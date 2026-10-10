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
2. `assets/uploads/avatars/` (uploaded user profile pictures).

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
