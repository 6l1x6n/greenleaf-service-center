// Cloudflare Worker: статика сайта Greenleaf + обработка форм → Telegram
// + единое хранилище Сервис-Центров (Cloudflare KV, binding SC_STORES).
// Разворачивается через Git-интеграцию Workers (проект mygreenleaf).
// Переменные окружения (Worker → Settings → Variables):
//   TG_BOT_TOKEN, TG_CHAT_ID — заявки/консультации
//   TG_ORDERS_CHAT_ID       — группа, куда бот шлёт ЗАКАЗЫ (корзина + бронь)
//   STORE_CREDS             — JSON-секрет с учётками филиалов для /api/auth:
//                             {"<логин>": {"password": "...", "storeId": "...", "name": "...", "role": "sc|superadmin"}, ...}
//   AUTH_HMAC_KEY           — секрет подписи токенов сессий админки
//   PARSER_API_KEY          — ключ парсера для /api/parser-config
// KV namespace SC_STORES:
//   stores       — {"<storeId>": { id, officeCode, name, city, cityKey, address, hours,
//                   phone, phoneRaw, whatsapp, email, image, description, status, partner,
//                   portalLogin, portalPassword, authLogin, authPassword, createdAt }}
//   stores_archive — удалённые СЦ (суперадмин может восстановить или удалить навсегда):
//                   {"<storeId>": { ...карточка, archivedAt }}
//   applications — {"<appId>": { id, type: sc_registration|partner, name, phone, email,
//                   storeName, city, address, officeCode, portalLogin, portalPassword, comment,
//                   status: pending|approved|rejected|new, createdAt }}
//   reservations — {"<orderId>": { storeId, items: [{productId, qty}], createdAt, expiresAt }}
//                  временная бронь на 2 минуты при оформлении заказа (как места в кино)
//   orders       — {"<orderId>": { id, storeId, items: [{productId, qty}], name, phone,
//                  comment, total, payment, pickupDate, pickupTime, status: new|confirmed|cancelled,
//                  createdAt, confirmedAt?, cancelledAt? }} — активные заказы сайта.
//                  Доступно = факт(парсер) − 2-мин холды − Σ new − Σ confirmed после последнего
//                  обновления базы. Подтверждённые заказы после синка парсера уходят в архив
//                  и больше не влияют на остаток. Отмена возвращает зарезервированное.
//   orders_history — архив подтверждённых заказов (виден только суперадмину)

const TELEGRAM_API = 'https://api.telegram.org/bot';
const TOKEN_TTL = 12 * 3600; // 12 часов

// ---------------- Защита от ботов (экономия запросов к Worker и KV) ----------------
// Публичные GET, которые ходят в KV: для них блокируем агрессивных краулеров
// и вырезаем трекинг-параметры, чтобы edge-кеш попадал в цель
// (уникальный ?utm_... у бота = отдельный кеш-слот и запуск воркера).
const PUBLIC_KV_GET = ['/api/stores', '/api/events', '/api/event-bookings', '/api/stock', '/data/products.json'];
const TRACKING_PARAM_RE = /^(utm_|fbclid|gclid|yclid|gbraid|wbraid|msclkid|_ga|cmpid)/i;
const BOT_UA_RE = /gptbot|chatgpt-user|oai-searchbot|claude|anthropic-ai|cohere-ai|perplexity|bytespider|amazonbot|applebot-extended|google-extended|ccbot|meta-external|diffbot|imagesiftbot|petalbot|dataforseobot|ahrefsbot|mj12bot|seekportbot|semrushbot|dotbot|screaming\s?frog/i;

function cleanPublicUrl(url) {
  const u = new URL(url);
  const kept = [...u.searchParams.entries()].filter(function (kv) { return !TRACKING_PARAM_RE.test(kv[0]); });
  u.search = kept.map(function (kv) { return kv[0] + '=' + kv[1]; }).join('&');
  return u;
}

function isBotRequest(request) {
  const ua = String(request.headers.get('User-Agent') || '');
  return BOT_UA_RE.test(ua);
}

function jsonResponse(obj, status, cacheSeconds) {
  const headers = { 'Content-Type': 'application/json' };
  // Workers Cache (wrangler.jsonc: "cache": { "enabled": true }):
  // публичным GET задаём явный max-age + stale-while-revalidate на edge,
  // остальным ответам — no-store, чтобы эвристический кеш (RFC 9111)
  // не закешировал чувствительные ответы (креды парсера и т.п.)
  if (cacheSeconds) {
    headers['Cache-Control'] = 'public, max-age=' + cacheSeconds + ', stale-while-revalidate=' + (cacheSeconds * 3);
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  // Маркер нового билда: scripts/verify.sh и deploy.sh проверяют его,
  // чтобы вовремя заметить деплой из устаревшей рабочей копии
  headers['x-greenleaf-build'] = 'v2';
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers
  });
}

// ---------------- Cloudflare KV ----------------

async function kvGet(env, key) {
  const v = await env.SC_STORES.get(key, 'json');
  return (v && typeof v === 'object') ? v : {};
}

async function kvPut(env, key, obj) {
  await env.SC_STORES.put(key, JSON.stringify(obj));
}

// ---------------- Шифрование секретов (AES-GCM, ключ DATA_ENC_KEY) ----------------
// Пароли (портала и кабинетов) в KV хранятся зашифрованными.
// Формат: enc:v1:<base64(iv)>:<base64(ciphertext||authTag)>
const ENC_PREFIX = 'enc:v1:';

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64decode(str) {
  const bin = atob(String(str || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function encKey(env) {
  const raw = new TextEncoder().encode(String(env.DATA_ENC_KEY || ''));
  const digest = await crypto.subtle.digest('SHA-256', raw);
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptSecret(env, plain) {
  const s = String(plain == null ? '' : plain);
  if (!s) return s;
  if (!env.DATA_ENC_KEY) return s; // ключ не задан — режим совместимости
  const key = await encKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(s));
  return ENC_PREFIX + b64encode(iv) + ':' + b64encode(ct);
}

async function decryptSecret(env, value) {
  const v = String(value == null ? '' : value);
  if (!v.startsWith(ENC_PREFIX) || !env.DATA_ENC_KEY) return v;
  try {
    const rest = v.slice(ENC_PREFIX.length);
    const sep = rest.indexOf(':');
    const key = await encKey(env);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(rest.slice(0, sep)) },
      key,
      b64decode(rest.slice(sep + 1))
    );
    return new TextDecoder().decode(pt);
  } catch (e) {
    console.error('decryptSecret error:', e);
    return '';
  }
}


// ---------------- Остатки: база − продажи − активные брони ----------------

const RESERVE_TTL_MS = 120 * 1000; // 2 минуты

function parseStockCount(text) {
  const t = String(text || '').trim();
  if (!t || t.indexOf('Ожидается') !== -1) return null;
  if (t.indexOf('Нет') === 0) return 0;
  const m = t.match(/(\d+)\s*шт/);
  return m ? parseInt(m[1], 10) : null;
}

async function loadBaseStock(env, url) {
  const res = await env.ASSETS.fetch(new URL('/data/store-stock.json', url));
  if (!res.ok) return { stock: {}, updated: '' };
  const d = await res.json();
  const stock = (d && d.stock) || {};
  // Ручные правки остатков суперадмина (KV) — приоритетнее статичного файла
  try {
    const edits = await kvGet(env, 'stock_edits');
    if (edits) {
      Object.keys(edits).forEach((scId) => {
        if (!edits[scId] || typeof edits[scId] !== 'object') return;
        if (!stock[scId]) stock[scId] = {};
        Object.keys(edits[scId]).forEach((pid) => {
          stock[scId][pid] = edits[scId][pid];
        });
      });
    }
  } catch (e) { console.error('stock_edits merge:', e); }
  return { stock, updated: (d && d.updated) || '' };
}

// Суперадмин: сохранение ручных остатков (KV) — сайт обновляется сразу
async function handleStockSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const scId = String(body.scId || '').trim();
  const items = body.items && typeof body.items === 'object' ? body.items : null;
  if (!scId || !items) return jsonResponse({ ok: false, error: 'scId и items обязательны' }, 400);
  const edits = await kvGet(env, 'stock_edits');
  if (!edits[scId]) edits[scId] = {};
  Object.keys(items).forEach((pid) => {
    const v = String(items[pid] == null ? '' : items[pid]).trim();
    if (v === '') delete edits[scId][pid];
    else edits[scId][pid] = v;
  });
  if (!Object.keys(edits[scId]).length) delete edits[scId];
  await kvPut(env, 'stock_edits', edits);
  return jsonResponse({ ok: true });
}

// Активные 2-минутные брони корзины.
// Каждая бронь — отдельный ключ res_<orderId> с expirationTtl (KV сам удаляет
// истёкшие). Отдельные ключи исключают гонку «прочитать-изменить-записать»,
// из-за которой при параллельных резервах с двух устройств терялась бронь.
// Примечание: getMulti в Workers KV-binding недоступен — читаем по ключам по одному.
async function activeReservations(env) {
  const now = Date.now();
  const out = {};
  const listed = await env.SC_STORES.list({ prefix: 'res_' });
  const keys = (listed.keys || []).map(function (k) { return k.name; });
  for (let n = 0; n < keys.length; n++) {
    const key = keys[n];
    let raw = null;
    try {
      raw = await env.SC_STORES.get(key);
    } catch (e) { /* ключ мог истечь между list и get — пропускаем */ }
    if (!raw) continue;
    try {
      const r = JSON.parse(raw);
      const id = String(key).slice(4);
      if (r && r.expiresAt && r.expiresAt > now) out[id] = r;
    } catch (e) { /* повреждённая бронь — пропускаем */ }
  }
  return out;
}

