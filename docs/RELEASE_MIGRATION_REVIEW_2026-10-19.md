# Spark Admin ERP: phase 1 migration and release review

**Latest checkpoint:** Phase 1 correction approval reached the explicit R11 new-migration stop condition. See "Phase 1 correction approval checkpoint" below for proposed SQL, unresolved statuses and the revised 84-path future scope. No application/SQL corrections or commit have occurred.

Review date: 19 October 2026. Source HEAD: b7915035b0fc82b64eff6d74782e2483080e975f.

Decision: do not commit or deploy this workspace as-is. Static and mock verification found release blockers. No database was contacted, no application/migration source was changed, and no workspace changes were staged, unstaged, reset or committed. This new report is the only workspace file added during this review.

## Scope and migration inventory

Reviewed git status, staged changes, the complete net diff against HEAD, untracked source/docs/tests, all five pending migration SQL files, their prior migration dependencies, the Prisma model and relevant application queries. There were 61 tracked changed paths and 22 untracked files before this report. The index already contains user changes, including older staged supplier/routes/schema content that differs from the working versions. Committing the current index would not capture the reviewed working implementation. Existing index entries have been preserved.

The 22 SQL migrations in HEAD are byte-identical to their working copies. Five additional migrations follow them in strict lexical/timestamp order; their identity and deployment history outside this workspace remain unverified:

| Alias | Exact migration directory | Workspace state | Static assessment |
|---|---|---|---|
| M1 | `20261017183000_add_project_costing_and_attachments` | Staged addition | Blocking ownership, legacy-default and deletion-policy risks; many DDL statements |
| M2 | `20261018200000_add_goods_receipts_and_enhanced_attachments` | Staged addition | Additive new tables/nullable links; receipt concurrency and tenant validation need correction |
| M3 | `20261019120000_add_quotation_acceptance_project_lifecycle` | Untracked | Nullable lifecycle fields and unique source link are consistent; permission/audit/closure issues remain |
| M4 | `20261019133000_add_purchase_order_gst_snapshots` | Untracked | Additive zero-default fields; legacy representation and immutable snapshot handling need correction |
| M5 | `20261019150000_add_payment_cheque_clearance` | Untracked | Nullable DATE matches model; preserves old payment rows but project summaries mishandle new pending state |

Every migration path below ends in `/migration.sql` unless another file is named. The aliases always refer to the complete directory names in this table.

## Findings and proposed corrections

### R01 — High: unresolved tenant ownership is guessed as business 1

Files: `prisma/migrations/20261017183000_add_project_costing_and_attachments/migration.sql:29`, `:43`, `:49`, `:55` (M1).

M1 initially fills every cost with business 1, replaces that value only when the parent has a positive business ID, and assigns unresolved projects to business 1. A null/zero project business, an imported orphan, or a missing business record must not be interpreted as ownership. A null-to-1 project update may also collide with an existing `(businessId, code)` value because nullable unique keys previously allowed such rows. A checksum-valid baseline does not establish that these rows are safe.

Correction: add a read-only compatibility check before any migration DDL. Require each project to resolve to an existing, approved business and every cost to a valid parent; reject unresolved or ambiguous mappings, orphan references and target uniqueness conflicts. If M1 is confirmed never applied anywhere, add the new cost business column nullable, backfill only from verified parents, and require complete resolution before NOT NULL. Remove guesses. Otherwise preserve published checksums and design an explicitly reviewed recovery/forward-correction plan. No guessed repair should run automatically.

### R02 — High: existing cost-history deletion protection is weakened

File: M1 `migration.sql:286` and `:292`; previous behavior in `20261010183000_add_erp_modules_inventory_payroll_projects/migration.sql`; `prisma/schema.prisma` ProjectCost relation.

M1 drops the old project-cost FK and changes `ON DELETE RESTRICT` to `ON DELETE CASCADE`. Deleting a project could then delete existing financial cost history. No deletion occurs merely from this ALTER, but it changes an established preservation rule. New attachment/labour/contractor cascades also need an explicit retention decision.

Correction: retain RESTRICT for existing cost history and align the Prisma relation. Approve any other cascade separately against ERP retention requirements. Avoid dropping a working constraint merely to enable a broader delete. If any pending SQL was applied elsewhere, use a reviewed forward correction instead of editing its checksum.

### R03 — High: legacy supplier financial snapshots become verified zero values

File: M1 `migration.sql:76` and `:89` through `:110`; `prisma/schema.prisma` SupplierBill/SupplierBillItem; `app/services/supplierBill.service.js`.

Legacy bills retain their old nonzero `totalAmount` and line `amount`, while new taxable/tax/line-total fields default to zero. M1 simultaneously marks every old bill `VERIFIED` and assumes input-tax eligibility. This does not prove totals reconcile or that the missing tax detail is actually zero. No real legacy rows were inspected, so the incidence is unknown.

Correction: distinguish an unknown legacy snapshot from a calculated zero using nullable fields or an explicit legacy snapshot version/state. Preserve original totals and issued records. Mark legacy detail unverified until evidence supports it; backfill only deterministically recoverable values and make readers handle legacy data consistently. Do not infer tax rates/eligibility from absent data or rewrite historical journals.

### R04 — Medium: legacy cost classifications and source identities are lost

File: M1 `migration.sql:30` through `:38` and `:235`; `app/services/projectCostLedger.service.js:90`; `app/services/project.service.js:812` onward.

Old costs gain category OTHER, status POSTED, recoverable-tax=true and null source type/ID regardless of their old costType, journal/source reference or approval evidence. New category reports can reclassify all historic labour/material costs as OTHER. The new nullable composite unique key does not deduplicate unknown legacy source identities, so reposting a historic source can create an additional cost.

