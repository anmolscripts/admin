const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const invoiceService = require('../app/services/invoice.service');

describe('Documents Listing (Phase 2) Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let csrfToken;
    let testUserId;
    const adminEmail = 'admin@email.com';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'choose-a-local-development-password';

    function extractCookie(res) {
        const setCookie = res.headers.get('set-cookie');
        if (!setCookie) return null;
        const match = setCookie.match(/spark\.sid=[^;]+/);
        return match ? match[0] : null;
    }

    function extractCsrfToken(html) {
        const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
        return match ? match[1] : null;
    }

    before(async () => {
        // Query test admin user ID
        const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
        assert.ok(adminUser, 'Admin user must exist in database');
        testUserId = adminUser.id;

        // Start app on ephemeral port
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Authenticate as Admin to acquire session cookie and CSRF token
        const getLoginRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getLoginRes);
        const loginCsrf = extractCsrfToken(await getLoginRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: loginCsrf,
                email: adminEmail,
                password: adminPassword
            }).toString(),
            redirect: 'manual'
        });

        authCookie = extractCookie(loginRes);
        assert.ok(authCookie, 'Should successfully obtain session cookie for tests');

        // Extract fresh CSRF token from authenticated dashboard/listing
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        csrfToken = extractCsrfToken(await dashRes.text());
        assert.ok(csrfToken, 'Should successfully obtain post-auth CSRF token');
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await prisma.$disconnect();
    });

    // 1. Authenticated user can access main listing at /
    it('1. authenticated user accessing GET / receives 200 and renders Quotations & Invoices page', async () => {
        const res = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('Quotations &amp; Invoices') || html.includes('Quotations & Invoices'));
        assert.ok(html.includes('documents-table'));
        assert.ok(html.includes('/js/documents.js'));
        assert.ok(html.includes('/css/documents.css'));
    });

    // 2. Authenticated user can access listing at /documents
    it('2. authenticated user accessing GET /documents receives 200 and renders Quotations & Invoices page', async () => {
        const res = await fetch(`${baseUrl}/documents`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('Quotations &amp; Invoices') || html.includes('Quotations & Invoices'));
        assert.ok(html.includes('search-input'));
        assert.ok(html.includes('filter-status'));
        assert.ok(html.includes('filter-type'));
    });

    // 3. Unauthenticated user accessing / is redirected to /login
    it('3. unauthenticated user accessing GET / is redirected to /login', async () => {
        const res = await fetch(`${baseUrl}/`, {
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/login');
    });

    // 4. Unauthenticated user accessing /documents is redirected to /login
    it('4. unauthenticated user accessing GET /documents is redirected to /login', async () => {
        const res = await fetch(`${baseUrl}/documents`, {
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/login');
    });

    // 5. Document type filter returns only quotations or invoices
    it('5. type filter returns only documents matching the selected type', async () => {
        // Query quotations only
        const qtnRes = await fetch(`${baseUrl}/api/invoices?type=QUOTATION`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(qtnRes.status, 200);
        const qtnBody = await qtnRes.json();
        assert.strictEqual(qtnBody.success, true);
        assert.ok(qtnBody.data.length > 0);
        qtnBody.data.forEach((doc) => {
            assert.strictEqual(doc.documentType, 'QUOTATION');
            assert.ok(doc.invoiceNumber.startsWith('QTN-'));
        });

        // Query invoices only
        const invRes = await fetch(`${baseUrl}/api/invoices?type=INVOICE`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(invRes.status, 200);
        const invBody = await invRes.json();
        assert.strictEqual(invBody.success, true);
        assert.ok(invBody.data.length > 0);
        invBody.data.forEach((doc) => {
            assert.strictEqual(doc.documentType, 'INVOICE');
            assert.ok(doc.invoiceNumber.startsWith('INV-'));
        });
    });

    // 6. Status filter returns only documents matching status
    it('6. status filter returns only documents matching the selected lifecycle status', async () => {
        const activeRes = await fetch(`${baseUrl}/api/invoices?status=ACTIVE`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(activeRes.status, 200);
        const activeBody = await activeRes.json();
        assert.ok(activeBody.data.length > 0);
        activeBody.data.forEach((doc) => {
            assert.strictEqual(doc.status, 'ACTIVE');
        });

        const voidRes = await fetch(`${baseUrl}/api/invoices?status=VOID`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(voidRes.status, 200);
        const voidBody = await voidRes.json();
        assert.ok(voidBody.data.length > 0);
        voidBody.data.forEach((doc) => {
            assert.strictEqual(doc.status, 'VOID');
        });
    });

    // 7. Deleted status filter returns soft-deleted documents
    it('7. DELETED filter explicitly returns soft-deleted documents without silently omitting them', async () => {
        // Create a document and soft delete it
        const doc = await invoiceService.createInvoice({
            clientName: 'Listing Soft Delete Corp',
            invoiceDate: '2026-06-01',
            gstEnabled: false,
            items: [{ name: 'Service Item', quantity: 1, rate: 1200 }]
        }, testUserId);

        await invoiceService.softDeleteDocument(doc.id, 'Test soft delete for listing', testUserId);

        // Fetch with status=DELETED
        const delRes = await fetch(`${baseUrl}/api/invoices?status=DELETED`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(delRes.status, 200);
        const delBody = await delRes.json();
        assert.ok(delBody.data.length > 0);
        
        const found = delBody.data.find(d => d.id === doc.id);
        assert.ok(found, 'Soft-deleted document must be present in DELETED status query');
        assert.strictEqual(found.status, 'DELETED');
        assert.strictEqual(found.previousStatusBeforeDelete, 'ACTIVE');
        assert.ok(found.deletedAt);

        // Cleanup
        await prisma.invoice.delete({ where: { id: doc.id } });
    });

    // 8. Server-side search by document number and client name
    it('8. search query safely filters documents by document number and client name server-side', async () => {
        // Search by document number substring
        const numRes = await fetch(`${baseUrl}/api/invoices?search=INV-2026-0001`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(numRes.status, 200);
        const numBody = await numRes.json();
        assert.strictEqual(numBody.data.length, 1);
        assert.strictEqual(numBody.data[0].invoiceNumber, 'INV-2026-0001');

        // Search by client name
        const clientRes = await fetch(`${baseUrl}/api/invoices?search=Acme`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(clientRes.status, 200);
        const clientBody = await clientRes.json();
        assert.ok(clientBody.data.length >= 1);
        clientBody.data.forEach((d) => {
            assert.ok(d.clientName.includes('Acme') || d.invoiceNumber.includes('Acme'));
        });
    });

    // 9. Date range filtering (dateFrom and dateTo)
    it('9. dateFrom and dateTo filters return documents within the specified date boundaries', async () => {
        const dateRes = await fetch(`${baseUrl}/api/invoices?dateFrom=2026-02-01&dateTo=2026-02-28`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(dateRes.status, 200);
        const dateBody = await dateRes.json();
        assert.ok(dateBody.data.length > 0);
        dateBody.data.forEach((d) => {
            const docDate = new Date(d.invoiceDate);
            assert.ok(docDate >= new Date('2026-02-01'));
            assert.ok(docDate <= new Date('2026-02-28'));
        });
    });

    // 10. Server-side pagination parameters
    it('10. pagination returns expected slice, page limit, and total count', async () => {
        const pagRes = await fetch(`${baseUrl}/api/invoices?page=1&limit=2`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(pagRes.status, 200);
        const pagBody = await pagRes.json();
        assert.strictEqual(pagBody.pagination.page, 1);
        assert.strictEqual(pagBody.pagination.limit, 2);
        assert.strictEqual(pagBody.data.length, 2);
        assert.ok(pagBody.pagination.total >= 5);
        assert.ok(pagBody.pagination.totalPages >= 3);
    });

    // 11. Empty result handling
    it('11. search with no matches returns empty array and total count of 0', async () => {
        const noMatchRes = await fetch(`${baseUrl}/api/invoices?search=NONEXISTENT_KEYWORD_XYZ_9999`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(noMatchRes.status, 200);
        const body = await noMatchRes.json();
        assert.strictEqual(body.data.length, 0);
        assert.strictEqual(body.pagination.total, 0);
    });

    // 12. API error handling for unauthenticated requests
    it('12. unauthenticated GET /api/invoices is rejected with redirect to login or 401', async () => {
        const unauthRes = await fetch(`${baseUrl}/api/invoices`, {
            redirect: 'manual'
        });
        // requireAuth middleware redirects HTML requests or unauthenticated requests with 302 to /login
        assert.ok(unauthRes.status === 302 || unauthRes.status === 401);
        if (unauthRes.status === 302) {
            assert.strictEqual(unauthRes.headers.get('location'), '/login');
        }
    });

    // 13. API contract verification
    it('13. API response payload strictly matches required domain contract fields', async () => {
        const res = await fetch(`${baseUrl}/api/invoices?limit=1`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.ok(body.data.length > 0);
        const doc = body.data[0];

        // Required contract fields
        assert.ok(doc.id !== undefined, 'id must be present');
        assert.ok(['QUOTATION', 'INVOICE'].includes(doc.documentType), 'documentType must be valid');
        assert.ok(typeof doc.invoiceNumber === 'string' && doc.invoiceNumber.length > 0, 'invoiceNumber must be valid');
        assert.ok(typeof doc.clientName === 'string', 'clientName must be valid');
        assert.ok(doc.invoiceDate, 'invoiceDate must be present');
        assert.ok(doc.grandTotal !== undefined, 'grandTotal must be present');
        assert.ok(['ACTIVE', 'INACTIVE', 'VOID', 'DELETED'].includes(doc.status), 'status must be valid');
    });

    // 14. Static assets delivery verification
    it('14. frontend static assets /js/documents.js and /css/documents.css are served with 200', async () => {
        const jsRes = await fetch(`${baseUrl}/js/documents.js`);
        assert.strictEqual(jsRes.status, 200);
        const jsContent = await jsRes.text();
        assert.ok(jsContent.includes('loadDocuments'));
        assert.ok(jsContent.includes('formatIndianCurrency'));

        const cssRes = await fetch(`${baseUrl}/css/documents.css`);
        assert.strictEqual(cssRes.status, 200);
        const cssContent = await cssRes.text();
        assert.ok(cssContent.includes('.document-table'));
        assert.ok(cssContent.includes('.badge-status-deleted'));
    });
});
