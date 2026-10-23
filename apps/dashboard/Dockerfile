# Place this file at: apps/dashboard/Dockerfile
# Build context is the repo ROOT (docker-compose.yml sets this).

# ---------- Stage 1: install + build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# If you use pnpm 9 locally (run `pnpm -v`), change 10 to 9 here.
RUN npm install -g pnpm@10

COPY . .
# apps/dashboard/dashboard is a stray nested copy of the dashboard. Next.js type-checks
# every .tsx file it finds, so that copy breaks the build. Remove it inside the image only
# (your repo and your files stay untouched).
RUN rm -rf apps/dashboard/dashboard
RUN pnpm install --frozen-lockfile --filter "@livechat/dashboard..."

# NEXT_PUBLIC_* values are baked into the browser code at BUILD time.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=3072

# Builds @livechat/shared first, then the dashboard
RUN pnpm --filter "@livechat/dashboard..." build

# ---------- Stage 2: runtime ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/dashboard
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "-p", "3000"]