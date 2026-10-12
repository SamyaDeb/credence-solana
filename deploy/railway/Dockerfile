# Railway data host (deploy/railway/runner.ts). Build context: the directory deploy/railway/stage.sh assembles.
FROM rust:1.96-bookworm AS helpers
RUN apt-get update && apt-get install -y --no-install-recommends clang libclang-dev pkg-config libssl-dev libudev-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY programs programs
# The program's pricing as host binaries. overflow-checks stay on (the workspace's release profile); fat LTO and one
# codegen unit only cost build time here.
ENV CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
RUN cargo build --release -p credence-core --example gap_feed --example shadow_quote --example unlock_quote

FROM node:24-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.18.3 --activate
WORKDIR /app
COPY scripts/package.json scripts/pnpm-lock.yaml scripts/
COPY keeper/package.json keeper/pnpm-lock.yaml keeper/
COPY packages/sdk/package.json packages/sdk/pnpm-lock.yaml packages/sdk/
RUN pnpm -C scripts install --frozen-lockfile && pnpm -C keeper install --frozen-lockfile && pnpm -C packages/sdk install --frozen-lockfile
COPY --from=helpers /src/target/release/examples/gap_feed /src/target/release/examples/shadow_quote /src/target/release/examples/unlock_quote target/release/examples/
COPY . .
RUN mkdir -p data
CMD ["scripts/node_modules/.bin/tsx", "deploy/railway/runner.ts"]
