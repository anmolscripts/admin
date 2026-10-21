# Enterprise inspection and record workflows

## Delivered in this release

- Shared, keyboard-accessible row inspection for clients, items, units, suppliers, projects, documents, purchase orders, supplier bills, goods receipts, expenses, other income and credit/debit notes. Project purchasing, inventory, timesheet and expense rows use the same surface. Existing action links and report drilldowns remain available.
- In-modal editing for clients, items, units, suppliers and project identity/location fields. Document editing uses the existing full editor inside the modal and preserves invoice revisions. Edits are exposed only when the server grants the module's EDIT permission.
- Master-record changes and their before/after history commit in one database transaction. History failure rolls back the change. Stale edits return 409 instead of overwriting another user's save. Legacy update forms, status toggles and CSV item updates use the same history writer. Earlier logs remain visible, but missing historical field snapshots cannot be reconstructed.
- History includes actor, time, changed fields, pagination and a search filter for the displayed page. Project commercial fields require FINANCIALS_VIEW. Financial/stock/payroll rows retain their dedicated correction and reversal workflows.
- Existing client/item/unit API and page boundaries enforce the selected business. Lists and imports are scoped; imports require EDIT to update existing items. Default-business legacy units remain accessible without exposing them to other businesses.
- Removing a unit archives it and preserves its record and history. Supported record edits do not delete records.
- Supplier-bill posting now provisions and selects accounts and matches inventory within the current business. Foreign debit-account IDs are rejected.
- Goods-receipt retries use a persistent business-scoped request key and payload fingerprint. Matching retries return the original receipt; changed payloads using the same key return 409. The receipt form reuses its key after a network failure. Purchase-order quantities are checked while holding a row lock inside the posting transaction; duplicate PO lines and non-finite quantities/costs are rejected.

## Verification and release limits

Tests run in a disposable `ui_audit_*` database, never against production. New tests cover actual authenticated HTTP requests, CSRF, business boundaries, role denial, stale writes, immutable history, audit-failure rollback, HTML escaping and modal saves. Existing accounting, purchasing, project, payroll, document and release tests provide regression coverage.

This is an inspected implementation release, not a certification that every enterprise scenario or every row in every module is complete. The browser permission gate prevented an authenticated visual walkthrough. Aggregate/report rows and administration-specific records retain their existing interfaces rather than offering unsafe generic edits.

The R11 goods-receipt acceptance tests are now executable checks, backed by a real database concurrency/replay test. API consumers should supply an Idempotency-Key header or idempotencyKey body field when retrying receipt creation. Legacy callers without a key retain PO concurrency protection but cannot receive retry deduplication. Before general sale, complete an authorized visual/role walkthrough, restore drills and operational acceptance for the intended hosting environment. The ngrok endpoint is served by the local production process and depends on this computer and tunnel staying online.

Production deployment backs up the database and previous build, applies only forward migrations, verifies row counts, starts the production release and checks the public health endpoint. Record history uses existing audit/revision tables. The receiving migration adds nullable requestKey/requestHash columns and a business-scoped unique index; historical receipts are preserved with NULL request identity.
