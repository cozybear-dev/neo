FROM mcr.microsoft.com/playwright:v1.50.1-jammy

# Chromium CDP for the browser agent. Keep 9222 on the compose `control`
# network only — do not publish it to the host.
EXPOSE 9222

USER root
COPY start-chromium.sh /usr/local/bin/start-chromium.sh
RUN chmod +x /usr/local/bin/start-chromium.sh

USER pwuser
CMD ["/usr/local/bin/start-chromium.sh"]
