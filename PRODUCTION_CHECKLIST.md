# SPARK ADMIN - PRODUCTION DEPLOYMENT & RELEASE CHECKLIST

> [!IMPORTANT]
> **DEPLOYMENT MODEL: SINGLE-PROCESS PRODUCTION ONLY**
>
> The application uses `MemoryStore` for session management and an in-memory `Map` for brute-force rate limiting.
> - **DO NOT** configure multiple Node.js workers.
> - **DO NOT** use PM2 in cluster mode (`-i max`).
> - **DO NOT** deploy across multiple container instances without sticky sessions and a shared session/limiter store.

---

## 1. PRE-DEPLOYMENT CHECKLIST

### 1.1. Infrastructure & OS
- [ ] Server running Ubuntu 22.04 LTS or Debian 12 with latest security patches applied (`apt update && apt upgrade`).
- [ ] Dedicated non-root system user `sparkadmin` created (`/opt/spark-admin`).
- [ ] Node.js 24 LTS and npm 10+ installed and verified (`node -v`, `npm -v`).
- [ ] MySQL 8 installed, secured (`mysql_secure_installation`), and running (`systemctl status mysql`).
- [ ] Firewall (UFW) active: ports 22, 80, 443 allowed; ports 3000 and 3306 blocked externally.

### 1.2. Database & Backup
- [ ] Production database created with `utf8mb4` charset and `utf8mb4_unicode_ci` collation.
- [ ] Dedicated application user created (`spark_app_user@localhost`) with restricted permissions (NOT `root`).
- [ ] Full pre-deployment database backup taken and verified (`mysqldump ... | gzip > pre_deploy_backup.sql.gz`).

### 1.3. Environment Configuration & Secrets
- [ ] `.env` file copied from `.env.production.example` into `/opt/spark-admin/app-source/.env`.
- [ ] `SESSION_SECRET` generated with high entropy (min 32 characters, recommended 64 characters via `openssl rand -hex 32`).
- [ ] `NODE_ENV=production` set.
- [ ] `TRUST_PROXY=true` set (enables HTTPS cookie security and real client IP rate limiting behind Nginx).
- [ ] `DATABASE_URL` and database credentials point to production database (no dev/example placeholders).
- [ ] File permissions on `.env` locked down: `chmod 600 .env` and `chown sparkadmin:sparkadmin .env`.
- [ ] Git repository verified: no `.env`, passwords, tokens, or credentials committed.

### 1.4. Automated Verification & Quality Assurance
- [ ] Full automated test suite passes: `npm test` ($\ge 236$ tests, 0 failures).
- [ ] Prisma schema validated: `npx prisma validate`.
- [ ] Prisma migration status clean: `npx prisma migrate status`.

---

## 2. DEPLOYMENT EXECUTION CHECKLIST

- [ ] Release branch / tag checked out or deployment archive extracted into `/opt/spark-admin/app-source`.
- [ ] Production dependencies installed with clean install: `npm ci --omit=dev`.
- [ ] Prisma Client generated: `npx prisma generate`.
- [ ] Production migrations applied: `npx prisma migrate deploy` (**NEVER** use `prisma migrate dev` or `prisma db push`).
- [ ] Systemd service file created at `/etc/systemd/system/spark-admin.service`.
- [ ] Systemd daemon reloaded: `systemctl daemon-reload`.
- [ ] Application service enabled and started: `systemctl enable --now spark-admin`.
- [ ] Application service status confirmed healthy: `systemctl status spark-admin`.
- [ ] Local health check probe verified: `curl -i http://127.0.0.1:3000/health` (returns HTTP 200 with `status: ok`).
- [ ] Nginx site configuration linked in `/etc/nginx/sites-enabled/spark-admin`.
- [ ] Nginx configuration syntax tested: `nginx -t`.
- [ ] Nginx reloaded: `systemctl reload nginx`.
- [ ] SSL certificate provisioned via Let's Encrypt: `certbot --nginx -d example.com`.
- [ ] HTTP to HTTPS redirect active (HTTP 301).

---

## 3. POST-DEPLOYMENT SMOKE TEST CHECKLIST

Perform these smoke tests in a web browser and via curl over the live production HTTPS URL:

### 3.1. Public & Monitoring Endpoints
- [ ] `GET /health` returns HTTP 200 with JSON payload `{"status":"ok","database":"connected"}`.
- [ ] `GET /health` does not set cookies and does not require CSRF tokens.
- [ ] Security headers present in responses (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`).

### 3.2. Authentication & Session Security
- [ ] `GET /login` renders login page over HTTPS.
- [ ] `POST /login` with invalid credentials shows user-friendly error message.
- [ ] Rate limiting: 10 repeated invalid logins return HTTP 429 with `Retry-After` header.
- [ ] `POST /login` with valid admin credentials succeeds and redirects to `/`.
- [ ] Session cookie (`spark.sid`) is present with flags: `HttpOnly`, `Secure`, `SameSite=Lax`.
- [ ] CSRF token is present on all forms and required on all state-changing POST/PATCH/DELETE endpoints.
- [ ] Logout invalidates session and redirects to `/login`.

### 3.3. Core Document & Business Functionality
- [ ] Quotation & Invoice listings load with search, status filters, and pagination (`GET /documents`).
- [ ] Create new quotation: saves correctly, sequence number generated, line items calculated accurately.
- [ ] Quotation lifecycle: Activate, Deactivate, Edit, Copy, Void, Delete, Restore tested.
- [ ] Quotation conversion: convert quotation to invoice generates unique `INV` number and establishes reciprocal links.
- [ ] India GST calculation: verify Intra-State (CGST + SGST 50/50 split) and Inter-State (100% IGST) calculations.
- [ ] Payment recording: record partial payment, verify outstanding balance update, record final payment to set status to `PAID`.
- [ ] Overpayment prevention: verify overpayment beyond balance is strictly rejected with 400.
- [ ] Document PDF export: `GET /documents/:id/pdf` downloads clean, formatted PDF (`%PDF-` header).
- [ ] Document Excel export: `GET /api/invoices/export/excel` downloads formatted multi-sheet Excel file.
- [ ] Clients directory: search clients, create new client with 15-character GSTIN validation (`GET /clients`).
- [ ] Organization settings: update business profile defaults (`GET /settings`).

### 3.4. Logs & Process Health
- [ ] Inspect service logs: `journalctl -u spark-admin -n 100 --no-pager` (confirm zero unhandled exceptions or connection errors).
- [ ] Graceful shutdown test: `systemctl restart spark-admin` stops cleanly and restarts without dropping connections.

---

## 4. ROLLBACK CHECKLIST (CONTINGENCY)

In the event of an unrecoverable production issue:

- [ ] Stop application service: `sudo systemctl stop spark-admin`.
- [ ] Revert codebase to previous stable commit/tag: `git checkout <PREVIOUS_STABLE_TAG>`.
- [ ] Reinstall prior dependencies: `npm ci --omit=dev`.
- [ ] Regenerate Prisma client: `npx prisma generate`.
- [ ] If database schema was altered and requires rollback, restore pre-deployment database backup:
  ```bash
  gunzip < /var/backups/spark-admin/pre_deploy_backup.sql.gz | mysql --defaults-file=/etc/mysql/debian.cnf spark_admin_prod
  ```
- [ ] Restart service: `sudo systemctl start spark-admin`.
- [ ] Verify health: `curl -f http://127.0.0.1:3000/health`.
- [ ] Verify logs: `journalctl -u spark-admin -n 50`.
- [ ] Conduct root cause analysis (RCA) before re-attempting deployment.
