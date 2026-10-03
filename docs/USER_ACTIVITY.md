# User Activity & Forensic Audit Log Architecture

## 1. Overview
Spark Admin includes an append-only, immutable User Activity Log stored in the `user_activity_logs` MySQL table. Every state-changing operational action, administrative modification, and security event is recorded with forensic traceability.

---

## 2. Core Architectural Guarantees

1. **Append-Only Immutability:**
   - Audit records cannot be edited, overwritten, or updated.
   - Database operations only perform `INSERT` operations on `user_activity_logs`.
2. **Transactional Atomicity:**
   - Where operations occur within a Prisma database transaction, the corresponding activity log is created within the same transaction (`tx`).
   - If the business mutation fails, the activity log rolls back with it, preventing phantom audit entries.
   - If the activity log insertion fails, the business mutation rolls back, preventing untraceable operations.
3. **Zero Secret Leakage Guarantee:**
   - The logging pipeline automatically sanitizes all payloads.
   - Passwords, plaintext tokens, token hashes, bcrypt strings, session IDs, and CSRF tokens are strictly redacted and never persisted into metadata.

---

## 3. Semantic Audit Events

Audit events use explicit, semantic action identifiers rather than generic display labels:

| Action Identifier | Module | Description | Metadata Captured |
| :--- | :--- | :--- | :--- |
| `CREATE_USER` | `TEAM` | Admin creates a team member | Target email, assigned role |
| `INVITATION_CREATED` | `TEAM` | Single-use invitation generated | Target email, token expiry timestamp |
| `INVITATION_ACCEPTED` | `AUTH` | Invitee completes password setup | Account activated timestamp |
| `INVITATION_RESENT` | `TEAM` | Fresh invitation token generated | New expiry timestamp |
| `INVITATION_REVOKED` | `TEAM` | Pending invitation cancelled | Revocation reason |
| `ASSIGN_ROLE` | `TEAM` | User role modified | `oldRole`, `newRole`, `oldRoleId`, `newRoleId` |
| `CHANGE_PERMISSIONS` | `TEAM` | Custom permissions updated | `changedPermissions`, `previousEffectivePermissions` |
| `ACTIVATE_USER` | `TEAM` | User account enabled | Target user ID & reference |
| `DEACTIVATE_USER` | `TEAM` | User account disabled | Reason / status change note |
| `DELETE_USER` | `TEAM` | User account deleted or soft-deactivated | Soft deactivation flag if historical docs exist |
| `PERMISSION_DENIED` | `SECURITY` | Access denied on protected route | Target URL, HTTP method, required permission |
| `LOGIN_SUCCESS` | `AUTH` | Successful user authentication | Session establishment |
| `LOGOUT` | `AUTH` | Session explicitly terminated | Session clearance |
| `CREATE_DOCUMENT` | `DOCUMENTS` | Invoice or Quotation generated | Document type, document number, total |
| `EDIT_DOCUMENT` | `DOCUMENTS` | Document modified | Document type, version |
| `PRINT_DOCUMENT` | `DOCUMENTS` | Document print view loaded | Document type, reference number |
| `VIEW_DOCUMENT` | `DOCUMENTS` | Document detail view inspected | Document type, reference number |
| `EXPORT_PDF` | `DOCUMENTS` | Document PDF exported | Document type, reference number |
| `EXPORT_EXCEL` | `DOCUMENTS` | Document catalog exported | Export format, item count |
| `RECORD_PAYMENT` | `PAYMENTS` | Payment credited against invoice | Amount, payment method, reference |
| `VOID_PAYMENT` | `PAYMENTS` | Payment revoked | Reversal reason, restored balance |

---

## 4. Metadata Schema & Sanitization

Each audit log entry captures:
- `actorUserId`: ID of the authenticated user performing the action (null for public self-service actions like invitation acceptance).
- `action`: Semantic action string in uppercase.
- `module`: Target functional domain.
- `targetType`: Entity type (`USER`, `INVOICE`, `QUOTATION`, `PAYMENT`, `ROUTE`).
- `targetId`: String identifier of target entity.
- `targetReference`: Human-readable identifier (e.g., `INV-2026-0001`, user email).
- `ipAddress`: Client IPv4/IPv6 address.
- `userAgent`: Client browser user agent string.
- `metadata`: JSON payload describing changes.

### Automated Sanitization:
The following keys are automatically redacted in `activity.service.js`:
- `password`
- `passwordhash`
- `token`
- `tokenhash`
- `secret`
- `cookie`
- `sessionid`
- `_csrf`
- `authorization`

---

## 5. Inspection & Analytics UI

1. **User Activity Directory (`/team/activity`):**
   - Filter by actor, module, action, date range, or free-text search.
   - Protected by `TEAM:ACTIVITY_VIEW` permission.
2. **Team Analytics Dashboard (`/team/analytics`):**
   - Aggregated monthly activity counts, action breakdowns, and security anomaly indicators.
   - Protected by `TEAM:ACTIVITY_VIEW` permission.
