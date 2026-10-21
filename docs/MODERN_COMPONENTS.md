# Shared components and financial periods

The component layer in `assets/css/components.css` keeps the existing page layout and glass surfaces. It provides forest/lime theme states, stronger table and button hover feedback, visible keyboard focus, dark dialogs, consistent modal spacing, and reduced-motion skeletons.

Profile photos show a local preview before upload, reject unsupported/oversized selections, and allow undoing the selection. Saving retains the existing bounded upload, CSRF, signature checks and failed-save cleanup.

Theme initialization follows the device when `spark-theme` has no explicit light/dark value. The toggle stores the user's choice; later device changes do not override it. Authentication pages use the same initial preference.

The reporting-period bar is separate from page headings. It supports a start FY, an end FY, and unrestricted custom dates. Transaction lists default to the current FY; changing ordinary filters or server pagination retains the chosen period. Financial Years uses the control to open the reporting workbench. Profile, settings and master-data screens omit unrelated reporting filters. Dashboard quick ranges remain available.

The current Indian financial year (1 April–31 March) is ensured on authenticated business-page access. Each transaction continues to use its own transaction date to resolve its FY. At rollover the first page access or transaction creates the needed year without a manual setup step. The current marker is scoped to the business. Historical closed years remain closed; rollover never posts closing journals automatically. Year closing chronology checks and FY route access are scoped to the business.

Custom-template creation opens the correct dialog, preserves base layout, colors and toggles, and prevents duplicate save submissions. Empty charts display an action rather than empty axes. Document tables, dashboard refreshes and record dialogs show skeletons during real requests.

SweetAlert2 displays errors with safe text, with inline form errors retained. Failed JSON responses include an `X-Request-ID` / `requestId` reference. Daily JSONL error logs are stored in persistent `data/logs/errors-YYYY-MM-DD.jsonl`. They record route, status, actor/business IDs and diagnostic frames, excluding request bodies, query strings, cookies and uploaded content. Logs require the same restricted filesystem access as other server data.

Financial rollover and historical-period tests must run in the isolated `ui_audit_*` database. They must never be pointed at a production database.
