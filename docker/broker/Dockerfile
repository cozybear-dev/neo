FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS cli
FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY broker/ ./
CMD ["node", "server.mjs"]
