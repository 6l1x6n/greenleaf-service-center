import json
import os
import random
import re
import sys
import time
import urllib.request
from datetime import datetime
from html.parser import HTMLParser

from playwright.sync_api import sync_playwright

# PNG портала содержат крупные текстовые чанки (метаданные/ICC) — Pillow
# по умолчанию отказывается открывать их (MAX_TEXT_CHUNK = 1МБ)
try:
    import PIL.PngImagePlugin as _png_plugin
    _png_plugin.MAX_TEXT_CHUNK = 64 * 1024 * 1024
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
PRODUCTS_PATH = os.path.join(ROOT_DIR, "public", "data", "products.base.json")
MOVES_PATH = os.path.join(ROOT_DIR, "public", "data", "moves.json")
STORE_STOCK_PATH = os.path.join(ROOT_DIR, "public", "data", "store-stock.json")
CATALOG_CACHE_PATH = os.path.join(BASE_DIR, ".catalog_cache.json")
GOODS_CACHE_PATH = os.path.join(BASE_DIR, ".goods_cache.json")
GOODS_ID_CACHE_PATH = os.path.join(BASE_DIR, ".goods_id_map.json")

PRODUCT_CODE_STRICT_RE = re.compile(r"^[A-Z]{3}\d{3}$")
BOX_PREFIX_RE = re.compile(
    r"""^[\s()]*
        (?:Кол[-\s]?во?\s+)?
        (?:в\s+)?коробк[аеиу]
        \s*[:\.]?\s*\d+\s*шт\.?\s*[\)\.:,]?\s*""",
    re.IGNORECASE | re.VERBOSE,
)
AVAILABLE_QTY_RE = re.compile(r"Доступно для продажи:\s*(\d+)")
IMG_SRC_RE = re.compile(r'<img[^>]+src="([^"]+)"', re.IGNORECASE)
IMG_ATTR_RE = re.compile(
    r'<img[^>]+(?:data-src|data-original|data-lazy-src|srcset)="([^"]+)"', re.IGNORECASE
)
PLACEHOLDER_RE = re.compile(r"(placeholder|pixel|blank|\.gif$)", re.IGNORECASE)
# Общие картинки портала, которые встречаются как og:image/дефолт вместо фото товара
DEFAULT_IMG_RE = re.compile(r"(index\.jpe?g|nofoto|logo_white|/static/img/|/static/|default)", re.IGNORECASE)


def extract_image_url(html):
    for pattern in (IMG_ATTR_RE, IMG_SRC_RE):
        for m in pattern.finditer(html):
            url = m.group(1).strip()
            if not url or PLACEHOLDER_RE.search(url):
                continue
            url = url.split()[0]
            return url
    return ""


def clean_product_name(raw_name):
    name = re.sub(r"&nbsp;", " ", raw_name)
    name = re.sub(r"\s+", " ", name).strip()
    name = BOX_PREFIX_RE.sub("", name).strip()
    name = re.sub(r"\s*Доступно\s+для\s+продажи:\s*\d+\s*$", "", name, flags=re.IGNORECASE).strip()
    name = re.sub(r"\s*Доступно:\s*\d+\s*$", "", name, flags=re.IGNORECASE).strip()
    name = re.sub(r"^[\s)]+", "", name).strip()
    return name


