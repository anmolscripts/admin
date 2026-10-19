# SPARK ADMIN ERP — PROJECT-CENTRIC ERP INTEGRATION AUDIT
**Document Version:** 1.0.0  
**Audit Timestamp:** 2026-10-18T19:30:00+05:30  
**Target Environment:** Spark Admin ERP (Express + Prisma + MariaDB + EJS)  
**Authoritative Baseline:** Current Working Tree (`dist/candidates/spark-admin-release-candidate-rc3.zip`, SHA-256: `ee1060ef5a4cb4ec704f091d4db540ab605c88d6222ada26f13a71af34e86ce3`)

---

## 1. Executive Summary & Authoritative Workspace Baseline

Spark Admin ERP has evolved from a collection of standalone accounting and operational modules to a tightly coupled system. This audit establishes the baseline status across all business domains:
`Project → Quotations → Customer Invoices → Customer Payments → Purchase Orders → Goods Receipts (GRN) → Stores/Warehouse Inventory → Project Material Issues → Supplier Bills → Expenses → Attachments/Certificates/TPT → General Ledger → Project Profit & Loss → Consolidated Business Reporting`.

### 1.1 Working-Tree & Archive Status
- **Supplied Archive Inspection:** Workspace examined. Parent folder contains `admin.zip` (153MB baseline bundle). The local working tree contains the authoritative, verified RC3 release candidate and test suites.
- **Git Status:** 80 modified tracked files and 28 untracked candidate/test files. All pre-existing work and baseline candidates (Release, RC1, RC2, RC3) remain 100% byte-for-byte preserved and protected.
- **Test Baseline:** Full regression suite (`scripts/test-runner.js`) passes **845 / 845 tests** across 179 suites. Browser E2E suite passes **81 / 81 steps** across 5 suites. Disposable 8-gate release verification passes **8 / 8 gates** in 68.9s.

---

## 2. Comprehensive Module & Relationship Matrix

