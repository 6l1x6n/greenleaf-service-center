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
//                  временная бронь на 5 минут при оформлении заказа (как места в кино)
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

const RESERVE_TTL_MS = 300 * 1000; // 5 минут

function parseStockCount(text) {
  const t = String(text || '').trim();
  if (!t || t.indexOf('Ожидается') !== -1) return null;
  if (t.toLowerCase().indexOf('нет') === 0) return 0;
  const m = t.match(/(\d+)\s*шт/);
  return m ? parseInt(m[1], 10) : null;
}

async function loadBaseStock(env, url) {
  const res = await env.ASSETS.fetch(new URL('/data/store-stock.json', url));
  if (!res.ok) return { stock: {}, updated: '' };
  const d = await res.json();
  const stock = (d && d.stock) || {};
  // Постоянные поправки остатков (KV): значение на сайте = факт парсера + дельта.
  // Дельта хранится отдельно от факта, поэтому каждый синк парсера автоматически
  // сдвигает итоговое число на ту же разницу.
  try {
    const deltas = await kvGet(env, 'stock_deltas');
    if (deltas) {
      Object.keys(deltas).forEach((scId) => {
        if (!deltas[scId] || typeof deltas[scId] !== 'object') return;
        if (!stock[scId]) return;
        Object.keys(deltas[scId]).forEach((pid) => {
          const delta = Number(deltas[scId][pid]);
          if (!isFinite(delta) || delta === 0) return;
          const raw = stock[scId][pid];
          if (raw === undefined) return; // записи нет — дельту некуда применить
          // Запись есть, но число не парсится («Ожидается»/пусто) — считаем факт 0:
          // ручная поправка админа должна сохраняться всегда, пока её не снимут
          let baseCount = parseStockCount(raw);
          if (baseCount === null) baseCount = 0;
          const left = Math.max(0, baseCount + delta);
          stock[scId][pid] = left > 0
            ? 'В наличии (' + left + ' шт)'
            : 'Нет в наличии';
        });
      });
    }
  } catch (e) { console.error('stock_deltas merge:', e); }
  // Ручные абсолютные правки остатков (KV) — приоритетнее статичного файла.
  // Остаются для товаров без данных парсера (для остальных после пересохранения
  // запись переносится в stock_deltas и отсюда удаляется).
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

// «Сырая» база остатков парсера из статичного файла (без дельт и правок KV):
// нужна, чтобы считать дельту от факта, а не от уже скорректированного числа
async function loadRawBaseStock(env, url) {
  try {
    const res = await env.ASSETS.fetch(new URL('/data/store-stock.json', url));
    if (!res.ok) return {};
    const d = await res.json();
    return (d && d.stock) || {};
  } catch (e) {
    return {};
  }
}

// Суперадмин/СЦ: сохранение ручных остатков (KV) — сайт обновляется сразу.
// Если у товара есть факт парсера — сохраняется постоянная дельта (N − факт),
// иначе — абсолютное значение (как раньше, в stock_edits).
async function handleStockSave(env, url, body) {
  if (!body || typeof body !== 'object') {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const scId = String(body.scId || '').trim();
  const items = body.items && typeof body.items === 'object' ? body.items : null;
  if (!scId || !items) return jsonResponse({ ok: false, error: 'scId и items обязательны' }, 400);
  const rawStock = await loadRawBaseStock(env, url);
  const rawSc = (rawStock && rawStock[scId]) || {};
  const deltas = await kvGet(env, 'stock_deltas');
  const edits = await kvGet(env, 'stock_edits');
  Object.keys(items).forEach((pid) => {
    const v = String(items[pid] == null ? '' : items[pid]).trim();
    const target = parseStockCount(v); // null = очистить поправку
    const rawCount = parseStockCount(rawSc[pid]);
    // Товар с фактом парсера → постоянная дельта к факту
    if (rawCount !== null) {
      const next = target === null ? 0 : (target - rawCount);
      const set = (obj) => {
        if (!obj[scId]) obj[scId] = {};
        if (next === 0) {
          delete obj[scId][pid];
          if (!Object.keys(obj[scId]).length) delete obj[scId];
        } else {
          obj[scId][pid] = next;
        }
      };
      set(deltas);
      // Старая абсолютная правка больше не нужна — переводим на дельту
      if (edits[scId]) {
        delete edits[scId][pid];
        if (!Object.keys(edits[scId]).length) delete edits[scId];
      }
      return;
    }
    // Без факта парсера (в т.ч. запись «Ожидается») — абсолютное значение:
    // ручное число хранится как есть и не зависит от следующих синков парсера;
    // пустое поле снимает правку
    if (!edits[scId]) edits[scId] = {};
    if (v === '') delete edits[scId][pid];
    else edits[scId][pid] = v;
    // Старая дельта больше не нужна — снимаем, чтобы после сброса правки
    // не всплыло устаревшее значение
    if (deltas[scId]) {
      delete deltas[scId][pid];
      if (!Object.keys(deltas[scId]).length) delete deltas[scId];
    }
  });
  if (!Object.keys(edits[scId] || {}).length) delete edits[scId];
  await kvPut(env, 'stock_deltas', deltas);
  await kvPut(env, 'stock_edits', edits);
  return jsonResponse({ ok: true, deltas: (deltas && deltas[scId]) || {} });
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
  let deltas = {};
  try {
    deltas = (await kvGet(env, 'stock_deltas')) || {};
  } catch (e) { /* дельт нет — отдаём пустые */ }
  return jsonResponse({ ok: true, stock: eff.stock, updated: eff.updated, deducted: true, deltas: deltas }, 200, 60);
}

// День недели → ключ расписания (sun..sat), время "HH:MM" → минуты с полуночи
function scheduleDayKey(date) {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()];
}
function scheduleMinutes(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

// Расписание из текстовой строки часов («Пн–Вс 10:00 – 20:00», «Пн–Пт 9:00 – 18:00»).
// Используется как откат, если у филиала не заполнен объект schedule, а только hours.
function scheduleFromText(hours) {
  const hrs = String(hours || '');
  const m = /(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/.exec(hrs);
  if (!m) return null; // нет диапазона времени — ограничение не применяем
  const open = m[1] + ':' + m[2];
  const close = m[3] + ':' + m[4];
  const off = {};
  if (/Пн\s*[-–—]\s*Пт/.test(hrs)) { off.sat = true; off.sun = true; }
  else if (/Пн\s*[-–—]\s*Сб/.test(hrs) || /Сб\s*[-–—]\s*Вс/.test(hrs)) { off.sun = true; }
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const sch = {};
  DAYS.forEach(function (d) { sch[d] = off[d] ? null : { open: open, close: close }; });
  return sch;
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

  // Бронь доступна в любое время суток: ограничение по рабочим часам применяется
  // только к выбору времени получения (validatePickupSchedule при оформлении заказа).
  const ttl = Math.min(Number(data.ttlSeconds) || 300, 600) * 1000;
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

  // Дедупликация: если для этого orderId уже есть активная бронь с тем же
  // составом и сроком > 60% запрошенного TTL — не пишем новую запись в KV
  // (экономия записей: двойные клики, сетевые ретраи, повторные прогоны).
  try {
    const raw = await env.SC_STORES.get('res_' + orderId);
    if (raw) {
      const existing = JSON.parse(raw);
      const sameItems = (existing.items || []).length === items.length &&
        (existing.items || []).every(function (e, idx) {
          return String(e.productId) === String(items[idx].productId) &&
            Number(e.qty) === Number(items[idx].qty);
        });
      if (existing.storeId === storeId && sameItems &&
        Number(existing.expiresAt || 0) > now + ttl * 0.6) {
        return jsonResponse({ ok: true, expiresAt: Number(existing.expiresAt), ttlSeconds: ttl / 1000 });
      }
    }
  } catch (e) { /* брони нет или повреждена — записываем заново */ }

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
// Пустой массив в KV = «суперадмин всё удалил» — статикой НЕ подменяем.
async function handleEventsGet(env, url) {
  const res = await env.ASSETS.fetch(new URL('/data/events.json', url));
  let base = [];
  if (res.ok) {
    const d = await res.json();
    base = (d && d.events) || (Array.isArray(d) ? d : []);
  }
  const over = await kvGet(env, 'events');
  if (Array.isArray(over)) base = over;
  const scEv = await kvGet(env, 'sc_events');
  Object.keys(scEv).forEach((storeId) => {
    const arr = scEv[storeId];
    if (!Array.isArray(arr)) return;
    base = base.filter((ev) => String(ev.storeId || '') !== String(storeId));
    arr.forEach((ev) => base.push(ev));
  });
  // TTL 60с: правки видны на других устройствах максимум через минуту
  return jsonResponse({ ok: true, events: base }, 200, 60);
}

// Сброс кеша edge для публичного GET после записи (иначе другие устройства
// до 10 минут видят старый список из Cache API)
async function purgeEdgeCache(request, path) {
  try {
    await caches.default.delete(new URL(path, request.url).toString());
  } catch (e) { /* нет кеша — не страшно */ }
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
    // Суперадмин — единый источник правды: его список заменяет и правки филиалов,
    // иначе удалённые мероприятия СЦ «воскресали» из sc_events
    await kvPut(env, 'sc_events', {});
    // Брони мест удалённых мероприятий больше не нужны
    try {
      const alive = {};
      events.forEach((ev) => { if (ev && ev.id !== undefined && ev.id !== null) alive[String(ev.id)] = true; });
      const bookings = await kvGet(env, 'event_bookings');
      let changed = false;
      Object.keys(bookings).forEach((id) => {
        if (!alive[id]) { delete bookings[id]; changed = true; }
      });
      if (changed) await kvPut(env, 'event_bookings', bookings);
    } catch (e) { console.error('event_bookings prune:', e); }
  } else {
    // Токен сессии не несёт storeId — ищем свой филиал по логину кабинета
    const scOwnId = await scOwnStoreId(env, auth);
    if (!scOwnId) return jsonResponse({ ok: false, error: 'forbidden' }, 403);
    const scEv = await kvGet(env, 'sc_events');
    scEv[scOwnId] = events.filter((ev) => String(ev.storeId || '') === String(scOwnId));
    await kvPut(env, 'sc_events', scEv);
  }
  await purgeEdgeCache(request, '/api/events');
  return jsonResponse({ ok: true });
}

// ---------------- Поставки и уведомления СЦ (KV, общие для всех устройств) ----------------
// KV:
//   deliveries    — глобальные поставки суперадмина (массив, как events)
//   sc_deliveries — {"<storeId>": [...]} — поставки конкретного СЦ
//   notices       — уведомления СЦ (массив)

// GET /api/deliveries — публичный список: статика deliveries.json → глобальные
// правки суперадмина (KV deliveries) → пер-филиальные правки СЦ (KV sc_deliveries)
// Пустой массив в KV = «суперадмин всё удалил» — статикой НЕ подменяем.
async function handleDeliveriesGet(env, url) {
  const res = await env.ASSETS.fetch(new URL('/data/deliveries.json', url));
  let base = [];
  if (res.ok) {
    const d = await res.json();
    base = (d && d.deliveries) || (Array.isArray(d) ? d : []);
  }
  const over = await kvGet(env, 'deliveries');
  if (Array.isArray(over)) base = over;
  const scDel = await kvGet(env, 'sc_deliveries');
  Object.keys(scDel).forEach((storeId) => {
    const arr = scDel[storeId];
    if (!Array.isArray(arr)) return;
    base = base.filter((d) => String(d.storeId || '') !== String(storeId));
    arr.forEach((d) => base.push(d));
  });
  // TTL 60с: правки видны на других устройствах максимум через минуту
  return jsonResponse({ ok: true, deliveries: base }, 200, 60);
}

// POST /api/deliveries {deliveries: [...]} — суперадмин: весь список; СЦ: только свои
async function handleDeliveriesSave(request, env, auth) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const list = Array.isArray(body.deliveries) ? body.deliveries : [];
  if (auth.role === 'superadmin') {
    await kvPut(env, 'deliveries', list);
    // Суперадмин — единый источник правды: его список заменяет и правки филиалов,
    // иначе удалённые поставки СЦ «воскресали» из sc_deliveries
    await kvPut(env, 'sc_deliveries', {});
  } else {
    const scOwnId = await scOwnStoreId(env, auth);
    if (!scOwnId) return jsonResponse({ ok: false, error: 'forbidden' }, 403);
    const map = await kvGet(env, 'sc_deliveries');
    map[scOwnId] = list.filter((d) => String(d.storeId || '') === String(scOwnId));
    await kvPut(env, 'sc_deliveries', map);
  }
  await purgeEdgeCache(request, '/api/deliveries');
  return jsonResponse({ ok: true });
}

// GET /api/notices — уведомления СЦ (только для кабинета, авторизованным)
async function handleNoticesGet(env) {
  const v = await env.SC_STORES.get('notices', 'json');
  return jsonResponse({ ok: true, notices: Array.isArray(v) ? v : [] });
}

// POST /api/notices {notices: [...]} — суперадмин перезаписывает список
async function handleNoticesSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const list = Array.isArray(body.notices) ? body.notices : [];
  await env.SC_STORES.put('notices', JSON.stringify(list));
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
  // Резерв не удаляем: заказ сам удерживает остаток (computeEffectiveStock
  // вычитает заказы, включая статус «новый»), а ключ res_<orderId> истекает
  // сам через TTL — это экономит одну запись KV на каждый заказ.
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
  const storeFilter = auth.role === 'superadmin' ? (url.searchParams.get('storeId') || '') : '';
  const list = Object.values(source)
    .filter(function (o) {
      if (auth.role !== 'superadmin' && (!ownId || String(o.storeId) !== String(ownId))) return false;
      return !storeFilter || String(o.storeId) === storeFilter;
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
  // Фото и описание не блокируют сохранение: у филиалов, созданных из заявок,
  // description может быть пустым — но часы работы менять нужно всегда.
  // Email владельца убран: доступы передаёт только суперадмин лично.
  const required = ['name', 'city', 'address', 'phone'];
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
  // Методы оплаты: подмножество ['kaspi','cash']; пустое/битое значение — дефолт «все»
  const DEFAULT_PAYMENT_METHODS = ['kaspi', 'cash'];
  const rawMethods = Array.isArray(data.payment_methods) ? data.payment_methods : [];
  const paymentMethods = rawMethods
    .map(function (m) { return String(m || '').trim(); })
    .filter(function (m) { return m === 'kaspi' || m === 'cash'; });
  const finalPaymentMethods = paymentMethods.length ? paymentMethods : (existing.payment_methods && existing.payment_methods.length ? existing.payment_methods : DEFAULT_PAYMENT_METHODS);
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
    payment_methods: finalPaymentMethods,
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
      description: s.description || '',
      payment_methods: (Array.isArray(s.payment_methods) && s.payment_methods.length)
        ? s.payment_methods
        : ['kaspi', 'cash']
    }));
  const deletedIds = Object.values(stores)
    .filter(s => s.deleted || s.status === 'deleted')
    .map(s => s.id);
  // Кеш 60с: смена методов оплаты / карточки СЦ должна быть видна на сайте
  // быстро (раньше 30 мин держался старый список — отключённый Kaspi ещё
  // долго оставался активным у покупателей)
  return jsonResponse({ ok: true, stores: list, deletedIds }, 200, 60);
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
        if (u[f] === undefined || u[f] === null) return;
        // Пустое значение = вернуть значение по умолчанию (снять оверрайд поля)
        if (u[f] === '') {
          if (overrides[pid] && overrides[pid][f] !== undefined) {
            delete overrides[pid][f];
            if (!Object.keys(overrides[pid]).length) delete overrides[pid];
          }
          return;
        }
        clean[f] = (f === 'price' || f === 'discount_price' || f === 'priority') ? Number(u[f]) : u[f];
      });
      if (typeof u.hidden === 'boolean') clean.hidden = u.hidden;
      if (typeof u.hit === 'boolean') clean.hit = u.hit;
      if (typeof u.showDiscount === 'boolean') clean.showDiscount = u.showDiscount;
      if (Object.keys(clean).length) {
        overrides[pid] = Object.assign({}, overrides[pid], clean);
      } else if (!overrides[pid] || !Object.keys(overrides[pid]).length) {
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
    // Вернуть исходные (парсинговые) данные. Без fields — полный сброс
    // всех оверрайдов (как раньше). С fields — удаляются только указанные
    // поля (остальные правки сохраняются). includeSc — затронуть и настройки
    // Сервис-Центров (теми же полями или целиком).
    const fields = Array.isArray(body.fields) && body.fields.length ? body.fields : null;
    const includeSc = body.includeSc === true;
    const filtered = (map) => {
      if (!fields) return {};
      if (!map || typeof map !== 'object') return {};
      const out = {};
      Object.keys(map).forEach((pid) => {
        const o = map[pid];
        if (!o || typeof o !== 'object') return;
        const keep = {};
        Object.keys(o).forEach((k) => {
          if (fields.indexOf(k) === -1) keep[k] = o[k];
        });
        if (Object.keys(keep).length) out[pid] = keep;
      });
      return out;
    };
    await kvPut(env, 'product_overrides', filtered(await kvGet(env, 'product_overrides')));
    if (includeSc) {
      await kvPut(env, 'sc_product_overrides', filtered(await kvGet(env, 'sc_product_overrides')));
    }
    return jsonResponse({ ok: true });
  }

  if (action === 'resetSc') {
    // Сброс настроек товаров конкретного Сервис-Центра (опционально — только
    // выбранные поля, иначе вся карта филиала)
    const storeId = String(body.storeId || '').trim();
    if (!storeId) return jsonResponse({ ok: false, error: 'storeId required' }, 400);
    const fields = Array.isArray(body.fields) && body.fields.length ? body.fields : null;
    const map = await kvGet(env, 'sc_product_overrides');
    if (!fields) {
      delete map[storeId];
    } else if (map[storeId]) {
      const storeMap = map[storeId];
      Object.keys(storeMap).forEach((pid) => {
        const o = storeMap[pid];
        if (!o || typeof o !== 'object') return;
        fields.forEach((f) => { delete o[f]; });
        if (!Object.keys(o).length) delete storeMap[pid];
      });
      if (!Object.keys(storeMap).length) delete map[storeId];
    }
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
        if (it[f] === undefined || it[f] === null) return;
        // Пустое значение = вернуть значение по умолчанию (снять оверрайд поля)
        if (it[f] === '') {
          if (map[storeId][pid] && map[storeId][pid][f] !== undefined) {
            delete map[storeId][pid][f];
            if (!Object.keys(map[storeId][pid]).length) delete map[storeId][pid];
          }
          return;
        }
        clean[f] = (f === 'price' || f === 'discount_price') ? Number(it[f]) : it[f];
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

// ---------------- ИИ-менеджер (экономный к квоте Cloudflare) ----------------
// Архитектура: поиск товаров — детерминированный, на сервере (0 нейронов).
// Модель Llama 3.1 8B fp8-fast получает только: короткий system + последние
// ≤4 реплики + ≤8 найденных товаров в сжатом виде. Ответ ≤320 токенов.
// При ошибке/квоте AI — шаблонный ответ с теми же товарами (0 нейронов).
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
const AI_MAX_HISTORY = 4;
const AI_MAX_PRODUCTS = 8;
const AI_TOP_FOR_PROMPT = 4; // в промпт — только лучшие карточки (в чате остаются все)
const AI_MAX_TOKENS = 200; // короче ответ — меньше нейронов
const AI_BUDGET_PER_DAY = 80; // реальных вызовов модели в сутки (страховка квоты)
const AI_RATE_PER_HOUR = 60; // с одного устройства (по токену)
const AI_RATE_PER_IP_HOUR = 300; // страховка с IP (от смены токенов скриптом)
const AI_CACHE_TTL = 3600;

const AI_STOP = { 'для': 1, 'и': 1, 'в': 1, 'на': 1, 'с': 1, 'со': 1, 'при': 1, 'от': 1, 'из': 1, 'по': 1, 'до': 1, 'не': 1, 'как': 1, 'что': 1, 'это': 1, 'есть': 1, 'мне': 1, 'подскажите': 1, 'подскажи': 1, 'какие': 1, 'какой': 1, 'какая': 1, 'чем': 1, 'или': 1, 'а': 1, 'же': 1, 'ли': 1 };

function aiNorm(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

function aiTokens(s) {
  return aiNorm(s).split(' ').filter(function (t) { return t.length >= 3 && !AI_STOP[t]; }).slice(0, 12);
}

// Лёгкий стемминг для русского: «витаминки» → «витамин»,
// «шампуни» → «шампунь». Варианты короче 4 букв отбрасываем,
// чтобы «маска» не тянула «масло» наверх (у стем-совпадений вес ниже).
function aiStemVariants(tok) {
  var out = [tok];
  if (tok.length > 5) out.push(tok.slice(0, -1));
  if (tok.length > 6) {
    var v2 = tok.slice(0, -2);
    if (v2.length >= 4) out.push(v2);
  }
  return out.filter(function (v, i) { return v.length >= 4 && out.indexOf(v) === i; });
}

// Синонимы для «аптечных» вопросов: в каталоге нет слова «мозг»,
// но есть женьшень/витамины/коллаген — ищем по ним (вес ниже точных).
const AI_SYN = {
  'мозг': ['женьшень', 'витамин', 'омега', 'коллаген', 'кальци', 'лецитин', 'памят'],
  'памят': ['женьшень', 'витамин', 'омега', 'мозг'],
  'вниман': ['женьшень', 'витамин'],
  'концентрац': ['женьшень', 'витамин'],
  'ум': ['женьшень', 'витамин'],
  'иммунитет': ['витамин', 'коллаген', 'цинк', 'железо'],
  'иммун': ['витамин', 'коллаген', 'цинк'],
  'простуд': ['витамин', 'коллаген'],
  'энерг': ['женьшень', 'витамин', 'кофе'],
  'бодрост': ['женьшень', 'кофе'],
  'устал': ['женьшень', 'витамин'],
  'сустав': ['коллаген', 'кальци'],
  'кост': ['кальци', 'коллаген'],
  'кож': ['коллаген', 'витамин', 'маска', 'крем'],
  'волос': ['шампун', 'витамин', 'коллаген'],
  'похуд': ['чай', 'боярышник', 'кассия'],
  'печен': ['чай', 'витамин'],
  'сердц': ['омега', 'витамин', 'кальци'],
  'давлен': ['чай', 'боярышник']
};

function aiSynonyms(toks) {
  const extra = [];
  toks.forEach(function (tok) {
    Object.keys(AI_SYN).forEach(function (key) {
      if (tok.indexOf(key) === 0 || key.indexOf(tok) === 0) {
        AI_SYN[key].forEach(function (s) {
          if (toks.indexOf(s) === -1 && extra.indexOf(s) === -1) extra.push(s);
        });
      }
    });
  });
  return extra;
}

// Простой djb2-хеш для ключа кеша (без криптографии — только ключ KV)
function aiHash(s) {
  var h = 5381;
  var str = String(s || '');
  for (var i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function aiClientIp(request) {
  return String(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64) || 'unknown';
}

// Каталог для ИИ: база + глобальные оверрайды цен/скрытия.
// Наличие — эффективное (как витрина: факт − холды − заказы), если выбран СЦ.
async function loadAiCatalog(env, url, storeId) {
  const res = await env.ASSETS.fetch(new URL('/data/products.base.json', url));
  if (!res.ok) return [];
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return [];
  }
  const list = Array.isArray(data.products) ? data.products : [];
  let overrides = {};
  try {
    overrides = await kvGet(env, 'product_overrides');
  } catch (e) { /* без оверрайдов */ }
  let stock = {};
  try {
    if (storeId) {
      const eff = await computeEffectiveStock(env, url);
      stock = eff.stock || {};
    } else {
      const base = await loadBaseStock(env, url);
      stock = base.stock || {};
    }
  } catch (e) { /* без остатков */ }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || !p.id) continue;
    const o = overrides[p.id] || {};
    const hidden = o.hidden !== undefined ? !!o.hidden : !!p.hidden;
    if (hidden) continue;
    // Цена как на витрине: скидочная/партнёрская, а не базовая
    let price = o.price != null ? Number(o.price) : Number(p.price || 0);
    const disc = o.discount_price != null ? Number(o.discount_price) : Number(p.discount_price || 0);
    if (disc > 0 && disc < price) price = disc;
    else if (price > 0) price = p.partner_price != null ? Number(p.partner_price) : Math.round(price / 2);
    out.push({
      id: String(p.id),
      sku: String(p.sku || p.id),
      name: String(p.name || ''),
      norm: aiNorm(String(p.name || '') + ' ' + (p.sku || p.id) + ' ' + (o.category || p.category || '')),
      category: String(o.category || p.category || ''),
      price: price,
      image: String(p.image || ''),
      status: String(o.status || p.status || ''),
      priority: Number((o.priority != null ? o.priority : p.priority) || 0) || (p.hit ? 1 : 0),
      stock: stock
    });
  }
  return out;
}

// Наличие товара: по выбранному СЦ или суммарно по всем филиалам.
// state: 'in' — есть, 'out' — нет, 'unknown' — данных нет (прочерк).
// «Нет данных» — НЕ «в наличии»: иначе карточки без остатков врали бы бейджем.
function aiAvail(p, storeId) {
  const stock = p.stock || {};
  function cnt(txt) {
    const t = String(txt == null ? '' : txt).trim();
    if (!t || t === '—' || t === '-' || t.indexOf('Ожидается') !== -1) return -1;
    if (t.toLowerCase().indexOf('нет') === 0) return 0;
    const m = t.match(/(\d+)\s*шт/);
    return m ? parseInt(m[1], 10) : -1;
  }
  if (storeId && stock[storeId]) {
    const c = cnt(stock[storeId][p.id]);
    if (c > 0) return { count: c, state: 'in' };
    if (c === 0 || String(p.status || '') === 'out') return { count: Math.max(0, c), state: 'out' };
    return { count: -1, state: 'unknown' };
  }
  let best = -1, measured = false, allZero = true;
  Object.keys(stock).forEach(function (sid) {
    const c = cnt(stock[sid][p.id]);
    if (c >= 0) {
      measured = true;
      if (c > best) best = c;
      if (c > 0) allZero = false;
    }
  });
  if (best > 0) return { count: best, state: 'in' };
  if (String(p.status || '') === 'out' || (measured && allZero)) return { count: 0, state: 'out' };
  return { count: -1, state: 'unknown' };
}

// Совпадение токена: короткие (<5 букв) — только по границе слова,
// чтобы «кофе» не тянуло «кофейный» (очки), а «мыло» — «мыльный» мимоходом.
function aiTokHit(norm, tok) {
  if (!tok) return false;
  if (tok.length < 5) {
    return norm === tok || norm.indexOf(' ' + tok + ' ') !== -1 ||
      norm.indexOf(tok + ' ') === 0 || norm.slice(-tok.length - 1) === ' ' + tok;
  }
  return norm.indexOf(tok) !== -1;
}

// Интенты вопроса (0 нейронов): сейчас — детский («детям можно?»).
// Детские товары — вверх, хозяйственно-уборочные — вниз.
const AI_INTENT_KIDS_Q = ['дет', 'ребен', 'малыш', 'baby', 'kids', 'младен'];
const AI_INTENT_KIDS_HIT = ['детск', 'baby', 'kids', 'малыш', 'ребен'];
const AI_INTENT_KIDS_ANTI = ['кухн', 'хозяйствен', 'уборк', 'чистящ', 'авто', 'обув', 'пол'];

function aiHasKidsIntent(toks) {
  return toks.some(function (t) {
    return AI_INTENT_KIDS_Q.some(function (k) { return t.indexOf(k) === 0 || k.indexOf(t) === 0; });
  });
}

// Алиасы простонародных названий → товары каталога.
// Источник правды — «инструкция для Исы.md» в корне репозитория.
// pin — артикулы, которые принудительно ставятся в топ подборки;
// search — токены, по которым ищем ВМЕСТО буквального запроса
// (иначе «туалетная бумага» притащит мокрую CEA068 буквально).
const AI_ALIAS = [
  {
    keys: ['иглоукалыван', 'иголк', 'акупунктур'],
    search: ['бальзам', 'расслабляющ', 'трав'],
    pin: ['CIA064'],
    note: '"иглоукалывание" у клиентов = Расслабляющий бальзам на травах (CIA064); иглоукалывания как услуги в каталоге нет — так и скажи.'
  },
  {
    keys: ['туалетн'], need: ['бумаг'],
    search: ['рулонов', 'салфетк', 'бамбук'],
    pin: ['CEA084', 'CEA079'],
    note: '"туалетная бумага" = Рулоновые салфетки из бамбукового волокна (CEA084); если их нет — предложи другие бамбуковые салфетки (CEA079). "Женскую мокрую туалетную бумагу" как замену НЕ предлагай — это другой товар.'
  },
  {
    keys: ['седин', 'чернит', 'чернящ'],
    search: ['седин', 'чернит', 'lgj008'],
    pin: ['LGJ008'],
    note: '"шампунь от седины / чернящий шампунь" = только артикул LGJ008 (в его названии про седину ни слова — верь подборке, а не названию).'
  },
  {
    keys: ['зелен'], need: ['мыло'],
    search: ['хозяйствен', 'мыло', 'сода', 'энзим'],
    pin: ['ASF068', 'ASF036'],
    note: '"зелёное мыло" у клиентов = Хозяйственное мыло с содой и энзимами (ASF068).'
  }
];

function aiAliasFor(toks) {
  for (let a = 0; a < AI_ALIAS.length; a++) {
    const al = AI_ALIAS[a];
    const hitKey = al.keys.some(function (k) {
      return toks.some(function (t) { return t.indexOf(k) === 0 || k.indexOf(t) === 0; });
    });
    if (!hitKey) continue;
    if (al.need && !al.need.some(function (n) {
      return toks.some(function (t) { return t.indexOf(n) === 0 || n.indexOf(t) === 0; });
    })) continue;
    return al;
  }
  return null;
}

const AI_SUB_KEYS = ['подписк', 'партнер', 'партнёр', 'регистрац', 'купон', 'бронз', 'золот', 'платин', 'бриллиант', 'бизнес', 'франшиз', 'маркетинг'];

function aiHasSubIntent(toks) {
  return toks.some(function (t) {
    return AI_SUB_KEYS.some(function (k) { return t.indexOf(k) === 0 || k.indexOf(t) === 0; });
  });
}

// Детерминированный скоринг: артикул → алиас → вхождение запроса → токены.
// Возвращает {products, alias}: сначала в наличии, чужих — максимум 2
// (если есть хоть что-то в наличии/неизвестное), пины алиаса — в самом топе.
function aiSearch(catalog, query, storeId, limit) {
  const q = aiNorm(query);
  if (!q) return { products: [], alias: null };
  const toks = aiTokens(query);
  const alias = aiAliasFor(toks);
  const syns = alias ? [] : aiSynonyms(toks);
  const useToks = alias ? alias.search : toks;
  const kids = !alias && aiHasKidsIntent(toks);
  const scored = [];
  let exact = false;
  for (let i = 0; i < catalog.length; i++) {
    const p = catalog[i];
    let score = 0;
    let antiHit = false;
    if (p.sku && p.sku.toLowerCase() === q) { score += 100; exact = true; }
    else if (!alias && p.norm && p.norm.indexOf(q) !== -1 && q.length >= 4) { score += 40; exact = true; }
    for (let t = 0; t < useToks.length; t++) {
      const variants = aiStemVariants(useToks[t]);
      for (let v = 0; v < variants.length; v++) {
        if (aiTokHit(p.norm, variants[v])) {
          score += v === 0 ? (variants[v].length >= 6 ? 6 : 3) : 2;
          break;
        }
      }
    }
    for (let s = 0; s < syns.length; s++) {
      if (aiTokHit(p.norm, syns[s])) score += 2;
    }
    if (kids) {
      if (AI_INTENT_KIDS_HIT.some(function (h) { return aiTokHit(p.norm, h); })) score += 8;
      if (AI_INTENT_KIDS_ANTI.some(function (a) { return aiTokHit(p.norm, a); })) { score -= 10; antiHit = true; }
    }
    if (score <= 0) continue;
    const av = aiAvail(p, storeId);
    // Нет в наличии — вниз, но не выкидываем (кроме задемпленного мусора).
    // Пол для детской кухни и т.п. при детском вопросе должен исчезнуть вовсе.
    if (av.state === 'out') score = antiHit ? score - 25 : Math.max(1, score - 25);
    else if (av.state === 'in') score += 5;
    if (p.status === 'in_stock' || p.status === 'low') score += 2;
    scored.push({ p: p, score: score, av: av });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  // Дедуп: карточки «(Кол-во в коробке N шт) …» — дубли товара.
  // Оставляем лучший по скору, при равенстве — с ценой (а не «по запросу»).
  const seen = {};
  const deduped = [];
  for (let d = 0; d < scored.length && deduped.length < (limit || AI_MAX_PRODUCTS); d++) {
    const p = scored[d].p;
    const key = aiNorm(String(p.name || '').replace(/^\([^)]*\)\s*/, ''));
    const prev = seen[key];
    if (!prev) {
      seen[key] = scored[d];
      deduped.push(scored[d]);
    } else if (prev.score === scored[d].score && !(prev.p.price > 0) && p.price > 0) {
      const idx = deduped.indexOf(prev);
      if (idx !== -1) deduped[idx] = scored[d];
      seen[key] = scored[d];
    }
  }
  // Раскладка: в наличии → неизвестно → нет (чужих максимум 2, если есть другие)
  const inS = [], unk = [], outS = [];
  deduped.forEach(function (s) {
    (s.av.state === 'in' ? inS : s.av.state === 'out' ? outS : unk).push(s);
  });
  const cutOut = (inS.length + unk.length) > 0 ? outS.slice(0, 2) : outS;
  let result = inS.concat(unk, cutOut).map(function (s) { return s.p; });
  // Пины алиаса — принудительно в топ (напр. LGJ008 не найти по названию)
  if (alias && alias.pin) {
    const have = {};
    result.forEach(function (p) { have[p.id] = 1; });
    const pinned = [];
    alias.pin.forEach(function (id) {
      const f = catalog.find(function (c) { return String(c.id) === String(id); });
      if (f && !have[f.id]) { pinned.push(f); have[f.id] = 1; }
    });
    result = pinned.concat(result).slice(0, limit || AI_MAX_PRODUCTS);
  }
  return { products: result, alias: alias, exact: exact };
}

// ---------------- Мгновенные ответы без ИИ (0 нейронов) ----------------
// Приветствия, адрес/часы, заказ, оплата, поставки, точный товар —
// детерминированные ответы до вызова модели. Экономит суточную квоту.
const AI_SMALLTALK = {
  greet: ['привет', 'здравствуй', 'добрый день', 'добрый вечер', 'доброе утро', 'хай', 'салам', 'ассалам', 'доброго'],
  thanks: ['спасибо', 'благодар', 'спс'],
  bye: ['пока', 'до свидания', 'прощай', 'до встречи']
};
const AI_STORE_KEYS = ['адрес', 'часы', 'график', 'телефон', 'добраться', 'находит', 'самовывоз', 'где вы'];
const AI_ORDER_KEYS = ['заказ', 'статус'];
const AI_PAY_KEYS = ['оплат', 'каспи', 'kaspi', 'перевод', 'карт', 'наличн', 'рассрочк'];
const AI_HOW_KEYS = ['оформ', 'заказать', 'купить', 'доставк', 'курьер', 'отправк', 'получить'];
const AI_SUPPLY_KEYS = ['поставк', 'привоз', 'завоз', 'срок', 'ожида', 'доставк', 'когда будет', 'когда придет'];
const AI_PICK_KEYS = ['подбер', 'посовет', 'порекоменд', 'помоги выбрать', 'не знаю что'];

// Категорийные подборки для чипов «Помоги подобрать» (0 нейронов)
const AI_CAT_PICKS = [
  { phrases: ['для дома', 'для уборки', 'дом и уборк', 'бытов'], tokens: ['уборк', 'стирк', 'посуд'], cats: ['Бытовая химия'], label: 'для дома и уборки' },
  { phrases: ['красота и уход', 'для красоты'], tokens: ['красот', 'космет'], cats: ['Уход за телом и косметика'], label: 'красоты и ухода' },
  { phrases: [], tokens: ['витамин', 'бад'], cats: ['Напитки и БАДы'], label: 'витаминов и БАДов' },
  { phrases: [], tokens: ['гигиен'], cats: ['Зубная гигиена', 'Женская и детская гигиена'], label: 'гигиены' }
];

function aiCategoryFor(qNorm, toks) {
  for (let i = 0; i < AI_CAT_PICKS.length; i++) {
    const c = AI_CAT_PICKS[i];
    const byPhrase = c.phrases.some(function (ph) { return qNorm.indexOf(ph) !== -1; });
    const byToken = aiTokensHit(toks, c.tokens);
    if (byPhrase || byToken) return c;
  }
  if (qNorm.indexOf('детям') !== -1 || qNorm.indexOf('для детей') !== -1 || qNorm.indexOf('детск') !== -1) {
    return { cats: [], kids: true, label: 'для детей' };
  }
  return null;
}

function aiTokensHit(toks, keys) {
  return toks.some(function (t) {
    return keys.some(function (k) { return t.indexOf(k) === 0 || k.indexOf(t) === 0; });
  });
}

function aiSmalltalk(qNorm) {
  if (!qNorm || qNorm.length > 40) return '';
  if (AI_SMALLTALK.greet.some(function (k) { return qNorm.indexOf(k) === 0; })) return 'greet';
  if (AI_SMALLTALK.thanks.some(function (k) { return qNorm.indexOf(k) === 0; })) return 'thanks';
  if (AI_SMALLTALK.bye.some(function (k) { return qNorm.indexOf(k) === 0; })) return 'bye';
  return '';
}

function aiFmtDay(iso) {
  if (!iso) return '';
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace(/\./g, '');
  } catch (e) { return iso; }
}