def load_config():
    path = os.path.join(BASE_DIR, "config.json")
    example_path = os.path.join(BASE_DIR, "config.example.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            config = json.load(f)
    elif os.path.exists(example_path):
        with open(example_path, encoding="utf-8") as f:
            config = json.load(f)
        print("config.json не найден — использую config.example.json")
    else:
        raise FileNotFoundError(
            "Нет config.json и config.example.json. Скопируйте config.example.json: cp config.example.json config.json"
        )
    config["sc_login"] = os.environ.get("SC_LOGIN", config.get("sc_login", ""))
    config["sc_password"] = os.environ.get("SC_PASSWORD", config.get("sc_password", ""))
    config["partner_login"] = os.environ.get("PARTNER_LOGIN") or config.get("partner_login", "")
    worker_stores = load_stores_from_worker()
    if worker_stores:
        config["stores"] = worker_stores
    return config


def load_stores_from_worker():
    """Список сервис-центров с кредами — из Cloudflare Worker (KV), по API-ключу.

    Адрес и ключ задаются переменными окружения SC_API_URL / SC_API_KEY
    (GitHub Secrets). Если недоступно — парсер работает по config.json.
    """
    url = os.environ.get("SC_API_URL", "").strip().rstrip("/")
    key = os.environ.get("SC_API_KEY", "").strip()
    if not url or not key:
        return None
    try:
        req = urllib.request.Request(
            url + "/api/parser-config",
            headers={"X-API-Key": key, "User-Agent": "greenleaf-parser/1.0"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8", "ignore"))
        stores = data.get("stores") or []
        if not stores:
            print("Worker: активных СЦ нет — используем config.json")
            return None
        normalized = []
        for s in stores:
            if not s.get("login"):
                print(f"Worker: СЦ {s.get('id', '?')} без логина — пропускаю")
                continue
            normalized.append({
                "id": s.get("id") or s.get("officeCode") or s["login"].lower(),
                "login": s["login"],
                "password": s.get("password", ""),
                "partner": s.get("partner", ""),
            })
        print(f"Worker: получено СЦ: {[s['id'] for s in normalized]}")
        return normalized
    except Exception as e:
        print(f"Worker: не удалось получить СЦ ({e}) — используем config.json")
        return None


def get_stores(config):
    """Список сервис-центров для парсинга (каталог каждого парсится по кодам
    и вливается в единую базу). Пустые поля наследуют значения из config/env."""
    stores = config.get("stores") or []
    if not stores:
        stores = [{
            "id": config.get("central_store_id", "s240534"),
            "login": config.get("sc_login", ""),
            "partner": config.get("partner_login", ""),
        }]
    return stores


def active_store_ids(config):
    """Актуальные id сервис-центров — остатки сохраняются только для них.
    Устаревшие ключи (например, sc-astana от старых прогонов) удаляются."""
    ids = [s.get("id") for s in get_stores(config) if s.get("id")]
    central = config.get("central_store_id")
    if central and central not in ids:
        ids.append(central)
    return ids


def build_store_config(config, store):
    cfg = dict(config)
    cfg["sc_id"] = store.get("id") or config.get("central_store_id", "s240534")
    cfg["sc_login"] = store.get("login") or config.get("sc_login", "")
    cfg["sc_password"] = store.get("password") or config.get("sc_password", "")
    cfg["partner_login"] = store.get("partner") or config.get("partner_login", "")
    return cfg


def find_goods_rows(page):
    for selector in ("tr.goods-item", "tr.good_item"):
        rows = page.query_selector_all(selector)
        if rows:
            return rows
    return []


def wait_goods_rows(page, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = find_goods_rows(page)
        if rows:
            return rows
        time.sleep(1.5)
    return find_goods_rows(page)


DIAG_DIR = os.path.join(BASE_DIR, "diag")


def dump_diag(page, label):
    os.makedirs(DIAG_DIR, exist_ok=True)
    try:
        path = os.path.join(DIAG_DIR, label)
        page.screenshot(path=path + ".png")
    except Exception:
        pass
    try:
        with open(path + ".txt", "w", encoding="utf-8") as f:
            f.write("URL: " + page.url + "\n\n" + page.inner_text("body")[:3000])
    except Exception:
        pass
    print(f"Диагностика сохранена: {path}")


def dump_form_state(page, label):
    os.makedirs(DIAG_DIR, exist_ok=True)
    try:
        html = page.evaluate("""() => {
            const out = [];
            document.querySelectorAll('input, button, select').forEach(el => {
                const name = el.getAttribute('name') || '';
                const cq = el.getAttribute('check_query') || '';
                const id = el.id || '';
                if (cq || name === 'client' || name === 'login_buy' || /Далее|Найти|Проверить/.test(el.value || el.textContent || '')) {
                    out.push({
                        tag: el.tagName, id, name, check_query: cq,
                        value: (el.value || '').slice(0, 40),
                        disabled: !!el.disabled,
                        text: (el.textContent || '').trim().slice(0, 40)
                    });
                }
            });
            return JSON.stringify(out, null, 1);
        }""")
        with open(os.path.join(DIAG_DIR, label + ".json"), "w", encoding="utf-8") as f:
            f.write("URL: " + page.url + "\n\n" + html)
        print(f"Состояние формы сохранено: {label}")
    except Exception as e:
        print(f"Не удалось сохранить форму {label}: {e}")


def wait_login_or_form(page, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if "#admin" in page.url:
            return "already_logged_in"
        if page.query_selector('input[name="login"]') is not None:
            return "form"
        time.sleep(1)
    return "none"


def login(page, config):
    url = config["portal_url"] + "/office/login?goto=%2Fdashboard"
    login_ = config["sc_login"]
    password = config["sc_password"]
    missing = []
    if not login_:
        missing.append("SC_LOGIN")
    if not password:
        missing.append("SC_PASSWORD")
    if missing:
        raise RuntimeError(
            "Учетные данные не настроены: "
            + ", ".join(missing)
            + " (задайте их в GitHub Secrets → Actions или в scripts/parser/config.json)"
        )

    max_retries = 6
    for retry in range(max_retries):
        try:
            page.goto(url, timeout=60000)
            for _ in range(3):
                state = wait_login_or_form(page, timeout=25)
                if state == "already_logged_in":
                    print("Сессия уже активна")
                    time.sleep(2)
                    return
                if state == "form":
                    break
                print("Форма входа не загрузилась, перезагрузка страницы...")
                page.reload(timeout=30000)
                time.sleep(3)
            else:
                raise TimeoutError("форма входа не появилась")
            page.fill('input[name="login"]', login_)
            page.fill('input[name="passwd"]', password)
            page.keyboard.press("Enter")
            deadline = time.time() + 150
            while time.time() < deadline:
                if "#admin" in page.url:
                    break
                if page.query_selector('a[href="#admin/shop/buy"]') is not None:
                    break
                time.sleep(2)
            else:
                raise TimeoutError("остались на странице входа")
            time.sleep(3)
            print("Вход выполнен")
            return
        except Exception as e:
            print(f"Ошибка входа (попытка {retry + 1}/{max_retries}): {e}")
            dump_diag(page, f"login_failed_{retry + 1}")
            if retry < max_retries - 1:
                time.sleep(30)
    raise RuntimeError("Вход не удался после всех попыток")


def open_shop(page, config):
    # Каталог — страница «Новая продажа»: выбираем партнёра (partner_login), «Далее» открывает
    # каталог chgoods (place=purchase/create) со всеми товарами.
    page.goto(config["portal_url"] + "/do.vshow#admin/shop/buy", timeout=30000)
    time.sleep(3)


def enter_partner(page, config):
    partner = config.get("partner_login", "")
    if not partner:
        return True
    try:
        page.wait_for_selector('input[check_query="login_buy"]', state="attached", timeout=30000)
        field = page.locator('input[check_query="login_buy"]')
        field.fill(partner)
        # Клиент может отсутствовать в выпадашке поиска — ставим скрытое поле напрямую,
        # dbcheck портала подтвердит логин и активирует кнопку «Далее»
        page.evaluate("""(l) => {
            const h = document.querySelector('input[name="client"]');
            if (h) {
                h.value = l;
                h.dispatchEvent(new Event('input', {bubbles: true}));
            }
        }""", partner)
        # Стратегия 2: выбираем клиента из выпадающего списка, если он появился
        try:
            field.press("Enter")
        except Exception:
            pass
        deadline = time.time() + 25
        denied_since = None
        dropdown_clicked = False
        while time.time() < deadline:
            try:
                if page.locator('text="Нет доступа"').count() > 0:
                    if not denied_since:
                        denied_since = time.time()
                    if time.time() - denied_since >= 4:
                        dump_diag(page, f"partner_denied_{int(time.time() % 100)}")
                        dump_form_state(page, f"partner_denied_form_{int(time.time() % 100)}")
                        print("Партнёр отклонён порталом (Нет доступа)")
                        return False
                else:
                    denied_since = None
                if page.locator('input[type="submit"][value="Далее"]:not([disabled])').count() > 0:
                    break
                if not dropdown_clicked:
                    dropdown_items = page.locator('.ui-autocomplete li, ul.autocomplete li, [role="option"]')
                    count = dropdown_items.count()
                    if count > 0:
                        target_idx = None
                        for i in range(min(count, 20)):
                            text = (dropdown_items.nth(i).inner_text() or "").strip()
                            if partner.lower() in text.lower() or ("PART_" + partner.lower()) in text.lower():
                                target_idx = i
                                break
                        if target_idx is None:
                            target_idx = 0
                        dropdown_items.nth(target_idx).click(timeout=3000)
                        dropdown_clicked = True
                        page.evaluate("""(l) => {
                            const h = document.querySelector('input[name="client"]');
                            if (h) { h.value = l; h.dispatchEvent(new Event('input', {bubbles: true})); }
                        }""", partner)
            except Exception:
                pass
            time.sleep(0.5)
        else:
            dump_form_state(page, "partner_no_next")
            dump_diag(page, "partner_no_next")
            print("Кнопка «Далее» не активировалась — клиент не подтверждён")
            return False
        page.click('input[type="submit"][value="Далее"]', timeout=15000)
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
        dump_form_state(page, f"after_next_{int(time.time() % 100)}")
        return True
    except Exception as e:
        print(f"Ошибка подключения партнёра: {e}")
        return False


def parse_row(html):
    cells = re.findall(r"<td[^>]*>(.*?)</td>", html, re.DOTALL | re.IGNORECASE)
    if len(cells) < 6:
        return None

    parts = re.split(r"<br\s*/?>", cells[0], maxsplit=1, flags=re.IGNORECASE)
    if len(parts) < 2:
        return None
    raw_code = re.sub(r"<[^>]+>", "", parts[1]).strip()
    if not raw_code:
        return None

    if not PRODUCT_CODE_STRICT_RE.match(raw_code):
        return {"code": raw_code, "name": "", "sale_price": 0, "pv": 0, "quantity": 0, "skipped": True}

    name_match = re.search(
        r'<div[^>]*class="data-title"[^>]*>(.*?)</div>', cells[1], re.DOTALL | re.IGNORECASE
    )
    name_raw = name_match.group(1) if name_match else cells[1]
    name_raw = re.sub(r"<[^>]+>", " ", name_raw)
    name = clean_product_name(name_raw)

    cell2_text = re.sub(r"<[^>]+>", " ", cells[1]).strip()
    qty_match = AVAILABLE_QTY_RE.search(cell2_text)
    available_qty = int(qty_match.group(1)) if qty_match else 0

    image_url = extract_image_url(html)

    price_match = re.search(r"<b>\s*([\d\s]+)", cells[3], re.DOTALL)
    if not price_match:
        price_match = re.search(r"([\d\s]+)", cells[3])
    discount_price = 0
    if price_match:
        try:
            discount_price = int(price_match.group(1).replace(" ", "").replace("\u00a0", ""))
        except ValueError:
            discount_price = 0

    cell5_clean = re.sub(r"<[^>]+>", " ", cells[4]).strip()
    try:
        pv = float(cell5_clean)
    except ValueError:
        pv = 0

    return {
        "code": raw_code,
        "name": name,
        "sale_price": discount_price,
        "pv": pv,
        "quantity": available_qty,
        "image_url": image_url,
        "skipped": False,
    }


GOODS_ID_BY_CODE = {}  # код товара каталога -> id товара на портале (data-id строки buy-страницы)


def save_goods_id_map():
    if not GOODS_ID_BY_CODE:
        return
    with open(GOODS_ID_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(GOODS_ID_BY_CODE, f, ensure_ascii=False, indent=2)


def scrape_goods(page, config):
    rows = []
    for attempt in range(1, 4):
        if attempt > 1:
            print(f"Повторная попытка получения каталога ({attempt}/3)...")
            page.reload(timeout=30000)
            time.sleep(2)
        if not enter_partner(page, config):
            dump_diag(page, f"partner_failed_{attempt}")
            if attempt >= 3:
                raise RuntimeError("Не удалось получить каталог поставщика")
            continue
        rows = wait_goods_rows(page, timeout=15)
        if not rows:
            dump_diag(page, f"no_goods_{attempt}")
            # Клик «Далее» мог не сработать — пробуем ещё раз и ждём дольше
            try:
                nxt = page.locator('input[type="submit"][value="Далее"]:not([disabled])')
                if nxt.count() > 0:
                    nxt.first.click(timeout=5000)
            except Exception:
                pass
            rows = wait_goods_rows(page, timeout=35)
        if rows:
            break

    if not rows:
        dump_diag(page, "scrape_failed")
        raise RuntimeError("Не удалось получить каталог поставщика")

    all_items = []
    skipped_codes = []
    seen_codes = set()
    max_pages = config.get("max_pages", 200)

    for _ in range(max_pages):
        rows = find_goods_rows(page)
        if not rows:
            break

        # Прокручиваем до последней строки — форсируем ленивую загрузку картинок
        last = rows[-1]
        try:
            last.scroll_into_view_if_needed(timeout=5000)
            time.sleep(0.3)
        except Exception:
            pass

        new_count = 0
        for row in rows:
            try:
                parsed = parse_row(row.inner_html())
                if not parsed:
                    continue
                code = parsed.get("code")
                if code in seen_codes:
                    continue
                seen_codes.add(code)
                all_items.append(parsed)
                new_count += 1
                if parsed.get("skipped"):
                    skipped_codes.append(code)
                try:
                    gid = row.get_attribute("data-id")
                    if gid and code and not parsed.get("skipped"):
                        GOODS_ID_BY_CODE[code] = int(gid)
                except Exception:
                    pass
            except Exception:
                pass

        show_more = page.query_selector('a:has-text("Показать еще...")')
        if not show_more or not show_more.is_visible():
            break

        # Вежливость к порталу: случайная пауза перед кликом снижает
        # «машинный» паттерн при частых прогонах
        time.sleep(random.uniform(0.5, 1.5))
        try:
            prev_count = len(find_goods_rows(page))
            show_more.click(timeout=15000)
            deadline = time.time() + 20
            while time.time() < deadline:
                if len(find_goods_rows(page)) > prev_count:
                    break
                time.sleep(1.5)
            else:
                break
        except Exception:
            break

    print(f"Каталог получен: {len(all_items)} позиций ({new_count} на последней итерации)")
    if skipped_codes:
        print(f"Пропущено позиций (код не формата ABC123): {len(skipped_codes)}")

    save_goods_id_map()
    return [it for it in all_items if not it.get("skipped")]


def classify_category(name, categories):
    lower = name.lower()
    for cat in categories:
        for keyword in cat.get("keywords", []):
            kw = keyword.lower()
            # слово должно начинаться с ключевого слова (не подстрока внутри слова,
            # чтобы «пил» не попадал в «депиляции» и т.п.)
            if re.search(r"(?<![a-zа-яё0-9])" + re.escape(kw), lower):
                return cat["name"]
    return "Прочее"


def image_for_category(name, categories):
    for cat in categories:
        if cat["name"] == name:
            return cat.get("image", "assets/images/products/placeholder.svg")
    return "assets/images/products/placeholder.svg"


# ---------------- Изображения товаров ----------------

IMAGES_DIR = os.path.join(ROOT_DIR, "public", "assets", "images", "products")
IMAGE_EXT_RE = re.compile(r"\.(png|jpe?g|webp|gif)$", re.IGNORECASE)
DOWNLOAD_WORKERS = 8
DOWNLOAD_TIMEOUT = 25


def image_variant_urls(url, config):
    base = config.get("portal_url", "")
    if url.startswith("/"):
        url = base + url
    big_url = url.replace("-small.", "-big.")
    return [big_url, url]


def image_local_path(code, url):
    m = IMAGE_EXT_RE.search(url.split("?")[0])
    ext = m.group(0).lower() if m else ".png"
    return os.path.join(IMAGES_DIR, code + ext)


def fetch_image(path, urls, session=None):
    if os.path.exists(path):
        return True
    os.makedirs(IMAGES_DIR, exist_ok=True)
    tmp = path + ".tmp"
    for url in urls:
        try:
            if session is not None:
                resp = session.get(url)
                if not resp.ok:
                    continue
                data = resp.body()
            else:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp:
                    data = resp.read()
            if len(data) < 200:
                continue
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
            return True
        except Exception:
            continue
    try:
        if os.path.exists(tmp):
            os.remove(tmp)
    except Exception:
        pass
    return False


def download_images(items, config, session=None):
    if not config.get("download_images", True):
        return {}
    tasks = []
    pending = {}
    for it in items:
        if it.get("skipped") or not it.get("image_url"):
            continue
        urls = image_variant_urls(it["image_url"], config)
        path = image_local_path(it["code"], urls[0])
        if path in pending:
            continue
        pending[path] = it["code"]
        tasks.append((path, urls))
    done = 0
    # Последовательно: sync-API Playwright нельзя вызывать из потоков
    for path, urls in tasks:
        if fetch_image(path, urls, session):
            done += 1
        if done > 0 and (done % 50) == 0:
            print(f"Изображения: {done}/{len(tasks)}...")
    print(f"Изображения: {done} скачано, {len(tasks) - done} пропущено/уже было")
    result = {}
    for path, code in pending.items():
        if os.path.exists(path):
            result[code] = os.path.relpath(path, os.path.join(ROOT_DIR, "public")).replace(os.sep, "/")
    return result


# ---------------- Фото из API портала (поле photo) ----------------
# Поле photo отдаёт прямое фото товара — надёжнее парсинга страницы:
# страницы с суффиксом в slug (_2/_n) не рендерят галерею и подставляют
# первое фото из «похожих товаров». У файла есть веб-версия «-shop.»
# (тот же файл, оптимизированный для сайта) — пробуем её первой.

MAX_IMAGE_BYTES = 400 * 1024
MAX_IMAGE_EDGE = 800


def compress_image_if_needed(path):
    """Сжимает фото больше 400КБ до 800px по большей стороне (Pillow).

    RGBA/палитровые сохраняются как PNG; остальные — как JPEG (файл
    переименовывается в .jpg, чтобы расширение совпадало с содержимым).
    Возвращает итоговый путь (может отличаться от входного).
    """
    try:
        from PIL import Image
        if os.path.getsize(path) <= MAX_IMAGE_BYTES:
            return path
        img = Image.open(path)
        img.load()
        w, h = img.size
        scale = min(1.0, MAX_IMAGE_EDGE / max(w, h))
        if scale < 1.0:
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        if img.mode in ("RGBA", "P", "LA"):
            img.convert("RGBA").save(path, "PNG", optimize=True)
            return path
        new_path = os.path.splitext(path)[0] + ".jpg"
        img.convert("RGB").save(new_path, "JPEG", quality=82, optimize=True, progressive=True)
        if new_path != path and os.path.exists(path):
            os.remove(path)
        print(f"Фото сжато: {os.path.basename(new_path)} ({os.path.getsize(new_path) // 1024} КБ)")
        return new_path
    except ImportError:
        print("Pillow не установлен — фото без сжатия")
        return path
    except Exception as e:
        print(f"Сжатие фото {os.path.basename(path)} не удалось ({e}) — оставляю как есть")
        return path


def clean_local_photo_variants(sku):
    """Удаляет все локальные варианты фото артикула (для принудительной перезагрузки)."""
    for ext in (".png", ".jpg", ".jpeg"):
        p = os.path.join(IMAGES_DIR, sku + ext)
        if os.path.exists(p):
            try:
                os.remove(p)
            except Exception:
                pass


def download_product_photo(sku, photo_url, config, session=None):
    """Скачивает фото товара с портала: веб-версию «-shop.», затем оригинал.

    Большие файлы сжимаются (Pillow). Возвращает относительный путь или None.
    """
    url = str(photo_url or "").strip()
    if not url:
        return None
    if url.startswith("/"):
        url = config.get("portal_url", "") + url
    stem, _, ext = url.rpartition(".")
    orig_ext = ext.lower() if ext.lower() in ("png", "jpg", "jpeg") else ""
    # Сначала веб-версии «-shop.» (включая то же расширение, что у оригинала),
    # затем оригинал — так берём самый лёгкий подходящий файл
    attempts = []
    for e in ("png", "jpg", "jpeg"):
        if e != orig_ext:
            attempts.append(stem + "-shop." + e)
    attempts.insert(0, stem + "-shop." + orig_ext) if orig_ext else None
    attempts.append(url)
    for attempt in attempts:
        path = image_local_path(sku, attempt)
        if fetch_image(path, [attempt], session):
            final = compress_image_if_needed(path)
            return os.path.relpath(final, os.path.join(ROOT_DIR, "public")).replace(os.sep, "/")
    return None


def status_from_qty(qty, low_threshold):
    if qty >= low_threshold:
        return "in_stock"
    if qty >= 1:
        return "low"
    return "out"


# ---------------- Перемещения товаров (накладные, статусы поставок) ----------------

# Статусы накладных портала: код по значению из select[name="state"]
MOVE_STATUS_CODES = {
    "Новый": 0,
    "Оплачен": 1,
    "Выгружен в 1С": 2,
    "Проверен": 3,
    "Отправлен": 4,
    "Оспорен": 5,
    "Принят": 6,
    "Принят СЦ": 7,
    "Отменен": 9,
    "В обработке": 100,
    "Ошибка обработки": 101,
}
# Статусы, по которым имеет смысл показывать «в пути» и парсить состав накладной
ACTIVE_MOVE_CODES = (0, 1, 2, 3, 4, 6, 100)

# Действующие поставщики: «Астана поставщик "новый"», «Астана поставщик», «Алматы поставщик».
# Накладные с любым другим источником — это брак, на сайте не учитываются.
VALID_MOVE_SOURCE_RE = re.compile(r"(Астана поставщик|Алматы поставщик)", re.IGNORECASE)


def wait_move_rows(page, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = page.query_selector_all('table.table_round tr:has(a[href*="action=show&move="])')
        if rows:
            return rows
        time.sleep(1.5)
    return page.query_selector_all('table.table_round tr:has(a[href*="action=show&move="])')


def _cell_text(cell):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", cell)).strip()


def parse_move_row(html):
    cells = re.findall(r"<td[^>]*>(.*?)</td>", html, re.DOTALL | re.IGNORECASE)
    if len(cells) < 7:
        return None
    m = re.search(r'href="[^"]*move=(\d+)"', cells[0])
    if not m:
        return None
    time_raw = _cell_text(cells[2])
    sum_raw = _cell_text(cells[3]).replace(" ", "").replace("\u00a0", "")
    status = _cell_text(cells[6])
    date_iso = ""
    time_iso = ""
    tm = re.search(r"(\d{2})\.(\d{2})\.(\d{4})", time_raw)
    if tm:
        d, mo, y = tm.groups()
        date_iso = f"{y}-{mo}-{d}"
        time_iso = date_iso
        if "," in time_raw:
            time_iso += " " + time_raw.split(",", 1)[1].strip()
    try:
        total = float(sum_raw)
    except ValueError:
        total = 0.0
    return {
        "number": m.group(1),
        "who": _cell_text(cells[1]),
        "time": time_iso,
        "date": date_iso,
        "sum": total,
        "source": _cell_text(cells[4]),
        "recipient": _cell_text(cells[5]),
        "status": status,
        "statusCode": MOVE_STATUS_CODES.get(status, -1),
        "items": [],
        "itemsParsed": False,
    }


def fetch_move_items(page, config, mv):
    number = mv["number"]
    detail_url = config["portal_url"] + "/do.vshow#admin/shop/move?action=show&move=" + number
    # SPA портала может не перерисовать детали при переходе с предыдущей накладной
    # (тогда в следующую записываются чужие позиции). Поэтому: полная перезагрузка
    # страницы (свежий запуск SPA с нужным hash) + проверка, что открылась именно
    # эта накладная (move=N в URL и номер в тексте страницы). Если не вышло — пустой
    # состав («Состав накладной уточняется»), чужие позиции не подставляем.
    loaded = False
    for attempt in range(1, 4):
        try:
            page.goto(detail_url, timeout=30000)
            time.sleep(1)
            page.reload(timeout=30000)
            time.sleep(3)
        except Exception as e:
            print(f"Накладная {number}: не удалось открыть ({e}) — попытка {attempt}/3")
            continue
        try:
            if ("move=" + number) in page.url and number in page.inner_text("body"):
                loaded = True
                break
        except Exception:
            pass
        print(f"Накладная {number}: детали не загрузились (попытка {attempt}/3) — перезагружаю…")
    if not loaded:
        print(f"Накладная {number}: состав не получен — карточка покажет «Состав уточняется»")
        return []
    try:
        os.makedirs(DIAG_DIR, exist_ok=True)
        with open(os.path.join(DIAG_DIR, f"move_{number}.html"), "w", encoding="utf-8") as f:
            f.write(page.content())
    except Exception:
        pass
    items = []
    seen = set()
    html = page.content()
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.DOTALL | re.IGNORECASE):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL | re.IGNORECASE)
        if len(cells) < 3:
            continue
        code = _cell_text(cells[1])
        if not PRODUCT_CODE_STRICT_RE.match(code) or code in seen:
            continue
        seen.add(code)
        qty = 1
        if len(cells) >= 7:
            qty_m = re.search(r"(\d+)", _cell_text(cells[6]))
            if qty_m:
                qty = int(qty_m.group(1))
        items.append({"sku": code, "name": clean_product_name(_cell_text(cells[2])), "qty": qty})
    return items


def scrape_moves(page, config):
    page.goto(config["portal_url"] + "/do.vshow#admin/shop/move", timeout=30000)
    time.sleep(3)
    rows = wait_move_rows(page, timeout=30)
    if not rows:
        dump_diag(page, "moves_no_rows")
        raise RuntimeError("Не удалось получить список перемещений товаров")

    moves = []
    seen = set()
    for row in rows:
        try:
            mv = parse_move_row(row.inner_html())
            if not mv or mv["number"] in seen:
                continue
            # Накладные-брак (источник не из действующих поставщиков) не учитываем
            if not VALID_MOVE_SOURCE_RE.search(mv["source"] or ""):
                continue
            seen.add(mv["number"])
            moves.append(mv)
        except Exception:
            continue
    moves.sort(key=lambda x: x["time"], reverse=True)
    print(f"Накладные получены: {len(moves)}")

    max_details = config.get("move_details_limit", 10)
    done = 0
    for mv in moves:
        if done >= max_details:
            break
        if mv["statusCode"] not in ACTIVE_MOVE_CODES:
            continue
        mv["items"] = fetch_move_items(page, config, mv)
        mv["itemsParsed"] = len(mv["items"]) > 0
        done += 1
        time.sleep(1.5)
    return moves


def write_moves(moves):
    payload = {
        "updated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+03:00"),
        "moves": moves,
    }
    with open(MOVES_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Сохранено накладных: {len(moves)} -> {MOVES_PATH}")


# ---------------- Единая база товаров ----------------
# products.json — постоянная база: карточка создаётся один раз по коду (sku),
# дальше парсер обновляет только количество по каждому сервис-центру (stock[sc])
# и динамические характеристики (название, цены, фото). Описание статично:
# заполняется один раз при создании карточки, дальше его меняют только админы.
# Карточки никогда не удаляются и не пересоздаются.


def load_base_products():
    if not os.path.exists(PRODUCTS_PATH):
        print("База товаров не найдена — начнём с пустой")
        return []
    try:
        with open(PRODUCTS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("products") or []
    except Exception as e:
        print(f"База товаров: не удалось прочитать ({e}) — начнём с пустой")
        return []


def base_index(products):
    return {p["sku"]: p for p in products if p.get("sku")}


def fetch_all_goods(config):
    """Полный список товаров портала из API (без авторизации).

    /api/v1/shop/goods без code отдаёт весь каталог постранично (limit+offset),
    включая служебные узлы без code (их отбрасывает ensure_full_catalog).
    Это лёгкий проход: поля без описаний на каждой странице, ~13 запросов.
    """
    base = config.get("portal_url", "").rstrip("/")
    fields = "id,code,path,name,title,photo"
    out = []
    offset = 0
    page = 500
    while True:
        url = f"{base}/api/v1/shop/goods?fields={fields}&limit={page}&offset={offset}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                chunk = json.loads(resp.read().decode("utf-8", "ignore"))
        except Exception as e:
            print(f"Список товаров портала: ошибка на offset {offset} ({e}) — прекращаю")
            break
        if not chunk:
            break
        out.extend(chunk)
        offset += len(chunk)
        if len(chunk) < page:
            break
    print(f"Список товаров портала: {len(out)} записей")
    return out


def ensure_full_catalog(base_products, goods, config):
    """Создаёт карточки для всех товаров портала, которых ещё нет в базе.

    Карточки без цены/остатков: status out, price 0 (фронт показывает
    «Цена по запросу»), фото — веб-вариант «-small» с портала (локально
    не качаем — иначе репозиторий раздуется тысячами файлов). Когда артикул
    появится в каталоге продажи, merge_sc_items достроит его полными данными
    (цена, локальное фото, pending снимается).
    """
    categories = config.get("categories", [])
    by_code = base_index(base_products)
    created = 0
    for g in goods:
        code = (g.get("code") or "").strip()
        if not code or code in by_code:
            continue
        title = (g.get("title") or {}).get("ru") or g.get("name") or ""
        if not title:
            continue
        name = title
        category = classify_category(name, categories)
        photo = (g.get("photo") or "").strip()
        image = ""
        if photo:
            base_url = config.get("portal_url", "").rstrip("/")
            url = photo if photo.startswith("http") else base_url + photo
            stem, _, ext = url.rpartition(".")
            ext = ext.lower() if ext.lower() in ("png", "jpg", "jpeg") else ""
            if ext:
                image = stem + "-small." + ext
            else:
                image = url
        card = {
            "id": code,
            "sku": code,
            "name": name,
            "category": category,
            "price": 0,
            "partner_price": 0,
            "quantity": 0,
            "image": image or image_for_category(category, categories),
            "status": "out",
            "eta": None,
            "incoming": None,
            "description": "",
            "stock": {},
            "hidden": False,
        }
        base_products.append(card)
        by_code[code] = card
        created += 1
    if created:
        print(f"Каталог портала: создано карточек {created} (всего в базе {len(base_products)})")
    else:
        print("Каталог портала: новых карточек нет")
    return base_products


def merge_sc_items(base_products, items, sc_id, config, images=None, descriptions=None, full=True):
    """Вливает каталог одного сервис-центра в базу: по коду обновляет количество,
    новые коды создают новые карточки. Описание не перезаписывается (заполняется
    только при создании карточки).

    full=True  — ручной полный прогон (--full): обновляются название, категория,
                 цена, фото существующих карточек.
    full=False — умный режим (по умолчанию, все запуски): существующие карточки
                 обновляются ТОЛЬКО по количеству (по артикулу) — экономим запросы
                 к порталу; новые товары всё равно создаются с полными данными."""
    categories = config.get("categories", [])
    low_threshold = config.get("low_threshold", 6)
    multiplier = config.get("price_multiplier", 2)
    central = config.get("central_store_id", "s240534")
    images = images or {}
    descriptions = descriptions or {}

    for p in base_products:
        p.setdefault("stock", {})
        p.setdefault("eta", None)
        p.setdefault("incoming", None)
        p.setdefault("description", "")

    by_code = base_index(base_products)
    created = 0
    updated = 0
    for it in items:
        code = it.get("code")
        if not code or not it.get("name"):
            continue
        category = classify_category(it["name"], categories)
        price = round(it["sale_price"] * multiplier)
        partner_price = round(it["sale_price"])
        img = images.get(code)
        card = by_code.get(code)
        if card is None:
            card = {
                "id": code,
                "sku": code,
                "name": it["name"],
                "category": category,
                "price": price,
                "partner_price": partner_price,
                "quantity": 0,
                "image": img or image_for_category(category, categories),
                "status": "out",
                "eta": None,
                "incoming": None,
                "description": descriptions.get(code, ""),
                "stock": {},
            }
            by_code[code] = card
            created += 1
        else:
            # Инкрементальный режим: существующие карточки трогаем только по количеству.
            # Исключение — заглушка из накладной (pending): достраиваем её полными
            # данными один раз, как только артикул появился в каталоге продажи.
            if full or card.get("pending"):
                card["name"] = it["name"]
                card["category"] = category
                card["price"] = price
                card["partner_price"] = partner_price
                if img:
                    card["image"] = img
                if card.get("pending"):
                    card.pop("pending", None)
                    card["hidden"] = False
            updated += 1
        card["stock"][sc_id] = it["quantity"]

    # quantity/status — производные от центрального филиала (для фронта без изменений)
    for card in by_code.values():
        qty = int(card["stock"].get(central, 0) or 0)
        card["quantity"] = qty
        card["status"] = status_from_qty(qty, low_threshold)

    print(
        f"База {sc_id}: создано карточек {created}, обновлено {updated}, "
        f"всего в базе {len(by_code)}"
    )
    return list(by_code.values())


def write_products(products, active_ids=None):
    if active_ids:
        for p in products:
            stock = p.get("stock")
            if isinstance(stock, dict):
                p["stock"] = {k: v for k, v in stock.items() if k in active_ids}
    payload = {
        "updated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+03:00"),
        "products": products,
    }
    with open(PRODUCTS_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Сохранено карточек: {len(products)} -> {PRODUCTS_PATH}")


# ---------------- Описания товаров ----------------
# Короткие описания отдаёт API магазина (api.getShopGoods), полные тексты
# («Состав», «Свойства», «Срок годности»…) лежат на публичных карточках
# https://greenleaf-global.com/shop/<path>/<slug>_n/ в блоке .product__text.

DESC_SECTION_HEADERS = (
    "Описание", "Состав", "Свойства", "Применение", "Способ применения",
    "Способ хранения", "Срок годности", "Особенности", "Действие", "Назначение",
)


class ProductTextParser(HTMLParser):
    """Извлекает текстовые блоки описания из блока .product__text публичной карточки."""

    def __init__(self):
        super().__init__()
        self.in_text = False
        self.depth = 0
        self.cur = []
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get("class", "") or ""
        if tag == "div" and "product__text" in cls.split():
            self.in_text = True
            self.depth = 1
            return
        if self.in_text:
            if tag == "div":
                self.depth += 1
            elif tag in ("p", "br", "li", "h2", "h3", "h4"):
                self.cur.append("\n")

    def handle_endtag(self, tag):
        if not self.in_text:
            return
        if tag == "div":
            self.depth -= 1
            if self.depth <= 0:
                self.in_text = False
                self._flush()
        elif tag in ("p", "li", "h2", "h3", "h4"):
            self._flush()

    def handle_data(self, data):
        if self.in_text:
            self.cur.append(data)

    def _flush(self):
        text = re.sub(r"\s+", " ", "".join(self.cur)).strip()
        self.cur = []
        if text:
            self.blocks.append(text)


def extract_public_description(html):
    parser = ProductTextParser()
    try:
        parser.feed(html)
    except Exception:
        return ""
    blocks = [b for b in parser.blocks if not b.startswith("Другие товары из категории")]
    return "\n".join(blocks)


def extract_product_image(html):
    """Фото товара с публичной карточки.

    Первое <img itemProp="image"> в слайдере — это фото самого товара
    (дальше в слайдере идут фото похожих товаров). og:image используем только
    если это не общая картинка портала (/static/img/index.jpg — её портал
    подставляет всем страницам, фото товара в ней нет).
    """
    for m in re.finditer(r"<img[^>]+>", html, re.IGNORECASE):
        tag = m.group(0)
        if 'itemprop="image"' not in tag.lower() and "itemprop='image'" not in tag.lower():
            continue
        sm = re.search(r'(?:data-src|src)=["\']([^"\']+)["\']', tag, re.IGNORECASE)
        if not sm:
            continue
        url = sm.group(1).strip().split()[0]
        if not url or PLACEHOLDER_RE.search(url) or DEFAULT_IMG_RE.search(url):
            continue
        return url
    for m in re.finditer(r"<meta[^>]*>", html, re.IGNORECASE):
        tag = m.group(0)
        if "og:image" not in tag.lower():
            continue
        cm = re.search(r'content=["\']([^"\']+)["\']', tag, re.IGNORECASE)
        if cm:
            url = cm.group(1).strip()
            if url and not PLACEHOLDER_RE.search(url) and not DEFAULT_IMG_RE.search(url):
                return url.split()[0]
    return ""


def fetch_move_card_data(code, goods, config):
    """Публичная страница товара: описание + фото товара одним запросом (для накладных)."""
    if not goods.get("path") or not goods.get("name"):
        return "", ""
    url = (
        config["portal_url"]
        + "/shop/"
        + goods["path"].strip("/")
        + "/"
        + goods["name"].strip("/")
        + "/"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", "ignore")
        return extract_public_description(html), extract_product_image(html)
    except Exception:
        return "", ""


def ensure_cards_from_moves(page, base_products, moves, config):
    """Создаёт карточки-заглушки для артикулов из накладных, которых ещё нет в базе.

    «Умный» режим: карточка создаётся один раз (название, фото, описание с публичной
    страницы портала); цена из накладной неизвестна, поэтому карточка скрыта из
    каталога (hidden, price 0) до появления артикула в каталоге продажи — тогда
    merge_sc_items достроит её полными данными (pending снимается, hidden выключается).

    Заглушки с «битым» фото (портал отдал общую картинку index.jpg) пересоздаются
    в следующих прогонах, пока не получится настоящее фото товара.
    """
    known = {p["sku"] for p in base_products if p.get("sku")}
    todo = []
    seen = set()
    for mv in moves:
        # Пропускаем только отменённые/оспоренные/ошибки: карточки создаём и для
        # активных, и для прибывших накладных (товар уже у нас — фото нужно сразу)
        if mv.get("statusCode") in (5, 9, 101, -1):
            continue
        for it in mv.get("items") or []:
            sku = it.get("sku")
            if not sku or sku in seen:
                continue
            seen.add(sku)
            if sku not in known:
                todo.append((sku, it.get("name") or ""))
    refresh_seen = set()
    for p in base_products:
        if not p.get("pending"):
            continue
        # Заглушки перепроверяем каждый прогон: пока артикул не появился в каталоге,
        # уточняем имя/фото (их немного, до десятков — экономия не страдает).
        # После достройки (pending снят) карточка больше не обрабатывается здесь.
        if p["sku"] not in refresh_seen:
            refresh_seen.add(p["sku"])
            todo.append((p["sku"], p.get("name") or ""))
    if not todo:
        print("Карточки из накладных: новых артикулов нет")
        return base_products

    print(f"Карточки из накладных: обработка артикулов {len(todo)} — создаю/обновляю заглушки")
    goods_map = {}
    try:
        goods = fetch_goods_map(page, config, ids=[s for s, _ in todo])
        for g in goods:
            if g.get("code"):
                goods_map.setdefault(g["code"], []).append(g)
    except Exception as e:
        print(f"Карточки из накладных: карта портала недоступна ({e}) — заглушки без фото")

    categories = config.get("categories", [])
    by_code = base_index(base_products)
    created = 0
    refreshed = 0
    for sku, move_name in todo:
        goods_list = goods_map.get(sku) or []
        goods = goods_list[0] if goods_list else {}
        title = (goods.get("title") or "").strip()
        name = clean_product_name(title or move_name) or sku
        desc = (goods.get("description") or "").strip()
        existing = by_code.get(sku)
        # Фото: приоритет — поле photo из API портала (прямое фото товара);
        # страница парсится только ради полного описания, её фото — фолбэк
        img_url = (goods.get("photo") or "").strip()
        if goods:
            page_desc, page_img = fetch_move_card_data(sku, goods, config)
            if page_desc:
                desc = page_desc
            if not img_url:
                img_url = page_img
        img_rel = None
        if img_url:
            # Заглушку перекачиваем принудительно: fetch_image пропускает уже
            # существующие файлы, а старый файл мог быть чужой картинкой
            if existing and existing.get("pending"):
                clean_local_photo_variants(sku)
            img_rel = download_product_photo(sku, img_url, config, page.request)
        category = classify_category(name, categories)
        if existing and existing.get("pending"):
            # Обновляем только если портал отдал хоть какие-то данные: иначе
            # не затираем image_src/фото — следующий прогон попробует снова
            if img_url or goods:
                existing["name"] = name
                existing["category"] = category
                if desc:
                    existing["description"] = desc
                if img_rel:
                    existing["image"] = img_rel
                existing["image_src"] = img_url
                # Заглушка видна в каталоге («нет в наличии»), даже без цены —
                # полные данные достроит merge_sc_items при появлении в продаже
                existing["hidden"] = False
            refreshed += 1
            continue
        card = {
            "id": sku,
            "sku": sku,
            "name": name,
            "category": category,
            "price": 0,
            "partner_price": 0,
            "quantity": 0,
            "image": img_rel or image_for_category(category, categories),
            "status": "out",
            "eta": None,
            "incoming": None,
            "description": desc,
            "stock": {},
            "hidden": False,
            "pending": True,
            "image_src": img_url,
        }
        by_code[sku] = card
        created += 1
    print(f"Карточки из накладных: создано {created}, обновлено фото/имя {refreshed}, всего {len(todo)}")
    return list(by_code.values())


def fetch_public_description(code, goods, config):
    if not goods.get("path") or not goods.get("name"):
        return ""
    url = (
        config["portal_url"]
        + "/shop/"
        + goods["path"].strip("/")
        + "/"
        + goods["name"].strip("/")
        + "/"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", "ignore")
        desc = extract_public_description(html)
        if not desc:
            print(f"Описание {code}: пустой блок .product__text ({url})")
        return desc
    except Exception as e:
        print(f"Описание {code}: страница недоступна ({url}) — {e}")
        return ""


def fetch_goods_map(page, config, ids=None):
    """Карта товаров портала по кодам каталога (точный поиск code=...).

    Постраничный обход неполон: штучные товары (NWA110 и т.п.) в нём
    отсутствуют, но возвращаются по прямому запросу code=<код>.
    """
    if not ids:
        return []
    fields = "id,code,path,name,title,description,photo"
    goods = page.evaluate(
        """async (a) => {
            const out = [];
            for (let i = 0; i < a.codes.length; i += 20) {
                const chunk = a.codes.slice(i, i + 20);
                const res = await Promise.all(chunk.map(async c => {
                    const r = await fetch('/api/v1/shop/goods?fields=' + a.fields + '&code=' + c);
                    if (!r.ok) return [];
                    const d = await r.json();
                    return (d || []).map(g => ({
                        id: g.id,
                        code: g.code || '',
                        path: g.path || '',
                        name: g.name || '',
                        title: (g.title && g.title['ru']) || '',
                        description: (g.description && g.description['ru']) || '',
                        photo: g.photo || ''
                    }));
                }));
                res.forEach(arr => out.push(...arr));
            }
            return out;
        }""",
        {"fields": fields, "codes": ids},
    )
    print(f"Товары портала (API): {len(goods)}")
    with open(GOODS_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(goods, f, ensure_ascii=False, indent=2)
    return goods


def load_existing_descriptions():
    if not os.path.exists(PRODUCTS_PATH):
        return {}
    try:
        with open(PRODUCTS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return {p["sku"]: p.get("description") for p in data.get("products", [])}
    except Exception:
        return {}


def scrape_descriptions(items, goods_map, config):
    """Инкрементально добирает описания товаров (только отсутствующие)."""
    existing = load_existing_descriptions()
    missing = [
        it for it in items
        if it.get("code") and not (existing.get(it["code"]) or "").strip()
    ]
    limit = config.get("desc_limit", 80)
    todo = missing[:limit]
    if not todo:
        print("Описания: все товары уже имеют описания")
        return {}

    api_desc = {
        g["code"]: g["description"]
        for gs in goods_map.values()
        for g in gs
        if g.get("description") and str(g.get("description")).strip()
    }
    new = {}
    done = 0
    for it in todo:
        code = it["code"]
        desc = ""
        for goods in goods_map.get(code, []):
            desc = fetch_public_description(code, goods, config)
            if desc:
                break
        if not desc:
            desc = api_desc.get(code, "")
        if desc:
            new[code] = desc
        done += 1
        if done % 20 == 0:
            print(f"Описания: {done}/{len(todo)}...")
        time.sleep(0.15)
    print(f"Описания: получено {len(new)} из {len(todo)}")
    return new


# ---------------- Остатки по филиалам ----------------
# store-stock.json — производный файл из единой базы (stock по каждому СЦ),
# его читают фронт и админка; формат строк сохранён («В наличии (N шт)»/«Ожидается»).


def write_store_stock(products, config, active_ids=None):
    stock_data = {}
    for p in products:
        for sc_id, qty in (p.get("stock") or {}).items():
            if active_ids and sc_id not in active_ids:
                continue
            qty = int(qty or 0)
            stock_data.setdefault(sc_id, {})[p["id"]] = (
                f"В наличии ({qty} шт)" if qty > 0 else "Ожидается"
            )

    payload = {
        "updated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+03:00"),
        "stock": stock_data,
    }
    with open(STORE_STOCK_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    total = sum(len(v) for v in stock_data.values())
    print(f"Остатки по филиалам: {list(stock_data)} ({total} позиций) -> {STORE_STOCK_PATH}")


def run_parse_store(page, store_config, base_products, full=True):
    """Парсит каталог одного сервис-центра и вливает его в единую базу.

    full=False (умный режим по умолчанию): существующие карточки обновляются только
    по количеству — без перезаписи названий/цен/фото. Описания и карта товаров
    портала запрашиваются только для новых артикулов (их полные данные вносятся
    один раз при создании карточки). Полный прогон — флаг --full."""
    sc_id = store_config["sc_id"]
    print(f"--- Сервис-Центр: {sc_id} (режим: {'полный' if full else 'умный'}) ---")
    login(page, store_config)
    open_shop(page, store_config)
    items = scrape_goods(page, store_config)
    with open(CATALOG_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

    # Описания подтягиваются один раз — только для новых кодов, существующие не трогаем
    known = {p["sku"] for p in base_products}
    new_items = [it for it in items if it.get("code") and it["code"] not in known]
    goods_map = {}
    if new_items:
        try:
            codes = [it["code"] for it in new_items]
            goods = fetch_goods_map(page, store_config, ids=codes)
            for g in goods:
                if g.get("code"):
                    goods_map.setdefault(g["code"], []).append(g)
        except Exception as e:
            print(f"Карта товаров портала: не удалось ({e}) — описания новых карточек пропущены")
        descriptions = scrape_descriptions(new_items, goods_map, store_config)
    else:
        descriptions = {}
        print("Новых товаров нет — карта портала и описания не запрашиваются")

    images = download_images(items, store_config, page.request)
    return merge_sc_items(base_products, items, sc_id, store_config, images, descriptions, full=full)


def main():
    moves_only = "--moves-only" in sys.argv
    # Всегда «умный» режим: существующие карточки обновляются только по количеству,
    # новые артикулы (в любом запуске) создаются с полными данными один раз.
    # Редкий ручной полный прогон (перезапись названий/цен/фото) — флаг --full.
    full = "--full" in sys.argv
    config = load_config()
    try:
        if moves_only:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(
                    user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                    viewport={"width": 1440, "height": 900},
                )
                page = context.new_page()
                store_config = build_store_config(config, get_stores(config)[0])
                login(page, store_config)
                moves = scrape_moves(page, store_config)
                write_moves(moves)
                # Карточки для артикулов накладных создаются и в режиме «только поступления»
                base_products = load_base_products()
                base_products = ensure_cards_from_moves(page, base_products, moves, store_config)
                write_products(base_products, active_store_ids(config))
                browser.close()
            return
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                viewport={"width": 1440, "height": 900},
            )
            page = context.new_page()
            stores = get_stores(config)
            central = config.get("central_store_id", "s240534")
            active_ids = active_store_ids(config)
            base_products = load_base_products()
            print(f"База товаров: {len(base_products)} карточек, режим: {'полный' if full else 'умный'}, СЦ: {[s['id'] for s in stores]}")
            # Полный каталог портала: карточки для всех артикулов создаются
            # один раз и дальше только досоздаются (лёгкий API-проход)
            try:
                goods_all = fetch_all_goods(config)
                base_products = ensure_full_catalog(base_products, goods_all, config)
            except Exception as e:
                print(f"Каталог портала: не удалось ({e}) — продолжаем без него")
            for store in stores:
                store_config = build_store_config(config, store)
                base_products = run_parse_store(page, store_config, base_products, full=full)
                if store.get("id") == central:
                    # Пауза между этапами (каталог → накладные) — случайная,
                    # чтобы прогон не выглядел как робот для защиты портала
                    time.sleep(random.uniform(5, 15))
                    try:
                        moves = scrape_moves(page, store_config)
                        write_moves(moves)
                        # Карточки-заглушки для артикулов накладных, которых нет в каталоге:
                        # фото/имя появляются в «Поставках» сразу, цена достроится при
                        # появлении артикула в каталоге продажи (pending в merge_sc_items)
                        base_products = ensure_cards_from_moves(page, base_products, moves, store_config)
                    except Exception as e:
                        print(f"Перемещения товаров: не удалось ({e}) — продолжаем без них")
            write_products(base_products, active_ids)
            write_store_stock(base_products, config, active_ids)
            browser.close()
    except FileNotFoundError as e:
        print(e)
        print("Установите: pip install -r requirements.txt && python -m playwright install chromium")
        sys.exit(1)
    except RuntimeError as e:
        print(f"Ошибка: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
