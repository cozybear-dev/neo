# Pin DeepSeek Harness, overlay the neo profile, serve dsh --profile neo.
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

# Resolved at implement time: git ls-remote https://github.com/deepseek-ai/deepseek-harness.git HEAD
ARG DSH_SHA=141eb6fef83422698aef7a981029e843e8161534
WORKDIR /opt/dsh
RUN git init \
  && git remote add origin https://github.com/deepseek-ai/deepseek-harness.git \
  && git fetch --depth 1 origin "${DSH_SHA}" \
  && git checkout --force FETCH_HEAD \
  && git rev-parse HEAD | grep -qx "${DSH_SHA}"

ENV CI=true \
    GIT_AUTHOR_NAME=neo \
    GIT_AUTHOR_EMAIL=neo@local \
    GIT_COMMITTER_NAME=neo \
    GIT_COMMITTER_EMAIL=neo@local \
    PYTHON=/usr/bin/python3

RUN git config --global user.email neo@local \
  && git config --global user.name neo \
  && git config --global --add safe.directory /opt/dsh \
  && pnpm install --frozen-lockfile

RUN pnpm run build

RUN printf '%s\n' '#!/bin/sh' 'exec node /opt/dsh/apps/cli/lib/bin.js "$@"' > /usr/local/bin/dsh \
  && chmod +x /usr/local/bin/dsh

COPY plugins/neo-profile /opt/neo/plugins/neo-profile
COPY plugins/neo-tools-scope /opt/neo/plugins/neo-tools-scope
COPY plugins/neo-tools-memory /opt/neo/plugins/neo-tools-memory
COPY plugins/neo-tools-issues /opt/neo/plugins/neo-tools-issues
COPY plugins/neo-tools-oast /opt/neo/plugins/neo-tools-oast
COPY plugins/neo-sandbox-docker /opt/neo/plugins/neo-sandbox-docker
COPY plugins/neo-tools-browser /opt/neo/plugins/neo-tools-browser
COPY plugins/neo-tools-traffic /opt/neo/plugins/neo-tools-traffic
COPY docker/dsh/render-llm-settings.mjs /opt/neo/docker/dsh/render-llm-settings.mjs
COPY docker/dsh/entrypoint.sh /opt/neo/docker/dsh/entrypoint.sh
COPY docker/dsh/build-plugins.sh /opt/neo/docker/dsh/build-plugins.sh
RUN chmod +x /opt/neo/docker/dsh/entrypoint.sh /opt/neo/docker/dsh/build-plugins.sh \
  && chmod +r /opt/neo/docker/dsh/render-llm-settings.mjs \
  && /opt/neo/docker/dsh/build-plugins.sh

ENV DSH_HOME=/home/node/.dsh \
    DSH_WEB_SEARCH_PROVIDER=exa \
    NODE_ENV=production

WORKDIR /workspace
EXPOSE 3080
ENTRYPOINT ["/opt/neo/docker/dsh/entrypoint.sh"]
CMD ["dsh", "--profile", "neo", "--no-open"]
