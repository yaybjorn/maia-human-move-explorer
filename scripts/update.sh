#!/usr/bin/env bash
set -euo pipefail

APP=/opt/maia-human-move-explorer
REPO=${MAIA_REPO_URL:-https://github.com/yaybjorn/maia-human-move-explorer.git}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RELEASE="$APP/releases/$STAMP"
PREVIOUS=$(readlink -f "$APP/current" 2>/dev/null || true)
SWITCHED=0

rollback() {
  local exit_code=$?
  trap - ERR
  if [[ $SWITCHED -eq 1 && -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    echo "Health check failed; restoring the previous release" >&2
    ln -sfn "$PREVIOUS" "$APP/current.rollback"
    mv -Tf "$APP/current.rollback" "$APP/current"
    systemctl restart maia-explorer.service || true
    curl --fail --silent --retry 5 --retry-delay 2 --retry-connrefused http://127.0.0.1:8310/healthz >/dev/null || true
  fi
  exit "$exit_code"
}

trap rollback ERR

if [[ ${EUID} -ne 0 ]]; then echo "Run as root" >&2; exit 1; fi
git clone --depth 1 "$REPO" "$RELEASE"
"$APP/venv/bin/pip" install --upgrade "$RELEASE"
ln -sfn "$RELEASE" "$APP/current.next"
mv -Tf "$APP/current.next" "$APP/current"
SWITCHED=1
chown -R maia:maia "$RELEASE"
systemctl restart maia-explorer.service
curl --fail --silent --retry 10 --retry-delay 2 --retry-connrefused http://127.0.0.1:8310/healthz >/dev/null
SWITCHED=0
trap - ERR
echo "Updated to $(git -C "$RELEASE" rev-parse --short HEAD)"
