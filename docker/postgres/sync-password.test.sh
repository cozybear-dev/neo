#!/bin/bash
# A volume initialized with the old literal password must accept the
# password from a later start, including a password that contains a quote.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
network="neo-pg-sync-${suffix}"
volume_legacy="neo-pg-sync-legacy-${suffix}"
volume_quote="neo-pg-sync-quote-${suffix}"
legacy_name="neo-pg-legacy-${suffix}"
sync_name="neo-pg-sync-${suffix}"
quote_name="neo-pg-quote-${suffix}"
new_pw='rotated-secret-1'
quote_pw="quo'te"

cleanup() {
  docker rm -f "$legacy_name" "$sync_name" "$quote_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_legacy" "$volume_quote" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

tcp_query() {
  local name=$1 pw=$2
  docker run --rm --network "$network" \
    -e PGPASSWORD="$pw" \
    postgres:16-alpine \
    psql -h "$name" -U neo -d neo -v ON_ERROR_STOP=1 -tAc 'select 1'
}

wait_ready() {
  local name=$1
  local i
  for i in $(seq 1 120); do
    if docker exec "$name" test -f /var/run/neo-db-password-ready; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
      echo "container $name exited before adopting POSTGRES_PASSWORD" >&2
      docker logs "$name" >&2 || true
      return 1
    fi
    sleep 1
  done
  echo "timed out waiting for $name to adopt POSTGRES_PASSWORD" >&2
  docker logs "$name" >&2 || true
  return 1
}

stop_on_term() {
  local name=$1
  local start end
  start=$(date +%s)
  docker stop -t 20 "$name" >/dev/null
  end=$(date +%s)
  if [ $((end - start)) -ge 15 ]; then
    echo "$name ignored SIGTERM" >&2
    return 1
  fi
}

docker build -t neo-postgres:local "$root/docker/postgres"
docker network create "$network" >/dev/null

docker run -d --name "$legacy_name" --network "$network" \
  -v "$volume_legacy":/var/lib/postgresql/data \
  -e POSTGRES_USER=neo \
  -e POSTGRES_PASSWORD=neo \
  -e POSTGRES_DB=neo \
  postgres:16-alpine >/dev/null

for _ in $(seq 1 120); do
  if docker logs "$legacy_name" 2>&1 | grep -q "PostgreSQL init process complete"; then
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$legacy_name")" != "true" ]; then
    echo "stock postgres exited during init" >&2
    docker logs "$legacy_name" >&2 || true
    exit 1
  fi
  sleep 1
done
docker logs "$legacy_name" 2>&1 | grep -q "PostgreSQL init process complete"
for _ in $(seq 1 30); do
  if docker exec "$legacy_name" pg_isready -q -U neo -d neo; then
    break
  fi
  sleep 1
done
docker exec "$legacy_name" pg_isready -q -U neo -d neo
docker stop -t 20 "$legacy_name" >/dev/null
docker rm "$legacy_name" >/dev/null

docker run -d --name "$sync_name" --network "$network" \
  -v "$volume_legacy":/var/lib/postgresql/data \
  -e POSTGRES_USER=neo \
  -e POSTGRES_PASSWORD="$new_pw" \
  -e POSTGRES_DB=neo \
  neo-postgres:local >/dev/null
wait_ready "$sync_name"

got=$(tcp_query "$sync_name" "$new_pw" | tr -d '[:space:]')
if [ "$got" != "1" ]; then
  echo "new password was rejected after adopting an existing volume" >&2
  exit 1
fi
if tcp_query "$sync_name" neo >/dev/null 2>&1; then
  echo "legacy password was still accepted over TCP" >&2
  exit 1
fi
stop_on_term "$sync_name"

docker run -d --name "$quote_name" --network "$network" \
  -v "$volume_quote":/var/lib/postgresql/data \
  -e POSTGRES_USER=neo \
  -e POSTGRES_PASSWORD="$quote_pw" \
  -e POSTGRES_DB=neo \
  neo-postgres:local >/dev/null
wait_ready "$quote_name"
got=$(tcp_query "$quote_name" "$quote_pw" | tr -d '[:space:]')
if [ "$got" != "1" ]; then
  echo "quoted password was rejected on a fresh volume" >&2
  exit 1
fi
stop_on_term "$quote_name"
