# Spark Admin Accounting ERP — Architectural Decision Log (ADR & Decision Matrix)

**Document Version:** 1.0.0  
**Status:** APPROVED & AUDITED  
**Repository:** `anmolscripts/admin`  

---

## 1. Executive Summary & Governance

This Decision Log tracks all core engineering, architectural, accounting, security, and release decisions made across Phases 0 through 9 of the Spark Admin Autonomous Enterprise Delivery Programme.

All changes adhere to the canonical constraints:
- Non-destructive forward-only database evolution.
- Strict isolation of the protected `admin` database; disposable `spark_admin_test` and `spark_admin_test_shadow` used for all automated checks.
- Server-authoritative double-entry invariant: $\sum \text{Debit} \equiv \sum \text{Credit}$ down to the exact integer cent.
- Idempotent document posting (`SUPPLIER_BILL:<id>`, `EXPENSE:<id>`, `OTHER_INCOME:<id>`, `INVOICE:<id>`, `PAYMENT:<id>`).
- Closed Financial Year period locking.

---

## 2. Decision Matrix by Phase

### Phase 0: Baseline & Safety Invariants
- **Decision:** Mandate disposable database isolation for all development and automated test executions.
- **Rationale:** The production/protected database `admin` must never be mutated by developer testing, schema resets, or test fixtures.
- **Implementation:** Built `scripts/guard.js`, `scripts/db-target.js`, and `prisma7.config.ts` enforcing `spark_admin_test` and `spark_admin_test_shadow`.

### Phase 1: Security & Packaging Safeguards
- **Decision:** Enforce hard guardrails in `scripts/db-reset.js` requiring exact database confirmation and strictly prohibiting resets in `NODE_ENV=production`.
- **Rationale:** Eliminate accidental data loss risks.
- **Implementation:** Multi-stage checks rejecting `admin` database resets and verifying non-production mode.

### Phase 2: Design System & Responsive UI Tokens
- **Decision:** Use unified Vanilla CSS custom properties in `assets/css/theme.css` and `assets/css/components/` without introducing heavyweight frontend build pipelines.
- **Rationale:** Maximizes long-term maintainability, sub-millisecond server rendering in EJS, and clean visual consistency across desktop and mobile.

### Phase 3: Core Accounting Invariants & Lifecycle Locking
- **Decision:** Enforce that posted documents and journals are strictly immutable once finalized (`POSTED` or `REVERSED`).
- **Rationale:** Audit compliance and accounting standards prohibit in-place tampering of financial records.
- **Implementation:** Formal reversing journal entries linked via `reversedEntryId` and atomic financial year period locking.

### Phase 4: Purchases, Supplier Bills, Expenses & Non-Invoice Income
- **Decision:** Keep Purchase Orders strictly separate from Supplier Bills.
  - **Key Invariant:** Creating or approving a Purchase Order does **NOT** post any journal entry or alter Accounts Payable / Expense accounts.
  - **Supplier Bills:** Represent formal trade payables. Posts balanced double-entry entries:
    - $\text{Debit: COGS / Direct Purchases (Account 5110)}$
    - $\text{Debit: Input CGST (1131) + Input SGST (1132) OR Input IGST (1133)}$
    - $\text{Credit: Accounts Payable (2121)}$
  - **Operating Expenses:** Posts $\text{Debit: Admin Expense (5210)}$ / $\text{Credit: Bank (1112) or Cash (1111)}$.
  - **Other Income:** Posts $\text{Debit: Bank (1112) or Cash (1111)}$ / $\text{Credit: Service / Other Income (4120)}$.
- **Implementation:** Services `purchaseOrder.service.js`, `supplierBill.service.js`, `supplier.service.js`, `expense.service.js`, `otherIncome.service.js`, `purchase.controller.js`, web routes, responsive EJS views, and migration `20261010093000_add_bills_expenses_income`.

### Phase 5: Inventory & Item CSV Import with Dry-Run Preview
- **Decision:** Provide a two-phase CSV import workflow (`preview` and `commit`) with a dry-run guarantee.
  - **Safety Invariant:** Dry-run preview (`POST /api/items/import/preview`) parses, sanitizes, and checks duplicates and deltas against the Item Master with **ZERO** database writes.
  - **Commit:** Transactionally commits only validated rows (`POST /api/items/import/commit`), updating existing catalog entries or inserting new items.
