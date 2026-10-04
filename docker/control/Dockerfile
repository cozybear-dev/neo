FROM node:22.23.3-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY control/package.json control/package-lock.json* ./
RUN npm ci --ignore-scripts

COPY control/tsconfig.json ./
COPY control/migrations ./migrations
COPY control/src ./src

RUN npm run build \
  && npm prune --omit=dev

COPY docker/control/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

ENV PORT=8090
EXPOSE 8090

HEALTHCHECK --interval=5s --timeout=5s --retries=10 --start-period=10s \
  CMD curl -f http://localhost:8090/readyz || exit 1

USER node
ENTRYPOINT ["/entrypoint.sh"]
