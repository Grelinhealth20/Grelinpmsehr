# Grelin Health PMS & EHR — AWS Production Deployment Guide

This guide takes the three-tier application (gateway → backend → MySQL, plus the OCR
microservice and S3 for documents) to a hardened, HIPAA-oriented AWS deployment. It is
specific to **this** codebase: every environment variable, port, and control below maps
to real code, not a generic template.

> **Scope.** The application code is production-grade (AES-256-GCM PHI encryption, RBAC,
> CSRF, audit logging, key rotation, WAF). What this guide adds is the **deployment
> wrapper**: managed data, IAM roles instead of long-lived keys, TLS at the edge,
> secrets management, container/process supervision, a shared rate-limit store, and
> observability.

---

## 1. Target architecture

```
                       Route 53 (DNS)
                            │
                    ┌───────▼────────┐   ACM certificate (public TLS)
                    │  Application   │◄──────────────
                    │  Load Balancer │   HTTPS :443
                    └───────┬────────┘
                            │  HTTP/HTTPS to gateway (private subnet)
            ┌───────────────▼──────────────────────────┐
            │  ECS Fargate service (private subnets)    │
            │  ┌─────────────┐  loopback  ┌───────────┐ │
            │  │  gateway     │──127.0.0.1─►  backend  │ │
            │  │  :6002/:6004 │            │  :6000    │ │
            │  │  WAF+Helmet  │            └─────┬─────┘ │
            │  └─────────────┘   ┌──────────────►│       │
            │                    │  ocr :6003    │       │
            │              ┌─────┴──────┐        │       │
            │              │ ocr-service│        │       │
            │              └────────────┘        │       │
            └──────────────────────────────────┬─┼───────┘
                     Task IAM role              │ │
             (S3 + Secrets, no static keys)     │ │
                            ┌───────────────────┘ │
                            ▼                      ▼
             ElastiCache (Redis)          RDS MySQL (Multi-AZ, TLS)
             shared rate-limit store      grelin_pmsehr, automated backups
                            │
                            ▼
                    S3: pms-ehr (PHI docs, SSE, versioned, private)
                        pms-ehr-logs (access logs, 6-yr retention)
                            │
              CloudWatch Logs/Alarms · CloudTrail (data events) · GuardDuty
```

**Isolation invariant (already enforced in code):** only the gateway is reachable from
the ALB. The backend binds `127.0.0.1:6000` and, when `NODE_ENV=production`, rejects any
request missing the gateway-injected `INTERNAL_API_KEY`. Keep the backend and OCR
containers off the ALB target groups entirely.

---

## 2. Prerequisites

- An AWS account with Organizations/SCP guardrails, and a dedicated account or VPC for PHI.
- A registered domain in Route 53 (e.g. `app.grelinhealth.com`).
- The AWS CLI v2 and Docker installed locally.
- A signed **Business Associate Addendum (BAA)** with AWS covering every service used
  here (RDS, S3, ECS, ElastiCache, CloudWatch, Secrets Manager, KMS, ALB are all HIPAA-eligible).

---

## 3. Networking (VPC)

1. **VPC** with two public subnets (ALB only) and two private subnets (app, data) across
   two AZs.
2. **Security groups** (least privilege):
   - `sg-alb` — inbound `443` from the internet; outbound to `sg-app`.
   - `sg-app` — inbound `6004`/`6002` from `sg-alb` only; outbound to `sg-db:3306`,
     `sg-redis:6379`, and `443` (S3/Secrets/Stedi/NPPES via a NAT gateway or VPC endpoints).
   - `sg-db` — inbound `3306` from `sg-app` **only**. No public access.
   - `sg-redis` — inbound `6379` from `sg-app` only.
3. Prefer **VPC endpoints** for S3, Secrets Manager, and CloudWatch so that traffic never
   leaves the AWS network (and to drop NAT cost/exposure).
4. **Outbound internet egress is REQUIRED** for the external registries/APIs the app calls
   server-side over HTTPS (443). If the app runs in a private subnet, it needs a **NAT
   gateway** (VPC endpoints do not cover these public third parties), and `sg-app` must
   allow outbound 443:
   - **NPPES NPI Registry** — `https://npiregistry.cms.hhs.gov` (provider/facility lookup).
   - **Stedi** — `https://healthcare.us.stedi.com` (real-time eligibility + payer search).
   > Symptom when egress is missing: NPPES lookups return **"The NPPES registry could not
   > be reached"** (the service now distinguishes an unreachable registry from a genuine
   > no-match) and eligibility checks time out. Verify egress from the task with
   > `curl -sS https://npiregistry.cms.hhs.gov/api/?version=2.1\&number=1548758857`.

