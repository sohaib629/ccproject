# StockSync API image.
# Multi-arch base: the same Dockerfile builds arm64 (your Mac, minikube) and
# amd64 (DigitalOcean nodes, via `docker buildx --platform linux/amd64` or CI).
FROM node:24-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first, in their own layer: rebuilding after a code change
# reuses this cached layer instead of reinstalling everything.
# `npm ci` installs exactly what package-lock.json pins (reproducible builds).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Do not run as root. Files stay root-owned, so the app cannot modify its own code.
USER node

EXPOSE 3000

# Run node directly (not `npm start`) so SIGTERM from Docker/Kubernetes reaches
# the app and triggers graceful shutdown.
CMD ["node", "src/server.js"]
