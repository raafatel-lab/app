#!/usr/bin/env bash
# Настройка домена для бота: nginx + сертификат Let's Encrypt + PUBLIC_URL.
#
# Порт 443 на сервере занят VPN (xray), поэтому HTTPS бота живёт на 8443 —
# этот порт штатно поддерживают и Telegram, и CryptoBot.
#
# Нужны: DOMAIN, SSH_HOST, SSH_USER, HCLOUD_TOKEN (для правил файрвола),
# подготовленный ~/.ssh/id_deploy и заполненный EMAIL для Let's Encrypt.
set -euo pipefail

SSH_USER=${SSH_USER:-root}
HTTPS_PORT=${HTTPS_PORT:-8443}
KNOWN_HOSTS=/tmp/domain_known_hosts
: > "$KNOWN_HOSTS"

remote() {
  ssh -i ~/.ssh/id_deploy -o BatchMode=yes -o ConnectTimeout=20 \
      -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new \
      "$SSH_USER@$SSH_HOST" "$@"
}

echo "== проверяю DNS =="
# getent возвращает 2, если имя не резолвится, — гасим, чтобы выдать понятную ошибку.
resolved=$( (getent ahostsv4 "$DOMAIN" || true) | awk '{print $1}' | sort -u | head -3 | tr '\n' ' ')
echo "$DOMAIN -> ${resolved:-ничего}"
if [ -z "$resolved" ]; then
  echo "::error::домен $DOMAIN не резолвится. Создай A-запись на $SSH_HOST и подожди несколько минут"
  exit 1
fi
if ! echo "$resolved" | grep -q "$SSH_HOST"; then
  echo "::error::домен указывает на $resolved, а сервер — $SSH_HOST. Поправь A-запись (и выключи прокси Cloudflare)"
  exit 1
fi
echo "DNS в порядке"

echo "== файрвол Hetzner =="
if [ -n "${HCLOUD_TOKEN:-}" ]; then
  fw=$(curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" 'https://api.hetzner.cloud/v1/firewalls?per_page=50' \
    | jq -r --arg id "$(curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" 'https://api.hetzner.cloud/v1/servers?per_page=50' \
        | jq -r --arg ip "$SSH_HOST" '.servers[] | select(.public_net.ipv4.ip == $ip) | .id')" \
      '.firewalls[] | select(.applied_to[]?.server.id == ($id|tonumber)) | .id' | head -1)
  if [ -n "$fw" ]; then
    echo "к серверу привязан файрвол id=$fw — проверяю правила для 80 и $HTTPS_PORT"
    rules=$(curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" "https://api.hetzner.cloud/v1/firewalls/$fw" | jq '.firewall.rules')
    add=$(echo "$rules" | jq --arg p "$HTTPS_PORT" '
      def has(port): any(.[]; .direction=="in" and .protocol=="tcp" and (.port|tostring)==port);
      [ (if has("80") then empty else {direction:"in", protocol:"tcp", port:"80", source_ips:["0.0.0.0/0","::/0"]} end),
        (if has($p) then empty else {direction:"in", protocol:"tcp", port:$p, source_ips:["0.0.0.0/0","::/0"]} end) ]')
    if [ "$(echo "$add" | jq 'length')" -gt 0 ]; then
      echo "добавляю недостающие правила: $(echo "$add" | jq -c '[.[].port]')"
      merged=$(jq -n --argjson a "$rules" --argjson b "$add" '{rules: ($a + $b)}')
      curl -fsS -X POST -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' \
        -d "$merged" "https://api.hetzner.cloud/v1/firewalls/$fw/actions/set_rules" >/dev/null
      echo "правила обновлены"
    else
      echo "нужные порты уже открыты"
    fi
  else
    echo "файрвол Hetzner к серверу не привязан — правила не нужны"
  fi
fi

echo "== ставлю nginx и certbot, выпускаю сертификат =="
remote "DOMAIN='$DOMAIN' EMAIL='${EMAIL:-}' HTTPS_PORT='$HTTPS_PORT' bash -se" <<'EOS'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

command -v nginx >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq nginx; }
command -v certbot >/dev/null 2>&1 || apt-get install -y -qq certbot

# Локальный ufw, если включён
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow "${HTTPS_PORT}"/tcp >/dev/null 2>&1 || true
  echo "правила ufw добавлены"
fi

mkdir -p /var/www/certbot

# Порт 80 — только для выпуска и продления сертификата.
cat > /etc/nginx/sites-available/shop-bot <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://\$host:${HTTPS_PORT}\$request_uri;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/shop-bot /etc/nginx/sites-enabled/shop-bot
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  # Штатный таймер certbot мог занять блокировку — ждём и пробуем снова.
  issued=""
  for attempt in 1 2 3 4 5; do
    if certbot certonly --webroot -w /var/www/certbot -d "${DOMAIN}" \
         --non-interactive --agree-tos -m "${EMAIL:-admin@${DOMAIN}}" --no-eff-email; then
      issued=yes
      break
    fi
    if ! pgrep -x certbot >/dev/null 2>&1; then
      echo "certbot не запущен, снимаю зависшую блокировку"
      rm -f /var/lib/letsencrypt/.certbot.lock /var/log/letsencrypt/.certbot.lock /etc/letsencrypt/.certbot.lock
    else
      echo "certbot занят другим процессом, жду (попытка $attempt)"
    fi
    sleep 20
  done
  test -n "$issued" || { echo "не удалось выпустить сертификат"; exit 1; }
fi

# HTTPS на отдельном порту: 443 занят VPN и остаётся нетронутым.
cat > /etc/nginx/sites-available/shop-bot <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://\$host:${HTTPS_PORT}\$request_uri;
    }
}

server {
    listen ${HTTPS_PORT} ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
NGINX
nginx -t
systemctl reload nginx
systemctl enable nginx >/dev/null 2>&1 || true

# Автопродление: certbot ставит таймер сам, добавляем перезагрузку nginx.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx\n' > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

# PUBLIC_URL в .env бота
env_file=/var/www/shop-bot/.env
public_url="https://${DOMAIN}:${HTTPS_PORT}"
if grep -q '^PUBLIC_URL=' "$env_file"; then
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=${public_url}|" "$env_file"
else
  echo "PUBLIC_URL=${public_url}" >> "$env_file"
fi
pm2 restart shop-bot --update-env >/dev/null
sleep 4

echo "== проверка изнутри =="
curl -fsS --max-time 10 "https://${DOMAIN}:${HTTPS_PORT}/health" && echo
EOS

echo "== проверка снаружи =="
curl -fsS --max-time 20 "https://$DOMAIN:$HTTPS_PORT/health" && echo
echo
echo "вебхук для CryptoBot: https://$DOMAIN:$HTTPS_PORT/webhook/cryptobot"
