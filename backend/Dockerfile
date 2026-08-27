# syntax=docker/dockerfile:1.7

# ============================================================================
# Grelin Health — PMS & EHR  ·  BACKEND image (internal API)
# ----------------------------------------------------------------------------
# The internal API. NEVER published to the host — it is reachable only on the
# private compose network, and the frontend/gateway container proves it is the
# caller by injecting the shared INTERNAL_API_KEY header.
#
# Note: inside a container we must bind 0.0.0.0 (not 127.0.0.1) so the gateway
# container can reach it. Isolation is preserved by NOT mapping this port to
# the host, plus the internal-key check enforced in production.
#
# Build (from repo root):  docker build -t grelin-backend ./backend
# ============================================================================

# ---- deps: production node_modules only ------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ---- runtime ---------------------------------------------------------------
FROM node:20-alpine AS runtime
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=6000

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src

RUN addgroup -S grelin && adduser -S grelin -G grelin && chown -R grelin:grelin /app
USER grelin

EXPOSE 6000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${API_PORT}/api/health >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
