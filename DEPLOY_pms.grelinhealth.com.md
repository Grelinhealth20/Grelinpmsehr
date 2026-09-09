# Go-Live Runbook — `pms.grelinhealth.com` (single EC2, backend terminates TLS)

This is the exact, copy-paste path to a smooth AWS production deployment. Topology:
**one EC2 box** running the 3 containers from `docker-compose.aws.yml`. The **backend IS the public
edge** (`COMBINED_EDGE=true`) — it terminates TLS on 443 with the real Sectigo `*.grelinhealth.com`
cert (no ALB, no separate gateway), runs the WAF + hardened headers + rate limits, serves `/api`
in-process, and reverse-proxies the SPA to the private frontend container.

```
Internet ──443/80──▶ EC2 [ backend(443→6004, 80→6002) = edge+API ]──► frontend(6001) / ocr(6003) ──TLS──▶ MySQL
```

Registry: `285529798033.dkr.ecr.us-east-2.amazonaws.com/grelin-health` · region `us-east-2`.

---

## 0. Prerequisites (one-time)
- [ ] **DNS**: `pms.grelinhealth.com` A-record → the EC2 **Elastic IP**.
- [ ] **EC2 security group** inbound: **443** and **80** from `0.0.0.0/0`; **22** from your IP only.
- [ ] EC2 has **Docker + docker compose** and an **IAM role** (or `aws configure`) allowing ECR pull.
- [ ] **MySQL security group** allows **3306** inbound from the EC2's SG.
- [ ] Cert files present locally at `certs/` (gitignored): `pms_grelinhealth_fullchain.crt` +
      `pms_grelinhealth.key`, and the pinned DB CA at `backend/certs/db-ca.pem`.

---

## 1. Build + push all 3 images to ECR  *(run where Docker is — CI or a build box)*
> The compose file PULLS `:*_latest` from ECR — production runs whatever is in ECR, **not** your
> working tree. You MUST rebuild+push after every code change or the deploy runs stale code.

```bash
export ACCT=285529798033 REGION=us-east-2 REPO=grelin-health
export REG=$ACCT.dkr.ecr.$REGION.amazonaws.com

aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REG

# Build each service for the EC2 architecture (linux/amd64):
docker build --platform linux/amd64 -t $REG/$REPO:grelin_ehr_pms_backend_latest  ./backend
docker build --platform linux/amd64 -t $REG/$REPO:grelin_ehr_pms_frontend_latest ./frontend
docker build --platform linux/amd64 -t $REG/$REPO:grelin_ehr_pms_ocr_latest      ./ocr-service

docker push $REG/$REPO:grelin_ehr_pms_backend_latest
docker push $REG/$REPO:grelin_ehr_pms_frontend_latest
docker push $REG/$REPO:grelin_ehr_pms_ocr_latest
```

---

## 2. On the EC2 box — put the secrets + certs in place
```bash
git clone <repo> grelin && cd grelin        # or: git pull
```

**a. Copy the cert + key onto the box** (they are gitignored, so `git pull` will NOT bring them):
```bash
# from your machine:
scp certs/pms_grelinhealth_fullchain.crt ec2-user@<EC2>:~/grelin/certs/
scp certs/pms_grelinhealth.key           ec2-user@<EC2>:~/grelin/certs/
scp backend/certs/db-ca.pem              ec2-user@<EC2>:~/grelin/backend/certs/
# on the box, make the key readable by the container user (node uid) but not world-writable:
chmod 644 ~/grelin/certs/pms_grelinhealth.key
```

**b. Create `.env` next to `docker-compose.aws.yml`** (compose reads it for `${...}`):
```bash
cat > .env <<'EOF'
GATEWAY_ORIGIN=https://pms.grelinhealth.com
DB_HOST=<mysql host>            # e.g. 3.130.239.42 or the RDS endpoint
DB_PORT=3306
DB_USER=<db-user>
DB_PASSWORD=<db-password>
DB_NAME=grelin_pmsehr
PHI_ENC_KEY=<base64 32-byte>
BLIND_INDEX_KEY=<base64 32-byte>
JWT_ACCESS_SECRET=<64-char-random>
JWT_REFRESH_SECRET=<64-char-random>
S3_BUCKET=pms-ehr
S3_REGION=us-east-2
AWS_ACCESS_KEY_ID=<...>         # omit if the EC2 IAM role grants S3
AWS_SECRET_ACCESS_KEY=<...>
OCR_API_KEY=<...>
MASTER_ADMIN_EMAIL=<admin@grelinhealth.com>
MASTER_ADMIN_PASSWORD=<strong>
MASTER_ADMIN_NAME=Master Administrator
STEDI_API_KEY=<...>
EOF
chmod 600 .env
```
> The PHI/JWT keys must be the **same values already in use** — regenerating `PHI_ENC_KEY`
> makes existing encrypted PHI unreadable. Reuse the current production keys.
> There is no `INTERNAL_API_KEY` any more — the backend is the edge; there is no internal handshake.

---

## 3. Deploy
```bash
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 285529798033.dkr.ecr.us-east-2.amazonaws.com
docker compose -f docker-compose.aws.yml pull
docker compose -f docker-compose.aws.yml up -d
docker compose -f docker-compose.aws.yml ps        # all should be "healthy"
docker compose -f docker-compose.aws.yml logs -f grelin-ehr-pms-backend | head -50
```

---

## 4. Post-deploy smoke tests  *(run from your laptop)*
```bash
# TLS is valid + publicly trusted (no -k):
curl -sS https://pms.grelinhealth.com/healthz                       # {"status":"ok","service":"grelin-pms"}
curl -sS https://pms.grelinhealth.com/api/health                    # {"status":"ok","service":"grelin-pms-api"}
curl -sS -o /dev/null -w "%{http_code}\n" http://pms.grelinhealth.com/ehr   # 301 → https
curl -sS -o /dev/null -w "%{http_code}\n" https://pms.grelinhealth.com/api/patients   # 401 (auth required)
curl -sS -o /dev/null -w "%{http_code}\n" "https://pms.grelinhealth.com/api/health?q=1%20union%20select%201"  # 403 (WAF)
curl -sS -o /dev/null -w "%{http_code}\n" https://pms.grelinhealth.com/api/does-not-exist   # 404 (JSON, not proxied to SPA)
# cert chain served correctly:
echo | openssl s_client -connect pms.grelinhealth.com:443 -servername pms.grelinhealth.com 2>/dev/null | openssl x509 -noout -subject -dates
```
Then open `https://pms.grelinhealth.com/` in a browser → login → confirm Secure cookies (`gh_at`
`Secure; HttpOnly; SameSite=Strict`) in devtools.

---

## 5. Update a running deployment (new code)
```bash
# rebuild+push (step 1) → then on EC2:
docker compose -f docker-compose.aws.yml pull && docker compose -f docker-compose.aws.yml up -d
```

## 6. Rollback
```bash
# ECR keeps prior image digests. Re-tag the last-known-good digest to *_latest and re-pull,
# or pin the compose image to a specific digest and `up -d`.
```

---

## Cert renewal — IMPORTANT
This cert expires **Nov 19 2026** (short 78-day term). Before then: reissue/renew on Namecheap
with the **same key** (`certs/pms_grelinhealth.key`) — generate a CSR from it:
```bash
openssl req -new -key certs/pms_grelinhealth.key -out renew.csr -subj "/CN=*.grelinhealth.com"
```
Paste `renew.csr`, complete DCV, drop the new fullchain in `certs/`, then
`docker compose -f docker-compose.aws.yml restart grelin-ehr-pms-backend`.
