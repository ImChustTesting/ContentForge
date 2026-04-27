# syntax=docker/dockerfile:1.7
# Build context is the project root (see docker-compose.yml).

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY app/src ./src
COPY app/package.json ./
# Migrations live in /db/migrations relative to the project root,
# resolved by app/src/lib/migrate.js (../db/migrations from process.cwd()).
COPY db /db

# Vendor htmx at build time. Pinned for reproducibility.
RUN mkdir -p src/public \
 && curl -fsSL -o src/public/htmx.min.js \
        https://unpkg.com/htmx.org@2.0.3/dist/htmx.min.js \
 && test -s src/public/htmx.min.js

# Make sure the non-root user owns its files
RUN chown -R node:node /app /db

USER node
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
