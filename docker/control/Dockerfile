FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY control/package.json control/package-lock.json* ./
RUN npm install

COPY control/tsconfig.json ./
COPY control/migrations ./migrations
COPY control/src ./src

RUN npm run build \
  && npm prune --omit=dev

ENV PORT=8090
EXPOSE 8090

HEALTHCHECK --interval=5s --timeout=5s --retries=10 --start-period=10s \
  CMD curl -f http://localhost:8090/healthz || exit 1

CMD ["node", "dist/server.js"]
