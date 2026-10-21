# Stock transaction consistency — Phase 2

This phase preserves existing costing and posting choices. Moving average,
cutover activation, backdate enforcement and original-cost return/reversal
allocation are not enabled. The cutover preflight foundation is unchanged.

## Operation rules

| Operation | Quantity / recorded inventory value | Required journal | Required project cost | Atomic writes / owner |
| --- | --- | --- | --- | --- |
| Goods receipt | Accepted quantity and accepted recorded cost added | None: supplier bill recognises acquisition | None for tracked stock | Receipt header/lines, stock, PO status, numbering; goodsReceipt service |
| Inventory supplier bill | No physical movement | Dr Inventory Asset, Cr AP; existing tax rules | None for tracked stock | Existing bill/journal transaction; supplierBill service |
| Direct-expense supplier bill | No stock movement | Existing expense/AP journal | Existing direct project allocation | Existing bill/journal/project transaction; supplierBill service |
| Generic OPENING, RECEIPT, RETURN_IN, ISSUE, RETURN_OUT, ADJUSTMENT | Existing signed quantity and existing recorded cost | Only when explicitly requested with postToLedger=true and cost > 0 | None | Stock plus requested journal; stockMovement service |
| Project issue | Quantity/value reduced at existing issue cost | No new automatic journal | Positive material cost for nonzero recorded cost | Stock plus project cost; stockMovement and projectCostLedger services |
| Project return | Quantity/value increased at existing return cost | No new automatic journal | Negative material cost for nonzero recorded cost | Stock plus project credit; same services |
| Separate posting of an existing movement | No new movement | Existing posting request, once per movement | None | Journal, balances and numbering together; stockMovement/journal services |

Generic optional postings retain the existing account selection: outward Dr
requested debit account / Cr requested credit account, inward swapped. Defaults
remain COGS/Inventory Asset. This is not approval to use those defaults for every
opening, receipt, supplier return or adjustment. Do not post a second acquisition
for a receipt already recognised by its supplier bill. Zero-cost movements have
no journal or material-cost write under the existing convention.

The generic endpoint does not infer project-cost recognition from client-supplied
reference fields. The project page's Issue & Post Cost form now uses the dedicated
PROJECTS:COST_CREATE route; project returns use that route family too. Existing
route RBAC remains in place, and the transaction verifies active business access
and item/project ownership before writing or replaying a request.

## Transactions and retries

The shared stock transaction acquires the existing business row lock. Goods
receipts use the same business-before-PO lock order. Stock availability uses a
current locking read, including when a caller transaction has an older snapshot.
Required journal account checks, financial-year checks/creation, balances, project
costs and numbering use the same transaction. Journal validation errors propagate
out of caller-owned transactions; they cannot fall back to an independent commit.

Root stock operations retry at most three times for the existing supported
deadlock/serialization conflicts, with 25/50 ms waits. Numbering propagates these
conflicts when a transaction is supplied, so the entire operation retries. A caller
providing its own transaction owns its final commit and retry. Optional activity
telemetry remains best-effort; it is not the financial reconciliation authority.

## Request identity and compatibility

Generic stock and project routes accept `Idempotency-Key` or body `idempotencyKey`.
Supply a stable random key (8–100 permitted identifier characters) and reuse it
with the same payload after a timeout. The transaction locks the business before
checking the unique business/request key. It stores a SHA-256 fingerprint of the
operation, actor, item, project, quantity, cost/date intent and posting choices.
Changed requests return conflict; retries return the committed movement and its
requested journal without reposting costs. A request does not silently repair a
missing historical posting or reactivate a voided project cost.

Project forms retain the same key for unchanged payload retries while the page
remains open; changed inputs generate a new key. Refreshing the page loses that
form key. Integrations must persist their keys across reconnects/reloads. Legacy
requests without keys remain accepted for compatibility and cannot be deduplicated
after a lost response. Never retry them blindly: inspect existing movements first.
Goods receipts retain their existing request identity and gain whole-operation
transient retries. No acquisition journal is added there.

## Migration and rollback

`20261021000300_stock_request_identity` adds nullable requestKey/requestHash columns
and a business-scoped unique index to stock_movements. It does not update existing
movement values, journals or project costs. Deploy the reviewed additive migration
before this application version; old null keys remain valid. Migration was tested
only on disposable databases. No production upgrade or cutover is authorised.

For application rollback, retain the additive columns and request records. Do not
drop them or erase request keys: older code cannot guarantee replay safety. Never
remove posted records as rollback. Any eventual schema removal needs a separately
reviewed procedure preserving request/audit evidence.

## Reconciliation limits

Tests compare actual stored quantities, signed movement costs, journal totals,
account changes and project-cost amounts, including complete rollback of numbering
and financial-year creation. They separately identify unposted opening stock and
unbilled receipts as timing/opening differences. Balanced journals do not prove
inventory reconciliation.

Project issues/returns still have no automatic GL posting; generic stock posting
remains optional. Historical lifetime-average and return-cost discrepancies remain.
This phase cannot establish complete inventory/GL/project reconciliation or approve
cutover. The next phase needs source-linked return/reversal costing, the approved
moving-average engine, immutable approvals/configuration and backdate controls,
followed by a reviewed per-business reconciliation and explicit rollout date.
