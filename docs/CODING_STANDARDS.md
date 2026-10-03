# Engineering Coding Standards & Guidelines

## 1. Language & Module System

- **Runtime:** Node.js 24 LTS.
- **Module System:** Strict **CommonJS** (`require` / `module.exports`). Do not mix with ES Module `import`/`export` syntax in server code.
- **Asynchronous Code:** Use `async` / `await` for all asynchronous flows. Avoid raw promise chains (`.then()`, `.catch()`) and callback nesting.

---

## 2. Layered Architecture & Separation of Concerns

### 2.1. Controllers vs. Services
- **Controllers:** Sole responsibility is parsing the HTTP request, checking high-level parameter types, invoking the domain service, and returning an HTTP response or rendered template.
- **Services:** Contain 100% of the domain logic, financial formulas, database calls, audit logging, and authorization assertions. Services must never reference `req`, `res`, or Express middleware parameters.

### 2.2. Error Handling & Custom Error Classes
Define explicit domain error classes with standard HTTP status codes:
```javascript
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
        this.statusCode = 404;
    }
}

class ConcurrencyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConcurrencyError';
        this.statusCode = 409;
    }
}
```
Controllers catch errors and delegate to `handleControllerError(err, res, next)` to ensure consistent status code responses.

---

## 3. Database & Prisma Conventions

### 3.1. Prisma Client Singleton
Always import the shared Prisma instance from `app/config/prisma.js`:
```javascript
const prisma = require('../config/prisma');
```
Never instantiate `new PrismaClient()` inside services or routes.

### 3.2. Transactions
Whenever mutating related records (e.g., updating an invoice and inserting an audit revision, or creating an invoice and allocating sequence numbers), wrap operations inside `prisma.$transaction()`:
```javascript
return await prisma.$transaction(async (tx) => {
    // Perform atomic operations using tx
});
```

### 3.3. Raw SQL Policy
Do not write raw SQL strings unless executing an optimized aggregation not supported by Prisma's model query API. If raw SQL is necessary, use Prisma's `$queryRaw` tagged template literal to ensure parameterization against SQL injection. Never concatenate variables into SQL strings.

---

## 4. Templating & Presentation Safety (EJS)

- **Safe Escaping:** Always use `<%= %>` for outputting dynamic values. This automatically HTML-escapes output, preventing Cross-Site Scripting (XSS).
- **Unescaped Output Restricted:** Do not use `<%- %>` unless rendering trusted, pre-sanitized HTML from internal services (such as shared sub-templates).
- **Zero Business Logic in Views:** Do not perform math calculations, tax splits, or database calls in EJS templates. Consume pre-formatted fields from the view model.

---

## 5. Browser JavaScript & DOM Standards

- **Modern Vanilla JavaScript:** Use ES6+ syntax (destructuring, arrow functions, `fetch`). Avoid jQuery or legacy libraries.
- **Safe DOM Manipulation:** Prefer `textContent`, `setAttribute`, or structured elements over `innerHTML`. If setting HTML from dynamic variables, rigorously sanitize.
- **Debounced Network Requests:** Any input-triggered fetch (e.g., autocomplete) must be debounced by 200–300ms to avoid flooding the server.
- **Body Portal Dropdowns:** When rendering interactive suggestion dropdowns over scrollable table containers, mount the menu into a top-level body portal (`#item-autocomplete-portal`, `position: fixed`) with boundary collision calculations to prevent parent overflow clipping.
- **Unified Button System:** All actions must use standardized button classes (`.btn-primary`, `.btn-secondary`, `.btn-outline-primary`, `.btn-outline-secondary`, `.btn-danger`) with consistent border radii (6px), heights, typography, and hover transitions.
- **Accessibility:** Ensure interactive elements include appropriate ARIA attributes (`role="listbox"`, `role="option"`, `aria-expanded`, `aria-activedescendant`), semantic tags (`<button>`, `<a>`, `<input>`), and keyboard handlers (`keydown`).

---

## 6. Prohibited Unsafe Patterns

The following patterns are strictly forbidden in this codebase:

1. **PROHIBITED: Direct Secrets in Code**
   Never hardcode passwords, session keys, or database URLs in source files. Always access via `process.env`.
2. **PROHIBITED: Bypassing CSRF**
   Never disable CSRF checks on mutating endpoints (`POST`, `PUT`, `DELETE`).
3. **PROHIBITED: Authoritative Client-Side Math**
   Never trust monetary totals or tax amounts sent from the browser. The server must recalculate all totals.
4. **PROHIBITED: Duplicated Document Layouts**
   Never create a second PDF layout engine. PDF generation must render the shared `templates/document.ejs` template.
5. **PROHIBITED: Direct Production Database Modification**
   Never edit tables or records directly via SQL console in production. Use migrations and authenticated application workflows.
6. **PROHIBITED: Using `process.exit()` in Test Suites**
   Tests must clean up resources and exit naturally. Calling `process.exit()` hides unhandled promise rejections and open socket leaks.
