#!/usr/bin/env python3
"""Генерация лёгких превью товаров: <файл>_card.webp (600px по большей стороне).

Зачем: в карточку каталога раньше подставлялся полный файл товара — от 60 КБ
до 18 МБ (PNG с прозрачностью). Страница каталога на 100 товаров тянула
~35 МБ картинок, на мобильном интернете каталог не открывался.

Превью (WebP, 600px) весит 10–30 КБ и не меняет качество на экране: карточка
показывает фото ~96px, модалка — до 600px.

Запуск:  python3 scripts/parser/make_thumbs.py [--limit N] [--force]
"""
import argparse
import os
import sys
from concurrent.futures import ProcessPoolExecutor

from PIL import Image

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMAGES_DIR = os.path.join(ROOT_DIR, "public", "assets", "images", "products")
CARD_EDGE = 600
QUALITY = 74
EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp")


def thumb_path(path):
    return os.path.splitext(path)[0] + "_card.webp"


def make_thumb(path):
    """Создать превью для одного файла. Возвращает (путь, размер_байт) или None."""
    out = thumb_path(path)
    try:
        with Image.open(path) as img:
            img.load()
            img.info.clear()
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGB")
            w, h = img.size
            scale = min(1.0, CARD_EDGE / float(max(w, h)))
            if scale < 1.0:
                img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
            img.save(out, "WEBP", quality=QUALITY, method=4)
        return out
    except Exception as e:
        return "%s: %s" % (os.path.basename(path), e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="ограничить количество файлов")
    ap.add_argument("--force", action="store_true", help="пересоздавать существующие превью")
    args = ap.parse_args()

    if not os.path.isdir(IMAGES_DIR):
        print("Каталог фото не найден:", IMAGES_DIR)
        return 1

    files = sorted(
        os.path.join(IMAGES_DIR, f)
        for f in os.listdir(IMAGES_DIR)
        if f.lower().endswith(EXTS) and not f.lower().endswith("_card.webp")
    )
    if args.limit:
        files = files[: args.limit]
    if not args.force:
        files = [f for f in files if not os.path.exists(thumb_path(f))]

    if not files:
        print("Превью уже актуальны — нечего делать")
        return 0

    print(f"Файлов к обработке: {len(files)}")
    done = 0
    errors = []
    with ProcessPoolExecutor(max_workers=max(1, (os.cpu_count() or 4) - 1)) as pool:
        for res in pool.map(make_thumb, files, chunksize=16):
            done += 1
            if res and res.endswith(".webp"):
                pass
            elif res:
                errors.append(res)
            if done % 250 == 0:
                print(f"  {done}/{len(files)}")
    print(f"Готово: {done}, ошибок: {len(errors)}")
    for e in errors[:10]:
        print("  ⚠️", e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