// Сохранение брони отдельным ключом: без read-modify-write на общей карте
async function saveReservation(env, orderId, hold, ttlMs) {
  await env.SC_STORES.put('res_' + orderId, JSON.stringify(hold), {
    expirationTtl: Math.max(1, Math.ceil(ttlMs / 1000))
  });
}

async function deleteReservation(env, orderId) {
  try {
    await env.SC_STORES.delete('res_' + orderId);
  } catch (e) { /* ключа нет — не страшно */ }
}

// Эффективные остатки: факт(парсер) − 2-мин холды − активные заказы (new)
// − подтверждённые заказы после последнего синка базы.
// excludeOrderId — своя бронь при валидации новой.
async function computeEffectiveStock(env, url, excludeOrderId) {
  const base = await loadBaseStock(env, url);
  const reservations = await activeReservations(env);
  const orders = await loadOrders(env);
  const baseUpdatedMs = base.updated ? new Date(base.updated).getTime() : 0;
  const stock = {};
  Object.keys(base.stock).forEach((scId) => {
    const src = base.stock[scId];
    stock[scId] = {};
    Object.keys(src).forEach((pid) => {
      const baseCount = parseStockCount(src[pid]);
      if (baseCount === null) { stock[scId][pid] = src[pid]; return; }
      let res = 0;
      Object.keys(reservations).forEach((oid) => {
        if (excludeOrderId && oid === excludeOrderId) return;
        const r = reservations[oid];
        if (!r) return;
        const item = (r.items || []).find((i) => i.productId === pid && i.storeId === scId);
        if (item) res += Number(item.qty) || 0;
      });
      let ord = 0;
      Object.keys(orders).forEach((oid) => {
        const o = orders[oid];
        if (!o || String(o.storeId) !== String(scId) || o.status === 'cancelled') return;
        if (o.status === 'confirmed') {
          const confirmedMs = o.confirmedAt ? new Date(o.confirmedAt).getTime() : 0;
          // Подтверждено до последнего синка — парсер уже учёл продажу в базе
          if (!(confirmedMs > baseUpdatedMs)) return;
        }
        const item = (o.items || []).find((i) => String(i.productId) === String(pid));
        if (item) ord += Number(item.qty) || 0;
      });
      const left = baseCount - res - ord;
      stock[scId][pid] = left > 0
        ? 'В наличии (' + left + ' шт)'
        : 'Нет в наличии';
    });
  });
  return { stock, updated: base.updated };
}

async function handleStock(env, url) {
  const eff = await computeEffectiveStock(env, url);
  return jsonResponse({ ok: true, stock: eff.stock, updated: eff.updated, deducted: true }, 200, 60);
}

// День недели → ключ расписания (sun..sat), время "HH:MM" → минуты с полуночи
function scheduleDayKey(date) {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()];
}
function scheduleMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

// Общий часовой пояс сайта — Астана (UTC+5): расписание филиалов задаётся и проверяется
// в этом времени. Единая зона для всех филиалов (решение владельца). Cloudflare Workers
// работает в UTC — без пересчёта «сегодня»/часы работы съезжали бы на границе суток
// (ночь по Астане = предыдущий день по UTC).
const STORE_TZ = 'Asia/Almaty';

// «Сейчас» в времени Астаны: { date: 'YYYY-MM-DD', dayKey, minutes }
function storeLocalNow() {
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(now);
  const get = (t) => { const p = parts.find((x) => x.type === t); return p ? Number(p.value) : 0; };
  const y = get('year'), mo = get('month'), d = get('day');
  const date = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  return { date, minutes: get('hour') * 60 + get('minute'), dayKey: DAYS[new Date(y, mo - 1, d).getDay()] };
}

// Если филиал сейчас закрыт — вернуть сообщение об ошибке, иначе null
async function reserveOpenCheck(env, storeId) {
  const stores = await kvGet(env, 'stores');
  const store = (stores && typeof stores === 'object') ? stores[storeId] : null;
  const sch = store && store.schedule;
  if (!sch) return null; // расписание не задано — ограничение не применяем
  const n = storeLocalNow();
  const slot = sch[n.dayKey];
  if (!slot) return 'Филиал сегодня не работает — бронирование недоступно';
  const openM = scheduleMinutes(slot.open);
  const closeM = scheduleMinutes(slot.close);
  if (openM < 0 || closeM < 0 || n.minutes < openM || n.minutes >= closeM) {
    return 'Филиал сейчас закрыт — бронирование доступно в рабочее время ' + slot.open + '–' + slot.close;
  }
  return null;
}

async function handleReserve(request, env, url) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const orderId = String(data.orderId || '').trim();
  const storeId = String(data.storeId || '').trim();
  const items = Array.isArray(data.items) ? data.items.slice(0, 200) : [];
  if (!orderId || !storeId || !items.length) {
    return jsonResponse({ ok: false, error: 'orderId, storeId и items обязательны' }, 400);
  }

  // Бронь доступна только в рабочее время выбранного филиала (расписание из настроек СЦ)
  const closedMsg = await reserveOpenCheck(env, storeId);
  if (closedMsg) {
    return jsonResponse({ ok: false, error: 'closed', message: closedMsg }, 409);
  }

  const ttl = Math.min(Number(data.ttlSeconds) || 120, 600) * 1000;
  const eff = await computeEffectiveStock(env, url, orderId);
  const reservations = await activeReservations(env);
  const now = Date.now();
  let error = null;
  items.forEach((i) => {
    const pid = String(i.productId || '');
    const qty = Math.max(1, Math.min(Number(i.qty) || 1, 999));
    i.qty = qty;
    i.storeId = storeId;
    const txt = eff.stock[storeId] && eff.stock[storeId][pid];
    const avail = parseStockCount(txt);
    if (avail !== null && qty > avail && !error) {
      error = { productId: pid, available: avail };
    }
  });
  if (error) return jsonResponse({ ok: false, error: 'not enough', product: error }, 409);

  await saveReservation(env, orderId, { storeId, items, createdAt: new Date().toISOString(), expiresAt: now + ttl }, ttl);
  return jsonResponse({ ok: true, expiresAt: now + ttl, ttlSeconds: ttl / 1000 });
}

// Бронь места на мероприятие (единый счётчик в KV)
async function handleEventBook(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const eventId = String(body.eventId || '').trim();
  if (!eventId) return jsonResponse({ ok: false, error: 'eventId required' }, 400);
  const qty = Math.max(1, Math.min(Number(body.qty) || 1, 10));
  const bookings = await kvGet(env, 'event_bookings');
  bookings[eventId] = (Number(bookings[eventId]) || 0) + qty;
  await kvPut(env, 'event_bookings', bookings);
  return jsonResponse({ ok: true, booked: bookings[eventId] });
}

// Мероприятия: статика events.json + правки суперадмина (KV events) + правки СЦ (KV sc_events)
async function handleEventsGet(env, url) {
  const res = await env.ASSETS.fetch(new URL('/data/events.json', url));
  let base = [];
  if (res.ok) {
    const d = await res.json();
    base = (d && d.events) || (Array.isArray(d) ? d : []);
  }
  const over = await kvGet(env, 'events');
  if (Array.isArray(over) && over.length) base = over;
  const scEv = await kvGet(env, 'sc_events');
  Object.keys(scEv).forEach((storeId) => {
    const arr = scEv[storeId];
    if (!Array.isArray(arr)) return;
    base = base.filter((ev) => String(ev.storeId || '') !== String(storeId));
    arr.forEach((ev) => base.push(ev));
  });
  return jsonResponse({ ok: true, events: base }, 200, 600);
}

async function handleEventsSave(request, env, auth) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const events = Array.isArray(body.events) ? body.events : [];
  if (auth.role === 'superadmin') {
    await kvPut(env, 'events', events);
  } else {
    const scEv = await kvGet(env, 'sc_events');
    scEv[auth.storeId] = events;
    await kvPut(env, 'sc_events', scEv);
  }
  return jsonResponse({ ok: true });
}

// ---------------- Заказы (резервирование + синхронизация) ----------------
// Доступно онлайн = факт(парсер) − 2-мин холды корзины − Σ заказов status=new
//   − Σ заказов status=confirmed, подтверждённых ПОСЛЕ последнего обновления базы
//   (confirmedAt > base.updated). Подтверждённые до синка заказы парсер уже учёл —
//   они не вычитаются и лениво архивируются в orders_history.

async function loadOrders(env) {
  return kvGet(env, 'orders');
}

// Свой филиал Сервис-Центра: токен сессии несёт login, а не id —
// ищем карточку по логину кабинета (authLogin)
async function scOwnStoreId(env, auth) {
  if (auth.id) return String(auth.id);
  const stores = await kvGet(env, 'stores');
  const login = String(auth.login || '').toLowerCase();
  const rec = Object.values(stores).find(function (s) {
    return s && String(s.authLogin || '').toLowerCase() === login;
  });
  return rec ? rec.id : null;
}

// Подтверждённые заказы, по которым уже прошёл синк базы (base.updated > confirmedAt),
// уходят в архив: суперадмин их видит в /api/orders?archive=1.
// Отменённые заказы хранятся 24 часа, затем тоже переносятся в архив
// (у клиента из «Моих заказов» исчезают, у суперадмина остаётся аудит).
const CANCELLED_RETENTION_MS = 24 * 3600 * 1000;

