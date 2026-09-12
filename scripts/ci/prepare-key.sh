#!/usr/bin/env bash
# Готовит приватный ключ из секрета SSH_PRIVATE_KEY в ~/.ssh/id_deploy.
# Секрет принимается в трёх видах: нормальный PEM, PEM без переносов строк
# (так его портит вставка в веб-форму) и base64 от файла ключа целиком.
set -euo pipefail

: "${SSH_PRIVATE_KEY:?не задан секрет SSH_PRIVATE_KEY}"

mkdir -p ~/.ssh && chmod 700 ~/.ssh
printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_deploy
chmod 600 ~/.ssh/id_deploy

if ! ssh-keygen -y -f ~/.ssh/id_deploy >/dev/null 2>&1 && ! grep -q 'PRIVATE KEY' ~/.ssh/id_deploy; then
  tr -d ' \t\r\n' < ~/.ssh/id_deploy | base64 -d > ~/.ssh/id_deploy.dec 2>/dev/null || true
  if grep -q 'PRIVATE KEY' ~/.ssh/id_deploy.dec 2>/dev/null; then
    mv ~/.ssh/id_deploy.dec ~/.ssh/id_deploy
    chmod 600 ~/.ssh/id_deploy
    echo "ключ пришёл одной строкой в base64 — раскодировал"
  fi
  rm -f ~/.ssh/id_deploy.dec
fi

if ! ssh-keygen -y -f ~/.ssh/id_deploy >/dev/null 2>&1; then
  echo "ключ не читается как есть — восстанавливаю переносы строк"
  python3 - <<'PY'
import pathlib, re
path = pathlib.Path.home() / '.ssh' / 'id_deploy'
raw = path.read_text()
match = re.search(r'-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----(.*?)-----END \1-----', raw, re.S)
if match:
    label, body = match.group(1), re.sub(r'\s+', '', match.group(2))
    lines = [body[i:i + 70] for i in range(0, len(body), 70)]
    path.write_text(f"-----BEGIN {label}-----\n" + "\n".join(lines) + f"\n-----END {label}-----\n")
    print('формат восстановлен')
else:
    print('в секрете нет блока BEGIN/END PRIVATE KEY')
PY
  chmod 600 ~/.ssh/id_deploy
fi

if ! ssh-keygen -y -f ~/.ssh/id_deploy > ~/.ssh/id_deploy.pub 2>/dev/null; then
  echo "::error::в секрете SSH_PRIVATE_KEY не приватный ключ — нужен блок целиком, от BEGIN до END, либо он же в base64"
  exit 1
fi

echo "ключ готов: $(ssh-keygen -lf ~/.ssh/id_deploy.pub | awk '{print $1, $2}')"
