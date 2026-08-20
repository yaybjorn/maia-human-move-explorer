#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then echo "Run as root" >&2; exit 1; fi
install -d -o maia -g maia /opt/maia-human-move-explorer/{releases,cache}
python3.12 -m venv /opt/maia-human-move-explorer/venv
/opt/maia-human-move-explorer/venv/bin/pip install --upgrade pip
/opt/maia-human-move-explorer/venv/bin/pip install /opt/maia-human-move-explorer/current
install -m 0644 deploy/maia-explorer.service /etc/systemd/system/maia-explorer.service
systemctl daemon-reload
systemctl enable maia-explorer.service
echo "Installed. Create /etc/nginx/maia.htpasswd, install the nginx template, request TLS, then start the service."

