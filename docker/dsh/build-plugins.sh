#!/bin/sh
# Compile out-of-tree neo tool plugins against the pinned DSH tree.
set -eu

find_tsc() {
  if command -v tsc >/dev/null 2>&1; then
    command -v tsc
    return
  fi
  if [ -x /opt/dsh/node_modules/typescript/bin/tsc ]; then
    echo /opt/dsh/node_modules/typescript/bin/tsc
    return
  fi
  if [ -x /opt/dsh/node_modules/.bin/tsc ]; then
    echo /opt/dsh/node_modules/.bin/tsc
    return
  fi
  found=$(find /opt/dsh/node_modules -path '*/typescript/bin/tsc' -type f 2>/dev/null | head -n 1)
  if [ -n "${found}" ]; then
    echo "${found}"
    return
  fi
  npm install -g typescript@5.9.2 >/dev/null
  command -v tsc
}

TSC="$(find_tsc)"
mkdir -p /opt/dsh/node_modules

for p in neo-tools-scope neo-tools-memory neo-tools-issues neo-tools-oast neo-sandbox-docker neo-tools-browser neo-tools-traffic; do
  dir="/opt/neo/plugins/${p}"
  "${TSC}" -p "${dir}/tsconfig.json"
  mkdir -p "${dir}/node_modules/@deepseek-ai"
  ln -sfn /opt/dsh/packages/core/tools "${dir}/node_modules/@deepseek-ai/dsh-tools"
  ln -sfn "${dir}" "/opt/dsh/node_modules/${p}"
done
