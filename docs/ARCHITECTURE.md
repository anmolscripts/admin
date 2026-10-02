# System Architecture Specification

## 1. Architectural Overview

Spark Admin follows an enterprise layered architecture with strict separation of concerns. Every request flows sequentially through defined boundaries:

```
[ Browser Client ]
       │  (HTTPS / Session Cookie / CSRF Token)
       ▼
[ Express Application Layer ] (app/app.js)
  ├─ Security & Headers (helmet-style headers, CORS)
  ├─ Body Parsers (express.json, express.urlencoded)
  ├─ Static Asset Delivery (/assets -> assets/)
  ├─ Session Management (express-session + MemoryStore)
  ├─ Global & Auth Rate Limiting
  └─ CSRF Protection Middleware
       │
       ▼
[ Routing Layer ] (app/routes/)
  ├─ web.routes.js     -> Server-rendered EJS pages (GET, editor, view, print)
  ├─ auth.routes.js    -> Session lifecycle (login, logout, session check)
  └─ invoice.routes.js -> RESTful API endpoints for JSON consumers
       │
       ▼
[ Controller Layer ] (app/controllers/)
  ├─ Parameter sanitization and HTTP type coercion
  ├─ Invocation of domain services
  ├─ HTTP status code resolution (200, 201, 400, 404, 409, 500)
  └─ View rendering (res.render) or JSON response delivery (res.json)
       │
       ▼
[ Service Layer ] (app/services/)
  ├─ invoice.service.js       -> Domain calculations, lifecycle rules, transactions
  ├─ documentView.service.js  -> Single normalized view model generation
  ├─ item.service.js          -> Catalog search, uniqueness, autocomplete
  ├─ payment.service.js       -> Payment ledger, balance resolution, receipts
  ├─ dashboard.service.js     -> Parallel SQL KPI aggregations
  ├─ pdf.service.js           -> Headless Chromium PDF generation from shared HTML
  └─ excel.service.js         -> Multi-sheet formatted Excel workbook builder
       │
       ▼
[ Data Access Layer ] (Prisma ORM 7 + MariaDB Adapter)
  ├─ app/config/prisma.js     -> Singleton Prisma Client with connection pooling
  ├─ prisma/schema.prisma     -> Type-safe schema definition
  └─ Migration Engine         -> Forward-only sequential SQL migrations
       │
       ▼
[ Persistence Store ] (MySQL 8 / MariaDB 10.6+)
```

---

## 2. Component Breakdown

### 2.1. Server Bootstrap (`app/server.js`) vs. Application Factory (`app/app.js`)
- **`app/app.js`:** Exports the configured Express `app` instance without binding to a network port. This enables HTTP integration testing with `node:test` and ephemeral ports without port collision or process leaks.
- **`app/server.js`:** The production entrypoint. Loads validated environment configuration (`app/config/env.js`), binds the Express app to the designated `PORT`, logs startup information, and configures graceful process signal handling (`SIGINT`, `SIGTERM`).

