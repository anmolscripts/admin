# Form and component audit — 20 October 2026

The shared page header can now be disabled by pages that already supply their own title. List, editor and detail pages use one page title without changing their content layout.

Shared controls use 38 px standard height and 34 px compact height. GET filter forms align their controls at 38 px, with larger touch targets on coarse pointers. Tom Select respects compact Bootstrap classes outside tables too.

Profile uploads are parsed in bounded memory before the route validates multipart CSRF fields. No image reaches disk before CSRF, profile-field and image-signature validation. A failed database save retains the previous image and removes the new staged file. Profile forms display AJAX errors inline and re-enable their save buttons. HTTP error pages show the actual 4xx status instead of always displaying 500.

Supplier-bill create and void requests now include CSRF tokens and handle HTTP failures. Quantity zero is validated instead of silently becoming one. Additional list tables use the shared DataTable component; server-paginated lists keep their server pager and search only loaded records. Non-paginated DataTables no longer silently truncate loaded rows.

Regression coverage includes native multipart upload, missing CSRF, fake images, oversized files, failed avatar persistence, one title on 19 authenticated routes, server-paged table rendering, profile AJAX errors, and real supplier-bill create/void HTTP requests. Tests run against a separate synthetic database. Production financial records and passwords are not modified for browser testing.

Validation: 941 tests passed, with no failures or skipped tests. Authenticated live-browser checks confirmed single titles on purchase orders, suppliers and profile; working purchase filtering; client details, edit controls, cancel and history; and equal 38 px purchase filter controls. Public health returned 200 and all four changed shared assets matched the source hashes. Deployment preserved row counts in all 54 business tables. Browser screenshot capture was unavailable, so mobile and pixel-level visual review remain unverified.

This is a targeted audit and regression suite, not a claim that every possible workflow or permission combination is bug-free.
