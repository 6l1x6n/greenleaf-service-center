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
//   RESEND_API_KEY          — ключ почтового сервиса Resend (письма с логинами/паролями)
//   RESEND_FROM             — отправитель писем (опционально, по умолчанию onboarding@resend.dev)
// KV namespace SC_STORES:
//   stores       — {"<storeId>": { id, officeCode, name, city, cityKey, address, hours,
//                   phone, phoneRaw, whatsapp, email, image, description, status, partner,
//                   portalLogin, portalPassword, authLogin, authPassword, createdAt }}
//   applications — {"<appId>": { id, name, phone, email, storeName, city, address, officeCode,
//                   portalLogin, portalPassword, comment, status: pending|approved|rejected,
//                   createdAt }}
//   users        — {"<email>": { id, email, name, phone, password, role: 'client', createdAt }}
//   reservations — {"<orderId>": { storeId, items: [{productId, qty}], createdAt, expiresAt }}
//   sales        — {"<storeId>": { "<productId>": qty }} — постоянное списание по заказам

const TELEGRAM_API = 'https://api.telegram.org/bot';
const TOKEN_TTL = 12 * 3600; // 12 часов

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
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
  return { stock: (d && d.stock) || {}, updated: (d && d.updated) || '' };
}

async function activeReservations(env) {
  const all = await kvGet(env, 'reservations');
  const now = Date.now();
  let changed = false;
  const out = {};
  Object.keys(all).forEach((id) => {
    const r = all[id];
    if (r && r.expiresAt && r.expiresAt > now) out[id] = r;
    else { delete all[id]; changed = true; }
  });
  if (changed) await kvPut(env, 'reservations', all);
  return out;
}

// Эффективные остатки: строка «В наличии (N шт)» уменьшается на продажи и активные брони.
// excludeOrderId — своя бронь при валидации новой.
async function computeEffectiveStock(env, url, excludeOrderId) {
  const base = await loadBaseStock(env, url);
  const sales = await kvGet(env, 'sales');
  const reservations = await activeReservations(env);
  const stock = {};
  Object.keys(base.stock).forEach((scId) => {
    const src = base.stock[scId];
    stock[scId] = {};
    Object.keys(src).forEach((pid) => {
      const baseCount = parseStockCount(src[pid]);
      if (baseCount === null) { stock[scId][pid] = src[pid]; return; }
      let sold = (sales[scId] && sales[scId][pid]) || 0;
      let res = 0;
      Object.keys(reservations).forEach((oid) => {
        if (excludeOrderId && oid === excludeOrderId) return;
        const r = reservations[oid];
        if (!r) return;
        const item = (r.items || []).find((i) => i.productId === pid && i.storeId === scId);
        if (item) res += Number(item.qty) || 0;
      });
      const left = baseCount - sold - res;
      stock[scId][pid] = left > 0
        ? 'В наличии (' + left + ' шт)'
        : 'Нет в наличии';
    });
  });
  return { stock, updated: base.updated };
}

async function handleStock(env, url) {
  const eff = await computeEffectiveStock(env, url);
  return jsonResponse({ ok: true, stock: eff.stock, updated: eff.updated, deducted: true });
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
  const ttl = Math.min(Number(data.ttlSeconds) || 120, 300) * 1000;
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

  reservations[orderId] = { storeId, items, createdAt: new Date().toISOString(), expiresAt: now + ttl };
  await kvPut(env, 'reservations', reservations);
  return jsonResponse({ ok: true, expiresAt: now + ttl, ttlSeconds: ttl / 1000 });
}

// Конверсия брони в продажу (постоянное списание) — при оформлении заказа
async function commitSalesFromOrder(env, data) {
  const orderId = String(data.order_id || data.orderId || '').trim();
  if (!orderId) return;
  const reservations = await activeReservations(env);
  const res = reservations[orderId];
  if (!res || !res.items || !res.items.length) return;
  const sales = await kvGet(env, 'sales');
  res.items.forEach((i) => {
    if (!i || !i.storeId || !i.productId) return;
    if (!sales[i.storeId]) sales[i.storeId] = {};
    sales[i.storeId][i.productId] = (sales[i.storeId][i.productId] || 0) + (Number(i.qty) || 0);
  });
  await kvPut(env, 'sales', sales);
  delete reservations[orderId];
  await kvPut(env, 'reservations', reservations);
}

// ---------------- Почта (Resend) ----------------

