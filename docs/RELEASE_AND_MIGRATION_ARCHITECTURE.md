# Release Build and Database Migration Architecture

## Current command contract (supersedes earlier installer checkpoints)

The user explicitly clarified that both fresh-install commands are destructive:
`install:dev` creates/resets the selected database and seeds sample data;
`install:prod` creates/resets it and bootstraps only an administrator/system records.
Production has zero sample catalog items, clients, invoices, payments and profiles.
Both require exact destructive confirmation and retain protected-database guards.
Development no longer writes a separate test database or runs tests unless requested.

`install:migrate` installs production packages and delegates to the existing guarded
forward-only upgrade: no reset, cleanup, seed or administrator mutation. Target,
verified-backup, provenance and baseline checks remain. Plain interactive invocation
prompts for target and backup acknowledgement; non-interactive flags remain supported.
Fresh resets intentionally use local migration SQL without the upgrade provenance gate;
existing history/data are deliberately removed, not guessed or baselined.

`build` produces an isolated candidate with both production installers and their helpers,
Prisma configuration/client-generation requirements, migrations, views and assets. It
excludes development setup, sample-data seed modules, tests, secrets and local uploads.
Clean installation uses production dependencies only. No JavaScript minification or
performance improvement is claimed without measurements. Verification stages are retained
for inspection; existing release archives are not replaced.

Password prompts now suppress readline echo using a single input consumer; summary
output no longer prints passwords. Unknown production CLI options are rejected without
echoing possible credential values.

Verification: 45 focused tests passed covering fresh create/reset/repeat and cancellation,
failure stopping, wrong/protected targets, demo-vs-production bootstrap, URL-only and
conflicting configuration, password masking, dependency-install ordering and preserved-data
migration orchestration. SQL/CLI effects were mocked. The development entrypoint was tested
with injected dependencies; actual seed policy was tested without a database.
Build passed clean production npm installation, Prisma validate/generate, EJS compilation
and production server/static-asset smoke checks with mocked Prisma and blocked outbound
connections. No real reset, migration, seed or database write was run. Actual Windows
terminal input, live reset/replay, data-preserving upgrades, restore and business workflows
remain unverified. An approved disposable database/staging environment is still needed.
The workspace's migration provenance now reports committed at HEAD 1009019; this agent
did not commit or stage changes. Earlier uncommitted-provenance notes are historical.

## Scope and audit basis

This document records the release and migration design for the CommonJS Spark
Admin application. The audit covered `package.json` and its lockfile metadata,
the Prisma schema/configuration and migration SQL, setup/upgrade/release scripts,
the runtime database configuration, and the existing installation, upgrade,
deployment, and database-operation guides. Environment files and credentials
were not inspected. No database command, migration, seed, reset, or
write-enabled integration test was run during this audit. The review was updated
on 19 October 2026 using Node.js 24.12.0 and npm 11.6.2 on Windows. Prisma
validation/client generation did run with synthetic settings and no database.

## Verified current state

- The package requires Node.js `>=24` and npm `>=10`, is CommonJS, and has an
  npm lockfile v3. Runtime uses Express/EJS and Prisma 7 with the MariaDB
  adapter. There is no frontend bundler; application views and assets are
  served directly.
- Prisma's schema is `prisma/schema.prisma`. CLI configuration is in the
  non-default filename `prisma7.config.ts`; it loads `.env` or `.env.test` and
  obtains the CLI datasource from `DATABASE_URL`. The schema's datasource
  declaration does not itself contain a URL.