async function archiveConfirmedOrders(env, url) {
  const base = await loadBaseStock(env, url);
  const baseUpdatedMs = base.updated ? new Date(base.updated).getTime() : 0;
  const orders = await loadOrders(env);
  let changed = false;
  const history = await kvGet(env, 'orders_history');
  Object.keys(orders).forEach((oid) => {
    const o = orders[oid];
    if (!o) return;
    if (o.status === 'confirmed' && baseUpdatedMs) {
      const confirmedMs = o.confirmedAt ? new Date(o.confirmedAt).getTime() : 0;
      if (confirmedMs && baseUpdatedMs > confirmedMs) {
        o.archivedAt = new Date().toISOString();
        history[oid] = o;
        delete orders[oid];
        changed = true;
      }
    } else if (o.status === 'cancelled' && o.cancelledAt) {
      const cancelledMs = new Date(o.cancelledAt).getTime();
      if (!isNaN(cancelledMs) && Date.now() - cancelledMs > CANCELLED_RETENTION_MS) {
        o.archivedAt = new Date().toISOString();
        history[oid] = o;
        delete orders[oid];
        changed = true;
      }
    }
  });
  if (changed) {
    await kvPut(env, 'orders', orders);
    await kvPut(env, 'orders_history', history);
  }
}

// Последовательный номер заказа (#10001, #10002, …) — красивый номер для клиента;
// внутренний id (o_…/GL-…) остаётся для техники и связи.
// Страховка от KV-лага счётчика: номер не ниже максимума среди существующих заказов,
// чтобы два заказа не получили одинаковый #N.
async function nextOrderNumber(env) {
  const counter = Number(await kvGet(env, 'order_counter')) || 0;
  let next = Math.max(10000, counter + 1);
  const orders = await loadOrders(env);
  Object.keys(orders).forEach(function (oid) {
    const n = Number(orders[oid] && orders[oid].number) || 0;
    if (n >= next) next = n + 1;
  });
  await kvPut(env, 'order_counter', next);
  return next;
}

// Создание заказа из оформленной корзины: 2-минутный холд конвертируется в заказ,
// который и держит резерв до подтверждения/отмены.
// Бронь читаем напрямую по ключу (как в validateOrderReservation): обход списка
// всех броней (activeReservations) опаздывает на KV-репликах, из-за чего заказ
// молча не создавался («Заказ отправлен!» без заказа в базе).
async function createOrder(env, data) {
  const orderId = String(data.order_id || data.orderId || '').trim();
  if (!orderId) return null;
  let res = null;
  try {
    const raw = await env.SC_STORES.get('res_' + orderId);
    if (raw) {
      const r = JSON.parse(raw);
      if (r && r.expiresAt && r.expiresAt > Date.now()) res = r;
    }
  } catch (e) { /* нет брони или повреждена */ }
  if (!res || !res.items || !res.items.length) return null;
  let items = [];
  try {
    items = JSON.parse(String(data.order_items_json || '[]'));
  } catch (e) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  const order = {
    id: orderId,
    number: await nextOrderNumber(env),
    storeId: res.storeId,
    // Полный снимок позиций на момент оформления (имя/цена для «чека»)
    items: items.map(function (i) {
      return {
        productId: String(i.productId || ''),
        sku: String(i.sku || i.productId || ''),
        name: String(i.name || '').trim(),
        qty: Math.max(1, Number(i.qty) || 1),
        price: Number(i.price) || 0
      };
    }),
    name: String(data.name || '').trim(),
    phone: String(data.phone || '').trim(),
    comment: String(data.comment || data.order_comment || '').trim(),
    clientToken: String(data.clientToken || '').trim(),
    managerNote: '',
    total: Number(data.order_total) || 0,
    package: Number(data.order_package) || 0,
    payment: String(data.payment || ''),
    partnerMode: data.order_partner_mode === '1',
    pickupDate: String(data.pickup_date || data.pickupDate || ''),
    pickupTime: String(data.pickup_time || data.pickupTime || ''),
    status: 'new',
    createdAt: new Date().toISOString()
  };
  const orders = await loadOrders(env);
  orders[orderId] = order;
  await kvPut(env, 'orders', orders);
  // Холд на 2 минуты больше не нужен — резерв держит сам заказ
  await deleteReservation(env, orderId);
  console.log('Заказ создан:', orderId, 'СЦ', res.storeId, order.items.length, 'поз.');
  return order;
}

// GET /api/orders — СЦ видит свои заказы, суперадмин — все (и архив при ?archive=1)
async function handleOrdersGet(request, env, auth) {
  const url = new URL(request.url);
  await archiveConfirmedOrders(env, url);
  const history = url.searchParams.get('archive') === '1' && auth.role === 'superadmin';
  const source = history ? await kvGet(env, 'orders_history') : await loadOrders(env);
  const ownId = auth.role === 'superadmin' ? null : await scOwnStoreId(env, auth);
  const list = Object.values(source)
    .filter(function (o) {
      return auth.role === 'superadmin' || (ownId && String(o.storeId) === String(ownId));
    })
    .sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
  return jsonResponse({ ok: true, orders: list, archive: history });
}

// POST /api/orders/action {id, action: ready|confirm|cancel|delete, comment?}
//   ready    — new → ready (заказ упакован, готов к выдаче): резерв сохраняется.
//   confirm  — new/ready → confirmed: резерв переходит в продажу, остаток не меняется.
//   cancel   — new/ready → cancelled: резерв снимается, товар возвращается в доступное.
//   delete   — удаление из списка: для new/ready возвращает резерв (как отмена),
//              для confirmed НЕ возвращает товар (продажа уже состоялась).
//   comment  — опционально, сообщение для клиента (managerNote, виден в «Моих заказах»).
async function handleOrdersAction(request, env, auth) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const id = String(body.id || '').trim();
  const action = String(body.action || '').trim();
  const note = String(body.comment || '').trim();
  const orders = await loadOrders(env);
  const order = orders[id];
  if (!order) return jsonResponse({ ok: false, error: 'Заказ не найден' }, 404);
  const ownId = auth.role === 'superadmin' ? null : await scOwnStoreId(env, auth);
  if (auth.role !== 'superadmin' && (!ownId || String(order.storeId) !== String(ownId))) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }

  if (action === 'ready') {
    if (order.status !== 'new') {
      return jsonResponse({ ok: false, error: 'Отметить «готов» можно только новый заказ' }, 400);
    }
    order.status = 'ready';
    order.readyAt = new Date().toISOString();
    if (note) order.managerNote = note;
    await kvPut(env, 'orders', orders);
    return jsonResponse({ ok: true, order });
  }

  if (action === 'confirm') {
    if (order.status !== 'new' && order.status !== 'ready') {
      return jsonResponse({ ok: false, error: 'Подтвердить можно только новый или готовый заказ' }, 400);
    }
    order.status = 'confirmed';
    order.confirmedAt = new Date().toISOString();
    if (note) order.managerNote = note;
    await kvPut(env, 'orders', orders);
    return jsonResponse({ ok: true, order });
  }

  if (action === 'cancel') {
    if (order.status !== 'new' && order.status !== 'ready') {
      return jsonResponse({ ok: false, error: 'Отменить можно только новый или готовый заказ' }, 400);
    }
    order.status = 'cancelled';
    order.cancelledAt = new Date().toISOString();
    if (note) order.managerNote = note;
    await kvPut(env, 'orders', orders);
    return jsonResponse({ ok: true, order });
  }

  if (action === 'delete') {
    const wasNew = order.status === 'new' || order.status === 'ready';
    delete orders[id];
    await kvPut(env, 'orders', orders);
    // Суперадмин может удалять и архивные заказы
    if (auth.role === 'superadmin') {
      const history = await kvGet(env, 'orders_history');
      if (history[id]) {
        delete history[id];
        await kvPut(env, 'orders_history', history);
      }
    }
    // Удаление не меняет физический остаток: для new/ready резерв снимается (заказа больше
    // нет — товар снова доступен), для confirmed продажа остаётся продажей.
    return jsonResponse({ ok: true, deleted: true, returned: wasNew });
  }

  return jsonResponse({ ok: false, error: 'unknown action' }, 400);
}

// ---------------- «Мои заказы» клиента (без аккаунтов) ----------------
// Клиент отслеживает заказы по clientToken, сохранённому в localStorage устройства.
// Токен генерируется на клиенте и передаётся с каждым заказом.

// GET /api/my-orders?token=... — свои заказы (активные + архив по токену)
async function handleMyOrders(request, env) {
  const url = new URL(request.url);
  const token = String(url.searchParams.get('token') || '').trim();
  if (!token || token.length < 16) {
    return jsonResponse({ ok: false, error: 'token required' }, 400);
  }
  await archiveConfirmedOrders(env, url);
  const stores = await kvGet(env, 'stores');
  const active = await loadOrders(env);
  const history = await kvGet(env, 'orders_history');
  const list = [];
  const push = function (o, archived) {
    if (!o || String(o.clientToken || '') !== token) return;
    const store = stores[o.storeId];
    list.push(Object.assign({}, o, {
      storeName: store ? store.name : (o.storeId || ''),
      archived: !!archived
    }));
  };
  Object.keys(active).forEach(function (id) { push(active[id], false); });
  Object.keys(history).forEach(function (id) { push(history[id], true); });
  list.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
  return jsonResponse({ ok: true, orders: list });
}

