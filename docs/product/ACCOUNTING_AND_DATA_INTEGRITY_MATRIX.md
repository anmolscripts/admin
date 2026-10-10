# ACCOUNTING_AND_DATA_INTEGRITY_MATRIX.md

## Accounting Operations – Data Flow & Integrity

| Operation | User Action | Validation / Business Rule | DB Transaction (Prisma) | Journal Effect | Report Effect | Audit Trail |
|-----------|-------------|---------------------------|------------------------|----------------|--------------|------------|
| **Create Invoice** | Fill invoice form, submit | Required fields, GSTIN format, total > 0 | `prisma.invoice.create` + `prisma.journal.create` (debit Accounts Receivable, credit Sales) | New journal entries posted, immutable | Invoice appears in **Trial Balance**, **Aging** reports | Record created in `audit` table with actor, timestamp, payload |
| **Post Invoice** | Click *Post* button | Invoice status `DRAFT` → `POSTED`, fiscal year open | Update invoice status, create posting journal entries (tax, revenue) | Journal entries linked to invoice, `postedAt` timestamp | Revenue recognized in **P&L**, GST collected in **Tax** report | Audit entry for posting action |
| **Create Credit Note** | Select invoice, enter credit details | Credit amount ≤ original invoice amount, same customer | `prisma.creditNote.create` + reversal journal entries | Reversal entries offset original invoice journals | Adjusts **Accounts Receivable** balance, reflected in **Customer Statement** | Audit log of credit note creation |
| **Receive Payment** | Record payment against invoice | Payment amount ≤ outstanding, payment method valid | `prisma.payment.create` + journal entry (debit Cash, credit Accounts Receivable) | Cash increase, receivable decrease | Cash flow report updated, outstanding balances reduced | Audit entry for payment |
| **Purchase Order** | Create PO, add line items | Supplier exists, tax codes validated | `prisma.purchaseOrder.create` + journal (debit Inventory, credit Accounts Payable) | Inventory increase, liability recorded | Purchase reports, inventory valuation updated | Audit of PO creation |
| **Expense Claim** | Submit expense, attach receipt | Expense type allowed, amount limits enforced | `prisma.expense.create` + journal (debit Expense, credit Cash/Bank) | Expense recognized, cash reduced | Expense reports, cost center allocation | Audit of expense claim |
| **Payroll Reimbursement** (basic) | Log employee reimbursement | Employee exists, reimbursement ≤ policy limit | `prisma.reimbursement.create` + journal (debit Expense, credit Cash) | Expense recorded, cash outflow | Payroll expense report | Audit entry |
| **Financial Year Close** | Initiate year‑end closing | All periods closed, no open journals | `prisma.financialYear.update` set `closedAt` | No further postings allowed for that year | Year‑end reports locked | Audit record of closure |

*All journal entries are created via the `Journal` service which enforces double‑entry invariants and immutable storage. Every action records an audit row with `entityId`, `action`, `userId`, `timestamp`, and a JSON snapshot of the changed data.*
