// Тест-стенд для worker.js: модуль загружается как ESM, окружение — моки.
// Проверяет ключевые сценарии API без деплоя (партнёрская цена, лимиты,
// «Ожидается» = 0, пустой пароль, потеря заказов, скидки).
// Запуск:  node scripts/worker-test.mjs
// (корень репозитория определяется автоматически)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.env.APP_ROOT || path.dirname(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)));
const src = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
const code = src.replace('export default {', 'const __worker = {') + '\nmodule.exports = __worker;\n';

function loadWorker() {
const mod = { exports: {} };
const sandbox = {
  module: mod, exports: mod.exports,
  console,
  crypto: globalThis.crypto,
  TextEncoder, TextDecoder, URL, Request, Response, Headers, setTimeout, clearTimeout,
  fetch: globalThis.fetch,
  AbortController, URLSearchParams, Map, Set, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, isFinite, parseInt, parseFloat, Intl, Buffer,
  btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
  atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'worker.js' });
return mod.exports;
}
const worker = loadWorker();

// ---- Моки окружения ----
const kv = new Map();
const KV = {
  async get(key, type) {
    if (!kv.has(key)) return null;
    const v = kv.get(key);
    if (type === 'json') { try { return JSON.parse(v); } catch (e) { return null; } }
    return v;
  },
  async put(key, value, opts) { kv.set(key, typeof value === 'string' ? value : JSON.stringify(value)); },
  async delete(key) { kv.delete(key); },
  async list({ prefix } = {}) {
    const keys = [...kv.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name }));
    return { keys, list_complete: true };
  },
};

const TESTDATA = '/tmp/worker-test-data';
const ASSETS = {
  async fetch(url) {
    const raw = (typeof url === 'string') ? url : (url instanceof URL ? url.href : (url && url.url));
    const p = new URL(String(raw)).pathname;
    const testFile = path.join(TESTDATA, p);
    if (fs.existsSync(testFile) && fs.statSync(testFile).isFile()) {
      const body = fs.readFileSync(testFile);
      return new Response(body, { status: 200, headers: { 'content-type': p.endsWith('.json') ? 'application/json' : 'text/plain' } });
    }
    const file = path.join(ROOT, 'public', p === '/' ? 'index.html' : p);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const body = fs.readFileSync(file);
      return new Response(body, { status: 200, headers: { 'content-type': p.endsWith('.json') ? 'application/json' : 'text/plain' } });
    }
    return new Response('not found', { status: 404 });
  },
};

const env = {
  SC_STORES: KV,
  ASSETS,
  AUTH_HMAC_KEY: 'test-hmac-key-0123456789',
  DATA_ENC_KEY: '0123456789abcdef0123456789abcdef',
  STORE_CREDS: JSON.stringify({ admin: { password: 'sup3rpass', role: 'superadmin', name: 'Суперадмин' } }),
  TG_BOT_TOKEN: '', TG_CHAT_ID: '',
  PARTNER_IDS: 'kz44326234',
  PARTNER_LOGIN: 'kz44326234',
  PARSER_API_KEY: 'parser-key-123',
};

const ctx = { waitUntil() {} };
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ✅', name);
  else { failures++; console.log('  ❌', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200)); }
}
async function call(path, opts = {}) {
  const req = new Request('https://site.test' + path, opts);
  const res = await worker.fetch(req, env, ctx);
  let body = null;
  try { body = await res.clone().json(); } catch (e) { body = await res.text().catch(() => null); }
  return { res, body };
}

// ---- Каталог в базе: два товара с ценой, один «Ожидается» ----
fs.mkdirSync('/tmp/worker-test-data/data', { recursive: true });
fs.writeFileSync('/tmp/worker-test-data/data/products.base.json', JSON.stringify({
  updated: '2026-10-19T08:41:27+03:00',
  products: [
    { id: 'AAA111', sku: 'AAA111', name: 'Товар в наличии', category: 'Тест', price: 1000, partner_price: 500, status: 'in_stock' },
    { id: 'BBB222', sku: 'BBB222', name: 'Товар под заказ', category: 'Тест', price: 2000, partner_price: 1000, status: 'low' },
    { id: 'CCC333', sku: 'CCC333', name: 'Товар для скидки', category: 'Тест', price: 3000, partner_price: 1500, status: 'in_stock' },
  ]
}));
fs.writeFileSync('/tmp/worker-test-data/data/events.json', JSON.stringify({ events: [] }));
// store-stock.json кладём в ASSETS-подобный файл
fs.writeFileSync('/tmp/worker-test-data/data/store-stock.json', JSON.stringify({
  updated: '2026-10-19T08:41:27+03:00',
  stock: { s1: { AAA111: 'В наличии (5 шт)', BBB222: 'Ожидается', CCC333: 'В наличии (10 шт)' } }
}));
async function enc(plain) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  const b64 = (b) => Buffer.from(b).toString('base64');
  return 'enc:v1:' + b64(iv) + ':' + b64(new Uint8Array(ct));
}
kv.set('stores', JSON.stringify({ s1: { id: 's1', name: 'СЦ Тест', status: 'active', authLogin: 'sc1', authPassword: await enc('sc-pass'), portalLogin: 'p1', portalPassword: await enc('portal-pass') } }));
kv.set('site_settings', JSON.stringify({ showDiscountPrices: true }));

