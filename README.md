# Сайт сервис-центра Greenleaf

Одностраничный сайт на статике + Cloudflare Pages: каталог с наличием в реальном времени, бронирование товаров, даты поставок, презентации и заявки на партнёрство. Все формы отправляются в ваш Telegram-бот.

## Структура

```
index.html            — страница (все секции)
css/style.css         — стили
js/                   — ui.js (модалки/тосты), catalog.js (каталог), forms.js (отправка заявок)
data/                 — JSON-данные (правятся через кабинет cabinet.html или парсером)
admin/                — Decap CMS (админка по адресу /admin)
functions/telegram.js — Pages Function: формы → Telegram (маршрут /telegram)
_redirects            — редиректы (в т.ч. /admin/* → /admin/index.html)
_headers              — заголовки кеширования (data/* без кеша)
scripts/parser/       — парсер каталога из портала поставщика (Python)
```

## 1. Деплой на Cloudflare Pages

1. Создайте репозиторий на GitHub и загрузите туда эту папку.
2. На сайте [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Pages → Connect to Git** → выберите репозиторий.
3. Настройки сборки: **build command** — оставьте пустым, **Build output directory** — `/`.
4. Нажмите **Save and Deploy**. Через ~1 минуту сайт будет жить на `https://ваш-проект.pages.dev`.

Дальше каждый `git push` в ветку `main` автоматически обновляет сайт.

## 2. Telegram-бот (приём заявок)

1. Откройте в Telegram [@BotFather](https://t.me/BotFather) → `/newbot` → придумайте имя → получите **токен**.
2. Напишите вашему боту любое сообщение (например, «привет») — это нужно, чтобы он мог вам писать.
3. Узнайте свой **chat id**: откройте в браузере
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates`
   и найдите число в поле `"chat":{"id":...}` (обычно 10 цифр).
4. В Cloudflare Pages: **Settings → Environment variables** добавьте:
   - `TG_BOT_TOKEN` = токен из BotFather
   - `TG_CHAT_ID` = ваш chat id
5. Передеплойте сайт (Deployments → … → Retry deployment). Готово — заявки приходят вам в Telegram.

Проверить локально: установите [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`), затем
`npx wrangler pages dev .` в папке проекта — сайт и функция поднимутся на `localhost:8788`.

## 3. Админка (править данные без кода)

Кабинет СЦ/суперадмина — `cabinet.html` (кнопка «Войти» на сайте): филиалы, остатки,
поставки, мероприятия, каталог, заявки магазинов, тексты.

Decap CMS — [https://ваш-проект.pages.dev/admin](https://ваш-проект.pages.dev/admin) (если нужен).
Вход через GitHub, но на Cloudflare Pages нет OAuth-прокси, поэтому нужен свой:

1. В файле `admin/config.yml` замените `repo: ИМЯ_ПОЛЬЗОВАТЕЛЯ/имя-репозитория` на ваш репозиторий.
2. Создайте GitHub OAuth App: GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - Homepage URL: `https://ваш-проект.pages.dev`
   - Authorization callback URL: `https://ВАШ-ВОРКЕР.workers.dev/callback`
3. Задеплойте Cloudflare Worker с OAuth-провайдером Decap CMS
   (например порт `vencax/netlify-cms-github-oauth-provider` для Workers),
   переменные: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_DOMAINS` (ваш домен).
4. В `admin/config.yml` укажите `base_url: https://ВАШ-ВОРКЕР.workers.dev`, `auth_endpoint: auth`.
5. Откройте `/admin`, войдите через GitHub — можно править товары, поставки, мероприятия и контакты. Изменения сохраняются в git и автоматически деплоятся.

## 4. Парсер каталога (автоматический)

Каталог собирается с портала поставщика **greenleaf-global.com** (описание алгоритма —
`PARSING_GUIDE.md`): вход в кабинет СЦ → раздел покупки → партнёр `kz44326234` →
перебор страниц «Показать еще...» → разбор строк (`код ABC123`, название, кол-во
«Доступно для продажи», скидочная цена × 2).

Сайт читает каталог из `data/products.json`:

```json
{
  "updated": "2026-08-04T12:00:00+03:00",
  "products": [
    {
      "id": "ABC123",
      "sku": "ABC123",
      "name": "Газонокосилка Greenleaf",
      "category": "Газонокосилки",
      "price": 28990,
      "image": "assets/images/products/lawnmower.svg",
      "status": "in_stock",
      "eta": null,
      "incoming": null
    }
  ]
}
```

Статусы считаются из количества: ≥ 6 — `in_stock`, 1–5 — `low`, 0 — `out`.
Категория определяется по ключевым словам в названии (словарь в конфиге).

### Автозапуск (GitHub Actions, раз в 3 часа)

Workflow `.github/workflows/parse-catalog.yml`: парсит каталог, при изменениях
коммитит `data/products.json` и пушит → Cloudflare Pages передеплоит сайт автоматически.
Вручную можно запустить в любой момент: **Actions → Parse catalog → Run workflow**.

Один раз добавьте учётные данные в секреты репозитория
(Settings → Secrets and variables → Actions → New repository secret):

| Secret | Значение |
|---|---|
| `SC_LOGIN` | логин кабинета СЦ |
| `SC_PASSWORD` | пароль кабинета СЦ |

### Локальный запуск (по желанию)

```bash
cd scripts/parser
cp config.example.json config.json   # впишите логин/пароль
pip install -r requirements.txt
python -m playwright install chromium
python parser.py                     # обновит data/products.json
```

`config.json` в `.gitignore` — секреты в репозиторий не попадут.

## 5. Данные

- `data/store.json` — адрес, часы, телефон, WhatsApp (правьте через админку `/admin`)
- `data/products.json` — каталог, обновляется парсером автоматически (или через админку)
- `data/deliveries.json`, `data/events.json` — поставки и мероприятия (через админку)
- `assets/images/products/` — фото товаров (можно заменить SVG-плейсхолдеры на реальные)
