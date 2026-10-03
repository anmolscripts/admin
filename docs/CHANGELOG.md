# Project Changelog & Architectural Milestones

All notable changes to the **Spark Admin** Quotation & Invoice Management system are documented in this file.

---

## [Phase 8.2 / UX Polish & Master Data] — 2026-10-03
`fix: improve invoice editor ux and master data management`

### Added
- **Unit Master Domain (`Unit` model & management):**
  - Added `Unit` model with unique `symbol`, `name`, `description`, `isActive`, `createdAt`, `updatedAt` via forward-only migration `20261003060017_add_unit_master`.
  - Added `app/services/unit.service.js` with full CRUD, validation, activation toggling, duplicate symbol/name protection, and seeding.
  - Added `app/controllers/unit.controller.js` and registered web route `/units` and REST API endpoints `/api/units` and `/api/units/active`.
  - Created complete Unit Master management view `app/views/units/index.ejs` with search, active status toggle, add/edit modal, and delete confirmation.
  - Updated document editor (`app/views/documents/editor.ejs`) and item master (`app/views/items/index.ejs`) to dynamically load active units from the Unit Master catalog via `window.__AVAILABLE_UNITS__`.
- **Item Master Preloaded Catalog (21 Master Items):**
  - Updated `prisma/seed.js` to idempotently seed 21 master industrial pipeline and instrumentation items with exact business names, units (`m`, `unit`), and rates.
- **Top-Level Autocomplete Portal Architecture:**
  - Implemented `#item-autocomplete-portal` mounted directly under `document.body` with `position: fixed` and `z-index: 10050`.
  - Autocomplete dropdown dynamically calculates target input bounding client rect and clamps viewport positioning to eliminate parent overflow clipping (`overflow-x: auto`) and stacking context traps.
  - Implemented debounced API search (150ms, 1-char min), keyboard navigation (`↑`, `↓`, `Enter`, `Escape`), active option tracking, and ARIA listbox/option compliance.
- **Rapid Keyboard Invoice Entry Workflow:**
  - Implemented Enter-key navigation chaining: Item Name selection $\to$ Unit $\to$ Rate $\to$ Quantity $\to$ Next Row Item Name.
  - Pressing Enter in the Quantity input on the final row automatically appends a new line item and focuses its Item Name input.
  - Escape closes autocomplete suggestion portal; Tab navigation remains natural.
- **Document-Level Client Snapshotting & Autofill:**
  - Added instant client autofill from "Choose Saved Client" dropdown, populating Client Name, Email, Phone, GSTIN, Place of Supply, Billing Address, and Shipping Address.
  - Added "Clear Client" button (`#btn-clear-client`) to reset client inputs without page reloads.
  - Added non-intrusive `Document-level client snapshot` badge indicating document-level isolation from future master client updates.
- **Unified Button System:**
  - Standardized `.btn-spark` design system with consistent border radius (8px), padding, typography, icon alignment, focus rings, and states across `.btn-spark-primary`, `.btn-spark-secondary`, `.btn-spark-outline`, `.btn-spark-danger`, `.btn-spark-success`, and `.btn-spark-sm`.
- **Authoritative Side Navigation:**
  - Streamlined `app/views/layouts/header.ejs` into 6 authoritative sections: Dashboard, Documents, Clients, Items, Units, Settings.
  - Removed all stale template `.html` demo links, badges, and dummy components.
  - Bound active navigation state dynamically to `res.locals.currentPath`.
- **Standard Terms & Conditions:**
  - Configured 4 user-provided standard terms into default business profile terms in `prisma/seed.js`.
- **Architecture Decision Record:**
  - Added `docs/ADR/0006-unit-master-and-client-snapshot.md`.

### Changed
- **Client Optional Email and Phone:**
  - Relaxed client email and phone validation in `app/services/client.service.js` and `app/services/invoice.service.js` to be strictly optional.
  - When non-empty values are supplied, rigorous RFC email and 10-15 digit phone validation remains strictly enforced.
  - Removed misleading required indicators (`*`) from client forms and editor templates.
- **Documents List History PushState Bug Fix:**
  - Fixed `DataCloneError` in `assets/js/documents.js` where non-serializable `AbortController` was passed to `history.pushState()`.

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
