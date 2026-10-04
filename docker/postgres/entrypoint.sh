#!/bin/sh
# Adopts POSTGRES_PASSWORD on an existing data directory. The stock image
# applies that variable only during the first init.
set -eu

ready=/var/run/neo-db-password-ready
rm -f "$ready"

if [ "${POSTGRES_USER:-}" != "neo" ] || [ -z "${POSTGRES_DB:-}" ] || [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "postgres: POSTGRES_USER=neo, POSTGRES_DB, and POSTGRES_PASSWORD are required" >&2
  exit 1
fi

case $POSTGRES_PASSWORD in
  *'
'*)
    echo "postgres: POSTGRES_PASSWORD must be a single line" >&2
    exit 1
    ;;
esac

/usr/local/bin/docker-entrypoint.sh "$@" &
child=$!
stopping=0

forward() {
  stopping=1
  kill -TERM "$child" 2>/dev/null || true
}
on_signal() {
  forward
  wait "$child" 2>/dev/null || true
  exit 0
}
trap on_signal TERM INT

child_state() {
  stat=$(cat "/proc/$child/stat" 2>/dev/null || true)
  state=${stat##*) }
  state=${state%% *}
  printf '%s' "$state"
}

reap() {
  status=0
  wait "$child" || status=$?
  exit "$status"
}

# The stock entrypoint's temporary server is socket-only and still shows
# docker-entrypoint in its command line. Wait for the exec'd postgres.
i=0
while :; do
  if [ "$stopping" -eq 1 ]; then
    reap
  fi
  state=$(child_state)
  if [ -z "$state" ] || [ "$state" = "Z" ]; then
    reap
  fi
  cmd=$(tr '\0' ' ' < "/proc/$child/cmdline" 2>/dev/null || true)
  case $cmd in
    *docker-entrypoint*|*gosu*) ;;
    *postgres*)
      if pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"; then
        break
      fi
      ;;
  esac
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then
    echo "postgres: server did not become ready" >&2
    forward
    wait "$child" || true
    exit 1
  fi
  sleep 0.2
done

if [ "$stopping" -eq 1 ]; then
  reap
fi

escaped=$(printf '%s' "$POSTGRES_PASSWORD" | sed "s/'/''/g")
if ! printf "ALTER USER neo PASSWORD '%s';\n" "$escaped" |
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" >/dev/null; then
  echo "postgres: failed to adopt POSTGRES_PASSWORD" >&2
  forward
  wait "$child" || true
  exit 1
fi

touch "$ready"
status=0
wait "$child" || status=$?
exit "$status"
