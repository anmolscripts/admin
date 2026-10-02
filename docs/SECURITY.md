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
- `X-Frame-Options: SAMEORIGIN`: Prevents clickjacking by restricting embedding in third-party iframes.
- `Referrer-Policy: strict-origin-when-cross-origin`: Restricts referrer data leakage.

---

## 7. Input Limits & Error Sanitization

- **Body Parser Limits:** JSON and form payloads are capped at 10MB to prevent denial-of-service memory exhaustion.
- **Error Sanitization:** In `NODE_ENV=production`, internal database errors and stack traces are suppressed from client responses. Clients receive clean, actionable error messages.

---

## 8. Known Horizontal Scaling Limitations

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
