#!/bin/sh
# The API key is a process argument. Do not enable shell tracing.
set -eu

BIN_DIR=/opt/soloist
BIN="$BIN_DIR/soloist"
DEVICE_NAME="${SOLOIST_DEVICE_NAME:-music-bot}"
SINK_NAME="${SOLOIST_PIPEWIRE_DEVICE:-soloist-null}"

if [ -z "${SOLOIST_API_KEY:-}" ]; then
  echo "SOLOIST_API_KEY is unset; soloist sidecar is idle" >&2
  exec sleep infinity
fi

download_soloist() {
  arch=$(uname -m)
  case "$arch" in
    x86_64) asset=x86_64 ;;
    aarch64) asset=arm64 ;;
    armv7l) asset=arm32 ;;
    *)
      echo "unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac

  tmp=$(mktemp -d)
  url="https://soloist-builds.spotifycdn.com/soloist_release_${asset}.tar.gz"
  echo "downloading Spotify Soloist ($asset)" >&2
  curl --fail --location --silent --show-error -o "$tmp/soloist.tar.gz" "$url"
  tar -xzf "$tmp/soloist.tar.gz" -C "$tmp"
  found=$(find "$tmp" -type f -name soloist | head -n 1)
  if [ -z "$found" ]; then
    echo "soloist archive did not contain a soloist binary" >&2
    exit 1
  fi
  mkdir -p "$BIN_DIR"
  install -m 755 "$found" "$BIN"
  rm -rf "$tmp"
}

ensure_binary() {
  if [ ! -x "$BIN" ]; then
    download_soloist
  fi
}

if [ "${1:-run}" = "pair" ]; then
  ensure_binary
  exec "$BIN" \
    --device-name "$DEVICE_NAME" \
    --api-key "$SOLOIST_API_KEY" \
    --data-dir /data \
    --cache-dir /cache \
    --pair
fi

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

pipewire >/tmp/pipewire.log 2>&1 &
PIPEWIRE_PID=$!
wireplumber >/tmp/wireplumber.log 2>&1 &
WIREPLUMBER_PID=$!

ready=0
i=0
while [ "$i" -lt 50 ]; do
  if pw-cli info 0 >/dev/null 2>&1; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 0.1
done

if [ "$ready" -ne 1 ]; then
  echo "pipewire did not become ready" >&2
  exit 1
fi

pw-cli create-node adapter "{ factory.name=support.null-audio-sink node.name=$SINK_NAME media.class=Audio/Sink object.linger=true audio.position=[FL,FR] }" \
  >/tmp/null-sink.log 2>&1 \
  || echo "warning: null sink was not created; see /tmp/null-sink.log" >&2

SOLOIST_PID=
shutdown() {
  if [ -n "${SOLOIST_PID:-}" ]; then
    kill "$SOLOIST_PID" 2>/dev/null || true
  fi
  kill "$PIPEWIRE_PID" "$WIREPLUMBER_PID" 2>/dev/null || true
  wait "$PIPEWIRE_PID" "$WIREPLUMBER_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

while true; do
  ensure_binary
  "$BIN" \
    --device-name "$DEVICE_NAME" \
    --api-key "$SOLOIST_API_KEY" \
    --pipewire-device "$SINK_NAME" \
    --ws "0.0.0.0:${SOLOIST_WS_PORT:-9090}" \
    --data-dir /data \
    --cache-dir /cache &
  SOLOIST_PID=$!
  set +e
  wait "$SOLOIST_PID"
  code=$?
  set -e
  SOLOIST_PID=
  if [ "$code" -eq 10 ]; then
    echo "soloist build expired; downloading a newer build" >&2
    rm -f "$BIN"
    continue
  fi
  exit "$code"
done