// POST /api/my-orders/action {id, token, action: 'cancel'} — отмена своего заказа
// (только пока заказ «Новый»; отменённый заказ возвращает зарезервированный товар)
async function handleMyOrdersAction(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const id = String(body.id || '').trim();
  const token = String(body.token || '').trim();
  const action = String(body.action || '').trim();
  if (!id || !token) return jsonResponse({ ok: false, error: 'id и token обязательны' }, 400);
  const orders = await loadOrders(env);
  const order = orders[id];
  if (!order || String(order.clientToken || '') !== token) {
    return jsonResponse({ ok: false, error: 'Заказ не найден' }, 404);
  }
  if (action === 'cancel') {
    if (order.status !== 'new') {
      return jsonResponse({ ok: false, error: 'Отменить можно только заказ в статусе «Новый»' }, 400);
    }
    order.status = 'cancelled';
    order.cancelledAt = new Date().toISOString();
    order.managerNote = order.managerNote || 'Отменён клиентом';
    await kvPut(env, 'orders', orders);
    return jsonResponse({ ok: true, order });
  }
  return jsonResponse({ ok: false, error: 'unknown action' }, 400);
}

// Проверка заказа перед отправкой: бронь должна быть активной и покрывать все
// позиции заказа. Иначе заказ не принимается (409) — остатки могли уже уйти.
// Читаем бронь напрямую по ключу (res_<orderId>) — быстрее и без обхода всех
// броней; в пределах одного расположения KV отдаёт запись сразу после записи.
async function validateOrderReservation(env, data) {
  const orderId = String(data.order_id || data.orderId || '').trim();
  const expiredRes = jsonResponse({ ok: false, error: 'expired', message: 'Время бронирования истекло — соберите корзину заново' }, 409);
  if (!orderId) return { ok: false, res: expiredRes };
  let res = null;
  try {
    const raw = await env.SC_STORES.get('res_' + orderId);
    if (raw) {
      const r = JSON.parse(raw);
      if (r && r.expiresAt && r.expiresAt > Date.now()) res = r;
    }
  } catch (e) { /* нет брони или повреждена */ }
  if (!res || !res.items || !res.items.length) {
    return { ok: false, res: expiredRes };
  }
  let items = [];
  try {
    items = JSON.parse(String(data.order_items_json || '[]'));
  } catch (e) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  const bad = items.find(function (i) {
    const reserved = (res.items || []).find(function (r) { return r.productId === String(i.productId); });
    return !reserved || (Number(i.qty) || 0) > (Number(reserved.qty) || 0);
  });
  if (bad) {
    return { ok: false, res: jsonResponse({ ok: false, error: 'expired', message: 'Состав заказа изменился — соберите корзину заново' }, 409) };
  }
  return { ok: true };
}

// ---------------- Токены сессий (HMAC) ----------------

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToHex(sig);
}

async function issueToken(env, login, role) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  const sig = await hmacHex(env.AUTH_HMAC_KEY, `${login}:${role}:${exp}`);
  return `${login}.${role}.${exp}.${sig}`;
}

async function verifyToken(env, header) {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 4) return null;
  const [login, role, exp, sig] = parts;
  if (parseInt(exp, 10) < Math.floor(Date.now() / 1000)) return null;
  const expect = await hmacHex(env.AUTH_HMAC_KEY, `${login}:${role}:${exp}`);
  if (expect !== sig) return null;
  return { login, role };
}

// ---------------- Вход в кабинет филиала ----------------

async function handleStoreAuth(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false }, 400);
  }
  const login = String(body.login || '').trim().toLowerCase();
  const pass = String(body.password || '');
  let user = null;

  // 0. Суперадмин из KV admin_creds (пароль зашифрован в KV)
  const adminCreds = await kvGet(env, 'admin_creds');
  if (adminCreds && adminCreds.login && adminCreds.password &&
      adminCreds.login === login && (await decryptSecret(env, adminCreds.password)) === pass) {
    user = { id: 'admin', name: 'Суперадмин', role: 'superadmin' };
  }

  // 1. Статические учётки (суперадмин и пр.) из секрета STORE_CREDS
  const raw = env.STORE_CREDS;
  if (raw && !user) {
    try {
      const creds = JSON.parse(raw);
      const rec = creds[login];
      if (rec) {
        // Пароль суперадмина можно переопределить через KV admin_creds
        // (восстановление пароля без перезаписи read-only секрета)
        let expected = rec.password;
        if (rec.role === 'superadmin' && adminCreds && adminCreds.password) expected = await decryptSecret(env, adminCreds.password);
        if (expected === pass) {
          user = { id: rec.storeId || rec.id || login, name: rec.name || 'СЦ Greenleaf', role: rec.role || 'sc' };
        }
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: 'auth config error' }, 500);
    }
  }

  // 2. Выданные суперадмином логины Сервис-Центров (KV, пароль зашифрован)
  if (!user) {
    const stores = await kvGet(env, 'stores');
    // Ключ записи может отличаться от логина кабинета — ищем по обоим
    let rec = stores[login];
    if (!rec) {
      const keys = Object.keys(stores);
      for (let i = 0; i < keys.length; i++) {
        const s = stores[keys[i]];
        if (s && String(s.authLogin || '').toLowerCase() === login) { rec = s; break; }
      }
    }
    if (rec && rec.status === 'active' && (await decryptSecret(env, rec.authPassword)) === pass) {
      user = { id: rec.id || login, name: rec.name || 'СЦ Greenleaf', role: 'sc' };
    }
  }

  if (user) {
    const token = await issueToken(env, login, user.role);
    return jsonResponse({ ok: true, store: user, token });
  }
  return jsonResponse({ ok: false });
}

// ---------------- Регистрация Сервис-Центра (публично) ----------------