Correction: define a reviewed mapping from authoritative old costType/sourceReference/journal evidence; keep unknown values explicitly legacy/unverified. Compare category totals before/after and resolve source identities before permitting automatic reposting. Never invent source IDs or merge/delete costs to satisfy uniqueness.

### R05 — High: default-business posting can create a second, unowned chart

Files: `app/services/chartOfAccounts.service.js:93`; `app/services/accounting/posting.service.js:191`, `:559`, `:804`; schema alignment to committed `20261011120000_multi_business_and_central_numbering`.

The committed multi-business migration assigns old accounts to business 1. Posting still translates business 1 to null, while the new ensureSystemAccounts implementation strictly queries businessId:null. A mock containing the 44 standard accounts already owned by business 1 caused 44 additional null-owned accounts to be created. Shared/null fallback accounts can then split AR/bank postings from old account histories or weaken tenant isolation.

Correction: use the actual business ID consistently for account creation, resolution and journal posting, including business 1. Do not silently fall back to shared accounts. Preserve existing account IDs and posted lines; diagnose any existing duplicate charts without auto-merging or moving entries.

### R06 — High: PO line allocations bypass tenant ownership checks

Files: M2 `migration.sql:2` and `:76`; `app/services/purchaseOrder.service.js:73`, `:163`, `:171`, `:210`, `:382`.

The new line project FK references only a globally valid project ID. Creation validates the header project but accepts each sanitized line projectId without checking its business. The mock accepted business 2's PO line with projectId 99 and performed zero project ownership lookups. A real foreign project would satisfy the ID-only FK. Updates have the same line-level validation gap.

Correction: validate every distinct line project in the authorized business inside the write transaction. Enforce the agreed header-versus-line allocation rules. Consider composite tenant FKs only after a reviewed schema design and an audit of existing cross-business references; do not add them blindly to dirty data.

### R07 — High: header-only PO edits rewrite historical tax treatment

Files: M4 `migration.sql:2` and `:10`; `app/services/purchaseOrder.service.js:378`, `:394`, `:418`.

Every update recalculates totals using the current business tax context, but line snapshots are replaced only when items or supplier changes. In the mock, a remarks-only edit after a business-state change wrote header CGST=0/IGST=18 while the unchanged line still had CGST=9/SGST=9/IGST=0. Legacy PO snapshots also start as indistinguishable zeros; list/workbench fallbacks help presentation but do not establish canonical snapshot consistency.

Correction: preserve all monetary/tax snapshots on nonfinancial edits. Recalculate lines and header atomically only in an explicitly allowed financial edit, using the captured commercial context. Introduce an explicit legacy snapshot marker or an approved deterministic non-tax backfill rather than treating all zeros as proof of missing history.

### R08 — High: pending/void cheques affect project cash totals

Files: M5 `migration.sql:1`; `app/services/project.service.js:728`, `:739`, `:760`; `app/services/payment.service.js`.

The project summary loads all payments and sums all statuses, although the new receipt workflow intentionally leaves cheques pending. A mock invoice total 100 with one pending cheque of 100 returned cashCollected=100 and customerOutstanding=0; expected collected cash is 0 and outstanding is 100. Voided payments are also included by the same query.

Correction: sum only the agreed posted/cleared payments, use the correct accounting/clearance date for period reports, and reconcile outstanding with authoritative invoice balances/credit notes. Add project/portfolio/report tests for pending, cleared, void and reversed payments without changing old posted cheque records.

### R09 — High: closure can accept rejected deliveries and voided supplier payments

Files: M3 lifecycle fields; `app/services/project.service.js:1056`, `:1061`, `:1068`, `:1073`, `:1080`.

Closure counts received rather than accepted quantity and sums supplier payments without status filtering. A mock PO with ten units received but all ten rejected, plus a bill covered only by a VOID payment, was allowed to close with no blockers. Counting every non-POSTED cost also treats void costs as unfinished. The preview runs before the closing transaction, so concurrent receipts/costs/bills can invalidate it.

Correction: define acceptance/replacement obligations explicitly, use posted supplier settlements and outstanding bills, exclude terminal void costs, and evaluate blockers under a documented transaction/locking scheme. Reconcile unmatched GRNs, stock and journals rather than implying the current limited preview is a complete close control. Preserve authorized override reasons and audit records.

### R10 — Medium: new close permission has no upgrade provisioning

Files: M3 SQL; `app/services/rbac.service.js:70`, `:92`, `:155`; `app/routes/web.routes.js:865`; `prisma/seed/common/index.js:141`.

PROJECTS:CLOSE is added to the code matrix and route, but none of the five migrations inserts the permission. Only seedPermissionsAndRoles provisions it; the guarded upgrade correctly never runs seed. Owners/FULL_ACCESS can work through code expansion, while existing custom roles cannot receive a missing permission record through normal role configuration. MANAGER's fixed list also lacks CLOSE. CLOSE is duplicated in the ACTIONS array.

Correction: add a narrowly scoped idempotent forward data migration for the permission. Obtain an explicit role-grant policy rather than resetting or broadly reseeding roles. Proposed new file: `prisma/migrations/20261019160000_add_project_close_permission/migration.sql`. Remove the duplicate taxonomy entry; preserve existing role/user grants.

### R11 — High: receipt concurrency and retry protections are incomplete

Files: M2 receipt tables/unique key; existing `app/services/goodsReceipt.service.js:147`, `:155`, `:182`.

