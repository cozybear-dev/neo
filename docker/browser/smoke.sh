#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${NEO_BROWSER_TEST_IMAGE:-neo-browser-remediation-check}"
CREATED_NETWORK=false
CREATED_CONTAINER=false
cleanup() {
  if "$CREATED_CONTAINER"; then docker rm -f neo-browser-remediation-test >/dev/null 2>&1 || true; fi
  if "$CREATED_NETWORK"; then docker network rm neo-browser-remediation-test >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
# Uses dedicated names and refuses collisions rather than removing existing resources.
docker network create --internal neo-browser-remediation-test >/dev/null
CREATED_NETWORK=true
docker build -t "$IMAGE" "$ROOT/docker/browser"
docker run -d --name neo-browser-remediation-test --network neo-browser-remediation-test "$IMAGE" >/dev/null
CREATED_CONTAINER=true
docker run --rm --network neo-browser-remediation-test -v "$ROOT:/repo:ro" --entrypoint node "${NEO_DSH_TEST_IMAGE:-node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2}" /repo/docker/browser/smoke.mjs
