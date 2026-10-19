# Project Lifecycle Runbook

1. Select the intended business workspace before opening master data or documents.
2. Create suppliers under **Suppliers**. Deactivate rather than delete suppliers with history. Inactive suppliers remain visible on historical documents but cannot be selected for new POs.
3. From a project, use **New Purchase Order** to preselect that project; leave it blank only for genuine overhead procurement. Create/maintain suppliers through the link in the PO editor.
4. Record partial or final goods receipts against the PO. Do not edit PO lines, supplier or project after receipts; use an approved correction workflow.
5. Record supplier bills and supplier payments as distinct steps. A PO by itself is only a commitment.
6. Issue store stock to a project and record returns separately. Reconcile stock movement history before project closure.
7. Issue customer invoices separately from receiving customer cash; allocate receipts without treating them as extra revenue.
8. Record quotation acceptance before creating its project. Use the accepted quotation’s **Create Project** action; do not create a duplicate manually.
9. Review the project closure preview before closing. Customer receivables are commercial follow-up items, while incomplete deliveries, unposted costs and unpaid supplier bills are processing blockers. Overrides require Project Management permission and a written reason.

## Release safety

- Never run reset/seed/migration commands against `admin`, `spark_admin`, `spark_admin_test`, `spark_admin_prod` or `spark_admin_prod_test`.
- Before any write-enabled test, verify both `SELECT DATABASE()` and the connected user against a specifically approved disposable database.
- This change has not been production-certified: accepted-quotation project creation, project closure gatekeeping, complete lifecycle reconciliation, and browser acceptance still require the reviewed schema/workflow increment and disposable-DB evidence.
