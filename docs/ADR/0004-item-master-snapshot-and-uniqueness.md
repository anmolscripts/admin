# ADR 0004: Item Master Snapshot Isolation & Unique Identity

## Status
**ACCEPTED / FROZEN** (Core Baseline)

## Context
Businesses need a central catalog of standard products and services (Item Master) with default prices and tax codes to streamline invoice entry. However, two serious architectural hazards exist:
1. **Historical Corruption (Lack of Snapshotting):** If an invoice merely foreign-keys to an `items` table, updating an item's price next year retroactively changes the financial totals of all past issued invoices, violating commercial accounting laws.
2. **Catalog Duplication Under Concurrency:** When multiple operators enter documents simultaneously containing the same uncataloged item name, parallel `findFirst -> create` flows create duplicate catalog items.

## Decision
1. **Document Line Snapshot Isolation:**
   `InvoiceItem` rows snapshot item name, HSN/SAC code, unit, rate, and amount at the moment of document creation. Changes to `Item` records never mutate existing `InvoiceItem` records.
2. **Database-Level Unique Constraint:**
   `Item.name` has a strict unique constraint in MySQL:
   ```prisma
   model Item {
     name String @unique @db.VarChar(255)
     ...
   }
   ```
3. **Atomic Upserting:**
   When saving documents with new items, `item.service.js` uses atomic `upsert` or catch-conflict patterns to ensure concurrent saves cannot create duplicate records.

## Consequences
### Positive
- Historical accounting integrity is permanently preserved.
- Fast, debounced autocomplete with zero duplicate clutter.
- Catalog items can be safely deactivated or repriced without side effects.

### Negative / Trade-offs
- Slight denormalization on `InvoiceItem` tables.

## What Future Developers Must Not Casually Reverse
**Do NOT replace `InvoiceItem` snapshot columns with dynamic relational joins to `Item`.**
Historical invoice line items must remain strictly immutable snapshots.
