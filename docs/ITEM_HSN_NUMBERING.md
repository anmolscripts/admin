# Item Master HSN/SAC allocation

HSN/SAC values are unique within each business. Creating an item without a code,
or supplying a code already used by another item in that business, allocates the
next available number from 1000 through 999999. The same rule applies to explicit
HSN edits, CSV/XLSX imports, and new catalog items saved from documents.
Unused supplied codes, including leading zeroes, remain unchanged. Existing
document snapshots are never rewritten to match a new catalog code.

The persistent `ITEM_HSN` entry in `numbering_sequences` uses year/month zero:
the sequence does not reset each month. Allocation and item writes share a
transaction and business lock. Exhaustion rejects the write and rolls back the
sequence. A unique database index also protects writes outside the service.

Before upgrading an existing installation, check for duplicates:

```sql
SELECT businessId, hsnSac, COUNT(*) AS copies
FROM items
WHERE businessId IS NOT NULL AND hsnSac IS NOT NULL
GROUP BY businessId, hsnSac
HAVING COUNT(*) > 1;
```

The migration adds only the unique index. It deliberately fails on existing
duplicates instead of changing historical catalog data. Review any duplicates
before upgrading. Legacy null codes are not backfilled; new items always receive
a code. Generated values follow the requested catalog numbering policy and do
not validate tax classification.
