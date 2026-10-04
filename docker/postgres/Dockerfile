FROM postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea

COPY entrypoint.sh /usr/local/bin/neo-postgres-entrypoint.sh
RUN chmod 0755 /usr/local/bin/neo-postgres-entrypoint.sh

ENTRYPOINT ["neo-postgres-entrypoint.sh"]
# A new ENTRYPOINT drops the base image CMD.
CMD ["postgres"]
