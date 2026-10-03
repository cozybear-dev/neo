#!/usr/bin/env bash
# Seed the neo profile overlay, render $DSH_HOME/neo-llm.patch.yml from NEO_LLM_*,
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

for pkg in neo-tools-scope neo-tools-memory neo-tools-issues neo-tools-oast neo-sandbox-docker neo-tools-browser neo-tools-traffic neo-tools-deploy neo-summarizer neo-orchestrator; do
  if [[ -d "/opt/neo/plugins/${pkg}" ]]; then
    ln -sfn "/opt/neo/plugins/${pkg}" "${DSH_HOME}/profiles/node_modules/${pkg}"
  fi
done
export NODE_PATH="${DSH_HOME}/profiles/node_modules${NODE_PATH:+:$NODE_PATH}"
export NEO_PRESETS_DIR="${NEO_PRESETS_DIR:-/opt/neo/presets}"

# DSH skill-filesystem user root. Workspace /skills is not the compose volume.
mkdir -p "${DSH_HOME}/skills"
if [[ -d /opt/neo/skills ]]; then
  for skill in /opt/neo/skills/*; do
    [[ -d "${skill}" ]] || continue
    ln -sfn "${skill}" "${DSH_HOME}/skills/$(basename "${skill}")"
  done
fi

# Operational equivalent of the neo profile's web.searchProvider patch.
export DSH_WEB_SEARCH_PROVIDER="${DSH_WEB_SEARCH_PROVIDER:-exa}"
# Isolation is the sandbox container (sandbox_exec). DSH same-world
# workspace-write has no backend in this image (no bwrap/Landlock) and
# fail-closes bash/fs with SANDBOX_UNAVAILABLE. Override only if a backend
# is actually usable.
export DSH_PERMISSION_MODE="${DSH_PERMISSION_MODE:-danger-full-access}"

if [[ ! -f "${RENDERER}" ]]; then
  echo "neo: missing LLM settings renderer at ${RENDERER}" >&2
  exit 1
fi

# settings.yaml is a one-shot 0.1 import. A leftover file is merged over the
# profile on first 0.2 boot and, once settings.yaml.imported exists, later
# boots ignore a rewritten settings.yaml. Move it aside before dsh starts.
# Do not delete it, and do not clobber settings.yaml.imported or an existing dest.
if [[ -f "${DSH_HOME}/settings.yaml" && ! -e "${DSH_HOME}/settings.yaml.neo-legacy" ]]; then
  mv "${DSH_HOME}/settings.yaml" "${DSH_HOME}/settings.yaml.neo-legacy"
fi

# Writes neo-llm.patch.yml (env wins) and prints `export KEY='…'` for the mapped credential.
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
  cat "${DSH_HOME}/neo-llm.patch.yml"
  exit 0
fi

if [[ "$#" -eq 0 ]]; then
  set -- dsh --profile neo --no-open
fi

# Launcher flags end at the first token Commander does not know (--no-open is
# an app flag). Insert --patch before that token so the LLM rows are applied.
# Skip when the caller already passed --patch.
if [[ "${1:-}" == "dsh" ]]; then
  neo_has_patch=0
  for neo_arg in "$@"; do
    if [[ "${neo_arg}" == "--patch" ]]; then
      neo_has_patch=1
      break
    fi
  done
  if [[ "${neo_has_patch}" -eq 0 ]]; then
    neo_args=("dsh")
    shift
    neo_inserted=0
    neo_expect_value=0
    while [[ $# -gt 0 ]]; do
      if [[ "${neo_expect_value}" -eq 1 ]]; then
        neo_args+=("$1")
        neo_expect_value=0
        shift
        continue
      fi
      case "$1" in
        --profile|--from-default-profile|--patch)
          neo_args+=("$1")
          neo_expect_value=1
          ;;
        --dump-config|--dump-config-schema|--dump-default-config|-V|--version)
          neo_args+=("$1")
          ;;
        *)
          if [[ "${neo_inserted}" -eq 0 ]]; then
            neo_args+=("--patch" "${DSH_HOME}/neo-llm.patch.yml")
            neo_inserted=1
          fi
          neo_args+=("$1")
          ;;
      esac
      shift
    done
    if [[ "${neo_inserted}" -eq 0 ]]; then
      neo_args+=("--patch" "${DSH_HOME}/neo-llm.patch.yml")
    fi
    set -- "${neo_args[@]}"
  fi
fi

# Named volume mounts wipe image ownership; keep /workspace writable for USER neo.
mkdir -p /workspace
chmod 1777 /workspace || true
# Pre-create specialist dirs so neo can write even if umask is strict.
for d in agents explore recon research sandbox browser verification; do
  mkdir -p "/workspace/${d}"
  chmod 1777 "/workspace/${d}" || true
done

exec "$@"
