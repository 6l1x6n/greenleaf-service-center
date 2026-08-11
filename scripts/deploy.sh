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

SESSIONS=$(pgrep -f "opencode" | wc -l | tr -d ' ')
if [ "$SESSIONS" -gt 1 ]; then
  echo "⚠️ ВНИМАНИЕ: запущено $SESSIONS процессов opencode."
  echo "   Вторая сессия может деплоить старый код. Лучше закрыть её."
fi

echo "🚀 Деплой mygreenleaf (блокировка: $LOCK_DIR)..."
npx wrangler deploy "$@"
echo "✅ Готово."
