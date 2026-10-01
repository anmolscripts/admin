const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const invoiceService = require('../app/services/invoice.service');

describe('Document Editor (Phase 3) Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let csrfToken;
    let testUserId;
    let testQuotationId;
    let testInvoiceId;
    let testVoidInvoiceId;
    let testDeletedInvoiceId;

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

        // Create dedicated test documents for editor tests
        const qtn = await invoiceService.createQuotation({
            clientName: 'Editor Test Quotation Client',
            invoiceDate: '2026-06-01',
            gstEnabled: true,
            gstRate: 18,
            items: [{ name: 'Quotation Item 1', quantity: 2, unit: 'PCS', rate: 1000 }]
        }, testUserId);
        testQuotationId = qtn.id;

        const inv = await invoiceService.createInvoice({
            clientName: 'Editor Test Invoice Client',
            invoiceDate: '2026-06-05',
            gstEnabled: false,
            items: [{ name: 'Invoice Item 1', quantity: 1, unit: 'Project', rate: 5000 }]
        }, testUserId);
        testInvoiceId = inv.id;

        // Create VOID test document
        const voidInv = await invoiceService.createInvoice({
            clientName: 'Editor Test Void Client',
            invoiceDate: '2026-06-10',
            gstEnabled: false,
            items: [{ name: 'Void Item', quantity: 1, rate: 500 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(voidInv.id, 'VOID', testUserId);
        testVoidInvoiceId = voidInv.id;

        // Create DELETED test document
        const delInv = await invoiceService.createInvoice({
            clientName: 'Editor Test Deleted Client',
            invoiceDate: '2026-06-12',
            gstEnabled: false,
            items: [{ name: 'Deleted Item', quantity: 1, rate: 750 }]
        }, testUserId);
        await invoiceService.softDeleteDocument(delInv.id, 'Test soft deletion for editor', testUserId);
        testDeletedInvoiceId = delInv.id;
    });

    after(async () => {
        // Cleanup created test records
        const testIds = [testQuotationId, testInvoiceId, testVoidInvoiceId, testDeletedInvoiceId].filter(Boolean);
        for (const id of testIds) {
            try {
                await prisma.invoice.delete({ where: { id } });
            } catch (_) {}
        }
        if (server && server.closeAllConnections) server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await prisma.$disconnect();
    });

    // =========================================================================
    // 1. ROUTE TESTS & AUTHENTICATION ENFORCEMENT
    // =========================================================================
    it('1. unauthenticated user accessing GET /documents/new is redirected to /login', async () => {
        const res = await fetch(`${baseUrl}/documents/new?type=QUOTATION`, {
            redirect: 'manual'
        });
        assert.strictEqual(res.status, 302);
        assert.ok(res.headers.get('location').includes('/login'));
    });

    it('2. unauthenticated user accessing GET /documents/:id/edit is redirected to /login', async () => {
        const res = await fetch(`${baseUrl}/documents/${testInvoiceId}/edit`, {
            redirect: 'manual'
        });
        assert.strictEqual(res.status, 302);
        assert.ok(res.headers.get('location').includes('/login'));
    });

    it('3. authenticated user accessing GET /documents/new?type=QUOTATION receives 200 with New Quotation editor', async () => {
        const res = await fetch(`${baseUrl}/documents/new?type=QUOTATION`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('New Quotation'), 'Page title should be New Quotation');
        assert.ok(html.includes('QUOTATION'), 'Page should display QUOTATION type');
        assert.ok(html.includes('Number assigned when saved'), 'Should indicate number is assigned on save');
        assert.ok(html.includes('id="items-table"'), 'Should render dynamic items table');
        assert.ok(html.includes('id="document-form"'), 'Should render document form');
    });

    it('4. authenticated user accessing GET /documents/new?type=INVOICE receives 200 with New Invoice editor', async () => {
        const res = await fetch(`${baseUrl}/documents/new?type=INVOICE`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('New Invoice'), 'Page title should be New Invoice');
        assert.ok(html.includes('INVOICE'), 'Page should display INVOICE type');
        assert.ok(html.includes('Number assigned when saved'), 'Should indicate number is assigned on save');
    });

    it('5. authenticated user accessing GET /documents/:id/edit loads existing invoice data in edit mode', async () => {
        const res = await fetch(`${baseUrl}/documents/${testInvoiceId}/edit`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('Edit INV-'), 'Page title should contain Edit and invoice number');
        assert.ok(html.includes('Editor Test Invoice Client'), 'Should contain client name in initial data');
        assert.ok(html.includes('id="doc-version"'), 'Should include doc-version input for optimistic concurrency');
    });

    it('6. authenticated user accessing GET /documents/:id/edit loads existing quotation data in edit mode', async () => {
        const res = await fetch(`${baseUrl}/documents/${testQuotationId}/edit`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('Edit QTN-'), 'Page title should contain Edit and quotation number');
        assert.ok(html.includes('Editor Test Quotation Client'), 'Should contain quotation client name');
    });

    it('7. accessing GET /documents/:id/edit for a nonexistent ID returns 404', async () => {
        const res = await fetch(`${baseUrl}/documents/999999/edit`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 404);
    });

    it('8. attempting to edit a VOID document returns 400 Bad Request with lock message', async () => {
        const res = await fetch(`${baseUrl}/documents/${testVoidInvoiceId}/edit`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 400);
        const html = await res.text();
        assert.ok(html.includes('VOID') || html.includes('permanently locked'));
    });

    it('9. attempting to edit a DELETED document returns 400 Bad Request with restore message', async () => {
        const res = await fetch(`${baseUrl}/documents/${testDeletedInvoiceId}/edit`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 400);
        const html = await res.text();
        assert.ok(html.includes('DELETED') || html.includes('Restore the document'));
    });

    // =========================================================================
    // 2. CREATE FLOW & SERVER-SIDE CALCULATION VERIFICATION
    // =========================================================================
    it('10. create quotation via API integration generates sequential QTN number and exact totals', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'QUOTATION',
                clientName: 'Integration Quotation Client',
                invoiceDate: '2026-07-01',
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Architecture Review', quantity: 2, unit: 'Project', rate: 15000 },
                    { name: 'DevOps Setup', quantity: 1, unit: 'Service', rate: 10000 }
                ]
            })
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        const doc = body.data;

        assert.strictEqual(doc.documentType, 'QUOTATION');
        assert.match(doc.invoiceNumber, /^QTN-2026-\d{4}$/);
        assert.strictEqual(doc.status, 'ACTIVE');
        assert.strictEqual(doc.version, 1);
        // Server calculations:
        // subtotal: (2*15000) + (1*10000) = 40000.00
        // gstAmount: 40000 * 18% = 7200.00
        // grandTotal: 47200.00
        assert.strictEqual(Number(doc.subtotal), 40000);
        assert.strictEqual(Number(doc.gstAmount), 7200);
        assert.strictEqual(Number(doc.grandTotal), 47200);
        assert.strictEqual(doc.items.length, 2);

        // Cleanup
        await prisma.invoice.delete({ where: { id: doc.id } });
    });

    it('11. create invoice via API integration generates sequential INV number and ignores client-spoofed totals', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Integration Invoice Client',
                invoiceDate: '2026-07-05',
                gstEnabled: true,
                gstRate: 12,
                // Client attempts to spoof totals
                subtotal: '1.00',
                grandTotal: '1.00',
                invoiceNumber: 'INV-FAKE-0001',
                status: 'VOID',
                items: [
                    { name: 'Hardware License', quantity: 3, unit: 'Units', rate: 4500, amount: '1.00' }
                ]
            })
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        const doc = body.data;

        assert.strictEqual(doc.documentType, 'INVOICE');
        assert.match(doc.invoiceNumber, /^INV-2026-\d{4}$/);
        assert.notStrictEqual(doc.invoiceNumber, 'INV-FAKE-0001', 'Cannot spoof invoice number');
        assert.strictEqual(doc.status, 'ACTIVE', 'Cannot spoof status to VOID on creation');

        // Server calculations:
        // subtotal: 3 * 4500 = 13500.00
        // gstAmount: 13500 * 12% = 1620.00
        // grandTotal: 15120.00
        assert.strictEqual(Number(doc.subtotal), 13500);
        assert.strictEqual(Number(doc.gstAmount), 1620);
        assert.strictEqual(Number(doc.grandTotal), 15120);

        // Cleanup
        await prisma.invoice.delete({ where: { id: doc.id } });
    });

    // =========================================================================
    // 3. VALIDATION RULES
    // =========================================================================
    it('12. validation rejects missing client name with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: '',
                invoiceDate: '2026-07-01',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Client name is required'));
    });

    it('13. validation rejects missing items with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'No Items Client',
                invoiceDate: '2026-07-01',
                items: []
            })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('at least one line item'));
    });

    it('14. validation rejects invalid item quantity (<= 0) with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Bad Qty Client',
                invoiceDate: '2026-07-01',
                items: [{ name: 'Item', quantity: 0, rate: 100 }]
            })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Quantity must be greater than zero'));
    });

    it('15. validation rejects invalid item rate (< 0) with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Bad Rate Client',
                invoiceDate: '2026-07-01',
                items: [{ name: 'Item', quantity: 1, rate: -50 }]
            })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Rate must be greater than or equal to zero'));
    });

    it('16. validation rejects invalid invoice date with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Bad Date Client',
                invoiceDate: 'not-a-valid-date',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invalid invoice date format'));
    });

    it('17. validation rejects invalid GST rate with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Bad GST Client',
                invoiceDate: '2026-07-01',
                gstEnabled: true,
                gstRate: 15, // Invalid: must be 5, 12, 18, 28
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invalid GST rate'));
    });

    it('18. validation rejects quotation expiry date preceding quotation date', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'QUOTATION',
                clientName: 'Expiry Test Client',
                invoiceDate: '2026-07-15',
                validUntil: '2026-07-10', // Prior to quotation date!
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Quotation expiry date cannot be earlier than quotation date'));
    });

    it('19. validation rejects invoice due date preceding invoice date', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Due Date Test Client',
                invoiceDate: '2026-07-15',
                dueDate: '2026-07-01', // Prior to invoice date!
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invoice due date cannot be earlier than invoice date'));
    });

    // =========================================================================
    // 4. EDIT FLOW, IMMUTABILITY & CONCURRENCY
    // =========================================================================
    it('20. edit flow updates document details and increments version', async () => {
        const getDoc = await invoiceService.getInvoiceById(testInvoiceId);
        const currentVersion = getDoc.version;

        const res = await fetch(`${baseUrl}/api/invoices/${testInvoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: currentVersion,
                clientName: 'Editor Test Invoice Client Updated',
                invoiceDate: '2026-06-06',
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Updated Item 1', quantity: 2, unit: 'Project', rate: 7000 }
                ]
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.data.clientName, 'Editor Test Invoice Client Updated');
        assert.strictEqual(body.data.version, currentVersion + 1);
        assert.strictEqual(Number(body.data.subtotal), 14000);
        assert.strictEqual(Number(body.data.grandTotal), 16520); // 14000 + 18% (2520)
    });

    it('21. document number and documentType are strictly immutable on edit', async () => {
        const getDoc = await invoiceService.getInvoiceById(testInvoiceId);

        // Attempting to change documentType from INVOICE to QUOTATION must be rejected
        const typeChangeRes = await fetch(`${baseUrl}/api/invoices/${testInvoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: getDoc.version,
                documentType: 'QUOTATION',
                clientName: getDoc.clientName,
                invoiceDate: '2026-06-06',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        assert.strictEqual(typeChangeRes.status, 400);
        const typeBody = await typeChangeRes.json();
        assert.ok(typeBody.error.includes('Document type cannot be changed'));

        // Attempting to change document number must be rejected
        const numberChangeRes = await fetch(`${baseUrl}/api/invoices/${testInvoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: getDoc.version,
                invoiceNumber: 'INV-MODIFIED-9999',
                clientName: getDoc.clientName,
                invoiceDate: '2026-06-06',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        assert.strictEqual(numberChangeRes.status, 400);
        const numBody = await numberChangeRes.json();
        assert.ok(numBody.error.includes('Document number cannot be modified'));
    });

    it('22. status cannot be changed via normal document update endpoint', async () => {
        const getDoc = await invoiceService.getInvoiceById(testInvoiceId);

        const statusChangeRes = await fetch(`${baseUrl}/api/invoices/${testInvoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: getDoc.version,
                status: 'VOID',
                clientName: getDoc.clientName,
                invoiceDate: '2026-06-06',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        assert.strictEqual(statusChangeRes.status, 400);
        const body = await statusChangeRes.json();
        assert.ok(body.error.includes('Document status cannot be changed via update'));
    });

    it('23. optimistic concurrency conflict (409) is returned when submitting stale version', async () => {
        const getDoc = await invoiceService.getInvoiceById(testInvoiceId);
        const staleVersion = getDoc.version - 1; // Stale version

        const conflictRes = await fetch(`${baseUrl}/api/invoices/${testInvoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: staleVersion,
                clientName: 'Stale Update Attempt',
                invoiceDate: '2026-06-06',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });

        assert.strictEqual(conflictRes.status, 409);
        const body = await conflictRes.json();
        assert.ok(body.error.includes('Conflict: Document was modified by another user'));
    });

    it('24. cannot modify document in VOID status via PUT', async () => {
        const getDoc = await invoiceService.getInvoiceById(testVoidInvoiceId);

        const res = await fetch(`${baseUrl}/api/invoices/${testVoidInvoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: getDoc.version,
                clientName: 'Attempted Void Edit',
                invoiceDate: '2026-06-10',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Cannot modify an invoice in VOID status'));
    });

    it('25. cannot modify document in DELETED status via PUT', async () => {
        const getDoc = await invoiceService.getInvoiceById(testDeletedInvoiceId);

        const res = await fetch(`${baseUrl}/api/invoices/${testDeletedInvoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: getDoc.version,
                clientName: 'Attempted Deleted Edit',
                invoiceDate: '2026-06-12',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Cannot modify an invoice in DELETED status'));
    });

    // =========================================================================
    // 5. ASSET SERVING
    // =========================================================================
    it('26. frontend static assets /js/editor.js and /css/editor.css are served with 200', async () => {
        const jsRes = await fetch(`${baseUrl}/js/editor.js`);
        assert.strictEqual(jsRes.status, 200);
        const jsText = await jsRes.text();
        assert.ok(jsText.includes('recalculateTotals'), 'editor.js must contain recalculateTotals logic');

        const cssRes = await fetch(`${baseUrl}/css/editor.css`);
        assert.strictEqual(cssRes.status, 200);
        const cssText = await cssRes.text();
        assert.ok(cssText.includes('.document-editor-container'), 'editor.css must contain editor container styles');
    });

    // =========================================================================
    // 6. DOCUMENT SNAPSHOT FIELDS PERSISTENCE & HARDENING (PHASE 3 AUDIT)
    // =========================================================================
    let snapshotQuotationId;
    let snapshotInvoiceId;

    it('27. create quotation persists all 6 snapshot fields in database and GET returns them', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'QUOTATION',
                clientName: 'Snapshot Quotation Corp',
                clientEmail: 'billing@snapshotcorp.com',
                clientPhone: '+91 9876543210',
                billingAddress: '123 Billing Street, Mumbai, MH',
                shippingAddress: '123 Billing Street, Mumbai, MH',
                termsAndConditions: 'Quotation valid for 30 days. Standard warranty applies.',
                remarks: 'Initial draft for client review.',
                invoiceDate: '2026-07-01',
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Cloud Consultation', quantity: 10, unit: 'Hours', rate: 2500 }]
            })
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        snapshotQuotationId = body.data.id;

        // Verify response payload contains all 6 fields
        assert.strictEqual(body.data.clientEmail, 'billing@snapshotcorp.com');
        assert.strictEqual(body.data.clientPhone, '+91 9876543210');
        assert.strictEqual(body.data.billingAddress, '123 Billing Street, Mumbai, MH');
        assert.strictEqual(body.data.shippingAddress, '123 Billing Street, Mumbai, MH');
        assert.strictEqual(body.data.termsAndConditions, 'Quotation valid for 30 days. Standard warranty applies.');
        assert.strictEqual(body.data.remarks, 'Initial draft for client review.');

        // Verify via direct Prisma query
        const dbDoc = await prisma.invoice.findUnique({ where: { id: snapshotQuotationId } });
        assert.strictEqual(dbDoc.clientEmail, 'billing@snapshotcorp.com');
        assert.strictEqual(dbDoc.clientPhone, '+91 9876543210');
        assert.strictEqual(dbDoc.billingAddress, '123 Billing Street, Mumbai, MH');
        assert.strictEqual(dbDoc.shippingAddress, '123 Billing Street, Mumbai, MH');
        assert.strictEqual(dbDoc.termsAndConditions, 'Quotation valid for 30 days. Standard warranty applies.');
        assert.strictEqual(dbDoc.remarks, 'Initial draft for client review.');

        // Verify via GET /api/invoices/:id
        const getRes = await fetch(`${baseUrl}/api/invoices/${snapshotQuotationId}`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(getRes.status, 200);
        const getBody = await getRes.json();
        assert.strictEqual(getBody.data.clientEmail, 'billing@snapshotcorp.com');
        assert.strictEqual(getBody.data.clientPhone, '+91 9876543210');
        assert.strictEqual(getBody.data.billingAddress, '123 Billing Street, Mumbai, MH');
        assert.strictEqual(getBody.data.shippingAddress, '123 Billing Street, Mumbai, MH');
        assert.strictEqual(getBody.data.termsAndConditions, 'Quotation valid for 30 days. Standard warranty applies.');
        assert.strictEqual(getBody.data.remarks, 'Initial draft for client review.');
    });

    it('28. create invoice persists all 6 snapshot fields in database and GET returns them', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Snapshot Invoice Ltd',
                clientEmail: 'accounts@snapshotltd.com',
                clientPhone: '022-12345678',
                billingAddress: '456 Commercial Way, Delhi',
                shippingAddress: '456 Commercial Way, Delhi',
                termsAndConditions: 'Net 30 days payment term.',
                remarks: 'Deliver to 4th floor reception.',
                invoiceDate: '2026-07-02',
                gstEnabled: false,
                items: [{ name: 'Enterprise License', quantity: 1, unit: 'License', rate: 75000 }]
            })
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        snapshotInvoiceId = body.data.id;

        assert.strictEqual(body.data.clientEmail, 'accounts@snapshotltd.com');
        assert.strictEqual(body.data.clientPhone, '022-12345678');
        assert.strictEqual(body.data.billingAddress, '456 Commercial Way, Delhi');
        assert.strictEqual(body.data.shippingAddress, '456 Commercial Way, Delhi');
        assert.strictEqual(body.data.termsAndConditions, 'Net 30 days payment term.');
        assert.strictEqual(body.data.remarks, 'Deliver to 4th floor reception.');

        const dbDoc = await prisma.invoice.findUnique({ where: { id: snapshotInvoiceId } });
        assert.strictEqual(dbDoc.clientEmail, 'accounts@snapshotltd.com');
        assert.strictEqual(dbDoc.billingAddress, '456 Commercial Way, Delhi');

        const getRes = await fetch(`${baseUrl}/api/invoices/${snapshotInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(getRes.status, 200);
        const getBody = await getRes.json();
        assert.strictEqual(getBody.data.clientEmail, 'accounts@snapshotltd.com');
        assert.strictEqual(getBody.data.shippingAddress, '456 Commercial Way, Delhi');
    });

    it('29. edit document updates all 6 snapshot fields and persists changes', async () => {
        const getDoc = await invoiceService.getInvoiceById(snapshotQuotationId);

        const updateRes = await fetch(`${baseUrl}/api/invoices/${snapshotQuotationId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: getDoc.version,
                clientName: 'Updated Snapshot Quotation Corp',
                clientEmail: 'updated.billing@snapshotcorp.com',
                clientPhone: '+91 9999988888',
                billingAddress: '999 New Boulevard, Floor 10, Pune, MH',
                shippingAddress: '888 Warehouse Lane, Chakan, Pune, MH',
                termsAndConditions: 'Updated terms: 50% advance, 50% upon delivery.',
                remarks: 'Client requested rush delivery.',
                invoiceDate: '2026-07-03',
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Cloud Migration', quantity: 1, unit: 'Project', rate: 120000 }]
            })
        });

        assert.strictEqual(updateRes.status, 200);
        const updateBody = await updateRes.json();

        assert.strictEqual(updateBody.data.clientEmail, 'updated.billing@snapshotcorp.com');
        assert.strictEqual(updateBody.data.clientPhone, '+91 9999988888');
        assert.strictEqual(updateBody.data.billingAddress, '999 New Boulevard, Floor 10, Pune, MH');
        assert.strictEqual(updateBody.data.shippingAddress, '888 Warehouse Lane, Chakan, Pune, MH');
        assert.strictEqual(updateBody.data.termsAndConditions, 'Updated terms: 50% advance, 50% upon delivery.');
        assert.strictEqual(updateBody.data.remarks, 'Client requested rush delivery.');

        // Re-fetch via GET to guarantee database persistence
        const refetchRes = await fetch(`${baseUrl}/api/invoices/${snapshotQuotationId}`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(refetchRes.status, 200);
        const refetchBody = await refetchRes.json();
        assert.strictEqual(refetchBody.data.clientEmail, 'updated.billing@snapshotcorp.com');
        assert.strictEqual(refetchBody.data.billingAddress, '999 New Boulevard, Floor 10, Pune, MH');
        assert.strictEqual(refetchBody.data.shippingAddress, '888 Warehouse Lane, Chakan, Pune, MH');
        assert.strictEqual(refetchBody.data.remarks, 'Client requested rush delivery.');
    });

    it('30. independent shipping address differing from billing address is preserved', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Distinct Address Corp',
                billingAddress: 'Billing HQ: Tower A, Financial District, Hyderabad',
                shippingAddress: 'Shipping Depot: Shed 12, Logistic Park, Shamshabad',
                invoiceDate: '2026-07-04',
                gstEnabled: false,
                items: [{ name: 'Hardware Server', quantity: 2, unit: 'Units', rate: 150000 }]
            })
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        const distinctId = body.data.id;

        assert.notStrictEqual(body.data.billingAddress, body.data.shippingAddress);
        assert.ok(body.data.billingAddress.includes('Tower A'));
        assert.ok(body.data.shippingAddress.includes('Shed 12'));

        // Verify direct from database
        const fromDb = await prisma.invoice.findUnique({ where: { id: distinctId } });
        assert.strictEqual(fromDb.billingAddress, 'Billing HQ: Tower A, Financial District, Hyderabad');
        assert.strictEqual(fromDb.shippingAddress, 'Shipping Depot: Shed 12, Logistic Park, Shamshabad');
    });

    it('31. invalid email format is rejected with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Invalid Email Corp',
                clientEmail: 'not-an-email-at-all',
                invoiceDate: '2026-07-05',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Invalid client email format'));
    });

    it('32. phone exceeding 50 characters is rejected with 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Long Phone Corp',
                clientPhone: '+1-555-' + '9'.repeat(55),
                invoiceDate: '2026-07-05',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('phone number must not exceed 50 characters'));
    });

    it('33. text fields exceeding 65535 characters are rejected with 400 Bad Request', async () => {
        const hugeText = 'X'.repeat(65536);
        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'INVOICE',
                clientName: 'Huge Address Corp',
                billingAddress: hugeText,
                invoiceDate: '2026-07-05',
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Billing address must not exceed 65535 characters'));
    });

    it('34. pre-existing invoices seeded before migration return null for snapshot fields without error and remain updatable', async () => {
        // Query the pre-existing testInvoiceId created before the snapshot tests
        const preExistingDoc = await invoiceService.getInvoiceById(testInvoiceId);
        assert.strictEqual(preExistingDoc.clientEmail, null);
        assert.strictEqual(preExistingDoc.clientPhone, null);
        assert.strictEqual(preExistingDoc.billingAddress, null);
        assert.strictEqual(preExistingDoc.shippingAddress, null);
        assert.strictEqual(preExistingDoc.termsAndConditions, null);
        assert.strictEqual(preExistingDoc.remarks, null);

        // Update pre-existing document to add snapshot fields
        const updateRes = await fetch(`${baseUrl}/api/invoices/${testInvoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: preExistingDoc.version,
                clientName: preExistingDoc.clientName,
                clientEmail: 'seeded.migration@client.com',
                billingAddress: 'Original Seeded Building, Floor 1',
                invoiceDate: '2026-06-05',
                items: [{ name: 'Invoice Item 1', quantity: 1, unit: 'Project', rate: 5000 }]
            })
        });

        assert.strictEqual(updateRes.status, 200);
        const updated = await invoiceService.getInvoiceById(testInvoiceId);
        assert.strictEqual(updated.clientEmail, 'seeded.migration@client.com');
        assert.strictEqual(updated.billingAddress, 'Original Seeded Building, Floor 1');
    });

    it('35. GET /documents/:id/edit HTML page renders populated snapshot fields in form inputs', async () => {
        const editPageRes = await fetch(`${baseUrl}/documents/${snapshotQuotationId}/edit`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(editPageRes.status, 200);
        const html = await editPageRes.text();

        assert.ok(html.includes('updated.billing@snapshotcorp.com'), 'HTML should contain client email in input');
        assert.ok(html.includes('+91 9999988888'), 'HTML should contain client phone in input');
        assert.ok(html.includes('999 New Boulevard'), 'HTML should contain billing address in textarea');
        assert.ok(html.includes('888 Warehouse Lane'), 'HTML should contain shipping address in textarea');
        assert.ok(html.includes('Updated terms: 50% advance'), 'HTML should contain terms in textarea');
        assert.ok(html.includes('Client requested rush delivery'), 'HTML should contain remarks in textarea');
    });
});
