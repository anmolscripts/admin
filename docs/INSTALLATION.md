# Spark Admin — Installation Guide

Zero-friction, cross-platform installation and setup guide for development and production environments.

---

## BEGINNER MODE

### Development
```bash
npm run dev:install
npm run dev
```

### Production
For an already initialized database with an active OWNER, after approved migration
review and a verified backup:

```bash
npm run install:prod -- --confirm-db=YOUR_APPROVED_DATABASE --backup-confirmed
```

This preserves `.env`, accounts, roles and business records. It uses the guarded
migration workflow and does not seed or create databases. Uncommitted migrations
remain blocked. Fresh database/admin provisioning requires a separately reviewed
bootstrap; the old automatic production seed path is disabled. Install dependencies
separately when needed. Application startup and business workflows need independent
verification after the procedure succeeds.

---

## System Prerequisites

| Prerequisite | Minimum Version | Verification Command | Description |
| :--- | :--- | :--- | :--- |
| **Node.js** | `>= 24.0.0` | `node -v` | JavaScript runtime engine |
| **npm** | `>= 10.0.0` | `npm -v` | Package manager |
| **MySQL Server** | `8.0+` or MariaDB `10.5+` | `mysql --version` | Relational database service (running locally or remote) |

Spark Admin is cross-platform and natively supported on **Windows**, **Linux**, and **macOS**.

---

## Architecture & Build Policy

> [!NOTE]
> **Spark Admin has no frontend bundler or browser-asset compilation step.**
> `npm run build` performs release checks, validates/generates Prisma Client without
> connecting to a database, then installs production dependencies and smoke-tests a
> clean staged candidate. It does not migrate or seed a database.

All UI views are server-rendered via Express and EJS with direct static asset delivery. No webpack, vite, or compilation steps are needed.

---

## What the Installer Does

`npm run dev:install` uses the following development stages. Production uses the
separate guarded workflow described above:

```
[1/8] Checking prerequisites    → Validates Node.js (>=24), npm (>=10), and MySQL TCP port reachability
[2/8] Installing dependencies   → Runs npm ci / npm install
[3/8] Configuring environment   → Generates secure .env with 64-char SESSION_SECRET
[4/8] Preparing database        → Connects to MySQL and executes CREATE DATABASE IF NOT EXISTS
[5/8] Applying migrations       → Validates schema and applies all Prisma migrations
[6/8] Generating Prisma Client  → Generates typesafe Prisma MariaDb client
[7/8] Seeding data              → Applies environment-specific seed policy (see below)
[8/8] Verifying installation    → Deterministic invariant verification and test suite / smoke verification
```

---

## Environment Seed Policies

The table below describes the legacy seed functions only. Production installation
no longer invokes them, because they can change existing roles and accounts.

| Data Category | Development Seed (`dev:install`) | Legacy Production Seed (not invoked by installer) |
| :--- | :--- | :--- |
| **System Roles & Permissions** | ✅ OWNER, ADMIN, STAFF + 56 permissions | ✅ OWNER, ADMIN, STAFF + 56 permissions |
| **Unit Master (13 units)** | ✅ Standard predefined units | ✅ Standard predefined units |
| **Item Master (21 items)** | ✅ Standard predefined items | ✅ Standard predefined items |
| **Initial Administrator** | ✅ OWNER admin (`admin@email.com` or custom) | ✅ Explicitly provisioned OWNER admin |
| **Demo Invoices & Quotations** | ✅ Sample records for local testing | ❌ **STRICTLY EXCLUDED** (Hard-fail) |
| **Demo Clients** | ✅ Sample clients (TCS, Infosys) | ❌ **STRICTLY EXCLUDED** |
| **Business Profile** | ✅ Default sample terms & company | ❌ **STRICTLY EXCLUDED** (Configured by Owner) |
| **Payments & Activity Logs** | ❌ None | ❌ None |

---

## What the Installer Asks

### In Development (`npm run dev:install`)
If run in an interactive terminal, the installer prompts for:
1. **Existing `.env` file**: Confirmation before replacing existing `.env`.
2. **Database Host** *(Default: `localhost`)*
3. **Database Port** *(Default: `3306`)*
4. **Database User** *(Default: `root`)*
5. **Database Password**
6. **Database Name** *(Default: `admin`)*
7. **Application Port** *(Default: `3000`)*
8. **Admin Password** *(Default: auto-generates secure random password)*

In non-interactive mode (e.g. CI or scripts), defaults or flags (`--db-host`, `--db-port`, `--db-user`, `--db-password`, `--db-name`, `--admin-email`, `--admin-password`) are consumed without prompting.

