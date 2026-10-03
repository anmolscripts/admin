# Database Architecture & Schema Specification

## 1. Overview

Spark Admin utilizes MySQL 8 (or MariaDB 10.6+) accessed via **Prisma ORM 7** (`@prisma/client` with `@prisma/adapter-mariadb`). All monetary and rate values use fixed-point `Decimal` representation to avoid IEEE 754 binary floating-point rounding errors.

---

## 2. Production Data Models

### 2.1. `User` (`users`)
- **Purpose:** System operator accounts for authentication, authorization, and audit attribution.
- **Key Fields:** `id` (Int, PK), `name` (VarChar), `email` (VarChar, Unique), `password` (VarChar, bcrypt hash), `role` (VarChar, default "ADMIN"), `active` (Boolean).
- **Relations:** 1-to-many with `Invoice` (created, updated, deleted), `InvoiceRevision` (changed), `Client` (created), `Payment` (created), `Item` (created).
- **Indexes:** Primary key `id`, unique `email`.

### 2.2. `Client` (`clients`)
- **Purpose:** Customer directory storing billing, shipping, and tax identifiers.
- **Key Fields:** `id` (Int, PK), `name` (VarChar), `email`, `phone`, `gstin` (VarChar), `stateCode` (VarChar(5) for GST place of supply), `billingAddress` (Text), `shippingAddress` (Text), `active` (Boolean).
- **Relations:** Belongs to `User` (createdBy), 1-to-many with `Invoice`.
- **Indexes:** `name`, `email`, `active`, `createdById`.

### 2.3. `BusinessProfile` (`business_profiles`)
- **Purpose:** Singleton company configuration representing the selling entity.
- **Key Fields:** `id` (Int, PK), `legalName`, `displayName`, `gstin`, `stateCode`, `email`, `phone`, `address`, `defaultTerms`, `defaultRemarks`.
- **Lifecycle:** Created once via setup/seed, edited via settings view.

### 2.4. `Invoice` (`invoices`)
- **Purpose:** Unified entity representing both **Tax Invoices** and **Quotations**.
- **Key Fields:**
  - `id` (Int, PK)
  - `documentType` (`QUOTATION` | `INVOICE`)
  - `invoiceNumber` (VarChar(50), Unique, e.g. `INV-2026-0001` or `QTN-2026-0001`)
  - `clientId` (Int, FK to `Client`, nullable)
  - Snapshot fields: `clientName`, `clientEmail`, `clientPhone`, `clientGSTIN`, `placeOfSupplyStateCode`, `billingAddress`, `shippingAddress`, `sellerName`, `sellerGSTIN`, `sellerStateCode`, `sellerEmail`, `sellerPhone`, `sellerAddress`
  - Dates: `invoiceDate` (Date), `dueDate` (Date, nullable, used by Invoices), `validUntil` (Date, nullable, used by Quotations)
  - Financials: `gstEnabled` (Boolean), `gstRate` (Decimal(5,2)), `subtotal` (Decimal(12,2)), `gstAmount` (Decimal(12,2)), `cgstAmount` (Decimal(12,2)), `sgstAmount` (Decimal(12,2)), `igstAmount` (Decimal(12,2)), `roundOff` (Decimal(12,2)), `grandTotal` (Decimal(12,2)), `paidAmount` (Decimal(12,2)), `outstandingAmount` (Decimal(12,2))
  - Lifecycle: `status` (`ACTIVE` | `INACTIVE` | `VOID` | `DELETED`), `previousStatusBeforeDelete`, `deletedAt`, `deletedById`, `deleteReason`
  - Concurrency & Linkages: `version` (Int, default 1), `sourceQuotationId` (Int, unique FK to self), `createdById`, `updatedById`
- **Relations:** 1-to-many with `InvoiceItem`, `InvoiceRevision`, `Payment`. Self-relation `sourceQuotation` -> `convertedInvoice`.
- **Indexes:** `documentType`, `clientId`, `clientName`, `status`, `invoiceDate`, `createdById`, `updatedById`, `deletedById`.

### 2.5. `InvoiceItem` (`invoice_items`)
- **Purpose:** Line item entries belonging to an invoice or quotation.
- **Key Fields:** `id` (Int, PK), `invoiceId` (Int, FK), `lineNumber` (Int), `name` (VarChar), `hsnSac` (VarChar), `quantity` (Decimal(10,2)), `unit` (VarChar), `rate` (Decimal(12,2)), `amount` (Decimal(12,2)).
- **Lifecycle:** Cascades on invoice deletion.

