# SPARK ADMIN ERP — CONTROLLED STAGING DEPLOYMENT CHECKLIST & OPERATIONAL RUNBOOK

**Document Version:** 1.0.0  
**Target Environment:** Staging / Controlled Pilot Host  
**Application Repository:** `anmolscripts/admin`  
**Node.js Runtime:** v24 LTS (v24.21.0 or higher)  
**Database Engine:** MariaDB 11.4+ / MySQL 8.0+ (utf8mb4 / utf8mb4_unicode_ci)  
**Security Policy:** Zero unauthenticated writes; fail-closed database guards; secrets masked at prompt; single-process Node.js execution.

---

## 1. Approved Build & Source State

- [ ] **1.1. Release Artifact Verification:**
  - **Required Role:** Release Engineer / DevOps
  - **Action:** Obtain clean distribution archive `dist/spark-admin-release.zip` generated via `npm run package:release`. Verify SHA-256 against release manifest:
    ```bash
    sha256sum dist/spark-admin-release.zip
    cat dist/release-manifest.json
    ```
  - **Expected Outcome:** Hash matches exactly; manifest contains 295 files with zero `.env`, `.git`, or build artifact inclusions.
  - **Verification:** Inspection of manifest and package contents.

- [ ] **1.2. Source Code Tree Audit:**
  - **Required Role:** Release Engineer
  - **Action:** If deploying directly from Git commit baseline, assert tree cleanliness:
    ```bash
    git status --short
    git diff --check
    ```
  - **Expected Outcome:** No untracked files or whitespace/syntax errors (`exit code 0`).

- [ ] **1.3. Runtime Prerequisites:**
  - **Required Role:** Systems Administrator
  - **Action:** Verify Node.js v24+ and npm v10+:
    ```bash
    node -v   # Output: v24.x.x
    npm -v    # Output: v10.x.x or v11.x.x
    ```

---

## 2. Environment Configuration & Secret Injection

- [ ] **2.1. Staging `.env` File Creation:**
  - **Required Role:** Systems Administrator
  - **Action:** Copy `.env.production.example` to staging `.env` outside source control:
    ```bash
    sudo -u sparkadmin cp .env.production.example /opt/spark-admin/app/.env
    sudo chmod 600 /opt/spark-admin/app/.env
    ```
  - **Expected Outcome:** File accessible only to `sparkadmin` service user and root (`chmod 600`).

- [ ] **2.2. Cryptographic Secret Injection:**
  - **Required Role:** Security Officer / Systems Administrator
  - **Action:** Generate and inject 64-character hexadecimal session secret:
    ```bash
    openssl rand -hex 32
    ```
    Populate in `.env`:
    ```ini
    NODE_ENV=production
    PORT=3000
    DATABASE_HOST=localhost
    DATABASE_PORT=3306
    DATABASE_USER=spark_staging_user
    DATABASE_PASSWORD=<SECURE_STAGING_PASSWORD>
    DATABASE_NAME=spark_admin_staging
    DATABASE_URL="mysql://spark_staging_user:<ENCODED_PASSWORD>@localhost:3306/spark_admin_staging"
    SESSION_SECRET=<64_HEX_CHARACTERS>
    ATTACHMENT_STORAGE_DIR=/var/lib/spark-admin/attachments
    ```
  - **Safety Check:** Ensure `DATABASE_NAME` is strictly set to staging database, never protected `admin` or production names.

---

## 3. Database Connection & Schema Compatibility

- [ ] **3.1. Staging Database Provisioning:**
  - **Required Role:** Database Administrator (DBA)
  - **Action:** Create dedicated staging database and grant least-privilege permissions:
    ```sql
    CREATE DATABASE spark_admin_staging CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER 'spark_staging_user'@'localhost' IDENTIFIED BY '<SECURE_STAGING_PASSWORD>';
    GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON spark_admin_staging.* TO 'spark_staging_user'@'localhost';
    FLUSH PRIVILEGES;
    ```
  - **Expected Outcome:** Database created with `utf8mb4` encoding; user authenticated strictly from localhost.

