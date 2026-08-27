# syntax=docker/dockerfile:1.7

# ============================================================================
# Grelin Health — PMS & EHR  ·  FRONTEND image (React SPA)
# ----------------------------------------------------------------------------
# Compiles the React app with Vite and serves the static build with nginx.
#
# PRIVATE service: it is not published to the host. The gateway reverse-proxies
# browser traffic to it, so the WAF / CSP / rate limiting still sit in front of
# every request and the SPA and /api keep the same public origin.
#
# Build:  docker build -t grelin-frontend ./frontend
# ============================================================================

# ---- stage 1: compile the SPA ----------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build          # → /app/dist (per vite.config.js)


# ---- stage 2: serve the static build ---------------------------------------
# Unprivileged nginx: runs as a non-root user out of the box.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Replace the stock server block with the SPA config (history fallback, caching).
COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html

EXPOSE 6001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:6001/_health >/dev/null 2>&1 || exit 1
