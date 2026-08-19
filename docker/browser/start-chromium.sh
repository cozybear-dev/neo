#!/usr/bin/env bash
set -euo pipefail
CHROME="$(find /ms-playwright -type f -path '*/chrome-linux/chrome' 2>/dev/null | head -n1 || true)"
if [[ -z "${CHROME}" ]]; then
  echo "Chromium binary not found under /ms-playwright" >&2
  exit 1
fi
exec "${CHROME}" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  about:blank