- [ ] **3.2. Forward Schema Migration Deployment:**
  - **Required Role:** Systems Administrator / Deployer
  - **Action:** Apply all 23 versioned migrations non-destructively:
    ```bash
    sudo -u sparkadmin npx prisma migrate deploy
    sudo -u sparkadmin npx prisma generate
    sudo -u sparkadmin npx prisma migrate status
    ```
  - **Expected Outcome:** `All migrations have been successfully applied` and `Database schema is up to date`. Total 52 tables provisioned.

- [ ] **3.3. Read-Only System Doctor Diagnostic:**
  - **Required Role:** Deployer
  - **Action:** Run diagnostic check:
    ```bash
    sudo -u sparkadmin node scripts/doctor.js
    ```
  - **Expected Outcome:** 20/20 PASS across runtime, config, database, schema, migrations, RBAC, and master data.

---

## 4. Persistent Attachment Storage Deployment & Lifecycle Verification

- [ ] **4.1. Configured Storage Path Outside Public Web Root:**
  - **Required Role:** Systems Administrator
  - **Action:** Set environment variable `ATTACHMENT_STORAGE_DIR=/var/lib/spark-admin/attachments` in `/opt/spark-admin/.env`.
  - **Expected Outcome:** Files are stored strictly outside `/opt/spark-admin/app/assets` and `/opt/spark-admin/public`, preventing direct HTTP access without application-layer authentication and tenant authorization.

- [ ] **4.2. Directory Creation & Service-Account Permissions:**
  - **Required Role:** Systems Administrator
  - **Action:** Create directory tree and set restrictive ownership:
    ```bash
    sudo mkdir -p /var/lib/spark-admin/attachments
    sudo mkdir -p /opt/spark-admin/app/assets/uploads/avatars
    sudo chown -R sparkadmin:sparkadmin /var/lib/spark-admin/attachments /opt/spark-admin/app/assets/uploads/avatars
    sudo chmod 750 /var/lib/spark-admin/attachments /opt/spark-admin/app/assets/uploads/avatars
    ```
  - **Expected Outcome:** Service account `sparkadmin` has `rwxr-x---` (0750); unauthorized or other users have zero access.

- [ ] **4.3. Systemd Sandboxing Configuration:**
  - **Required Role:** Systems Administrator
  - **Action:** Add `ReadWritePaths` to `/etc/systemd/system/spark-admin.service` under `[Service]`:
    ```ini
    ProtectSystem=full
    ProtectHome=true
    ReadWritePaths=/var/lib/spark-admin/attachments /opt/spark-admin/app/assets/uploads/avatars
    ```
    Reload and restart service:
    ```bash
    sudo systemctl daemon-reload
    sudo systemctl restart spark-admin.service
    ```
  - **Expected Outcome:** Systemd sandboxing permits writing to `/var/lib/spark-admin/attachments` while locking down root filesystem.

- [ ] **4.4. Upload, Service Restart & Download Persistence:**
  - **Required Role:** QA Lead / Staging Operator
  - **Action:**
    1. Authenticate to Staging UI and upload a project attachment (`.pdf` or `.png`).
    2. Note attachment ID and verify file is written to `/var/lib/spark-admin/attachments/<hash>.<ext>`.
    3. Restart application service: `sudo systemctl restart spark-admin.service`.
    4. Download the attachment through the web UI (`GET /api/projects/:id/attachments/:attId/download`).
  - **Expected Outcome:** File download returns HTTP 200 with identical bytes and correct SHA-256 hash. Cross-business users receive HTTP 404.

- [ ] **4.5. Paired Backup of Attachment Bytes & Database Metadata:**
  - **Required Role:** Backup Operator / Systems Administrator
  - **Action:** Execute atomic snapshot pairing:
    ```bash
    # 1. Database logical dump
    mysqldump --single-transaction --routines --triggers spark_admin_staging > /var/backups/staging_db_$(date +%F).sql
    # 2. Synchronous file archive
    tar -czf /var/backups/staging_attachments_$(date +%F).tar.gz -C /var/lib/spark-admin attachments
    ```
  - **Expected Outcome:** Backup pair generated with matching timestamp.

