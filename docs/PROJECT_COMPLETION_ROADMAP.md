# Spark Admin Accounting ERP — Project Completion Roadmap

**Document Version:** 1.0.0
**Last Updated:** 2026-10-09
**Branch:** `main`
**Latest Baseline Commit:** `1cc39d4` (`feat(accounting): implement credit and debit notes with double-entry general ledger posting`)
**Current Baseline Verification:** 503 passing tests, 0 failures, 0 skipped (109 suites). Doctor 20/20 PASS. 14 migrations applied.

---

## 1. Project Overview & Architecture

**Spark Admin** is a professional double-entry accounting ERP and document management system built on:
- **Runtime:** Node.js 24 (CommonJS)
- **Framework:** Express 5
- **Template Engine:** EJS (server-rendered views, zero mandatory frontend build step)
- **Database:** MySQL 8.x
- **ORM / Driver:** Prisma 7 with `@prisma/adapter-mariadb`
- **Security:** Session-based auth with secure cookie flags, CSRF synchronizer tokens, sliding-window rate limiters, RBAC matrix, and append-only activity logging.

---

## 2. Core Accounting & Security Invariants

1. **Double-Entry Invariant:** Every posted journal entry must satisfy $\sum \text{Debit} = \sum \text{Credit}$ down to the exact cent. No floating-point arithmetic; all calculations use server-authoritative integer cents or Decimal representations.
2. **Posting Immutability:** Posted journal entries, once finalized (`POSTED` or `REVERSED`), cannot be updated or deleted in place. Corrections require formal reversing entries linked via `reversedEntryId`.
3. **Deterministic Idempotency:** All document posting functions (`INVOICE:<id>`, `PAYMENT:<id>`, `NOTE:<type>:<id>`) enforce unique idempotency keys to ensure concurrent or repeated requests resolve to the same canonical journal entry without duplicate posting.
4. **Financial Year Enclosure:** All journal entries and accounting postings must belong to an active, `OPEN` Financial Year matching the transaction date. Posting to a `CLOSED` Financial Year is strictly prohibited.
5. **Subledger Integrity:** Accounts Receivable movements must carry client tags (`clientId`) on control account `1121` lines. The customer subledger balance must strictly reconcile with General Ledger account `1121`.
6. **Concurrency & Locking:** Financial state transitions and numbering allocations must use row-level locks (`FOR UPDATE`) within explicit database transactions.
7. **Principle of Least Privilege:** All financial reports, mutations, exports, and print views must enforce server-side RBAC permissions. Hiding UI elements is never a substitute for server authorization.

---

## 3. Milestones & Historical Commit Status

| Milestone | Title | Status | Commit Hash | Summary & Verification |
|---|---|---|---|---|
| **Milestone 1** | Financial Year Foundation | **COMMITTED** | `97ace4a` | Model `FinancialYear`, date-range calculation, period validation, open/close constraints. |
| **Milestone 2** | Chart of Accounts | **COMMITTED** | `f7c91a6` | 5 standard groups (Asset, Liability, Equity, Income, Expense), system control accounts (`1121`, `4110`, `1111`, `1112`, GST accounts), hierarchy tree. |
| **Milestone 3** | Double-Entry Journal Engine | **COMMITTED** | `f7c91a6` | `JournalEntry`, `JournalEntryLine`, `JournalNumberSequence` (`JRN-YYYY-YY-NNNN`), exact $\text{Dr}=\text{Cr}$, atomic balance updates, reversals, immutable history. |
| **Milestone 4** | Invoice Accounting Posting | **COMMITTED** | `750233b` | `postInvoice`, `reverseInvoice`, idempotency `INVOICE:<id>`, Dr AR / Cr Sales / Cr Output GST / Round Off, multi-state lifecycle integration. |
| **Milestone 5** | Payment Accounting Posting | **COMMITTED** | `42c99c8` | `postPayment`, `reversePayment`, cash/bank mapping (`1111`/`1112`), subledger crediting, partial payment support, voiding reversal. |
| **Milestone 6** | Credit & Debit Notes | **COMMITTED** | `1cc39d4` | `CreditDebitNote`, `CreditDebitNoteItem`, sequence numbering, GL posting (`postCreditDebitNote`), void reversal, multi-note adjustment limits, 503 passing tests. |
| **Milestone 7** | Core Financial Reports & Accounting Reconciliation | **TESTS PASSED / REVIEW PENDING** | — | Journal Register, General Ledger, Trial Balance, Profit & Loss, Balance Sheet, Customer Receivables Ageing & Subledger Reconciliation. Full suite 537/537 passed. |
| **Milestone 8** | Financial Year Closing & Opening Balances | **NOT STARTED** | — | Year-end closing procedure, carry-forward balances, period locking. |
| **Milestone 9** | Statutory Tax Reports (GST Summary) | **NOT STARTED** | — | CGST, SGST, IGST tax return summaries, sales vs credit note tax adjustments. |
| **Milestone 10** | Production Hardening & Operational Audit | **NOT STARTED** | — | Cross-module reconciliation, production runbook, disaster recovery validation. |

