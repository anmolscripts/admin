# Letters

Open **Documents → Letters** or **New → New Letter**. Letters are independent, non-financial correspondence and never create invoice balances, GST calculations, stock movements or journal entries.

Enter the recipient, subject, date and optional address. Choose any available invoice/quotation template; the initial choice follows the active invoice template. The rich text editor supports headings, fonts, emphasis, lists, alignment, links, undo/redo and explicit page breaks. Long content flows across A4 pages. Preview is unsaved; saving allocates an atomic, organization-scoped `LTR/YYYY/MM/N` reference.

The saved letter provides PDF, Excel and browser print exports. PDF and print use the same document template, branding and pagination source. Letterhead and contact footers repeat on continuation pages. Excel contains reference data and plain letter text; list export follows the search/status filter and is limited to 500 matching records.

Active letters can be edited. Copy opens an unsaved new letter and assigns a fresh reference on save. Void makes correspondence read-only. Delete is recoverable, with full content/history retained; restore returns a previously voided letter to VOID. Reasons are mandatory for status actions. Every successful save/action records an immutable version snapshot and an activity entry in the same transaction. Stale updates return 409.

All routes use existing DOCUMENTS permissions: VIEW, CREATE, EDIT, VOID, DELETE, RESTORE, PRINT and EXPORT. All reads and writes enforce the active organization. State-changing routes require CSRF protection. Server-side HTML sanitization excludes scripts, embedded images/videos, remote assets, event handlers, unsafe links and arbitrary CSS. Formatted content is limited to 200 KB. The migration only adds `letters` and `letter_revisions`; existing tables and records are not rewritten.

Validation runs against a separate `ui_audit_*` database. The tests exercise rich text/page-break round trips, sanitization, tenant boundaries, concurrent edits, lifecycle history, CSRF, role restrictions, template reuse and multi-page PDF/Excel exports. Physical-device coverage is separate from browser viewport checks.
