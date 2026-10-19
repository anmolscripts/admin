# Spark Admin — Safe Database & Application Upgrade Guide

This guide explains how system administrators and self-hosting customers can upgrade Spark Admin to new versions without data loss, downtime surprises, or manual database hacking.

---

## 1. Principles of Safe Upgrades

1. **Forward-Only Versioned Migrations**: Existing customer databases are upgraded only with committed `prisma migrate deploy` migrations.
2. **Explicit Target Confirmation**: The target database name must match `DATABASE_URL` and the operator's `--confirm-db` value.
3. **Verified Backup First**: The operator confirms a verified pre-upgrade backup before migration begins.
4. **No Upgrade Seeding or Reset**: An upgrade does not create databases, reset schemas, run seeds, or use `db push`.

---

## 2. Standard Upgrade Workflow (`npm run db:upgrade`)

Spark Admin includes a dedicated, non-destructive upgrade command:

```bash
npm run install:migrate -- --confirm-db=<exact-database-name> --backup-confirmed
```

### What `npm run db:upgrade` Does:
1. Requires a valid MySQL `DATABASE_URL`, an exact matching target confirmation,
   and the `--backup-confirmed` acknowledgement.
2. Refuses protected database names and validates the Prisma schema using the
   checked-in `prisma7.config.ts`.
3. Applies committed migrations with `prisma migrate deploy`, then verifies
   `prisma migrate status`.
4. Regenerates Prisma Client. The command never creates a database, resets a
   schema, runs a seed, or invokes `db push`.

---

## 3. Step-by-Step Production Upgrade Procedure

### Step 1: Backup Database & Static Assets
Always take a snapshot prior to updating application code:
```bash
# Dump MySQL database
mysqldump -u <db_user> -p <db_name> --single-transaction --routines --triggers > spark_admin_backup_$(date +%Y%m%d_%H%M%S).sql

# Archive user uploads (avatars & documents)
tar -czvf spark_admin_uploads_$(date +%Y%m%d).tar.gz assets/uploads/
```

### Step 2: Pull or Extract New Release
```bash
# Extract the clean release archive over the application directory
tar -xzvf spark-admin-release-vX.Y.Z.tar.gz
```

### Step 3: Install Updated Production Dependencies
```bash
npm ci --omit=dev
```

### Step 4: Run Safe Database Upgrade
```bash
npm run install:migrate -- --confirm-db=<exact-database-name> --backup-confirmed
```

### Step 5: Verify System Health
```bash
npm run doctor
```

### Step 6: Restart Application Daemon
```bash
# If using PM2:
pm2 restart spark-admin

# If using systemd:
sudo systemctl restart spark-admin
```

---

## 4. Troubleshooting & Rollback

### If a Migration Fails
1. Stop the deployment and preserve the complete sanitized command output.
2. Do not assume the operation rolled back: MariaDB DDL statements may
   implicitly commit and leave a partially applied migration.
3. Verify the current migration status and schema using read-only diagnostics;
   do not manually mark a migration as applied without reviewing the SQL and
   database state.
4. Restore from the verified pre-upgrade backup if schema state is indeterminate:
   ```bash
   mysql -u <db_user> -p <db_name> < spark_admin_backup_YYYYMMDD_HHMMSS.sql
   ```
