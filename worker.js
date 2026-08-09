// Cloudflare Worker: статика сайта Greenleaf + обработка форм → Telegram.
// Разворачивается через Git-интеграцию Workers (проект mygreenleaf).
// Переменные окружения (Worker → Settings → Variables):
//   TG_BOT_TOKEN, TG_CHAT_ID — заявки/консультации
//   TG_ORDERS_CHAT_ID       — группа, куда бот шлёт ЗАКАЗЫ (корзина + бронь)
//   STORE_CREDS             — JSON-секрет с учётками филиалов для /api/auth:
//                             {"<логин>": {"password": "...", "storeId": "...", "name": "...", "role": "sc|superadmin"}, ...}

const TELEGRAM_API = 'https://api.telegram.org/bot';

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Вход в кабинет филиала: креды сверяются на сервере, клиенту никогда не отдаются
async function handleStoreAuth(request, env) {
  const raw = env.STORE_CREDS;
  if (!raw) {
    return jsonResponse({ ok: false, error: 'auth not configured' }, 500);
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    return jsonResponse({ ok: false, error: 'auth config error' }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false }, 400);
  }
  const login = String(body.login || '').trim().toLowerCase();
  const pass = String(body.password || '');
  const rec = creds[login];
  if (rec && rec.password === pass) {
    return jsonResponse({
      ok: true,
      store: { id: rec.storeId || login, name: rec.name || 'СЦ Greenleaf', role: rec.role || 'sc' }
    });
  }
  return jsonResponse({ ok: false });
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
    '🕐 ' + new Date().toLocaleString('ru-RU')
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

    // 1.1 Вход в кабинет филиала (креды только в секрете STORE_CREDS)
    if (path === '/api/auth' && request.method === 'POST') {
      return handleStoreAuth(request, env);
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
