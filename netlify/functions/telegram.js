const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID = process.env.TG_CHAT_ID;

function buildText(data) {
  const name = (data.name || '').trim();
  const phone = (data.phone || '').trim();
  const type = data.type || 'other';
  const head = '🔔 Новая заявка с сайта';

  const blocks = {
    reservation: [
      '🛒 Бронирование товара',
      '📦 ' + (data.product || '—'),
      '🔢 Кол-во: ' + (data.quantity || 1),
      data.comment ? '💬 ' + data.comment : null
    ],
    event: [
      '📅 Запись на мероприятие',
      '🎫 ' + (data.event || '—')
    ],
    partner: [
      '🤝 Заявка на партнёрство',
      data.city ? '🏙️ Город: ' + data.city : null,
      data.experience ? '💼 Тип бизнеса: ' + data.experience : null,
      data.message ? '💬 ' + data.message : null
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('TG_BOT_TOKEN или TG_CHAT_ID не заданы');
    return { statusCode: 500, body: 'Telegram not configured' };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (err) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const honey = data.company;
  if (honey) {
    return { statusCode: 200, body: 'ok' };
  }

  const text = buildText(data);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true })
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Telegram API error:', res.status, body);
    return { statusCode: 502, body: 'Telegram error' };
  }

  return { statusCode: 200, body: 'ok' };
};
