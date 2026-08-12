#!/usr/bin/env bash
# Деплой Worker Greenleaf с защитой от параллельных деплоев.
# Использовать только этот скрипт: ./scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

LOCK_DIR=".deploy-lock"
LOCK_FILE="$LOCK_DIR/pid"

if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "❌ Уже идёт другой деплой (PID $OLD_PID). Отменяюсь — дождитесь завершения." >&2
    exit 1
  fi
  echo "⚠️ Найдена устаревшая блокировка — снимаю (предыдущий деплой, вероятно, упал)."
  rm -rf "$LOCK_DIR"
fi

mkdir -p "$LOCK_DIR"
echo "$$" > "$LOCK_FILE"
trap 'rm -rf "$LOCK_DIR"' EXIT

SESSIONS=$(pgrep -f "opencode" 2>/dev/null || true | wc -l | tr -d ' ')
if [ "$SESSIONS" -gt 1 ]; then
  echo "⚠️ ВНИМАНИЕ: запущено $SESSIONS процессов opencode."
  echo "   Вторая сессия может деплоить старый код. Лучше закрыть её."
fi

# Гард от деплоя из устаревшей рабочей копии: такой деплой затирает
# продакшен старым билдом (пропадают бейджи/оверрайды товаров).
if ! grep -q "handleProductsJson" worker.js; then
  echo "❌ worker.js не содержит handleProductsJson — это старая версия кода." >&2
  echo "   Выполните git pull (и обновите копию на машине, которая делает деплой после парсинга)." >&2
  exit 1
fi
if [ ! -f public/data/products.base.json ]; then
  echo "❌ Нет public/data/products.base.json — база товаров старая (products.json)." >&2
  exit 1
fi
echo "✅ Гард версии пройден: worker.js v2 + products.base.json"

# Гард от деплоя из копии, отстающей от origin/main: авто-деплой по пушам
# (и парсер раз в 3 часа) перезальёт origin/main поверх любого ручного деплоя.
# Правильный флоу: git push → GitHub Actions деплоит ровно git HEAD.
git fetch origin main --quiet 2>/dev/null || true
LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "")
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
  echo "❌ Локальная main ($(echo $LOCAL | cut -c1-8)) ≠ origin/main ($(echo $REMOTE | cut -c1-8))." >&2
  echo "   Деплой вручную затирается авто-деплоем — запушите изменения: git push, затем deploy через GitHub Actions." >&2
  exit 1
fi
echo "✅ main совпадает с origin/main — деплой не будет перезатёрт"

# Маркер версии на сайте: /version.json отдаёт задеплоенный коммит
if [ -n "$LOCAL" ]; then
  echo "{\"commit\":\"$LOCAL\",\"short\":\"$(echo $LOCAL | cut -c1-8)\",\"deployedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > public/version.json
  echo "✅ version.json: $(echo $LOCAL | cut -c1-8)"
fi

echo "🚀 Деплой mygreenleaf (блокировка: $LOCK_DIR)..."
npx wrangler deploy "$@"
echo "✅ Готово."

# Пост-деплой проверка: убеждаемся, что на продакшене новый билд
if [ -f scripts/verify.sh ]; then
  echo "🔎 Проверка продакшена..."
  bash scripts/verify.sh || echo "⚠️ Внимание: проверка продакшена не пройдена — проверьте вручную."
fi
