# Devnet keeper and monitor (start.sh). Build context: the directory deploy/railway-devnet/stage.sh assembles.
FROM node:24-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
WORKDIR /app
COPY scripts/package.json scripts/pnpm-lock.yaml scripts/
COPY keeper/package.json keeper/pnpm-lock.yaml keeper/
RUN pnpm -C scripts install --frozen-lockfile && pnpm -C keeper install --frozen-lockfile
COPY . .
CMD ["sh", "deploy/railway-devnet/start.sh"]