async function sendEmail(env, to, subject, html) {
  const key = env.RESEND_API_KEY;
  if (!key) {
    console.error('RESEND_API_KEY не задан — письмо пропущено');
    return false;
  }
  const from = env.RESEND_FROM || 'Greenleaf <onboarding@resend.dev>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html })
    });
    return res.ok;
  } catch (e) {
    console.error('Resend error:', e);
    return false;
  }
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

  // 1. Статические учётки (суперадмин и пр.) из секрета STORE_CREDS
  const raw = env.STORE_CREDS;
  if (raw) {
    try {
      const creds = JSON.parse(raw);
      const rec = creds[login];
      if (rec && rec.password === pass) {
        user = { id: rec.storeId || rec.id || login, name: rec.name || 'СЦ Greenleaf', role: rec.role || 'sc' };
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: 'auth config error' }, 500);
    }
  }

  // 2. Выданные суперадмином логины Сервис-Центров (KV)
  if (!user) {
    const stores = await kvGet(env, 'stores');
    const rec = stores[login];
    if (rec && rec.status === 'active' && rec.authPassword === pass) {
      user = { id: rec.id || login, name: rec.name || 'СЦ Greenleaf', role: 'sc' };
    }
  }

  // 3. Клиентские аккаунты (KV users) — вход обычных пользователей
  if (!user) {
    const users = await kvGet(env, 'users');
    const rec = users[login];
    if (rec && rec.password === pass) {
      user = { id: rec.id || login, login: login, name: rec.name || login, email: rec.email || '', phone: rec.phone || '', role: 'client' };
    }
  }

  if (user) {
    const token = await issueToken(env, login, user.role);
    return jsonResponse({ ok: true, store: user, token });
  }
  return jsonResponse({ ok: false });
}

// ---------------- Регистрация клиента (публично) ----------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleClientRegister(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const email = String(data.email || '').trim().toLowerCase();
  const name = String(data.name || '').trim();
  const phone = String(data.phone || '').trim();
  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ ok: false, error: 'Укажите корректный email — на него придёт логин и пароль' }, 400);
  }
  const users = await kvGet(env, 'users');
  if (users[email]) {
    return jsonResponse({ ok: false, error: 'Такой email уже зарегистрирован. Войдите по нему.' }, 409);
  }
  const password = randomPassword(8);
  users[email] = {
    id: 'u_' + email,
    email,
    name,
    phone,
    password,
    role: 'client',
    createdAt: new Date().toISOString()
  };
  await kvPut(env, 'users', users);

  // Письмо с доступами
  await sendEmail(env, email, 'Ваш аккаунт Greenleaf',
    '<p>Здравствуйте, ' + String(name || '').replace(/[<>]/g, '') + '!</p>' +
    '<p>Ваш аккаунт на сайте Greenleaf создан. Данные для входа:</p>' +
    '<p><b>Логин:</b> ' + email.replace(/[<>]/g, '') + '<br>' +
    '<b>Пароль:</b> ' + password + '</p>' +
    '<p>Вход: сайт Greenleaf → «Войти».</p>');

  // Дубликат в Telegram (как раньше client_registration)
  const text = buildText(Object.assign({ type: 'client_registration' }, data, { email }));
  await sendTelegram(env, text);

  return jsonResponse({ ok: true, email });
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
  const officeCode = String(data.officeCode || '').trim();
  const portalLogin = String(data.portalLogin || '').trim();
  const portalPassword = String(data.portalPassword || '').trim();
  if (!officeCode || !portalLogin || !portalPassword) {
    return jsonResponse({ ok: false, error: 'officeCode, portalLogin и portalPassword обязательны' }, 400);
  }
  const app = {
    id: 'app_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    name: String(data.name || '').trim(),
    phone: String(data.phone || '').trim(),
    email: String(data.email || '').trim(),
    storeName: String(data.storeName || '').trim(),
    city: String(data.city || '').trim(),
    address: String(data.address || '').trim(),
    officeCode,
    officeId: normalizeOfficeCode(officeCode),
    portalLogin,
    portalPassword,
    comment: String(data.comment || '').trim(),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  const apps = await kvGet(env, 'applications');
  apps[app.id] = app;
  await kvPut(env, 'applications', apps);

  // Уведомление главному администратору
  const text = buildText(Object.assign({ type: 'sc_registration' }, data));
  await sendTelegram(env, text);

  return jsonResponse({ ok: true, id: app.id });
}

// ---------------- Заявки СЦ (суперадмин) ----------------

async function handleScApplications(env) {
  const apps = await kvGet(env, 'applications');
  const list = Object.values(apps).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return jsonResponse({ ok: true, applications: list });
}

