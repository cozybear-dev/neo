#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CREATED=false
cleanup(){ if "$CREATED"; then docker rm -f neo-oast-remediation-test >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
docker run -d --name neo-oast-remediation-test -p 127.0.0.1::8080 projectdiscovery/interactsh-server@sha256:246d8988fed0cfefb28f904c4e1ec4a6bb4b6931288d10794a31577687f02471 -d oast.neo.internal -ip 127.0.0.1 -sa -http-port 8080 -duc >/dev/null
CREATED=true
OAST_TEST_PORT="$(docker port neo-oast-remediation-test 8080/tcp)"
export NEO_OAST_TEST_URL="http://${OAST_TEST_PORT}"
"${NEO_TEST_NODE:-node}" "$ROOT/plugins/neo-tools-oast/scripts/service-smoke.mjs"
