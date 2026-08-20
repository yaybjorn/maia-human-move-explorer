#!/usr/bin/env bash
set -euo pipefail

APP=/opt/maia-human-move-explorer
REPO=${MAIA_REPO_URL:-https://github.com/yaybjorn/maia-human-move-explorer.git}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE="$APP/releases/$STAMP"

if [[ ${EUID} -ne 0 ]]; then echo "Run as root" >&2; exit 1; fi
git clone --depth 1 "$REPO" "$RELEASE"
"$APP/venv/bin/pip" install --upgrade "$RELEASE"
ln -sfn "$RELEASE" "$APP/current.next"
mv -Tf "$APP/current.next" "$APP/current"
chown -R maia:maia "$RELEASE"
systemctl restart maia-explorer.service
curl --fail --silent --retry 10 --retry-delay 2 http://127.0.0.1:8310/healthz >/dev/null
echo "Updated to $(git -C "$RELEASE" rev-parse --short HEAD)"

