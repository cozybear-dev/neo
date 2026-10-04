FROM mcr.microsoft.com/playwright:v1.50.1-jammy@sha256:8845c40cdade98fd7a6cd32df75bfc234cd52b3278f9cd1f9fe8d6291e48ea03

# Chromium CDP for the browser agent. Keep 9222 on the isolated internal `browser-link`
# network only — do not publish it to the host.
EXPOSE 9222

USER root
COPY cdp-proxy.cjs /usr/local/bin/cdp-proxy.cjs
COPY start-chromium.sh /usr/local/bin/start-chromium.sh
RUN chmod +x /usr/local/bin/start-chromium.sh

USER pwuser
CMD ["/usr/local/bin/start-chromium.sh"]