---

## 4. Data tier — RDS for MySQL

Move off the current self-managed MySQL (`3.130.239.42`) to **RDS MySQL 8.0**:

- Multi-AZ, encryption at rest (KMS), automated backups (≥ 7 days; longer per retention
  policy), deletion protection, minor-version auto-upgrade in a maintenance window.
- Parameter group: `require_secure_transport = ON` (force TLS).
- Restrict `sg-db` to `sg-app`. Never assign a public IP.

**TLS to the database is already implemented** in [`backend/src/db/pool.js`](backend/src/db/pool.js)
via `buildDbSsl()`:

- For RDS, download the regional **RDS CA bundle**, store it, and point `DB_SSL_CA` at it.
  RDS certificates carry the real hostname, so verification is full (chain **and**
  hostname). Set `DB_SSL=true`.
- The pinned-CA mechanism used for the self-managed server (`backend/certs/db-ca.pem`,
  hostname check skipped) remains available if you keep a self-managed instance, but RDS
  is the recommended path.

Run the idempotent migrations once against RDS: `npm run migrate` (from `backend/`).

---

## 5. Secrets — AWS Secrets Manager

Do **not** ship `.env` files to production hosts. Store secrets in Secrets Manager (KMS
CMK), grant read to the task role only, and inject at container start (ECS `secrets:` or
an entrypoint that fetches them).

### Environment reference (complete, from the code)

**Required — the app fails fast on boot if any are missing:**

| Variable | Purpose |
|----------|---------|
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | RDS connection |
| `PHI_ENC_KEY` | 32-byte base64 — AES-256-GCM PHI key |
| `BLIND_INDEX_KEY` | 32-byte base64 — HMAC blind-index key |
| `JWT_ACCESS_SECRET` `JWT_REFRESH_SECRET` | JWT signing secrets (rotation seeds) |
| `MASTER_ADMIN_EMAIL` `MASTER_ADMIN_PASSWORD` | Bootstrap master admin (rotate after first login) |

**Security / transport:**

| Variable | Recommended value |
|----------|-------------------|
| `NODE_ENV` | `production` (enables Secure cookies, HSTS, gateway-key enforcement) |
| `INTERNAL_API_KEY` | strong random; the gateway↔backend shared secret |
| `DB_SSL` | `true` |
| `DB_SSL_CA` | path to the RDS CA bundle (or the pinned `backend/certs/db-ca.pem`) |
| `DB_SSL_REJECT_UNAUTHORIZED` | `true` |
| `GATEWAY_ORIGIN` | the public origin, e.g. `https://app.grelinhealth.com` |
| `GATEWAY_TLS` | `true` if the gateway terminates TLS; `false` if the ALB does |
| `TRUST_PROXY` | `true` behind the ALB (correct client IPs in audit logs / rate limits) |
| `WAF_BLOCKING` | `true` (blocking mode, not monitor) |

**Tunables (have safe defaults):** `API_HOST` `API_PORT` `DB_CONNECTION_LIMIT`
`ACCESS_TOKEN_TTL` `REFRESH_TOKEN_TTL` `KEY_ROTATION_SECONDS` `MAX_FAILED_LOGINS`
`ACCOUNT_LOCK_MINUTES` `PASSWORD_MIN_LENGTH` `PASSWORD_HISTORY_SIZE`
`GATEWAY_PORT` `GATEWAY_HTTPS_PORT` `WAF_IP_ALLOWLIST` `WAF_IP_BLOCKLIST`.

**Integrations:** `STEDI_API_KEY` (`STEDI_BASE_URL` `STEDI_TIMEOUT_MS`),
`OCR_SERVICE_URL` `OCR_API_KEY` `OCR_TIMEOUT_MS`, `NPPES_ENABLED` `NPPES_BASE_URL`.

> Generate the crypto keys with `npm run keygen` (backend) and store the output in
> Secrets Manager — never commit them.

---

## 6. Object storage — S3 (already hardened)

The PHI bucket **`pms-ehr`** (us-east-2) is already configured to production standard and
verified:

