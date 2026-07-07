FROM node:22.11.0-bookworm-slim

RUN groupadd --gid 10001 minicode \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/minicode --shell /usr/sbin/nologin minicode

WORKDIR /workspace
USER 10001:10001

CMD ["node", "--version"]
