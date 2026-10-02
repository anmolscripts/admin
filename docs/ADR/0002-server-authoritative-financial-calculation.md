# ADR 0002: Server-Authoritative Financial & Tax Calculation

## Status
**ACCEPTED / FROZEN** (Core Baseline)

## Context
Web applications that allow client-side financial calculations are inherently vulnerable to:
1. Manipulation: Malicious or curious actors modifying DOM input values or crafting custom API payloads with distorted totals, zero taxes, or manipulated round-offs.
2. Floating-Point Drift: JavaScript `Number` represents numbers as IEEE 754 double-precision floats, leading to inaccuracies such as `0.1 + 0.2 = 0.30000000000000004`.
3. Statutory Non-Compliance: GST tax invoices require deterministic, half-up rounding rules that must match official accounting standards.

## Decision
We established a strict **Server-Authoritative Financial Calculation Engine** in `app/services/invoice.service.js`:

1. **Client as a Calculation Mirror Only:** Client-side JavaScript in `assets/js/editor.js` performs real-time calculations solely to provide instant visual feedback to the operator.
2. **Server Disregards Client Totals:** The API accepts only primitive input parameters: line items (quantity, unit rate, tax rate) and discount settings. The server ignores any client-supplied `subtotal`, `gstAmount`, or `grandTotal`.
3. **Integer Arithmetic with Half-Up Rounding:** All monetary figures are multiplied by 100, rounded using `Math.round()`, and stored in fixed-point MySQL `Decimal(12, 2)` columns.
4. **Authoritative GST Split:** Tax split (CGST + SGST vs. IGST) is determined by comparing supplier state code against client place of supply code on the server.

## Consequences
### Positive
- Total protection against monetary manipulation via developer tools or automated scripts.
- 100% mathematical consistency across web views, PDF exports, and database records.
- Zero floating-point rounding errors.

### Negative / Trade-offs
- Slight duplication of math formulas between `editor.js` (for UX preview) and `invoice.service.js` (for persistence).

## What Future Developers Must Not Casually Reverse
**Do NOT accept calculated financial totals from client request payloads.**
Never persist client-submitted `grandTotal`, `subtotal`, or `taxAmount` without server-side recalculation. The server must remain the sole legal authority on all numbers.