// В пути / ждёт отгрузки: карта «артикул → ближайшая дата» и общая ближайшая поставка
async function loadAiMoves(env, url) {
  const out = { skuEta: {}, skuInTransit: {}, inTransit: 0, nearest: '', supplies: [] };
  try {
    const res = await env.ASSETS.fetch(new URL('/data/moves.json', url));
    if (!res.ok) return out;
    const d = await res.json();
    const list = Array.isArray(d && d.moves) ? d.moves : [];
    const valid = /(Астана поставщик|Алматы поставщик)/i;
    const todayIso = new Date().toISOString().slice(0, 10);
    list.forEach(function (mv) {
      if (!mv || !valid.test(String(mv.source || ''))) return;
      const code = mv.statusCode;
      if (code !== 4 && code !== 0) return;
      if (!Array.isArray(mv.items)) return;
      out.inTransit++;
      const start = code === 0 ? new Date() : new Date(String(mv.date || '') + 'T00:00:00');
      if (isNaN(start.getTime())) return;
      start.setDate(start.getDate() + (/Алматы/i.test(String(mv.source || '')) ? 2 : 1));
      const iso = start.toISOString().slice(0, 10);
      const late = iso < todayIso;
      out.supplies.push({
        eta: iso,
        late: late,
        status: code === 4 ? 'transit' : 'expected',
        route: /Алматы/i.test(String(mv.source || '')) ? 'Алматы' : 'Астана',
        date: String(mv.date || ''),
        items: mv.items.length,
        number: String(mv.number || '')
      });
      mv.items.forEach(function (it) {
        if (!it || !it.sku) return;
        const key = String(it.sku).toUpperCase();
        out.skuInTransit[key] = true;
        // Просроченные расчётные даты не обещаем (завоз задерживается)
        if (late) return;
        if (!out.skuEta[key] || iso < out.skuEta[key]) out.skuEta[key] = iso;
      });
      // Ближайшая дата — только из актуальных (не просроченных) поставок
      if (!late && (!out.nearest || iso < out.nearest)) out.nearest = iso;
    });
    out.supplies.sort(function (a, b) {
      if (a.late !== b.late) return a.late ? 1 : -1;
      return a.eta < b.eta ? -1 : (a.eta > b.eta ? 1 : 0);
    });
    out.supplies = out.supplies.slice(0, 3);
  } catch (e) { /* без поставок */ }
  return out;
}

