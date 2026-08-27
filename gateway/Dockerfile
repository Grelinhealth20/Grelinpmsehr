# syntax=docker/dockerfile:1.7

# ============================================================================
# Grelin Health — PMS & EHR  ·  GATEWAY image (public edge)
# ----------------------------------------------------------------------------
# The ONLY internet-facing service:
#   • WAF — SQLi / XSS / traversal-LFI / RCE signatures, scanner-UA + IP lists
#   • Helmet hardened headers, strict CSP, HSTS
#   • Edge rate limiting (global + stricter on /api/auth)
#   • /api      → reverse-proxied to the backend, injecting INTERNAL_API_KEY
#   • anything else → reverse-proxied to the frontend (SPA) container
#
# Build:  docker build -t grelin-gateway ./gateway
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
    GATEWAY_HOST=0.0.0.0 \
    GATEWAY_PORT=6002 \
    GATEWAY_HTTPS_PORT=6004 \
    INTERNAL_API_URL=http://backend:6000 \
    FRONTEND_ORIGIN=http://frontend:6001

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src

# Writable dir for the self-signed TLS cert generated on first boot when
# NODE_ENV=production (or GATEWAY_TLS=true).
RUN mkdir -p /app/certs \
 && addgroup -S grelin && adduser -S grelin -G grelin \
 && chown -R grelin:grelin /app
USER grelin

EXPOSE 6002 6004

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${GATEWAY_PORT}/healthz >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