- [ ] **4.6. Restore Validation & SHA-256 File Integrity:**
  - **Required Role:** Systems Administrator
  - **Action:**
    1. Restore database into a restore test target.
    2. Extract attachments into a temporary mount path.
    3. Run verification script comparing disk SHA-256 hashes against `project_attachments.sha256Hash`.
  - **Expected Outcome:** 100% hash parity across all metadata records.

- [ ] **4.7. Failure Handling & Orphan Cleanup Verification:**
  - **Required Role:** QA Lead
  - **Action:** Test upload behavior when directory is temporarily read-only or invalid:
    ```bash
    sudo chmod 500 /var/lib/spark-admin/attachments
    # Attempt upload via API; expect HTTP 500 / 400 clean failure
    sudo chmod 750 /var/lib/spark-admin/attachments
    ```
  - **Expected Outcome:** Request fails gracefully; zero orphaned records created in `project_attachments` database table.

---


## 5. Initial Administrator Authentication & Credential Rotation

- [ ] **5.1. RBAC & Initial User Bootstrap (Seed):**
  - **Required Role:** Systems Administrator
  - **Action:** Execute initial seed in production mode:
    ```bash
    SEED_ADMIN_PASSWORD="<COMPLEX_BOOTSTRAP_PASSWORD>" sudo -u sparkadmin node prisma/seed.js
    ```
  - **Expected Outcome:** Bootstraps 5 roles (`OWNER`, `ADMIN`, `MANAGER`, `MEMBER`, `VIEWER`), 102 permissions, 318 mappings, 13 units, 21 master items, and initial administrator user. Zero mock records seeded.

- [ ] **5.2. Secure Masked Credential Rotation:**
  - **Required Role:** Authorised Systems Administrator
  - **Action:** Rotate bootstrap password using masked prompt:
    ```bash
    node scripts/rotate-password.js --email="admin@email.com"
    ```
    *(If targeting a protected database, explicitly add `--authorized-protected-db --confirm-db-name=<target>`)*
  - **Input Procedure:** Type new strong password (min 8 chars) at masked `*` prompt and confirm at second prompt.
  - **Expected Outcome:** Bcrypt(12) hash updated in `users` table; zero secrets logged to terminal or shell history.

---

## 6. Session Invalidation & Verification

- [ ] **6.1. Targeted Session Invalidation:**
  - **Required Role:** Systems Administrator / QA Lead
  - **Action:** Confirm rotation output verifies session invalidation:
    `[REVOCATION] Revoked X active session(s) for user ID 1.`
  - **Expected Outcome:** Any pre-existing session token for User 1 in `sessions` table is invalidated. Unrelated users remain authenticated.

- [ ] **6.2. Web Login Verification:**
  - **Required Role:** Operator / QA Lead
  - **Action:** Open staging web UI at `https://staging.yourdomain.com/login`:
    1. Attempt login with old bootstrap password: Must receive HTTP 401 / "Invalid credentials".
    2. Log in with new rotated password: Must receive HTTP 302 redirect to `/dashboard` with session established.

---

## 7. Business-Level Access & Role Permissions

- [ ] **7.1. Business Profile Setup:**
  - **Required Role:** Staging Business Owner (`OWNER` role)
  - **Action:** Navigate to `/settings`, configure Business Profile (Legal Name, GSTIN, State Code, Currency `INR`, TimeZone `Asia/Kolkata`, Bank Details).
  - **Expected Outcome:** Saved and rendered on invoices and headers; branding cache reloads.

- [ ] **7.2. Multi-Role RBAC Enforcement:**
  - **Required Role:** QA Lead
  - **Action:** Verify access controls per role:
    - `OWNER` / `ADMIN`: Access all settings, users, payroll, reports, and journal registers.
    - `MANAGER`: Create and approve sales, bills, and purchase orders; view reports; cannot alter system security settings.
    - `MEMBER` / `STAFF`: Create draft quotations/bills; cannot view P&L, Balance Sheet, or close financial years.
    - `VIEWER`: Read-only views; POST/PUT/DELETE return HTTP 403 Forbidden.

