# syntax=docker/dockerfile:1
#
# On-Demand Gatekeeper — the only always-on component for an on-demand webapp.
# Tiny image: node:20-alpine + docker CLI. No runtime npm dependencies.
FROM node:20-alpine

# docker CLI is needed to drive the target stack on the host daemon.
RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8023

# Default command; override via docker-compose / env as needed.
CMD ["node", "src/server.js"]