- **Block Public Access** — all four settings ON.
- **Default encryption** — SSE-S3 `AES256` (SSE-C blocked); optionally upgrade to SSE-KMS
  with a CMK (requires the task role to hold `kms:GenerateDataKey`/`Decrypt` and a small
  code change from the explicit `AES256` header — do this deliberately, it breaks uploads
  if the grant is missing).
- **Versioning** — enabled (accidental overwrite/delete is recoverable).
- **Object Ownership** — `BucketOwnerEnforced` (ACLs disabled).
- **Bucket policy** — denies non-TLS (`aws:SecureTransport=false`) plus the AWS Config grants.
- **Lifecycle** — aborts incomplete multipart uploads after 7 days.
- **Server access logging** — ON → **`pms-ehr-logs`** (private, encrypted,
  `BucketOwnerEnforced`, TLS-only, log-delivery via bucket policy), **6-year** log retention
  (HIPAA §164.316(b)(2)).

**Change still required for AWS:** the app currently authenticates to S3 with a static
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. In AWS, **remove those** and let the SDK use
the **ECS task role / EC2 instance profile** (default credential provider chain). Grant the
task role a least-privilege policy scoped to `arn:aws:s3:::pms-ehr/*` and
`arn:aws:s3:::pms-ehr` (Get/Put/Delete/List). See §11 for the code touch-up.

---

## 7. Compute — containerize and run under ECS Fargate

**Container artifacts already exist in the repo:** `backend/Dockerfile`,
`gateway/Dockerfile`, `frontend/Dockerfile` (+ `frontend/nginx.conf`),
`ocr-service/Dockerfile`, plus `docker-compose.yml` (local) and
`docker-compose.aws.yml` (AWS). Ports follow the merged internal scheme:

| Service  | Internal port | Notes |
|----------|---------------|-------|
| backend  | **6000**      | loopback / private (`API_PORT`) |
| frontend | **6001**      | static SPA (nginx), private |
| gateway  | **6002** (HTTP) / **6004** (HTTPS) | the only public tier |
| ocr      | **6003**      | private |

Build the frontend (`vite build`) and serve `dist/` — the compose does this via the
frontend image + `nginx.conf`. Run the tiers as one ECS task (so the gateway reaches the
backend over loopback) or as separate services behind service discovery; either way, only
the gateway (`:6002`/`:6004`) is mapped into the ALB target group.

**ECS task definition notes:**

- Put `gateway`, `backend`, and `ocr-service` as containers in one task so
  `127.0.0.1` loopback holds between them (matches the code's isolation model). The
  gateway is the only container mapped into the ALB target group.
- Inject secrets via the task definition `secrets` block (from Secrets Manager).
- Attach the **task role** (S3 + Secrets read); attach a separate **execution role** for
  image pull + log writes.
- Health checks: `GET /api/health` on the gateway; `GET /api/health` on the backend
  (loopback). Both already exist and return `{"status":"ok"}`.
- Graceful shutdown is implemented (SIGTERM/SIGINT in both `server.js`); set a stop
  timeout ≥ 30s so in-flight requests drain.

> Alternative: EC2 + `systemd` units (`grelin-backend.service`, `grelin-gateway.service`,
> `grelin-ocr.service`) with `Restart=always`. Deploy from a path **without spaces or `&`**
> — the repo's own folder name breaks `npm`'s script runner, so on a server use a clean
> path like `/opt/grelin`.

---

## 8. Edge & TLS

- Request an **ACM certificate** for the domain; attach it to the **ALB** HTTPS listener
  (`:443`). The ALB terminates public TLS. Set `GATEWAY_TLS=false` and let the gateway
  serve HTTP on `:6002` to the ALB inside the private subnet — or keep gateway TLS
  (`GATEWAY_TLS=true`, self-signed internal cert) for end-to-end encryption.
- The gateway already sends **HSTS** (1 year, preload) in production and pins **TLS 1.2**
  as the floor; keep `NODE_ENV=production`.
- Set `TRUST_PROXY=true` so `X-Forwarded-For` yields real client IPs for the audit trail
  and rate limiter.
- Front the ALB with **AWS WAF** (managed rule groups) in addition to the app-layer WAF
  for defense in depth.

---

## 9. Horizontal scale — shared rate-limit store

Rate limiting is currently in-memory (`express-rate-limit` default store), which is
**per-instance**. Behind the ALB with more than one task, limits are not global. For
correct throttling at scale, back the limiter with **ElastiCache (Redis)** using
`rate-limit-redis`, and point both the gateway edge limiter and the backend auth limiter
at it. The rest of the app is stateless (JWT sessions; key-rotation ring persisted in the
`security_keyring` DB table), so tasks scale out cleanly. Configure ECS **service
auto-scaling** on CPU/ALB-request-count.

---

## 10. Observability & compliance

- **CloudWatch Logs**: ship gateway, backend, and OCR stdout (structured pino JSON).
  Create metric filters + alarms for `auth.login.failure` spikes, `auth.account.locked`,
  5xx rates, and DB connection errors.
- **CloudTrail**: enable **S3 data events** for `pms-ehr` (API-level access on PHI objects)
  — complements the bucket's server access logging. Command:
  ```bash
  aws cloudtrail put-event-selectors --region us-east-2 --trail-name <trail> \
    --advanced-event-selectors '[{"Name":"S3 data events for pms-ehr","FieldSelectors":[{"Field":"eventCategory","Equals":["Data"]},{"Field":"resources.type","Equals":["AWS::S3::Object"]},{"Field":"resources.ARN","StartsWith":["arn:aws:s3:::pms-ehr/"]}]}]'
  ```
- **GuardDuty** + **AWS Config** on the PHI account.
- The application's own **append-only audit trail** (`audit_logs`, surfaced in the Super
  Admin activity console) covers §164.312(b); export it to your SIEM on a schedule.

