# ADR 0007: Server-Authoritative RBAC Hierarchy, Delegation Boundary, and Immutable Audit Logging

## Status
Accepted

## Date
2026-10-03

## Context
As Spark Admin scales from single-user operations to multi-user collaborative enterprise administration, the application requires fine-grained access control across Commercial, Catalog, Financial, and System domains.

Earlier milestones introduced basic authentication and initial role indicators. However, the application needed to address critical security imperatives:
1. Preventing horizontal and vertical self-privilege escalation (e.g., a user with `TEAM.MANAGE` elevating themselves to `OWNER` or `ADMIN`).
2. Enforcing delegation boundaries (preventing managers from delegating permissions they do not themselves possess).
3. Protecting system continuity by preventing the deactivation, demotion, or deletion of the last active Organization Owner or last Administrator.
4. Ensuring audit events use explicit, semantic action types rather than generic labels, and are recorded atomically with mutations while strictly sanitizing sensitive credentials.

## Decisions

1. **Explicit Actor vs. Target Hierarchy:**
   - Hierarchy is structured as `OWNER > ADMIN > STAFF / VIEWER`.
   - Only active `OWNER` users can create, modify, or demote an `OWNER`.
   - `ADMIN` users can manage `STAFF` and `VIEWER` users but cannot assign `OWNER` or modify `OWNER` records.
   - Self-modification of roles, custom permissions, or account deactivation is rejected with HTTP 403 Forbidden.

2. **Delegation Boundary Ceilings:**
   - When assigning roles or custom user permissions, non-owner administrators cannot grant any permission that they themselves do not possess.
   - If an Admin attempts to grant `TEAM:DELETE` without holding `TEAM:DELETE`, the operation is rejected.

3. **Last-Administrator Invariant:**
   - The last active `OWNER` cannot be deactivated, demoted, or deleted.
   - The last active holder of `TEAM.MANAGE` cannot be deactivated, deleted, or stripped of `TEAM.MANAGE`.

4. **Cryptographic Single-Use Invitations:**
   - Invitations use a cryptographically secure 32-byte token generated with `crypto.randomBytes(32)`.
   - The database only stores a SHA-256 hash (`tokenHash`).
   - Tokens are single-use, subject to expiration (7 days), and can be revoked.
   - Resending an invitation invalidates prior tokens immediately.

5. **Semantic & Atomic Activity Logging:**
   - Real operational events (`CREATE_USER`, `INVITATION_CREATED`, `ASSIGN_ROLE`, `CHANGE_PERMISSIONS`, `ACTIVATE_USER`, `DEACTIVATE_USER`, `DELETE_USER`) are logged inside the same database transaction (`tx`) as the entity mutation.
   - Automated sanitization redacts passwords, bcrypt hashes, raw tokens, session cookies, and secrets before persisting to `user_activity_logs`.

6. **Test Concurrency Architecture:**
   - Node 24 test runner executes integration test files with `--test-concurrency=1` to prevent database connection pool exhaustion on MariaDB/MySQL.

## Consequences

- **Positive:** Comprehensive defense-in-depth against privilege escalation, complete regulatory compliance for financial and administrative audits, zero secret leakage in logs, deterministic test runner lifecycle without socket hangs.
- **Negative:** Requires careful attention when bootstrapping replacement administrators (a second administrator must be activated before the existing administrator can be demoted or deactivated).
