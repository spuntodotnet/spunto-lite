# Pinned on purpose, patch version included. `node:24-bookworm-slim` floats, so a
# rebuild silently swapped the runtime under our native addons: Node 24.19.0 added
# cleanup hooks to `node::ObjectWrap` (nodejs/node#63642), and every NAN-style addon
# built against it aborts the process the moment the GC finalizes one of its objects
# (`Assertion failed: (env) != nullptr` in `RemoveEnvironmentCleanupHook`). Bumping
# this is a deliberate step: check the native deps still behave first.
FROM node:24.20.0-bookworm-slim

# A native dep may still need a toolchain when no prebuild matches its platform
# (better-sqlite3 ships its own since v13); ca-certificates for HTTPS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80

CMD ["npm", "run", "start"]
