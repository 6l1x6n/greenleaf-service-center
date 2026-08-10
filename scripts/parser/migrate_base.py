#!/usr/bin/env python3
"""Одноразовая миграция каталога в единую базу товаров (карточки по коду SKU).

Старый формат: products.json с одним полем quantity (центральный филиал)
и store-stock.json с текстовыми остатками по филиалам.
Новый формат: products.json — постоянная база, у каждой карточки поле
stock: {id филиала: количество}. Описания и прочие поля сохраняются.

Запуск: python3 scripts/parser/migrate_base.py
"""
import json
import os
import re

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
PRODUCTS_PATH = os.path.join(ROOT_DIR, "public", "data", "products.json")
STORE_STOCK_PATH = os.path.join(ROOT_DIR, "public", "data", "store-stock.json")

QTY_RE = re.compile(r"В наличии\s*\(\s*(\d+)\s*шт\s*\)")


def parse_stock_text(text):
    if not text:
        return 0
    m = QTY_RE.search(str(text))
    if m:
        return int(m.group(1))
    return 0


def main():
    with open(PRODUCTS_PATH, encoding="utf-8") as f:
        data = json.load(f)
    products = data.get("products") or []
    print(f"Товаров в старом products.json: {len(products)}")

    stock_data = {}
    if os.path.exists(STORE_STOCK_PATH):
        try:
            with open(STORE_STOCK_PATH, encoding="utf-8") as f:
                stock_data = (json.load(f).get("stock") or {})
        except Exception as e:
            print(f"store-stock.json не прочитан ({e}) — берём только quantity")
    print(f"Филиалов в store-stock.json: {list(stock_data)}")

    with_stock = 0
    for p in products:
        p.setdefault("description", "")
        p.setdefault("eta", None)
        p.setdefault("incoming", None)
        stock = {}
        for sc_id, by_code in stock_data.items():
            if p.get("sku") in by_code:
                stock[sc_id] = parse_stock_text(by_code[p["sku"]])
        if not stock and p.get("quantity") is not None:
            stock = {"s240534": int(p.get("quantity") or 0)}
        p["stock"] = stock
        if stock:
            with_stock += 1

    payload = {
        "updated": data.get("updated", ""),
        "products": products,
    }
    with open(PRODUCTS_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"Миграция завершена: {len(products)} карточек, с остатками: {with_stock} -> {PRODUCTS_PATH}")


if __name__ == "__main__":
    main()
