# Shared component theme — 20 October 2026

The supplied `spark-admin-1.0.0__.zip` is the design reference: forest primary `#072F1F`, lime accent `#B4F105`, neutral surfaces, 10–18px component corners and quiet table headers. Existing page layout, navigation geometry and glass panels are retained.

`assets/css/premium-refresh.css` owns the shared Bootstrap component skin for tables/DataTables, buttons, controls, checkboxes, switches and modals. Conflicting older modal/table/form rules were removed, select menus use the same tokens, and button pill utilities were removed from 18 templates. Semantic danger/success colors remain distinct. Print document templates keep their own document design.

The record modal uses Bootstrap grid fields, readable status badges, associated labels and a proper form-switch control. Existing saves, role checks, concurrency protection and history are retained.

Organizations → Edit now updates display and legal names. Editing is restricted to platform administrators or active organization OWNER/ADMIN memberships. Name/profile synchronization and change history commit in one transaction; unrelated contact and banking details remain untouched. Changes refresh the organization switcher and workspace branding. Stale forms return a conflict instead of overwriting newer names.

Verification uses the separate synthetic audit database, DOM tests that execute the actual scripts, EJS compilation and CSS parsing. The browser permission gate previously declined access to the audit application, so authenticated pixel-level desktop/mobile comparison remains unverified.
