# Сайт сервис-центра Greenleaf

Одностраничный сайт на статике + Cloudflare Worker: каталог с наличием в реальном времени,
заказы с резервированием, бронирование товаров, даты поставок, презентации и заявки на
партнёрство. Все формы отправляются в ваш Telegram-бот.

## Структура

```
worker.js              — Cloudflare Worker (формы → Telegram, заказы, остатки, админка)
index.html             — страница (все секции)
css/style.css          — стили
js/                    — ui.js (модалки/тосты), catalog.js (каталог), forms.js (отправка заявок)
data/                  — JSON-данные (правятся парсером или суперадмином)
admin/                 — Decap CMS (админка по адресу /admin)
scripts/parser/        — парсер каталога из портала поставщика (Python)
_redirects             — редиректы (в т.ч. /admin/* → /admin/index.html)
_headers               — заголовки кеширования (data/* без долгого кеша)
.github/workflows/     — deploy.yml (push → деплой), parse-catalog.yml (парсер)
```

## Деплой (только через git push)

1. Запушьте изменения в `main` — GitHub Actions (`deploy.yml`) развернёт ровно git HEAD.
2. Один раз добавьте в секреты репозитория **`CF_API_TOKEN`** (Cloudflare → My Profile →
   API Tokens → Create Token → «Edit Cloudflare Workers» → Account: ваш, Workers Scripts: Edit).
3. Проверка после деплоя: `bash scripts/verify.sh` (сверяет `/version.json` на сайте с git HEAD).

⚠️ Ручной `wrangler deploy` из рабочей копии **не** рекомендуется: авто-деплой по пушам
(в т.ч. от парсера) перезальёт origin/main поверх. `scripts/deploy.sh` откажет, если копия
отстаёт от origin/main.

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

### Расписание — 4 запуска в день (Астана)

| Время (Астана) | UTC | Режим |
|---|---|---|
| 11:00 | 06:00 | **full** — полный: новые товары (утренние поступления) + все остатки |
| 14:00 | 09:00 | **incr** — только количества по артикулам |
| 17:00 | 12:00 | **incr** — только количества по артикулам |
| 20:00 | 15:00 | **incr** — только количества по артикулам |

- После 21:00 — посадка PV (актуализация остатков), до утра парсер не запускается.
- **full**: описания и карта товаров портала запрашиваются только для новых артикулов;
  существующие карточки обновляются полностью (название/цена/фото).
- **incr**: существующие карточки обновляются только по количеству — без перезаписи
  данных; полные данные новых товаров по-прежнему вносятся один раз.

Сайт читает каталог из `data/products.base.json` (виртуальный `/data/products.json`
с оверрайдами суперадмина отдаёт воркер):

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

Workflow `.github/workflows/parse-catalog.yml`: парсит каталог по расписанию, при
изменениях коммитит и пушит → авто-деплой обновит сайт автоматически.
Вручную можно запустить в любой момент: **Actions → Parse catalog → Run workflow**
(параметр `mode`: auto/full/incr).

Один раз добавьте учётные данные в секреты репозитория
(Settings → Secrets and variables → Actions → New repository secret):

| Secret | Значение |
|---|---|
| `SC_LOGIN` | логин кабинета СЦ |
| `SC_PASSWORD` | пароль кабинета СЦ |
| `CF_API_TOKEN` | токен Cloudflare для деплоя (deploy.yml) |

### Локальный запуск (по желанию)

```bash
cd scripts/parser
cp config.example.json config.json   # впишите логин/пароль
pip install -r requirements.txt
python -m playwright install chromium
PARSER_MODE=full python parser.py    # full/incr (по умолчанию incr)
```

`config.json` в `.gitignore` — секреты в репозиторий не попадут.

## 5. Заказы и остатки

- **Фактический остаток** — что последний раз сообщил парсер (`store-stock.json`).
- **Зарезервировано онлайн** — товары в заказах `new` (и 2-минутные холды корзины).
- **Доступно онлайн** = факт − холды − Σ `new` − Σ `confirmed` после последнего синка.
- Подтверждение заказа: резерв → продажа (остаток не меняется). После следующего
  синка парсера заказ уходит в архив и больше не влияет на остаток.
- Отмена заказа возвращает товар; удаление подтверждённого заказа НЕ возвращает товар.
- Раздел «🛒 Заказы» в кабинете: у СЦ — свои заказы, у суперадмина — все + архив.

## 6. Данные

- `data/store.json` — адрес, часы, телефон, WhatsApp (правьте через кабинет)
- `data/products.base.json` — каталог, обновляется парсером автоматически
- `data/store-stock.json` — остатки по филиалам (парсер)
- `data/deliveries.json`, `data/events.json` — поставки и мероприятия (через кабинет)
- `assets/images/products/` — фото товаров (можно заменить SVG-плейсхолдеры на реальные)
