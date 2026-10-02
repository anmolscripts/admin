# Document Lifecycle & State Machine Specification

## 1. Lifecycle Overview

Spark Admin governs Quotations and Invoices through a formal finite state machine. Every document transitions deterministically through four enumerated states:

```
                  ┌──────────────┐
                  │    DRAFT     │ (Browser Client Session)
                  └──────┬───────┘
                         │ Save Document
                         ▼
        ┌──────────►  ACTIVE  ◄──────────┐
        │               │                │
        │ Activate      │ Deactivate     │
        │               ▼                │
        └──────────  INACTIVE ───────────┘
                        │
       ┌────────────────┼────────────────┐
       │ Void           │ Delete         │ Restore
       ▼                ▼                │
   ┌───────┐       ┌─────────┐           │
   │ VOID  │       │ DELETED ├───────────┘
   └───────┘       └─────────┘
 (TERMINAL)       (Soft-Deleted)
```

---

## 2. Document Status Definitions

| Status | Business Meaning | Behavioral Constraints |
| :--- | :--- | :--- |
| **`ACTIVE`** | Live, operational document. | Invoices can receive payments. Can be edited, printed, exported to PDF/Excel, copied, or converted (quotations). |
| **`INACTIVE`** | Temporarily suspended document. | Cannot receive new payments. Can be reactivated to `ACTIVE` by an administrator. Edits permitted. |
| **`VOID`** | Permanently nullified legal document. | **TERMINAL STATE.** Permanently locked against edits, payments, or reactivation. Print and PDF views display a mandatory `VOID` watermark. |
| **`DELETED`** | Soft-deleted document. | Excluded from default list queries and KPI calculations. Retained in database for regulatory audit compliance. Can be restored to `ACTIVE`. |

---

## 3. State Transition Matrix

The table below outlines every possible state transition:

| From State | To `ACTIVE` | To `INACTIVE` | To `VOID` | To `DELETED` | Notes |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **(New)** | **ALLOWED** | Disallowed | Disallowed | Disallowed | Documents are created in `ACTIVE` state. |
| **`ACTIVE`** | — | **ALLOWED** | **ALLOWED** | **ALLOWED** | Full lifecycle operations permitted. |
| **`INACTIVE`** | **ALLOWED** | — | **ALLOWED** | **ALLOWED** | Can be re-enabled or archived. |
| **`VOID`** | **PROHIBITED** | **PROHIBITED** | — | **PROHIBITED** | Terminal. Locked permanently. |
| **`DELETED`** | **ALLOWED** | **PROHIBITED** | **PROHIBITED** | — | Restoration returns document directly to `ACTIVE`. |

---

## 4. Special Transition Workflows

### 4.1. Quotation to Invoice Conversion
- **Trigger:** Operator clicks **Convert to Invoice** on an active Quotation.
- **Rules:**
  1. The source quotation remains in `ACTIVE` state, retaining its original `QTN-YYYY-NNNN` number and `validUntil` date.
  2. A new `INVOICE` record is created with a brand-new `INV-YYYY-NNNN` sequence number.
  3. `invoice.sourceQuotationId` is set to the quotation's `id`.
  4. The quotation's `validUntil` is **NOT** copied to the invoice's `dueDate`. The invoice receives a new `dueDate` (defaults to `invoiceDate + 30 days` unless explicitly specified).
  5. The conversion event is recorded in the audit trail of both documents.

### 4.2. Document Copy Semantics
- **Trigger:** Operator clicks **Copy** from document details or editor.
- **Rules:**
  1. A new unsaved draft is initialized in the browser editor.
  2. Client info, billing address, line items (name, description, rate, quantity, unit, GST rate), remarks, and terms are duplicated.
  3. **EXCLUDED FROM COPY:**
     - `id` (New ID generated upon save)
     - `invoiceNumber` (Assigned sequentially upon save)
     - `status` (Defaults to `ACTIVE`)
     - `version` (Initialized to 1)
     - `isDeleted` and `deletedAt`
     - Conversion linkages (`sourceQuotationId`)
     - Revision history (`InvoiceRevision`)
     - Payment transactions (`Payment`)

### 4.3. Payment Restrictions by Lifecycle State
- **`ACTIVE` Invoices:** Payments can be recorded up to the remaining `outstandingAmount`.
- **`INACTIVE` Invoices:** Recording payments is rejected with HTTP 400 (`Cannot record payment against an inactive invoice.`).
- **`VOID` Invoices:** Recording payments is strictly rejected with HTTP 400 (`Cannot record payment against a voided invoice.`).
- **`DELETED` Invoices:** Recording payments is strictly rejected with HTTP 400 (`Cannot record payment against a deleted invoice.`).

### 4.4. Audit Logging on Lifecycle Changes
Every state change triggers an automatic `InvoiceRevision` insertion with:
- `documentId`: ID of the target document.
- `userId`: Authenticated user performing the action.
- `version`: Incremented document version.
- `changeReason`: Explicit event description (e.g., `STATUS_CHANGE_TO_VOID`, `STATUS_CHANGE_TO_INACTIVE`, `DOCUMENT_RESTORED`, `CONVERTED_FROM_QUOTATION`).
- `snapshotJson`: Full JSON capture of document state at the moment of change.
