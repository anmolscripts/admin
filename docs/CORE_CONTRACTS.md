# Frozen Core Architecture Contracts

> **CRITICAL ARCHITECTURAL POLICY:**
> The 20 contracts detailed in this document are **FROZEN**.
> Multiple developers will build feature additions on top of this repository. They must not refactor, redesign, or alter these core baseline contracts without deliberate architectural review, automated test coverage, and an approved Architecture Decision Record (ADR).
>
> - **CORE CHANGE:** Requires deliberate team review, migration/ADR documentation, and end-to-end regression testing.
> - **FEATURE CHANGE:** Built *around* the core contracts without modifying their underlying mechanics or interfaces.

---

## The 20 Frozen Core Contracts

### 1. Express Bootstrap Architecture
- **Contract:** `app/app.js` builds and exports the Express app instance; `app/server.js` binds to network ports.
- **Why It Exists:** Enables parallel automated integration tests with ephemeral ports without port collision or process hangs.
- **Side Effects If Changed:** Automated test runner breaks, CI hangs on unclosed sockets, unable to run parallel integration suites.
- **Tests Protecting It:** [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js), [tests/auth.test.js](file:///c:/Users/User/Documents/project/admin/tests/auth.test.js).

### 2. Authentication Architecture
- **Contract:** Password verification uses `bcrypt` salted hashing with 12 rounds and a constant-time dummy hash comparison for nonexistent accounts to defeat timing attacks.
- **Why It Exists:** Protects user credentials and prevents user enumeration via response latency analysis.
- **Side Effects If Changed:** User accounts compromised, security audits fail, account enumeration vulnerability introduced.
- **Tests Protecting It:** [tests/auth.test.js](file:///c:/Users/User/Documents/project/admin/tests/auth.test.js).

### 3. Session Architecture
- **Contract:** Sessions are managed using `express-session` with a signed `spark.sid` cookie, `httpOnly: true`, and `sameSite: 'lax'`.
- **Why It Exists:** Provides secure, stateful user authentication across server-rendered pages and API requests without exposing tokens to client script XSS.
- **Side Effects If Changed:** Session hijacking vulnerabilities, broken page authorization, login redirection loops.
- **Tests Protecting It:** [tests/auth.test.js](file:///c:/Users/User/Documents/project/admin/tests/auth.test.js), [tests/hardening.test.js](file:///c:/Users/User/Documents/project/admin/tests/hardening.test.js).

### 4. CSRF Architecture
- **Contract:** All mutating requests (`POST`, `PUT`, `DELETE`) require a cryptographically random CSRF token matching the session token, supplied via `_csrf` body field or `x-csrf-token` header.
- **Why It Exists:** Neutralizes Cross-Site Request Forgery attacks against authenticated administrative sessions.
- **Side Effects If Changed:** Malicious third-party websites could forge document deletions, status changes, or payments on behalf of logged-in staff.
- **Tests Protecting It:** [tests/hardening.test.js](file:///c:/Users/User/Documents/project/admin/tests/hardening.test.js).

### 5. Document Domain Model
- **Contract:** Quotations and Invoices share the single `Invoice` model in MySQL, differentiated by `documentType` enum (`QUOTATION` vs. `INVOICE`).
- **Why It Exists:** Enables seamless conversion without cross-table entity migration, allows shared line item mechanics, and unifies presentation logic.
- **Side Effects If Changed:** Data duplication, dual-maintenance of quotation vs. invoice schemas, broken historical references.
- **Tests Protecting It:** [tests/invoice.test.js](file:///c:/Users/User/Documents/project/admin/tests/invoice.test.js), [tests/documents.test.js](file:///c:/Users/User/Documents/project/admin/tests/documents.test.js).

### 6. Document Statuses
- **Contract:** Documents operate strictly within four enumerated statuses: `ACTIVE`, `INACTIVE`, `VOID`, and `DELETED`.
- **Why It Exists:** Provides a deterministic state machine for financial governance.
- **Side Effects If Changed:** Inconsistent reporting, invalid payment allocations, corrupted dashboard metrics.
- **Tests Protecting It:** [tests/documents.test.js](file:///c:/Users/User/Documents/project/admin/tests/documents.test.js).

### 7. Document Types
- **Contract:** Supported document types are `QUOTATION` and `INVOICE`. Quotations use `validUntil` (`dueDate = null`); Invoices use `dueDate` (`validUntil = null`).
- **Why It Exists:** Enforces business semantic clarity between pre-sale quotes and binding commercial invoices.
- **Side Effects If Changed:** Database integrity violations, invalid date representations on printouts and reports.
- **Tests Protecting It:** [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js), [tests/invoice.test.js](file:///c:/Users/User/Documents/project/admin/tests/invoice.test.js).

### 8. Document Numbering
- **Contract:** Documents use atomic sequence allocation via `InvoiceNumberSequence` (`QTN-YYYY-NNNN` and `INV-YYYY-NNNN`).
- **Why It Exists:** Guarantees gapless, race-condition-free legal invoice numbers under concurrent creation.
- **Side Effects If Changed:** Duplicate document numbers, race conditions, non-compliance with tax and accounting statutes.
- **Tests Protecting It:** [tests/invoice.test.js](file:///c:/Users/User/Documents/project/admin/tests/invoice.test.js), [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js).

### 9. Quotation to Invoice Conversion Rules
- **Contract:** Converting a quotation generates a brand-new `INVOICE` with a fresh `INV-` number, links to the source quotation via `sourceQuotationId`, and establishes an independent `dueDate` (never copying `validUntil`).
- **Why It Exists:** Maintains legal separation between quote commitments and tax billing while preserving audit traceability.
- **Side Effects If Changed:** Invoices carrying quotation validity dates, duplicate quote numbers, broken audit links.
- **Tests Protecting It:** [tests/invoice.test.js](file:///c:/Users/User/Documents/project/admin/tests/invoice.test.js).

### 10. Copy Rules
- **Contract:** Copying a document duplicates client and line items into an unsaved draft, but NEVER copies: `id`, `invoiceNumber`, `status`, `version`, `isDeleted`, `deletedAt`, conversion relationships, revision history, or payments.
- **Why It Exists:** Prevents accidental cloning of identifiers, payment histories, or audit logs into new documents.
- **Side Effects If Changed:** Primary key collisions, payment records associated with wrong invoices, corrupted audit trails.
- **Tests Protecting It:** [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js), [tests/documents.test.js](file:///c:/Users/User/Documents/project/admin/tests/documents.test.js).

### 11. Delete & Restore Rules
- **Contract:** Deletion is soft (`isDeleted: true`, `status: DELETED`, `deletedAt: timestamp`). Restoring returns document to `ACTIVE`. Documents cannot be modified while in `DELETED` status.
- **Why It Exists:** Prevents accidental permanent data loss and ensures regulatory data retention.
- **Side Effects If Changed:** Accidental permanent record destruction, broken foreign key constraints, untraceable missing documents.
- **Tests Protecting It:** [tests/documents.test.js](file:///c:/Users/User/Documents/project/admin/tests/documents.test.js).

### 12. Void Rules
- **Contract:** `VOID` is a permanent, terminal state. Voided documents cannot be edited, reactivated, deleted, or accept payments. Print and PDF renderings permanently display a `VOID` watermark.
- **Why It Exists:** Tax compliance prohibits deleting or altering issued tax invoices; voiding locks the record while maintaining audit visibility.
- **Side Effects If Changed:** Tax law non-compliance, financial fraud risks, audit invalidation.
- **Tests Protecting It:** [tests/documents.test.js](file:///c:/Users/User/Documents/project/admin/tests/documents.test.js), [tests/export.test.js](file:///c:/Users/User/Documents/project/admin/tests/export.test.js).

### 13. Optimistic Locking
- **Contract:** Every document update increments `version` and requires `where: { id, version }`. If the version does not match, a `ConcurrencyError` (HTTP 409) is thrown.
- **Why It Exists:** Prevents silent overwrites when two operators edit the same document concurrently.
- **Side Effects If Changed:** Lost updates, inconsistent line item modifications, untraceable overwrite bugs.
- **Tests Protecting It:** [tests/phase6.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase6.test.js), [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js).

### 14. Server-Authoritative Financial Calculations
- **Contract:** Line totals, subtotals, GST breakdown, round-off, grand totals, and balances are calculated strictly on the server in `invoice.service.js` using rounded integer half-up math. Client calculations are strictly visual mirrors.
- **Why It Exists:** Client inputs can be manipulated; financial and legal documents must guarantee immutable numerical precision.
- **Side Effects If Changed:** Arithmetic drift, manipulated totals submitted via browser devtools, tax calculation discrepancies.
- **Tests Protecting It:** [tests/unit.test.js](file:///c:/Users/User/Documents/project/admin/tests/unit.test.js), [tests/invoice.test.js](file:///c:/Users/User/Documents/project/admin/tests/invoice.test.js).

### 15. GST Rules
- **Contract:** If `gstEnabled` is true:
  - If supplier state equals customer place of supply: split tax equally into **CGST** and **SGST**.
  - If supplier state differs: apply entire tax as **IGST**.
- **Why It Exists:** Mandatory Indian Goods and Services Tax statutory compliance.
- **Side Effects If Changed:** Penalties from tax authorities, erroneous tax invoices, incorrect accounting ledgers.
- **Tests Protecting It:** [tests/unit.test.js](file:///c:/Users/User/Documents/project/admin/tests/unit.test.js), [tests/export.test.js](file:///c:/Users/User/Documents/project/admin/tests/export.test.js).

### 16. Payment Lifecycle Separation
- **Contract:** Payments exist in a separate child table (`Payment`). Invoices track denormalized aggregate fields (`paidAmount`, `outstandingAmount`) updated inside Prisma transactions.
- **Why It Exists:** Supports partial payments, multiple installment receipts, diverse payment methods, and independent payment voiding without mutating invoice items.
- **Side Effects If Changed:** Lost payment history, inability to record partial receipts, broken financial reconciliation.
- **Tests Protecting It:** [tests/phase6.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase6.test.js), [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js).

### 17. Audit & Revision Rules
- **Contract:** Every create, edit, status change, and soft-delete appends an immutable record to `InvoiceRevision` containing actor ID, timestamp, version, change reason, and full snapshot JSON.
- **Why It Exists:** Satisfies statutory compliance for accounting systems and enables forensic historical inspection.
- **Side Effects If Changed:** Inability to trace who changed an invoice or what prices were modified, non-compliance with audit requirements.
- **Tests Protecting It:** [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js), [tests/invoice.test.js](file:///c:/Users/User/Documents/project/admin/tests/invoice.test.js).

### 18. Item Master Snapshot Rules
- **Contract:** Invoices snapshot item name, unit, rate, and GST rate onto `InvoiceItem`. Editing an item in Item Master does NOT alter historical invoices. New item names typed in the editor are safely ingested into Item Master with database uniqueness.
- **Why It Exists:** Past issued invoices must remain immutable even if the product catalog prices or descriptions change later.
- **Side Effects If Changed:** Historical invoices retroactively changing totals when catalog items are edited, catastrophic accounting corruption.
- **Tests Protecting It:** [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js).

### 19. Print/PDF Shared-Template Architecture
- **Contract:** Only ONE template exists: `app/views/documents/templates/document.ejs`, fed by `documentView.service.js`. PDF generation executes headless Chromium against this shared HTML. No second PDF markup renderer is allowed.
- **Why It Exists:** Completely eliminates visual and content divergence between what a user prints from the browser and what they download as a PDF.
- **Side Effects If Changed:** Discrepancies between printed and emailed documents, double-maintenance overhead for all invoice layout changes.
- **Tests Protecting It:** [tests/export.test.js](file:///c:/Users/User/Documents/project/admin/tests/export.test.js), [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js).

### 20. Dashboard Aggregation Principles
- **Contract:** Dashboard KPI numbers, sums, overdue metrics, and trends are aggregated directly in the database via optimized SQL count/sum queries rather than loading large arrays into Node.js memory.
- **Why It Exists:** Guarantees fast, O(1) memory usage regardless of whether the database contains 100 or 100,000 documents.
- **Side Effects If Changed:** Node.js process out-of-memory crashes, severe dashboard latency under production loads.
- **Tests Protecting It:** [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js).

### 21. Unit Master Snapshot & Relational Isolation
- **Contract:** Measurement units are governed by the `Unit` master entity (`symbol` unique constraint) and served dynamically via `/api/units/active`. Line items (`InvoiceItem.unit`) store an immutable string snapshot. Editing or deactivating an entry in Unit Master never modifies historical quotations or invoices.
- **Why It Exists:** Businesses need customizable measurement units without risking retroactive corruption of issued tax documents.
- **Side Effects If Changed:** Historical invoices displaying altered units or failing schema validations upon later retrieval.
- **Tests Protecting It:** [tests/ux_polish.test.js](file:///c:/Users/User/Documents/project/admin/tests/ux_polish.test.js).

### 22. Client Optional Contact Fields & Document-Level Snapshotting
- **Contract:** Client/Company Name is required. Email and Phone are optional; when supplied, strict format validation applies. Selecting a saved client auto-populates the editor into an editable document-level snapshot (`clientName`, `clientEmail`, `clientPhone`, `billingAddress`, `shippingAddress`). Changes to the document snapshot never alter Client Master, and modifying Client Master never corrupts historical documents.
- **Why It Exists:** Enables fast, frictionless counter invoicing when complete customer contact information is unavailable, while strictly preserving accounting audit immutability.
- **Side Effects If Changed:** Validation rejecting valid cash/counter clients; or dynamic joins corrupting historical client addresses on past tax invoices.
- **Tests Protecting It:** [tests/ux_polish.test.js](file:///c:/Users/User/Documents/project/admin/tests/ux_polish.test.js).

### 23. RBAC Hierarchy, Delegation Boundary & Last-Administrator Invariant
- **Contract:** Access control strictly enforces `OWNER > ADMIN > STAFF / VIEWER` hierarchy. Non-owners cannot create/modify/demote an OWNER. Administrators cannot delegate permissions they do not possess. Users cannot self-modify roles, permissions, or deactivation status. The last active OWNER and last active holder of `TEAM.MANAGE` cannot be demoted, deactivated, or deleted.
- **Why It Exists:** Prevents horizontal and vertical self-privilege escalation, stops administrative lockout, and enforces organizational delegation boundaries.
- **Side Effects If Changed:** Unauthorized elevation to Owner, privilege delegation leakage, accidental administrative lockouts.
- **Tests Protecting It:** [tests/rbac_team_activity.test.js](file:///c:/Users/User/Documents/project/admin/tests/rbac_team_activity.test.js).

### 24. Operational Audit Event Immutability & Secret Sanitization
- **Contract:** State-changing operational actions create semantic, append-only records (`CREATE_USER`, `ASSIGN_ROLE`, `CHANGE_PERMISSIONS`, etc.) atomically inside the same database transaction. Audit logs strictly sanitize and never record passwords, bcrypt hashes, raw tokens, or session identifiers.
- **Why It Exists:** Guarantees regulatory forensic auditability while preventing credential leakage into logs and reports.
- **Side Effects If Changed:** Phantom audit logs on rolled-back transactions, untraceable administrative actions, secret credential exposure.
- **Tests Protecting It:** [tests/rbac_team_activity.test.js](file:///c:/Users/User/Documents/project/admin/tests/rbac_team_activity.test.js), [tests/phase8.test.js](file:///c:/Users/User/Documents/project/admin/tests/phase8.test.js).
