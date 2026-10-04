#!/usr/bin/env bash
set -euo pipefail
CHROME="$(find /ms-playwright -type f -path '*/chrome-linux/chrome' 2>/dev/null | head -n1 || true)"
if [[ -z "${CHROME}" ]]; then
  echo "Chromium binary not found under /ms-playwright" >&2
  exit 1
fi
node /usr/local/bin/cdp-proxy.cjs &
PROXY_PID=$!
trap 'kill "$PROXY_PID" "${CHROME_PID:-}" 2>/dev/null || true' EXIT TERM INT
"${CHROME}" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=9223 \
  --remote-debugging-address=127.0.0.1 \
  --proxy-server=http://127.0.0.1:9 \
  --proxy-bypass-list="<-loopback>" \
  --disable-quic \
  --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
  about:blank &
CHROME_PID=$!
wait "$CHROME_PID"
