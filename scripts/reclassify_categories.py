#!/usr/bin/env python3
"""Разовая переклассификация категорий в public/data/products.base.json.

Правила ровно те же, что у парсера (та же функция сопоставления и тот же
словарь из scripts/parser/config.json), поэтому после прогона база и будущие
прогоны парсера не расходятся.

  python3 scripts/reclassify_categories.py --dry-run   # только отчёт, файл не трогает
  python3 scripts/reclassify_categories.py             # переклассифицировать и записать

Остаток «Прочее» выгружается в scripts/parser/diag/uncertain_categories.json —
это позиции, где ключевых слов не хватило; их правят вручную в кабинете.
"""

import argparse
import collections
import json
import os
import re
import sys

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCTS_PATH = os.path.join(ROOT_DIR, "public", "data", "products.base.json")
CONFIG_PATHS = (
    os.path.join(ROOT_DIR, "scripts", "parser", "config.json"),
    os.path.join(ROOT_DIR, "scripts", "parser", "config.example.json"),
)
UNCERTAIN_PATH = os.path.join(ROOT_DIR, "scripts", "parser", "diag", "uncertain_categories.json")

NOISE_WORDS = {
    "коробке", "коробка", "коробки", "каробке", "версия", "русская", "английская",
    "языках", "greenleaf", "цвета", "цвет", "размер", "материал", "набор", "упаковка",
    "штук", "лист", "комплект", "обновленная", "обновлённая", "серии", "серия",
    "мужские", "женские", "мужской", "женский", "мужское", "детские", "детский",
    "черные", "черный", "белые", "белый", "синие", "синий", "серые", "серый",
    "розовые", "розовый", "зеленый", "зелёный", "красный", "pink", "black",
    "большой", "большая", "маленький", "средний", "модные", "модная", "яркие",
    "стиль", "спортивный", "спортивная", "повседневный", "деловой", "летние",
    "длинные", "длиной", "одна", "пары", "пара", "штуки",
}


def load_categories():
    for path in CONFIG_PATHS:
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                return json.load(f).get("categories", []), path
    sys.exit("Не найден scripts/parser/config.json")


def classify_category(name, categories):
    """Копия parser.classify_category: слово начинается с ключевого слова."""
    lower = (name or "").lower()
    for cat in categories:
        for keyword in cat.get("keywords", []):
            kw = keyword.lower()
            if re.search(r"(?<![a-zа-яё0-9])" + re.escape(kw), lower):
                return cat["name"]
    return "Прочее"


def top_tokens(products, limit):
    counter = collections.Counter()
    for p in products:
        for word in re.findall(r"[a-zа-яё]+", (p.get("name") or "").lower()):
            if len(word) >= 4 and word not in NOISE_WORDS:
                counter[word] += 1
    return counter.most_common(limit)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="только отчёт, файл не меняется")
    ap.add_argument("--tokens", type=int, default=40, help="сколько частых слов показать у остатка")
    args = ap.parse_args()

    categories, cfg_path = load_categories()
    known = {c["name"] for c in categories}

    with open(PRODUCTS_PATH, encoding="utf-8") as f:
        payload = json.load(f)
    products = payload["products"]

    before = collections.Counter(p.get("category", "Прочее") for p in products)
    after = collections.Counter()
    moved = collections.Counter()
    uncertain = []
    untouched = []

    for p in products:
        current = p.get("category", "Прочее")
        # Категория, которой нет в словаре, поставлена вручную — не переписываем
        if current != "Прочее" and current not in known:
            after[current] += 1
            untouched.append(p)
            continue
        new = classify_category(p.get("name", ""), categories)
        after[new] += 1
        if new == "Прочее":
            uncertain.append({"id": p.get("id"), "sku": p.get("sku"), "name": p.get("name")})
        if new != current:
            moved[(current, new)] += 1
            if not args.dry_run:
                p["category"] = new

    total = len(products)
    other = after.get("Прочее", 0)
    print(f"Словарь: {cfg_path}")
    print(f"Товаров: {total}\n")
    print("Категория                          было  стало")
    for name in sorted(set(before) | set(after), key=lambda n: (-after[n], n)):
        mark = "  <-- Прочее" if name == "Прочее" else ""
        print(f"  {name:<32}{before[name]:>6}{after[name]:>7}{mark}")
    print(f"\n«Прочее»: {other} из {total} ({other / total * 100:.1f}%), ориентир < 10%")

    if moved:
        print("\nПереходы (было -> стало):")
        for (src, dst), count in moved.most_common():
            print(f"  {src} -> {dst}: {count}")

    if untouched:
        print(f"\nКатегории мимо словаря (не трогали): {len(untouched)}")

    if uncertain:
        print(f"\nОсталось в «Прочее»: {len(uncertain)}. Частые слова:")
        for word, count in top_tokens(uncertain, args.tokens):
            print(f"  {count:5d}  {word}")

    if args.dry_run:
        print("\nХолостой прогон: файл не изменён.")
        return

    os.makedirs(os.path.dirname(UNCERTAIN_PATH), exist_ok=True)
    with open(UNCERTAIN_PATH, "w", encoding="utf-8") as f:
        json.dump(uncertain, f, ensure_ascii=False, indent=2)

    with open(PRODUCTS_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"\nЗаписано: {PRODUCTS_PATH}")
    print(f"Остаток «Прочее» выгружен: {UNCERTAIN_PATH}")


if __name__ == "__main__":
    main()