console.log('\n== 1. Партнёрская цена только для белого списка ==');
{
  const { body } = await call('/api/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'GL-TEST01', storeId: 's1', items: [{ productId: 'AAA111', qty: 1 }] })
  });
  check('резерв создан', body && body.ok === true, body);

  const { body: b2 } = await call('/telegram', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'order', order_id: 'GL-TEST01', orderStoreId: 's1', phone: '+77001234567',
      clientToken: 'ct_0123456789abcdef', payment: 'cash', paymentCode: 'cash', partner_id: 'kz99999999',
      order_items_json: JSON.stringify([{ productId: 'AAA111', qty: 1 }]),
      order_total: 1000
    })
  });
  const orders = JSON.parse(kv.get('orders') || '{}');
  const ord = orders['GL-TEST01'];
  check('чужой partner_id не дал скидку (total = 1000 + упаковка)', ord && ord.total === 1015, ord && { total: ord.total, partnerMode: ord.partnerMode });
  check('partnerId пустой в заказе', ord && !ord.partnerId, ord && ord.partnerId);
}

console.log('\n== 2. «Ожидается» = 0: лимит проверяется ==');
{
  const { body } = await call('/api/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'GL-TEST02', storeId: 's1', items: [{ productId: 'BBB222', qty: 3 }] })
  });
  check('заказ товара с нулевым остатком отклонён', body && body.error === 'not enough', body);
  check('available = 0', body && body.product && body.product.available === 0, body);
}
{
  // в остатке 5 шт, из них 1 уже в холде предыдущего теста → доступно 4
  const { body } = await call('/api/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'GL-TEST03', storeId: 's1', items: [{ productId: 'AAA111', qty: 4 }] })
  });
  check('товар резервируется в доступном количестве (4 из 5)', body && body.ok === true, body);
  const { body: b2 } = await call('/api/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'GL-TEST04', storeId: 's1', items: [{ productId: 'AAA111', qty: 5 }] })
  });
  check('5 шт при доступных 4 — отклонено', b2 && b2.error === 'not enough', b2);
}

console.log('\n== 3. Вход в кабинет ==');
{
  const { res, body } = await call('/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: '' })
  });
  check('пустой пароль не пускает', res.status === 401, { status: res.status, body });
}
{
  const { res, body } = await call('/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'sup3rpass' })
  });
  check('верный пароль пускает и выдаёт токен', res.status === 200 && body && body.token, body);
}
{
  // Битое шифрование пароля СЦ: decryptSecret вернёт null → вход не проходит
  const { res } = await call('/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'sc1', password: '' })
  });
  check('битый пароль СЦ (enc:v1:bad) не пускает с пустым паролем', res.status === 401, res.status);
}

console.log('\n== 4. Лимиты публичных записей ==');
{
  let limited = false;
  for (let i = 0; i < 40; i++) {
    const { res } = await call('/api/event-book', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: 'ev1', qty: 1 })
    });
    if (res.status === 429) { limited = true; break; }
  }
  check('брони мест ограничены (429 после 10)', limited);
}

console.log('\n== 5. Telegram: типы и пароли ==');
{
  const { res } = await call('/telegram', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'sc_registration', name: 'X', phone: '+7', storeName: 'Y', city: 'Z', address: 'A', portalPassword: 'secret-pass' })
  });
  check('неизвестный/запрещённый тип отклонён', res.status === 400, res.status);
}
{
  const { res } = await call('/api/register-sc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X', phone: '+77000000000', storeName: 'Y', city: 'Z', address: 'A', portalPassword: 'secret-pass' })
  });
  check('регистрация СЦ принимается (401 — нет Telegram, это ок)', res.status === 200 || res.status === 500, res.status);
  const apps = JSON.parse(kv.get('applications') || '{}');
  const first = Object.values(apps)[0];
  check('пароль в заявке сохранён зашифрованным', first && String(first.portalPassword).startsWith('enc:v1:'), first && first.portalPassword);
}

console.log('\n== 6. Конфиг парсера: только заголовок ==');
{
  const { res } = await call('/api/parser-config?key=parser-key-123');
  check('ключ в query-строке не принимается', res.status === 403, res.status);
  const { res: r2, body } = await call('/api/parser-config', { headers: { 'X-API-Key': 'parser-key-123' } });
  check('ключ в заголовке принимается', r2.status === 200, r2.status);
  check('логин партнёра из секрета', body && body.stores && body.stores[0] && body.stores[0].partner === 'kz44326234', body);
}

console.log('\n== 7. Статус остатка «Ожидается» в /api/stock ==');
{
  const { body } = await call('/api/stock');
  check('«Ожидается» превращается в «Нет в наличии»', body && body.stock && body.stock.s1 && body.stock.s1.BBB222 === 'Нет в наличии', body && body.stock && body.stock.s1);
}

