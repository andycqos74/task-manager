# ---- Stage 1: build the React frontend into static files ----
FROM node:22-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- Stage 2: install server dependencies (better-sqlite3 is a native
#      module, so this stage needs a C/C++ toolchain to compile it) ----
FROM node:22-slim AS server-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 3: slim runtime image ----
# Reuses the same node:22-slim base as the deps stage, so the compiled
# better-sqlite3 binary is ABI-compatible. No build tools ship in the
# final image.
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3001

WORKDIR /app/server
COPY server/ ./
COPY --from=server-deps /app/server/node_modules ./node_modules
# The server serves the built frontend from ../client/dist relative to itself.
COPY --from=client /app/client/dist ../client/dist

# SQLite database lives on a volume so data survives container recreation.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3001
VOLUME ["/data"]
CMD ["node", "index.js"]
