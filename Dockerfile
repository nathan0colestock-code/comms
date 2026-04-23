# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

# ca-certificates so outbound HTTPS (Google, Gemini) works out of the box.
# curl + tar so we can fetch and unpack the litestream binary below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar \
 && rm -rf /var/lib/apt/lists/*

# Litestream — continuous SQLite replication to R2. We install the binary
# into /usr/local/bin so it's on PATH for the CMD wrapper below.
RUN curl -L https://github.com/benbjohnson/litestream/releases/download/v0.3.13/litestream-v0.3.13-linux-amd64.tar.gz \
    | tar xz -C /usr/local/bin/

WORKDIR /app

# Install production deps against the lockfile first to keep the layer cache
# from busting every time source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# App source. .dockerignore keeps data/, test/, .git, etc. out.
COPY . .

ENV NODE_ENV=production \
    PORT=3748

EXPOSE 3748

# node-only healthcheck (slim image has no curl/wget).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3748)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Litestream wraps the node process. It restores the DB on boot (if the
# replica is newer than /data/comms.db), then runs `node server.js` while
# continuously replicating WAL frames to R2.
CMD ["litestream", "replicate", "-exec", "node server.js", "-config", "/app/litestream.yml"]