### 2.6. `Item` (`items`)
- **Purpose:** Centralized Item Master catalog for fast autocomplete and standard pricing.
- **Key Fields:** `id` (Int, PK), `name` (VarChar, Unique), `description` (Text), `unit` (VarChar), `rate` (Decimal(12,2)), `hsnSac` (VarChar), `gstRate` (Decimal(5,2)), `active` (Boolean).
- **Snapshot Rule:** Changes to `Item` do not alter existing `InvoiceItem` rows.
- **Indexes:** Unique `name`, `active`, `createdById`.

### 2.7. `InvoiceRevision` (`invoice_revisions`)
- **Purpose:** Append-only audit history capturing every lifecycle transition, edit, or status change.
- **Key Fields:** `id` (Int, PK), `invoiceId` (Int, FK), `revisionNo` (Int), `action` (VarChar), `changedById` (Int, FK), `ipAddress`, `userAgent`, `changedAt` (DateTime), `changes` (JSON field diff), `snapshot` (Full JSON snapshot).
- **Indexes:** Unique composite `[invoiceId, revisionNo]`, `invoiceId`, `changedById`.

### 2.8. `Payment` (`payments`)
- **Purpose:** Payment transaction ledger for commercial invoices.
- **Key Fields:** `id` (Int, PK), `invoiceId` (Int, FK), `paymentDate` (Date), `amount` (Decimal(12,2)), `method` (VarChar: `BANK_TRANSFER`, `UPI`, `CASH`, `CHEQUE`, `CARD`), `reference` (VarChar), `notes` (Text), `status` (VarChar, default "RECORDED"), `createdById` (Int, FK).
- **Relations:** Belongs to `Invoice`, belongs to `User` (createdBy).
- **Indexes:** `invoiceId`, `status`, `paymentDate`, `createdById`.

### 2.9. `InvoiceNumberSequence` (`invoice_number_sequences`)
- **Purpose:** Atomic sequence counters for race-condition-free document numbering.
- **Key Fields:** `id` (Int, PK), `documentType` (`QUOTATION` | `INVOICE`), `year` (Int), `currentNumber` (Int).
- **Indexes:** Unique composite `[documentType, year]`.

### 2.10. `Unit` (`units`)
- **Purpose:** Centralized Unit Master catalog defining standard measurement units for line items.
- **Key Fields:** `id` (Int, PK), `name` (VarChar), `symbol` (VarChar(30), Unique), `description` (Text), `active` (Boolean), `createdById` (Int, FK), `createdAt`, `updatedAt`.
- **Relations:** Belongs to `User` (createdBy).
- **Indexes:** Unique `symbol`, `active`, `createdById`.

---

## 3. Prisma Migrations History

All database schema evolutions are captured in forward-only SQL migration scripts inside `prisma/migrations/`:

1. `20260925090401_init`: Baseline user table and authentication attributes.
2. `20261001111514_add_invoice_module`: Initial invoice and line items schema.
3. `20261001120315_add_document_foundation`: Document type enums, statuses, sequences, and optimistic locking version tokens.
4. `20261001132951_add_document_snapshot_fields`: Seller/client snapshot columns and place of supply state codes.
5. `20261001163947_add_clients_business_profile_and_payments`: Client directory, business profile, and payment ledger tables.
6. `20261002065000_add_item_master_and_audit_fields`: Item Master table and append-only audit revision log.
7. `20261002141500_add_unique_constraint_to_item_name`: Strict case-insensitive uniqueness index on `Item.name`.
8. `20261002150000_add_due_date_and_valid_until_to_invoices`: Pure calendar date persistence for `validUntil` and `dueDate`.
9. `20261003060017_add_unit_master`: Unit Master table with symbol uniqueness constraint and user audit relation.

---

## 4. Migration Execution Commands

### Local Development
```bash
# Apply migrations and create new migration from schema changes:
npx prisma migrate dev --name your_migration_name

# Generate fresh Prisma client:
npx prisma generate
```

### Production Deployment
```bash
# Apply pending migrations safely without schema alteration or prompt:
npx prisma migrate deploy

# Verify status:
npx prisma migrate status
```

> **CRITICAL RULE FOR PRODUCTION:**
> **NEVER run `npx prisma migrate reset` or `npx prisma db push` on a production or staging database.**
> `prisma migrate reset` will drop all tables and destroy business data. Only `npx prisma migrate deploy` is permitted in staging and production.