| Entity / Flow | Schema Support | Service / Backend Support | UI / Workspace Integration | Audit Status & Gap Description |
| :--- | :--- | :--- | :--- | :--- |
| **Project Master** | `Project` model with `contractValue`, `budgetAmount`, budgets by category, `costRate`, etc. | Full CRUD in `project.service.js` with tenant isolation. | Detailed 9-tab workspace in `projects/details.ejs`. | **Solid Base.** Needs integration of POs, GRNs, Quotations, store inventory breakdown, and unified activity timeline. |
| **Quotations** | `Invoice` model with `documentType: 'QUOTATION'`, `sourceQuotationId`. | Full quotation creation & conversion to invoice in `invoice.service.js`. | Quotation editor supports project association. | **Partially Exposed.** Quotations linked to project exist in DB but are not queried or rendered in Project Workspace `#tab-sales` (only invoices shown). |
| **Customer Invoices** | `Invoice.projectId`, `InvoiceItem.projectId`. | Full project association, client validation, conversion preservation. | Dedicated `#tab-sales` in Project Workspace. | **Complete.** 27/27 E2E tests verified in RC3. |
| **Customer Payments** | `Payment` linked to `Invoice`. | Double-entry journal posting (`Dr Bank, Cr AR`), invoice balance tracking. | Displayed under invoices with drilldown. | **Complete.** Verified idempotent journal postings. |
| **Purchase Orders** | `PurchaseOrder.projectId` exists in schema. `PurchaseOrderItem` lacks `projectId`. | `purchaseOrder.service.js` currently omits `projectId` on create/update! | `#tab-purchases` in Project Workspace only renders supplier bills, POs missing entirely! | **Significant Gap.** PO editor needs project selector; PO service needs `projectId` persistence & line allocation; POs must be listed in Project Workspace. |
| **Goods Receipts (GRN)** | **Missing from Schema.** | **Missing Service.** No receipt against PO lines. | **Missing View.** No GRN registration or warehouse receiving UI. | **Major Gap.** Must add `GoodsReceipt` & `GoodsReceiptItem` models, PO line receipt tracking, and partial/full delivery acceptance. |
| **Stores / Warehouses** | No store entity or store location on movements. | `stockMovement.service.js` tracks total stock per item. | Inventory valuation report exists. | **Gap.** Need store/warehouse identifier on stock receipts and movements to differentiate general store stock from project allocations. |
| **Project Material Issue & Return** | `StockMovement.projectId` exists in schema. | `stockMovement.service.js` currently does not save `projectId` or post to `ProjectCost`! | No issue/return modal in Project Workspace. | **Major Gap.** Material issue must debit project cost at weighted average cost; material return must restore stock and adjust project cost. |
| **Supplier Bills** | `SupplierBill.projectId`, `SupplierBillItem.projectId`. | Full journal posting, project cost subledger posting for direct items. | `#tab-purchases` lists supplier bills. | **Solid.** Needs matching to PO and GRN lines to prevent duplicate cost recognition. |
| **Operating Expenses** | `Expense.projectId` exists in schema. | `expense.service.js` currently omits `projectId` on create and does not post to `ProjectCost`! | `#tab-expenses` lists project expenses. | **Gap.** Expense creation must persist `projectId`, validate tenant, and idempotently record in `ProjectCost`. |
| **Project Documents & TPT** | `ProjectAttachment` with SHA-256 and magic bytes validation. | `attachment.service.js` handles disk storage and DB records. | Basic upload list in `#tab-attachments`. | **Enhancement Required.** Missing metadata fields: `title`, `category` (`CERTIFICATE`, `TPT`, `DELIVERY_CHALLAN`, etc.), rich-text `description`, reference number, and dates. |
| **Project Cost Ledger** | `ProjectCost` with composite key `businessId_sourceType_sourceId_sourceLineId`. | `projectCostLedgerService` idempotent upsert and void. | `#tab-subledger` in Project Workspace. | **Solid Foundation.** Connect missing sources: `STOCK_MOVEMENT` (issue), `EXPENSE`, and ensure no double counting from POs. |
| **Profit & Loss / Analytics** | `getProjectFinancialSummary` in `project.service.js`. | Breakdowns for contract, budget, actual costs, margins. | `#tab-overview` and `#tab-profitability`. | **Enhancement Required.** Add quoted value, open PO commitments, goods received not billed, cash collections, and portfolio summary. |
| **Unified Activity Timeline** | Separate logs in `UserActivityLog` and entity audit timestamps. | `activity.service.js` logs actions. | No single unified timeline in Project Workspace. | **Gap.** Must provide chronological unified audit timeline across project, quotes, invoices, payments, POs, GRNs, stock issues, bills, expenses, and documents. |

---

## 3. Current Accounting Posting & Inventory Valuation Behaviour

### 3.1 Accounting Invariant Rules
1. **Purchase Orders:** Pure procurement commitment. Zero GL impact ($\Delta Dr = 0, \Delta Cr = 0$). Must NOT create an expense, liability, or inventory asset.
2. **Goods Receipt (GRN):** Physical acceptance of goods into warehouse. Updates stock subledger quantities and records movement reference. Under verified inventory valuation policy, does not duplicate financial expense.
3. **Supplier Bills:** Financial recognition of purchase liability.
   - For **Tracked Inventory:** Debits `INVENTORY_ASSET` (1130), Debits `INPUT_GST` (1141/1142/1143), Credits `ACCOUNTS_PAYABLE` (2110). Does **NOT** post to `ProjectCost` (to prevent double counting before material consumption).
   - For **Direct Project Purchases:** Debits `COGS/DIRECT_EXPENSE` (5100), Debits `INPUT_GST`, Credits `ACCOUNTS_PAYABLE`. Posts directly to `ProjectCost` via `projectCostLedgerService.recordCost`.
4. **Project Material Consumption (Stock Issue):**
   - Physical movement `StockMovement(movementType: 'ISSUE')` decreases store quantity.
   - GL posting (if perpetual): Debits `COGS/PROJECT_MATERIAL` (5100), Credits `INVENTORY_ASSET` (1130) at weighted average cost.
   - Subledger posting: Records entry in `ProjectCost` with `category: 'MATERIALS', sourceType: 'STOCK_MOVEMENT', sourceId: movement.id`.
   - **Zero Double-Counting Invariant:** Materials purchased for stock are counted in project cost ONLY upon issue, never at both purchase bill and stock issue.