---

## 11. Code touch-ups for AWS (small, tracked separately)

The **Dockerfiles and compose files are already in the repo** (§7). The remaining
application changes the AWS move needs — neither alters functionality — are:

1. **IAM role instead of static keys.** Let the S3 client use the default credential
   provider chain when `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are absent, so the ECS
   task role is used. (Today S3 disables itself if the keys are unset.)
2. **Redis-backed rate limiter** (§9), defaulting to in-memory when `REDIS_URL` is unset
   (keeps local dev unchanged).

Ask and these can be implemented behind env flags so local development is untouched.

---

## 12. Go-live checklist

- [ ] BAA with AWS in place; PHI isolated to its account/VPC.
- [ ] RDS MySQL: Multi-AZ, encrypted, `require_secure_transport=ON`, SG limited to `sg-app`, backups on.
- [ ] `DB_SSL=true` with the RDS CA bundle; migrations run; boot log shows `tls: on (...)`.
- [ ] All secrets in Secrets Manager (KMS); no `.env` on disk; crypto keys from `keygen`; master-admin password rotated after first login.
- [ ] S3 `pms-ehr` hardened (already done) — re-verify BPA, TLS-only, versioning, logging, 6-yr retention.
- [ ] App uses the **task role** for S3 (static keys removed).
- [ ] ECS task: gateway + backend + ocr, secrets injected, health checks green, stop timeout ≥ 30s.
- [ ] Only the gateway is in the ALB target group; `NODE_ENV=production`, `INTERNAL_API_KEY` enforced, `TRUST_PROXY=true`.
- [ ] ACM cert on the ALB `:443`; HSTS confirmed; AWS WAF attached.
- [ ] ElastiCache Redis wired for rate limiting; ECS auto-scaling configured.
- [ ] CloudWatch alarms, CloudTrail S3 data events, GuardDuty, Config enabled; audit trail exported to SIEM.
- [ ] MySQL SG confirmed closed to the internet; VPC endpoints for S3/Secrets/CloudWatch.

---

## Appendix — what is already production-grade in the codebase

- AES-256-GCM PHI field encryption with fail-fast 32-byte key validation; HMAC-SHA256 blind index.
- **Verified DB TLS** with a pinned CA (`buildDbSsl()` in `backend/src/db/pool.js`).
- JWT key **rotation persisted** in `security_keyring` (survives restarts; multi-instance safe for reads).
- Gateway WAF, Helmet CSP, HSTS, TLS 1.2 floor, HTTP→HTTPS redirect, edge + auth rate limits.
- RBAC + service-line data isolation; CSRF double-submit; account lockout; forced first-login reset.
- Graceful shutdown (SIGTERM/SIGINT) on both Node tiers; idempotent migrations on boot.
- Append-only audit trail with a plain-language Super Admin console (real-time).
- **S3 PHI bucket hardened and access-logged** (§6); 6-year log retention.

The gaps this guide closes are all in the deployment layer — not the application.
