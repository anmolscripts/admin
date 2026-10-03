# Role-Based Access Control (RBAC) Architecture

## 1. Overview & Security Philosophy
Spark Admin implements an enterprise-grade, server-authoritative Role-Based Access Control (RBAC) framework designed to eliminate privilege escalation, protect administrative continuity, and prevent unauthorized horizontal and vertical access.

Access control is evaluated dynamically on the server:
- Frontend navigation and UI action buttons reflect granted permissions for ergonomic UX.
- All backend routes, API controllers, and domain services strictly enforce permissions and hierarchy checks independently of client state.

---

## 2. Actor vs. Target Hierarchy

The system establishes a strict hierarchical order across principals:

```
┌───────────────────────────────────────────────┐
│                    OWNER                      │
│     (Absolute authority, Root of Trust)       │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│                    ADMIN                      │
│      (Delegated operational administration)   │
└───────────────────────┬───────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────┐
│                 STAFF / VIEWER                │
│             (Operational end users)           │
└───────────────────────────────────────────────┘
```

### Hierarchy Rules
1. **OWNER Authority:**
   - Only an active **OWNER** can create, modify, demote, or deactivate another **OWNER**.
   - An OWNER can assign any system role (`OWNER`, `ADMIN`, `STAFF`, `VIEWER`) or custom role.
   - An OWNER possesses universal access to all modules and actions.

2. **ADMIN Authority:**
   - Administrators can manage users below the OWNER tier (`STAFF`, `VIEWER`, custom roles).
   - An ADMIN **cannot** modify, demote, or deactivate an OWNER.
   - An ADMIN **cannot** promote any user to OWNER or invite a new user with the OWNER role.
   - An ADMIN cannot modify another ADMIN unless permitted by explicit policy.

3. **STAFF & VIEWER Authority:**
   - Non-administrators cannot manage the team or modify user records unless granted explicit `TEAM:MANAGE` permission.

---

## 3. Delegation Boundaries & Privilege Ceiling

To prevent vertical privilege escalation:
- **No Manager Can Grant What They Do Not Possess:**
  When an actor assigns a role or custom user permissions to a target, the actor's own effective permissions serve as an absolute ceiling.
  - If Actor does not possess `TEAM:DELETE`, they cannot grant `TEAM:DELETE` to another user.
  - If Actor does not possess `DOCUMENTS:VOID`, they cannot assign a role or custom permission containing `DOCUMENTS:VOID`.
- Only an active **OWNER** is exempt from delegation boundary ceilings.

---

## 4. Self-Modification Restrictions

Even when a user possesses `TEAM:MANAGE`:
1. **Self-Role Modification Blocked:** A user cannot change their own role (e.g., Staff manager promoting themselves to Admin or Owner). Attempts return HTTP 403 Forbidden.
2. **Self-Permission Modification Blocked:** A user cannot grant themselves additional permissions or remove restrictions from their own account. Attempts return HTTP 403 Forbidden.
3. **Self-Deactivation / Self-Deletion Blocked:** A user cannot deactivate or delete their own account via team management endpoints. Attempts return HTTP 403 Forbidden.

---

## 5. Continuity Safeguards (Last Administrator Invariants)

The application enforces automated safeguards to prevent accidental administrative lockout:

1. **Last Active OWNER Protection:**
   - The final active user holding the `OWNER` role cannot be deactivated, demoted, or deleted.
   - A replacement OWNER must be created and activated before the existing OWNER can step down.

2. **Last Active Administrator Protection:**
   - The final active user holding effective `TEAM:MANAGE` permissions cannot be deactivated, deleted, or stripped of `TEAM:MANAGE`.
   - The system checks the resulting active administrator count before executing status or permission changes. Unsafe mutations are rejected with HTTP 403 Forbidden.

---

## 6. Permissions Taxonomy

Permissions are represented as canonical `MODULE:ACTION` pairs:

| Module | Allowed Actions | Description |
| :--- | :--- | :--- |
| `DASHBOARD` | `VIEW`, `FULL_ACCESS` | Executive KPI analytics & commercial metrics |
| `DOCUMENTS` | `VIEW`, `CREATE`, `EDIT`, `DELETE`, `RESTORE`, `VOID`, `CONVERT`, `EXPORT`, `PRINT`, `MANAGE`, `FULL_ACCESS` | Quotations and Invoices lifecycle operations |
| `CLIENTS` | `VIEW`, `CREATE`, `EDIT`, `DELETE`, `MANAGE`, `FULL_ACCESS` | Customer master directory and GSTIN management |
| `ITEMS` | `VIEW`, `CREATE`, `EDIT`, `DELETE`, `MANAGE`, `FULL_ACCESS` | Product/Service catalog management |
| `UNITS` | `VIEW`, `CREATE`, `EDIT`, `DELETE`, `MANAGE`, `FULL_ACCESS` | Measurement units catalog |
| `PAYMENTS` | `VIEW`, `CREATE`, `EDIT`, `VOID`, `MANAGE`, `FULL_ACCESS` | Payment recordings and reversals |
| `BUSINESS_PROFILE` | `VIEW`, `EDIT`, `MANAGE`, `FULL_ACCESS` | Organization legal details, GST defaults, and terms |
| `TEAM` | `VIEW`, `CREATE`, `EDIT`, `DELETE`, `MANAGE`, `ACTIVITY_VIEW`, `FULL_ACCESS` | User management and security oversight |
| `AUDIT_LOGS` | `VIEW`, `EXPORT`, `MANAGE`, `FULL_ACCESS` | System audit log inspection |
| `SETTINGS` | `VIEW`, `EDIT`, `MANAGE`, `FULL_ACCESS` | System configuration |

### Specific Team Permissions:
- `TEAM:VIEW`: Access `/team` directory, search team members, inspect public profiles.
- `TEAM:MANAGE`: Invite new team members, edit roles, toggle active status, manage custom permissions (subject to hierarchy and delegation boundaries).
- `TEAM:ACTIVITY_VIEW`: Access `/team/activity` and `/team/analytics`, review forensic user audit trails.

---

## 7. Default System Roles

1. **OWNER (`isSystem: true`):**
   - Universal authority across all modules and actions.
   - Root of trust for user delegation.
2. **ADMIN (`isSystem: true`):**
   - Full operational administration across documents, clients, catalog, business profile, and team members.
   - Restrained from `TEAM:DELETE` and `SETTINGS:DELETE` by default to preserve audit trails and prevent destructive administrative destruction.
3. **STAFF (`isSystem: false`):**
   - Commercial operations: viewing/creating/editing documents, managing clients, recording payments.
4. **VIEWER (`isSystem: false`):**
   - Read-only visibility across documents, clients, items, and units.

---

## 8. Runtime Architecture & Caching

1. **Resolution Pipeline:**
   - In Express middleware, `attachUserPermissions` resolves user effective permissions and stores them on `req.userPermissions` and `res.locals.userPermissions`.
   - `requirePermission(module, action)` middleware guards sensitive routes.
2. **In-Memory Cache:**
   - Permissions are cached with a 60-second TTL in `rbac.service.js`.
   - Any mutation to a user's role, custom permissions, or account status triggers immediate targeted cache invalidation via `rbacService.invalidateUser(userId)`.
   - Global role updates trigger `rbacService.invalidateAll()`.
