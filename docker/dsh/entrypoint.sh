#!/usr/bin/env bash
# Seed the neo profile overlay, render $DSH_HOME/settings.yaml from NEO_LLM_*,
# map NEO_LLM_API_KEY onto the adapter env DSH expects, then exec the image CMD.
set -euo pipefail

export DSH_HOME="${DSH_HOME:-/home/node/.dsh}"
PROFILE_SRC="${NEO_PROFILE_SRC:-/opt/neo/plugins/neo-profile}"
PROFILE_DST="${DSH_HOME}/profiles/neo"
RENDERER="${NEO_LLM_RENDERER:-/opt/neo/docker/dsh/render-llm-settings.mjs}"
EXA_PKG="${NEO_EXA_PKG:-/opt/dsh/packages/web/web-search-exa}"

mkdir -p "${DSH_HOME}/profiles/node_modules/@deepseek-ai" "${PROFILE_DST}"

if [[ ! -f "${PROFILE_SRC}/package.json" ]]; then
  echo "neo: missing profile overlay at ${PROFILE_SRC}" >&2
  exit 1
fi

cp "${PROFILE_SRC}/package.json" "${PROFILE_DST}/package.json"
cp "${PROFILE_SRC}/cordis.patch.yml" "${PROFILE_DST}/cordis.patch.yml"
if [[ -f "${PROFILE_SRC}/pnpm-workspace.yaml" ]]; then
  cp "${PROFILE_SRC}/pnpm-workspace.yaml" "${PROFILE_DST}/pnpm-workspace.yaml"
fi
if [[ -f "${PROFILE_SRC}/cordis.yml" ]]; then
  cp "${PROFILE_SRC}/cordis.yml" "${PROFILE_DST}/cordis.yml"
fi

if [[ -d "${EXA_PKG}" ]]; then
  ln -sfn "${EXA_PKG}" "${DSH_HOME}/profiles/node_modules/@deepseek-ai/dsh-web-search-exa"
fi

for pkg in neo-tools-scope neo-tools-memory neo-tools-issues neo-tools-oast; do
  if [[ -d "/opt/neo/plugins/${pkg}" ]]; then
    ln -sfn "/opt/neo/plugins/${pkg}" "${DSH_HOME}/profiles/node_modules/${pkg}"
  fi
done
export NODE_PATH="${DSH_HOME}/profiles/node_modules${NODE_PATH:+:$NODE_PATH}"

# Operational equivalent of the neo profile's web.searchProvider patch.
export DSH_WEB_SEARCH_PROVIDER="${DSH_WEB_SEARCH_PROVIDER:-exa}"

if [[ ! -f "${RENDERER}" ]]; then
  echo "neo: missing LLM settings renderer at ${RENDERER}" >&2
  exit 1
fi

# Writes settings.yaml (env wins) and prints `export KEY='…'` for the mapped credential.
# Redirect, not eval "$(…)", so a renderer failure trips `set -e` (bash does not
# inherit errexit into command substitution without inherit_errexit).
ENV_FILE="${DSH_HOME}/.neo-llm.env"
node "${RENDERER}" --dsh-home "${DSH_HOME}" --export > "${ENV_FILE}"
# shellcheck disable=SC1090
set -a
# shellcheck disable=SC1091
source "${ENV_FILE}"
set +a

if [[ "${NEO_DUMP_SETTINGS:-}" == "1" ]]; then
  cat "${DSH_HOME}/settings.yaml"
  exit 0
fi

if [[ "$#" -eq 0 ]]; then
  set -- dsh --profile neo --no-open
fi

exec "$@"
