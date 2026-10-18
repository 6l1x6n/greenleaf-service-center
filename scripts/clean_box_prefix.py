#!/usr/bin/env python3
"""Разовая чистка названий в public/data/products.base.json.

Портал отдаёт часть карточек со складской приставкой в названии:
«(Кол-во в коробке 24 шт) Карточка», «(Коробка 40 шт) …» и их опечатки
(«Корбока», «каробке», «Кол-во в коробе»). Для клиента это служебный шум.

Правило парсера (BOX_PREFIX_RE) такие приставки уже срезает при создании
карточки из каталога продажи, но карточки «всего портала» пишутся сырым
заголовком — отсюда 3,7 тыс. грязных имён в базе. Скрипт приводит базу к тому
виду, который теперь даёт парсер.

Если у карточки-коробки есть «чистый двойник» и она без цены, она прячется:
клиент видит один товар, а не две одинаковые строки. В кабинете обе остаются.

  python3 scripts/clean_box_prefix.py --dry-run   # только отчёт
  python3 scripts/clean_box_prefix.py             # почистить и записать
"""

import argparse
import json
import os
import re

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCTS_PATH = os.path.join(ROOT_DIR, "public", "data", "products.base.json")

# Копия BOX_PREFIX_RE из scripts/parser/parser.py (приставка без скобок или с ними)
BOX_PREFIX_RE = re.compile(
    r"""^[\s()]*
        (?:Кол[-\s]?во?\s+)?
        (?:в\s+)?коробк[аеиу]
        \s*[:\.]?\s*\d+\s*шт\.?\s*[\)\.:,]?\s*""",
    re.IGNORECASE | re.VERBOSE,
)

# Приставка целиком в скобках, включая опечатки: «(Корбока 20 шт)»,
# «(100 шт в коробке)», «(24 шт коробка)». Внутри обязательно слово про коробку —
# поэтому «(Целый 1 шт)» не трогаем.
LEAD_GROUP_RE = re.compile(r"^\s*\(([^)]{1,45})\)\s*")
BOX_WORD_RE = re.compile(r"короб|корб|кароб|карб", re.IGNORECASE)


def clean_name(raw):
    name = str(raw or "").replace("&nbsp;", " ")
    name = re.sub(r"\s+", " ", name).strip()
    name = BOX_PREFIX_RE.sub("", name).strip()
    lead = LEAD_GROUP_RE.match(name)
    if lead and BOX_WORD_RE.search(lead.group(1)):
        name = name[lead.end():].strip()
    name = re.sub(r"^[\s)]+", "", name).strip()
    return name or str(raw or "")


def extract_pack(raw):
    """Сколько штук в коробке — из служебной приставки (0 — приставки нет)."""
    name = str(raw or "")
    m = BOX_PREFIX_RE.match(name)
    if m:
        num = re.search(r"\d+", m.group(0))
        return int(num.group(0)) if num else 0
    lead = LEAD_GROUP_RE.match(name)
    if lead and BOX_WORD_RE.search(lead.group(1)):
        num = re.search(r"\d+", lead.group(1))
        return int(num.group(0)) if num else 0
    return 0


def normalize(name):
    return re.sub(r"\s+", " ", str(name or "")).strip().lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="только отчёт, файл не меняется")
    args = ap.parse_args()

    with open(PRODUCTS_PATH, encoding="utf-8") as f:
        payload = json.load(f)
    products = payload["products"]

    # Чистые имена до правки — по ним ищем двойников
    clean_names = {}
    for p in products:
        n = str(p.get("name") or "")
        if clean_name(n) == n:
            clean_names.setdefault(normalize(n), []).append(p)

    renamed = 0
    packed = 0
    hidden = 0
    samples = []
    for p in products:
        raw = str(p.get("name") or "")
        new = clean_name(raw)
        # Число штук в коробке не теряем: приставка уходит из названия,
        # значение остаётся полем pack (склад/кабинет)
        pack = extract_pack(raw)
        if pack and not (p.get("pack") or 0):
            packed += 1
            if not args.dry_run:
                p["pack"] = pack
        if new == raw:
            continue
        renamed += 1
        if len(samples) < 8:
            samples.append((raw, new))
        if not args.dry_run:
            p["name"] = new
        # Двойник с чистым именем и без цены — прячем карточку-коробку,
        # чтобы клиент не видел две одинаковые строки
        twins = clean_names.get(normalize(new)) or []
        if twins and not (p.get("price") or 0) and not p.get("hidden"):
            hidden += 1
            if not args.dry_run:
                p["hidden"] = True

    total = len(products)
    print(f"Товаров: {total}")
    print(f"Переименовано: {renamed}")
    print(f"Сохранено число в коробке (pack): {packed}")
    print(f"Скрыто как дубли коробок: {hidden}")
    print("\nПримеры:")
    for raw, new in samples:
        print(f"  было:  {raw[:78]}")
        print(f"  стало: {new[:78]}")

    if args.dry_run:
        print("\nХолостой прогон: файл не изменён.")
        return

    with open(PRODUCTS_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"\nЗаписано: {PRODUCTS_PATH}")


if __name__ == "__main__":
    main()
