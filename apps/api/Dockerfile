# Place this file at: apps/api/Dockerfile
# Build context is the repo ROOT (docker-compose.yml already sets this).

# ---------- Stage 1: install + build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# If you use pnpm 9 locally (run `pnpm -v`), change 10 to 9 here.
RUN npm install -g pnpm@10

COPY . .

# Install only what @livechat/api (and the workspace packages it needs) requires
RUN pnpm install --frozen-lockfile --filter "@livechat/api..."

# Builds @livechat/db and @livechat/shared first, then the API
RUN pnpm --filter "@livechat/api..." build

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/apps/api

COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
