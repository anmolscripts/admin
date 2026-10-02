# Project Changelog & Architectural Milestones

All notable changes to the **Spark Admin** Quotation & Invoice Management system are documented in this file.

---

## [Core Baseline Freeze] — 2026-10-02

### Added
- **Custom Due Date & Validity Persistence:**
  - Added `dueDate DateTime? @db.Date` and `validUntil DateTime? @db.Date` to the shared `Invoice` model.
  - Quotations persist `validUntil` with null `dueDate`; Invoices persist `dueDate` with null `validUntil`.
  - Added pure calendar date persistence via migration `20261002150000_add_due_date_and_valid_until_to_invoices`.
  - Updated conversion logic to isolate quotation `validUntil` from invoice `dueDate`.
  - Updated overdue calculations across dashboard aggregations and document listing badges.
- **Strict Single Print & PDF Presentation Architecture:**
  - Removed independent PDFKit markup fallback from `app/services/pdf.service.js`.
  - Enforced single presentation pipeline: `buildDocumentViewModel()` -> `templates/document.ejs` -> Headless Chromium -> PDF Buffer.
  - Controlled `PdfConfigurationError` thrown when browser executable is unavailable.
- **Repository Normalization & Developer Experience:**
  - Added `.gitattributes` for consistent repository-wide LF line-ending normalization.
  - Added `.editorconfig` specifying indentation, line endings, and whitespace trimming.
  - Added `.nvmrc` locking Node.js 24 runtime.
  - Created complete architectural documentation suite in `docs/` and 5 Architecture Decision Records in `docs/ADR/`.

---

## [Phase 8.1] — Commit `14a8385`
`fix: complete phase 8 final qa`
- Added case-insensitive unique constraint to `Item.name` via migration `20261002141500_add_unique_constraint_to_item_name` to eliminate concurrent duplicate item insertion races.
- Added `this_quarter` preset to dashboard KPI date-range filter with January/April/July/October boundary tests.
- Fixed integration test runner teardown by ensuring explicit HTTP server close and Prisma pool disconnection.

---

## [Phase 8] — Commit `b5f030f`
`feat: add item master audit dashboard and unified document template`
- Introduced centralized `Item` Master catalog with name, unit, rate, HSN/SAC, and GST rate.
- Implemented asynchronous debounced autocomplete in document editor with full keyboard navigation (`↑`, `↓`, `Enter`, `Esc`).
- Automatic catalog ingestion for uncataloged item names entered in documents.
- Created `InvoiceRevision` append-only audit log capturing actor, timestamp, version, and full JSON snapshot.
- Built Executive Dashboard KPI strip and SQL aggregations for revenue, quotation conversions, and collections.
- Unified document print presentation into `app/views/documents/templates/document.ejs`.

---

## [Deployment Readiness] — Commit `1e95333`
`chore: prepare application for production deployment`
- Prepared single-process production baseline guidelines.
- Configured systemd service definition and Nginx reverse proxy template.
- Documented automated backup scripts and disaster recovery restoration procedures.

---

## [Phase 7] — Commit `d7eb3c5`
`feat: production hardening and release audit`
- Implemented stateful CSRF synchronizer token protection across all mutating endpoints.
- Added in-memory sliding window rate limiters for authentication attempts and mutation routes.
- Configured secure cookie attributes (`HttpOnly`, `SameSite=Lax`, `Secure` in production).
- Configured OWASP security headers (`nosniff`, `SAMEORIGIN`, `strict-origin-when-cross-origin`).

---

## [Phase 6] — Commit `c246d20`
`feat: add clients business profile and payments`
- Added `Client` directory table and autocomplete search.
- Added `BusinessProfile` singleton configuration for seller legal details, GSTIN, and bank remittance information.
- Added `Payment` ledger table supporting multiple partial payments, diverse methods, and payment voiding.

---

## [Phase 5] — Commit `1d5c089`
`feat: add document print and export`
- Built full-page HTML print view for quotations and invoices.
- Implemented PDF generation using headless browser rendering.
- Added Excel export generating multi-sheet formatted workbooks via `exceljs`.

---

## [Phase 4] — Commit `cf6b9c5`
`feat: add document view and lifecycle actions`
- Built Document View screen (`/documents/:id`) with comprehensive lifecycle management.
- Implemented document status transitions: `ACTIVE`, `INACTIVE`, `VOID`, `DELETED`.
- Added soft-deletion, restoration, and document copying mechanics.
- Implemented Quotation to Invoice conversion with sequence isolation.

---

## [Phase 3] — Commit `397362f`
`feat: add quotation and invoice document editor`
- Created unified document editor (`/documents/new`, `/documents/:id/edit`).
- Real-time client-side calculation mirror with interactive GST split.
- Optimistic locking using document version concurrency tokens.

---

## [Phase 2] — Commit `3770d43`
`feat: add quotation and invoice listing`
- Built interactive document directory table with server-side pagination, search, and type/status filters.
- Added responsive status badges and quick action dropdown menus.

---

## [Phase 1] — Commit `7405c7a`
`feat: add quotation and invoice domain foundation`
- Created unified `Invoice` schema model with `documentType` enum (`QUOTATION` | `INVOICE`).
- Implemented atomic sequence numbering (`InvoiceNumberSequence`).
- Established server-authoritative financial calculation engine with half-up rounding.

---

## [Initial Milestones]
- `65dc8e8 feat: complete database authentication`: Database authentication with bcrypt and session storage.
- `b094768 feat: add user database schema`: Initial user model and Prisma migration.
- `d1f112b chore: add prisma mysql integration`: Prisma ORM configuration with MariaDB driver adapter.
- `1284044 refactor: organise authenticated admin routes`: Express routing modularization.