5. **Operating Expenses:**
   - Standalone: Debits `EXPENSE` (5210), Credits `BANK/CASH` (1112/1111).
   - Project-linked: Same GL entry, PLUS idempotent subledger entry in `ProjectCost` (`category: 'EXPENSE', sourceType: 'EXPENSE'`).
6. **Customer Invoices & Payments:**
   - Invoice posting: Debits `ACCOUNTS_RECEIVABLE` (1120), Credits `OUTPUT_GST` (2131/2132/2133), Credits `SALES_REVENUE` (4110).
   - Payment collection: Debits `BANK_ACCOUNT` (1112), Credits `ACCOUNTS_RECEIVABLE` (1120). Outstanding balance decreases. Cash collection is NOT recognized as secondary revenue.

---

## 4. Attachment & Security Hygiene Audit

1. **Storage Location:** `data/attachments` outside web public directory.
2. **Integrity Validation:** SHA-256 hash calculated and stored. Magic byte inspection rejects spoofed extensions (supports PDF, PNG, JPEG, WebP).
3. **Tenant Scoping:** Cross-tenant access strictly blocked with HTTP 404/400.
4. **Rich-Text Sanitization:** Project attachment descriptions must be sanitized against XSS (script injection, malicious attributes) before rendering.
5. **Release Hygiene:** Sensitive files (`.env`, `.env.test`, `.git`, `node_modules`, `data/attachments`) are strictly excluded from all candidate zip archives.

---

## 5. Schema Evolution Requirements

The following additive schema changes are required in `prisma/schema.prisma`:
1. **`GoodsReceipt` (Header):**
   - Fields: `id`, `receiptNumber`, `businessId`, `purchaseOrderId?`, `supplierId`, `supplierName`, `deliveryChallanNumber`, `receiptDate`, `storeLocation`, `status` (`DRAFT`, `ACCEPTED`, `REJECTED`, `CANCELLED`), `notes`, `projectId?`, `receivedById`, `createdAt`, `updatedAt`.
   - Relations: `business`, `purchaseOrder`, `project`, `supplier`, `receivedBy`, `items` (`GoodsReceiptItem[]`).
2. **`GoodsReceiptItem` (Line):**
   - Fields: `id`, `goodsReceiptId`, `purchaseOrderItemId?`, `itemId?`, `name`, `unit`, `orderedQuantity`, `receivedQuantity`, `acceptedQuantity`, `rejectedQuantity`, `unitCost`, `totalCost`, `stockMovementId?`.
   - Relations: `goodsReceipt`, `purchaseOrderItem`, `item`, `stockMovement`.
3. **`PurchaseOrderItem` Enhancement:**
   - Add optional `projectId Int?` with relation to `Project`.
4. **`StockMovement` Enhancement:**
   - Add optional `storeLocation String? @db.VarChar(100)` to record store/warehouse name.
5. **`ProjectAttachment` Enhancement:**
   - Add `title String? @db.VarChar(255)`.
   - Add `category String @default("OTHER") @db.VarChar(50)` (supported: `CERTIFICATE`, `TPT`, `DELIVERY_CHALLAN`, `INSPECTION`, `WARRANTY`, `COMPLIANCE`, `OTHER`).
   - Add `description String? @db.Text` (rich text).
   - Add `referenceNumber String? @db.VarChar(100)`.
   - Add `issueDate DateTime? @db.Date`.
   - Add `expiryDate DateTime? @db.Date`.

---

## 6. Implementation Dependencies & Risk Mitigation

1. **Prisma Additive Migration:** Must use a versioned SQL migration script with safe defaults, zero data destruction, and instant backward compatibility.
2. **Database Protection:** Preflight connection check must strictly target `spark_project_costing_disposable_test`. Protected DBs (`admin`, `spark_admin`, etc.) remain untouched.
3. **Idempotency:** Every subledger and ledger write uses composite unique indexes or atomic transactions to eliminate retry duplicates.
4. **Release Preservation:** Existing packages (`spark-admin-release.zip`, `rc1`, `rc2`, `rc3`) remain intact; new candidate will be packaged as `rc4` only after all 4 E2E flows, regressions, and gates pass.
