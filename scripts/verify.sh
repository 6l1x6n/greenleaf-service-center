#!/usr/bin/env bash
# Проверка продакшена после деплоя: новый ли билд, отдаётся ли виртуальный
# /data/products.json с оверрайдами (бейджи), кешируются ли данные.
# Использование: bash scripts/verify.sh [URL]  (по умолчанию mygreenleaf.postalarchive.workers.dev)
set -uo pipefail

SITE="${1:-https://mygreenleaf.postalarchive.workers.dev}"
FAIL=0

echo "🔎 Проверка: $SITE"

# 1. Маркер нового билда на любом API-ответе
HDR=$(curl -s -D - -o /dev/null "$SITE/api/stores" | tr -d '\r' | grep -i '^x-greenleaf-build:' | awk '{print $2}' | tr -d ' ')
if [ "$HDR" = "v2" ]; then
  echo "✅ Воркер: новый билд (x-greenleaf-build: v2)"
else
  echo "❌ Воркер: СТАРЫЙ билд — деплой зашёл из устаревшей копии, бейджи не показываются." >&2
  FAIL=1
fi

# 2. Виртуальный каталог с оверрайдами
PROD=$(curl -s "$SITE/data/products.json")
echo "$PROD" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception as e:
    print('❌ /data/products.json не JSON:', e); sys.exit(1)
ov=d.get('overrides') or {}
ps=[p for p in d.get('products',[]) if p.get('priority') not in (None,'',0)]
print(f'✅ products.json виртуальный: товаров {len(d.get(\"products\",[]))}, оверрайдов {len(ov)}, бейджей {len(ps)}')
for p in ps[:6]:
    print('   ', p['id'], 'priority', p.get('priority'))
if not ps:
    print('❌ Нет товаров с priority — бейджи не отображаются'); sys.exit(1)
" || FAIL=1

# 3. База товаров на месте
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$SITE/data/products.base.json")
if [ "$CODE" = "200" ]; then
  echo "✅ products.base.json отдаётся (200)"
else
  echo "❌ products.base.json: HTTP $CODE — базы нет в ассетах" >&2
  FAIL=1
fi

# 4. Кеширование каталога
CC=$(curl -sI "$SITE/data/products.json" | tr -d '\r' | grep -i '^cache-control:' | head -1 | sed 's/^[Cc]ache-[Cc]ontrol: *//')
echo "$CC" | grep -q 'max-age=60' && echo "✅ Кеш каталога: $CC" || { echo "⚠️ Кеш каталога не установлен: ${CC:-нет}"; }

if [ "$FAIL" -ne 0 ]; then
  echo "❌ Проверка не пройдена — смотрите ошибки выше."
  exit 1
fi
echo "✅ Всё в порядке."
