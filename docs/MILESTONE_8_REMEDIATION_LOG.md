# Milestone 8 Remediation Log: Financial Year Closing, Opening Balances & Period Locking

**ERP:** Spark Admin  
**Date:** 2026-10-09  
**Status:** COMPLETE — All 564/564 tests passing across 131 test suites.  

---

## 1. Executive Summary & Remediation Overview

Milestone 8 introduces Financial Year Management, Year-End Closing, Retained Earnings Transfer, Balance Sheet / P&L Carryforward, Historical Period Locking, and Controlled Reopening.

During final acceptance verification, several blocker issues were identified, investigated, and remediated autonomously:
1. **Background Task Accumulation & Hanging Processes:** Multiple background test runs were hanging indefinitely due to an unclosed HTTP server instance in `tests/financial_year_closing.test.js`.
2. **Service Syntax Error:** Stray closing delimiter in `app/services/financialYearClosing.service.js` caused module loading failure across dependent routes.
3. **Test Isolation & Cascading Failures:** Section 7 of `tests/financial_year_closing.test.js` created accounting activity in earlier FY 2023-24 without resetting it, causing chronological sequence validation in Milestone 8 to block closing FY 2024-25. Furthermore, test cleanup was indiscriminately deleting invoices from standard fixture year 2025-26, causing regressions in `tests/invoice.test.js`.
4. **Milestone 4 Invoice Posting Test Sequence:** `tests/invoice_posting.test.js` (test 5.4) set the Financial Year to `CLOSED` before creating an invoice, conflicting with the newly established period-locking rule in `invoice.service.js` that forbids creating invoices in closed financial years.
5. **Custom Test Runner Filter:** `scripts/test-runner.js` ignored CLI arguments, always discovering all 60 test suites. A backward-compatible CLI filter was implemented.

---

## 2. Detailed Root Cause Analysis & Fixes

### 2.1 Background Process Stalling (Unclosed HTTP Server)
* **Root Cause:** `tests/financial_year_closing.test.js` instantiated an HTTP server with `server = http.createServer(app); server.listen(0, '127.0.0.1')` in `before()` but lacked an `after()` hook. The active TCP handle kept Node.js alive indefinitely.
* **Fix:** Added `after()` hook closing active connections and calling `server.close()` followed by `prisma.$disconnect()`.
* **Verification:** Process exits cleanly within ~5 seconds upon suite completion.

### 2.2 Syntax Error in `financialYearClosing.service.js`
* **Root Cause:** A misplaced closing brace `});` at line 690 prematurely closed the transaction callback.
* **Fix:** Cleaned up stray delimiter and verified with `node --check app/services/financialYearClosing.service.js` (exit code 0).

### 2.3 Chronological Sequence & Test Data Collision
* **Root Cause:**
  1. Section 7 created FY `2023-24` and posted an opening balance journal into it.
  2. In subsequent test runs, FY 2023-24 remained open with 1 accounting transaction.
  3. `closeFinancialYear(fy2024.id)` enforces chronological sequence: all earlier FYs with accounting activity must be closed first. Thus, it blocked closing FY 2024-25.
  4. In addition, `tests/financial_year_closing.test.js` was deleting all invoices for all test years, including `fy2025.id` (FY 2025-26), which wiped out the deterministic seed invoice `INV-2026-0001` required by `invoice.test.js`.
* **Fix:**
  - Scoped the test cleanup in `tests/financial_year_closing.test.js` to isolated test years (`fy2023`, `fy2024`, `fy2026`).
  - For `fy2025` (standard fixture year), only test-specific closing journals and `'Activity in 2025-26'` entries are cleaned, preserving standard invoice fixtures.
  - Handled self-referencing foreign keys on `invoices` (`sourceQuotationId`) cleanly before deletions.
* **Verification:** `tests/financial_year_closing.test.js` (27/27 pass) and `tests/invoice.test.js` (53/53 pass) both pass independently and sequentially.

### 2.4 Period-Locking Rejection in `tests/invoice_posting.test.js`
* **Root Cause:** Test 5.4 in `invoice_posting.test.js` tested that posting an invoice into a closed FY is rejected. However, it marked the FY as `CLOSED` *before* calling `createInvoice()`. Since Milestone 8 strictly locks invoice creation in closed FYs, `createInvoice()` failed with `Cannot create invoice in CLOSED Financial Year 2024-25`.
* **Fix:** Updated test 5.4 to create the historical unposted invoice while the FY is `OPEN`, then set the FY to `CLOSED`, and then verify that `postingService.postInvoice()` correctly rejects posting into a closed FY.
* **Verification:** `invoice_posting.test.js` (21/21 pass).

### 2.5 Test Runner Backward-Compatible Single-File Filter
* **Root Cause:** `scripts/test-runner.js` did not parse CLI arguments, executing all test suites even when a specific file was targeted.
* **Fix:** Added filtering on `process.argv.slice(2)` so targeted suites like `node scripts/test-runner.js financial_year_closing.test.js` execute rapidly in isolation while preserving default full-suite execution when no arguments are provided.

### 2.6 Closing Preview Read-Only Verification
* **Verification:** Audited `closingService.previewCloseFinancialYear` and `renderClosePreview`. Confirmed zero database mutations, no journal creation, and no status transitions.
* **Regression Test Added:** Added dedicated assertion in `tests/financial_year_closing.test.js` comparing journal counts, activity logs, FY status, and account balances before and after calling preview.

---

## 3. Test Verification Results

### Focused Test Run
* **Command:** `node scripts/test-runner.js financial_year_closing.test.js`
* **Output:**
  - Total Tests: 27
  - Passed: 27
  - Failed: 0
  - Duration: ~4.8s
  - Exit Code: 0

### Full Suite Regression Run
* **Command:** `npm test`
* **Output:**
  - Total Tests: 564
  - Total Suites: 131
  - Passed: 564
  - Failed: 0
  - Duration: ~69.6s
  - Exit Code: 0

### System Health Doctor
* **Command:** `npm run doctor`
* **Output:**
  - 20/20 PASS, 0 WARN, 0 FAIL
  - All application tables, RBAC roles, permissions, and migrations verified.
