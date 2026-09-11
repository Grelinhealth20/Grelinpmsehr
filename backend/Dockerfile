# syntax=docker/dockerfile:1.7

# ============================================================================
# Grelin Health — PMS & EHR  ·  BACKEND image (Node.js API + Edge)
# ----------------------------------------------------------------------------
# Combined Edge architecture: serves /api in-process, applies WAF / rate limits,
# hardened security headers, and proxies non-/api requests to the frontend SPA.
#
# Multi-stage build with unprivileged runtime user and tini process supervisor.
# ============================================================================

# ---- stage 1: production dependencies --------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- stage 2: production runtime -------------------------------------------
FROM node:20-alpine AS runtime

# Install tini for proper PID 1 signal forwarding (SIGTERM / SIGINT) and wget for healthchecks
RUN apk add --no-cache tini wget

ENV NODE_ENV=production \
  COMBINED_EDGE=true \
  GATEWAY_HOST=0.0.0.0 \
  GATEWAY_PORT=8080 \
  GATEWAY_TLS=false \
  API_HOST=0.0.0.0 \
  API_PORT=6000

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY certs ./certs

# Hardened unprivileged user
RUN addgroup -S grelin && adduser -S grelin -G grelin && chown -R grelin:grelin /app
USER grelin

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${GATEWAY_PORT}/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
