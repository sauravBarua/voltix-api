# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# ── base: Node + pnpm (version pinned by the packageManager field) ──
FROM node:${NODE_VERSION}-alpine AS base
ENV npm_config_store_dir=/pnpm/store
RUN corepack enable
WORKDIR /app

# ── deps: every dependency, installed from the lockfile only ──
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY .npmrc* pnpm-workspace.yaml* ./
# HUSKY=0: the "prepare" script must not try to install git hooks inside the image
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    HUSKY=0 pnpm install --frozen-lockfile

# ── build: Prisma client + compiled JavaScript ──
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
# prisma.config.ts reads DATABASE_URL; generating the client does not connect, so a placeholder is enough
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm exec prisma generate && pnpm exec nest build
# nest build only emits files compiled from TypeScript: carry any other generated file (e.g. WASM) into dist
RUN cd src/generated/prisma \
 && find . -type f ! -name '*.ts' | while read -r f; do \
      mkdir -p "/app/dist/generated/prisma/$(dirname "$f")" \
      && cp "$f" "/app/dist/generated/prisma/$f"; \
    done

# ── tools: migrations and seed (has the Prisma CLI and tsx, which the runtime image does not) ──
FROM build AS tools
RUN pnpm exec prisma --version
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ── prod-deps: runtime dependencies only ──
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
COPY .npmrc* pnpm-workspace.yaml* ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts

# ── runtime: what actually runs (API and worker share it) ──
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]