function normalizeOfficeCode(code) {
  return String(code || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

async function handleRegisterSc(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const name = String(data.name || '').trim();
  const phone = String(data.phone || '').trim();
  const storeName = String(data.storeName || '').trim();
  const city = String(data.city || '').trim();
  const address = String(data.address || '').trim();
  if (!name || !phone || !storeName || !city || !address) {
    return jsonResponse({ ok: false, error: 'name, phone, storeName, city и address обязательны' }, 400);
  }
  const officeCode = String(data.officeCode || '').trim();
  const portalLogin = String(data.portalLogin || '').trim();
  const portalPassword = String(data.portalPassword || '').trim();
  const hasCabinet = true;
  const app = {
    id: 'app_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    type: data.type === 'sc_registration' ? 'sc_registration' : 'sc_registration',
    name,
    phone,
    email: String(data.email || '').trim(),
    storeName,
    city,
    address,
    officeCode,
    officeId: hasCabinet ? normalizeOfficeCode(officeCode) : '',
    portalLogin,
    portalPassword: await encryptSecret(env, portalPassword),
    hasCabinet,
    comment: String(data.comment || data.message || '').trim(),
    experience: String(data.experience || '').trim(),
    hours: String(data.hours || '').trim(),
    schedule: (data.schedule && typeof data.schedule === 'object') ? data.schedule : null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  const apps = await kvGet(env, 'applications');
  apps[app.id] = app;
  await kvPut(env, 'applications', apps);

  // Уведомление главному администратору
  const text = buildText(Object.assign({ type: app.type }, data, { comment: app.comment, experience: app.experience }));
  await sendTelegram(env, text);

  return jsonResponse({ ok: true, id: app.id });
}

// ---------------- Заявки СЦ (суперадмин) ----------------

async function handleScApplications(env) {
  const apps = await kvGet(env, 'applications');
  const list = Object.values(apps).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map(function (a) { return Object.assign({}, a, { portalPassword: undefined }); });
  return jsonResponse({ ok: true, applications: list });
}

// Доступы владельцу передаёт лично суперадмин (раздел «Сервис-Центры»);
// письма и email владельца убраны.

async function handleScApplicationAction(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const apps = await kvGet(env, 'applications');
  const app = apps[body.id];
  if (!app) return jsonResponse({ ok: false, error: 'not found' }, 404);
  if (body.action === 'approve' || body.action === 'reject') {
    let created = null;
    if (body.action === 'approve') {
      // Однокликовое подтверждение: карточка СЦ создаётся из заявки
      if (body.create) {
        const stores = await kvGet(env, 'stores');
        const storeId = app.hasCabinet
          ? (app.officeId || normalizeOfficeCode(app.officeCode))
          : ('sc-partner-' + app.id);
        const existing = stores[storeId] || {};
        // Пароль из заявки может быть уже зашифрован (миграция/повторное одобрение) —
        // расшифровываем и шифруем заново один раз
        const appPortalPass = String(app.portalPassword || '').trim();
        const record = {
          id: storeId,
          officeCode: String(app.officeCode || '').trim(),
          name: String(app.storeName || '').trim() || existing.name || (app.hasCabinet ? 'СЦ Greenleaf' : 'Магазин-партнёр Greenleaf'),
          city: String(app.city || '').trim() || existing.city || '',
          cityKey: String(app.city || '').trim().toLowerCase() || existing.cityKey || '',
          address: String(app.address || '').trim() || existing.address || 'Адрес уточняется',
          hours: String(app.hours || '').trim() || existing.hours || 'Пн–Вс 10:00 – 20:00',
          schedule: (app.schedule && typeof app.schedule === 'object') ? app.schedule : existing.schedule || null,
          phone: String(app.phone || '').trim() || existing.phone || '',
          phoneRaw: String(app.phone || '').replace(/\D/g, '') || existing.phoneRaw || '',
          whatsapp: String(app.phone || '').replace(/\D/g, '') || existing.whatsapp || '',
          image: existing.image || 'assets/images/products/placeholder.svg',
          description: existing.description || (app.hasCabinet
            ? ''
            : (app.comment || 'Магазин-партнёр Greenleaf. Приходите за эко-продукцией!')),
          partner: existing.partner || '',
          portalLogin: String(app.portalLogin || '').trim() || existing.portalLogin || '',
          portalPassword: (appPortalPass ? await encryptSecret(env, await decryptSecret(env, appPortalPass)) : '') || existing.portalPassword || '',
          authLogin: existing.authLogin || storeId.toLowerCase(),
          authPassword: existing.authPassword || await encryptSecret(env, randomPassword(10)),
          isPartner: app.hasCabinet ? false : true,
          status: 'active',
          createdAt: existing.createdAt || new Date().toISOString()
        };
        stores[storeId] = record;
        await kvPut(env, 'stores', stores);
        created = record;
      }
      app.status = 'approved';
      app.resolvedAt = new Date().toISOString();
      await kvPut(env, 'applications', apps);
      return jsonResponse({ ok: true, application: app, store: created });
    }
    app.status = 'rejected';
    app.resolvedAt = new Date().toISOString();
    await kvPut(env, 'applications', apps);
  } else if (body.action === 'delete') {
    delete apps[body.id];
    await kvPut(env, 'applications', apps);
    return jsonResponse({ ok: true, deleted: true });
  }
  return jsonResponse({ ok: true, application: app });
}

// ---------------- Карточки Сервис-Центров (суперадмин) ----------------

function randomPassword(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

async function handleScStore(request, env, auth) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  // Сервис-Центр может сохранять только свой филиал (по логину кабинета)
  const isScRole = !!(auth && auth.role === 'sc');
  const stores = await kvGet(env, 'stores');
  const scOwnId = isScRole ? await scOwnStoreId(env, auth) : null;
  if (isScRole && (!scOwnId || String(data.id || '').trim() !== String(scOwnId))) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }
  // Обязательные поля карточки (форма суперадмина требует их все).
  // Email владельца убран: доступы передаёт только суперадмин лично.
  const required = ['name', 'city', 'address', 'hours', 'phone', 'image'];
  const missing = required.filter(function (f) { return !String(data[f] || '').trim(); });
  if (missing.length) {
    return jsonResponse({ ok: false, error: 'Не заполнены обязательные поля: ' + missing.join(', ') }, 400);
  }
  const officeId = normalizeOfficeCode(data.officeCode || '');
  const storeId = isScRole ? scOwnId : (String(data.id || '').trim() || officeId || ('sc_' + Date.now()));
  const existing = stores[storeId] || {};
  // Пароли: СЦ не видит текущие значения (portalPassword вырезается из ответа),
  // но может задать новый: непустое поле = смена, пустое = оставить как было.
  // В KV пароли хранятся зашифрованными (AES-GCM, DATA_ENC_KEY).
  const submittedPortalPass = String(data.portalPassword || '').trim();
  const submittedAuthPass = String(data.authPassword || '').trim();
  const newPortalPass = submittedPortalPass ? await encryptSecret(env, submittedPortalPass) : '';
  const newAuthPass = submittedAuthPass ? await encryptSecret(env, submittedAuthPass) : '';
  const record = {
    id: storeId,
    officeCode: String(data.officeCode || '').trim() || existing.officeCode || '',
    name: String(data.name || '').trim() || existing.name || 'СЦ Greenleaf',
    city: String(data.city || '').trim() || existing.city || '',
    cityKey: String(data.cityKey || '').trim() || existing.cityKey || '',
    address: String(data.address || '').trim() || existing.address || '',
    hours: String(data.hours || '').trim() || existing.hours || '',
    schedule: (data.schedule && typeof data.schedule === 'object') ? data.schedule : existing.schedule || null,
    phone: String(data.phone || '').trim() || existing.phone || '',
    phoneRaw: String(data.phoneRaw || '').trim() || existing.phoneRaw || '',
    whatsapp: String(data.whatsapp || '').trim() || existing.whatsapp || '',
    email: existing.email || '',
    image: String(data.image || '').trim() || existing.image || '',
    description: String(data.description || '').trim() || existing.description || '',
    // Логин партнёра для каталога универсален для всех СЦ
    partner: existing.partner || 'kz44326234',
    portalLogin: String(data.portalLogin || '').trim() || existing.portalLogin || '',
    portalPassword: newPortalPass || existing.portalPassword || '',
    authLogin: isScRole
      ? (existing.authLogin || officeId || storeId.toLowerCase())
      : (String(data.authLogin || '').trim().toLowerCase() || existing.authLogin || officeId || storeId.toLowerCase()),
    authPassword: newAuthPass || existing.authPassword || await encryptSecret(env, randomPassword(10)),
    status: isScRole ? (existing.status || 'active') : (data.status === 'inactive' ? 'inactive' : 'active'),
    createdAt: existing.createdAt || new Date().toISOString()
  };
  stores[storeId] = record;
  await kvPut(env, 'stores', stores);
  // Пароль парсера и кабинета СЦ не отдаём в ответе
  const publicRecord = Object.assign({}, record, { portalPassword: undefined, authPassword: undefined });
  return jsonResponse({ ok: true, store: publicRecord });
}

// POST /api/sc-store/reset-password {id} — генерация нового пароля кабинета (суперадмин)
async function handleScStoreResetPassword(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const id = String(body.id || '').trim();
  const stores = await kvGet(env, 'stores');
  const rec = stores[id];
  if (!rec) return jsonResponse({ ok: false, error: 'not found' }, 404);
  const password = randomPassword(10);
  rec.authPassword = await encryptSecret(env, password);
  await kvPut(env, 'stores', stores);
  return jsonResponse({ ok: true, id, login: rec.authLogin, password });
}

// Полные карточки СЦ для админки (креды, статус). Суперадмин — все,
// СЦ — только свой филиал; пароль портала (для парсера) виден только суперадмину.
async function handleScStoresAdmin(env, auth) {
  const stores = await kvGet(env, 'stores');
  const list = Object.values(stores);
  if (auth.role !== 'superadmin') {
    const login = String(auth.login || '').toLowerCase();
    const own = list.filter(function (s) { return String(s.authLogin || '').toLowerCase() === login; })
      .map(function (s) { return Object.assign({}, s, { portalPassword: undefined, authPassword: undefined }); });
    return jsonResponse({ ok: true, stores: own });
  }
  list.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ru'); });
  // Суперадмину пароли отдаём расшифрованными (для панели), в KV они зашифрованы
  const decrypted = [];
  for (const s of list) {
    decrypted.push(Object.assign({}, s, {
      portalPassword: await decryptSecret(env, s.portalPassword),
      authPassword: await decryptSecret(env, s.authPassword)
    }));
  }
  return jsonResponse({ ok: true, stores: decrypted });
}

// Удаление СЦ: карточка перемещается в архив (stores_archive) — оттуда суперадмин
// может восстановить её или удалить безвозвратно. Tombstones не создаются.
async function handleScStoreDelete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const id = String(body.id || '').trim();
  if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
  const stores = await kvGet(env, 'stores');
  const card = stores[id];
  if (!card || card.deleted || card.status === 'deleted') {
    return jsonResponse({ ok: false, error: 'Филиал не найден' }, 404);
  }
  delete stores[id];
  await kvPut(env, 'stores', stores);
  const archive = await kvGet(env, 'stores_archive');
  card.status = 'active';
  card.archivedAt = new Date().toISOString();
  archive[id] = card;
  await kvPut(env, 'stores_archive', archive);
  try {
    const scOverrides = await kvGet(env, 'sc_product_overrides');
    if (scOverrides && scOverrides[id]) {
      delete scOverrides[id];
      await kvPut(env, 'sc_product_overrides', scOverrides);
    }
  } catch (e) { console.error('cleanup sc overrides:', e); }
  return jsonResponse({ ok: true, archived: true, id });
}

// GET /api/sc-archive — список удалённых СЦ (суперадмин)
async function handleScArchiveGet(env) {
  const archive = await kvGet(env, 'stores_archive');
  const list = Object.values(archive);
  list.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ru'); });
  return jsonResponse({ ok: true, archived: list });
}

// POST /api/sc-archive/action {id, action: restore|purge}
//   restore — вернуть карточку в активные; purge — удалить из архива навсегда
async function handleScArchiveAction(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const id = String(body.id || '').trim();
  const action = String(body.action || '').trim();
  if (!id || !action) return jsonResponse({ ok: false, error: 'id и action обязательны' }, 400);
  const archive = await kvGet(env, 'stores_archive');
  const card = archive[id];
  if (!card) return jsonResponse({ ok: false, error: 'Карточка не найдена в архиве' }, 404);

  if (action === 'restore') {
    delete card.archivedAt;
    card.status = 'active';
    card.restoredAt = new Date().toISOString();
    const stores = await kvGet(env, 'stores');
    stores[id] = card;
    delete archive[id];
    await kvPut(env, 'stores', stores);
    await kvPut(env, 'stores_archive', archive);
    return jsonResponse({ ok: true, store: card });
  }

  if (action === 'purge') {
    delete archive[id];
    await kvPut(env, 'stores_archive', archive);
    return jsonResponse({ ok: true, purged: true });
  }

  return jsonResponse({ ok: false, error: 'unknown action' }, 400);
}

// ---------------- Список СЦ для сайта (публично) ----------------

async function handleStores(env) {
  const stores = await kvGet(env, 'stores');
  const list = Object.values(stores)
    .filter(s => s.status === 'active')
    .map(s => ({
      id: s.id,
      officeCode: s.officeCode || '',
      name: s.name,
      city: s.city || '',
      cityKey: s.cityKey || '',
      address: s.address || '',
      hours: s.hours || '',
      schedule: s.schedule || null,
      phone: s.phone || '',
      phoneRaw: s.phoneRaw || '',
      whatsapp: s.whatsapp || '',
      image: s.image || '',
      description: s.description || ''
    }));
  const deletedIds = Object.values(stores)
    .filter(s => s.deleted || s.status === 'deleted')
    .map(s => s.id);
  return jsonResponse({ ok: true, stores: list, deletedIds }, 200, 1800);
}

// ---------------- Конфиг для парсера (по API-ключу) ----------------

// Логин партнёра для каталога универсален для всех Сервис-Центров
const PARTNER_LOGIN = 'kz44326234';

async function handleParserConfig(request, env) {
  const url = new URL(request.url);
  const key = request.headers.get('X-API-Key') || url.searchParams.get('key') || '';
  if (!env.PARSER_API_KEY || key !== env.PARSER_API_KEY) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }
  const stores = await kvGet(env, 'stores');
  const list = [];
  for (const s of Object.values(stores)) {
    if (s.status !== 'active' || !s.portalLogin) continue;
    list.push({
      id: s.id,
      officeCode: s.officeCode || '',
      login: s.portalLogin,
      password: await decryptSecret(env, s.portalPassword || ''),
      partner: PARTNER_LOGIN
    });
  }
  return jsonResponse({ ok: true, stores: list });
}