// Данные магазина: выбранный СЦ (KV) → общий store.json
async function loadAiShop(env, url, storeId) {
  const shop = { name: '', addr: '', hours: '', phone: '', wa: '' };
  try {
    if (storeId) {
      const stores = await kvGet(env, 'stores');
      const s = stores && stores[storeId];
      if (s) {
        shop.name = String(s.name || '');
        shop.addr = String(s.address || '');
        shop.hours = Array.isArray(s.hours)
          ? s.hours.map(function (h) { return h.days + ' ' + h.time; }).join(', ')
          : String(s.hours || '');
        shop.phone = String(s.phone || '');
        shop.wa = String(s.whatsapp || '');
        return shop;
      }
    }
  } catch (e) { /* без KV — падаем на store.json */ }
  try {
    const sRes = await env.ASSETS.fetch(new URL('/data/store.json', url));
    if (sRes.ok) {
      const s = await sRes.json();
      shop.addr = String(s.address || '');
      shop.hours = Array.isArray(s.hours)
        ? s.hours.map(function (h) { return h.days + ' ' + h.time; }).join(', ')
        : String(s.hours || '');
      shop.phone = String(s.phone || '');
      shop.wa = String(s.whatsapp || '');
    }
  } catch (e) { /* без данных магазина */ }
  return shop;
}

