#!/usr/bin/env bash
# Start Ghidra under Xvfb so LaurieWired GhidraMCP can bind its HTTP API.
# Port: ${GHIDRA_MCP_PORT:-8080} (compose service alias: ghidra:8080).
set -euo pipefail

export GHIDRA_INSTALL_DIR="${GHIDRA_INSTALL_DIR:-/opt/ghidra}"
export GHIDRA_MCP_PORT="${GHIDRA_MCP_PORT:-8080}"
PROJECTS="${GHIDRA_PROJECTS:-/home/ghidra/projects}"
mkdir -p "${PROJECTS}" /workspace/ghidra

echo "ghidra-mcp: GhidraMCP HTTP API on 0.0.0.0:${GHIDRA_MCP_PORT}" >&2
echo "ghidra-mcp: drop binaries under /workspace/ghidra and open via CodeBrowser" >&2

# Headless analyze when BINARIES is set (comma-separated paths), then keep GUI/plugin up.
if [[ -n "${GHIDRA_BINARIES:-}" ]]; then
  IFS=',' read -r -a bins <<< "${GHIDRA_BINARIES}"
  for bin in "${bins[@]}"; do
    [[ -f "${bin}" ]] || continue
    name="$(basename "${bin}")"
    "${GHIDRA_INSTALL_DIR}/support/analyzeHeadless" \
      "${PROJECTS}" "neo-${name}" \
      -import "${bin}" \
      -analysisTimeoutPerFile 300 \
      -deleteProject \
      || true
  done
fi

exec xvfb-run -a -s "-screen 0 1920x1080x24" \
  "${GHIDRA_INSTALL_DIR}/ghidraRun" \
  -DGhidraMCP.httpPort="${GHIDRA_MCP_PORT}"