Previously received quantity is calculated before the transaction and without a PO-line lock. Concurrent requests can both pass the remaining-quantity check. An automatically allocated new receipt number is not a stable retry key. This is an existing application gap exposed by enabling the staged receipt migration, not proof that SQL has already duplicated stock.

Correction: lock the relevant PO/lines in a consistent order and recalculate accepted/remaining quantities within the transaction. Define an immutable caller idempotency key or require a stable document reference with a unique business-scoped check. Any additional schema required by that design needs a separately listed, reviewed migration. Concurrency has not been tested against a database.

### R12 — Medium: acceptance/project/closure audits are outside their transactions

Files: M3; `app/services/invoice.service.js:1685`; `app/services/project.service.js:206`, `:1087`; `app/services/activity.service.js:38` and `:89`.

These workflows call activityService.log without the transaction client, and the logger swallows errors. An audit can persist for a later-rolled-back change or be absent after a committed change. That weakens the audit promise of the new lifecycle fields.

Correction: write required lifecycle audit rows through the same transaction, propagate failures for mandatory audit events, and keep optional actor-last-activity updates separate. Test both rollback directions. This does not authorize modifying existing audit history.

### R13 — Medium: updatedAt behavior differs from the Prisma model

Files: M1 `migration.sql:2`, `:5`, `:8`, `:26`; committed multi-business table definitions; `prisma/schema.prisma` corresponding @updatedAt fields.

M1 drops DEFAULT but leaves the prior ON UPDATE CURRENT_TIMESTAMP clauses in SQL text. Offline Prisma-generated target DDL has neither clause. The textual comparison found these four differences. This is a static mismatch, not a live introspection result.

Correction: choose whether the intended behavior is server-driven or Prisma-driven timestamps. Preserve current behavior until that decision is reviewed; if removing server automation, use an explicitly reviewed full column definition and verify its effect on the supported server. Do not assume DROP DEFAULT also settles update behavior.

### R14 — Low: redundant source-quotation index is declared only in schema

Files: M3 `migration.sql:16`; `prisma/schema.prisma:1364`.

SQL creates a unique sourceQuotationId index, while the model also declares a separate nonunique index. The unique index already covers this lookup. The textual comparison also found two inherited index-name aliases for payments/employee reimbursements with equivalent business-ID coverage; those are not new missing-column/FK defects.

Correction: remove the redundant Prisma index declaration or deliberately include it if justified. Prefer avoiding the extra index and its write/DDL cost; confirm actual introspection in approved staging.

### R15 — Medium: old operational docs conflict with the implemented guard contract

Files: `docs/DEPLOYMENT.md`, `docs/INSTALLATION.md`, `docs/UPGRADE_GUIDE.md`, `docs/PROJECT_LIFECYCLE_IMPLEMENTATION_PLAN.md`.

Some docs still state that install:migrate never creates a database, show Prisma commands without the explicit config, or describe source locking that the lifecycle code does not implement. The deployment example also gives the normal app account broad DDL privileges. These instructions conflict with the updated architecture and scoped installer/runtime separation.

Correction: document opt-in creation, exact config/provenance, separate least-privilege accounts, real locking boundaries and the currently unverified state. Do not replace an actual restore drill with a backup acknowledgement.

## Locking, uniqueness and partial-DDL review

No pending file contains DROP DATABASE, DROP TABLE, DROP COLUMN, TRUNCATE, DELETE or a destructive data cleanup. M1 does drop an FK and several defaults and changes a delete action, as reported above. M2's new unique keys initially apply to empty tables; M3's source link initially contains NULL and is globally unique by quotation ID. M1's source identity key contains nullable legacy fields and cannot prove deduplication. No live duplicate/orphan survey was possible.

All five migrations can acquire metadata locks; M1 also performs full-table ownership updates, a nullable-to-NOT-NULL conversion, index construction and many FK validations. M2/M3 build indexes on existing tables; M4/M5 may be online/instant on some server versions but no supported server/version/size has been approved, so lock duration and algorithm are unknown. Adding columns is not evidence that a migration is operationally nonblocking.

