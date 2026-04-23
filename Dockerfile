# syntax=docker/dockerfile:1
FROM node:20-slim

# ca-certificates so outbound HTTPS (Google, Gemini) works out of the box.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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

CMD ["node", "server.js"]
