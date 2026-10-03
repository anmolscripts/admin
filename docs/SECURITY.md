# Security Architecture & Production Hardening

## 1. Threat Model & Defenses

Spark Admin operates in financial and commercial environments where authenticity, authorization, and audit integrity are paramount.

```
Incoming Request
      │
      ├─► Security Headers (OWASP recommendations, frame busting)
      ├─► Reverse Proxy Verification (`trust proxy`)
      ├─► Rate Limiting (IP sliding window for auth & mutations)
      ├─► Session Verification (Signed, HttpOnly, Lax cookies)
      ├─► CSRF Validation (Synchronizer token pattern)
      ├─► Input Validation & Parameter Coercion
      ├─► Parameterized Persistence (Prisma ORM SQL injection defense)
      └─► Output Encoding (EJS HTML escaping against XSS)
```

---

## 2. Authentication & Credential Storage

### 2.1. Salted Password Hashing
- User passwords are encrypted using `bcrypt` with a cost factor of **12 rounds**.
- Passwords are never logged, echoed in API responses, or retained in plain text.

### 2.2. Timing Attack Mitigation
To prevent user enumeration via response latency differences between existing and nonexistent accounts:
- If a login attempt targets an unknown email address, `auth.service.js` executes a simulated `bcrypt.compare()` against a pre-computed dummy hash.
- This ensures response time is identical regardless of whether an email exists in the database.

---

## 3. Session Security & Cookie Protection

- **Cookie Name:** `spark.sid`
- **Signing:** Cookies are signed with `SESSION_SECRET` to prevent tampering.
- **Attributes:**
  - `httpOnly: true`: Neutralizes client-side JavaScript access via `document.cookie` (XSS mitigation).
  - `sameSite: 'lax'`: Protects against cross-site request forgery during cross-origin navigations.
  - `secure: true`: Enforced automatically in `production` environments to ensure cookies travel exclusively over HTTPS.

---

## 4. CSRF Defense Architecture

Mutating operations (`POST`, `PUT`, `DELETE`, `PATCH`) require a synchronizer CSRF token:
- On session initialization, a cryptographically random token is generated and attached to `req.session.csrfToken`.
- Web forms output this token via `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`.
- Asynchronous API calls transmit this token via the `x-csrf-token` HTTP header.
- Mutating requests failing CSRF validation are rejected with HTTP 403 Forbidden.

---

## 5. Rate Limiting

In-memory rate limiters protect the application against brute-force attacks and abuse:
- **Authentication Limiter (`loginRateLimiter`):** Restricts failed login attempts to a maximum of 10 requests per 15-minute sliding window per IP.
- **API Limiter (`apiMutationRateLimiter`):** Restricts high-frequency write operations to 100 requests per minute per IP.

---

## 6. HTTP Headers & Reverse Proxy Trust

Configured in `app/app.js`:
- `app.set('trust proxy', 1)`: Accurately identifies client IP behind Nginx/Cloudflare reverse proxies.
- `X-Content-Type-Options: nosniff`: Prevents MIME-type sniffing.
- `X-Frame-Options: SAMEORIGIN`: Prevents clickjacking by practical iframe sandboxing.
- `Referrer-Policy: strict-origin-when-cross-origin`: Restricts referrer data leakage.

---

## 7. Role-Based Access Control (RBAC) & Privilege Boundaries

Spark Admin implements strict multi-tier Role-Based Access Control with defense-in-depth protections:

### 7.1. Actor / Target Role Hierarchy
Roles are ordered strictly: `OWNER (5) > ADMIN (4) > MANAGER (3) > MEMBER (2) > VIEWER (1)`.
- A user can only manage or invite users with a strictly lower hierarchy level (`actorRank > targetRank`).
- Non-`OWNER` users can never create, promote, modify, deactivate, or delete an `OWNER` or peer-level account.

### 7.2. Self-Privilege Escalation & Self-Modification Protections
To prevent insider threat escalation and account lockouts:
- Users are strictly prohibited from changing their own role, assigned permissions, or activation status.
- Attempts by any user to modify their own account via administrative endpoints trigger an immediate HTTP `403 Forbidden` response.

### 7.3. Privilege Delegation Boundaries
- Non-`OWNER` administrators or managers cannot grant, invite, or assign any permission that they do not personally possess.
- For example, an `ADMIN` cannot grant `SETTINGS:DELETE` or `TEAM:DELETE` to another user if their own role lacks that permission.

### 7.4. Last Active Administrator Protections
- The system prevents deactivating, demoting, or deleting the last remaining active `OWNER`.
- The system prevents deactivating, demoting, or deleting the last active user who holds `TEAM:MANAGE` permissions.
- This guarantees the system cannot be left in an unadministered or locked-out state.

---

## 8. Audit Trail & Sensitive Data Sanitization

All significant mutations generate append-only logs in `user_activity_logs`:
- **Atomic Operations:** Activity logging occurs within the same database transaction (`tx`) as the operation itself, ensuring no phantom logs or orphaned mutations.
- **Sensitive Field Scrubbing:** Passwords, password hashes, reset tokens, invitation token secrets, session IDs, authorization headers, and payment secrets are strictly sanitized prior to persisting log metadata.
- **Append-Only Immutability:** Activity logs contain no `UPDATE` or `DELETE` endpoints, guaranteeing non-repudiation for audit inspections.

---

## 9. Automated Testing & Credential Governance

- **Zero Hardcoded Credentials:** Automated tests and browser end-to-end scripts strictly read administrative credentials from environment variables (`TEST_ADMIN_PASSWORD` or `SEED_ADMIN_PASSWORD`).
- **Fail-Fast Enforcement:** Scripts fail immediately with descriptive errors if credentials are not provided via environment variables, preventing fallback to insecure hardcoded defaults.
- **Git Hygiene:** Local configuration files (`.env`, `.env.production`) and secret tokens are strictly excluded by `.gitignore`.

---

## 10. Input Limits & Error Sanitization

- **Body Parser Limits:** JSON and form payloads are capped at 10MB to prevent denial-of-service memory exhaustion.
- **Error Sanitization:** In `NODE_ENV=production`, internal database errors and stack traces are suppressed from client responses. Clients receive clean, actionable error messages.

---

## 11. Known Horizontal Scaling Limitations

> **IMPORTANT ARCHITECTURAL ADVISORY:**
> The current baseline is engineered for **Single-Process VPS Deployments**.
>
> 1. **In-Memory Session Store (`MemoryStore`):** Sessions exist in the Node.js process memory. In a multi-instance or clustered environment (e.g., PM2 cluster mode or Kubernetes multi-pod), sessions will not be shared across processes, causing random logouts.
> 2. **In-Memory Rate Limiting:** Rate limit counters are process-local. Multiple instances will not share rate limit state.
>
> **Recommended Transition for Multi-Instance Deployments:**
> When scaling horizontally across multiple Node.js instances:
> - Replace `MemoryStore` with `connect-redis` backed by a managed Redis cluster.
> - Replace in-memory rate limiting with Redis-backed rate limiting (`rate-limiter-flexible`).
