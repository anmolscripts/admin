# Production Release Verification Checklist

Every production release must undergo this sequential verification before tagging, deploying, or distributing builds.

---

## 1. Automated Verification
- [ ] **Full Test Suite:** Run `npm test`. All tests must pass with 0 failures and exit naturally without hanging.
- [ ] **System Doctor Diagnostic:** Run `npm run doctor`. Must report 100% PASS for runtime, config, DB, RBAC, master data, and invariants.
- [ ] **Prisma Schema Validation:** Run `npx prisma validate`. Schema syntax and relations must be valid.
- [ ] **Prisma Format Check:** Run `npx prisma format`.
- [ ] **Migration Cleanliness:** Run `npx prisma migrate status`. All migrations must be applied; zero unapplied migrations or schema drift.

---

## 2. Git & Working Tree Hygiene
- [ ] **Git Diff Check:** Run `git diff --check`. Must return zero whitespace errors, merge conflicts, or CRLF mismatch warnings.
- [ ] **No Secret Tracking:** Verify `.env` is untracked and in `.gitignore`.
- [ ] **Secret Scan:** Search tracked files for unintended credentials:
  ```bash
  git grep -i "password"
  git grep -i "secret"
  git grep -i "token"
  ```
  Ensure matches are restricted to documentation and variable names.
- [ ] **Working Tree State:** Run `git status`. Ensure only intentional release files are tracked; zero untracked artifacts.

---

## 3. Runtime & Smoke Test Verification
- [ ] **Production Startup Test:** Run `NODE_ENV=production npm start`. Verify clean server initialization without uncaught exceptions.
- [ ] **Health Endpoint:** Query `GET /health`. Confirm HTTP 200 `{ "status": "ok", "database": "connected" }`.
- [ ] **Authentication Smoke Test:**
  - Open `/login`.
  - Submit valid credentials. Confirm redirect to `/dashboard`.
  - Submit invalid credentials. Confirm controlled error feedback without stack traces.
- [ ] **Document Creation & Custom Dates:**
  - Create a Quotation with custom `validUntil`. Save, reload, confirm date persisted.
  - Create an Invoice with custom `dueDate`. Save, reload, confirm date persisted.
- [ ] **Quotation Conversion:**
  - Convert active Quotation to Invoice.
  - Verify new `INV-` number assigned and `sourceQuotationId` linked.
  - Verify quotation's `validUntil` does not overwrite invoice's `dueDate`.
- [ ] **Payment Recording & Balances:**
  - Record a partial payment on an active invoice.
  - Verify `paidAmount` and `outstandingAmount` recalculate accurately.
- [ ] **Document Presentation & Exports:**
  - Open `/documents/:id/print`. Confirm print preview matches layout.
  - Open `/api/invoices/:id/pdf`. Confirm valid binary PDF downloads with matching layout.
  - Open `/api/invoices/export/excel`. Confirm valid XLSX workbook opens with formatted currency columns.
- [ ] **Dashboard Aggregations:**
  - Open `/dashboard`. Confirm KPI totals, overdue metrics, and chart series render.
  - Toggle date ranges (`today`, `this_quarter`, `custom`). Confirm zero calculation errors.

---

## 4. Disaster Recovery & Backup
- [ ] **Pre-Release Database Backup:** Execute `mysqldump` and confirm backup `.sql.gz` file exists on durable storage.
- [ ] **Rollback Plan Confirmed:** Previous stable release commit hash noted and rollback command tested.

---

## 5. Tagging & Final Release
- [ ] Commit finalized with standard message.
- [ ] Git tag created: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
- [ ] Verify tag metadata.