// ---------------- Оверрайды товаров (суперадмин) ----------------
// KV:
//   product_overrides     — {"<productId>": {price?, description?, category?, status?, hidden?}}
//   sc_product_overrides  — {"<storeId>": {"<productId>": {status?, hidden?}}}
//   site_settings         — {showDiscountPrices: bool, categories: [..]}

// GET /api/admin/products — текущие оверрайды и настройки
async function handleAdminProductsGet(env) {
  const overrides = await kvGet(env, 'product_overrides');
  const scOverrides = await kvGet(env, 'sc_product_overrides');
  const settings = await kvGet(env, 'site_settings');
  return jsonResponse({
    ok: true,
    overrides,
    scOverrides,
    settings: {
      showDiscountPrices: settings.showDiscountPrices !== false,
      categories: Array.isArray(settings.categories) ? settings.categories : []
    }
  });
}

// POST /api/admin/parser-run {task: products|deliveries|all, full?} — запуск парсера
// через GitHub Actions (workflow_dispatch). Только суперадмин. Требуется Worker-секрет GH_PAT.
async function handleParserRun(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const pat = String(env.GH_PAT || '');
  if (!pat) {
    return jsonResponse({ ok: false, error: 'GH_PAT не настроен — кнопка недоступна' }, 400);
  }
  const task = String(body.task || 'all').trim();
  if (['all', 'products', 'deliveries'].indexOf(task) === -1) {
    return jsonResponse({ ok: false, error: 'task должен быть all|products|deliveries' }, 400);
  }
  const res = await fetch(
    'https://api.github.com/repos/6l1x6n/greenleaf-service-center/actions/workflows/parse-catalog.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + pat,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'greenleaf-worker'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          task: task,
          full: body.full === true ? 'true' : 'false',
          skip_delay: 'true'
        }
      })
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(function () { return ''; });
    return jsonResponse({ ok: false, error: 'GitHub: HTTP ' + res.status + ' ' + text.slice(0, 120) }, 502);
  }
  return jsonResponse({ ok: true, task: task, full: body.full === true });
}

// POST /api/admin/products — сохранение оверрайдов/настроек
async function handleAdminProducts(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const action = String(body.action || '');

  if (action === 'save') {
    const overrides = await kvGet(env, 'product_overrides');
    const updates = (body.updates && typeof body.updates === 'object') ? body.updates : {};
    Object.keys(updates).forEach(function (pid) {
      const u = updates[pid];
      if (!u || typeof u !== 'object') return;
      const clean = {};
      ['price', 'description', 'category', 'status', 'discount_price', 'eta', 'incoming', 'priority'].forEach(function (f) {
        if (u[f] !== undefined && u[f] !== null && u[f] !== '') {
          clean[f] = (f === 'price' || f === 'discount_price' || f === 'priority') ? Number(u[f]) : u[f];
        }
      });
      // Приоритет снимается пустой строкой
      if (u.priority === '') {
        const o0 = overrides[pid];
        if (o0) {
          delete o0.priority;
          if (Object.keys(o0).length) overrides[pid] = o0;
          else delete overrides[pid];
        }
        return;
      }
      if (typeof u.hidden === 'boolean') clean.hidden = u.hidden;
      if (typeof u.hit === 'boolean') clean.hit = u.hit;
      if (typeof u.showDiscount === 'boolean') clean.showDiscount = u.showDiscount;
      if (Object.keys(clean).length) {
        overrides[pid] = Object.assign({}, overrides[pid], clean);
      } else {
        delete overrides[pid];
      }
    });
    await kvPut(env, 'product_overrides', overrides);
    return jsonResponse({ ok: true });
  }

  // action='hit' — быстрая отметка «🔥 Хит» (суперадмин)
  if (action === 'hit') {
    const id = String(body.id || '').trim();
    const val = body.hit === true;
    if (!id) return jsonResponse({ ok: false, error: 'id обязателен' }, 400);
    const overrides = await kvGet(env, 'product_overrides');
    if (val) {
      overrides[id] = Object.assign({}, overrides[id], { hit: true });
    } else {
      const o = overrides[id];
      if (o && o.hit !== undefined) {
        delete o.hit;
        if (!Object.keys(o).length) delete overrides[id];
        else overrides[id] = o;
      }
    }
    await kvPut(env, 'product_overrides', overrides);
    return jsonResponse({ ok: true });
  }

  // Ручная карточка товара (создание/обновление по артикулу)
  if (action === 'custom') {
    const p = (body.product && typeof body.product === 'object') ? body.product : {};
    const sku = String(p.sku || '').trim().toUpperCase();
    if (!sku) return jsonResponse({ ok: false, error: 'Артикул обязателен' }, 400);
    const name = String(p.name || '').trim();
    if (!name) return jsonResponse({ ok: false, error: 'Название обязательно' }, 400);
    const price = Number(p.price);
    if (isNaN(price) || price < 0) return jsonResponse({ ok: false, error: 'Некорректная цена' }, 400);
    const custom = await kvGet(env, 'custom_products');
    custom[sku] = {
      id: sku,
      sku: sku,
      name: name,
      category: String(p.category || '').trim() || 'Прочее',
      price: price,
      discount_price: (p.discount_price !== undefined && p.discount_price !== '' && !isNaN(Number(p.discount_price))) ? Number(p.discount_price) : null,
      description: String(p.description || '').trim(),
      priority: (p.priority !== undefined && p.priority !== '' && p.priority !== null) ? Number(p.priority) : null,
      showDiscount: p.showDiscount !== false,
      status: 'in_stock',
      hidden: false,
      created: (custom[sku] && custom[sku].created) || new Date().toISOString()
    };
    await kvPut(env, 'custom_products', custom);
    return jsonResponse({ ok: true });
  }

  // Удаление ручной карточки товара
  if (action === 'custom-delete') {
    const sku = String(body.sku || '').trim().toUpperCase();
    if (!sku) return jsonResponse({ ok: false, error: 'Артикул обязателен' }, 400);
    const custom = await kvGet(env, 'custom_products');
    if (custom[sku]) {
      delete custom[sku];
      await kvPut(env, 'custom_products', custom);
    }
    const overrides = await kvGet(env, 'product_overrides');
    if (overrides[sku]) {
      delete overrides[sku];
      await kvPut(env, 'product_overrides', overrides);
    }
    return jsonResponse({ ok: true });
  }

  if (action === 'reset') {
    // Вернуть исходные (парсинговые) данные: убрать все оверрайды
    await kvPut(env, 'product_overrides', {});
    await kvPut(env, 'sc_product_overrides', {});
    return jsonResponse({ ok: true });
  }

  if (action === 'resetSc') {
    // Сброс настроек товаров конкретного Сервис-Центра
    const storeId = String(body.storeId || '').trim();
    if (!storeId) return jsonResponse({ ok: false, error: 'storeId required' }, 400);
    const map = await kvGet(env, 'sc_product_overrides');
    delete map[storeId];
    await kvPut(env, 'sc_product_overrides', map);
    return jsonResponse({ ok: true });
  }

  if (action === 'saveSc') {
    const storeId = String(body.storeId || '').trim();
    const items = Array.isArray(body.items) ? body.items : [];
    if (!storeId) return jsonResponse({ ok: false, error: 'storeId required' }, 400);
    const map = await kvGet(env, 'sc_product_overrides');
    map[storeId] = map[storeId] || {};
    items.forEach(function (it) {
      const pid = String(it.productId || '');
      if (!pid) return;
      const clean = {};
      ['status', 'price', 'discount_price', 'eta', 'incoming'].forEach(function (f) {
        if (it[f] !== undefined && it[f] !== null && it[f] !== '') {
          clean[f] = (f === 'price' || f === 'discount_price') ? Number(it[f]) : it[f];
        }
      });
      if (typeof it.hidden === 'boolean') clean.hidden = it.hidden;
      if (Object.keys(clean).length) {
        map[storeId][pid] = Object.assign({}, map[storeId][pid], clean);
      }
    });
    await kvPut(env, 'sc_product_overrides', map);
    return jsonResponse({ ok: true });
  }

  if (action === 'settings') {
    const settings = await kvGet(env, 'site_settings');
    if (typeof body.showDiscountPrices === 'boolean') settings.showDiscountPrices = body.showDiscountPrices;
    if (Array.isArray(body.categories)) settings.categories = body.categories;
    if (body.clearCategories === true) delete settings.categories;
    await kvPut(env, 'site_settings', settings);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: 'unknown action' }, 400);
}

