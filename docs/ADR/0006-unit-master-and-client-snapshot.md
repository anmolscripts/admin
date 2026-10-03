# ADR 0006: Unit Master Management & Document-Level Client Snapshotting

## Status
**ACCEPTED / FROZEN** (Core Baseline)

## Context
1. **Unit Consistency & Flexibility:**
   Previous versions hardcoded measurement units across the frontend and backend. Businesses require customizable measurement units (e.g., meters `m`, pieces `PCS`, project `Project`, units `unit`, weight `KG`, time `Hours`), the ability to manage active units, and ensure historical documents never break when units are later deactivated or edited.
2. **Client Information Requirements & Fast Autofill:**
   In real-world billing, clients do not always have an email address or fixed phone number upfront (e.g., counter sales, physical delivery). Forcing email/phone as mandatory fields impedes fast data entry. However, when selecting an existing saved client, all known details (name, email, phone, GSTIN, place of supply, billing/shipping address) must auto-populate immediately without requiring manual re-entry.
3. **Document-Level Snapshot Integrity:**
   If invoice client fields dynamically joined to Client Master, subsequent updates to a client's legal address or tax status would silently corrupt historical invoices, violating legal compliance.

## Decision
1. **Unit Master Domain & Isolation:**
   - Dedicated `Unit` model in database with unique `symbol` constraint (`@unique @db.VarChar(30)`).
   - Dynamic `/api/units/active` service and `/units` management UI for administrators to activate, deactivate, add, and edit units.
   - Editor dropdown loads active units dynamically from Unit Master.
   - `InvoiceItem.unit` stores an immutable string snapshot. Deactivating or editing a unit in Unit Master never mutates historical documents.
2. **Client Optional Contact Fields:**
   - Client / Business Name is **REQUIRED**.
   - Email Address is **OPTIONAL** (empty string / null allowed; strict RFC 5322 regex validation applies only when provided).
   - Phone Number is **OPTIONAL** (empty string / null allowed; E.164 / Indian phone regex applies only when provided).
   - UI reflects optionality with clear placeholders and zero incorrect `*` asterisks.
3. **Saved Client Autofill & Document Snapshot:**
   - Selecting a client from "Choose Saved Client" immediately populates all document fields via client-side DOM events (zero page reload).
   - The user retains the freedom to edit the populated values for document-specific requirements.
   - A non-intrusive badge (`Document-level client snapshot`) indicates to the operator that saved values belong exclusively to the document's immutable snapshot.

## Consequences
### Positive
- Flexible measurement unit catalog supporting industrial, service, and commodity billing.
- Fast, frictionless data entry when customer contact details are partial or unavailable.
- Rapid client auto-fill saves time while preserving document-level snapshot isolation.
- Complete auditability and legal compliance for past invoices.

### Negative / Trade-offs
- Slight denormalization across `invoices` (`clientName`, `clientEmail`, `clientPhone`, `billingAddress`, `shippingAddress`).

## What Future Developers Must Not Casually Reverse
1. **Never make email or phone mandatory** on client models or document creation unless business rules explicitly mandate it.
2. **Never replace document client snapshot fields with dynamic foreign-key joins.** Historical documents must remain strictly immutable.
3. **Never hardcode units** back into frontend scripts; always load from Unit Master.
