# ADR 0003: Single Shared Template for Print and PDF Rendering

## Status
**ACCEPTED / FROZEN** (Core Baseline)

## Context
In many invoice systems, HTML printing and PDF downloads are developed independently:
- Print view uses HTML/CSS rendered in the browser.
- PDF generation uses a programmatic canvas library (like PDFKit) with hardcoded X/Y coordinate drawing commands.

Over time, this dual-engine approach always results in:
1. **Visual Divergence:** Margins, fonts, tables, bank remittance sections, and watermarks look different in the print dialog versus the downloaded PDF.
2. **Maintenance Overhead:** Every design tweak, company rebranding, or regulatory disclosure change must be implemented and tested twice.
3. **Bug Multiplications:** Bug fixes applied to the HTML template are forgotten in the PDFKit generator, creating subtle customer-facing discrepancies.

## Decision
We mandate a **Single Presentation Source** architecture:

```
Database Document Record
          │
          ▼
buildDocumentViewModel()     [app/services/documentView.service.js]
          │
          ▼
templates/document.ejs       [app/views/documents/templates/document.ejs]
     ├─────────────────────────────┐
     ▼                             ▼
HTML Print View               Headless Chromium CLI
(/documents/:id/print)        (/api/invoices/:id/pdf)
                                   │
                                   ▼
                              Binary PDF
```

1. **One View Model:** `documentView.service.js` produces a normalized, sanitized view model consumed by both presentation pathways.
2. **One EJS Template:** `app/views/documents/templates/document.ejs` defines the sole HTML markup for both Print and PDF.
3. **Headless Browser Execution:** `app/services/pdf.service.js` renders the shared HTML template using installed Google Chrome, Chromium, or Microsoft Edge CLI flags (`--headless`, `--print-to-pdf`).
4. **Controlled Failure:** If the browser executable is missing, the service raises `PdfConfigurationError` rather than falling back to a divergent secondary renderer.

## Consequences
### Positive
- Guaranteed 100% pixel-level visual and content parity between browser print and downloaded PDF.
- A single location to update branding, typography, tables, and tax summaries.
- PDFKit markup layout completely eliminated from the production path.

### Negative / Trade-offs
- Requires Google Chrome, Chromium, or Edge to be installed on the deployment host.

## What Future Developers Must Not Casually Reverse
**Do NOT reintroduce a separate PDFKit or canvas layout engine for PDF generation.**
All visual presentation changes must be made exclusively inside `app/views/documents/templates/document.ejs`.