// /data/products.json (виртуальный путь, база в products.base.json) → слияние
// с серверными оверрайдами суперадмина, чтобы цены/описания/скрытия
// применялись для всех посетителей и при оплате.
async function handleProductsJson(request, env, url) {
  const asset = await env.ASSETS.fetch(new URL('/data/products.base.json', url));
  if (!asset.ok) return asset;
  let data;
  try {
    data = await asset.json();
  } catch (e) {
    return asset;
  }
  const overrides = await kvGet(env, 'product_overrides');
  const scOverrides = await kvGet(env, 'sc_product_overrides');
  const settings = await kvGet(env, 'site_settings');
  const customProducts = await kvGet(env, 'custom_products');
  const list = Array.isArray(data.products) ? data.products : [];
  list.forEach(function (p) {
    const o = overrides[p.id];
    if (!o) return;
    if (o.price !== undefined && o.price !== '' && o.price !== null) p.price = Number(o.price);
    if (o.discount_price !== undefined && o.discount_price !== '' && o.discount_price !== null) p.discount_price = Number(o.discount_price);
    if (o.description) p.description = o.description;
    if (o.category) p.category = o.category;
    if (o.status) p.status = o.status;
    if (o.eta) p.eta = o.eta;
    if (o.incoming) p.incoming = o.incoming;
    if (o.hidden !== undefined) p.hidden = !!o.hidden;
    if (o.hit !== undefined) p.hit = !!o.hit;
    if (o.priority !== undefined && o.priority !== '' && o.priority !== null) p.priority = Number(o.priority);
    if (o.showDiscount !== undefined) p.showDiscount = !!o.showDiscount;
  });
  // Ручные карточки товаров (созданы суперадмином) — всегда в каталоге:
  // парсер/бот находит их по артикулу и не плодит дубли при повторных синках.
  Object.keys(customProducts).forEach(function (sku) {
    const c = customProducts[sku];
    if (!c || typeof c !== 'object') return;
    const o = overrides[c.id] || {};
    const item = {
      id: c.id,
      sku: c.sku,
      name: c.name,
      category: c.category || 'Прочее',
      price: o.price != null ? Number(o.price) : Number(c.price || 0),
      discount_price: o.discount_price != null ? Number(o.discount_price) : (c.discount_price != null ? Number(c.discount_price) : null),
      description: o.description || c.description || '',
      status: o.status || c.status || 'in_stock',
      eta: c.eta || '',
      incoming: c.incoming || '',
      hidden: o.hidden !== undefined ? !!o.hidden : (c.hidden === true),
      priority: o.priority != null ? Number(o.priority) : (c.priority != null ? Number(c.priority) : null),
      showDiscount: o.showDiscount !== undefined ? !!o.showDiscount : (c.showDiscount !== false),
      custom: true,
      created: c.created || ''
    };
    list.push(item);
  });
  data.showDiscountPrices = settings.showDiscountPrices !== false;
  data.overrides = overrides;
  data.scOverrides = scOverrides;
  data.settings = settings;
  // Кеш 5 мин на edge + SWR 2 часа: каталог меняется только парсером (4 раза в день),
  // но правки суперадмина (бейджи/цены) приходят из KV в каждый ответ — при TTL 5 мин
  // они видны посетителям в течение пары минут. SWR 2 ч: после TTL edge отдаёт
  // закешированный ответ ботам/повторным посетителям и перевыпускает фоном
  // (1 вызов воркера на URL в 5 минут, а не на каждый запрос — экономия сохранена).
  // ETag: повторные запросы ботов уходят по 304 без тела.
  const body = JSON.stringify(data);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const etag = '"' + bytesToHex(digest) + '"';
  const cacheHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=7200', 'ETag': etag };
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  return new Response(body, { headers: cacheHeaders });
}

// ---------------- Telegram ----------------

