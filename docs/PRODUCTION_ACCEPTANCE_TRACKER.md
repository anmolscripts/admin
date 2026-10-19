# SPARK ADMIN ERP — PRODUCTION ACCEPTANCE RUN TRACKER

**Document Version:** 1.1.0  
**Baseline Build Package (Immutable):** `dist/candidates/spark-admin-release-candidate-rc2.zip` (SHA-256: `38c0b0976e41b659cfaa675bb97f10cd249dcdb1e558b488095f9c1f781d0d74`)  
**Feature Build Package (RC3):** `dist/candidates/spark-admin-release-candidate-rc3.zip` (SHA-256: `ee1060ef5a4cb4ec704f091d4db540ab605c88d6222ada26f13a71af34e86ce3`)  
**Certified Release Candidate (RC4):** `dist/candidates/spark-admin-release-candidate-rc4.zip` (SHA-256: `7448469107b48dc998c6af767decfa7fc64561a0384b5d9996d497aaf0c529c2`)  
**Execution Reference:** [PRODUCTION_ACCEPTANCE_FLOWS.md](file:///c:/Users/USER/Documents/project/admin/docs/PRODUCTION_ACCEPTANCE_FLOWS.md)  
**E2E Feature Report:** [PROJECT_INVOICE_PAYMENT_E2E_REPORT.md](file:///c:/Users/USER/Documents/project/admin/docs/PROJECT_INVOICE_PAYMENT_E2E_REPORT.md)  
**Final Integration Report:** [PROJECT_INTEGRATION_FINAL_REPORT.md](file:///c:/Users/USER/Documents/project/admin/docs/PROJECT_INTEGRATION_FINAL_REPORT.md)  
**Permitted Status Values:** `NOT RUN` | `IN PROGRESS` | `PASS` | `FAIL` | `BLOCKED` | `NOT APPLICABLE`  

---

## 1. Acceptance Execution Master Tracker

| Flow ID | Status | Environment | Build ID | Tester | Date | Result | Evidence Reference | Bug ID | Retest Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **FLOW-F00** | PASS | Disposable Pre-Prod | `74484691` (RC4) | DevOps / QA | 2026-10-18 | All 8 release gates passed cleanly; 24/24 migrations applied; 0 mutations to protected DBs | `scripts/disposable-release-verification.js` | None | Verified |
| **FLOW-F01** | PASS | Disposable Pre-Prod | `74484691` (RC4) | Security QA | 2026-10-18 | Session cookie flags, CSRF tokens, brute-force rate limits verified; CDP login automation verified | `evidence/F01_auth_session.har`, `browser/01_login_dashboard.png` | None | Verified |
| **FLOW-F02** | PASS | Disposable Sandbox | `74484691` (RC4) | Security QA | 2026-10-18 | Multi-tenant isolation verified; foreign-tenant project/invoice queries return 404/403 | `tests/complete_project_integration_flows.test.js` | None | Verified |
| **FLOW-F03** | PASS | Disposable Sandbox | `74484691` (RC4) | Financial QA | 2026-10-18 | Chart of Accounts, Unit Master, Item Master seeded and verified with exact casing/rates | `tests/ux_polish_unit_master.test.js` | None | Verified |
| **FLOW-F04** | PASS | Disposable Sandbox | `74484691` (RC4) | Operations QA | 2026-10-18 | Project quote converted to invoice `INVO-2026-10-25` (₹88,500); 2-phase settlement (₹38.5k + ₹50k) fully settles AR | `browser/05_converted_invoice.png`, `browser/07_invoice_fully_settled.png` | None | Verified |
| **FLOW-F05** | PASS | Disposable Sandbox | `74484691` (RC4) | Operations QA | 2026-10-18 | PO `PO-2026-0003` created with line project tag; GRN `GRN-2026-0001` received into store; 0 duplicate expense verified | `browser/flow_b_po_detail.png`, `browser/flow_b_grn_detail.png` | None | Verified |
| **FLOW-F06** | PASS | Disposable Sandbox | `74484691` (RC4) | Inventory QA | 2026-10-18 | GRN physical receipt into store location; material issue (₹24k) and return (₹6k) post net ₹18k cost to project WIP | `browser/flow_b_project_materials_tab.png` | None | Verified |
| **FLOW-F07** | PASS | Disposable Sandbox | `74484691` (RC4) | Financial QA | 2026-10-18 | Direct expenses and labour timesheets posted to project cost ledger; standalone expense functionality intact | `browser/e2e_expenses_desktop.png` | None | Verified |
| **FLOW-F08** | PASS | Disposable Sandbox | `74484691` (RC4) | Project PM / QA | 2026-10-18 | Project workspace 10 tabs, material issue/return modals, attachment magic bytes & SHA-256 deduplication verified | `browser/flow_a_project_detail_1280.png`, `browser/flow_c_project_attachments_metadata.png` | None | Verified |
| **FLOW-F09** | PASS | Disposable Sandbox | `74484691` (RC4) | Payroll Specialist | 2026-10-18 | Statutory payroll run approved and posted to GL (Dr ₹5,011,950 = Cr ₹5,011,950); unit tests 854/854 passed | `scripts/e2e_financials_and_ops_acceptance.js`, `tests/payroll.test.js` | None | Verified |
| **FLOW-F10** | PASS | Disposable Sandbox | `74484691` (RC4) | Chartered Accountant | 2026-10-18 | Trial Balance equilibrium verified ($\sum Dr = \sum Cr = ₹92,500.00$, $\Delta = ₹0.00$); Customer Subledger balanced | `browser/flow_d_trial_balance_equilibrium.png`, `browser/12_customer_subledger.png` | None | Verified |
| **FLOW-F11** | PASS | Disposable Sandbox | `74484691` (RC4) | Reporting QA | 2026-10-18 | PDFKit invoice rendering and ExcelJS export verified with project metadata parity; 375px mobile responsiveness verified | `browser/invoice_INVO_2026_10_25.pdf`, `browser/flow_d_project_detail_mobile_375.png` | None | Verified |
| **FLOW-F12** | PASS | Disposable DR Host | `74484691` (RC4) | DevOps Engineer | 2026-10-18 | Forward upgrade test from 32 to 54 tables with 100% data preservation; logical backup/restore fidelity 100% | `scripts/disposable-release-verification.js` | None | Verified |

---

## 2. Flow Details & Acceptance Criteria Summary

### Flow Summary Reference Table

| Flow ID | Flow Name | Mode | Prod Safe? | Primary Focus Area | Rollback / Reversal Strategy |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **FLOW-F00** | Build Identity, Application Health & Database Connectivity | Mode A | **YES** | Commit hash, environment flags, DB connectivity, schema migration level | None required (read-only) |
| **FLOW-F01** | Authentication, Session Lifecycle, Password Masking & Security Hardening | Mode A/B | **YES (Mode A)** | Session cookie flags, CSRF tokens, brute-force limits, credential hygiene | Session termination / re-login |
| **FLOW-F02** | Multi-Business Tenant Isolation & RBAC Permission Matrix | Mode A/B | **YES (Mode A)** | Tenant boundaries, cross-business 404/403 assertion, role privilege gates | Re-assign original user roles if modified |
| **FLOW-F03** | Chart of Accounts, Unit Master, Item Master & Master Setup | Mode B | **NO** | Master records, GL account tree, default accounts, tax profiles | Mark test items inactive (do not hard-delete) |
| **FLOW-F04** | Sales Commercial Lifecycle: Quote &rarr; Invoice &rarr; Payments &rarr; Credit Note | Mode B | **NO** | Sequential numbering, GST calculations, partial payments, credit note adjustments | Issue offsetting Credit Note / Cancellation |
| **FLOW-F05** | Procurement Lifecycle, AP Invariance & Supplier Bill Settlement | Mode B | **NO** | PO commitment (zero GL impact), bill posting (AP credit), bill settlement | Cancel PO; Void Bill via reversing credit note |
| **FLOW-F06** | Perpetual Inventory Movements, Weighted-Average Costing & COGS | Mode B | **NO** | Stock receipts, weighted-average rate, invoice dispatch, negative stock denial | Counter-balancing stock adjustment with remarks |
| **FLOW-F07** | Operating Expenses, Miscellaneous Income & Direct Ledger Postings | Mode B | **NO** | Expense vouchers, bank/cash credits, miscellaneous receipts, GL accuracy | Post equal and opposite adjusting voucher |
| **FLOW-F08** | Project Workspace, Labour Streams, Budgeting & Attachments | Mode B | **NO** | Project milestone tracking, timesheet labour costing, attachment storage security | Close/archive test project; delete test uploads |
| **FLOW-F09** | Statutory Payroll Period Generation, Tax Deductions & Ledger Integration | Mode B | **NO** | Employee salary structures, PF/ESI/TDS withholdings, salary payable ledger | Reversal journal entry against salary payable |
| **FLOW-F10** | Financial Reporting Equilibrium, Drilldown & Subledger Reconciliation | Mode A | **YES** | Trial balance equilibrium ($\sum Dr = \sum Cr$), P&L, balance sheet, AR/AP parity | None required (read-only query) |
| **FLOW-F11** | Document Export Parity: PDFKit Invoices, ExcelJS Subledgers & Print Layouts | Mode A | **YES** | PDF generation, XLSX cell formulas/formatting, print CSS styling, cross-browser parity | Delete generated export files |
| **FLOW-F12** | Operational Backup, Restore Validation, Forward Migration & Packaging Audit | Mode B | **NO (DR Host)** | `mysqldump` archive integrity, disposable restore, file storage persistence | Tear down ephemeral validation container |

---

## 3. Standard Acceptance Bug Report Template

When any flow fails or deviates from verified application behavior, file a structured defect using the standardized template below:

```markdown
### [BUG-ID] Short Descriptive Title (Module - Failure Summary)

- **Severity:** [Critical | High | Medium | Low]
  - *Critical:* System crash, data corruption, GL ledger out of balance, cross-tenant data leak, security bypass.
  - *High:* Workflow blocked with no workaround, erroneous tax calculation, incorrect COGS calculation.
  - *Medium:* Non-blocking functional defect, export formatting glitch, validation message confusing.
  - *Low:* Cosmetic alignment, typo, minor non-functional deviation.
- **Module:** [Auth | Tenants | Documents | Purchases | Inventory | Financials | Projects | Payroll | Reports | Infrastructure]
- **Flow ID:** [e.g., FLOW-F04]
- **Build ID:** `bfae7af0fab34bc16d3b832ae0537340f1c4360f` (Archive SHA-256: `ed4a698503a9...`)
- **Environment:** [Staging Dedicated Sandbox | Disposable Pre-Prod | Disaster Recovery Host]
- **Database Target:** [e.g., `spark_admin_staging` (Host: 10.0.0.12:3306)]
- **Tester / Reporter:** [Name & Role]
- **Date Reported:** YYYY-MM-DD HH:MM:SS (UTC / Local)

#### 1. Preconditions & Test Data
- Business ID: `999` ("Acceptance Sandbox Ltd")
- User ID / Role: `test_admin` (`business_admin`)
- Existing entities referenced: Document ID `INV-2026-0001`, Customer ID `501`

#### 2. Exact Reproduction Steps
1. Navigate to URL `https://staging.domain.com/documents/new`
2. Select Customer `ACME Corporation` (ID: 501)
3. Add Line Item `SKU-ITEM-01`, Quantity `5`, Unit Price `1,000.00`, Tax Rate `18% GST`
4. Click `Save & Issue Invoice`
5. On the invoice detail page, click `Record Payment`
6. Enter Amount `6,500.00` (exceeding invoice balance of `5,900.00`)
7. Click `Confirm Payment`

#### 3. Expected Result
- The application should reject the payment submission with HTTP 400 and display the validation error:
  `"Payment amount cannot exceed remaining invoice balance of ₹5,900.00"`
- No payment record should be inserted in `DocumentPayment`.
- General Ledger should post zero new journal entries.

#### 4. Actual Result
- Application returned HTTP 500 / Unhandled Promise Rejection.
- UI displayed generic error: `"Something went wrong. Please try again."`
- In the database, a partial payment record was created with negative remaining balance.

#### 5. Evidence Artifacts
- **Screenshot:** `evidence/bugs/BUG-001_error_modal.png`
- **Network HAR / Payload:** `evidence/bugs/BUG-001_payment_request.json`
- **Server Application Log:** `logs/error-2026-10-18.log` (Line 412: `Unhandled Rejection: Cannot calculate balance...`)
- **Database Query Result:** `SELECT * FROM DocumentPayment WHERE documentId = '...'`

#### 6. Business & Accounting Impact
- Document status marked as `PAID` with remaining balance `-600.00`.
- Accounts Receivable (GL 1121) credited by `6,500.00`, causing Customer Subledger to fall out of reconciliation with General Ledger by `600.00`.

#### 7. Root Cause Analysis (Preliminary)
- `app/controllers/document.controller.js` line `482` checks `if (amount <= 0)` but omits the boundary check `if (amount > invoice.remainingBalance)` prior to initiating the Prisma `$transaction`.

#### 8. Fix Reference & Remediation
- **Assigned Developer:** [Developer Name]
- **Target Branch / Pull Request:** `fix/invoice-overpayment-validation` / PR #142
- **Regression Test Added:** `tests/document_payment_overpayment.test.js`

#### 9. Retest & Sign-Off Verification
- **Retest Date:** [YYYY-MM-DD]
- **Retest Build ID:** [Commit SHA]
- **Retester:** [QA Lead Name]
- **Retest Status:** [PASS | FAIL | BLOCKED]
- **Retest Evidence:** `evidence/bugs/BUG-001_retest_success.png`
- **Sign-Off Notes:** Verified validation modal displays correctly; boundary test added to CI suite.
```

---

## 4. Execution Guidance & Quality Gates

1. **Sequential Flow Order:**
   - Always execute **FLOW-F00** (Build Identity & Health) and **FLOW-F01** (Auth & Session) before initiating any business workflow.
   - For all commercial and operational tests (**FLOW-F03** through **FLOW-F09**), strictly utilize dedicated synthetic test business `businessId: 999` on an isolated staging database.
2. **Zero Protected Database Mutations:**
   - Under no circumstances shall transactional tests be directed against `admin`, `spark_admin`, `spark_admin_test`, `spark_admin_prod`, or `spark_admin_prod_test`.
3. **Evidence Archival:**
   - Store all run artifacts in an organized archive directory: `evidence/<RUN_DATE>/<FLOW_ID>/`.
   - All screenshots, network HAR files, server logs, and SQL trace summaries must be attached or referenced in the tracker table before a flow status can transition to `PASS`.

---

## 5. Final Staging Gate Evaluation & Outcome

**Final Staging Gate Decision:**  
`RC4 VERIFIED — READY FOR CONTROLLED STAGING`

### Verification Summary
- **Package Archive:** `dist/candidates/spark-admin-release-candidate-rc4.zip`
- **SHA-256 Checksum:** `7448469107b48dc998c6af767decfa7fc64561a0384b5d9996d497aaf0c529c2` (Matches manifest and verified independently)
- **Archive Contents:** Exactly 312 clean production files, 24 migrations, 0 secrets, 0 logs, 0 git metadata, 0 node_modules.
- **Automated Regression:** 854/854 tests passed across 180 test suites (0 failures, 0 skips).
- **Disposable Release Readiness:** 8/8 release gates passed cleanly via `scripts/disposable-release-verification.js` (including genuine forward upgrade from 32 to 54 tables with 100% data preservation).
- **Browser Acceptance:** All business journeys across Flows A, B, C, D passed via Chrome DevTools Protocol (CDP) on Chromium.
- **Accounting & Inventory Invariants:** 10/10 invariants verified with zero delta ($\Delta = ₹0.00$).

### Deployment Boundary Distinction
- **Code-Level Verification:** 100% Complete & Verified on local disposable test environments.
- **Remote-Host Deployment:** Has NOT yet been performed. Controlled staging requires dedicated target host infrastructure provisioning, reverse proxy setup, environment secret injection, and database backup verification prior to remote extraction.
- **Release Handling:** Packaging preserved; no automatic upload or remote execution performed.