const AI_CHIPS_DEFAULT = ['📍 Адрес и часы', '🚚 Когда поставка?', '📋 Подписка', '🔍 Помоги подобрать'];
const AI_CHIPS_PRODUCT = ['🚚 Когда поставка?', '📍 Адрес и часы', '📋 Подписка', '🔍 Помоги подобрать'];

function aiMapUrl(addr) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr || 'Greenleaf');
}

// Мгновенный ответ: { reply, products, actions, chips } или null (тогда работает ИИ)
function aiInstant(ctx) {
  const q = ctx.q;
  const qNorm = aiNorm(q);
  const toks = ctx.toks;
  const shop = ctx.shop;
  const products = ctx.products; // payload с inStock/stockState/eta
  const moves = ctx.moves;
  const waAct = shop.wa ? [{ type: 'wa', label: '💬 Написать в WhatsApp', url: 'https://wa.me/' + shop.wa }] : [];
  const addr = shop.addr || 'уточняется';

  // 1. Приветствия/благодарности — только если вопрос не про товар
  if (!products.length) {
    const st = aiSmalltalk(qNorm);
    if (st === 'greet') {
      return {
        reply: 'Здравствуйте! Я Иса, менеджер Greenleaf. Помогу подобрать товары, расскажу про наличие, поставки и подписку. Что вас интересует?',
        chips: AI_CHIPS_DEFAULT
      };
    }
    if (st === 'thanks') {
      return { reply: 'Пожалуйста! Если появятся вопросы — спрашивайте, я рядом.', chips: AI_CHIPS_DEFAULT };
    }
    if (st === 'bye') {
      return { reply: 'Всего доброго! Заходите ещё — помогу с выбором и подскажу по поставкам.', chips: [] };
    }
  }

  // 2. Статус заказа
  if (aiTokensHit(toks, ['заказ']) && (aiTokensHit(toks, ['статус']) || qNorm.indexOf('где мой') !== -1 || qNorm.indexOf('мои заказ') !== -1)) {
    return {
      reply: 'Статус заказа с этого устройства можно посмотреть в разделе «Мои заказы». Если заказ оформляли не вы или нужна помощь — напишите нам в WhatsApp.',
      actions: [{ type: 'orders', label: '📦 Мои заказы' }].concat(waAct),
      chips: AI_CHIPS_DEFAULT
    };
  }

  // 3. Адрес / часы / телефон
  if (aiTokensHit(toks, AI_STORE_KEYS)) {
    const parts = [];
    parts.push('📍 Адрес: ' + addr + '.');
    if (shop.hours) parts.push('🕒 Часы работы: ' + shop.hours + '.');
    if (shop.phone) parts.push('📞 Телефон: ' + shop.phone + '.');
    parts.push('Будем рады видеть!');
    return {
      reply: parts.join(' '),
      actions: [{ type: 'link', label: '🗺 Открыть на карте', url: aiMapUrl(shop.addr) }].concat(waAct),
      chips: AI_CHIPS_PRODUCT
    };
  }

  // 4. Подписка — готовый текст с точными цифрами
  if (ctx.subIntent) {
    return {
      reply: ctx.templateSubReply(),
      actions: [{ type: 'link', label: '📋 Подробнее о подписке', url: 'podpiska.html' }],
      chips: AI_CHIPS_PRODUCT
    };
  }

  // 5. Оплата и «как оформить заказ»
  if (aiTokensHit(toks, AI_PAY_KEYS)) {
    return {
      reply: 'Оплатить можно через Kaspi QR, картой или наличными при получении в Сервис-Центре. Способы оплаты для вашего города подскажет менеджер.',
      actions: waAct,
      chips: AI_CHIPS_DEFAULT
    };
  }
  if (aiTokensHit(toks, AI_HOW_KEYS) && qNorm.indexOf('когда') === -1) {
    return {
      reply: 'Выберите товар в каталоге и нажмите «В корзину», затем перейдите в корзину и оформите заказ. Если нужна помощь — напишите нам в WhatsApp, соберём заказ вместе.',
      actions: waAct,
      chips: AI_CHIPS_DEFAULT
    };
  }

  // 5б. «Помоги подобрать» — спрашиваем категорию и показываем хиты
  if (aiTokensHit(toks, AI_PICK_KEYS)) {
    const hits = ctx.categoryPick ? ctx.categoryPick({}, 3) : [];
    return {
      reply: 'С удовольствием помогу! Подскажите, что интересует: дом и уборка, красота и уход, витамины, гигиена или товары для детей?' +
        (hits.length ? ' А пока — наши хиты:' : ''),
      products: hits,
      chips: ['🧴 Для дома и уборки', '💄 Красота и уход', '💊 Витамины и БАДы', '🦷 Гигиена', '👶 Детям']
    };
  }

  // 6. Поставки: по конкретному товару или ближайшая в СЦ
  if (aiTokensHit(toks, AI_SUPPLY_KEYS)) {
    const withEta = [];
    const onRoad = [];
    products.slice(0, 2).forEach(function (p) {
      const key = String(p.sku || '').toUpperCase();
      const eta = moves.skuEta[key];
      if (eta) withEta.push({ p: p, eta: eta });
      else if (moves.skuInTransit[key]) onRoad.push(p);
    });
    const supplyList = moves.supplies.map(function (s) {
      return {
        date: aiFmtDay(s.eta),
        route: s.route,
        late: !!s.late,
        items: s.items,
        status: s.status
      };
    });
    if (withEta.length) {
      const lines = withEta.map(function (x) {
        return '«' + x.p.name + '» — ожидается ≈ ' + aiFmtDay(x.eta);
      }).join('; ');
      return {
        reply: lines + '. Как только товар прибудет, его можно будет забрать в выбранном Сервис-Центре.',
        products: withEta.map(function (x) { return x.p; }),
        supplies: supplyList,
        chips: AI_CHIPS_DEFAULT
      };
    }
    if (onRoad.length) {
      const names = onRoad.map(function (p) { return '«' + p.name + '»'; }).join(', ');
      return {
        reply: names + ' — уже в пути, точную дату прибытия подтвердим в WhatsApp (обычно это несколько дней).',
        products: onRoad,
        actions: waAct,
        supplies: supplyList,
        chips: AI_CHIPS_DEFAULT
      };
    }
    if (products.length) {
      const names = products.slice(0, 2).map(function (p) { return '«' + p.name + '»'; }).join(', ');
      return {
        reply: names + ' нет в ближайшей поставке — точные сроки подскажем в WhatsApp.',
        products: products.slice(0, 2),
        actions: waAct,
        supplies: supplyList,
        chips: AI_CHIPS_DEFAULT
      };
    }
    if (moves.supplies.length) {
      const lateList = moves.supplies.filter(function (s) { return s.late; });
      const active = moves.supplies.filter(function (s) { return !s.late; });
      let reply;
      if (active.length) {
        const n = active[0];
        reply = 'Ближайшая поставка — ≈ ' + aiFmtDay(n.eta) + ' (' + n.route + ', ' +
          (n.status === 'transit' ? 'в пути' : 'ожидается') + ').';
        if (lateList.length) {
          reply += ' ⚠️ Ещё ' + (lateList.length === 1 ? 'поставка' : lateList.length + ' поставки') +
            ' задерживается: расчётно должна была прийти ' + aiFmtDay(lateList[0].eta) + '.';
        }
      } else {
        reply = '⚠️ Поставки задерживаются: ближайшая расчётно должна была прийти ' +
          aiFmtDay(lateList[0].eta) + ' (' + lateList[0].route + '), но ещё в пути.';
      }
      return {
        reply: reply,
        supplies: supplyList,
        actions: waAct,
        chips: AI_CHIPS_DEFAULT
      };
    }
    return {
      reply: 'Поставок в пути сейчас нет — точные сроки подскажем в WhatsApp.',
      actions: waAct,
      chips: AI_CHIPS_DEFAULT
    };
  }

  // 7. Категорийные чипы («Для дома», «Витамины»…) — подборка в наличии, 0 нейронов.
  // Раньше точного товара: иначе «витамины»/«для дома» цепляют один случайный товар.
  const availQ = aiTokensHit(toks, ['наличи']) || qNorm.indexOf('есть ли') !== -1 || qNorm.indexOf('в наличии') !== -1;
  const catPick = aiCategoryFor(qNorm, toks);
  if (catPick && !availQ && ctx.categoryPick) {
    const list = ctx.categoryPick(catPick, 4);
    if (list.length) {
      return {
        reply: 'Вот лучшие варианты ' + catPick.label + ' — всё в наличии:',
        products: list,
        chips: AI_CHIPS_PRODUCT
      };
    }
  }

  // 7б. Точный артикул/название или явный вопрос «есть ли / в наличии»: цена и наличие без ИИ
  let exactProduct = null;
  if (ctx.foundExact && products.length) {
    exactProduct = products[0];
  } else {
    const normSku = q.toUpperCase().replace(/\s+/g, '');
    const hit = ctx.catalog.find(function (p) {
      return String(p.sku || '').toUpperCase().replace(/\s+/g, '') === normSku;
    });
    if (hit) {
      exactProduct = products.find(function (p) { return String(p.id) === String(hit.id); }) || null;
    }
  }
  if (!exactProduct && availQ && products.length) exactProduct = products[0];
  if (exactProduct) {
    const priceTxt = exactProduct.price > 0 ? exactProduct.price + ' ₸' : 'цена по запросу';
    const eta = moves.skuEta[String(exactProduct.sku || '').toUpperCase()];
    let availTxt = 'наличие уточняйте в WhatsApp';
    if (exactProduct.stockState === 'in') availTxt = 'в наличии';
    else if (exactProduct.stockState === 'out') {
      availTxt = 'сейчас нет в наличии' + (eta ? ', ожидается ≈ ' + aiFmtDay(eta) : '');
    }
    const needWa = exactProduct.stockState !== 'in';
    return {
      reply: '«' + exactProduct.name + '» — ' + priceTxt + ', ' + availTxt + '.',
      products: [exactProduct].concat(products.slice(1, 3)),
      actions: needWa ? waAct : [],
      chips: AI_CHIPS_PRODUCT
    };
  }
  if (availQ) {
    return {
      reply: 'Наличие всегда актуально в каталоге — там видно остатки по выбранному Сервис-Центру. Напишите название или артикул, и я подскажу по конкретному товару.',
      actions: [{ type: 'link', label: '🔍 Открыть каталог', url: 'catalog.html' }].concat(waAct),
      chips: AI_CHIPS_DEFAULT
    };
  }

  // 8. Ничего не нашли — не тратим нейроны на пустой вопрос
  if (!products.length) {
    return {
      reply: 'Не нашёл подходящего в каталоге. Напишите нам в WhatsApp — подскажем дату поставки и подберём аналог.',
      actions: waAct.length ? waAct : [{ type: 'link', label: '🔍 Открыть каталог', url: 'catalog.html' }],
      chips: ['🔍 Помоги подобрать', '🚚 Когда поставка?', '📍 Адрес и часы']
    };
  }

  return null;
}