- **Implementation:** `itemService.parseAndValidateItemCsv`, `itemService.importItemsFromCsv`, routes in `invoice.routes.js`, and comprehensive test suite `tests/item_import_inventory.test.js`.

### Phase 6: Payroll Requirements & Indian Statutory Compliance Scope
- **Decision (Planning & Scope Definition):**
  - Indian Payroll statutory framework encompasses:
    1. **Provident Fund (PF):** Employee contribution (12% of Basic + DA) and Employer contribution (12% split between EPF 3.67% and EPS 8.33% up to statutory wage ceiling of ₹15,000/month).
    2. **Employee State Insurance (ESI):** Applicable if gross wages $\le$ ₹21,000/month (Employee: 0.75%, Employer: 3.25%).
    3. **Professional Tax (PT):** State-specific slabs (e.g. Maharashtra slab of ₹200/month, ₹300 in February).
    4. **TDS on Salary (Statutory Provision):**
       - Tax Year 2026–27 onwards (salaries paid from April 2026): Section 392(1) of the Income-tax Act, 2025.
       - Historical periods (prior to April 2026): Section 192 of the Income-tax Act, 1961.
       - Tax deduction at source based on annual projected taxable income under Old vs. New Tax Regimes.
  - **Accounting Posting Model:**
    - $\text{Debit: Salaries & Wages Expense (Account 5100 series)}$
    - $\text{Credit: PF Payable (Current Liability)}$
    - $\text{Credit: ESI Payable (Current Liability)}$
    - $\text{Credit: Professional Tax Payable (Current Liability)}$
    - $\text{Credit: TDS on Salaries Payable (Current Liability)}$
    - $\text{Credit: Net Salary Payable to Employees (Current Liability)}$
    - On disbursement: $\text{Debit: Salary Payable}$ / $\text{Credit: Operating Bank Account (1112)}$.

### Phase 7: Project Costing & Labour Cost Allocation Model
- **Decision (Planning & Scope Definition):**
  - Project/Job Costing architecture links directly to commercial quotations and invoices:
    1. **Cost Centers / Project Codes:** Track revenue, direct materials, subcontracting, and direct labour per project.
    2. **Labour Cost Absorption:** Standard hourly labour rates allocated from timesheet records into Project Work-In-Progress (WIP) or Cost of Goods Sold.
    3. **Double-Entry Flow:**
       - $\text{Debit: Project WIP / Direct Labour Cost (COGS)}$
       - $\text{Credit: Labour Recovery / Allocated Payroll Clearing Account}$
    4. **Reconciliation:** Project subledger reconciles with general ledger revenues and expenses, providing project-level gross margin analytics.

### Phase 8: Universal Global Search & Product Hardening
- **Decision:** Universal keyboard-driven search (`Ctrl+K`) indexing across documents, clients, items, accounts, and system navigation with server-side RBAC scoping.
- **Implementation:** Verified in `app/services/search.service.js`, `tests/search.test.js`.

### Phase 9: Release Readiness & Verification Gates
- **Decision:** Master verification script `scripts/verify-all.js` acts as the definitive release gate.
  - Zero-defect standard: 10/10 quality checks must pass.
  - Automated release packaging (`scripts/package-release.js`) generates clean distribution archive `dist/spark-admin-release.zip` with zero secret leaks.

---

## 3. Audited Invariant Verification Status

| Invariant | Specification | Verification Result |
|---|---|---|
| Double-Entry Balance | $\sum \text{Debit} \equiv \sum \text{Credit}$ | PASS (integer-cent verified across all suites) |
| Idempotency | Canonical document posting keys | PASS (`INVOICE:<id>`, `SUPPLIER_BILL:<id>`, `EXPENSE:<id>`, `OTHER_INCOME:<id>`) |
| Closed FY Rejection | Rejection of mutations in closed period | PASS (verified with `400 Bad Request`) |
| PO Invariant | No premature ledger postings | PASS (verified zero journal entries created on PO creation) |
| CSV Import Safety | Zero mutations on dry-run preview | PASS (verified `item.count()` unchanged on preview) |
| Release Package | Zero leaks (.env, secrets, logs) | PASS (verified 236 clean files in ZIP archive) |
| Master Test Suite | `npm test` & `verify:all` | PASS (623 tests, 0 failures, 10/10 gates passed) |