### In Production (`npm run prod:install`)
No configuration or password prompts are used. The existing `.env` is read without
rewriting it. Supply only exact target confirmation and backup acknowledgement.
Credential/overwrite options are refused without printing their values. An active
OWNER must already exist; missing or disabled administrators require separate
approved account recovery, not automatic promotion or password replacement.

---

## Where Credentials Appear

- **Admin Password**: Not printed in the final summary. Password prompts suppress terminal echo.
- **Never written to `.env` in production**: In production mode, `SEED_ADMIN_PASSWORD` is omitted from `.env` to protect security.
- **Never logged as raw hashes**: Password hashes are stored securely in MySQL via bcrypt (`saltRounds=12`).

---

## Doctor Command (`npm run doctor`)

To run read-only diagnostics on your system without mutating any data:

```bash
npm run doctor
```

The Doctor command checks:
1. Node.js version (`>=24.0.0`)
2. npm version (`>=10.0.0`)
3. `.env` file presence and syntax
4. Session secret strength (>= 32 chars)
5. MySQL TCP network port reachability
6. MySQL authentication and connection
7. Prisma schema validity (`npx prisma validate`)
8. Migration status (`npx prisma migrate status`)
9. Required tables existence (all 9 core application tables)
10. RBAC roles and permissions integrity
11. Unit master data (13 units)
12. Item master data (21 items)
13. Active administrator availability
14. Production security invariants (dedicated DB user, zero demo data in production)

---

## Troubleshooting Guide

### 1. MySQL Not Running
**Symptom:**
```
✖ FAIL  Cannot connect to MySQL at localhost:3306 (connection refused). Verify that MySQL service is started.
```
**Resolution:**
- Windows: Start MySQL in Windows Services (`services.msc`), or run `net start MySQL80`.
- Linux (systemd): `sudo systemctl start mysql` or `sudo systemctl start mariadb`.
- macOS (Homebrew): `brew services start mysql`.

### 2. Invalid Database Credentials
**Symptom:**
```
✖ FAIL  Authentication failed for MySQL user 'root' at localhost:3306. Please verify your username and password.
```
**Resolution:**
- Double-check your MySQL root or application user password.
- Test manually with: `mysql -u root -p`
- Rerun the installer with `--db-password=your_correct_password`.

### 3. Database Already Exists
**Symptom:**
```
✔ PASS  Database 'admin' already exists.
```
**Resolution:**
- This is normal behavior. The installer is idempotent and safe to run multiple times. Existing databases are preserved and migrations are reconciled without data loss.

### 4. Migration Failure
**Symptom:**
```
✖ FAIL  Migration deployment failed: ...
```
**Resolution:**
- Run `npm run doctor` to inspect the exact migration error.
- Check database connectivity and user privileges (requires `CREATE`, `ALTER`, `DROP`, `REFERENCES`, `INDEX`).

### 5. Production Configuration Failure
**Symptom:**
```
✖ FAIL  SESSION_SECRET must be at least 32 characters long for production security.
```
**Resolution:**
- The installer automatically generates a 64-character hex secret. If manually overriding, ensure the secret is at least 32 characters long and not a default placeholder.

---

## Operational & Maintenance Commands

| Command | Description |
| :--- | :--- |
| `npm run install:migrate -- --confirm-db=<database> --backup-confirmed` | Forward-only upgrade after target confirmation and verified backup |
| `npm run build` | Build and smoke-test a clean release candidate without database writes |
| `npm run db:upgrade -- --confirm-db=<database> --backup-confirmed` | Backward-compatible alias for the guarded migration command |
| `npm run verify:all` | Comprehensive 10-point static, schema, doctor, and test verification |
| `npm run package:release` | Verifies release exclusions and builds clean distribution archive |
| `npm run doctor` | Performs 20-point production environment and database health check |
| `npm test` | Runs the full test suite across all 143 test files |

### Upgrading an Existing Installation

Do not use `dev:install` or `db:reset` to upgrade an existing
customer database. Stop application writes, create and verify a database backup,
then run the guarded forward-only migration command with the exact database
name:

```bash
npm run install:migrate -- --confirm-db=<exact-database-name> --backup-confirmed
```

The command refuses missing/mismatched targets and protected database names. It
creates a missing database only with explicit `--create-database`; it never resets
schemas, seeds data, or uses `db push`. The production installer wrapper additionally
requires an initialized OWNER and does not allow database creation. MariaDB
DDL can implicitly commit, so a failed migration is not guaranteed to roll back
as a unit; follow the recovery plan in the upgrade guide if the resulting schema
is uncertain.
