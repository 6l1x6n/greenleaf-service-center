import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime

from playwright.sync_api import sync_playwright

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
PRODUCTS_PATH = os.path.join(ROOT_DIR, "public", "data", "products.json")
MOVES_PATH = os.path.join(ROOT_DIR, "public", "data", "moves.json")
CATALOG_CACHE_PATH = os.path.join(ROOT_DIR, "scripts", "parser", ".catalog_cache.json")

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
    return config


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
            except Exception:
                pass

        show_more = page.query_selector('a:has-text("Показать еще...")')
        if not show_more or not show_more.is_visible():
            break

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
    url = config["portal_url"] + "/do.vshow#admin/shop/move?action=show&move=" + mv["number"]
    try:
        page.goto(url, timeout=30000)
        time.sleep(2.5)
    except Exception as e:
        print(f"Не удалось открыть накладную {mv['number']}: {e}")
        return []
    try:
        os.makedirs(DIAG_DIR, exist_ok=True)
        with open(os.path.join(DIAG_DIR, f"move_{mv['number']}.html"), "w", encoding="utf-8") as f:
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


def build_products(items, config, images=None):
    categories = config.get("categories", [])
    low_threshold = config.get("low_threshold", 6)
    multiplier = config.get("price_multiplier", 2)
    images = images or {}
    products = []
    for it in items:
        if not it["name"]:
            continue
        category = classify_category(it["name"], categories)
        products.append({
            "id": it["code"],
            "sku": it["code"],
            "name": it["name"],
            "category": category,
            "price": round(it["sale_price"] * multiplier),
            "partner_price": round(it["sale_price"]),
            "quantity": it["quantity"],
            "image": images.get(it["code"]) or image_for_category(category, categories),
            "status": status_from_qty(it["quantity"], low_threshold),
            "eta": None,
            "incoming": None,
        })
    return products


def write_products(products):
    payload = {
        "updated": datetime.now().strftime("%Y-%m-%dT%H:%M:%S+03:00"),
        "products": products,
    }
    with open(PRODUCTS_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Сохранено товаров: {len(products)} -> {PRODUCTS_PATH}")


def main():
    images_only = "--images-only" in sys.argv
    moves_only = "--moves-only" in sys.argv
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
                login(page, config)
                moves = scrape_moves(page, config)
                write_moves(moves)
                browser.close()
            return
        if images_only:
            with open(CATALOG_CACHE_PATH, encoding="utf-8") as f:
                items = json.load(f)
            print(f"Каталог из кэша: {len(items)} позиций")
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context(
                    user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                    viewport={"width": 1440, "height": 900},
                )
                page = context.new_page()
                login(page, config)
                images = download_images(items, config, page.request)
                products = build_products(items, config, images)
                write_products(products)
                browser.close()
            return
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
                viewport={"width": 1440, "height": 900},
            )
            page = context.new_page()
            login(page, config)
            open_shop(page, config)
            items = scrape_goods(page, config)
            with open(CATALOG_CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(items, f, ensure_ascii=False, indent=2)
            images = download_images(items, config, page.request)
            products = build_products(items, config, images)
            write_products(products)
            try:
                moves = scrape_moves(page, config)
                write_moves(moves)
            except Exception as e:
                print(f"Перемещения товаров: не удалось ({e}) — продолжаем без них")
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
