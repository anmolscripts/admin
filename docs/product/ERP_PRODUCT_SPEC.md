# ERP_PRODUCT_SPEC.md

## Vision
Spark Admin aims to be a **general‑purpose ERP** for small and medium‑size businesses, covering core financial, sales, purchasing, inventory, and reporting workflows.

## Target Users
- SME owners / managers
- Finance & accounting staff
- Sales & purchase teams
- Inventory/warehouse supervisors

## Core Principles
1. **Data integrity** – immutable posted journals, audit‑trail, optimistic locking.
2. **Security** – role‑based access, session hardening, no secret leakage.
3. **Safety** – never operate on the production `admin` database in tests or packaging.
4. **Extensibility** – modular services, clean API boundaries.
5. **Compliance‑ready** – Indian GST handling is documented, not assumed.

## Core Modules (minimum viable for release)
| Module | Description | Status |
|--------|-------------|--------|
| Organisation & Branding | Org profile, logo, fiscal settings, dynamic branding. | Exists & Verified |
| Authentication & Sessions | Login, password reset, session expiry. | Exists & Verified |
| RBAC & Navigation | Role permissions, menu visibility. | Exists & Verified |
| Customer / Supplier Management | CRUD, contact details, tax IDs. | Exists & Verified |
| Invoice & Quotation | Creation, conversion, numbering, PDF/Excel export, posting, notes. | Exists & Verified |
| Payments | Record, void, post to journals. | Exists & Verified |
| Credit/Debit Notes | CRUD, posting, reversal. | Exists & Verified |
| Journal & Ledger | Double‑entry posting, immutable journals, reports. | Exists & Verified |
| Dashboard & Search | Metrics, global search. | Exists & Verified |
| Reporting | Trial balance, P&L, balance sheet, ageing. | Exists & Verified |
| Settings | Business profile, fiscal year, defaults. | Exists & Verified |

## Non‑Goals (out of scope for Phase 0)
- Full payroll processing (only expense reimbursements).
- Multi‑currency support.
- Advanced project costing beyond basic labour allocation.
- Automated GST filing to government portals.

## Design Standards
- Use the existing design tokens defined in `assets/css/` (primary hue #2A9D8F, secondary #E9C46A).
- Typography: **Inter** from Google Fonts, base size 16px.
- Responsive breakpoints: 320, 768, 1024, 1280, 1440.
- Accessibility: ARIA labels on interactive elements, focus-visible outlines.

## Security Standards
- All endpoints protected by `requireAuth` middleware.
- Permission checks via `requirePermission`.
- No secrets in source; `.env*` are ignored.
- CSRF protection via same‑site cookies, input validation for all uploads.

## Accounting Invariants
- Posted journals are immutable; corrections use reversal entries.
- Fiscal year runs 1 Apr – 31 Mar, stored in `financial_year` table.
- Document statuses: `ACTIVE`, `INACTIVE`, `VOID`, `DELETED`.
- Separate numbering series for quotations (`QUOTATION`) and invoices (`INVOICE`).
- `RETAINED_EARNINGS` system account key.

*Prepared by the technical lead – Phase 0.*
