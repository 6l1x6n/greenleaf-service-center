import json
import os
import re
import sys
import time
from datetime import datetime

from playwright.sync_api import sync_playwright

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
PRODUCTS_PATH = os.path.join(ROOT_DIR, "public", "data", "products.json")

PRODUCT_CODE_STRICT_RE = re.compile(r"^[A-Z]{3}\d{3}$")
BOX_PREFIX_RE = re.compile(
    r"""^[\s()]*
        (?:Кол[-\s]?во?\s+)?
        (?:в\s+)?коробк[аеиу]
        \s*[:\.]?\s*\d+\s*шт\.?\s*[\)\.:,]?\s*""",
    re.IGNORECASE | re.VERBOSE,
)
AVAILABLE_QTY_RE = re.compile(r"Доступно для продажи:\s*(\d+)")


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
            f.write("URL: " + page.url + "\n\n" + page.inner_text("body")[:1500])
    except Exception:
        pass
    print(f"Диагностика сохранена: {path}")


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
    if not login_ or not password:
        raise RuntimeError("Учетные данные не настроены (config.json или SC_LOGIN/SC_PASSWORD)")

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
    try:
        page.wait_for_selector('a[href="#admin/shop/buy"]', state="attached", timeout=30000)
        page.click('a[href="#admin/shop/buy"]', timeout=15000)
    except Exception:
        try:
            page.click('a:has-text("Новая продажа")', timeout=15000)
        except Exception:
            page.goto(config["portal_url"] + "/do.vshow#admin/shop/buy", timeout=30000)
    time.sleep(2)


def enter_partner(page, config):
    try:
        page.wait_for_selector('input[check_query="login_buy"]', state="attached", timeout=30000)
        page.fill('input[check_query="login_buy"]', config["partner_login"])
        deadline = time.time() + 20
        while time.time() < deadline:
            if page.locator('text="Не найдено"').count() > 0:
                return False
            if page.locator('input[type="submit"][value="Далее"]:not([disabled])').count() > 0:
                break
            time.sleep(0.5)
        else:
            return False
        page.click('input[type="submit"][value="Далее"]', timeout=15000)
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
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
            if attempt >= 3:
                raise RuntimeError("Не удалось получить каталог поставщика")
            continue
        try:
            page.wait_for_selector('input[name="query"]', state="visible", timeout=30000)
        except Exception:
            if attempt >= 3:
                raise RuntimeError("Не удалось получить каталог поставщика")
            continue
        rows = wait_goods_rows(page)
        if rows:
            break

    if not rows:
        raise RuntimeError("Не удалось получить каталог поставщика")

    all_items = []
    skipped_codes = []
    max_pages = config.get("max_pages", 200)

    for _ in range(max_pages):
        rows = find_goods_rows(page)
        if not rows:
            break

        for row in rows:
            try:
                parsed = parse_row(row.inner_html())
                if parsed:
                    all_items.append(parsed)
                    if parsed.get("skipped"):
                        skipped_codes.append(parsed["code"])
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

    print(f"Каталог получен: {len(all_items)} позиций")
    if skipped_codes:
        print(f"Пропущено позиций (код не формата ABC123): {len(skipped_codes)}")

    return [it for it in all_items if not it.get("skipped")]


def classify_category(name, categories):
    lower = name.lower()
    for cat in categories:
        for keyword in cat.get("keywords", []):
            if keyword.lower() in lower:
                return cat["name"]
    return "Прочее"


def image_for_category(name, categories):
    for cat in categories:
        if cat["name"] == name:
            return cat.get("image", "assets/images/products/placeholder.svg")
    return "assets/images/products/placeholder.svg"


def status_from_qty(qty, low_threshold):
    if qty >= low_threshold:
        return "in_stock"
    if qty >= 1:
        return "low"
    return "out"


def build_products(items, config):
    categories = config.get("categories", [])
    low_threshold = config.get("low_threshold", 6)
    multiplier = config.get("price_multiplier", 2)
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
            "image": image_for_category(category, categories),
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
    config = load_config()
    try:
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
            browser.close()
    except FileNotFoundError as e:
        print(e)
        print("Установите: pip install -r requirements.txt && python -m playwright install chromium")
        sys.exit(1)
    except RuntimeError as e:
        print(f"Ошибка: {e}")
        sys.exit(1)

    products = build_products(items, config)
    write_products(products)


if __name__ == "__main__":
    main()
