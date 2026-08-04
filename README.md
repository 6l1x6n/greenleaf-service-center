# Сайт сервис-центра Greenleaf

Одностраничный сайт на статике + Netlify: каталог с наличием в реальном времени, бронирование товаров, даты поставок, презентации и заявки на партнёрство. Все формы отправляются в ваш Telegram-бот.

## Структура

```
index.html            — страница (все секции)
css/style.css         — стили
js/                   — ui.js (модалки/тосты), catalog.js (каталог), forms.js (отправка заявок)
data/                 — JSON-данные (правятся через админку /admin или парсером)
admin/                — Decap CMS (админка по адресу /admin)
netlify/functions/    — serverless-функция: формы → Telegram
netlify.toml          — конфиг Netlify
scripts/parser/       — парсер каталога из портала поставщика (Python)
```

## 1. Деплой на Netlify

1. Создайте репозиторий на GitHub и загрузите туда эту папку.
2. На сайте [netlify.com](https://netlify.com) → **Add new site** → **Import an existing project** → выберите репозиторий.
3. Настройки менять не нужно (`netlify.toml` уже задаёт publish-директорию `.` и папку функций).
4. Нажмите **Deploy**. Через ~1 минуту сайт будет жить на `https://ваш-проект.netlify.app`.

Дальше каждый `git push` в ветку `main` автоматически обновляет сайт.

## 2. Telegram-бот (приём заявок)

1. Откройте в Telegram [@BotFather](https://t.me/BotFather) → `/newbot` → придумайте имя → получите **токен**.
2. Напишите вашему боту любое сообщение (например, «привет») — это нужно, чтобы он мог вам писать.
3. Узнайте свой **chat id**: откройте в браузере
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates`
   и найдите число в поле `"chat":{"id":...}` (обычно 10 цифр).
4. В Netlify: **Site configuration → Environment variables** добавьте:
   - `TG_BOT_TOKEN` = токен из BotFather
   - `TG_CHAT_ID` = ваш chat id
5. Передеплойте сайт (Redeploy). Готово — заявки приходят вам в Telegram.

Проверить локально: установите [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`npm i -g netlify-cli`), затем
`netlify dev` в папке проекта — сайт и функция поднимутся на `localhost:8888`.

## 3. Админка (править данные без кода)

Админка — [https://ваш-проект.netlify.app/admin](https://ваш-проект.netlify.app/admin) (Decap CMS).

Вход через GitHub. Чтобы он заработал:

1. В файле `admin/config.yml` замените `repo: ИМЯ_ПОЛЬЗОВАТЕЛЯ/имя-репозитория` на ваш репозиторий.
2. Создайте GitHub OAuth App: GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - Homepage URL: `https://ваш-проект.netlify.app`
   - Authorization callback URL: `https://api.netlify.com/auth/done`
3. В Netlify: **Site configuration → Access control → OAuth** → укажите Client ID и Client Secret приложения.
4. Откройте `/admin`, войдите через GitHub — можно править товары, поставки, мероприятия и контакты. Изменения сохраняются в git и автоматически деплоятся.

## 4. Парсер каталога (когда появится описание портала)

Сайт читает каталог из `data/products.json` и понимает любой набор товаров — парсер лишь пишет этот файл.

Формат записи:

```json
{
  "updated": "2026-08-04T12:00:00+03:00",
  "products": [
    {
      "id": "gl-1001",
      "sku": "GL-1001",
      "name": "Газонокосилка Greenleaf GL 3.8",
      "category": "Газонокосилки",
      "price": 28990,
      "image": "assets/images/products/lawnmower.svg",
      "status": "in_stock",
      "eta": "2026-08-14",
      "incoming": "2026-08-06"
    }
  ]
}
```

Статусы: `in_stock` — в наличии, `low` — заканчивается, `expected` — заказано, `out` — нет в наличии.
`eta` — дата следующей поставки (показывается клиенту), `incoming` — дата завоза в пути.

Запуск скелета:

```bash
cd scripts/parser
cp config.example.json config.json   # впишите URL портала и логин/пароль
pip install -r requirements.txt
python parser.py
```

Логику входа и парсинга (`login`, `fetch_products`) опишем отдельно, когда будет готов документ с описанием портала.

## 5. Данные для замены (перед запуском)

- `data/store.json` — адрес, часы, телефон, WhatsApp (или через админку)
- `data/products.json` — каталог (демо-товары заменятся парсером или через админку)
- `assets/images/products/` — замените SVG-плейсхолдеры на реальные фото товаров