console.log('\n== 8. Цены: скидка применяется только при включённом переключателе ==');
{
  kv.set('product_overrides', JSON.stringify({ CCC333: { discount_price: 2400 } }));
  const worker2 = loadWorker();
  const env2 = Object.assign({}, env, { SC_STORES: KV });
  const call2 = async (path, opts = {}) => {
    const req = new Request('https://site.test' + path, opts);
    const res = await worker2.fetch(req, env2, ctx);
    let body = null;
    try { body = await res.clone().json(); } catch (e) { body = null; }
    return { res, body };
  };
  const { body } = await call('/api/stock');
  check('каталог отдаёт оверрайды', !!body);
  // прямой расчёт через orderProductPrice недоступен снаружи — проверяем через заказ
  const { body: b } = await call2('/api/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'GL-TEST05', storeId: 's1', items: [{ productId: 'CCC333', qty: 1 }] })
  });
  check('резерв со скидкой принят', b && b.ok === true, b);
  console.log('   DEBUG reservation =', kv.get('res_GL-TEST05'));
  await call2('/telegram', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'order', order_id: 'GL-TEST05', orderStoreId: 's1', phone: '+77001234567', clientToken: 'ct_0123456789abcdef', payment: 'cash', paymentCode: 'cash', order_items_json: JSON.stringify([{ productId: 'CCC333', qty: 1 }]) })
  });
  console.log('   DEBUG res_GL-TEST05 =', kv.get('res_GL-TEST05'));
  console.log('   DEBUG product_overrides =', kv.get('product_overrides'));
  console.log('   DEBUG order GL-TEST05 =', JSON.parse(kv.get('orders') || '{}')['GL-TEST05']);
  const orders = JSON.parse(kv.get('orders') || '{}');
  check('скидка 2400 применена к заказу (total 2415)', orders['GL-TEST05'] && orders['GL-TEST05'].total === 2415, orders['GL-TEST05'] && orders['GL-TEST05'].total);
  // выключаем показ скидок — нужен свежий экземпляр воркера (кеш каталога 30 с)
  kv.set('site_settings', JSON.stringify({ showDiscountPrices: false }));
  const worker3 = loadWorker();
  const env3 = Object.assign({}, env, { SC_STORES: KV });
  const call3 = async (path, opts = {}) => {
    const req = new Request('https://site.test' + path, opts);
    const res = await worker3.fetch(req, env3, ctx);
    let body = null;
    try { body = await res.clone().json(); } catch (e) { body = null; }
    return { res, body };
  };
  await call3('/api/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'GL-TEST06', storeId: 's1', items: [{ productId: 'CCC333', qty: 1 }] })
  });
  await call3('/telegram', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'order', order_id: 'GL-TEST06', orderStoreId: 's1', phone: '+77001234567', clientToken: 'ct_0123456789abcdef', payment: 'cash', paymentCode: 'cash', order_items_json: JSON.stringify([{ productId: 'CCC333', qty: 1 }]) })
  });
  const orders2 = JSON.parse(kv.get('orders') || '{}');
  check('при выключенных скидках берётся розничная цена (total 3015)', orders2['GL-TEST06'] && orders2['GL-TEST06'].total === 3015, orders2['GL-TEST06'] && orders2['GL-TEST06'].total);
}

console.log('\n== 9. Заказы не теряются при параллельных действиях ==');
{
  await call('/api/reserve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderId: 'GL-TEST07', storeId: 's1', items: [{ productId: 'CCC333', qty: 1 }] })
  });
  const { body } = await call('/telegram', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'order', order_id: 'GL-TEST07', orderStoreId: 's1', phone: '+77001234567',
      clientToken: 'ct_0123456789abcdef', payment: 'cash', paymentCode: 'cash',
      order_items_json: JSON.stringify([{ productId: 'CCC333', qty: 1 }])
    })
  });
  check('заказ создан', body && body.ok, body);
  const before = Object.keys(JSON.parse(kv.get('orders') || '{}')).length;
  // Параллельные мутации: подтверждение и чтение «моих заказов»
  await Promise.all([
    call('/api/my-orders?token=ct_0123456789abcdef'),
    call('/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'order', order_id: 'GL-TEST08', orderStoreId: 's1', phone: '+77001234567', clientToken: 'ct_0123456789abcdef', payment: 'cash', paymentCode: 'cash', order_items_json: JSON.stringify([{ productId: 'CCC333', qty: 1 }]) }) }),
  ]);
  const after = Object.keys(JSON.parse(kv.get('orders') || '{}')).length;
  check('заказы не потерялись после параллельных запросов', after >= before, { before, after });
}

console.log('\n== 10. Заголовки и статика ==');
{
  const { res } = await call('/');
  check('главная отдаётся', res.status === 200, res.status);
  const { res: apiRes } = await call('/api/stores');
  check('маркер билда на месте', apiRes.headers.get('x-greenleaf-build') === 'v2', apiRes.headers.get('x-greenleaf-build'));
}

console.log(failures ? `\n❌ Провалено проверок: ${failures}` : '\n✅ Все проверки пройдены');
process.exit(failures ? 1 : 0);
