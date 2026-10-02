# Automated Testing Architecture & Guidelines

## 1. Overview & Test Runner

Spark Admin utilizes Node's built-in test runner (`node:test`) and assertion module (`node:assert`). This provides fast, native test execution without external runners (such as Jest or Mocha) or compilation overhead.

To run the complete automated test suite:
```bash
npm test
```

---

## 2. Test Suite Organization

| Suite | File | Focus Areas |
| :--- | :--- | :--- |
| **Unit Calculations** | `tests/unit.test.js` | Financial formulas, GST split (CGST/SGST/IGST), half-up rounding, round-off logic. |
| **Authentication & Session** | `tests/auth.test.js` | Login flows, bcrypt verification, session persistence, logout destruction. |
| **Document Domain** | `tests/invoice.test.js` | Create, update, sequence allocation, tax determination, optimistic locking. |
| **Document Lifecycle** | `tests/documents.test.js` | State transitions (`ACTIVE` -> `INACTIVE` -> `VOID` -> `DELETED`), restoration, copy mechanics. |
| **Export & Presentation** | `tests/export.test.js` | HTML print view, Chromium headless PDF generation, Excel workbook export. |
| **Security Hardening** | `tests/hardening.test.js` | CSRF enforcement, rate limiting, security headers, XSS mitigation. |
| **Item Master & QA** | `tests/phase8.test.js` | Autocomplete search, concurrency unique constraints, dashboard KPI queries. |
| **Integration Baseline** | `tests/phase6.test.js` | Full end-to-end integration workflows. |

---

## 3. Focused Test Execution

During development, you can execute individual test files:
```bash
# Run only Item Master & Dashboard tests
node --test tests/phase8.test.js

# Run only Print/PDF export tests
node --test tests/export.test.js

# Run only Document lifecycle tests
node --test tests/documents.test.js
```

---

## 4. Test Teardown Architecture & The Phase 8 Test-Hang Case Study

### 4.1. The Root Cause of Process Hangs
During earlier development (Phase 8), test suites experienced intermittent hangs where tests completed successfully but the Node process failed to exit.

**Root Cause:**
Node's event loop will remain active as long as there are unclosed I/O handles, open network sockets, active HTTP listeners, or unclosed database connection pools.
1. `http.createServer(app).listen(0)` left listening sockets without explicit `server.close()`.
2. Prisma Client retained open connection pool handles without explicit `$disconnect()`.
3. Background intervals or unref'd timers kept the Node event loop alive.

### 4.2. The Mandatory Teardown Pattern
Every integration test file that binds an HTTP server or touches Prisma **MUST** implement strict cleanup inside an `after()` block:

```javascript
const { describe, it, before, after } = require('node:test');
const http = require('node:http');
const prisma = require('../app/config/prisma');
const app = require('../app/app');

describe('Feature Integration Suite', () => {
    let server;

    before(async () => {
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    after(async () => {
        // 1. Close HTTP server and terminate open sockets
        if (server && server.listening) {
            await new Promise((resolve) => server.close(resolve));
        }

        // 2. Disconnect Prisma connection pool
        await prisma.$disconnect();
    });

    it('executes test assertions...', async () => {
        // Test body
    });
});
```

> **POLICY:**
> **Never call `process.exit()` inside a test file as a workaround.**
> Any test file failing to exit naturally indicates an unhandled resource leak that must be identified and closed properly.

---

## 5. Browser QA & Chrome CDP Verification

PDF export testing relies on headless Chromium execution. The test suite verifies:
- Chrome executable discovery across standard OS paths.
- Conversion of `templates/document.ejs` to binary PDF buffers.
- Verification of the `%PDF-` binary magic header.
- Proper handling of `PdfConfigurationError` when no browser is available.
