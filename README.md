# Grelin Health — PMS & EHR

Enterprise-grade, HIPAA-oriented Patient Management System / EHR platform.
**MySQL** database · **Node.js** backend (with a built-in edge: **WAF**, TLS, hardened headers, SPA proxy) · **React** frontend.

> ⚠️ **Folder-name note (Windows):** this project lives in a folder whose name
> contains a space and an `&` (`Grelin Health PMS & EHR`). On Windows, `npm`
> runs scripts through `cmd.exe`, and the `&` breaks npm run-scripts and native
> module builds. This project is deliberately built with **no native
> dependencies** and is launched with **`node` directly** (see commands below),
> so it runs fine as-is. For production, deploy from a path **without spaces or
> `&`** (e.g. `C:\apps\grelin-pms`) so `npm start` works normally.

---

## Architecture

```
Browser (React SPA)
      │  HTTPS
      ▼
┌────────────────────────────────────────────────────────┐
│  backend/  — SINGLE PUBLIC EDGE (COMBINED_EDGE)         │
│  • Terminates TLS (443) + HTTP→HTTPS redirect (80)      │
│  • WAF (SQLi/XSS/traversal/RCE/scanner) + IP lists      │
│  • Helmet strict SPA CSP, HSTS, rate limiting           │
│  • Serves /api IN-PROCESS (no proxy hop):               │
│      scrypt passwords · AES-256-GCM PHI encryption ·    │
│      JWT (httpOnly cookies) + CSRF + RBAC · audit log   │
│  • Reverse-proxies every non-/api request to frontend   │
└───────────┬───────────────────────────────┬────────────┘
            │ non-/api (SPA)                 │
            ▼                                ▼
   ┌──────────────────┐              MySQL (grelin_pmsehr)
   │ frontend/ (:6001)│              (PHI over TLS, pinned CA)
   │ React SPA (dist) │  ← served by YOUR nginx (built via vite; no nginx in this repo)
   └──────────────────┘
```

There is **one internet-facing service** — the backend edge. The frontend and OCR
containers are private (no host ports); the browser only ever reaches them through
the backend's reverse-proxy, so the WAF / CSP / rate-limits sit in front of every
request and `/api` shares the SPA's origin. Unknown `/api/*` paths return a JSON 404
(never proxied to the SPA). *(The former standalone gateway has been folded in.)*

---

## Security features (SOC 2 / VAPT / HIPAA-oriented)

| Area | Control |
|------|---------|
| **PHI at rest** | AES-256-GCM authenticated field-level encryption; HMAC-SHA256 blind index for searchable-but-encrypted identifiers |
| **Passwords** | scrypt (memory-hard) hashing, per-user salt; 12-char policy with complexity + history (no reuse) |
| **Sessions** | JWT in `httpOnly` + `Secure` + `SameSite=Strict` cookies (never localStorage); short access token + rotating refresh token; revoke-all on credential change |
| **CSRF** | Double-submit token on all state-changing requests |
| **AuthN/Z** | Forced first-login password reset; RBAC (master_admin / super_admin / billing / provider); account lockout after failed attempts |
| **WAF** | Signature detection for SQLi, XSS, path traversal/LFI, command injection; scanner-UA + IP block/allow lists; monitor or blocking mode |
| **Transport/Headers** | Helmet, strict CSP, HSTS, `X-Frame-Options: DENY`, no-referrer, no `x-powered-by` |
| **Input** | Zod schema validation, strict unknown-field rejection, small body caps |
| **Auditing** | Append-only audit log (§164.312(b)) + login-attempt forensics |
| **Frontend** | Idle auto-logout (§164.312(a)(2)(iii)), no secrets in JS storage, React auto-escaping (no `dangerouslySetInnerHTML`), client password-policy feedback |
| **Rate limiting** | In-process edge global limit + stricter per-endpoint (auth) limits |

---

## First-time setup

Install dependencies (works despite the folder name — no native builds):

```bash
cd "backend"  && npm install
cd "../frontend" && npm install
```

The `.env` files are **already created and integrated** with live secrets and
the MySQL credentials. (Regenerate secrets any time with
`node backend/src/scripts/keygen.js`.)

---

## Running (from this folder — use `node` directly)

The backend is the single edge (WAF + `/api` + SPA proxy). Two terminals:

**1 · Backend edge + API** (auto-creates the MySQL tables + seeds the master admin on first boot)
```bash
cd "backend"
COMBINED_EDGE=true GATEWAY_TLS=false GATEWAY_PORT=8080 FRONTEND_ORIGIN=http://localhost:5173 node src/server.js
```
> Serves `/api` in-process and reverse-proxies everything else to the frontend dev server.
> `GATEWAY_TLS=false` runs plain HTTP for dev; set it `true` (with `TLS_CERT_PATH`/`TLS_KEY_PATH`) for HTTPS.

**2 · Frontend dev server** (React, hot-reload)
```bash
cd "frontend" && node node_modules/vite/bin/vite.js   # http://localhost:5173
```
The Vite dev server serves the SPA and proxies `/api` to the backend edge (`:8080`), so every
request passes through the WAF exactly as in production. Open **http://localhost:5173**.

> On a normally-named path you can instead use `npm start` (backend) and `npm run dev` (frontend).

---

## First login

1. Go to **http://localhost:5173** (dev) — or the backend edge origin directly if you built the SPA.
2. Sign in with the master administrator:
   - **Email:** `git@grelinhealth.com`
   - **Password:** `Grelin@2026!!`
3. You will be **required to set a new password** before continuing.
4. As master/super admin you land in the **Super Admin Panel**, where you can
   create Super Admins, Providers, and Billing users; set system access levels;
   edit users; reset passwords; restrict/disable access; and delete accounts.

Providers and billing users land in the **PMS System** shell (intentionally
blank — header + session only — ready for clinical modules).

---

## Database tables (auto-created)

`users`, `password_history`, `refresh_tokens`, `audit_logs`, `login_attempts`
— all `CREATE TABLE IF NOT EXISTS`, so startup is safe and idempotent.

---

## Production hardening checklist

> **Deploying on AWS?** See the full **[AWS Production Deployment Guide](AWS_DEPLOYMENT.md)** —
> a system-specific runbook (RDS TLS, IAM roles, Secrets Manager, ECS/ALB + ACM, S3
> posture already applied, ElastiCache-backed rate limiting, CloudWatch/CloudTrail).

- [ ] Deploy from a path without spaces/`&`; run via `npm start` or a process manager (pm2/systemd).
- [ ] Set `NODE_ENV=production` in `.env` (enables Secure cookies + HSTS) and `COMBINED_EDGE=true`.
- [ ] Terminate TLS at the backend edge (`GATEWAY_TLS=true` + `TLS_CERT_PATH`/`TLS_KEY_PATH`) or an ALB in front (`TRUST_PROXY=1`); set `DB_SSL=true`.
- [ ] Rotate all secrets in the `.env` file; store them in a secrets manager, not on disk.
- [ ] Restrict the MySQL security group to the backend host only.
- [ ] Ship edge/audit logs to a SIEM; review the audit trail regularly.
```