// Письмо с доступами владельцу Сервис-Центра (после подтверждения)
async function sendScCredsEmail(env, to, rec) {
  if (!to) return false;
  return sendEmail(env, to, 'Сервис-Центр Greenleaf подключён',
    '<p>Здравствуйте!</p>' +
    '<p>Ваш Сервис-Центр <b>' + String(rec.name || '').replace(/[<>]/g, '') + '</b> подтверждён и подключён к каталогу Greenleaf.</p>' +
    '<p>Данные для входа в кабинет Сервис-Центра:</p>' +
    '<p><b>Логин:</b> ' + String(rec.authLogin || '').replace(/[<>]/g, '') + '<br>' +
    '<b>Пароль:</b> ' + String(rec.authPassword || '').replace(/[<>]/g, '') + '</p>' +
    '<p>Вход: сайт Greenleaf → «Войти».</p>' +
    '<p>Остатки ваших товаров будут синхронизироваться автоматически.</p>');
}

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
        const storeId = app.officeId || normalizeOfficeCode(app.officeCode);
        const existing = stores[storeId] || {};
        const record = {
          id: storeId,
          officeCode: String(app.officeCode || '').trim(),
          name: String(app.storeName || '').trim() || existing.name || 'СЦ Greenleaf',
          city: String(app.city || '').trim() || existing.city || '',
          cityKey: String(app.city || '').trim().toLowerCase() || existing.cityKey || '',
          address: String(app.address || '').trim() || existing.address || '',
          hours: existing.hours || '',
          phone: String(app.phone || '').trim() || existing.phone || '',
          phoneRaw: String(app.phone || '').replace(/\D/g, '') || existing.phoneRaw || '',
          whatsapp: String(app.phone || '').replace(/\D/g, '') || existing.whatsapp || '',
          image: existing.image || '',
          description: existing.description || '',
          partner: existing.partner || '',
          portalLogin: String(app.portalLogin || '').trim() || existing.portalLogin || '',
          portalPassword: String(app.portalPassword || '').trim() || existing.portalPassword || '',
          authLogin: existing.authLogin || storeId.toLowerCase(),
          authPassword: existing.authPassword || randomPassword(10),
          status: 'active',
          createdAt: existing.createdAt || new Date().toISOString()
        };
        stores[storeId] = record;
        await kvPut(env, 'stores', stores);
        created = record;
        if (app.email) await sendScCredsEmail(env, app.email, record);
      }
      app.status = 'approved';
      app.resolvedAt = new Date().toISOString();
      await kvPut(env, 'applications', apps);
      return jsonResponse({ ok: true, application: app, store: created });
    }
    app.status = 'rejected';
    app.resolvedAt = new Date().toISOString();
    await kvPut(env, 'applications', apps);
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

async function handleScStore(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid json' }, 400);
  }
  const stores = await kvGet(env, 'stores');
  const officeId = normalizeOfficeCode(data.officeCode || '');
  const storeId = String(data.id || '').trim() || officeId || ('sc_' + Date.now());
  const existing = stores[storeId] || {};
  const record = {
    id: storeId,
    officeCode: String(data.officeCode || '').trim() || existing.officeCode || '',
    name: String(data.name || '').trim() || existing.name || 'СЦ Greenleaf',
    city: String(data.city || '').trim() || existing.city || '',
    cityKey: String(data.cityKey || '').trim() || existing.cityKey || '',
    address: String(data.address || '').trim() || existing.address || '',
    hours: String(data.hours || '').trim() || existing.hours || '',
    phone: String(data.phone || '').trim() || existing.phone || '',
    phoneRaw: String(data.phoneRaw || '').trim() || existing.phoneRaw || '',
    whatsapp: String(data.whatsapp || '').trim() || existing.whatsapp || '',
    email: String(data.email || '').trim() || existing.email || '',
    image: String(data.image || '').trim() || existing.image || '',
    description: String(data.description || '').trim() || existing.description || '',
    partner: String(data.partner || '').trim() || existing.partner || '',
    portalLogin: String(data.portalLogin || '').trim() || existing.portalLogin || '',
    portalPassword: String(data.portalPassword || '').trim() || existing.portalPassword || '',
    authLogin: String(data.authLogin || '').trim().toLowerCase() || existing.authLogin || officeId || storeId.toLowerCase(),
    authPassword: String(data.authPassword || '').trim() || existing.authPassword || randomPassword(10),
    status: data.status === 'inactive' ? 'inactive' : 'active',
    createdAt: existing.createdAt || new Date().toISOString()
  };
  stores[storeId] = record;
  await kvPut(env, 'stores', stores);
  // Новая карточка → письмо с доступами владельцу
  if (!existing.id && record.email) {
    await sendScCredsEmail(env, record.email, record);
  }
  // Без портальных паролей в ответ не отдаём — но панели они нужны; админ авторизован
  return jsonResponse({ ok: true, store: record });
}

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
  if (!stores[id]) return jsonResponse({ ok: false, error: 'not found' }, 404);
  delete stores[id];
  await kvPut(env, 'stores', stores);
  return jsonResponse({ ok: true });
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
      phone: s.phone || '',
      phoneRaw: s.phoneRaw || '',
      whatsapp: s.whatsapp || '',
      image: s.image || '',
      description: s.description || ''
    }));
  return jsonResponse({ ok: true, stores: list });
}

