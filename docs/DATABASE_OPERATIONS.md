# Spark Admin — Database Operations & Safety Manual

This manual details database administration, backup/restore procedures, migration guidelines, and safety guardrails for Spark Admin ERP.

---

## 1. Safety Guardrails & Principles

Spark Admin ERP stores mission-critical financial, tax, and double-entry accounting records. The following principles are strictly enforced:

- **Customer Data Immutability**: Posted journal entries, closed financial years, issued tax invoices, and credit/debit notes are permanent accounting records.
- **No Indiscriminate Resets**: `prisma migrate reset` is prohibited in deployment and ordinary operation.
- **Guardrails on `npm run db:reset`**:
  - Automatically aborts if `NODE_ENV=production`.
  - Aborts if the database name is not explicitly passed via `--confirm-db=<dbname>`.
  - Aborts if `--force-reset` is not present.
  - Displays target host and database without revealing passwords or credentials.

---

## 2. Key Database Commands

| Command | Purpose | Production Safe? |
| :--- | :--- | :--- |
| `npm run db:upgrade` | Deploys pending forward-only migrations and regenerates Prisma client | **YES** |
| `npm run db:reset` | Destructive development/test database teardown and re-seed | **NO** (Strictly blocked in production) |
| `npm run doctor` | Performs 20-point diagnostic check (connectivity, schema, migrations) | **YES** (Read-only) |
| `npx prisma migrate status` | Inspects migration sync status between schema and database | **YES** (Read-only) |

---

## 3. Backup and Disaster Recovery

### Standard Backup Procedure (MySQL / MariaDB)

Perform automated daily logical backups using `mysqldump`:

```bash
mysqldump \
  --host=localhost \
  --port=3306 \
  --user=spark_admin_user \
  -p \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  admin > /var/backups/spark_admin_$(date +%F_%T).sql
```

**Notes on flags:**
- `--single-transaction`: Ensures consistent snapshot without table locking during active business transactions.
- `--quick`: Streams rows directly rather than buffering entire tables in memory.

### Files Requiring Separate Backup
Along with the SQL database, always back up:
1. `.env` configuration file (encryption keys, session secret).
2. `data/attachments/` (project costing, vendor bills, and entity file attachments stored outside web root).
3. `assets/uploads/avatars/` (uploaded user profile pictures).

When restoring attachments on a production host:
- Ensure the destination directory exists: `mkdir -p /data/attachments` (or `./data/attachments`).
- Restore the physical files with appropriate application read/write permissions (`chmod 750 /data/attachments` or service user ownership).
- Verify SHA-256 hashes against `project_attachments.sha256Hash` database records.

---

## 4. Restoration Procedure

Never restore directly over a live, unverified production database.

1. Create a clean temporary restoration database:
   ```bash
   mysql -u root -p -e "CREATE DATABASE spark_admin_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
   ```
2. Restore the dump into the test database:
   ```bash
   mysql -u root -p spark_admin_restore_test < spark_admin_backup_2026-10-09.sql
   ```
3. Run verification checks:
   ```bash
   DATABASE_URL="mysql://root:password@localhost:3306/spark_admin_restore_test" node scripts/doctor.js
   ```
4. Once verified, swap connection string or restore to primary database during scheduled maintenance.

---

## 5. Adding New Schema Migrations (Development Workflow)

1. Update `prisma/schema.prisma`.
2. Generate migration SQL without applying immediately:
   ```bash
   npx prisma migrate dev --create-only --name <descriptive_name>
   ```
3. Review generated SQL in `prisma/migrations/<timestamp>_<name>/migration.sql`.
   - Ensure columns are nullable or have safe defaults.
   - Ensure existing rows will not violate new unique constraints.
4. Apply migration to local development database:
   ```bash
   npx prisma migrate deploy
   ```
5. Regenerate Prisma Client:
   ```bash
   npx prisma generate
   ```
6. Run full verification suite:
   ```bash
   npm run verify:all
   ```

---

## 6. Historical Incident Reconciliation & Non-Destructive Recovery Plan (Database `admin`)

### 6.1 Context & Incident Background
During initial verification on 2026-10-17, test execution without an isolated database target ran against protected database `admin`. This resulted in:
1. Application of forward migration `20261017183000_add_project_costing_and_attachments`.
2. Insertion of synthetic demonstration/test records into `projects`, `project_attachments`, `daily_workers`, `clients`, `users`, `businesses`, and `business_memberships`.

Subsequent test guard implementation in `app/config/prisma.js` strictly blocked any further writes to `admin`. Recent read-only forensic inspection confirmed that zero additional writes have occurred.

