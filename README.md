# Grelin Health — PMS & EHR

Enterprise-grade, HIPAA-oriented Patient Management System / EHR platform.
**MySQL** database · **Node.js** backend · **React** frontend · hardened security gateway with a built-in **WAF**.

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
┌──────────────────────────────────────────┐
│  gateway/  — PUBLIC service (port 8080)   │
│  • WAF (SQLi/XSS/traversal/RCE/scanner)   │
│  • Helmet CSP, HSTS, rate limiting        │
│  • Serves the React build                 │
│  • Injects internal API key, proxies /api │
└───────────────┬──────────────────────────┘
                │  loopback only (127.0.0.1)
                ▼
┌──────────────────────────────────────────┐
│  backend/  — INTERNAL API (port 4000)     │
│  • Never publicly exposed (loopback bind) │
│  • Argon-class scrypt password hashing    │
│  • AES-256-GCM PHI field encryption       │
│  • JWT (httpOnly cookies) + CSRF + RBAC   │
│  • Audit logging, account lockout         │
└───────────────┬──────────────────────────┘
                │
                ▼
        MySQL  (grelin_pmsehr @ 3.130.239.42)
```

The three tiers are isolated: **only the gateway is internet-facing.** The API
binds to `127.0.0.1` and, in production, additionally rejects any request that
does not carry the shared `INTERNAL_API_KEY` the gateway injects — so no API
endpoint is ever directly reachable.

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
| **Rate limiting** | Edge (gateway) + per-endpoint (auth) limits |

---

## First-time setup

Install dependencies (works despite the folder name — no native builds):

```bash
cd "backend"  && npm install
cd "../gateway" && npm install
cd "../frontend" && npm install
```

The `.env` files are **already created and integrated** with live secrets and
the MySQL credentials. (Regenerate secrets any time with
`node backend/src/scripts/keygen.js`.)

---

## Running (from this folder — use `node` directly)

Open three terminals:

**1 · Backend API** (auto-creates the 5 MySQL tables + seeds the master admin on first boot)
```bash
cd "backend"
node src/server.js
```

**2 · Build the frontend** (once, or after UI changes)
```bash
cd "frontend"
node node_modules/vite/bin/vite.js build
```

**3 · Gateway** (serves the built SPA + WAF + proxy)
```bash
cd "gateway"
node src/server.js
```

Then open **http://localhost:8080**.

> On a normally-named path you can instead use `npm start` (backend, gateway)
> and `npm run build` (frontend).

### Optional: hot-reload dev mode
```bash
cd "frontend" && node node_modules/vite/bin/vite.js   # http://localhost:5173
```
The dev server proxies `/api` to the gateway, so requests still pass through the
WAF/proxy layer exactly as in production.

---

## First login

1. Go to **http://localhost:8080**
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

- [ ] Deploy from a path without spaces/`&`; run via `npm start` or a process manager (pm2/systemd).
- [ ] Set `NODE_ENV=production` in both `.env` files (enables Secure cookies, HSTS, and gateway-key enforcement).
- [ ] Terminate TLS in front of the gateway (nginx/ALB) or add TLS to it; set `DB_SSL=true`.
- [ ] Rotate all secrets in the `.env` files; store them in a secrets manager, not on disk.
- [ ] Restrict the MySQL security group to the backend host only.
- [ ] Ship gateway/audit logs to a SIEM; review the audit trail regularly.
```
