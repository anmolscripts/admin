# Project Lifecycle Implementation Plan

Date: 2026-10-19. This plan is based on static code review only; no database mutation has been authorised or performed.

## Reusable code paths

- `invoice.service.js` owns quotation creation, revisioning and optimistic conversion to invoices; `invoice.controller.js` exposes guarded document APIs.
- `project.service.js` owns tenant-scoped project creation, financial summaries and project cost-ledger usage; `project.controller.js` owns the workspace APIs.
- `purchaseOrder.service.js`, `goodsReceipt.service.js`, `supplierBill.service.js`, `supplierPayment.service.js`, `stockMovement.service.js`, `expense.service.js`, `payment.service.js` and `accounting/posting.service.js` are the authoritative workflow modules.
- The project detail workspace is the existing lifecycle UI; it will be extended rather than duplicated.

## Additive data model

- `Invoice` (quotations only): `acceptedAt`, `acceptedById`, and an optional acceptance note. Acceptance remains an auditable state distinct from `InvoiceStatus`, which is shared with invoices.
- `Project`: unique nullable `sourceQuotationId`, immutable source quotation number and JSON snapshot. The unique constraint is the final concurrency/retry backstop against two projects from one quotation.
- `Project`: close/audit fields (`closedAt`, `closedById`, `closureOverrideReason`) while retaining the existing string status (`COMPLETED`) to avoid a breaking enum change.

The matching additive MySQL migration creates nullable columns, indexes and foreign keys. It is intentionally **not applied** in this increment. Rollback is operationally a forward migration that stops using the fields; physical column removal requires an approved migration after confirming no history depends on them.

## Workflow and authorization

1. A `DOCUMENTS:EDIT` user accepts an active, business-owned quotation. The server checks document type/status/business, locks by version, records actor/time/note and writes activity history.
2. A `PROJECTS:CREATE` user creates a project only from that accepted quotation. The transaction verifies the same business, locks the source quotation, writes immutable commercial snapshot data and relies on the unique source link for idempotency/concurrency.
3. A `PROJECTS:CLOSE` permission is added to the established RBAC taxonomy. Closure evaluates server-side blockers. `PROJECTS:MANAGE` may use a documented override with a reason; the decision and actor are audited.

## Closure reconciliation rules

- PO totals are commitments only and are never added to recognised cost or payable totals.
- Project actual cost remains the sum of posted `ProjectCost` ledger rows by category. GRN value is reported separately as received-not-billed/stock context.
- Invoice subtotal (less issued credit-note subtotal) is invoiced revenue; payments are customer cash and reduce receivables, not extra revenue.
- Supplier payments settle bills/payables and are not project cost. Open supplier bills, incomplete POs/GRNs, unreturned project stock, unposted costs and unbalanced journals are blockers. Unpaid customer invoices are reported as receivables but are not automatically a closure blocker.

## Test matrix and dependencies

- Acceptance rejection cases: non-quotation, cross-business ID, inactive/void quotation, stale version and repeat acceptance.
- Project creation: unaccepted source rejection, cross-business rejection, retry/idempotency, concurrent duplicate protection and immutable snapshot.
- Closure: missing permission, each blocker category, allowable unpaid receivable, audited override, repeated closure, and business isolation.
- Reconciliation: dashboard source totals versus posted cost ledger, invoices/credit notes and payments; PO commitment must remain separate.

Write-enabled tests and migration application are blocked until an explicitly named, approved disposable database is verified with `SELECT DATABASE()` and `CURRENT_USER()`. No release candidate will be produced before those tests and browser acceptance pass.
