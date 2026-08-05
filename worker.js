// Cloudflare Worker: статика сайта Greenleaf + обработка форм → Telegram.
// Разворачивается через Git-интеграцию Workers (проект mygreenleaf).
// Переменные окружения (Worker → Settings → Variables):
//   TG_BOT_TOKEN, TG_CHAT_ID

const TELEGRAM_API = 'https://api.telegram.org/bot';

function buildText(data) {
  const name = (data.name || '').trim();
  const phone = (data.phone || '').trim();
  const type = data.type || 'other';
  const head = '🔔 Новая заявка с сайта';

  const blocks = {
    reservation: [
      '🛒 Бронирование товара',
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
  const CHAT_ID = env.TG_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TG_BOT_TOKEN или TG_CHAT_ID не заданы');
    return new Response('Telegram not configured', { status: 500 });
  }

  let data;
  try {
    data = await request.json();
  } catch (err) {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (data.company) {
    return new Response('ok', { status: 200 });
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
