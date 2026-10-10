# Spark Admin — Safe Database & Application Upgrade Guide

This guide explains how system administrators and self-hosting customers can upgrade Spark Admin to new versions without data loss, downtime surprises, or manual database hacking.

---

## 1. Principles of Safe Upgrades

1. **Zero Destructive Resets**: Upgrades NEVER run `prisma migrate reset` or drop databases.
2. **Forward-Only Versioned Migrations**: Schema alterations are strictly additive with safe defaults or nullable columns.
3. **Pre-flight Health Inspection**: Upgrade scripts verify MySQL reachability, migration checksums, and schema consistency before applying changes.
4. **Historical Snapshot Invariance**: Changing organization settings or software versions never alters historical issued invoices, posted journals, or ledger entries.

---

## 2. Standard Upgrade Workflow (`npm run db:upgrade`)

Spark Admin includes a dedicated, non-destructive upgrade command:

```bash
npm run db:upgrade
```

### What `npm run db:upgrade` Does:
1. **Connectivity Check**: Connects to the database configured in `.env` without exposing credentials.
2. **Pending Migration Detection**: Inspects the `_prisma_migrations` table for unapplied migrations.
3. **Sequential Migration Execution**: Applies pending migrations in strict timestamp order using `prisma migrate deploy`.
4. **Prisma Client Regeneration**: Recompiles the typesafe MariaDB/MySQL Prisma client matching the new schema.
5. **System Health Verification**: Runs the 20-point `scripts/doctor.js` diagnostics suite.

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
npm run db:upgrade
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
1. Check detailed logs in `.artifacts/product-readiness/` or console output.
2. The migration engine halts immediately before partial corruption occurs.
3. Verify database user privileges (`ALTER`, `CREATE`, `INDEX` are required).
4. Restore from the pre-upgrade dump if schema state is indeterminate:
   ```bash
   mysql -u <db_user> -p <db_name> < spark_admin_backup_YYYYMMDD_HHMMSS.sql
   ```
