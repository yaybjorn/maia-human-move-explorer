#!/usr/bin/env bash
# Install the private CPU worker runtime only; does not enable it or restart services.
# Existing Maia venv, systemd service and nginx are not changed.
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo 'Run as root' >&2; exit 1; }
video_app=/opt/maia-human-move-explorer
video_script_root=$(cd "$(dirname "$0")/.." && pwd)
video_runtime="$video_app/video-runtime"
video_node_version=v24.20.0
video_node_sha=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
mkdir -p "$video_runtime/bin"
# Debian ffprobe links the complete codec/filter/device runtime. Simulation verified
# the additional260MB fits; no graphical server or public service is installed.
apt-get install -y --no-install-recommends ffmpeg python3-venv
ln -sfn /usr/bin/ffprobe "$video_runtime/bin/ffprobe"
video_temp=$(mktemp -d /tmp/maia-video-runtime.XXXXXX)
trap 'rm -rf "$video_temp"' EXIT
"$video_runtime/bin/ffprobe" -version | head -1
if [[ ! -x "$video_runtime/bin/node" ]] || [[ $("$video_runtime/bin/node" --version) != "$video_node_version" ]]; then
  curl --fail --silent --show-error --location --max-time 120 \
    "https://nodejs.org/dist/$video_node_version/node-$video_node_version-linux-x64.tar.xz" \
    -o "$video_temp/node.tar.xz"
  echo "$video_node_sha  $video_temp/node.tar.xz" | sha256sum --check --status
  tar -xJf "$video_temp/node.tar.xz" -C "$video_temp"
  install -m 755 "$video_temp/node-$video_node_version-linux-x64/bin/node" "$video_runtime/bin/node"
  install -m 644 "$video_temp/node-$video_node_version-linux-x64/LICENSE" "$video_runtime/NODE-LICENSE"
fi
"$video_runtime/bin/node" --version
python3 -m venv "$video_runtime/venv"
"$video_runtime/venv/bin/pip" install --no-cache-dir -r "$video_script_root/app/video_ocr/requirements.txt"
"$video_runtime/venv/bin/pip" check
mkdir -p "$video_app/cache/video-extractions/sources" "$video_app/cache/video-models"
chown maia:maia "$video_app/cache/video-extractions" "$video_app/cache/video-extractions/sources" "$video_app/cache/video-models"
chmod 700 "$video_app/cache/video-extractions" "$video_app/cache/video-extractions/sources"
echo 'Video runtime installed. Model, host smoke and explicit enable step remain required.'