---

## 8. Representative Commercial & Operational Workflows

- [ ] **8.1. Sales Lifecycle (Quotation -> Invoice -> Payment -> Credit Note):**
  - **Action:**
    1. Create Quotation `QTN-STG-001` with intra-state GST (CGST 9% + SGST 9%).
    2. Convert quotation to Tax Invoice `INV-STG-001`.
    3. Re-attempt conversion on same quotation: Confirm HTTP 409 Conflict guard blocks duplicate.
    4. Record partial payment of 50% via bank transfer; verify remaining balance in AR.
    5. Issue Credit Note `CN-STG-001` against invoice; verify balanced journal.
  - **Expected Outcome:** State transitions valid; reciprocal links maintained; double-entry journals balanced down to the exact paisa.

- [ ] **8.2. Purchase Order & Inventory Movement:**
  - **Action:**
    1. Create Purchase Order `PO-STG-001` with 10 units of catalog item @ ₹500.
    2. Verify PO detail view renders live calculations and posts ZERO GL entries (invariance).
    3. Convert to Supplier Bill `BILL-STG-001`: Dr Direct Purchases (5110) / Cr Accounts Payable (2121).
    4. Issue StockMovement `SM-STG-001`: Dr COGS / Cr Inventory Asset.
  - **Expected Outcome:** Subledger balances match; zero double-counting with project costing.

- [ ] **8.3. Project Costing & Secure Attachment Upload:**
  - **Action:**
    1. Create Project `PRJ-STG-001` linked to client.
    2. Upload valid PDF attachment `spec_sheet.pdf` via `/projects/:id/attachments`.
    3. Confirm file saved at `/var/lib/spark-admin/attachments/<timestamp>_<hash>.pdf`.
    4. Attempt upload of disallowed `.exe` or `.svg`: Confirm HTTP 415 rejection with zero disk/DB orphans.
    5. Test authenticated download stream: Bytes match SHA-256 hash.

---

## 9. General Ledger, Trial Balance, P&L & Reconciliation Checks

- [ ] **9.1. Trial Balance Equilibrium ($\sum \text{Debit} \equiv \sum \text{Credit}$):**
  - **Action:** Navigate to `/reports/trial-balance` and inspect control totals.
  - **Expected Outcome:** Delta is exactly `₹0.00` across all active asset, liability, equity, revenue, and expense accounts.

- [ ] **9.2. Customer Receivables Subledger Reconciliation:**
  - **Action:** Cross-check `/reports/customer-receivables` balance against GL Account `1121` (Accounts Receivable).
  - **Expected Outcome:** Sum of all client receivables equals GL 1121 balance.

- [ ] **9.3. Closed Financial Year Period Locking:**
  - **Action:** Attempt to back-post invoice into a `CLOSED` financial year.
  - **Expected Outcome:** Server rejects with HTTP 400 "Financial year is closed for posting".

---

## 10. Backup & Restore Operational Drill

- [ ] **10.1. Staging Database Backup:**
  - **Required Role:** DBA / Systems Administrator
  - **Action:** Execute logical backup:
    ```bash
    mysqldump --single-transaction --quick -u spark_staging_user -p spark_admin_staging > /var/backups/spark_staging_$(date +%F).sql
    ```
  - **Expected Outcome:** Non-empty `.sql` dump file generated without table locks.

- [ ] **10.2. Physical Attachment Backup:**
  - **Required Role:** Systems Administrator
  - **Action:** Archive attachments and avatars:
    ```bash
    tar -czf /var/backups/spark_attachments_$(date +%F).tar.gz -C /var/lib/spark-admin attachments
    ```
  - **Expected Outcome:** Tarball archives physical files; matches database metadata records.

