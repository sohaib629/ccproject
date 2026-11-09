# StockSync frontend image (multi-stage).
#   Stage 1: build the React app with Node.
#   Stage 2: serve the static files with nginx. Node, npm and the source code are
#            not in the final image, which keeps it small (~20 MB) and simple.

# ---- build ----
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- serve ----
# nginx-unprivileged runs as a non-root user and listens on 8080.
FROM nginxinc/nginx-unprivileged:stable-alpine
ENV API_UPSTREAM=http://api:3000
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
