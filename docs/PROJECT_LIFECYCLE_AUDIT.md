# Project Lifecycle Audit

Audit date: 2026-10-19. This is a code-path audit; no protected database was written or migrated.

## Working foundation

- Clients, quotations/invoices, payments, credit/debit notes, projects, purchase orders, goods receipts, supplier bills/payments, expenses, stock movements, project costs, attachments and reporting already have models, services and routes.
- A project has a business-scoped client relationship. Purchase orders have a header-level `projectId`; PO lines also retain their existing optional allocation field.
- Goods receipts support partial receipts, accepted/rejected quantities and stock movement creation. The project workspace already aggregates POs, GRNs, invoices, costs, labour, attachments and a timeline.
- PO creation explicitly documents that it is a commitment and does not post a payable or expense.

## Confirmed gaps and risks found

- Supplier controller/service existed, but supplier EJS pages and create/edit/deactivate routes were missing. The original controller did not supply a business scope or actor ID.
- PO list, new-editor supplier lookup, PO detail supplier lookup, update and void paths omitted the active business in at least one call. This permitted data leakage or mutation if an ID was known.
- A PO could select an inactive supplier. Before this change, PO update could replace all item rows after GRNs existed, breaking receipt references; it could also change supplier/project after receiving.
- Supplier bills and several older client/document paths still need a full business-scope review before production readiness. In particular, do not infer an authorised business from request bodies.
- The invoice schema has no quotation acceptance timestamp/status and Project has no source-quotation relation/snapshot. Therefore an auditable “accepted quotation → one project” workflow cannot be safely added without an additive, reviewed migration and agreed acceptance rules.
- The current supplier list is bounded to 100 records rather than a true paginated repository query. This should be addressed before very large supplier masters are expected.

## Accounting and data integrity findings

- Purchase orders are commitments, not expenses/payables. Do not add PO totals to actual project costs.
- GRN retry/idempotency, GRN-to-bill matching, supplier-payment allocation and project-close blocking need targeted acceptance tests against an approved disposable database before a production claim.
- The project dashboard already distinguishes some commitment/revenue/cost values, but its aggregation needs a formal reconciliation test to ensure bills, inventory receipts, material issues and manual expenses are never counted twice.
- Historical supplier snapshots are present on POs (`supplierName`, `supplierGSTIN`), so master edits will not rewrite PO presentation. Supplier records must remain soft-deactivated rather than deleted.

## Changes made in this delivery

- Added tenant-scoped Supplier management pages and routes, GSTIN/email/phone validation reuse, unique code checking, audit actor propagation, and protected activate/deactivate actions.
- Scoped supplier reads in supplier pages and PO editor/detail selectors to the active business; inactive suppliers are excluded from new PO selection at the service boundary.
- Validated project preselection against the active business. PO update/void now require the active business; updates cannot replace lines or change supplier/project after a non-cancelled GRN exists.

## Schema decision

An additive, unapplied migration now defines quotation acceptance fields, a one-to-one project source quotation link/snapshot, and closure audit fields. It must only be applied after disposable-database verification and acceptance testing.

## Next lifecycle increment (implemented, not database-applied)

- Quotation acceptance is a separate server-side audit action, scoped to the active business and protected with the quotation version.
- Project creation accepts only accepted, active quotations from the active business. It preserves an immutable source quotation snapshot and uses a unique source relationship for retry/concurrency protection.
- Project closure now has server-side preview and close APIs. Incomplete PO deliveries, unposted costs and unpaid supplier bills are blockers; customer receivables are reported but are not automatic blockers. An override requires a reason and `PROJECTS:MANAGE` in addition to the close permission.
- Full closure coverage for stock reconciliation, unmatched GRNs, unallocated customer receipts and project-linked journal balance is still dependent on the current data model exposing reliable source links for those records.
