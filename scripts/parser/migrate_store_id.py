#!/usr/bin/env python3
"""Миграция: id филиала sc-astana -> s240534 (код личного кабинета портала).

Переименование ключей в products.json (stock), store-stock.json (stock) и
stores.json (id). config.json переименовывается вручную.

Запуск: python3 scripts/parser/migrate_store_id.py
"""
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
DATA_DIR = os.path.join(ROOT_DIR, "public", "data")

OLD = "sc-astana"
NEW = "s240534"

FILES = ["products.json", "store-stock.json", "stores.json"]


def rename_keys(obj):
    if isinstance(obj, dict):
        return {
            (NEW if k == OLD else k): rename_keys(v) for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [rename_keys(v) for v in obj]
    return obj


def rename_store_ids(obj):
    """stores.json: массив карточек, переименовываем значение поля id."""
    if isinstance(obj, list):
        return [rename_store_ids(v) for v in obj]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "id" and v == OLD:
                out[k] = NEW
            elif k == "id" and isinstance(v, str) and v.startswith(OLD + "-"):
                out[k] = NEW + v[len(OLD):]
            else:
                out[k] = rename_store_ids(v)
        return out
    return obj


def main():
    for name in FILES:
        path = os.path.join(DATA_DIR, name)
        if not os.path.exists(path):
            print(f"Пропущено (нет файла): {name}")
            continue
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        new_data = rename_store_ids(data) if name == "stores.json" else rename_keys(data)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(new_data, f, ensure_ascii=False, indent=2)
        print(f"Переименовано: {name}")

    with open(os.path.join(DATA_DIR, "stores.json"), encoding="utf-8") as f:
        stores = json.load(f)
    astana = [s for s in stores if s["id"] == NEW]
    if astana:
        print(f"Карточка филиала {NEW}: {astana[0]['name']} / {astana[0]['address']}")
    print("Готово. Не забудьте: central_store_id в config.json -> " + NEW)


if __name__ == "__main__":
    main()