---

## 4. Assessment of Candidate Completion Areas (Step 3 Inventory)

| Area | Description | Assessment Status | Notes & Dependencies |
|---|---|---|---|
| **Candidate A: Financial Reports** | Journal Register, General Ledger, Trial Balance, Profit & Loss, Balance Sheet, Account Activity, Customer Statements. | **PRESENT BUT INCOMPLETE** | Posting engine and account ledger service exist, but unified reports service, web views, filters, and Trial Balance / P&L / Balance Sheet engines are missing. **Selected as Milestone 7.** |
| **Candidate B: Customer Receivables** | Invoice outstanding, partial payments, credit/debit notes, ageing buckets, customer statements, AR subledger reconciliation. | **PRESENT BUT INCOMPLETE** | Invoice and payment models track balances; subledger tagging exists on journal lines; comprehensive ageing report and subledger-to-GL reconciliation view are missing. Included in Milestone 7. |
| **Candidate C: Purchases & Payables** | Supplier master, purchase bills, payments, returns, accounts payable (`2121`). | **OUT OF CURRENT SCOPE** | Core focus is sales and accounts receivable ERP; purchase invoices not present in current schema. Requires explicit business decision if needed. |
| **Candidate D: Expenses & Cash/Bank** | Expense entry, cash/bank accounts, bank reconciliation, duplicate protection. | **PRESENT BUT INCOMPLETE** | Standard COA contains Expense and Cash/Bank accounts; journals support manual expense posting. Bank reconciliation module not yet implemented. |
| **Candidate E: Tax & Statutory Reporting** | GST summaries, CGST/SGST/IGST breakdown, tax register. | **PRESENT BUT INCOMPLETE** | Tax accounts (`1131-1133`, `2111-2113`) capture all posted taxes from invoices and notes. Comprehensive tax return reporting planned for Milestone 9. |
| **Candidate F: Commercial Documents** | Quotations, invoices, numbering, revisions, printing, PDF export, lifecycle transitions. | **COMPLETE AND VERIFIED** | Full document editor, quotation-to-invoice conversion, optimistic locking, PDF generation, and revision audit logs verified. |
| **Candidate G: Opening Balances & FY** | Opening balance verification, year-end closure, carry forward. | **PRESENT BUT INCOMPLETE** | Opening balances exist on accounts; formal FY closing journal workflow planned for Milestone 8. |
| **Candidate H: Administration & UX** | RBAC, team management, user activity logs, items, units, settings, layouts. | **COMPLETE AND VERIFIED** | 5 system roles, fine-grained permission matrix, item autocomplete portal, unit master, activity audit verified. |
| **Candidate I: Production Readiness** | Migrations, security headers, rate limiting, CSRF, health checks, doctor. | **COMPLETE AND VERIFIED** | Doctor checks pass 20/20, 14 migrations verified clean-room, CSRF & rate limiters verified in regression tests. |

---

## 5. Milestone 7 — Detailed Scope & Architecture

### Goal
Provide a complete, auditable, permission-protected financial reporting and reconciliation suite that leverages existing double-entry journal postings.

### Sub-Modules
1. **Financial Reports Service (`app/services/accounting/report.service.js`):**
   - **Journal Register (`getJournalRegister`):** Query journal entries with filters (`financialYearId`, `fromDate`, `toDate`, `sourceType`, `status`, `accountId`). Calculates pagination, line items, and debit/credit totals.
   - **General Ledger (`getGeneralLedgerReport`):** Account-wise statement with opening balance, chronological debit/credit movements, running balance, journal linkage, and client subledger reference.
   - **Trial Balance (`getTrialBalance`):** As-of cutoff date or Financial Year. Calculates total debits, total credits, net debit/credit balance per account, and asserts control total $\sum \text{Dr} = \sum \text{Cr}$.
   - **Profit and Loss Statement (`getProfitAndLoss`):** Reporting period / FY statement grouping Operating Revenue (Sales `4110`, Service `4120`, less Sales Returns `4130`) and Operating Expenses (COGS `5110`, Admin `5210`, Bank Charges `5220`, Round Off `5230`). Computes Gross & Net Profit / Loss.
   - **Balance Sheet (`getBalanceSheet`):** As-of date statement grouping Assets (`1000`), Liabilities (`2000`), and Equity (`3000`). Integrates Retained Earnings and Net Current Period Profit/Loss, verifying the fundamental equation: $\text{Assets} = \text{Liabilities} + \text{Equity}$.
   - **Customer Receivables & Ageing (`getCustomerReceivablesReport`):** Per-client summary showing total invoiced, total paid, credit/debit adjustments, outstanding balance, ageing breakdown (Current 0-30, 31-60, 61-90, 90+ days), and reconciliation against GL Accounts Receivable (`1121`).
