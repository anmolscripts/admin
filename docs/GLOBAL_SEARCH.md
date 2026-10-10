# Spark Admin — Universal Global Search & Command Palette

Spark Admin includes a fast, permission-aware Universal Global Search and Command Palette accessible on every authenticated screen.

---

## 1. User Experience & Keyboard Shortcuts

- **Open Command Palette**: Press `Ctrl + K` (Windows/Linux) or `Cmd + K` (macOS).
- **Direct Input**: Click on the search bar in the top navbar or click the search magnifying glass icon.
- **Arrow Navigation**: Use `Up` (`↑`) and `Down` (`↓`) arrow keys to highlight results.
- **Select / Open**: Press `Enter` to navigate directly to the highlighted record or page.
- **Dismiss**: Press `Escape` or click anywhere outside the dropdown.

---

## 2. Indexed Entities & Search Scope

Global search queries across multiple business entities and navigation endpoints simultaneously, grouping results logically:

| Category | Searchable Attributes | Destination |
| :--- | :--- | :--- |
| **Commands & Pages** | Route title, keywords, descriptions (e.g., "Ledger", "Settings", "New Invoice") | Respective web route |
| **Invoices & Quotes** | Document Number, Client Name, PO Reference, Status | `/documents/:id` |
| **Clients** | Client Name, Email, Phone, GSTIN | `/clients/:id` |
| **Credit & Debit Notes** | Note Number, Client Name, Reason, Status | `/credit-debit-notes/:id` |
| **Item Master** | Item Name, SKU, Description, HSN/SAC code | `/items` |
| **Unit Master** | Unit Name, Unit Symbol | `/units` |
| **Chart of Accounts** | Account Code, Account Name, Account Type | `/reports/general-ledger` |
| **Financial Years** | Year Code / Label (e.g., "FY 2025-26") | `/financial-years` |
| **Team Members** | User Full Name, Email | `/team` |

---

## 3. Security & Permission Enforcement (RBAC)

1. **Server-Side Enforcement**: Search results are filtered dynamically based on the requesting user's active permissions (`session.permissions` / `rbac.service.js`).
   - If a user lacks `DOCUMENT_VIEW`, no invoices or quotations are returned.
   - If a user lacks `CLIENT_VIEW`, clients are omitted.
   - If a user lacks `USER_VIEW`, team members are omitted.
2. **Read-Only API**: `GET /api/search` is strictly read-only and idempotent.
3. **Authentication Required**: Unauthenticated requests to `/api/search` receive `401 Unauthorized`.
4. **Input Sanitization**: Query inputs are trimmed, limited to safe lengths (min 2, max 100 characters), and parameterised via Prisma ORM queries to prevent SQL injection.
5. **Debouncing & Race Condition Guard**: Client-side queries are debounced at 250ms and tracked using `AbortController` so slow responses cannot overwrite newer search queries.

---

## 4. Troubleshooting Search

- **No Results Shown**: Verify minimum query length is at least 2 characters.
- **Missing Invoices / Clients**: Confirm that the user has been granted the necessary permissions in `/team`.
- **Keyboard Shortcut Not Working**: Ensure the cursor is not focused inside a textarea where native hotkeys take precedence.
