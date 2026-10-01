# syntax = docker/dockerfile:1

# Node (pinned to match mise.toml) + Express + the built-in node:sqlite
# module, persisting to the /data volume fly.toml mounts. Serves HTTP on
# 0.0.0.0:$PORT and publishes README.md at /readme/ (spec/README.md says
# what's checked).

FROM node:24-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY server/ server/
COPY public/ public/
COPY README.md ./

ENV PORT=8080
ENV DB_PATH=/data/app.db
EXPOSE 8080

CMD ["node", "server/index.js"]
