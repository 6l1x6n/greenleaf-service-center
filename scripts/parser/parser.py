import json
import os
from datetime import date

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
PRODUCTS_PATH = os.path.join(ROOT_DIR, "data", "products.json")


def load_config():
    path = os.path.join(BASE_DIR, "config.json")
    if not os.path.exists(path):
        raise FileNotFoundError(
            "Нет config.json. Скопируйте config.example.json: cp config.example.json config.json"
        )
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def login(session, portal_url, login, password):
    raise NotImplementedError("Логика входа в портал — опишите по вашему MD-доку")


def fetch_products(session):
    raise NotImplementedError("Логика парсинга каталога и наличия — опишите по вашему MD-доку")


def normalize(product):
    return {
        "id": product["id"],
        "sku": product.get("sku", product["id"]),
        "name": product["name"],
        "category": product.get("category", "Прочее"),
        "price": product.get("price", 0),
        "image": product.get("image", ""),
        "status": product.get("status", "out"),
        "eta": product.get("eta"),
        "incoming": product.get("incoming"),
    }


def write_products(products):
    payload = {
        "updated": date.today().strftime("%Y-%m-%dT%H:%M:%S+03:00"),
        "products": [normalize(p) for p in products],
    }
    with open(PRODUCTS_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Сохранено товаров: {len(payload['products'])} -> {PRODUCTS_PATH}")


def main():
    config = load_config()
    portal_url = config["portal_url"]
    login_ = config.get("login")
    password = config.get("password")
    session = login(None, portal_url, login_, password)
    products = fetch_products(session)
    write_products(products)


if __name__ == "__main__":
    main()