Do read-only compatibility checks before the first DDL, stop app writes and concurrent DBA changes, capture the exact baseline/schema/ledger and record progress. Do not wrap the entire file in a transaction and assume rollback: MySQL DDL can commit independently. A late FK/unique failure can leave earlier DDL/backfills applied. Preserve failed migration evidence and inspect before any separately approved recovery. Never reset, truncate, drop/recreate or silently mark failed migrations applied. Reference: [MySQL implicit commits](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html) and [ALTER TABLE](https://dev.mysql.com/doc/refman/8.4/en/alter-table.html).

## Passed checks in this continuation

1. `node --test tests/release_build.test.js tests/migration_upgrade.test.js tests/migration_provenance.test.js tests/test_database_config.test.js`: 31 passed, zero failed/skipped. All driver/Prisma interactions in migration orchestration are mocked. Tests create only their own temporary filesystem fixtures.
2. Offline installed Prisma CLI `migrate diff --from-empty --to-schema <isolated schema.prisma> --script` exited zero using a temporary config and synthetic loopback port-1 datasource. No generated SQL was executed; no migration-directory/shadow replay was requested. A limited textual DDL analyzer processed all 27 migrations and generated target definitions for 54 tables, with no duplicate DDL objects/unparsed DDL in its final pass. This is not a database parser, actual migration execution or proof of schema equivalence. See [Prisma shadow database boundaries](https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/shadow-database).
3. Confirmed all 22 committed migration SQL files match HEAD byte-for-byte. New migration names sort after that history with no name collision. New field types/nullable declarations match the model subject to R13/R14.
4. Read-only inspection of existing candidate `dist/builds/spark-admin-1.0.0-2026-10-19T11-25-14-133Z`: 288 files including manifest, 59 EJS views, 48 asset files, 27 migrations and 13 declared runtime dependencies. All required installer/doctor helpers, Prisma config/schema/lock, package and dependency lock are present. Manifest inventory and working source bytes match; package scripts are sanitized. No forbidden file paths were present. Generated Client/node_modules are deliberately not shipped. This is a pathname/content-equality check, not a complete certification against embedded secrets in all documentation.
5. Existing candidate provenance remains allCommitted:false. No release or candidate archive was rebuilt or overwritten. Baseline ZIP SHA-256: cc03900a994f0b09e4d489d89d851c34e8fe3684d8a0dc891758a62c8e4a0113. Baseline manifest SHA-256: aab6b8895fffb7bf11c11ea7b90405ef9a2c2ced3b0f3f8bf8e3a14498d79113.

## Failed acceptance checks / reproduced defects

The existing test suite passed, but separate in-memory mock experiments reproduced R05, R06, R07, R08 and R09 using the actual service functions. Outbound sockets were blocked, Prisma was replaced before any app import, and no real data or credentials were loaded. Observed results: 44 duplicate null-owned accounts; an unchecked line project allocation; header/line tax disagreement on a memo edit; pending cheque counted as cash; and closure allowed for rejected goods plus a void supplier settlement. These behaviors fail the stated release invariants. Corrections and persistent regression coverage have not been applied yet.

## Blocked and not-tested checks

Blocked: commit approval; correction/role/backfill/retention policy decisions; valid committed migration provenance; identification and explicit approval of disposable server/database targets and scoped non-production credentials; intended deployment OS/version; and the earliest supported populated baseline. Do not infer approval from .env or use production credentials. Do not commit the current index as-is.

Not tested live: database creation and denied CREATE, actual migration replay, populated SQL upgrades, real repeated installer execution, failure/partial-DDL recovery, data/tenant preservation, backup creation/integrity/restoration, live health/startup and the required business workflows. No backup has been called restorable. `npm run build`, clean production install and mocked server startup passed in the preceding audit; they were not rerun in this phase. The current artifact's recorded verification was inspected only. No live doctor, full npm test, setup, seed or migration command was run.

The offline review wrapper's temporary-directory removal failed with EPERM, and a later explicit removal attempt was rejected by automatic approval review with 'blocked by policy'. Two tool-created directories remain outside the workspace: `C:/Users/User/AppData/Local/Temp/spark-static-schema-review-2iLaLJ` and `C:/Users/User/AppData/Local/Temp/spark-static-schema-review-UuK3eN`. They contain only copied schema and synthetic review configuration. No further cleanup was attempted after rejection.

## Exact proposed commit scope — pending approval, not staged

This is the proposed complete release scope after reviewed corrections, not approval to commit the present contents. Existing staged files remain untouched. The following list contains 82 paths: 78 existing release-related changed/untracked paths, this new report, an existing receipt service proposed for correction, one proposed regression test, and one proposed permission migration. The last two files have not been created. Any additional migration required by the approved receipt-idempotency design must be named and reviewed in a revised list before commit.

```text
.gitignore
app/app.js
app/controllers/invoice.controller.js
app/controllers/item.controller.js
app/controllers/payment.controller.js
app/controllers/project.controller.js
app/controllers/purchase.controller.js
app/controllers/report.controller.js
app/controllers/supplier.controller.js
app/routes/invoice.routes.js
app/routes/web.routes.js
app/services/accounting/posting.service.js
app/services/accounting/report.service.js
app/services/activity.service.js
app/services/attachment.service.js
app/services/chartOfAccounts.service.js
app/services/documentView.service.js
app/services/goodsReceipt.service.js
app/services/invoice.service.js
app/services/navigation.service.js
app/services/payment.service.js
app/services/project.service.js
app/services/purchaseOrder.service.js
app/services/rbac.service.js
app/services/reportingWorkbench.service.js
app/services/supplier.service.js
app/views/documents/view.ejs
app/views/layouts/header.ejs
app/views/projects/details.ejs
app/views/purchases/orders.ejs
app/views/purchases/po-editor.ejs
app/views/reports/customer-statement.ejs
app/views/suppliers/form.ejs
app/views/suppliers/index.ejs
assets/css/documents.css
assets/css/main.css
assets/css/projects.css
assets/js/spark-daterange.js
assets/js/view.js
docs/DATABASE.md
docs/DEPLOYMENT.md
docs/INSTALLATION.md
docs/PROJECT_LIFECYCLE_AUDIT.md
docs/PROJECT_LIFECYCLE_IMPLEMENTATION_PLAN.md
docs/PROJECT_LIFECYCLE_RUNBOOK.md
docs/RELEASE_AND_MIGRATION_ARCHITECTURE.md
docs/RELEASE_MIGRATION_REVIEW_2026-10-19.md
docs/TESTING.md
docs/UPGRADE_GUIDE.md
docs/USER_MANUAL.md
package-lock.json
package.json
prisma/migrations/20261017183000_add_project_costing_and_attachments/migration.sql
prisma/migrations/20261018200000_add_goods_receipts_and_enhanced_attachments/migration.sql
prisma/migrations/20261019120000_add_quotation_acceptance_project_lifecycle/migration.sql
prisma/migrations/20261019133000_add_purchase_order_gst_snapshots/migration.sql
prisma/migrations/20261019150000_add_payment_cheque_clearance/migration.sql
prisma/migrations/20261019160000_add_project_close_permission/migration.sql
prisma/schema.prisma
scripts/build-runtime-smoke.js
scripts/build.js
scripts/db-upgrade.js
scripts/doctor.js
scripts/lib/db-manager.js
scripts/lib/env-file.js
scripts/lib/env-manager.js
scripts/lib/migration-preflight.js
scripts/lib/prisma-cli.js
scripts/lib/test-database-config.js
scripts/package-candidate.js
scripts/package-release.js
scripts/setup.js
tests/migration_provenance.test.js
tests/migration_upgrade.test.js
tests/payment_posting.test.js
tests/phase6.test.js
tests/purchase_order_gst.test.js
tests/purchases_and_financials.test.js
tests/release_build.test.js
tests/release_migration_compatibility.test.js
tests/reports_reconciliation.test.js
tests/test_database_config.test.js
```

Explicitly excluded and preserved for the user: `.vscode/settings.json` (local tooling), `filestructure.txt` (includes local artifact/data inventory), `scripts/qa_search_browser_e2e.js` (unrelated deletion), `tests/quotation_long_item_regression.test.js`, and `tests/templates.test.js` (unrelated existing staged test changes). No exclusion means those user changes should be discarded. Do not run git add -A, git commit -a, reset or clean.

## Approval-controlled next steps

1. Approve the correction plan/file scope and confirm whether any of the five pending SQL files has ever been applied outside this workspace. Resolve unknown legacy ownership/tax/retention/role policies explicitly. Prepare corrections and regression tests, review the resulting exact diff, then obtain separate explicit commit approval. Preserve all 22 committed SQL files.
2. Supply disposable server host/port, intended database names, expected server/account identity, supported MySQL/MariaDB version and deployment OS. Provide credentials through an approved local configuration mechanism, not chat. Identify separate fresh-install, populated-upgrade and restore targets plus a dedicated denied-CREATE account. Verify SELECT DATABASE(), CURRENT_USER(), server hostname/port and VERSION() read-only before writes. For a missing schema, validate server/account identity before CREATE and validate SELECT DATABASE() immediately after; never substitute an existing protected schema for this check.
3. Only after explicit write approval, create synthetic fixtures or restore an approved sanitized baseline. Capture table counts and canonical representative-row hashes, per-business/year invoice totals, posted/pending/void payment totals, supplier payables/settlements, project-cost categories, stock quantity/value, journal debits/credits and attachment metadata/file hashes. Compare before/after; apply only committed migrations; run twice and compare schema/ledger/data again.
4. Exercise wrong/protected/legacy targets and failed migration behavior using mocks or separately approved disposable schemas only. Never contact a protected database to demonstrate refusal. Test denied CREATE with the dedicated scoped account; do not alter account grants as part of the installer.
5. Produce a backup with checksums and consistency evidence; restore to a separately approved empty target, compare the same data/financial invariants and run smoke tests. A dump hash or successful dump command alone does not establish restorability. No destructive cleanup/drop/reset is part of this plan.
6. Run login/persistent-session, quotation/project, procurement, invoice/payment, inventory, report, attachment and accounting-reconciliation workflows in approved staging. Fresh-install login also requires an explicitly approved synthetic administrator bootstrap because install:migrate never seeds users.
7. After approved commits, rebuild a new candidate, validate provenance against committed SQL, perform clean production install and actual readiness/health checks on the intended OS, and report passed/failed/blocked/not-tested separately. Do not promote the earlier allCommitted:false candidate. No production-readiness conclusion is currently supported.

## Workspace preservation note

After this report was created, the workspace file inventory also added its filename to filestructure.txt (the existing unstaged additions increased from 48 to 49 lines). No explicit inventory edit was issued by this review. That generated addition was preserved and remains outside the proposed commit scope. Comparing the complete tracked diff before and after the review showed no other changed diff sections; application, migration, release-script and existing documentation changes were preserved. The existing candidate inspection preceded creation of this new report, which is not yet in that candidate.

## Phase 1 correction approval checkpoint (19 October 2026)

This section supersedes the initial review's "only workspace file added" statement for this continuation. The user approved corrections and regression-test preparation, but explicitly required a stop if R11 needs a new migration. That boundary was reached before application or SQL corrections. No finding is marked fixed by this checkpoint.

### R11 decision requiring review

The existing business/receipt-number unique key protects a chosen document number, but automatic numbering allocates another number on each request. The GRN editor sends neither a stable request key nor a receipt number. Requiring the caller to supply a permanent GRN number could avoid additional DDL, but changes the existing automatic-number workflow. Proposed choice: retain automatic numbering and persist a separate immutable request key with a canonical payload fingerprint. This design needs approval before its migration, Prisma fields or application behavior are created.

**Proposed file (not created):**
`prisma/migrations/20261019170000_add_goods_receipt_idempotency/migration.sql`

**Exact proposed SQL (not executed):**

```sql
ALTER TABLE `goods_receipts`
    ADD COLUMN `idempotencyKey` VARCHAR(36) NULL,
    ADD COLUMN `requestHash` CHAR(64) NULL;

CREATE UNIQUE INDEX `goods_receipts_businessId_idempotencyKey_key`
    ON `goods_receipts`(`businessId`, `idempotencyKey`);
```

Nullable columns preserve existing receipts without invented keys/hashes. New requests must supply a canonical UUID request key, generated once for a receipt draft and retained across retries, double clicks and network failures. A genuinely new receipt gets a new key. The server validates the UUID and hashes a versioned canonical representation of the authorized business, actor and effective persisted input (including explicit date, supplier/PO, allocations, locations, notes, ordered lines, quantities and cost). Dates/defaults and numeric representations must be normalized deterministically before hashing; no per-attempt timestamp or allocated number may enter the hash. Store the fingerprint and receipt atomically with all receipt/stock writes.

Same business/key/hash returns the original committed receipt without stock, numbering or audit writes; a different hash returns conflict. A unique-key race must roll back the losing transaction and resolve the winner outside that failed transaction, comparing its hash. Restrict this recovery to the request-key unique conflict; do not treat every P2002 as a replay. Old null-key receipts cannot be inferred as retries or retroactively fingerprinted. Voided/cancelled receipts retain their key and cannot be replayed as a new posting. Review response authorization on replay and preserve the original result/status.

Before writes, lock projects, PO header and relevant PO lines in a consistent documented order, then read current quantities through the same transaction. Aggregate repeated request lines by PO-line ID or reject duplicates. Count accepted quantities for fulfillment; rejected units do not fulfill the order and replacement acceptance must not exceed the outstanding accepted obligation. Require each linked PO line to belong to that PO and authorized business; retain each line's project allocation when creating stock/cost records. Reject unlinked lines on a linked-PO request rather than bypassing its limit. Closure must share the project lock protocol with every relevant writer. Database isolation/locking, parallel execution, deadlocks and retry behavior still need approved live tests.

MySQL DDL may partially commit: the ALTER and unique index are separate steps. This proposal does not authorize retrying partial DDL blindly or calling migrate resolve. Preserve failure evidence and inspect exact schema/ledger under a separate approved recovery plan. Index size, nullable unique semantics, locking and supported server versions remain untested. M2 precedes this new file in local ordering, but external deployment history and all earlier blockers remain release gates.

### External deployment history

| Migration | External history | Consequence |
|---|---|---|
| M1: 20261017183000_add_project_costing_and_attachments | unknown | Preserve SQL/checksum |
| M2: 20261018200000_add_goods_receipts_and_enhanced_attachments | unknown | Preserve SQL/checksum |
| M3: 20261019120000_add_quotation_acceptance_project_lifecycle | unknown | Preserve SQL/checksum |
| M4: 20261019133000_add_purchase_order_gst_snapshots | unknown | Preserve SQL/checksum |
| M5: 20261019150000_add_payment_cheque_clearance | unknown | Preserve SQL/checksum |

No deployment/ledger evidence was supplied in this continuation. Local Git state does not establish external history. Forward correction cannot undo guessed ownership or fabricated verification after the fact without independent source evidence. Before applying any pending DDL, a read-only compatibility gate must reject unresolved ownership, orphan/foreign-tenant references, target unique collisions and unsupported legacy snapshots. That additional gate is proposed, not implemented. Never run known-unsafe M1 first and rely on a later migration to recover information it discarded.

### Proposed policy decisions (not approvals)

- Ownership: unresolved projects/costs block upgrade until evidenced mapping to an existing business is approved; no business-1 fallback or automatic transfer.
- Cost history: keep existing account IDs, posted lines, costs and source references. Classify from authoritative evidence only; unknown classification/recoverability/source identity stays explicitly legacy/unknown. Disable unproven source reposting; do not synthesize identities to make uniqueness pass.
- Supplier history: retain original totals. Missing tax snapshots/eligibility/verification are unknown, not zero-tax or VERIFIED. A forward marker design and evidence-backed remediation need separate review; defaults alone cannot identify which rows were originally legacy.
- Retention: retain RESTRICT for financial cost history; no cascade, metadata purge or physical attachment deletion until an explicit retention/legal policy and authorized purge workflow exist. Current implementation still needs correction.
- Permissions: narrowly insert PROJECTS:CLOSE idempotently, preserve existing roles/users/grants and grant no role automatically. Owners/FULL_ACCESS retain their existing code behavior; managers/custom roles require explicit administrator assignment. The previously proposed 20261019160000 permission migration is still uncreated.
- Receipts: proposed request-key/hash contract and accepted-quantity rules above; line-level tenant/project allocation is mandatory. Shipment rejection does not count as fulfillment.
- Timestamps: preserve current server behavior pending decision; proposed target is Prisma-managed updatedAt for these four tables only if every approved writer supplies it. Server-managed timestamps may be necessary for external writers. Do not remove automation until writer inventory and an explicit forward column definition are reviewed.
- Indexes: propose removing redundant sourceQuotationId model index while retaining uniqueness. Inherited equivalent index-name aliases are not grounds for replacing indexes blindly.
- Privileges/recovery: runtime account should have only required application DML; the separate migration identity has approved schema DDL, and optional creation is scoped to one approved database. No GRANT/account creation, reset, broad seed or automatic partial-DDL repair. A backup acknowledgement is not a restore test.

### R01–R15 checkpoint status

| Finding | Status | Work remaining |
|---|---|---|
| R01 | blocked | Evidence-backed ownership; compatibility gate and reviewed SQL strategy |
| R02 | blocked | Preserve RESTRICT through reviewed forward correction; retention decision |
| R03 | blocked | Explicit legacy unknown state and evidence-backed tax handling |
| R04 | blocked | Approved source/classification mapping; legacy repost protection |
| R05 | blocked | Actual-business account resolution/creation and persistent acceptance tests; not changed at this stop |
| R06 | blocked | Transactional distinct-line tenant validation, including updates |
| R07 | blocked | Preserve memo snapshots; atomic financial recalculation |
| R08 | blocked | Posted/cleared cash and authoritative outstanding reconciliation |
| R09 | blocked | Accepted deliveries, posted settlements, terminal costs and shared writer locking |
| R10 | blocked | Prepare permission migration, remove duplicate action; no new grants |
| R11 | blocked | Persistent failing TODO acceptance tests prepared; production defect remains; approve proposal before implementing |
| R12 | blocked | Required audit through business transaction; propagate mandatory failures |
| R13 | blocked | Timestamp writer/policy decision and forward SQL |
| R14 | blocked | Remove redundant model index deliberately; live introspection remains unverified |
| R15 | partially fixed | Architecture/checkpoint now state actual limits; conflicting older operational docs still need correction |

Neither R11 receipt invariant passes. Other authorized corrections remain unimplemented because of the user's explicit stop condition, not a claim that each needs fresh individual permission.

### Verification in this correction checkpoint

Executed:

```text
node --test tests/release_build.test.js tests/migration_upgrade.test.js tests/test_database_config.test.js tests/release_migration_compatibility.test.js
node --check tests/release_migration_compatibility.test.js
git diff --check
git diff --cached --check
```

Tests: **28 pass, 2 TODO with failing assertions**. The TODOs execute actual receipt service code with injected in-memory dependencies and expose two receipts for one request and a remaining-quantity read outside the transaction. Node exits zero for TODO failures; that is not acceptance evidence. Mocks do not load Prisma/application environment or create/delete fixture files. Existing guard tests cover explicit creation, denied privileges, upgrade/repeat behavior, wrong/protected targets and legacy history; this is mock coverage only. Provenance fixture tests were deliberately not rerun because they delete their fixture directories.

Installed Prisma validation passed with explicit prisma7.config.ts, synthetic loopback port-1 URLs, update checks disabled and net.Socket.connect replaced with a throwing network guard. An initial attempt resolving the package root failed MODULE_NOT_FOUND before validation; rerunning with installed node_modules/prisma/build/index.js passed. No install/download or Prisma migrate/db command was used. Config loads .env but datasource/shadow URLs were explicitly overridden; no values were printed. Syntax and both diff-whitespace checks passed, with Git's existing CRLF-normalization warning for scripts/db-upgrade.js.

Not tested/rebuilt: build, clean production install/startup, artifact contents after changes, provenance fixture suite, database creation, SQL replay/upgrades, live concurrency/idempotency, data/tenant preservation, partial-DDL recovery, backup/restore or business workflows. Prior candidate results remain historical evidence only. Current release remains blocked; no production-readiness conclusion.

### Exact revised proposed commit scope

This is a **future implementation scope**, not approval to commit the existing index. Original report: 82 paths. Proposed additions: the GRN editor and new request-identity migration below; removals: none; revised total: **84 paths**. The permission migration and request-identity migration in this list do not exist. The new test is now present. No schema or UI changes for this design have been made.

```text
.gitignore
app/app.js
app/controllers/invoice.controller.js
app/controllers/item.controller.js
app/controllers/payment.controller.js
app/controllers/project.controller.js
app/controllers/purchase.controller.js
app/controllers/report.controller.js
app/controllers/supplier.controller.js
app/routes/invoice.routes.js
app/routes/web.routes.js
app/services/accounting/posting.service.js
app/services/accounting/report.service.js
app/services/activity.service.js
app/services/attachment.service.js
app/services/chartOfAccounts.service.js
app/services/documentView.service.js
app/services/goodsReceipt.service.js
app/services/invoice.service.js
app/services/navigation.service.js
app/services/payment.service.js
app/services/project.service.js
app/services/purchaseOrder.service.js
app/services/rbac.service.js
app/services/reportingWorkbench.service.js
app/services/supplier.service.js
app/views/documents/view.ejs
app/views/layouts/header.ejs
app/views/projects/details.ejs
app/views/purchases/grn-editor.ejs
app/views/purchases/orders.ejs
app/views/purchases/po-editor.ejs
app/views/reports/customer-statement.ejs
app/views/suppliers/form.ejs
app/views/suppliers/index.ejs
assets/css/documents.css
assets/css/main.css
assets/css/projects.css
assets/js/spark-daterange.js
assets/js/view.js
docs/DATABASE.md
docs/DEPLOYMENT.md
docs/INSTALLATION.md
docs/PROJECT_LIFECYCLE_AUDIT.md
docs/PROJECT_LIFECYCLE_IMPLEMENTATION_PLAN.md
docs/PROJECT_LIFECYCLE_RUNBOOK.md
docs/RELEASE_AND_MIGRATION_ARCHITECTURE.md
docs/RELEASE_MIGRATION_REVIEW_2026-10-19.md
docs/TESTING.md
docs/UPGRADE_GUIDE.md
docs/USER_MANUAL.md
package-lock.json
package.json
prisma/migrations/20261017183000_add_project_costing_and_attachments/migration.sql
prisma/migrations/20261018200000_add_goods_receipts_and_enhanced_attachments/migration.sql
prisma/migrations/20261019120000_add_quotation_acceptance_project_lifecycle/migration.sql
prisma/migrations/20261019133000_add_purchase_order_gst_snapshots/migration.sql
prisma/migrations/20261019150000_add_payment_cheque_clearance/migration.sql
prisma/migrations/20261019160000_add_project_close_permission/migration.sql
prisma/migrations/20261019170000_add_goods_receipt_idempotency/migration.sql
prisma/schema.prisma
scripts/build-runtime-smoke.js
scripts/build.js
scripts/db-upgrade.js
scripts/doctor.js
scripts/lib/db-manager.js
scripts/lib/env-file.js
scripts/lib/env-manager.js
scripts/lib/migration-preflight.js
scripts/lib/prisma-cli.js
scripts/lib/test-database-config.js
scripts/package-candidate.js
scripts/package-release.js
scripts/setup.js
tests/migration_provenance.test.js
tests/migration_upgrade.test.js
tests/payment_posting.test.js
tests/phase6.test.js
tests/purchase_order_gst.test.js
tests/purchases_and_financials.test.js
tests/release_build.test.js
tests/release_migration_compatibility.test.js
tests/reports_reconciliation.test.js
tests/test_database_config.test.js
```

Actual edits in this checkpoint: this report and docs/RELEASE_AND_MIGRATION_ARCHITECTURE.md. New file: tests/release_migration_compatibility.test.js. No application or migration source edits, staging, commit, database contact/write, archive overwrite, deployment or deletion occurred. The excluded files and index are checked separately against the starting snapshot; any automatic file inventory update is reported without reverting it.

Approval needed at this stop: review the proposed 20261019170000 migration SQL and two-path scope addition, or explicitly choose stable caller-supplied document numbering instead. Implementation and all acceptance tests must subsequently pass before any separate commit request. External history, policy decisions and disposable-database approval remain independent gates.

### Workspace preservation verification at this stop

SHA-256 comparison against the start-of-correction snapshot confirms the index is unchanged and all 27 migration SQL files are unchanged (22 committed plus M1–M5). No path was removed. The only new file is the persistent receipt test. Existing source, archive and excluded-file content was preserved except the automatic inventory update described next.

The environment automatically added the new test to filestructure.txt: its unstaged additions increased from 49 to 50 lines. No explicit edit to that excluded file was issued and no attempt was made to revert the automatic change. All other excluded files match their starting hashes. The two blocked temporary directories were not touched.

Git status has 61 tracked changed paths: 9 have staged changes, 56 have unstaged changes, and 4 have both (supplier controller, routes, file inventory, Prisma schema). There are 24 untracked files. Those existing staged/unstaged discrepancies remain; this is not a clean commit candidate. Full status at this checkpoint:

```text
M  .gitignore
 M app/app.js
 M app/controllers/invoice.controller.js
 M app/controllers/item.controller.js
 M app/controllers/payment.controller.js
 M app/controllers/project.controller.js
 M app/controllers/purchase.controller.js
 M app/controllers/report.controller.js
AM app/controllers/supplier.controller.js
 M app/routes/invoice.routes.js
MM app/routes/web.routes.js
 M app/services/accounting/posting.service.js
 M app/services/accounting/report.service.js
 M app/services/activity.service.js
 M app/services/attachment.service.js
 M app/services/chartOfAccounts.service.js
 M app/services/documentView.service.js
 M app/services/invoice.service.js
 M app/services/navigation.service.js
 M app/services/payment.service.js
 M app/services/project.service.js
 M app/services/purchaseOrder.service.js
 M app/services/rbac.service.js
 M app/services/reportingWorkbench.service.js
 M app/services/supplier.service.js
 M app/views/documents/view.ejs
 M app/views/layouts/header.ejs
 M app/views/projects/details.ejs
 M app/views/purchases/orders.ejs
 M app/views/purchases/po-editor.ejs
 M app/views/reports/customer-statement.ejs
 M assets/css/documents.css
 M assets/css/main.css
 M assets/js/spark-daterange.js
 M assets/js/view.js
 M docs/DATABASE.md
 M docs/DEPLOYMENT.md
 M docs/INSTALLATION.md
 M docs/TESTING.md
 M docs/UPGRADE_GUIDE.md
 M docs/USER_MANUAL.md
MM filestructure.txt
 M package-lock.json
 M package.json
A  prisma/migrations/20261017183000_add_project_costing_and_attachments/migration.sql
A  prisma/migrations/20261018200000_add_goods_receipts_and_enhanced_attachments/migration.sql
MM prisma/schema.prisma
 M scripts/db-upgrade.js
 M scripts/doctor.js
 M scripts/lib/db-manager.js
 M scripts/lib/env-manager.js
 M scripts/package-candidate.js
 M scripts/package-release.js
 M scripts/qa_search_browser_e2e.js
 M scripts/setup.js
 M tests/payment_posting.test.js
 M tests/phase6.test.js
 M tests/purchases_and_financials.test.js
M  tests/quotation_long_item_regression.test.js
 M tests/reports_reconciliation.test.js
M  tests/templates.test.js
?? .vscode/settings.json
?? app/views/suppliers/form.ejs
?? app/views/suppliers/index.ejs
?? assets/css/projects.css
?? docs/PROJECT_LIFECYCLE_AUDIT.md
?? docs/PROJECT_LIFECYCLE_IMPLEMENTATION_PLAN.md
?? docs/PROJECT_LIFECYCLE_RUNBOOK.md
?? docs/RELEASE_AND_MIGRATION_ARCHITECTURE.md
?? docs/RELEASE_MIGRATION_REVIEW_2026-10-19.md
?? prisma/migrations/20261019120000_add_quotation_acceptance_project_lifecycle/migration.sql
?? prisma/migrations/20261019133000_add_purchase_order_gst_snapshots/migration.sql
?? prisma/migrations/20261019150000_add_payment_cheque_clearance/migration.sql
?? scripts/build-runtime-smoke.js
?? scripts/build.js
?? scripts/lib/env-file.js
?? scripts/lib/migration-preflight.js
?? scripts/lib/prisma-cli.js
?? scripts/lib/test-database-config.js
?? tests/migration_provenance.test.js
?? tests/migration_upgrade.test.js
?? tests/purchase_order_gst.test.js
?? tests/release_build.test.js
?? tests/release_migration_compatibility.test.js
?? tests/test_database_config.test.js
```


