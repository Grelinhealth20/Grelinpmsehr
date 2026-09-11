# ============================================================================
# Grelin Health — PMS & EHR  ·  FRONTEND image (React SPA)
# ----------------------------------------------------------------------------
# Multi-stage build:
# 1. Compiles React SPA with Vite
# 2. Serves static distribution with unprivileged Nginx on internal port 6001
# ============================================================================

# ---- stage 1: compile the SPA ----------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- stage 2: serve static build -------------------------------------------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Replace default server config with SPA history-fallback and caching rules
COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /app/dist /usr/share/nginx/html

EXPOSE 6001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:6001/_health >/dev/null 2>&1 || exit 1