// ---------------- Конфиг для парсера (по API-ключу) ----------------

async function handleParserConfig(request, env) {
  const url = new URL(request.url);
  const key = request.headers.get('X-API-Key') || url.searchParams.get('key') || '';
  if (!env.PARSER_API_KEY || key !== env.PARSER_API_KEY) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }
  const stores = await kvGet(env, 'stores');
  const list = Object.values(stores)
    .filter(s => s.status === 'active' && s.portalLogin)
    .map(s => ({
      id: s.id,
      officeCode: s.officeCode || '',
      login: s.portalLogin,
      password: s.portalPassword || '',
      partner: s.partner || ''
    }));
  return jsonResponse({ ok: true, stores: list });
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
  const isOrder = type === 'order' || type === 'reservation';
  const head = isOrder ? '🛒 НОВЫЙ ЗАКАЗ' : '🔔 Новая заявка с сайта';

  const blocks = {
    order: [
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
    reservation: [
      '📦 ' + (data.product || '—'),
      data.store ? '🏬 Филиал: ' + data.store : null,
      '🔢 Кол-во: ' + (data.quantity || 1),
      data.comment ? '💬 ' + data.comment : null
    ],
    event: [
      '📅 Запись на мероприятие',
      '🎫 ' + (data.event || '—')
    ],
    client_registration: [
      '📝 Регистрация клиента',
      data.email ? '📧 Email: ' + data.email : null,
      data.city ? '🏙️ Город: ' + data.city : null,
      data.comment ? '💬 ' + data.comment : null
    ],
    partner: [
      '🤝 Заявка на партнёрство',
      data.city ? '🏙️ Город: ' + data.city : null,
      data.address ? '📍 Адрес: ' + data.address : null,
      data.experience ? '💼 Тип бизнеса: ' + data.experience : null,
      data.message ? '💬 ' + data.message : null
    ],
    sc_registration: [
      '🏬 Регистрация Сервис-Центра',
      data.storeName ? '🏪 Магазин: ' + data.storeName : null,
      data.email ? '📧 Email: ' + data.email : null,
      data.officeCode ? '🔑 Код личного кабинета: ' + data.officeCode : null,
      data.portalLogin ? '👤 Логин кабинета поставщика: ' + data.portalLogin : null,
      data.portalPassword ? '🔒 Пароль кабинета поставщика: ' + data.portalPassword : null,
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

  // Оформленный заказ: бронь → постоянное списание остатков (до проверки токена)
  if (data.type === 'order') {
    try { await commitSalesFromOrder(env, data); } catch (e) { console.error('commitSales error:', e); }
  }

  // Заказы (корзина, бронь) — в группу заказов, остальное — в основной чат
  const isOrder = data.type === 'order' || data.type === 'reservation';
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

  return new Response('ok', { status: 200 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

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

    // 1.2.1 Публичная регистрация клиента (аккаунт + письмо с доступом)
    if (path === '/api/register' && request.method === 'POST') {
      return handleClientRegister(request, env);
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

    // 1.4.2 Бронь товаров на 2 минуты (оформление заказа)
    if (path === '/api/reserve' && request.method === 'POST') {
      return handleReserve(request, env, url);
    }

    // 1.5 Админские API (суперадмин по токену)
    if (path === '/api/sc-applications' || path === '/api/sc-application' || path === '/api/sc-store') {
      const auth = await verifyToken(env, request.headers.get('Authorization'));
      if (!auth || auth.role !== 'superadmin') {
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
    }

    // 2. /admin и /admin/* → панель Decap CMS (обходим clean-url редиректы)
    if (path === '/admin' || path.startsWith('/admin/')) {
      let r = await env.ASSETS.fetch(new URL('/admin/index.html', url));
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        r = await env.ASSETS.fetch(new URL(r.headers.get('location'), url));
      }
      return r;
    }

    // 3. Остальное — статика
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
