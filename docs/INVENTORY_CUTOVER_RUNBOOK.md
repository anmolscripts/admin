# Inventory cutover: foundation only

This release adds a read-only preflight and validation of a proposed per-business
configuration. It does not activate moving weighted average, change stock writes,
approve exceptions, grant permissions, or alter historical records. There are no
schema migrations. Existing businesses retain their existing operational behaviour;
the known lifetime-average valuation defect remains until the subsequent repair.

## Run the preflight

Use an operator-controlled environment file and a database account with SELECT-only
permissions. This foundation rejects protected database names, including production;
production inspection and activation require the subsequent reviewed rollout tooling.
An explicit environment file is required; no environment or database is inferred.

```
node scripts/inventory-cutover-preflight.js --help
node scripts/inventory-cutover-preflight.js --env .env.test --business all
node scripts/inventory-cutover-preflight.js --env .env.test --business 1 --plan PATH_TO_REVIEWED_PLAN.json
```

These commands have no interactive or mutation mode. Exit 0 means help displayed;
exit 1 means invalid arguments, configuration or a failed inspection; exit 2 means
inspection completed but activation is blocked. This foundation always blocks
activation, even when the numeric balances agree. Cancellation cannot apply a
cutover. Output contains financial information: store it with restricted access.

## Proposed configuration format

The JSON document contains `version: 1` and a `businesses` array. Each entry requires:

- `businessId`: unique positive integer.
- `effectiveDate`: explicitly approved real calendar date in `YYYY-MM-DD` form.
- `requestedById`, `approvedById`, `configuredById`: positive user IDs; requester
  and approver must differ.
- `approvedAt`, `configuredAt`: timestamps including timezone; configuration must
  not precede approval.
- `evidenceReference`: nonempty reference to the reviewed reconciliation/approval.
- `openingBalances`: every business item, including inactive items, with `itemId`,
  `quantity`, and `value`. Supply exact decimal strings with at most two places.

No operational date or opening valuation is supplied by this release. Business
timezone comes from the stored Business record. Approval fields are declarations
to review, not authenticated approval: this JSON is not a permission mechanism,
immutable approval store, or runtime activation configuration.

## Review exceptions before proposing activation

The report exposes recorded signed movement value, not a recalculation of historic
issue costs. It compares that value with inventory-account opening balances plus
posted and reversed journal lines. Negative/residual values are never clamped.
Opening plans are checked against the current snapshot, not an inferred historical
opening. Movements on/after a proposed effective date are flagged for review.

Resolve negative stock/value, residual value at zero quantity, invalid costs/signs,
unverified return origins, uncertain outward posting requirements, missing project
costs, missing receipt movements, foreign opening items and opening mismatches.
The all-business report also counts stock movements without a business assignment.

Receipt/bill matching is deliberately unverified: the schema has no reliable
receipt-to-bill allocation. All accepted receipts and non-void bills are listed for
review, including bills that may be non-inventory. Do not treat these entries as
proof of a missing document. Explain timing, price, tax and direct-expense differences
with source evidence. Equal aggregate values do not prove individual reconciliation.
Zero recorded costs may be intentional or missing: the source documents must decide.

## Required before enabling the approved policy

1. Implement the approved costing, transaction propagation, request idempotency,
   source-linked returns/reversals and authoritative reports with real DB tests.
2. Establish the business-date helper using stored Business.timeZone. Proposed
   chronology is effective date followed by immutable movement ID; it is not yet
   approved/enforced by this foundation. Do not infer intraday historical order
   from date-only storage or silently recost backdated entries.
3. Implement immutable configuration/approval persistence and audited current-dated
   corrections with server-verified membership and the dedicated permission
   `INVENTORY:COSTING_EXCEPTION:APPROVE`. Explicit reviewed grants only; no default
   administrator elevation. Require different requester/approver and complete
   before/after quantity/value, original date and source evidence.
4. Freeze relevant writes, rerun reconciliation, approve opening quantity/value
   and an explicit business-local cutover date, then record who configured it and
   when. Do not enable with unresolved exceptions. No historical rewrites.
5. Keep goods receipts physical-only and supplier bills responsible for acquisition
   recognition; do not add a second acquisition journal. Preserve explicit timing
   differences instead of pretending every receipt immediately equals GL inventory.
6. Verify post-cutover depletion/replacement (10 units worth 200), the approved 270
   average scenario, original-cost returns, exact paise conservation, atomic failure
   rollback, concurrency, permissions and report/GL/project parity. Retain historical
   snapshots. Run targeted tests and `npm run verify:all` before any reviewed rollout.

Rollback of this foundation is removal of its new service, command, tests and
documentation; it has no runtime hooks or database state to reverse. Later rollback
after real cutover must preserve new posted costs and needs its own reviewed plan.