- The migration directory contains ordered migration history, including existing
  staged and untracked migration SQL that has not yet been committed.
  A static search found no `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, or
  `RENAME TABLE` statements. This does not prove that every migration is
  operationally safe: new constraints, backfills, DDL implicit commits, and
  legacy data can still cause failures or partial application.
- Before this implementation, `npm run db:upgrade` invoked Prisma without
  explicitly naming `prisma7.config.ts`, had no exact target or backup
  confirmation, and displayed `admin` as a fallback. The guarded runner now
  requires `DATABASE_URL`, an exact `--confirm-db` name, and
  `--backup-confirmed`; it invokes the configured Prisma CLI directly.
- `scripts/setup.js` is a broader first-time installer, not an in-place
  production upgrade: it may create databases, reset a development database,
  seed data, write `.env`, and run tests. It must not be used as the upgrade
  path for an existing customer database.
- The legacy `scripts/package-release.js` used to delete/recreate
  `dist/staging` before its baseline archive overwrite check and included
  database-writing utilities. It now stages in a newly allocated temporary
  directory, refuses existing baseline outputs before staging, and shares
  strict exclusions with candidate packaging.
- The existing `verify:all` and test runner can access a database, apply
  fixtures, and run database/migration checks. They are not appropriate as
  database-free build verification.
- The existing docs describe installation and upgrades but overstate some
  guarantees (for example, automatic rollback on migration failure) and do
  not distinguish a release build from database installation clearly.

## Command contracts

### `npm run build`

The build is database-free and reproducible from the lockfile. It must:

1. Validate the supported Node/npm versions and package/lockfile consistency.
2. Validate Prisma schema/configuration and generate the Prisma client without
   opening a database connection.
3. Check JavaScript syntax and compile server-rendered EJS templates.
4. Assemble and smoke-check a clean release candidate in a new, unique output
   location. Existing build, staging, archive, and manifest files are never
   deleted or overwritten.
5. Exclude credentials, local environment files, `.git`, `node_modules`,
   uploads, runtime data, logs, backups/dumps, test fixtures, evidence, caches,
   and local tool configuration. Include only sanitized environment examples.
6. Verify the candidate contains the expected runtime, Prisma schema,
   migrations, and install scripts and that its production dependency
   installation is lockfile-based.

Build must not connect to, create, seed, migrate, or otherwise write to any
database. It must not claim database migration or production deployment
readiness.

### `npm run install:migrate`

This is a forward-only, in-place schema upgrade for an already configured
database. It must fail closed unless:

1. A valid `DATABASE_URL` is explicitly configured and its database name
   matches the effective target; no implicit `admin` fallback is permitted.
2. The operator supplies an exact target confirmation matching that database.
   The displayed target is sanitized and never includes URL credentials.
3. The configured database is not one of the protected targets:
   `admin`, `spark_admin`, `spark_admin_test`, `spark_admin_prod`, or
   `spark_admin_prod_test`. MySQL system databases `mysql`, `information_schema`,
   `performance_schema` and `sys` are also protected, case-insensitively.
4. The Prisma schema validates, the supported CLI config is explicitly
   selected, and a pre-upgrade backup has been confirmed by the operator.

After those preconditions and the provenance/history checks below, it runs
`prisma migrate deploy`, verifies `prisma migrate status`, and generates Client.
Missing-database creation requires the separate `--create-database` flag. It must
not drop databases, reset schemas, run `db push`, seed data, or silently switch
targets. Repeat execution is covered with mocks; actual SQL no-op behavior still
requires an approved database. Failures are
reported with a nonzero exit status and sanitized output. Because MariaDB DDL
can implicitly commit, the command must not promise transaction-wide rollback;
operators should stop application writes and restore the verified pre-upgrade
backup if state is uncertain.

The command must not be run against a protected database in this environment.
It can be validated here only with mocked CLI boundaries or an explicitly
approved disposable database; a real migration is not part of ordinary
verification.

## Implemented behavior

- `npm run build` validates package/lockfile metadata, checks JavaScript syntax,
performs a clean production dependency install in an isolated temporary
staging directory, validates and generates Prisma Client using synthetic loopback
database settings, compiles EJS templates, and imports the staged app with
outbound sockets blocked. It then starts the real server with only the Prisma
boundary mocked, production environment validation and session-store construction
enabled, and compares a loopback HTTP CSS response with the staged file bytes.
It then writes a unique source release candidate and manifest under
`dist/builds/`. It never connects to a database and never overwrites an
existing candidate.
- Release and candidate packaging share explicit exclusions for environment
files, uploads, evidence/local data, backups/dumps, test/destructive database
scripts, and the internal database operations incident ledger. The release
manifest retains only `start`, `doctor`, and guarded `install:migrate`
commands.
- `npm run install:migrate -- --confirm-db=<exact-name> --backup-confirmed`
(also exposed through `db:upgrade`) validates and matches the target, rejects
protected databases, runs forward deploy/status, and generates the client.
The command never seeds databases and does not claim rollback of MariaDB DDL.
Explicit provisioning and fail-closed history checks are described below.

### Missing-database provisioning and least privilege

The previous policy message claimed no database creation, although Prisma
documents that `migrate deploy` can create a missing database. That implicit
behavior was not tested on a live server in this review. See the
[Prisma CLI reference](https://docs.prisma.io/docs/orm/reference/prisma-cli-reference).

The runner now first connects to the exact configured database using the URL's
credentials. Only error 1049 / `ER_BAD_DB_ERROR`, together with explicit
`--create-database`, permits a connection to the same server without selecting a
database. It issues one quoted `CREATE DATABASE` with `utf8mb4` and
`utf8mb4_unicode_ci`, closes that connection, then reconnects to the target and
verifies `SELECT DATABASE()` before inspecting history. Concurrent creation error
1007 causes the same reconnect and checks, never replacement. Existing databases
are never recreated, including when `--create-database` is present.

```text
npm run install:migrate -- --confirm-db=<exact-name> --backup-confirmed --create-database
```

Authentication, access, network or transport failure never triggers creation or
credential fallback. The runner creates no users and issues no grants, database
alteration or deletion. Prefer an operator-preprovisioned schema; otherwise use
`CREATE` scoped to the exact approved schema, plus only the table/DDL/DML and
metadata privileges needed by the reviewed migration SQL. Do not grant global
`CREATE`, `ALL PRIVILEGES`, root access or account-management privileges for this
workflow. The runner cannot narrow an already overprivileged account; grant
review remains an operator responsibility. The normal runtime account should
have only application privileges. Denied creation stops with instructions to
preprovision manually or correct scoped grants, without escalating privileges.

The same confirmation, protected-name and backup guards apply to creation. The
backup flag records an operator assertion; it does not verify a backup. A fresh
schema does not include a provisioned administrator; bootstrap/account policy
requires a separate reviewed procedure.

### Target, provenance and legacy-history checks

- Database identifiers are limited to ASCII letters/digits/underscore/hyphen,
  at most 64 characters. Supplied granular host, port, user, password and database
  values must agree with `DATABASE_URL`, preventing migration/runtime ambiguity.
- Ordinary TCP URLs and numeric Prisma pool/timeout options `connection_limit`,
  `pool_timeout`, `connect_timeout`, and `socket_timeout` are accepted; only
  `connect_timeout` controls the short-lived preflight connection. Other URL
  options, including TLS/socket transport options, currently fail closed before
  connecting. They require reviewed support for equivalent transport semantics
  in the driver and Prisma engine. Do not remove required TLS settings to bypass
  this refusal.
- In a checkout, migration SQL must be committed and unchanged relative to HEAD.
  Releases require `migration-source.json` with a commit, `allCommitted: true`
  and matching SHA-256 hashes for every SQL file and the MySQL migration lock.
  Missing/modified/uncommitted provenance stops before any connection. This is
  integrity metadata, not a cryptographic signature or a schema-drift proof.
- Preflight reads visible tables/views, routines/events and `_prisma_migrations`.
  Empty schemas may receive shipped migrations. Nonempty schemas with missing
  or empty history fail with a legacy-baseline diagnostic before deploy; no
  `migrate resolve`, inferred baseline or generated SQL is used.
- Completed records must form an exact ordered prefix of shipped names and raw
  SQL SHA-256 checksums. Unknown, duplicate, missing-prefix, changed, unfinished
  or rolled-back history fails closed. Metadata errors and ledgers with applied
  records but no application tables also fail. Even legitimate resolved/retried
  histories may require manual review under this conservative policy.
- Driver errors use fixed diagnostics; Prisma output redacts configured URL
  credentials including encoded/decoded forms. Connections close on success or
  failure. Any Prisma failure stops subsequent steps.

These checks do not establish schema equivalence or data compatibility. Stop
application writes and concurrent DBA/schema changes during installation. There
is a gap between preflight and Prisma's separate connection; concurrent database
deletion/replacement is outside the guarantee. Prisma could create a database
itself if an external actor deletes the target during that gap.

### Verified artifact requirements

The artifact contains `app/`, all EJS views, public `assets/`, sanitized package
and lockfile, `prisma7.config.ts`, schema, migration lock/SQL, migration provenance,
the guarded runner and `scripts/lib/migration-preflight.js`, doctor dependencies,
docs and environment examples. Runtime dependencies include Express, EJS, Prisma
CLI/client/adapter, native bcrypt and the now explicit `mariadb` dependency.

This remains a source distribution: `node_modules` and generated Client files
are intentionally excluded. The target must run `npm ci --omit=dev` and generate
Client with the included config/schema. `install:migrate` generates it after
successful deploy; generation alone can run without a database connection.
Actual startup still requires live schema readiness. The clean install and
generated Client were exercised in temporary staging, not bundled for every
deployment platform.

The smoke harness uses `NODE_ENV=production`, a random session secret,
`SESSION_STORE=database` and synthetic database settings. It first loads real
runtime dependencies with outbound connections blocked, then mocks only Prisma
for the real server, readiness checks and ephemeral loopback HTTP listener.
The listener/session timer close afterward. This verifies mocked production
startup and static serving, not real health/login/session persistence or business
routes. Dependency installation may use the npm registry; real database settings
are not inherited by staging.

The existing staged/untracked migration files are preserved. Review candidates
record `allCommitted: false` and refuse `install:migrate`. Commit reviewed SQL
and rebuild before database installation. No migration SQL was changed, staged
or committed during this review.

## Release and upgrade sequence

1. Build from a clean checkout and validate the candidate without a live
   datasource.
2. Review the migration SQL and test against a separate disposable staging
   database. Verify both fresh installation and forward upgrade from the
   oldest supported production schema.
3. Take and verify a restorable database backup and separately back up
   persistent attachments/uploads.
4. Deploy the candidate and install dependencies with `npm ci --omit=dev`.
5. Run `npm run install:migrate` with an exact target confirmation and explicit
   backup acknowledgement during a controlled maintenance window.
6. Run read-only health checks and application smoke tests. Do not seed customer
   databases as part of an upgrade.
7. Keep the previous application release and backup until acceptance checks
   pass. Application rollback does not automatically reverse an applied
   migration; restore the pre-upgrade backup only under the documented recovery
   plan.

## Verification boundaries

Database-free build checks, candidate exclusions, schema validation, template
compilation, CLI argument/target guards, and mocked migration orchestration may
run without database approval. Live install, migration, seed, doctor checks
that connect to a database, fixture setup, backup/restore, and disposable
database release verification require a positively identified disposable
database and explicit authorization. No such database is assumed.

## Verification performed on 19 October 2026

The following database-free command passed **27 tests**, with none skipped:

```text
node --test tests/release_build.test.js tests/migration_upgrade.test.js tests/migration_provenance.test.js
```

Coverage includes target/backup flags; wrong/protected/encoded/system names;
malformed and ambiguous targets; explicit missing-database creation; denied
credentials/grants/network/TLS; concurrent creation; existing populated upgrade;
repeat fresh/existing runs; wrong connected database; empty schemas; legacy
tables/views/routines with absent/empty history; invalid migration ledgers;
metadata errors; stopping at each failed Prisma step; credential redaction;
package/lock consistency; exclusions; and missing/modified/uncommitted provenance.
Database behavior is mocked. Retaining mock business rows does not prove that
migration SQL preserves real production data.

`npm run build` passed clean isolated production installation, actual Prisma
validation/generation, compilation of the staged EJS views, real dependency
imports, mocked production server startup and HTTP static-asset verification.
Artifact inspection uses an isolated copy to check required runtime/config/SQL
files, manifests and exclusions. Existing baseline archives were not rebuilt or
overwritten. The full `npm test`, `verify:all`, live `doctor`, setup and database
integration suites were not run because they can access configured databases.

## Still requires an approved disposable database or staging environment

1. Actual missing-database creation and permission refusal on supported
   MySQL/MariaDB versions, including database-scoped grants and server TLS policy.
2. All migrations against a fresh schema and representative populated upgrades
   from each supported baseline, including a real second execution.
3. Data/tenant preservation, backfills, constraints, locking and execution time.
   Existing SQL includes business-ID backfills, foreign-key/default changes and
   unique constraints; it was preserved and is not certified safe by mocks.
4. Partial-DDL recovery and a verified backup restore, including persistent uploads.
5. Live readiness, health, login, durable sessions, attachments, reports and other
   business flows, plus native dependency compatibility on the deployment OS.

Commit/rebuild the current migration changes before that approval-controlled
exercise. No production-readiness conclusion is supported by this review.

## Phase 1 correction checkpoint: explicit R11 approval gate

The approved correction pass stopped at the user's requirement to review any new
receipt-idempotency migration before creating it. Automatic GRN numbering allocates
a fresh number on retries; the existing receipt-number unique key does not identify
a repeated request. A proposed business-scoped request key and payload hash preserve
automatic numbering and existing rows. Neither its SQL nor application/schema
changes have been created. See the [review checkpoint](RELEASE_MIGRATION_REVIEW_2026-10-19.md#phase-1-correction-approval-checkpoint-19-october-2026)
for exact proposed SQL, revised 84-path future commit scope, history and policy gates.

Current receipt remaining-quantity reads still occur outside the write transaction.
Current lifecycle closure checks do not provide a verified concurrency guarantee.
All five pending migrations have unknown external deployment history; their SQL and
the 22 committed SQL files remain unchanged. Unsafe ownership/default/cascade findings
remain release blockers. A forward migration must not be treated as permission to
execute earlier unsafe SQL or reconstruct historical evidence from new defaults.

This checkpoint ran 28 passing mock/unit checks plus two executing TODO acceptance
tests that fail on duplicate receipt creation and pre-transaction quantity reads.
The TODO failures are unresolved defects despite Node's zero exit code. Offline
Prisma validation, test syntax and staged/unstaged whitespace checks passed.
Provenance fixture tests were not rerun because their cleanup deletes directories,
which this approval prohibits. No database was contacted and no build was rerun.
Prior clean-install/startup and artifact results have not been renewed for this diff.
Live creation, upgrades, repeat execution, data preservation, concurrent receipt and
closure behavior, partial-DDL recovery, isolated restore and business flows remain
unverified and require explicitly approved disposable targets/staging. No commit,
staging, migration execution or production readiness is implied by this checkpoint.
