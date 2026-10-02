# ADR 0001: Shared Document Model for Quotations & Invoices

## Status
**ACCEPTED / FROZEN** (Core Baseline)

## Context
A key capability of Spark Admin is issuing pre-sale Quotations and converting them into legal commercial Invoices.

Traditional ERP systems often split these entities into two completely separate database tables (`quotations` and `invoices`) with duplicated line item tables (`quotation_items`, `invoice_items`). However, in this domain:
- Line item structures are 100% identical (name, description, rate, quantity, unit, HSN/SAC, tax rate).
- Customer snapshot fields are identical (name, email, GSTIN, place of supply, addresses).
- Financial arithmetic is identical (subtotal, tax split, round-off, grand total).
- Quotations convert directly into Invoices, often with zero modification to line items.

Maintaining two distinct tables results in duplicate schema definitions, redundant validation logic, duplicated editor templates, and complex cross-table data copying during conversion.

## Decision
We decided to model both Quotations and Invoices in a **single shared database table (`invoices`)** differentiated by an enumerated discriminator column:
`documentType: DocumentType @default(INVOICE)` (`QUOTATION` | `INVOICE`)

- **Sequence Isolation:** Numbering is partitioned by `documentType` (`QTN-YYYY-NNNN` vs. `INV-YYYY-NNNN`).
- **Date Isolation:** Quotations persist `validUntil` (`dueDate = null`); Invoices persist `dueDate` (`validUntil = null`).
- **Conversion Linkage:** An invoice converted from a quotation links to its source via `sourceQuotationId: Int? @unique`.

## Consequences
### Positive
- Zero schema duplication for line items, taxes, or customer snapshots.
- Single unified view model builder (`documentView.service.js`) and presentation template (`templates/document.ejs`).
- Instant quotation-to-invoice conversion executed as a simple, atomic database insertion.

### Negative / Trade-offs
- Certain fields are nullable depending on `documentType` (`dueDate` vs. `validUntil`, payment relations).
- Queries must filter by `documentType` when listing or aggregating specific document types.

## What Future Developers Must Not Casually Reverse
**Do NOT split Quotations and Invoices into two separate database tables.**
Splitting the table would break existing foreign key linkages, invalidate `documentView.service.js`, duplicate migration paths, and fragment the unified editor and presentation architecture.
