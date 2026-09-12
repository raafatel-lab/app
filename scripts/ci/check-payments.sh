#!/usr/bin/env bash
# Проверка платёжного контура: DNS, HTTPS, вебхук CryptoBot, токен Crypto Pay.
# Ничего не меняет и балансов не трогает: подписанный вебхук отправляется для
# несуществующего счёта, чтобы проверить только приём и проверку подписи.
set -uo pipefail

DOMAIN=${DOMAIN:?не задан DOMAIN}
HTTPS_PORT=${HTTPS_PORT:-8443}
BASE="https://${DOMAIN}:${HTTPS_PORT}"
fails=0

echo "== DNS =="
addrs=$( (getent ahostsv4 "$DOMAIN" || true) | awk '{print $1}' | sort -u | tr '\n' ' ')
echo "$DOMAIN -> ${addrs:-ничего}"
extra=$(echo "$addrs" | tr ' ' '\n' | grep -v "^$SSH_HOST$" | grep -v '^$' || true)
if [ -n "$extra" ]; then
  echo "::warning::домен отдаёт лишние адреса: $extra — часть вебхуков уйдёт мимо сервера"
else
  echo "адрес только один, и он верный"
fi

echo
echo "== HTTPS =="
if curl -fsS --max-time 15 "$BASE/health"; then echo " — ок"; else echo "::error::/health недоступен"; fails=$((fails+1)); fi

echo
echo "== вебхук без подписи (должен быть отклонён) =="
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/webhook/cryptobot" \
  -H 'Content-Type: application/json' -d '{"update_type":"invoice_paid"}')
if [ "$code" = "401" ]; then echo "401 — верно, чужой запрос не пройдёт"; else echo "::error::ожидался 401, получен $code"; fails=$((fails+1)); fi

echo
echo "== вебхук с подписью (несуществующий счёт, балансы не трогаем) =="
body='{"update_id":1,"update_type":"invoice_paid","payload":{"invoice_id":999999999,"payload":"999999999","status":"paid"}}'
# Подпись считаем тем же способом, что и сервер: HMAC-SHA256 тела ключом SHA256(токен).
sig=$(BODY="$body" node -e '
  const c = require("crypto");
  const secret = c.createHash("sha256").update(process.env.CRYPTO_PAY_TOKEN).digest();
  console.log(c.createHmac("sha256", secret).update(process.env.BODY).digest("hex"));
')
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/webhook/cryptobot" \
  -H 'Content-Type: application/json' -H "crypto-pay-api-signature: $sig" -d "$body")
if [ "$code" = "200" ]; then echo "200 — подпись принята, обработчик работает"; else echo "::error::ожидался 200, получен $code"; fails=$((fails+1)); fi

echo
echo "== токен Crypto Pay =="
me=$(curl -sS --max-time 15 -H "Crypto-Pay-API-Token: $CRYPTO_PAY_TOKEN" https://pay.crypt.bot/api/getMe)
if echo "$me" | jq -e '.ok' >/dev/null 2>&1; then
  echo "приложение: $(echo "$me" | jq -r '.result.name // "без имени"')"
else
  echo "::error::Crypto Pay не принял токен: $me"; fails=$((fails+1))
fi

echo
echo "== что увидел бот =="
ssh -i ~/.ssh/id_deploy -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile=/tmp/known -o ConnectTimeout=20 \
    "${SSH_USER:-root}@$SSH_HOST" 'pm2 logs shop-bot --lines 15 --nostream 2>/dev/null | tail -15'

echo
if [ "$fails" -gt 0 ]; then
  echo "::error::проверок с ошибкой: $fails"
  exit 1
fi
echo "платёжный контур в порядке"