### 2.2. Middleware Pipeline (`app/middleware/`)
1. **Security Headers (`app.js`):** Enforces `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and strict referrer policies.
2. **Body Parsers (`app.js`):** Parses JSON bodies (10MB limit) and URL-encoded forms with extended encoding.
3. **Session Middleware (`app/config/session.js`):** Configures session cookies (`spark.sid`), cookie signing via `SESSION_SECRET`, and `httpOnly: true`.
4. **Rate Limiting (`app/middleware/rateLimit.middleware.js`):** In-memory sliding window rate limiters:
   - Auth Rate Limiter: 10 failed login attempts per 15 minutes per IP.
   - API Rate Limiter: 100 requests per minute for sensitive mutation endpoints.
5. **CSRF Middleware (`app/middleware/csrf.middleware.js`):** Protects all mutating requests (`POST`, `PUT`, `DELETE`). Compares incoming `_csrf` body field or `x-csrf-token` header against the cryptographically secure token stored in `req.session.csrfToken`.
6. **Authentication Guard (`app/middleware/auth.middleware.js`):** Enforces valid session presence on protected routes. Unauthenticated browser requests are redirected to `/login`; unauthenticated API requests receive HTTP 401 Unauthorized.
7. **Error Middleware (`app/middleware/error.middleware.js`):** Global error trap. Maps domain errors (`ValidationError`, `NotFoundError`, `ConcurrencyError`) to structured JSON or user-friendly 404/500 EJS views without exposing internal stack traces in production.

### 2.3. Controllers (`app/controllers/`)
Controllers handle the HTTP layer only. They unpack request data, execute services, and package the response.
- [auth.controller.js](file:///c:/Users/User/Documents/project/admin/app/controllers/auth.controller.js): Login validation, timing-safe bcrypt authentication, session establishment, and logout destruction.
- [invoice.controller.js](file:///c:/Users/User/Documents/project/admin/app/controllers/invoice.controller.js): CRUD, status transitions, quotation conversion, PDF/Excel streaming, and copy endpoints.
- [client.controller.js](file:///c:/Users/User/Documents/project/admin/app/controllers/client.controller.js): Client directory management.
- [item.controller.js](file:///c:/Users/User/Documents/project/admin/app/controllers/item.controller.js): Item Master queries, debounced autocomplete search.
- [payment.controller.js](file:///c:/Users/User/Documents/project/admin/app/controllers/payment.controller.js): Payment recording and payment voiding.
- [dashboard.controller.js](file:///c:/Users/User/Documents/project/admin/app/controllers/dashboard.controller.js): Analytics aggregations and trend charts.

### 2.4. Services (`app/services/`)
Services contain ALL business rules, financial formulas, and database transactions:
- **`invoice.service.js`:** Document lifecycle transitions, tax calculations, sequence numbering, and revision tracking.
- **`documentView.service.js`:** The authoritative single view model builder for print, PDF, and details screens.
- **`pdf.service.js`:** Headless browser automation converting the shared HTML template to PDF buffers.
- **`item.service.js`:** Case-insensitive catalog lookup and automated concurrent upserting.
- **`payment.service.js`:** Multi-payment ledger, partial payment reconciliation, and overdue checking.
- **`dashboard.service.js`:** Server-side SQL metric counting, sums, and trend bucketing.

### 2.5. Persistence Layer (Prisma ORM 7 & MySQL)
Database access is handled through `@prisma/client` using the modern `@prisma/adapter-mariadb` driver adapter. Database operations are strictly transactional when touching multiple tables (`$transaction`).

### 2.6. Presentation Layer (EJS & Shared Template)
- Server-side rendered views reside in `app/views/`.
- Documents use a **Single Presentation Source**: `app/views/documents/templates/document.ejs`. Both the Print page (`app/views/documents/print.ejs`) and the PDF generation engine (`app/services/pdf.service.js`) render this identical template with the same normalized view model.

---

## 3. Strict Layer Boundaries

| Layer | MUST Contain | MUST NOT Contain |
| :--- | :--- | :--- |
| **Routes** | HTTP method and path mapping, middleware bindings. | Business logic, database queries, request body parsing. |
| **Controllers** | Request parameter extraction, service invocation, status code mapping, HTTP response output. | Direct Prisma/SQL queries, financial calculation formulas, raw credential hashing. |
| **Services** | Domain rules, tax/financial calculations, database transactions, concurrency checks, data formatting. | Direct access to `req` or `res` objects, HTTP headers, session cookies. |
| **Views (EJS)** | Display markup, HTML presentation tokens, semantic structure. | Business rules, tax recalculations, database queries. |
| **Browser JS** | DOM interaction, autocomplete UX, client-side input validation, calculation mirrors for instant feedback. | Authoritative financial calculations, final status changes, unauthenticated mutations. |

---

## 4. Error Handling Flow

```
[ Error Occurs in Service ]
       │ (e.g. ValidationError, NotFoundError, ConcurrencyError)
       ▼
[ Caught by Controller try/catch ]
       │
       ▼
[ Handled by handleControllerError() / Passed to next(err) ]
       │
       ▼
[ Global Error Middleware (app/middleware/error.middleware.js) ]
  ├─ API Request: Returns structured JSON { success: false, error: "..." } with matching HTTP status.
  └─ Web Request: Renders custom 404.ejs or 500.ejs with user-safe message.
```