- [ ] **10.3. Restoration Test into Ephemeral Database:**
  - **Required Role:** Systems Administrator
  - **Action:** Restore dump into temporary test database `spark_staging_restore_test` and verify table row counts and trial balance equilibrium.

---

## 11. Health Diagnostics, Logging & Rollback Plan

- [ ] **11.1. Service Health & Logs:**
  - **Action:** Inspect systemd service logs and Nginx access/error logs:
    ```bash
    sudo systemctl status spark-admin
    journalctl -u spark-admin -n 100 --no-pager
    sudo tail -n 50 /var/log/nginx/error.log
    ```
  - **Expected Outcome:** Service active (running); zero unhandled exceptions, memory warnings, or 5xx server errors.

- [ ] **11.2. Rollback Runbook (In Case of Unrecoverable Regression):**
  - **Step 1:** Stop Node.js service: `sudo systemctl stop spark-admin`.
  - **Step 2:** Restore database snapshot from pre-deployment backup:
    ```bash
    mysql -u spark_staging_user -p spark_admin_staging < /var/backups/pre_deployment_snapshot.sql
    ```
  - **Step 3:** Re-checkout previous stable Git release tag or extract prior release archive.
  - **Step 4:** Restart service: `sudo systemctl start spark-admin`.
  - **Step 5:** Run `node scripts/doctor.js` to confirm operational health.

---

## 12. Sign-Off Criteria & Final Operational Status

| Operational Gate | Target Scope | Implementation & Tooling Status | Deployment Host Execution Status | Designated Role |
| :--- | :--- | :--- | :--- | :--- |
| **Gate 1: Build & Source State** | Packaging & git clean tree | **VERIFIED COMPLETE** (295 files, `dist/spark-admin-release.zip`, `git diff --check` clean) | **Awaiting Staging Host Provisioning** | Release Engineer |
| **Gate 2: Environment & Secrets** | Production config & secret generation | **VERIFIED COMPLETE** (`.env.production.example`, secret injection scripts) | **Awaiting Secret Injection on Host** | Security Officer |
| **Gate 3: Database & Migrations** | 23 migrations, 52 tables, doctor | **VERIFIED IN DISPOSABLE ENV** (100% pass across clean install & upgrade) | **Awaiting Staging Database Creation** | Database Administrator |
| **Gate 4: Persistent Storage** | Storage outside web root, SHA-256 | **VERIFIED IN DISPOSABLE ENV** (5/5 tests pass in `attachment_storage_readiness`) | **Pending Host Volume Mount (`0750`)** | Systems Administrator |
| **Gate 5: Credential Rotation & RBAC** | Masked password prompt, session revocation | **TOOLING HARDENED & TESTED** (8/8 tests pass in `rotate_password_guard`) | **Awaiting Authorised Human Execution** | Systems Administrator |
| **Gate 6: Commercial & Ops Workflows** | Sales, PO, inventory, costing, payroll | **VERIFIED IN BROWSER TEST** (54/54 scenarios pass across 4 suites) | **Pending Staging Smoke Test** | QA Lead / Operator |
| **Gate 7: Accounting Reconciliation** | Trial balance delta ₹0.00, subledger match | **VERIFIED COMPLETE** (38/38 report tests pass, balance sheet equilibrium) | **Pending Staging Ledger Review** | Finance Officer |
| **Gate 8: Backup & Disaster Recovery** | Logical dump & restore with 100% fidelity | **VERIFIED IN DISPOSABLE ENV** (109.8 KB dump & restore verified) | **Pending Staging Host Backup Schedule** | Systems Administrator |

### Release Sign-Off Classification:
- **Application Code & Automated Gates:** **CONDITIONALLY READY FOR PRODUCTION / READY FOR CONTROLLED PILOT DEPLOYMENT**
- **Staging Host Execution:** **AWAITING STAGING HOST PROVISIONING & OPERATOR RUNBOOK EXECUTION**
- **Protected Environment Operations (`admin`):** **AWAITING AUTHORISED HUMAN ACTION** (Administrator password rotation and historical synthetic data archival require explicit human execution)

