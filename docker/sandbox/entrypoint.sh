#!/usr/bin/env bash
# Named volume mounts wipe image chown; chmod as root so USER neo can write
# even when this container starts before dsh.
set -euo pipefail

mkdir -p /workspace
chmod 1777 /workspace || true

if [ "$(id -u)" = 0 ]; then
  exec runuser -u neo -- "$@"
fi
exec "$@"