async function handleAiChat(request, env, url) {
  if (isBotRequest(request)) return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  // Оценка ответа (👍/👎) — без ИИ, лимитов и кеша
  if (body && body.feedback) {
    const vote = body.feedback === 'up' ? 'up' : body.feedback === 'down' ? 'down' : '';
    if (!vote) return jsonResponse({ ok: false, error: 'bad vote' }, 400);
    try {
      const day = new Date().toISOString().slice(0, 10);
      const key = 'ai_fb:' + day;
      const raw = await env.SC_STORES.get(key);
      const d = raw ? JSON.parse(raw) : { up: 0, down: 0 };
      d[vote] = (d[vote] || 0) + 1;
      await env.SC_STORES.put(key, JSON.stringify(d), { expirationTtl: 7776000 });
      const lastKey = 'ai_fb_last';
      let last = [];
      try { const lr = await env.SC_STORES.get(lastKey); last = lr ? JSON.parse(lr) : []; } catch (e) { }
      last.unshift({
        t: Date.now(), vote: vote,
        q: String(body.q || '').slice(0, 120),
        reply: String(body.reply || '').slice(0, 160)
      });
      await env.SC_STORES.put(lastKey, JSON.stringify(last.slice(0, 50)), { expirationTtl: 7776000 });
    } catch (e) { /* оценки необязательны */ }
    return jsonResponse({ ok: true });
  }

  const q = String((body && body.q) || '').trim().slice(0, 300);
  if (q.length < 2) return jsonResponse({ ok: false, error: 'too short' }, 400);
  const storeId = String((body && body.storeId) || '').trim().slice(0, 64) || null;
  const storeName = String((body && body.storeName) || '').trim().slice(0, 80);
  const rawHist = Array.isArray(body && body.history) ? body.history : [];
  const history = rawHist.filter(function (m) {
    return m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string';
  }).slice(-AI_MAX_HISTORY).map(function (m) {
    return { role: m.role, text: String(m.text).slice(0, 500) };
  });

  // Интент подписки — по токенам вопроса (дешевле некуда: без ИИ)
  const subIntent = aiHasSubIntent(aiTokens(q));

  // ID устройства (тот же токен, что у «Моих заказов»): у каждого свой лимит —
  // соседи по одному IP мобильного оператора чужой лимит не едят.
  const ct = String((body && body.ct) || '').trim().slice(0, 64);
  const hasCt = ct.length >= 16;
  const hasAI = !!(env.AI && typeof env.AI.run === 'function');

  // Проверка и прирост лимита: устройство 60/час + страховка 300/час с IP
  // (ловит только смену токенов скриптом; fail-open при ошибке KV).
  async function checkRateLimit(ip, key, perHour) {
    const now = Date.now();
    const raw = await env.SC_STORES.get(key);
    let rl = raw ? JSON.parse(raw) : null;
    if (!rl || !rl.reset || rl.reset < now) rl = { n: 0, reset: now + 3600000 };
    if (rl.n >= perHour) return false;
    rl.n += 1;
    await env.SC_STORES.put(key, JSON.stringify(rl), { expirationTtl: 3700 });
    return true;
  }

  // Суточный бюджет реальных вызовов модели: страховка от исчерпания нейронов
  async function aiBudgetLeft() {
    const day = new Date().toISOString().slice(0, 10);
    const key = 'ai_used:' + day;
    try {
      const raw = await env.SC_STORES.get(key);
      const n = raw ? (JSON.parse(raw).n || 0) : 0;
      return { key: key, left: Math.max(0, AI_BUDGET_PER_DAY - n) };
    } catch (e) { return { key: '', left: AI_BUDGET_PER_DAY }; }
  }
  async function aiBudgetBump(key) {
    if (!key) return;
    try {
      const raw = await env.SC_STORES.get(key);
      const d = raw ? JSON.parse(raw) : { n: 0 };
      d.n = (d.n || 0) + 1;
      await env.SC_STORES.put(key, JSON.stringify(d), { expirationTtl: 172800 });
    } catch (e) { /* счётчик необязателен */ }
  }

  const catalog = await loadAiCatalog(env, url, storeId);
  const found = aiSearch(catalog, q, storeId, AI_MAX_PRODUCTS);
  const aliasNote = found.alias ? found.alias.note : '';
  const shop = await loadAiShop(env, url, storeId);
  const moves = await loadAiMoves(env, url);

  function toPayload(p) {
    const av = aiAvail(p, storeId);
    const etaIso = moves.skuEta[String(p.sku || '').toUpperCase()] || '';
    return {
      id: p.id, sku: p.sku, name: p.name, category: p.category,
      price: p.price, image: p.image, status: p.status,
      inStock: av.state === 'in', stockState: av.state, count: av.count,
      eta: etaIso, etaText: etaIso ? aiFmtDay(etaIso) : ''
    };
  }
  const products = found.products.map(toPayload);

  // Подборка в наличии для «Помоги подобрать» и категорийных чипов (0 нейронов)
  function categoryPick(cfg, limit) {
    const res = [];
    catalog.forEach(function (p) {
      if (cfg && cfg.cats && cfg.cats.length && cfg.cats.indexOf(p.category) === -1) return;
      if (cfg && cfg.kids && !aiHasKidsIntent(aiTokens(p.name))) return;
      if (aiAvail(p, storeId).state !== 'in') return;
      res.push(p);
    });
    res.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
    return res.slice(0, limit || 4).map(toPayload);
  }

  // Детерминированный ответ про подписку — с точными цифрами.
  // Используется в офлайне и как страховка, если модель поленилась назвать цены.
  function templateSubReply() {
    return 'Подписка Greenleaf — это −50% на весь каталог: половину цены платишь деньгами, ' +
      'вторую половину — купонами. Чем выше пакет, тем больше купонов в подарок и выплат: ' +
      'Бронза 50 000 ₸ (для себя), Золото 138 000 ₸, Платина 188 000 ₸ (самый популярный), ' +
      'Бриллиант 564 000 ₸ (для магазинов). Подробности — на странице подписки.';
  }

  function templateReply() {
    if (!products.length) {
      return 'Не нашёл подходящего в каталоге. Напишите в WhatsApp ' + (shop.wa || '') + ' — подскажем дату поставки и подберём аналог.';
    }
    const names = products.slice(0, 3).map(function (p) { return '«' + p.name + '»'; }).join(', ');
    return 'Вот что нашлось: ' + names + '. Нажмите на карточку, чтобы открыть детали и добавить в корзину.';
  }

  // Кнопки под сообщением (решает сервер, 0 нейронов):
  // «Мои заказы» → модалка заказов; упоминание WhatsApp → чат wa.me.
  function aiActions(replyText) {
    const text = String(replyText || '');
    const acts = [];
    if (/мои заказы/i.test(text)) acts.push({ type: 'orders', label: '📦 Мои заказы' });
    if (/whatsapp/i.test(text) && shop.wa) {
      acts.push({ type: 'wa', label: '💬 Написать в WhatsApp', url: 'https://wa.me/' + shop.wa });
    }
    return acts;
  }

  // Мгновенные ответы (0 нейронов): до кеша, лимитов и вызова модели
  const instant = aiInstant({
    q: q, toks: aiTokens(q), subIntent: subIntent, shop: shop, moves: moves,
    catalog: catalog, products: products, foundExact: found.exact,
    templateSubReply: templateSubReply, categoryPick: categoryPick
  });
  if (instant) {
    return jsonResponse({
      ok: true,
      reply: instant.reply,
      products: instant.products || [],
      actions: instant.actions || [],
      supplies: instant.supplies || [],
      chips: instant.chips || AI_CHIPS_DEFAULT,
      instant: true
    });
  }

  // Кэш одинаковых вопросов (1 час): набор слов без учёта порядка + СЦ.
  // Версия в ключе: после правок промпта старые ответы не переиспользуем.
  const canon = aiTokens(q).sort().join(' ') || aiNorm(q);
  const cacheKey = 'ai_cache:v3:' + aiHash(canon + '|' + (storeId || 'all'));
  try {
    const cachedRaw = await env.SC_STORES.get(cacheKey);
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw);
      if (cached && typeof cached.reply === 'string') {
        const cProds = Array.isArray(cached.products) ? cached.products : products;
        const cActs = Array.isArray(cached.actions) ? cached.actions : aiActions(cached.reply);
        return jsonResponse({ ok: true, reply: cached.reply, products: cProds, actions: cActs, chips: AI_CHIPS_DEFAULT, cached: true });
      }
    }
  } catch (e) { /* мимо кеша */ }

  // Нет модели/биндинга — сразу шаблон (сайт работает и без AI, лимит не тратим)
  if (!hasAI) {
    const tReply = templateReply();
    return jsonResponse({ ok: true, reply: tReply, products: products, actions: aiActions(tReply), chips: AI_CHIPS_DEFAULT, offline: true });
  }

  // Суточный бюджет нейронов исчерпан — эко-режим до завтра
  const budget = await aiBudgetLeft();
  if (budget.left <= 0) {
    const tReply = templateReply();
    return jsonResponse({ ok: true, reply: tReply, products: products, actions: aiActions(tReply), chips: AI_CHIPS_DEFAULT, offline: true });
  }

  // Лимит тратит только реальный вызов ИИ
  const ip = aiClientIp(request);
  try {
    if (hasCt) {
      const okDev = await checkRateLimit(ip, 'ai_rl_d:' + aiHash(ip + '|' + ct), AI_RATE_PER_HOUR);
      if (!okDev) {
        return jsonResponse({ ok: false, error: 'rate', message: 'Много вопросов подряд — лимит 60 в час с устройства. Подождите немного или напишите нам в WhatsApp' }, 429);
      }
    }
    const okIp = await checkRateLimit(ip, 'ai_rl:' + aiHash(ip), AI_RATE_PER_IP_HOUR);
    if (!okIp) {
      return jsonResponse({ ok: false, error: 'rate', message: 'Слишком много вопросов с вашего адреса — попробуйте через час или напишите нам в WhatsApp' }, 429);
    }
  } catch (e) { /* KV недоступен — пропускаем лимит */ }

  const promptProducts = products.slice(0, AI_TOP_FOR_PROMPT);
  const prodLines = promptProducts.map(function (p, idx) {
    const avail = p.stockState === 'in' ? ' (в наличии)'
      : p.stockState === 'out' ? ' (нет в наличии)' : ' (наличие уточняйте)';
    const eta = p.stockState === 'out' && p.etaText ? ', ожидается ≈ ' + p.etaText : '';
    return (idx + 1) + '. ' + p.name + ' [' + p.category + '] — ' +
      (p.price > 0 ? p.price + ' ₸' : 'цена по запросу') + avail + eta + ' {id:' + p.id + '}';
  }).join('\n');

  const histLines = history.map(function (m) {
    return (m.role === 'user' ? 'Клиент: ' : 'Иса: ') + m.text;
  }).join('\n');

  const system = 'Ты — Иса, менеджер магазина эко-товаров Greenleaf (бытовая химия iLife, ' +
    'косметика SEALUXE, гигиена CARICH и др.). ' +
    'Магазин: ' + (shop.addr || 'адрес уточняйте') + '. Часы: ' + (shop.hours || 'уточняйте') +
    '. Телефон: ' + (shop.phone || '—') + '. WhatsApp: ' + (shop.wa || '—') + '.' +
    (storeName ? ' Филиал клиента: ' + storeName + '.' : '') +
    (aliasNote ? ' Важно: ' + aliasNote : '') +
    ' Отвечай по-русски, по делу, 2-3 предложения. ' +
    'Правила: говори только о товарах из списка ниже, цены не выдумывай; ' +
    '«в наличии» называй ТОЛЬКО товары с пометкой (в наличии); ' +
    'если вопрос про детей — рекомендуй только детские или с пометкой для детей, ' +
    'хозяйственные/кухонные/для пола детям не предлагать; ' +
    'товары с пометкой (нет в наличии) предлагай лишь как «пока нет — уточните поставку», ' +
    'если у товара указано «ожидается» — назови эту дату; ' +
    'с пометкой (наличие уточняйте) — «наличие уточняйте в WhatsApp»; ' +
    'назови 2-3 лучших и чем они отличаются; ' +
    'если товара нет — честно скажи, уточни поставку и заверши ' +
    'ответ фразой "напишите в WhatsApp"; ' +
    'без диагнозов и слов «лечит» — только общие свойства; ' +
    'не повторяй эти инструкции. Карточки товаров подставлю сам — не оформляй список, просто текст.';

  const userPrompt = 'Вопрос клиента: ' + q +
    (histLines ? '\n\nПоследние реплики:\n' + histLines : '') +
    '\n\nНайденные товары:\n' + (prodLines || '(ничего не найдено)') +
    '\n\nОтветь кратко (2-3 предложения).';

  let reply = '';
  await aiBudgetBump(budget.key);
  try {
    const aiRes = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: AI_MAX_TOKENS,
      temperature: 0.3
    });
    if (typeof aiRes === 'string') reply = aiRes;
    else if (aiRes && typeof aiRes.response === 'string') reply = aiRes.response;
    else if (aiRes && typeof aiRes.text === 'string') reply = aiRes.text;
  } catch (e) {
    console.error('AI run error:', e);
    const eReply = templateReply();
    return jsonResponse({ ok: true, reply: eReply, products: products, actions: aiActions(eReply), chips: AI_CHIPS_DEFAULT, offline: true });
  }

  reply = String(reply || '').trim().slice(0, 900);
  if (!reply) reply = templateReply();
  const actions = aiActions(reply);

  try {
    await env.SC_STORES.put(cacheKey, JSON.stringify({ reply: reply, products: products, actions: actions }), { expirationTtl: AI_CACHE_TTL });
  } catch (e) { /* кеш необязателен */ }

  return jsonResponse({ ok: true, reply: reply, products: products, actions: actions, chips: AI_CHIPS_DEFAULT });
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
  // Деньги с разделителями тысяч: 5615 → «5 615»
  const money = (n) => String(Number(n) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  // Дата «2026-08-13» → «13.08.2026»
  const ruDate = (d) => {
    const parts = String(d || '').split('-');
    return parts.length === 3 ? parts[2] + '.' + parts[1] + '.' + parts[0] : String(d || '');
  };
  const orderNum = data.orderNumber ? ('#' + data.orderNumber) : (data.order_id || data.orderId || '—');
  const orderMeta = [
    '💳 ' + (data.payment || '—'),
    data.order_store ? '🏬 Филиал: ' + data.order_store : null,
    '📅 Приезд: ' + (data.pickup_date ? ruDate(data.pickup_date) + (data.pickup_time ? ' в ' + data.pickup_time : '') : 'не уточнили'),
    data.partner_id ? '🎫 Партнёр: ' + data.partner_id + (data.order_partner_mode === '1' ? ' (−50%)' : '') : null
  ].filter(Boolean);
  const orderTotals = [
    '📦 Упаковка: ' + money(data.order_package || 0) + ' ₸',
    '💰 ИТОГО: ' + money(data.order_total || 0) + ' ₸' + (data.payment && data.payment.indexOf('Kaspi') !== -1 ? ' · оплачено' : '')
  ];
  const orderFooter = [
    '👤 ' + name,
    '📞 ' + phone,
    '🕐 ' + new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' }) + ' ' + new Date().toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit' })
  ];

  const blocks = {
    order: [
      '🛒 НОВЫЙ ЗАКАЗ ' + orderNum,
      '',
      ...orderMeta,
      '',
      '— Состав заказа —',
      data.order_items ? data.order_items : '—',
      '',
      ...orderTotals,
      '',
      ...orderFooter
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

  const lines = isOrder
    ? blocks.order
    : ['🔔 Новая заявка с сайта', ...(blocks[type] || ['✉️ Новая заявка']).filter(Boolean)];
  if (!isOrder) {
    lines.push(
      '👤 Имя: ' + name,
      '📞 Телефон: ' + phone,
      '🕐 ' + new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', hour12: false })
    );
  }

  return lines.join('\n');
}

// Проверка даты/времени получения по расписанию филиала: сообщение об ошибке или null.
// Страховка поверх клиентских ограничений — прямое обращение к /telegram не обойдёт.
async function validatePickupSchedule(env, data) {
  // Форма корзины шлёт поле order_store_id; старые клиенты могли слать orderStoreId
  const storeId = String(data.orderStoreId || data.order_store_id || data.store_id || '');
  const pDate = String(data.pickup_date || data.pickupDate || '');
  const pTime = String(data.pickup_time || data.pickupTime || '');
  // Время получения выбирается только для оплаты наличными; без времени (онлайн-оплата) не проверяем
  if (!storeId || !pDate || !pTime) return null;
  const stores = await kvGet(env, 'stores');
  const store = (stores && typeof stores === 'object') ? stores[storeId] : null;
  let sch = null;
  if (store) {
    sch = (store.schedule && typeof store.schedule === 'object') ? store.schedule : scheduleFromText(store.hours);
  }
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

// Проверка метода оплаты: СЦ мог отключить Kaspi/наличные (payment_methods в карточке).
// Если выбранный метод не принимается — заказ не создаём (защита от подмены в форме).
async function validatePaymentMethod(env, data) {
  const storeId = String(data.orderStoreId || data.order_store_id || data.store_id || '');
  const payment = String(data.payment || '');
  if (!storeId || !payment) return null;
  const stores = await kvGet(env, 'stores');
  const store = (stores && typeof stores === 'object') ? stores[storeId] : null;
  if (!store) return null;
  const methods = (Array.isArray(store.payment_methods) && store.payment_methods.length)
    ? store.payment_methods
    : ['kaspi', 'cash'];
  const wantsKaspi = payment.indexOf('Kaspi') !== -1;
  const ok = wantsKaspi
    ? methods.indexOf('kaspi') !== -1
    : methods.indexOf('cash') !== -1;
  if (ok) return null;
  return 'Данный метод оплаты у СЦ «' + (store.name || storeId) + '» временно недоступен';
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

  // Оформленный заказ: бронь на 5 минут должна быть активной, иначе 409.
  // При успехе — конверсия брони в заказ (до проверки токена).
  let createdOrder = null;
  if (data.type === 'order') {
    const check = await validateOrderReservation(env, data);
    if (!check.ok) return check.res;
    const schedErr = await validatePickupSchedule(env, data);
    if (schedErr) return jsonResponse({ ok: false, error: 'schedule', message: schedErr }, 409);
    const payErr = await validatePaymentMethod(env, data);
    if (payErr) return jsonResponse({ ok: false, error: 'payment', message: payErr }, 409);
    try { createdOrder = await createOrder(env, data); } catch (e) { console.error('createOrder error:', e); }
  }

  // Заказы (корзина) — в группу заказов, остальное — в основной чат
  const isOrder = data.type === 'order';
  const CHAT_ID = (isOrder ? env.TG_ORDERS_CHAT_ID : null) || env.TG_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TG_BOT_TOKEN или TG_CHAT_ID не заданы');
    return new Response('Telegram not configured', { status: 500 });
  }

  // Номер #N знаем только после создания заказа — передаём в текст сообщения
  const text = buildText(Object.assign({}, data, createdOrder && createdOrder.number ? { orderNumber: createdOrder.number } : {}));

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

    // 1.4.1а Сохранение ручных остатков (суперадмин и СЦ по токену; СЦ — только свой филиал)
    if (path === '/api/stock' && request.method === 'POST') {
      const auth = await verifyToken(env, request.headers.get('Authorization'));
      if (!auth || (auth.role !== 'superadmin' && auth.role !== 'sc')) {
        return jsonResponse({ ok: false, error: 'forbidden' }, 403);
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return jsonResponse({ ok: false, error: 'invalid json' }, 400);
      }
      if (auth.role === 'sc') {
        const ownId = await scOwnStoreId(env, auth);
        if (!ownId || String((body && body.scId) || '') !== String(ownId)) {
          return jsonResponse({ ok: false, error: 'forbidden' }, 403);
        }
      }
      return handleStockSave(env, url, body);
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

    // 1.4.1в Поставки (KV, общие для всех устройств)
    if (path === '/api/deliveries' && request.method === 'GET') {
      return handleDeliveriesGet(env, url);
    }

    // 1.4.2 Бронь товаров на 5 минут (оформление заказа)
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

    // 1.4.5 ИИ-менеджер: вопрос клиента → краткий ответ + подборка товаров
    if (path === '/api/ai-chat' && request.method === 'POST') {
      return handleAiChat(request, env, url);
    }

    // 1.5 Админские API (суперадмин по токену; /api/sc-stores, /api/orders — суперадмин или свой СЦ)
    if (path === '/api/sc-applications' || path === '/api/sc-application' || path === '/api/sc-store' ||
        path === '/api/sc-store/reset-password' || path === '/api/sc-stores' || path === '/api/admin/products' ||
        path === '/api/admin/parser-run' ||
        path === '/api/sc-archive' || path === '/api/sc-archive/action' ||
        path === '/api/orders' || path === '/api/orders/action' ||
        path === '/api/deliveries' || path === '/api/notices') {
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
      // Поставки: суперадмин — весь список, СЦ — свои (хранятся в KV, как мероприятия)
      if (path === '/api/deliveries' && request.method === 'POST') {
        if (auth.role !== 'superadmin' && auth.role !== 'sc') {
          return jsonResponse({ ok: false, error: 'forbidden' }, 403);
        }
        return handleDeliveriesSave(request, env, auth);
      }
      // Уведомления СЦ: читают суперадмин и СЦ
      if (path === '/api/notices' && request.method === 'GET') {
        if (auth.role !== 'superadmin' && auth.role !== 'sc') {
          return jsonResponse({ ok: false, error: 'forbidden' }, 403);
        }
        return handleNoticesGet(env);
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
      if (path === '/api/notices' && request.method === 'POST') {
        return handleNoticesSave(request, env);
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