### 6.2 Schema Migration vs. Synthetic Data Separation
- **Schema Migration (`20261017183000`)**: Purely additive (creates new tables for project costing, attachments, daily workers, budgets). Rolling back this migration is **strictly prohibited**, as the application runtime, Prisma schema, and forward-upgrade integrity depend on these tables.
- **Synthetic Entity Records**: Fully isolated by tenant (`businessId: 3` and `businessId: 4` for separate test tenants, or specific isolated IDs in business 1). They do not corrupt legitimate accounting records in businesses 1 or 2.

### 6.3 Historical Incident Reconciliation Ledger

| Entity / Item | Identified Record(s) | Previously Reported State | Recent Forensic Evidence (`admin`) | Current Status | Dependencies & Foreign Key Risks | Proposed Recovery Action | Required Approval |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Migration** | `20261017183000_add_project_costing_and_attachments` | Applied to `admin` | Recorded as finished in `_prisma_migrations` | Applied & Healthy | Prisma Client and runtime depend on schema | **Retain & Formally Adopt**. Do not roll back. | Database Owner / Lead Architect |
| **Project** | ID: `1`, Code: `PRJ-2026-001`, Name: `Metro Line HVAC Expansion` | Inserted during test | Present (Business 1, `2026-10-17T15:03:27Z`) | Inert demonstration project | Referenced by `project_attachments` (ID 1) | Archive attachment first, then archive project during maintenance | Database Owner |
| **Attachment** | ID: `1`, File: `test_1792244580103.pdf` (`test.pdf`) | Uploaded during test | Present (Business 1, `2026-10-17T13:43:00Z`) | Metadata record present | References Project 1; physical file in test attachments directory | Verify physical file path, archive record, remove or archive file | Database Owner |
| **DailyWorker** | ID: `1`, Name: `Rameshwar Kumar` | Created during test | Present (Business 3, `2026-10-17T13:36:34Z`) | Isolated in Business 3 | Child of synthetic Business 3 | Archive with Business 3 hierarchy | Database Owner |
| **Clients** | IDs: `9` (`Reliance Metro Projects`), `10` (`Adani Port Logistics`) | Created during test | Present (Business 1, `2026-10-17T13:36:34Z`) | Zero transactions/invoices linked | No dependent invoices or GL transactions | Archive or delete after verifying zero transactional links | Database Owner |
| **Users** | IDs: `8` (`Alice Alpha PM`), `9` (`Bob Beta PM`) | Created during test | Present (Roles: ADMIN, created 2026-10-17T13:36:34Z) | Isolated; no active sessions | Referenced in `business_memberships` (IDs 2 & 3) | Remove `business_memberships` first, then archive/delete users | Database Owner |
| **Businesses** | IDs: `3` (`Alpha Engineering Projects Ltd`), `4` (`Beta Global Logistics LLP`) | Created during test | Present (Codes `ALPHA_...`, `BETA_...`) | Isolated synthetic tenants | Referenced in `business_memberships` and `daily_workers` | Archive all dependent records, then archive/delete businesses | Database Owner |
| **Memberships** | IDs: `2` (User 8, Biz 3), `3` (User 9, Biz 4) | Created during test | Present (Roles: ADMIN, created 2026-10-17T13:36:34Z) | Links synthetic users to synthetic businesses | FK constraints on `users` and `businesses` | Delete memberships before deleting users/businesses | Database Owner |

### 6.4 Operator Non-Destructive Archival Procedure (When Authorised)
If the database owner approves cleanup of the synthetic records, the operator must execute the following non-destructive procedure in an approved maintenance window:

1. **Take a full consistent backup first:**
   ```bash
   mysqldump --single-transaction --routines --triggers admin > admin_pre_cleanup_$(date +%F_%T).sql
   ```
2. **Export synthetic records to an archival table or SQL script before deletion:**
   ```sql
   -- Verify target database
   SELECT DATABASE(); -- Must return 'admin'

   -- Verify zero live financial transactions link to Clients 9 and 10
   SELECT COUNT(*) FROM invoices WHERE clientId IN (9, 10); -- Expected: 0
   SELECT COUNT(*) FROM quotations WHERE clientId IN (9, 10); -- Expected: 0

   -- Archival sequence respecting FK constraints (reverse dependency order):
   START TRANSACTION;
   DELETE FROM project_attachments WHERE id = 1;
   DELETE FROM projects WHERE id = 1;
   DELETE FROM daily_workers WHERE id = 1;
   DELETE FROM business_memberships WHERE id IN (2, 3);
   DELETE FROM users WHERE id IN (8, 9);
   DELETE FROM businesses WHERE id IN (3, 4);
   DELETE FROM clients WHERE id IN (9, 10);
   -- COMMIT only after inspecting affected row counts (exactly 1 or 2 rows per statement)
   -- COMMIT;
   -- Or ROLLBACK if any unexpected count occurs.
   ```
3. **Confirm zero impact to legitimate business IDs (1 & 2):**
   ```sql
   SELECT id, name FROM businesses WHERE id IN (1, 2);
   SELECT COUNT(*) FROM users WHERE id NOT IN (8, 9);
   ```
