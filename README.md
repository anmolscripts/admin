# Spark Admin — Quotation & Invoice Management

[![Node.js 24](https://img.shields.io/badge/Node.js-24.x-green.svg)](https://nodejs.org/)
[![Prisma ORM 7](https://img.shields.io/badge/Prisma-7.10-blue.svg)](https://www.prisma.io/)
[![Express 5](https://img.shields.io/badge/Express-5.2-black.svg)](https://expressjs.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A mission-critical enterprise Quotation & Invoice Management system engineered for speed, mathematical precision, GST compliance, and immutable auditability. Built upon Express 5, Prisma 7, and MariaDB/MySQL 8, Spark Admin provides a server-authoritative financial core with rich browser workflows, item master autocomplete, lifecycle management, and a unified HTML print/PDF presentation architecture.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Technology Stack](#technology-stack)
- [Architecture](#architecture)
- [System Requirements](#system-requirements)
- [Clone Instructions](#clone-instructions)
- [Environment Configuration](#environment-configuration)
- [Database Setup & Prisma](#database-setup--prisma)
- [Seed & Initial Setup](#seed--initial-setup)
- [Development Startup](#development-startup)
- [Production Startup](#production-startup)
- [Testing Suite](#testing-suite)
- [Project Directory Structure](#project-directory-structure)
- [Document Domain & Lifecycle](#document-domain--lifecycle)
- [GST Tax Calculation Model](#gst-tax-calculation-model)
- [Payment Separation & Behaviour](#payment-separation--behaviour)
- [Item Master & Autocomplete](#item-master--autocomplete)
- [Audit Trail & Revisions](#audit-trail--revisions)
- [Print & PDF Presentation Architecture](#print--pdf-presentation-architecture)
- [Deployment Documentation Links](#deployment-documentation-links)
- [Troubleshooting](#troubleshooting)
- [Contribution & Development Workflow](#contribution--development-workflow)
- [Security Notes](#security-notes)
- [Known Limitations](#known-limitations)
- [License & Third-Party Attribution](#license--third-party-attribution)

---

## Overview

Spark Admin delivers an operational platform for business invoicing and quotations. It guarantees:
1. **Server-Authoritative Calculations:** Every financial total, GST breakdown, discount, round-off, and payment balance is computed exclusively on the backend using integer half-up rounding. Browser editors serve only as interactive calculation mirrors.
2. **Unified Presentation:** Quotation/Invoice print views and exported PDFs are generated from a single shared EJS template driven by a normalized view model, eliminating visual drift.
3. **Data Integrity & Immutability:** Historical quotations and invoices preserve item master snapshots (unit, rate, tax rate) and immutable lifecycle revision histories. Once voided, documents cannot be altered.

---

## Features

- **Document Management:** Create, view, edit, activate, deactivate, void, soft-delete, and restore Quotations and Invoices.
- **Quotation to Invoice Conversion:** Instant single-click conversion with sequence-isolated numbering, linking, and status tracking.
- **Custom Validity / Due Dates:** Persistent date tracking (`validUntil` for quotations, `dueDate` for invoices) with automatic fallback rules and overdue analytics.
- **Indian GST Compliance:** Automatic intra-state (CGST + SGST split) vs. inter-state (IGST) calculation based on supplier and customer places of supply.
- **Unit Master (`/units`):** Full measurement units management with symbol uniqueness, active/inactive toggles, and dynamic dropdown population in document editors.
- **Item Master Autocomplete Portal:** Body portal dropdown with boundary collision avoidance (`zIndex: 10050`) ensuring suggestions never clip behind tables or cards.
- **Fast Keyboard Invoicing Workflow:** Rapid data entry flow (`Item Autocomplete Enter` -> `Unit Enter` -> `Rate Enter` -> `Quantity Enter` -> `Next Row`). Enter on the last row automatically creates a new row and focuses Item Name.
- **Client Optional Fields & Snapshotting:** Client Name is required; Email and Phone are optional (strictly validated when provided). Selecting a saved client auto-populates all fields into an editable document-level snapshot.
- **Unified Button Design System:** Cohesive styling across all pages, modals, and actions following Spark Admin design guidelines.
- **Authoritative Navigation:** Single clean source of truth for sidebar and header pills without demo template links.
- **Separate Payment Ledger:** Invoices track payments independently with receipt numbering, payment methods (Bank Transfer, UPI, Cash, Cheque, Card), and immutable void audits.
- **Optimistic Locking:** Document edit collisions are prevented using concurrency version tokens.
- **Executive Analytics:** Dashboard KPI strip, status counts, aging metrics, and trends aggregated via SQL across dynamic date ranges (`today`, `this_week`, `this_month`, `this_quarter`, `this_year`, `custom`).
- **Team & Role-Based Access Control (`/team`):** 5-tier role hierarchy (`OWNER`, `ADMIN`, `MANAGER`, `MEMBER`, `VIEWER`), module-level action permissions, custom overrides, self-escalation blocks, and last-administrator protection.
- **Cryptographic User Invitations (`/invite/:token`):** Secure single-use invitation lifecycle with SHA-256 token hashing, expiration, revoking, and password onboarding.
- **Append-Only Activity Audit & Analytics (`/team/activity`):** Transaction-atomic logging of user events with sensitive credential sanitization and operational analytics.
- **Export Engines:**
  - One-click native browser print.
  - Pixel-perfect PDF generation powered by headless Chrome/Chromium.
  - Multi-sheet Excel exports via ExcelJS with cell formatting and summary formulas.

---

## Technology Stack

- **Runtime:** Node.js 24 LTS (`v24.x`)
- **Web Framework:** Express 5 (`^5.2.1`)
- **Database & ORM:** MySQL 8 / MariaDB with Prisma ORM 7 (`@prisma/client`, `@prisma/adapter-mariadb`)
- **Templating Engine:** EJS (`^6.0.1`)
- **Authentication & Security:** `bcrypt`, `express-session`, custom stateful CSRF validation, in-memory IP rate limiting, OWASP HTTP headers.
- **Export Tools:** Headless Chromium/Chrome CLI for PDF generation, `exceljs` for XLSX spreadsheets.
- **Frontend Layer:** Vanilla JavaScript (ES6+), Bootstrap 5 UI components, ApexCharts.

---

## Architecture

The application strictly separates presentation, business logic, and persistence layers:

```
Browser Client
     │  (HTTP / Session Cookie / CSRF Token)
     ▼
Express Middleware Pipeline
  ├─ Security Headers & CORS
  ├─ Body Parsers (JSON & URL-Encoded)
  ├─ Session Middleware (express-session)
  ├─ Rate Limiting (auth & global tiers)
  └─ CSRF Protection Middleware
     │
     ▼
Route Dispatchers (`app/routes/`)
  ├─ web.routes.js     (Server-rendered EJS pages)
  ├─ auth.routes.js    (Login, logout, session state)
  └─ invoice.routes.js (REST API endpoints)
     │
     ▼
Controllers (`app/controllers/`)
  ├─ Parameter extraction & validation
  ├─ HTTP status code resolution
  └─ Response rendering / JSON formatting
     │
     ▼
Services (`app/services/`)
  ├─ invoice.service.js       (Lifecycle, domain rules, calculation)
  ├─ documentView.service.js  (Normalized view model builder)
  ├─ item.service.js          (Item Master & search)
  ├─ payment.service.js       (Payment recording & balances)
  ├─ dashboard.service.js     (KPI & SQL aggregations)
  ├─ pdf.service.js           (Headless browser PDF rendering)
  └─ excel.service.js         (Spreadsheet generation)
     │
     ▼
Data Layer (Prisma ORM 7 + MariaDB Adapter)
     │
     ▼
MySQL 8 Database
```

---

## System Requirements

- **Node.js:** `^24.0.0` (Verify with `node -v`)
- **npm:** `^10.0.0` (Verify with `npm -v`)
- **Database:** MySQL 8.0+ or MariaDB 10.6+
- **Headless Browser:** Google Chrome, Chromium, or Microsoft Edge installed on the host for PDF generation.
- **Operating System:** Linux (Ubuntu 22.04/24.04 LTS, Debian 12), macOS, or Windows 10/11.

---

## Clone Instructions

```bash
git clone <repository-url>
cd admin
```

Verify your active branch and ensure line endings are managed by `.gitattributes`:
```bash
git checkout main
```

---

## Environment Configuration

Copy the example environment configuration into `.env`:

```bash
# On Linux / macOS
cp .env.example .env

# On Windows PowerShell
Copy-Item .env.example .env
```

Edit `.env` to configure your local credentials:

```ini
# Application Port and Environment
PORT=3000
NODE_ENV=development

# MySQL Database Connection (Prisma)
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USER=root
DATABASE_PASSWORD=your_local_password
DATABASE_NAME=spark_admin
DATABASE_URL="mysql://root:your_local_password@localhost:3306/spark_admin"

# Session Secret (Generate a strong random string)
SESSION_SECRET=your-random-32-byte-development-secret-key-here

# Initial Admin Seeding Password
SEED_ADMIN_PASSWORD=your-secure-development-password

# Optional: Path to Chrome / Chromium binary if not in standard PATH
# CHROME_BIN=/usr/bin/google-chrome-stable
```

> **Security Alert:** Never commit `.env` or track real credentials in Git.

---

## Database Setup & Prisma

1. **Create Database:** Ensure MySQL is running and create the database if not present:
   ```sql
   CREATE DATABASE IF NOT EXISTS spark_admin CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

2. **Apply Migrations:** Run all production migrations sequentially:
   ```bash
   npx prisma migrate deploy
   ```

3. **Generate Prisma Client:**
   ```bash
   npx prisma generate
   ```

4. **Verify Migration Status:**
   ```bash
   npx prisma migrate status
   ```

---

## Seed & Initial Setup

Database seeding is strictly governed by environment policy (`NODE_ENV`):

```bash
npm run prisma:seed
# or: npx prisma db seed
```

### Production Mode (`NODE_ENV=production`)
Provisions **only** system configuration and master data:
- **System Bootstrap:** RBAC permission dictionary (56 atomic permissions) and standard system roles (`OWNER`, `ADMIN`, `STAFF`, `VIEWER`).
- **Initial Administrator:** Provisions root admin with `OWNER` role using credentials defined in `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`. If admin exists, preserves credentials and updates role to `OWNER`. If `SEED_ADMIN_PASSWORD` is omitted, admin creation is skipped safely.
- **Business Master Data:** 13 Predefined Unit Master entries (`PCS`, `m`, `unit`, `Hours`, `Project`, etc.) and 21 standard Item Master catalog items.
- **Strictly Prohibited in Production:** Zero business profile, zero clients, zero quotations, zero invoices, zero payments, zero revisions, zero activity logs, zero demo users. The business profile is configured on-demand through the web interface on first access.

### Development Mode (`NODE_ENV=development`)
Additionally seeds sample business profile, sample clients (TCS, Infosys), 3 development invoices, and 2 development quotations for local UI evaluation and automated testing.

---

## Development Startup

Start the local server with nodemon auto-reload:

```bash
npm run dev
```

Access the application in your browser:
- **Application URL:** [http://localhost:3000](http://localhost:3000)
- **Login Screen:** [http://localhost:3000/login](http://localhost:3000/login)
- **Health Check:** [http://localhost:3000/health](http://localhost:3000/health)

---

## Production Startup

For production deployment (single-process baseline):

```bash
# 1. Install production dependencies
npm ci --omit=dev

# 2. Deploy database migrations
npx prisma migrate deploy

# 3. Generate client
npx prisma generate

# 4. Start production process
NODE_ENV=production npm start
```

Refer to [docs/DEPLOYMENT.md](file:///c:/Users/User/Documents/project/admin/docs/DEPLOYMENT.md) for full systemd, Nginx reverse proxy, and SSL configuration.

---

## Testing Suite

Spark Admin uses Node's native test runner (`node:test`). Tests run cleanly without external runner dependencies:

```bash
npm test
```

Run a specific test suite:
```bash
node --test tests/phase8.test.js
node --test tests/export.test.js
node --test tests/invoice.test.js
```

All test suites feature strict teardown handlers that disconnect Prisma and terminate HTTP listeners cleanly.

---

## Project Directory Structure

```
admin/
├── app/
│   ├── app.js                 # Express application factory & middleware setup
│   ├── server.js              # HTTP server entrypoint
│   ├── config/
│   │   ├── env.js             # Environment variable validation & parsing
│   │   ├── prisma.js          # Singleton Prisma Client with MariaDB adapter
│   │   └── session.js         # Session store configuration
│   ├── controllers/           # HTTP Request handlers
│   ├── middleware/            # Auth, CSRF, Rate Limiting, Error handlers
│   ├── routes/                # Web pages and REST API routes
│   ├── services/              # Domain logic, calculations, exports
│   └── views/                 # EJS templates
│       ├── auth/              # Login view
│       ├── dashboard/         # Dashboard metrics view
│       ├── documents/         # Editor, document list, view, print views
│       │   └── templates/     # Shared presentation template (document.ejs)
│       ├── clients/           # Client directory
│       └── items/             # Item Master directory
├── assets/                    # Static CSS, JS, vendor libraries, icons
├── docs/                      # Comprehensive technical architecture & guides
│   ├── ADR/                   # Architecture Decision Records
│   ├── ARCHITECTURE.md        # System architecture specification
│   ├── CORE_CONTRACTS.md      # Frozen core baseline contracts
│   ├── DATABASE.md            # Schema, models, and migrations
│   ├── DOCUMENT_LIFECYCLE.md  # State machine and transition matrix
│   └── DEVELOPER_HANDBOOK.md  # Onboarding guide
├── prisma/
│   ├── migrations/            # Ordered SQL migrations
│   ├── schema.prisma          # Database schema definition
│   └── seed.js                # Seed script
├── tests/                     # Automated test suites
├── .editorconfig              # Uniform editor whitespace & formatting
├── .gitattributes             # Line ending normalization
├── .nvmrc                     # Node 24 runtime lock
└── package.json               # Manifest & scripts
```

---

## Document Domain & Lifecycle

Documents share a unified schema model (`Invoice`) differentiated by `documentType`:
- **`QUOTATION`:** Pre-sale price estimates. Number prefix: `QTN-YYYY-NNNN`. Tracks `validUntil`.
- **`INVOICE`:** Commercial tax invoice. Number prefix: `INV-YYYY-NNNN`. Tracks `dueDate`.

### Document Status Transitions

```
[ DRAFT (Client Form) ]
           │
           ▼
        ACTIVE ◄──────────┐
        │    │            │
        │    └─► INACTIVE ┘
        │
        ├─► VOID (Terminal: permanently locked)
        │
        └─► DELETED (Soft-delete: restorable to ACTIVE)
```

- **ACTIVE:** Live document. Invoices can accept payments.
- **INACTIVE:** Temporarily paused. Invoices cannot accept new payments until reactivated.
- **VOID:** Permanently locked. Retains watermark on print/PDF. No edits, payments, or status reversions permitted.
- **DELETED:** Hidden from default lists. Can be restored to `ACTIVE`.

---

## GST Tax Calculation Model

All financial values are computed on the server using rounded integer arithmetic:
1. `lineTotal = round(quantity * rate)`
2. `subtotal = sum(lineTotal)`
3. Tax Determination:
   - **Intra-State:** If `businessProfile.state === client.state`, tax splits equally into **CGST** (`rate / 2`) and **SGST** (`rate / 2`).
   - **Inter-State:** If states differ, entire tax is applied as **IGST** (`rate`).
4. `taxAmount = round(subtotal * (taxRate / 100))`
5. `grandTotal = subtotal + taxAmount + roundOff`
6. `outstandingAmount = grandTotal - paidAmount`

---

## Payment Separation & Behaviour

Payments are modeled as a distinct child ledger (`Payment`):
- Recorded against `INVOICE` documents in `ACTIVE` status only.
- Updating or recording payments triggers an atomic transaction updating `invoice.paidAmount` and `invoice.outstandingAmount`.
- When `paidAmount >= grandTotal`, payment status is `PAID`.
- Voiding a payment decreases `paidAmount` and reopens `outstandingAmount` without altering invoice line items.

---

## Item Master & Autocomplete

- **Centralized Catalog:** The `Item` model stores catalog items with name, unit, default rate, and default GST rate. Includes the 21 industrial and commercial preloaded master items.
- **Case-Insensitive Unique Names:** MySQL unique index prevents duplicate names.
- **Autocomplete Portal UI:** In the document editor, typing in the Item Description invokes a debounced `/api/items/search` query. Results render via a top-level body portal (`#item-autocomplete-portal`, `z-index: 10050`) using fixed coordinates and viewport collision clamping, eliminating clipping by horizontal/vertical scroll wrappers.
- **Keyboard Navigation & Fast Operations:** Full keyboard support (`↑`, `↓`, `Enter`, `Escape`). Pressing Enter on Quantity automatically creates the next row and transfers focus to the new Item Name.
- **Inline Catalog Ingestion:** If a user completes a document with an uncataloged item name, the service automatically inserts the new item into the Item Master inside a concurrent-safe upsert.
- **Snapshot Isolation:** Changing an item in Item Master does NOT alter prices or descriptions of historical invoices/quotations.

---

## Unit Master (`/units`)

- **Domain Model:** Dedicated `Unit` entity with name, symbol (`@unique`), description, and `active` boolean.
- **Predefined Units:** 13 common measurement standards seeded idempotently (`PCS`, `m`, `unit`, `Project`, `Hours`, `Months`, `Units`, `License`, `Year`, `Package`, `Set`, `KG`, `Service`).
- **Dynamic Editor Integration:** Invoice and quotation editors fetch active units dynamically from `/api/units/active`.
- **Historical Immutability:** Line items snapshot unit symbols as string values; deactivating or editing a unit in Unit Master never mutates historical documents.

---

## Client Optional Fields & Document-Level Snapshot

- **Required vs Optional:** Client / Business Name is required. Email address and phone number are optional; when provided, strict RFC 5322 email and phone format validation applies.
- **Saved Client Autofill:** Selecting an existing client from "Choose Saved Client" populates Name, Email, Phone, GSTIN, Place of Supply, Billing Address, and Shipping Address instantly.
- **Document Snapshot Badge:** Changes made in the editor after selection remain isolated to the document snapshot (`Document-level client snapshot`), never silently modifying the Client Master.

---

## Audit Trail & Revisions

- Every document modification creates an immutable snapshot in `InvoiceRevision`.
- Captures: `documentId`, `userId`, `version`, `changeReason`, `snapshotJson`, `createdAt`.
- Concurrency control: Updates verify `version` against the database to prevent concurrent overwrites (Optimistic Concurrency Control).

---

## Print & PDF Presentation Architecture

To prevent discrepancy between what the user prints and the PDF they download, Spark Admin enforces **One Presentation Source**:

```
Database Record
      │
      ▼
buildDocumentViewModel()  [app/services/documentView.service.js]
      │
      ▼
templates/document.ejs    [app/views/documents/templates/document.ejs]
      ├──────────────────────────────┐
      ▼                              ▼
HTML Print View                 Headless Chromium
(GET /documents/:id/print)     (GET /api/invoices/:id/pdf)
                                     │
                                     ▼
                                 PDF Buffer
```

No secondary PDF layout engine is permitted. If Chromium/Chrome is missing, the PDF service raises a controlled `PdfConfigurationError` rather than rendering a divergent layout.

---

## Deployment Documentation Links

- **Production Deployment Guide:** [docs/DEPLOYMENT.md](file:///c:/Users/User/Documents/project/admin/docs/DEPLOYMENT.md)
- **Production Checklist:** [PRODUCTION_CHECKLIST.md](file:///c:/Users/User/Documents/project/admin/PRODUCTION_CHECKLIST.md)
- **Architecture Documentation:** [docs/ARCHITECTURE.md](file:///c:/Users/User/Documents/project/admin/docs/ARCHITECTURE.md)
- **Core Baseline Contracts:** [docs/CORE_CONTRACTS.md](file:///c:/Users/User/Documents/project/admin/docs/CORE_CONTRACTS.md)

---

## Troubleshooting

### 1. `PDF generation engine (Chrome/Chromium) is unavailable`
- Ensure Google Chrome, Chromium, or Microsoft Edge is installed on the host.
- In Linux environments:
  ```bash
  sudo apt-get install -y chromium-browser
  ```
- Alternatively, specify the binary path explicitly in `.env`:
  ```ini
  CHROME_BIN=/usr/bin/chromium-browser
  ```

### 2. `Database connection refused on localhost:3306`
- Verify MySQL service status: `sudo systemctl status mysql` (Linux) or Services app (Windows).
- Ensure credentials in `DATABASE_URL` match your MySQL user grant.

### 3. Concurrency Conflict: `Document has been modified by another user`
- The document was modified by another session. Refresh the document page to load the latest revision before making edits.

---

## Contribution & Development Workflow

Please follow the conventions detailed in [docs/DEVELOPMENT_WORKFLOW.md](file:///c:/Users/User/Documents/project/admin/docs/DEVELOPMENT_WORKFLOW.md):
1. Create a feature branch: `feature/your-feature-name` or `fix/your-fix-name`.
2. Do not modify frozen core contracts without team consensus and Architecture Decision Records (ADRs).
3. Ensure all tests pass: `npm test`.
4. Validate Prisma schema: `npx prisma validate`.
5. Keep commits atomic and informative.

---

## Security Notes

- **Password Storage:** Salted and hashed with `bcrypt` (12 rounds) with dummy hash comparison to mitigate timing attacks.
- **CSRF Defense:** Synchronizer token pattern implemented for all non-GET requests.
- **Rate Limiting:** IP-based sliding window rate limiter protects `/login` and API mutation routes.
- **Input Sanitization:** Parameter validation across controllers; SQL injection prevented via Prisma parameterized queries; XSS mitigated through EJS HTML escaping.

---

## Known Limitations

- **Single-Process Session Store:** Currently uses Express `MemoryStore` suitable for single-instance VPS deployments. Multi-instance horizontal scaling requires configuring Redis session store and distributed rate limiting.
- **Local PDF Execution:** Headless Chrome execution runs on the local server; high-volume concurrency should consider a dedicated rendering sidecar/queue.

---

## License & Third-Party Attribution

- **Application Code:** Licensed under the [MIT License](file:///c:/Users/User/Documents/project/admin/LICENSE).
- **Dashboard UI Template:** Spark Admin HTML/Bootstrap template is Copyright &copy; [Spark Admin Dev](https://sparkadminpro.gumroad.com/) and distributed by [ThemeWagon](https://themewagon.com).