2. **RBAC & Authorization:**
   - Add `REPORTS` module to RBAC permission matrix: `VIEW`, `EXPORT`, `PRINT`.
   - Protect all report routes with `requirePermission('REPORTS', 'VIEW')` or `requirePermission('JOURNALS', 'VIEW')`.
3. **Web Controllers & Routes (`app/controllers/report.controller.js`, `app/routes/web.routes.js`):**
   - `GET /reports` (Overview dashboard linking all reports)
   - `GET /reports/journal-register`
   - `GET /reports/general-ledger`
   - `GET /reports/trial-balance`
   - `GET /reports/profit-and-loss`
   - `GET /reports/balance-sheet`
   - `GET /reports/customer-receivables`
   - `GET /reports/customer-statement/:clientId`
   - `GET /accounting/journals/:id` (Journal entry inspection view)
4. **EJS Templates & UI:**
   - Dedicated report views with filter bars (FY dropdown, date pickers, account selectors, client selectors).
   - Sidebar navigation integration in `app/views/layouts/header.ejs` under a dedicated "Reports & Accounting" section.
   - Print layouts with `@media print` styling for clean audit presentation.
5. **Automated Testing Suite (`tests/reports_reconciliation.test.js`):**
   - Trial Balance mathematical balance verification across multiple complex postings (invoices, payments, credit/debit notes, reversals).
   - P&L net income calculation and boundary date filtering.
   - Balance Sheet equation balance $\text{Assets} = \text{Liabilities} + \text{Equity}$.
   - Customer subledger-to-GL reconciliation.
   - RBAC access control enforcement (403 for unauthorized roles).

---

## 6. Verification Baseline & Progression Log

- **Baseline Test Count:** 503 tests passed, 0 failures, 109 suites (Commit `1cc39d4`).
- **Milestone 7 Test Results:** 537 tests passed, 0 failures, 122 suites (+34 tests across 13 targeted report, boundary, lifecycle, and RBAC suites).
- **Doctor Diagnostic:** 20/20 PASS.
- **Prisma Validation & Migrations:** Valid; 14 migrations up to date (no schema changes).
- **Accounting & Boundary Verification Findings:**
  - **Indian FY Date Boundaries (31 March / 1 April):** Handled via `getFinancialYearDateBounds()` and `@db.Date` UTC boundary normalization (`parseStartOfDay` / `parseEndOfDay`). Cutoff as of 31 March strictly includes year-end entries and excludes 1 April entries.
  - **Carried-Forward Balance Sheet Balances:** Selecting a Financial Year in Trial Balance or Balance Sheet computes cumulative balances up to the FY closing cutoff date without stripping prior-year assets, liabilities, or equity.
  - **General Ledger Continuous Opening Balances:** Opening balance entering a Financial Year aggregates all historical posted entries prior to the FY start date (`2026-04-01`).
  - **Round-off Discrepancy (`5230`):** Both debit (expense) and credit (gain) directions are accurately reflected in P&L and Trial Balance.
  - **Contra-Revenue (`4130`):** Debit-normal sales returns are subtracted from Gross Revenue to produce Net Revenue.
  - **Receivables Lifecycle Invariants:** DRAFT and VOID credit notes strictly do not reduce receivables. VOID payments cleanly restore receivables without double-counting. DEBIT notes increase receivables and customer subledger balances.
  - **Subledger Reconciliation:** Customer subledger reconciles with GL Control Account `1121`. Unassigned AR is disclosed if any historical lines lack client IDs.
  - **Known Milestone 8 Limitation Documented:** Formal year-end closing entries transferring cumulative nominal P&L balances into Retained Earnings (`3120`) belong to Milestone 8 ("Financial Year Closing & Opening Balances"). In Milestone 7, the Balance Sheet dynamically calculates cumulative net earnings ($\sum \text{Income} - \sum \text{Expenses}$) under Equity, satisfying $\text{Assets} = \text{Liabilities} + \text{Equity}$ without artificial plugs.
- **Git State:** 4 modified tracked files, 5 untracked files/directories, 0 unapproved commits, clean diff check.
- **Current Milestone Status:** **TESTS PASSED / REVIEW PENDING**.
- **Next Recommended Action:** User authorization to commit Milestone 7 locally.
