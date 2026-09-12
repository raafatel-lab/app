#!/usr/bin/env bash
# Прописывает деплой-ключ на сервер Hetzner, когда обычного доступа нет:
# грузит ключ в проект, поднимает сервер в аварийном режиме, монтирует диск,
# дописывает ключ в authorized_keys и возвращает машину в обычный режим.
#
# Нужны переменные: HCLOUD_TOKEN, SSH_HOST, SSH_USER (по умолчанию root),
# и подготовленный ~/.ssh/id_deploy (см. prepare-key.sh).
set -euo pipefail

API=https://api.hetzner.cloud/v1
SSH_USER=${SSH_USER:-root}
KNOWN_HOSTS=/tmp/rescue_known_hosts
: > "$KNOWN_HOSTS"

api() {
  curl -fsS -H "Authorization: Bearer $HCLOUD_TOKEN" -H 'Content-Type: application/json' "$@"
}

server_status() {
  api "$API/servers/$SERVER_ID" | jq -r '.server.status'
}

wait_status() {
  local want=$1 tries=${2:-40}
  for _ in $(seq 1 "$tries"); do
    local now; now=$(server_status)
    [ "$now" = "$want" ] && { echo "сервер: $now"; return 0; }
    sleep 5
  done
  echo "::error::сервер не перешёл в состояние $want"
  return 1
}

ssh_try() {
  ssh -i ~/.ssh/id_deploy -o BatchMode=yes -o ConnectTimeout=10 \
      -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new \
      "$SSH_USER@$SSH_HOST" "$@"
}

wait_ssh() {
  local tries=${1:-24}
  : > "$KNOWN_HOSTS"   # у аварийной системы свой ключ хоста
  for _ in $(seq 1 "$tries"); do
    if ssh_try true 2>/dev/null; then return 0; fi
    sleep 10
  done
  return 1
}

echo "== ищу сервер в проекте =="
servers=$(api "$API/servers?per_page=50")
SERVER_ID=$(echo "$servers" | jq -r --arg ip "$SSH_HOST" '.servers[] | select(.public_net.ipv4.ip == $ip) | .id')
if [ -z "$SERVER_ID" ]; then
  echo "::error::в проекте Hetzner нет сервера с адресом $SSH_HOST"
  echo "$servers" | jq -r '.servers[] | "  \(.name) — \(.public_net.ipv4.ip)"'
  exit 1
fi
rescue_on=$(api "$API/servers/$SERVER_ID" | jq -r '.server.rescue_enabled')
echo "сервер id=$SERVER_ID, состояние: $(server_status), аварийный режим: $rescue_on"

# Если сервер работает в обычном режиме и ключ уже принят — делать нечего.
# В аварийном режиме ключ тоже работает, поэтому одной проверки SSH мало.
if [ "$rescue_on" != "true" ] && ssh -i ~/.ssh/id_deploy -o BatchMode=yes -o ConnectTimeout=10 \
     -o UserKnownHostsFile="$KNOWN_HOSTS" -o StrictHostKeyChecking=accept-new \
     "$SSH_USER@$SSH_HOST" true 2>/dev/null; then
  echo "ключ уже работает на обычной системе — ничего не трогаю"
  exit 0
fi

echo "== кладу деплой-ключ в проект =="
pub=$(cat ~/.ssh/id_deploy.pub)
key_id=$(api -X POST -d "$(jq -n --arg n "github-actions-deploy-$(date +%s)" --arg k "$pub" '{name:$n, public_key:$k}')" \
  "$API/ssh_keys" 2>/dev/null | jq -r '.ssh_key.id // empty' || true)
if [ -z "$key_id" ]; then
  # такой ключ уже загружен — ищем его в проекте по телу ключа
  material=$(awk '{print $2}' ~/.ssh/id_deploy.pub)
  key_id=$(api "$API/ssh_keys?per_page=50" \
    | jq -r --arg m "$material" '.ssh_keys[] | select((.public_key | split(" ")[1]) == $m) | .id' | head -1)
fi
test -n "$key_id" || { echo "::error::не удалось добавить ключ в проект Hetzner"; exit 1; }
echo "ключ в проекте: id=$key_id"

# В аварийной системе корень — не раздел диска, по этому её и отличаем.
in_rescue() {
  local src
  src=$(ssh_try 'findmnt -n -o SOURCE / 2>/dev/null || true' 2>/dev/null || true)
  case "$src" in
    /dev/*) return 1 ;;
    '') return 1 ;;
    *) return 0 ;;
  esac
}

if [ "$rescue_on" = "true" ] && wait_ssh 3 && in_rescue; then
  echo "== сервер уже в аварийном режиме, перезагрузка не нужна =="
else
  echo "== включаю аварийный режим =="
  api -X POST -d "$(jq -n --argjson k "$key_id" '{type:"linux64", ssh_keys:[$k]}')" \
    "$API/servers/$SERVER_ID/actions/enable_rescue" | jq -r '.action.status'

  echo "== мягко выключаю сервер =="
  api -X POST "$API/servers/$SERVER_ID/actions/shutdown" >/dev/null
  if ! wait_status off 18; then
    echo "не выключился по ACPI — выключаю принудительно"
    api -X POST "$API/servers/$SERVER_ID/actions/poweroff" >/dev/null
    wait_status off
  fi

  echo "== включаю (загрузка в аварийную систему) =="
  api -X POST "$API/servers/$SERVER_ID/actions/poweron" >/dev/null
  wait_status running

  echo "== жду SSH в аварийной системе =="
  wait_ssh 24 || { echo "::error::аварийная система не отвечает по SSH"; exit 1; }
fi
echo "аварийная система: $(ssh_try 'uname -sr')"

echo "== прописываю ключ на диск сервера =="
# Ключ передаём аргументом: через stdin уже идёт сам скрипт.
ssh_try "bash -s -- '$pub'" <<'EOS'
set -eu
key="$1"
target=""
mkdir -p /mnt/target
for part in $(lsblk -ln -o NAME,TYPE | awk '$2=="part"{print "/dev/"$1}'); do
  if mount "$part" /mnt/target 2>/dev/null; then
    if [ -d /mnt/target/etc ] && [ -d /mnt/target/root ]; then
      target="$part"
      break
    fi
    umount /mnt/target
  fi
done
test -n "$target" || { echo "не нашёл корневой раздел"; exit 1; }
echo "корневой раздел: $target"

mkdir -p /mnt/target/root/.ssh
chmod 700 /mnt/target/root/.ssh
touch /mnt/target/root/.ssh/authorized_keys
grep -v 'github-actions-deploy' /mnt/target/root/.ssh/authorized_keys > /tmp/ak || true
printf '%s\n' "$key" >> /tmp/ak
cp /tmp/ak /mnt/target/root/.ssh/authorized_keys
chmod 600 /mnt/target/root/.ssh/authorized_keys
echo "ключей в authorized_keys: $(wc -l < /mnt/target/root/.ssh/authorized_keys)"

sync
umount /mnt/target
EOS

echo "== выключаю аварийный режим и возвращаю сервер =="
api -X POST "$API/servers/$SERVER_ID/actions/disable_rescue" >/dev/null || true
api -X POST "$API/servers/$SERVER_ID/actions/reset" >/dev/null
sleep 15
wait_status running

echo "== жду обычную систему =="
wait_ssh 30 || { echo "::error::сервер не поднялся после возврата из аварийного режима"; exit 1; }
echo "готово: $(ssh_try 'hostname; uptime -p')"