async function sendTelegram(env, text) {
  const BOT_TOKEN = env.TG_BOT_TOKEN;
  if (!BOT_TOKEN || !env.TG_CHAT_ID) return false;
  try {
    const res = await fetch(`${TELEGRAM_API}${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text, disable_web_page_preview: true })
    });
    return res.ok;
  } catch (e) {
    console.error('Telegram error:', e);
    return false;
  }
}

function buildText(data) {
  const name = (data.name || '').trim();
  const phone = (data.phone || '').trim();
  const type = data.type || 'other';
  const isOrder = type === 'order';
  const head = isOrder ? '🛒 НОВЫЙ ЗАКАЗ' : '🔔 Новая заявка с сайта';

  const blocks = {
    order: [
      '🆔 Номер заказа: ' + (data.order_id || data.orderId || '—'),
      '💳 Оплата: ' + (data.payment || '—'),
      data.partner_id ? '🎫 ID партнёра: ' + data.partner_id + (data.order_partner_mode === '1' ? ' (партнёрские цены)' : '') : null,
      data.order_store ? '🏬 Филиал: ' + data.order_store : null,
      '— Состав заказа —',
      data.order_items ? data.order_items : '—',
      '—',
      '🧾 Пакет-упаковка: ' + (data.order_package || 0) + ' ₸',
      '💰 ИТОГО: ' + (data.order_total || 0) + ' ₸' + (data.payment && data.payment.indexOf('Kaspi') !== -1 ? ' (оплачено)' : ''),
      data.pickup_date ? '📅 Дата приезда: ' + data.pickup_date + (data.pickup_time ? ' в ' + data.pickup_time : '') : null
    ],
    event: [
      '📅 Запись на мероприятие',
      '🎫 ' + (data.event || '—')
    ],
    partner: [
      '🤝 Заявка на партнёрство',
      data.storeName ? '🏪 Магазин: ' + data.storeName : null,
      data.city ? '🏙️ Город: ' + data.city : null,
      data.address ? '📍 Адрес: ' + data.address : null,
      data.experience ? '💼 Тип бизнеса: ' + data.experience : null,
      data.message ? '💬 ' + data.message : null
    ],
    sc_registration: [
      '🏬 Регистрация Сервис-Центра',
      data.storeName ? '🏪 Магазин: ' + data.storeName : null,
      data.email ? '📧 Email: ' + data.email : null,
      data.portalLogin ? '👤 Логин кабинета СЦ: ' + data.portalLogin : null,
      data.portalPassword ? '🔒 Пароль кабинета СЦ: ' + data.portalPassword : null,
      data.city ? '🏙️ Город: ' + data.city : null,
      data.address ? '📍 Адрес: ' + data.address : null,
      data.comment ? '💬 ' + data.comment : null,
      '🔐 Креды хранятся только для работы парсера и не публикуются на сайте.'
    ],
    notice: [
      '📢 Уведомление для Сервис-Центров',
      data.notice ? '💬 ' + data.notice : null
    ],
    subscription: [
      '📦 Заявка на подписку',
      data.package ? '🎁 Пакет: ' + data.package : null,
      data.contact ? '📱 Способ связи: ' + data.contact : null,
      data.city ? '🏙️ Город: ' + data.city : null,
      data.comment ? '💬 ' + data.comment : null
    ],
    consultation: [
      '💬 Консультация по партнёрству',
      data.contact ? '📱 Способ связи: ' + data.contact : null,
      data.city ? '🏙️ Город: ' + data.city : null,
      data.comment ? '💬 ' + data.comment : null
    ],
    join_team: [
      '🤝 Присоединение к команде',
      data.contact ? '📱 Способ связи: ' + data.contact : null,
      data.city ? '🏙️ Город: ' + data.city : null,
      data.comment ? '💬 ' + data.comment : null
    ]
  };

  const lines = [
    head,
    ...(blocks[type] || ['✉️ Новая заявка']).filter(Boolean),
    '👤 Имя: ' + name,
    '📞 Телефон: ' + phone,
    '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', hour12: false })
  ];

  return lines.join('\n');
}

// Проверка даты/времени получения по расписанию филиала: сообщение об ошибке или null.
// Страховка поверх клиентских ограничений — прямое обращение к /telegram не обойдёт.
async function validatePickupSchedule(env, data) {
  const storeId = String(data.orderStoreId || data.store_id || '');
  const pDate = String(data.pickup_date || data.pickupDate || '');
  const pTime = String(data.pickup_time || data.pickupTime || '');
  // Время получения выбирается только для оплаты наличными; без времени (онлайн-оплата) не проверяем
  if (!storeId || !pDate || !pTime) return null;
  const stores = await kvGet(env, 'stores');
  const store = (stores && typeof stores === 'object') ? stores[storeId] : null;
  const sch = store && store.schedule;
  if (!sch) return null;
  const d = new Date(pDate + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const slot = sch[scheduleDayKey(d)];
  if (!slot) return 'Выбранный день — выходной в филиале. Выберите рабочий день.';
  const pM = scheduleMinutes(pTime);
  const openM = scheduleMinutes(slot.open);
  const closeM = scheduleMinutes(slot.close);
  if (pM < 0 || openM < 0 || closeM < 0 || pM < openM || pM >= closeM) {
    return 'Выберите время получения в рабочее время филиала (' + slot.open + '–' + slot.close + ')';
  }
  const n = storeLocalNow();
  if (pDate < n.date) {
    return 'Дата получения не может быть в прошлом. Выберите сегодняшний или следующий день.';
  }
  if (pDate === n.date) {
    if (n.minutes >= closeM - 30) {
      return 'Сегодня уже недоступно — филиал закрывается в ' + slot.close + '. Выберите другой день.';
    }
    if (pM < n.minutes + 30) {
      return 'Время получения должно быть минимум через 30 минут от текущего времени';
    }
  }
  return null;
}

async function handleTelegram(request, env) {
  const BOT_TOKEN = env.TG_BOT_TOKEN;

  let data;
  try {
    data = await request.json();
  } catch (err) {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (data.company) {
    return new Response('ok', { status: 200 });
  }

  // Оформленный заказ: бронь на 2 минуты должна быть активной, иначе 409.
  // При успехе — конверсия брони в заказ (до проверки токена).
  let createdOrder = null;
  if (data.type === 'order') {
    const check = await validateOrderReservation(env, data);
    if (!check.ok) return check.res;
    const schedErr = await validatePickupSchedule(env, data);
    if (schedErr) return jsonResponse({ ok: false, error: 'schedule', message: schedErr }, 409);
    try { createdOrder = await createOrder(env, data); } catch (e) { console.error('createOrder error:', e); }
  }

  // Заказы (корзина) — в группу заказов, остальное — в основной чат
  const isOrder = data.type === 'order';
  const CHAT_ID = (isOrder ? env.TG_ORDERS_CHAT_ID : null) || env.TG_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TG_BOT_TOKEN или TG_CHAT_ID не заданы');
    return new Response('Telegram not configured', { status: 500 });
  }

  const text = buildText(data);

  const res = await fetch(`${TELEGRAM_API}${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Telegram API error:', res.status, body);
    return new Response('Telegram error', { status: 502 });
  }

  // Заказам возвращаем номер (#N) — экран успеха показывает его сразу
  if (isOrder) {
    return new Response(JSON.stringify({ ok: true, number: createdOrder ? createdOrder.number : null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return new Response('ok', { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Публичные GET в KV: ботов режем сразу (403 без чтений KV),
    // трекинг-параметры вырезаем — кеш edge работает по каноничному URL
    if (request.method === 'GET' && PUBLIC_KV_GET.indexOf(path) !== -1) {
      if (isBotRequest(request)) {
        return jsonResponse({ ok: false, error: 'forbidden' }, 403);
      }
      // Кеш edge ключуется по исходному URL запроса, поэтому переписывать
      // URL «внутри» воркера бесполезно — отдаём 301 на каноничный URL
      // (краулеры запоминают редирект, а сам 301 кешируется на сутки)
      const clean = cleanPublicUrl(request.url);
      if (clean.toString() !== url.toString()) {
        return new Response(null, {
          status: 301,
          headers: { 'Location': clean.toString(), 'Cache-Control': 'public, max-age=86400' }
        });
      }
    }

    // 1. Формы → Telegram
    if (path === '/telegram' && request.method === 'POST') {
      return handleTelegram(request, env);
    }

    // 1.1 Вход в кабинет филиала (креды только в секрете STORE_CREDS / KV)
    if (path === '/api/auth' && request.method === 'POST') {
      return handleStoreAuth(request, env);
    }

    // 1.2 Публичная регистрация Сервис-Центра
    if (path === '/api/register-sc' && request.method === 'POST') {
      return handleRegisterSc(request, env);
    }

    // 1.3 Публичный список СЦ (карточки из KV, без паролей)
    if (path === '/api/stores' && request.method === 'GET') {
      return handleStores(env);
    }

    // 1.4 Конфиг для парсера (по API-ключу)
    if (path === '/api/parser-config' && request.method === 'GET') {
      return handleParserConfig(request, env);
    }

    // 1.4.1 Эффективные остатки (база − продажи − активные брони)
    if (path === '/api/stock' && request.method === 'GET') {
      return handleStock(env, url);
    }

    // 1.4.1а Сохранение ручных остатков (суперадмин, по токену)
    if (path === '/api/stock' && request.method === 'POST') {
      const auth = await verifyToken(env, request.headers.get('Authorization'));
      if (!auth || auth.role !== 'superadmin') {
        return jsonResponse({ ok: false, error: 'forbidden' }, 403);
      }
      return handleStockSave(request, env);
    }

    // 1.4.1б Мероприятия: единый список (events.json + правки из KV)
    if (path === '/api/events' && request.method === 'GET') {
      return handleEventsGet(env, url);
    }
    if (path === '/api/events' && request.method === 'POST') {
      const auth = await verifyToken(env, request.headers.get('Authorization'));
      if (!auth || (auth.role !== 'superadmin' && auth.role !== 'sc')) {
        return jsonResponse({ ok: false, error: 'forbidden' }, 403);
      }
      return handleEventsSave(request, env, auth);
    }

    // 1.4.2 Бронь товаров на 2 минуты (оформление заказа)
    if (path === '/api/reserve' && request.method === 'POST') {
      return handleReserve(request, env, url);
    }

    // 1.4.3 Брони мест на мероприятия (единая БД на всех устройствах)
    if (path === '/api/event-bookings' && request.method === 'GET') {
      const bookings = await kvGet(env, 'event_bookings');
      return jsonResponse({ ok: true, bookings }, 200, 600);
    }
    if (path === '/api/event-book' && request.method === 'POST') {
      return handleEventBook(request, env);
    }

    // 1.4.4 «Мои заказы» клиента (по clientToken устройства, без кеша)
    if (path === '/api/my-orders' && request.method === 'GET') {
      return handleMyOrders(request, env);
    }
    if (path === '/api/my-orders/action' && request.method === 'POST') {
      return handleMyOrdersAction(request, env);
    }

    // 1.5 Админские API (суперадмин по токену; /api/sc-stores, /api/orders — суперадмин или свой СЦ)
    if (path === '/api/sc-applications' || path === '/api/sc-application' || path === '/api/sc-store' ||
        path === '/api/sc-store/reset-password' || path === '/api/sc-stores' || path === '/api/admin/products' ||
        path === '/api/admin/parser-run' ||
        path === '/api/sc-archive' || path === '/api/sc-archive/action' ||
        path === '/api/orders' || path === '/api/orders/action') {
      const auth = await verifyToken(env, request.headers.get('Authorization'));
      if (!auth) {
        return jsonResponse({ ok: false, error: 'forbidden' }, 403);
      }
      if (path === '/api/sc-stores' || path === '/api/orders') {
        if (auth.role !== 'superadmin' && auth.role !== 'sc') {
          return jsonResponse({ ok: false, error: 'forbidden' }, 403);
        }
        if (path === '/api/sc-stores' && request.method === 'GET') {
          return handleScStoresAdmin(env, auth);
        }
        if (path === '/api/orders' && request.method === 'GET') {
          return handleOrdersGet(request, env, auth);
        }
        return jsonResponse({ ok: false, error: 'method not allowed' }, 405);
      }
      // Сервис-Центр может сохранять только свой филиал
      if (path === '/api/sc-store' && request.method === 'POST' && auth.role === 'sc') {
        return handleScStore(request, env, auth);
      }
      // Подтверждение/отмена/удаление заказов: СЦ — только свои, суперадмин — все
      if (path === '/api/orders/action' && request.method === 'POST') {
        return handleOrdersAction(request, env, auth);
      }
      if (auth.role !== 'superadmin') {
        return jsonResponse({ ok: false, error: 'forbidden' }, 403);
      }
      if (path === '/api/sc-applications' && request.method === 'GET') {
        return handleScApplications(env);
      }
      if (path === '/api/sc-application' && request.method === 'POST') {
        return handleScApplicationAction(request, env);
      }
      if (path === '/api/sc-store' && request.method === 'POST') {
        return handleScStore(request, env);
      }
      if (path === '/api/sc-store' && request.method === 'DELETE') {
        return handleScStoreDelete(request, env);
      }
      if (path === '/api/sc-store/reset-password' && request.method === 'POST') {
        return handleScStoreResetPassword(request, env);
      }
      if (path === '/api/admin/products' && request.method === 'GET') {
        return handleAdminProductsGet(env);
      }
      if (path === '/api/admin/products' && request.method === 'POST') {
        return handleAdminProducts(request, env);
      }
      if (path === '/api/admin/parser-run' && request.method === 'POST') {
        return handleParserRun(request, env);
      }
      if (path === '/api/sc-archive' && request.method === 'GET') {
        return handleScArchiveGet(env);
      }
      if (path === '/api/sc-archive/action' && request.method === 'POST') {
        return handleScArchiveAction(request, env);
      }
    }

    // 2. /admin и /admin/* → панель Decap CMS (обходим clean-url редиректы)
    if (path === '/admin' || path.startsWith('/admin/')) {
      let r = await env.ASSETS.fetch(new URL('/admin/index.html', url));
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        r = await env.ASSETS.fetch(new URL(r.headers.get('location'), url));
      }
      return r;
    }

    // 3. Остальное — статика.
    // Каталог товаров отдаём через серверные оверрайды суперадмина
    // (цены/описания/категории/скрытие применяются и при оплате).
    if (path === '/data/products.json') {
      return handleProductsJson(request, env, url);
    }

    const asset = await env.ASSETS.fetch(request);

    // 4. data/* — без кеша (каталог обновляется парсером)
    if (path.startsWith('/data/')) {
      const headers = new Headers(asset.headers);
      headers.set('Cache-Control', 'no-cache');
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    }

    return asset;
  }
};
