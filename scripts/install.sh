#!/usr/bin/env bash
# Установка и обновление бота на сервере.
# Запуск:
#   curl -fsSL <raw-url>/scripts/install.sh | BOT_TOKEN=... ADMIN_IDS=... bash
# Повторный запуск обновляет код и перезапускает бота, база и .env не трогаются.
set -euo pipefail

REPO_URL=${REPO_URL:-https://github.com/raafatel-lab/app.git}
BRANCH=${BRANCH:-claude/telegram-shop-bot-zziqdy}
APP_DIR=${APP_DIR:-/var/www/app}
APP_NAME=${APP_NAME:-shop-bot}

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || fail "запусти от root (или через sudo)"

log "Пакеты"
export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null || apt-get update -qq && apt-get install -y -qq curl git ca-certificates

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then
  log "Ставлю Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
command -v pm2 >/dev/null 2>&1 || { log "Ставлю pm2"; npm install -g pm2; }
echo "node $(node -v), npm $(npm -v), pm2 $(pm2 -v)"

log "Код"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
  echo "обновлено до $(git -C "$APP_DIR" log --oneline -1)"
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
mkdir -p data

log "Настройки"
if [ -f .env ]; then
  echo ".env уже есть — оставляю как есть (правь руками: nano $APP_DIR/.env)"
else
  [ -n "${BOT_TOKEN:-}" ] || fail "нет .env и не передан BOT_TOKEN"
  [ -n "${ADMIN_IDS:-}" ] || fail "нет .env и не передан ADMIN_IDS (твой Telegram ID)"
  umask 077
  cat > .env <<EOF
BOT_TOKEN=${BOT_TOKEN}
ADMIN_IDS=${ADMIN_IDS}
BOT_MODE=polling
CURRENCY=${CURRENCY:-RUB}
CURRENCY_SYMBOL=${CURRENCY_SYMBOL:-₽}
MIN_TOPUP=${MIN_TOPUP:-100}
MAX_TOPUP=${MAX_TOPUP:-100000}
DB_PATH=data/shop.db
PORT=${PORT:-3000}
CRYPTO_PAY_TOKEN=${CRYPTO_PAY_TOKEN:-}
CRYPTO_PAY_API_URL=https://pay.crypt.bot/api
CRYPTO_PAY_ASSETS=${CRYPTO_PAY_ASSETS:-USDT,TON}
PUBLIC_URL=${PUBLIC_URL:-}
MANUAL_CRYPTO=0
EOF
  chmod 600 .env
  echo ".env создан"
fi

log "Зависимости"
npm ci --omit=dev

log "Запуск"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 reload "$APP_NAME" --update-env
else
  pm2 start src/index.js --name "$APP_NAME" --time
fi
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

sleep 5
log "Проверка"
pm2 ls
if curl -fsS --max-time 10 "http://127.0.0.1:${PORT:-3000}/health" >/dev/null; then
  echo "HTTP-сервер отвечает"
else
  echo "HTTP-сервер не ответил — смотри логи"
fi

echo
pm2 logs "$APP_NAME" --lines 20 --nostream || true

cat <<EOF

Готово. Бот запущен как pm2-процесс "$APP_NAME".

  логи:        pm2 logs $APP_NAME
  перезапуск:  pm2 restart $APP_NAME
  настройки:   nano $APP_DIR/.env  (после правок: pm2 restart $APP_NAME --update-env)
  обновление:  повторный запуск этого же скрипта

Дальше: открой бота в Telegram, напиши /start — и кнопка «🛠 Админка» будет твоей.
EOF
