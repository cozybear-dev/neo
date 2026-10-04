#!/bin/sh
# Create the chat-opener secret before control serves traffic, then drop root.
set -eu
token_file="${NEO_SESSION_OPEN_FILE:-/state/session-open.token}"
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$(dirname "$token_file")"
  if [ ! -s "$token_file" ]; then
    node -e 'const {randomBytes}=require("node:crypto"); const {writeFileSync}=require("node:fs"); writeFileSync(process.argv[1], randomBytes(32).toString("base64url")+"\n", {mode:0o600})' "$token_file"
  fi
  chown node:node "$token_file"
  chmod 400 "$token_file"
  export HOME=/home/node
  exec runuser --preserve-environment -u node -- node dist/server.js
fi
exec node dist/server.js
