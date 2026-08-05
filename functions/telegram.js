// Cloudflare Pages Function: формы сайта → Telegram.
// Маршрут: /telegram (файл functions/telegram.js в корне репозитория).
// Переменные окружения (Pages → Settings → Environment variables):
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

export async function onRequestPost(context) {
  const { env } = context;
  const BOT_TOKEN = env.TG_BOT_TOKEN;
  const CHAT_ID = env.TG_CHAT_ID;

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TG_BOT_TOKEN или TG_CHAT_ID не заданы');
    return new Response('Telegram not configured', { status: 500 });
  }

  let data;
  try {
    data = await context.request.json();
  } catch (err) {
    return new Response('Invalid JSON', { status: 400 });
  }

  const honey = data.company;
  if (honey) {
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
