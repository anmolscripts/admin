const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const invoiceService = require('../app/services/invoice.service');

describe('Invoice Module Backend Test Suite', () => {
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
        csrfToken = extractCsrfToken(await getLoginRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: adminEmail,
                password: adminPassword
            }).toString(),
            redirect: 'manual'
        });

        authCookie = extractCookie(loginRes);
        assert.ok(authCookie, 'Should successfully obtain session cookie for tests');

        // Extract fresh CSRF token from authenticated dashboard
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        csrfToken = extractCsrfToken(await dashRes.text());
        assert.ok(csrfToken, 'Should successfully obtain post-auth CSRF token');
    });

    after(async () => {
        if (server && server.closeAllConnections) server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await prisma.$disconnect();
    });

    // 1. create invoice
    it('1. create invoice successfully with calculated totals and items', async () => {
        const payload = {
            clientName: 'Alpha Tech Corp',
            invoiceDate: '2026-03-01',
            gstEnabled: true,
            gstRate: 18,
            items: [
                { name: 'Software Development', quantity: 2, rate: 5000, unit: 'Days' },
                { name: 'Deployment Server', quantity: 1, rate: 2500, unit: 'Unit' }
            ]
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.ok(body.data.id);
        assert.ok(body.data.invoiceNumber.startsWith('INV-2026-'));
        assert.strictEqual(body.data.clientName, 'Alpha Tech Corp');
        assert.strictEqual(Number(body.data.subtotal), 12500); // (2*5000) + (1*2500)
        assert.strictEqual(Number(body.data.gstAmount), 2250); // 12500 * 0.18
        assert.strictEqual(Number(body.data.grandTotal), 14750);
        assert.strictEqual(body.data.status, 'ACTIVE');
        assert.strictEqual(body.data.version, 1);
        assert.strictEqual(body.data.items.length, 2);
    });

    // 2. create invoice without authentication
    it('2. create invoice without authentication is rejected', async () => {
        const payload = {
            clientName: 'Unauthenticated Request',
            invoiceDate: '2026-03-01',
            items: [{ name: 'Test', quantity: 1, rate: 100 }]
        };

        const unauthGet = await fetch(`${baseUrl}/login`);
        const unauthCookie = extractCookie(unauthGet);
        const unauthCsrf = extractCsrfToken(await unauthGet.text());

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': unauthCsrf,
                Cookie: unauthCookie
            },
            body: JSON.stringify(payload),
            redirect: 'manual'
        });

        // requireAuth rejects unauthenticated requests with redirect 302 or 401
        assert.ok(res.status === 302 || res.status === 401);
        if (res.status === 302) {
            assert.strictEqual(res.headers.get('location'), '/login');
        }
    });

    // 3. missing client name
    it('3. missing client name returns 400 Bad Request', async () => {
        const payload = {
            clientName: '   ',
            invoiceDate: '2026-03-01',
            items: [{ name: 'Item 1', quantity: 1, rate: 100 }]
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('Client name is required'));
    });

    // 4. missing invoice date
    it('4. missing invoice date returns 400 Bad Request', async () => {
        const payload = {
            clientName: 'Valid Client',
            invoiceDate: '',
            items: [{ name: 'Item 1', quantity: 1, rate: 100 }]
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('Invoice date is required'));
    });

    // 5. missing items
    it('5. missing items array returns 400 Bad Request', async () => {
        const payload = {
            clientName: 'Valid Client',
            invoiceDate: '2026-03-01',
            items: []
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('at least one line item'));
    });

    // 6. invalid quantity
    it('6. invalid quantity (<= 0) returns 400 Bad Request', async () => {
        const payload = {
            clientName: 'Valid Client',
            invoiceDate: '2026-03-01',
            items: [{ name: 'Item 1', quantity: 0, rate: 100 }]
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('Quantity must be greater than zero'));
    });

    // 7. invalid rate
    it('7. invalid rate (< 0) returns 400 Bad Request', async () => {
        const payload = {
            clientName: 'Valid Client',
            invoiceDate: '2026-03-01',
            items: [{ name: 'Item 1', quantity: 1, rate: -10 }]
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('Rate must be greater than or equal to zero'));
    });

    // 8. invalid GST rate
    it('8. invalid GST rate returns 400 Bad Request', async () => {
        const payload = {
            clientName: 'Valid Client',
            invoiceDate: '2026-03-01',
            gstEnabled: true,
            gstRate: 25, // Not in [5, 12, 18, 28]
            items: [{ name: 'Item 1', quantity: 1, rate: 100 }]
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('Invalid GST rate'));
    });

    // 9. GST calculation
    it('9. GST calculation applies exact percentage', () => {
        const result = invoiceService.calculateInvoiceTotals({
            items: [
                { name: 'Service A', quantity: 3, rate: 100 },
                { name: 'Service B', quantity: 2, rate: 50 }
            ],
            gstEnabled: true,
            gstRate: 18
        });

        assert.strictEqual(result.subtotal, 400); // 300 + 100
        assert.strictEqual(result.gstAmount, 72); // 400 * 0.18
        assert.strictEqual(result.grandTotal, 472);
        assert.strictEqual(result.roundOff, 0);
    });

    // 10. no-GST calculation
    it('10. no-GST calculation sets gstRate and gstAmount to 0', () => {
        const result = invoiceService.calculateInvoiceTotals({
            items: [{ name: 'Service C', quantity: 4, rate: 250 }],
            gstEnabled: false,
            gstRate: 18 // Should be ignored when gstEnabled is false
        });

        assert.strictEqual(result.subtotal, 1000);
        assert.strictEqual(result.gstRate, 0);
        assert.strictEqual(result.gstAmount, 0);
        assert.strictEqual(result.grandTotal, 1000);
        assert.strictEqual(result.roundOff, 0);
    });

    // 11. round-off calculation
    it('11. round-off calculation correctly computes nearest whole rupee', () => {
        // subtotal 100.50, gst 18% -> gstAmount 18.09 -> totalBeforeRound 118.59 -> grandTotal 119 -> roundOff +0.41
        const result1 = invoiceService.calculateInvoiceTotals({
            items: [{ name: 'Item', quantity: 1, rate: 100.50 }],
            gstEnabled: true,
            gstRate: 18
        });

        assert.strictEqual(result1.subtotal, 100.50);
        assert.strictEqual(result1.gstAmount, 18.09);
        assert.strictEqual(result1.grandTotal, 119);
        assert.strictEqual(result1.roundOff, 0.41);

        // subtotal 100.20, gst 12% -> gstAmount 12.02 -> totalBeforeRound 112.22 -> grandTotal 112 -> roundOff -0.22
        const result2 = invoiceService.calculateInvoiceTotals({
            items: [{ name: 'Item', quantity: 1, rate: 100.20 }],
            gstEnabled: true,
            gstRate: 12
        });
        assert.strictEqual(result2.subtotal, 100.20);
        assert.strictEqual(result2.gstAmount, 12.02);
        assert.strictEqual(result2.grandTotal, 112);
        assert.strictEqual(result2.roundOff, -0.22);
    });

    // 12. get invoice
    it('12. get invoice by ID returns full invoice with items and revisions', async () => {
        // Query one of the seeded invoices
        const seeded = await prisma.invoice.findFirst({
            where: { invoiceNumber: 'INV-2026-0001' }
        });
        assert.ok(seeded, 'Seeded invoice INV-2026-0001 should exist');

        const res = await fetch(`${baseUrl}/api/invoices/${seeded.id}`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.id, seeded.id);
        assert.strictEqual(body.data.invoiceNumber, 'INV-2026-0001');
        assert.ok(Array.isArray(body.data.items) && body.data.items.length > 0);
        assert.ok(Array.isArray(body.data.revisions) && body.data.revisions.length > 0);
    });

    // 13. get nonexistent invoice
    it('13. get nonexistent invoice returns 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/999999`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 404);
        const body = await res.json();
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('was not found'));
    });

    // 14. update invoice
    it('14. update invoice increments version and creates revision', async () => {
        // Create an invoice to update
        const created = await invoiceService.createInvoice({
            clientName: 'Client Before Update',
            invoiceDate: '2026-03-05',
            gstEnabled: false,
            items: [{ name: 'Initial Item', quantity: 1, rate: 500 }]
        }, 1);

        assert.strictEqual(created.version, 1);

        const updatePayload = {
            version: 1,
            clientName: 'Client After Update',
            invoiceDate: '2026-03-06',
            gstEnabled: true,
            gstRate: 18,
            items: [
                { name: 'Updated Item 1', quantity: 2, rate: 1000 },
                { name: 'Updated Item 2', quantity: 1, rate: 500 }
            ]
        };

        const res = await fetch(`${baseUrl}/api/invoices/${created.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(updatePayload)
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.clientName, 'Client After Update');
        assert.strictEqual(body.data.version, 2);
        assert.strictEqual(Number(body.data.subtotal), 2500);
        assert.strictEqual(Number(body.data.grandTotal), 2950);

        // Verify revision was created
        const revisions = await prisma.invoiceRevision.findMany({
            where: { invoiceId: created.id },
            orderBy: { revisionNo: 'asc' }
        });
        assert.strictEqual(revisions.length, 2);
        assert.strictEqual(revisions[1].action, 'UPDATED');
        assert.strictEqual(revisions[1].revisionNo, 2);
    });

    // 15. optimistic concurrency conflict
    it('15. optimistic concurrency conflict returns 409 Conflict when version mismatches', async () => {
        // Create invoice
        const created = await invoiceService.createInvoice({
            clientName: 'Concurrency Test Client',
            invoiceDate: '2026-03-05',
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, 1);

        // Try to update with wrong version (e.g. version: 99 instead of 1)
        const updatePayload = {
            version: 99,
            clientName: 'Outdated Update',
            invoiceDate: '2026-03-05',
            items: [{ name: 'Item', quantity: 1, rate: 200 }]
        };

        const res = await fetch(`${baseUrl}/api/invoices/${created.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(updatePayload)
        });

        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.strictEqual(body.success, false);
        assert.ok(body.error.includes('Conflict'));
    });

    // 16. search invoice
    it('16. search invoice by client name and invoice number', async () => {
        const res = await fetch(`${baseUrl}/api/invoices?search=Acme`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.ok(body.data.length >= 1);
        assert.ok(body.data.some(inv => inv.clientName.includes('Acme')));
    });

    // 17. filter active
    it('17. filter active invoices returns only ACTIVE status', async () => {
        const res = await fetch(`${baseUrl}/api/invoices?status=ACTIVE`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.ok(body.data.length >= 1);
        assert.ok(body.data.every(inv => inv.status === 'ACTIVE'));
    });

    // 18. filter inactive
    it('18. filter inactive invoices returns only INACTIVE status', async () => {
        const res = await fetch(`${baseUrl}/api/invoices?status=INACTIVE`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.ok(body.data.length >= 1);
        assert.ok(body.data.every(inv => inv.status === 'INACTIVE'));
    });

    // 19. filter void
    it('19. filter void invoices returns only VOID status', async () => {
        const res = await fetch(`${baseUrl}/api/invoices?status=VOID`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.ok(body.data.length >= 1);
        assert.ok(body.data.every(inv => inv.status === 'VOID'));
    });

    // 20. revision creation
    it('20. revision creation records accurate history with user and action', async () => {
        const created = await invoiceService.createInvoice({
            clientName: 'Revision History Corp',
            invoiceDate: '2026-03-10',
            items: [{ name: 'Consulting', quantity: 5, rate: 1000 }]
        }, 1);

        const res = await fetch(`${baseUrl}/api/invoices/${created.id}/history`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.invoiceId, created.id);
        assert.ok(body.data.revisions.length >= 1);
        assert.strictEqual(body.data.revisions[0].revisionNo, 1);
        assert.strictEqual(body.data.revisions[0].action, 'CREATED');
        assert.ok(body.data.revisions[0].changedBy.email);
    });

    // 21. activate invoice
    it('21. activate invoice transitions status to ACTIVE and records ACTIVATED revision', async () => {
        // Start with INACTIVE invoice
        const created = await invoiceService.createInvoice({
            clientName: 'Activation Target',
            invoiceDate: '2026-03-10',
            items: [{ name: 'Item', quantity: 1, rate: 500 }]
        }, 1);
        await invoiceService.updateInvoiceStatus(created.id, 'INACTIVE', 1);

        const res = await fetch(`${baseUrl}/api/invoices/${created.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'ACTIVE' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.status, 'ACTIVE');

        const revisions = await prisma.invoiceRevision.findMany({
            where: { invoiceId: created.id },
            orderBy: { revisionNo: 'desc' }
        });
        assert.strictEqual(revisions[0].action, 'ACTIVATED');
    });

    // 22. deactivate invoice
    it('22. deactivate invoice transitions status to INACTIVE and records DEACTIVATED revision', async () => {
        const created = await invoiceService.createInvoice({
            clientName: 'Deactivation Target',
            invoiceDate: '2026-03-10',
            items: [{ name: 'Item', quantity: 1, rate: 500 }]
        }, 1);

        const res = await fetch(`${baseUrl}/api/invoices/${created.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'INACTIVE' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.status, 'INACTIVE');

        const revisions = await prisma.invoiceRevision.findMany({
            where: { invoiceId: created.id },
            orderBy: { revisionNo: 'desc' }
        });
        assert.strictEqual(revisions[0].action, 'DEACTIVATED');
    });

    // 23. void invoice
    it('23. void invoice transitions status to VOID and locks invoice from further edits', async () => {
        const created = await invoiceService.createInvoice({
            clientName: 'Void Target',
            invoiceDate: '2026-03-10',
            items: [{ name: 'Item', quantity: 1, rate: 500 }]
        }, 1);

        // Void invoice
        const res = await fetch(`${baseUrl}/api/invoices/${created.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'VOID' })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.data.status, 'VOID');

        // Attempting to modify VOID invoice must be rejected
        const editRes = await fetch(`${baseUrl}/api/invoices/${created.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: body.data.version,
                clientName: 'Attempted Change to Void',
                invoiceDate: '2026-03-10',
                items: [{ name: 'Item', quantity: 1, rate: 500 }]
            })
        });

        assert.strictEqual(editRes.status, 400);
        const editBody = await editRes.json();
        assert.ok(editBody.error.includes('VOID status'));
    });

    // 24. invoice number uniqueness
    it('24. invoice number uniqueness is strictly enforced by database unique constraint', async () => {
        const existing = await prisma.invoice.findFirst();
        assert.ok(existing);

        // Attempting to insert another invoice with same invoiceNumber must fail unique constraint
        await assert.rejects(async () => {
            await prisma.invoice.create({
                data: {
                    invoiceNumber: existing.invoiceNumber,
                    clientName: 'Duplicate Test',
                    invoiceDate: new Date(),
                    subtotal: '100.00',
                    gstAmount: '0.00',
                    roundOff: '0.00',
                    grandTotal: '100.00',
                    createdById: 1,
                    updatedById: 1
                }
            });
        }, /Unique constraint failed/);
    });

    // 25. yearly invoice number sequence
    it('25. yearly invoice number sequence generates sequential format per year', async () => {
        const testYear = 3028;
        await prisma.invoiceNumberSequence.deleteMany({
            where: { year: { in: [testYear, testYear + 1] } }
        });

        const num1 = await prisma.$transaction((tx) => invoiceService.generateInvoiceNumber(tx, `${testYear}-01-01`));
        const num2 = await prisma.$transaction((tx) => invoiceService.generateInvoiceNumber(tx, `${testYear}-06-15`));
        const numNextYear = await prisma.$transaction((tx) => invoiceService.generateInvoiceNumber(tx, `${testYear + 1}-01-01`));

        assert.strictEqual(num1, `INV-${testYear}-0001`);
        assert.strictEqual(num2, `INV-${testYear}-0002`);
        assert.strictEqual(numNextYear, `INV-${testYear + 1}-0001`);

        // Clean up
        await prisma.invoiceNumberSequence.deleteMany({
            where: { year: { in: [testYear, testYear + 1] } }
        });
    });

    // 26. server-calculated totals cannot be overridden by client
    it('26. server-calculated totals cannot be overridden by client submitted fake values', async () => {
        const fakePayload = {
            clientName: 'Client Trying to Forge Totals',
            invoiceDate: '2026-03-15',
            gstEnabled: true,
            gstRate: 18,
            // Client attempts to send forged zero/low totals
            subtotal: 1.00,
            gstAmount: 0.00,
            roundOff: 0.00,
            grandTotal: 1.00,
            items: [
                { name: 'Legitimate Item', quantity: 10, rate: 1000, amount: 1.00 } // Forged item amount
            ]
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(fakePayload)
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        // Server MUST recalculate: 10 * 1000 = 10000, GST 18% = 1800, Grand Total = 11800
        assert.strictEqual(Number(body.data.subtotal), 10000);
        assert.strictEqual(Number(body.data.gstAmount), 1800);
        assert.strictEqual(Number(body.data.grandTotal), 11800);
        assert.strictEqual(Number(body.data.items[0].amount), 10000);
    });

    // 27. concurrent invoice-number generation
    it('27. concurrent invoice creations generate strictly unique sequential numbers for the same year', async () => {
        const testYear = 2088;
        await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `INV-${testYear}-` } } });
        await prisma.invoiceNumberSequence.deleteMany({ where: { year: testYear } });

        const concurrentCount = 5;
        const promises = Array.from({ length: concurrentCount }, (_, i) => {
            return fetch(`${baseUrl}/api/invoices`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({
                    clientName: `Concurrent Test Client ${i + 1}`,
                    invoiceDate: `${testYear}-04-01`,
                    gstEnabled: false,
                    items: [{ name: `Line ${i + 1}`, quantity: 1, rate: 100 }]
                })
            }).then(r => r.json());
        });

        const responses = await Promise.all(promises);
        const invoiceNumbers = responses.map(r => {
            assert.strictEqual(r.success, true);
            return r.data.invoiceNumber;
        });

        // Ensure all 5 invoice numbers are distinct
        const uniqueSet = new Set(invoiceNumbers);
        assert.strictEqual(uniqueSet.size, concurrentCount, 'Every concurrent invoice must have a unique invoice number');

        // Ensure numbers are strictly sequential: INV-2088-0001 through INV-2088-0005
        invoiceNumbers.sort();
        for (let i = 0; i < concurrentCount; i++) {
            const expected = `INV-${testYear}-${String(i + 1).padStart(4, '0')}`;
            assert.strictEqual(invoiceNumbers[i], expected);
        }

        // Verify sequence table
        const seqRecord = await prisma.invoiceNumberSequence.findUnique({
            where: {
                documentType_year: { documentType: 'INVOICE', year: testYear }
            }
        });
        assert.ok(seqRecord);
        assert.strictEqual(seqRecord.currentNumber, concurrentCount);

        // Cleanup
        await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `INV-${testYear}-` } } });
        await prisma.invoiceNumberSequence.deleteMany({ where: { year: testYear } });
    });

    // 28. concurrent update concurrency (optimistic locking)
    it('28. two concurrent updates against the same invoice version result in exactly one success and one 409 conflict', async () => {
        // Create an invoice
        const createRes = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                clientName: 'Concurrency Update Target',
                invoiceDate: '2026-06-01',
                gstEnabled: false,
                items: [{ name: 'Initial Line', quantity: 1, rate: 250 }]
            })
        });
        const created = await createRes.json();
        const invoiceId = created.data.id;
        const initialVersion = created.data.version;

        // Perform two simultaneous updates both passing initialVersion
        const update1 = fetch(`${baseUrl}/api/invoices/${invoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: initialVersion,
                clientName: 'Updated By Worker 1',
                invoiceDate: '2026-06-01',
                gstEnabled: false,
                items: [{ name: 'Worker 1 Line', quantity: 1, rate: 300 }]
            })
        });

        const update2 = fetch(`${baseUrl}/api/invoices/${invoiceId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: initialVersion,
                clientName: 'Updated By Worker 2',
                invoiceDate: '2026-06-01',
                gstEnabled: false,
                items: [{ name: 'Worker 2 Line', quantity: 1, rate: 400 }]
            })
        });

        const [res1, res2] = await Promise.all([update1, update2]);
        const statuses = [res1.status, res2.status].sort();

        // Exactly one must be 200 and one must be 409
        assert.deepStrictEqual(statuses, [200, 409]);

        const conflictRes = res1.status === 409 ? res1 : res2;
        const conflictBody = await conflictRes.json();
        assert.strictEqual(conflictBody.success, false);
        assert.ok(conflictBody.error.includes('Conflict'));

        // Verify database invoice has version incremented exactly once (version 2)
        const inDb = await prisma.invoice.findUnique({ where: { id: invoiceId } });
        assert.strictEqual(inDb.version, 2);

        // Cleanup
        await prisma.invoice.delete({ where: { id: invoiceId } });
    });

    // 29. status transition state machine - allowed transitions
    it('29. status transition state machine allows ACTIVE->INACTIVE, INACTIVE->ACTIVE, ACTIVE->VOID, INACTIVE->VOID', async () => {
        // Create an ACTIVE invoice
        const createRes = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                clientName: 'State Machine Flow Client',
                invoiceDate: '2026-07-01',
                gstEnabled: false,
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        const inv = (await createRes.json()).data;

        // 1. ACTIVE -> INACTIVE
        const toInactiveRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'INACTIVE' })
        });
        assert.strictEqual(toInactiveRes.status, 200);
        const inactiveBody = await toInactiveRes.json();
        assert.strictEqual(inactiveBody.data.status, 'INACTIVE');

        // 2. INACTIVE -> ACTIVE
        const toActiveRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'ACTIVE' })
        });
        assert.strictEqual(toActiveRes.status, 200);
        const activeBody = await toActiveRes.json();
        assert.strictEqual(activeBody.data.status, 'ACTIVE');

        // 3. ACTIVE -> VOID
        const toVoidRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'VOID' })
        });
        assert.strictEqual(toVoidRes.status, 200);
        const voidBody = await toVoidRes.json();
        assert.strictEqual(voidBody.data.status, 'VOID');

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv.id } });

        // 4. Test INACTIVE -> VOID on another invoice
        const inv2 = await invoiceService.createInvoice({
            clientName: 'Second State Client',
            invoiceDate: '2026-07-02',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(inv2.id, 'INACTIVE', testUserId);

        const inactiveToVoidRes = await fetch(`${baseUrl}/api/invoices/${inv2.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'VOID' })
        });
        assert.strictEqual(inactiveToVoidRes.status, 200);
        const inv2Void = await inactiveToVoidRes.json();
        assert.strictEqual(inv2Void.data.status, 'VOID');

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv2.id } });
    });

    // 30. status transition state machine - disallowed VOID transitions
    it('30. status transition state machine strictly disallows VOID->ACTIVE, VOID->INACTIVE, and VOID->VOID', async () => {
        const inv = await invoiceService.createInvoice({
            clientName: 'Terminal VOID Client',
            invoiceDate: '2026-07-03',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(inv.id, 'VOID', testUserId);

        // Attempt VOID -> ACTIVE
        const toActive = await fetch(`${baseUrl}/api/invoices/${inv.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'ACTIVE' })
        });
        assert.strictEqual(toActive.status, 400);
        const activeErr = await toActive.json();
        assert.ok(activeErr.error.includes('VOID'));

        // Attempt VOID -> INACTIVE
        const toInactive = await fetch(`${baseUrl}/api/invoices/${inv.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'INACTIVE' })
        });
        assert.strictEqual(toInactive.status, 400);
        const inactiveErr = await toInactive.json();
        assert.ok(inactiveErr.error.includes('VOID'));

        // Attempt VOID -> VOID
        const toVoid = await fetch(`${baseUrl}/api/invoices/${inv.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'VOID' })
        });
        assert.strictEqual(toVoid.status, 400);
        const voidErr = await toVoid.json();
        assert.ok(voidErr.error.includes('VOID'));

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv.id } });
    });

    // 31. status transition state machine - sensible no-ops (ACTIVE->ACTIVE, INACTIVE->INACTIVE)
    it('31. status no-op transitions (ACTIVE->ACTIVE, INACTIVE->INACTIVE) succeed without creating meaningless revisions', async () => {
        const inv = await invoiceService.createInvoice({
            clientName: 'No-Op Transition Client',
            invoiceDate: '2026-07-04',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);

        const revsBefore = await prisma.invoiceRevision.count({ where: { invoiceId: inv.id } });
        assert.strictEqual(revsBefore, 1);

        // ACTIVE -> ACTIVE
        const noOpActiveRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'ACTIVE' })
        });
        assert.strictEqual(noOpActiveRes.status, 200);

        const revsAfterActive = await prisma.invoiceRevision.count({ where: { invoiceId: inv.id } });
        assert.strictEqual(revsAfterActive, 1, 'No revision should be created for ACTIVE -> ACTIVE no-op');

        // Transition to INACTIVE
        await invoiceService.updateInvoiceStatus(inv.id, 'INACTIVE', testUserId);
        const revsAfterInactive = await prisma.invoiceRevision.count({ where: { invoiceId: inv.id } });
        assert.strictEqual(revsAfterInactive, 2);

        // INACTIVE -> INACTIVE
        const noOpInactiveRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'INACTIVE' })
        });
        assert.strictEqual(noOpInactiveRes.status, 200);

        const revsFinal = await prisma.invoiceRevision.count({ where: { invoiceId: inv.id } });
        assert.strictEqual(revsFinal, 2, 'No revision should be created for INACTIVE -> INACTIVE no-op');

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv.id } });
    });

    // 32. revision history audit details
    it('32. revision history records sequential revision numbers, snapshot integrity, and exact changed fields', async () => {
        const inv = await invoiceService.createInvoice({
            clientName: 'Audit Trail Client',
            invoiceDate: '2026-07-05',
            gstEnabled: false,
            items: [{ name: 'Item A', quantity: 1, rate: 100 }]
        }, testUserId);

        // Update invoice
        await invoiceService.updateInvoice(inv.id, {
            version: 1,
            clientName: 'Audit Trail Client Renamed',
            invoiceDate: '2026-07-06',
            gstEnabled: true,
            gstRate: 18,
            items: [
                { name: 'Item A', quantity: 2, rate: 100 },
                { name: 'Item B', quantity: 1, rate: 50 }
            ]
        }, testUserId);

        const history = await invoiceService.getInvoiceHistory(inv.id);
        assert.strictEqual(history.revisions.length, 2);

        const rev1 = history.revisions.find(r => r.revisionNo === 1);
        const rev2 = history.revisions.find(r => r.revisionNo === 2);

        assert.ok(rev1);
        assert.strictEqual(rev1.action, 'CREATED');
        assert.strictEqual(rev1.changedById, testUserId);
        assert.ok(rev1.snapshot);
        assert.strictEqual(rev1.snapshot.clientName, 'Audit Trail Client');

        assert.ok(rev2);
        assert.strictEqual(rev2.action, 'UPDATED');
        assert.strictEqual(rev2.changedById, testUserId);
        assert.ok(rev2.snapshot);
        assert.strictEqual(rev2.snapshot.clientName, 'Audit Trail Client Renamed');
        assert.ok(rev2.changes.changedFields);
        assert.strictEqual(rev2.changes.changedFields.clientName.from, 'Audit Trail Client');
        assert.strictEqual(rev2.changes.changedFields.clientName.to, 'Audit Trail Client Renamed');

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv.id } });
    });

    // 33. calculation engine edge cases and all GST rates
    it('33. calculation engine correctly computes 5%, 12%, 18%, 28%, decimal quantities, and round-off edge cases', () => {
        // GST rates test
        const rates = [5, 12, 18, 28];
        rates.forEach(rate => {
            const res = invoiceService.calculateInvoiceTotals({
                items: [{ name: 'Rate Test', quantity: 1, rate: 1000 }],
                gstEnabled: true,
                gstRate: rate
            });
            assert.strictEqual(res.subtotal, 1000);
            assert.strictEqual(res.gstAmount, 1000 * (rate / 100));
            assert.strictEqual(res.grandTotal, 1000 + 1000 * (rate / 100));
            assert.strictEqual(res.roundOff, 0);
        });

        // Decimal quantity & decimal rate
        const decRes = invoiceService.calculateInvoiceTotals({
            items: [
                { name: 'Consulting Hours', quantity: 2.75, rate: 1250.50 }
            ],
            gstEnabled: false
        });
        // 2.75 * 1250.50 = 3438.875 -> rounded to 3438.88
        assert.strictEqual(decRes.subtotal, 3438.88);
        assert.strictEqual(decRes.grandTotal, 3439);
        assert.strictEqual(decRes.roundOff, 0.12);

        // Rounding down edge case (e.g. 100.40 -> 100, roundOff -0.40)
        const roundDownRes = invoiceService.calculateInvoiceTotals({
            items: [{ name: 'Test', quantity: 1, rate: 100.40 }],
            gstEnabled: false
        });
        assert.strictEqual(roundDownRes.subtotal, 100.40);
        assert.strictEqual(roundDownRes.grandTotal, 100);
        assert.strictEqual(roundDownRes.roundOff, -0.40);

        // Rounding up edge case (e.g. 100.60 -> 101, roundOff +0.40)
        const roundUpRes = invoiceService.calculateInvoiceTotals({
            items: [{ name: 'Test', quantity: 1, rate: 100.60 }],
            gstEnabled: false
        });
        assert.strictEqual(roundUpRes.subtotal, 100.60);
        assert.strictEqual(roundUpRes.grandTotal, 101);
        assert.strictEqual(roundUpRes.roundOff, 0.40);
    });

    // 34. pagination defaults, max page size cap, search, and empty results
    it('34. pagination caps excessive page size at 100, defaults page to 1, and handles empty searches gracefully', async () => {
        // Test default pagination
        const defaultList = await invoiceService.listInvoices();
        assert.strictEqual(defaultList.pagination.page, 1);
        assert.strictEqual(defaultList.pagination.limit, 10);

        // Test excessive limit cap
        const cappedList = await invoiceService.listInvoices({ limit: 500 });
        assert.strictEqual(cappedList.pagination.limit, 100, 'Page size must be capped at 100 maximum');

        // Test search by invoiceNumber
        const searchRes = await invoiceService.listInvoices({ search: 'INV-2026-0001' });
        assert.ok(searchRes.data.length >= 1);
        assert.strictEqual(searchRes.data[0].invoiceNumber, 'INV-2026-0001');

        // Test empty search results
        const emptyRes = await invoiceService.listInvoices({ search: 'NonexistentClientXYZ999999' });
        assert.deepStrictEqual(emptyRes.data, []);
        assert.strictEqual(emptyRes.pagination.total, 0);
        assert.strictEqual(emptyRes.pagination.totalPages, 1);
    });

    // 35. audit field spoofing protection and unauthenticated API rejection
    it('35. invoice audit fields cannot be spoofed by client and all invoice endpoints reject unauthenticated access', async () => {
        // Attempt to spoof createdById/updatedById in create
        const createRes = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                clientName: 'Spoof Test Client',
                invoiceDate: '2026-08-01',
                gstEnabled: false,
                createdById: 9999, // Malicious spoof
                updatedById: 9999, // Malicious spoof
                items: [{ name: 'Item', quantity: 1, rate: 100 }]
            })
        });
        const createdBody = await createRes.json();
        assert.strictEqual(createRes.status, 201);
        assert.strictEqual(createdBody.data.createdById, testUserId, 'createdById must come from session, not client body');
        assert.strictEqual(createdBody.data.updatedById, testUserId, 'updatedById must come from session, not client body');

        // Verify unauthenticated requests to all invoice endpoints are rejected
        const endpoints = [
            { method: 'GET', url: `${baseUrl}/api/invoices` },
            { method: 'POST', url: `${baseUrl}/api/invoices` },
            { method: 'GET', url: `${baseUrl}/api/invoices/${createdBody.data.id}` },
            { method: 'PUT', url: `${baseUrl}/api/invoices/${createdBody.data.id}` },
            { method: 'PATCH', url: `${baseUrl}/api/invoices/${createdBody.data.id}/status` },
            { method: 'GET', url: `${baseUrl}/api/invoices/${createdBody.data.id}/history` }
        ];

        for (const ep of endpoints) {
            const res = await fetch(ep.url, { method: ep.method, redirect: 'manual' });
            assert.ok([302, 401, 403].includes(res.status), `${ep.method} ${ep.url} should reject unauthenticated request, got ${res.status}`);
        }

        // Cleanup
        await prisma.invoice.delete({ where: { id: createdBody.data.id } });
    });

    // 36. quotation creation & QTN prefix
    it('36. quotation creation generates QTN prefix and assigns documentType QUOTATION', async () => {
        const payload = {
            documentType: 'QUOTATION',
            clientName: 'Quotation Test Corp',
            invoiceDate: '2026-03-20',
            gstEnabled: true,
            gstRate: 18,
            items: [{ name: 'Architectural Blueprint', quantity: 1, rate: 45000 }]
        };

        const res = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.documentType, 'QUOTATION');
        assert.ok(body.data.invoiceNumber.startsWith('QTN-2026-'));
        assert.strictEqual(body.data.status, 'ACTIVE');

        // Check revision
        const rev = await prisma.invoiceRevision.findFirst({
            where: { invoiceId: body.data.id }
        });
        assert.ok(rev);
        assert.strictEqual(rev.action, 'CREATED');

        // Cleanup
        await prisma.invoice.delete({ where: { id: body.data.id } });
    });

    // 37. same year independent sequences
    it('37. same year independent sequences ensure quotation numbers do not advance invoice numbers and vice versa', async () => {
        const testYear = 2095;
        await prisma.invoice.deleteMany({
            where: {
                OR: [
                    { invoiceNumber: { startsWith: `QTN-${testYear}-` } },
                    { invoiceNumber: { startsWith: `INV-${testYear}-` } }
                ]
            }
        });
        await prisma.invoiceNumberSequence.deleteMany({ where: { year: testYear } });

        const qtn1 = await prisma.$transaction(tx => invoiceService.generateDocumentNumber(tx, 'QUOTATION', `${testYear}-01-01`));
        const inv1 = await prisma.$transaction(tx => invoiceService.generateDocumentNumber(tx, 'INVOICE', `${testYear}-01-01`));
        const qtn2 = await prisma.$transaction(tx => invoiceService.generateDocumentNumber(tx, 'QUOTATION', `${testYear}-01-01`));
        const inv2 = await prisma.$transaction(tx => invoiceService.generateDocumentNumber(tx, 'INVOICE', `${testYear}-01-01`));

        assert.strictEqual(qtn1, `QTN-${testYear}-0001`);
        assert.strictEqual(inv1, `INV-${testYear}-0001`);
        assert.strictEqual(qtn2, `QTN-${testYear}-0002`);
        assert.strictEqual(inv2, `INV-${testYear}-0002`);

        // Cleanup
        await prisma.invoiceNumberSequence.deleteMany({ where: { year: testYear } });
    });

    // 38. different year sequences reset count
    it('38. different year sequences independently start from 0001 per year', async () => {
        const y1 = 2096;
        const y2 = 2097;
        await prisma.invoiceNumberSequence.deleteMany({ where: { year: { in: [y1, y2] } } });

        const numY1 = await prisma.$transaction(tx => invoiceService.generateDocumentNumber(tx, 'QUOTATION', `${y1}-01-01`));
        const numY2 = await prisma.$transaction(tx => invoiceService.generateDocumentNumber(tx, 'QUOTATION', `${y2}-01-01`));

        assert.strictEqual(numY1, `QTN-${y1}-0001`);
        assert.strictEqual(numY2, `QTN-${y2}-0001`);

        // Cleanup
        await prisma.invoiceNumberSequence.deleteMany({ where: { year: { in: [y1, y2] } } });
    });

    // 39. concurrent quotation sequence generation
    it('39. concurrent quotation creations generate strictly unique sequential QTN numbers', async () => {
        const testYear = 2098;
        await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `QTN-${testYear}-` } } });
        await prisma.invoiceNumberSequence.deleteMany({ where: { year: testYear } });

        const count = 5;
        const promises = Array.from({ length: count }, (_, i) => {
            return invoiceService.createQuotation({
                clientName: `Concurrent Quotation Client ${i + 1}`,
                invoiceDate: `${testYear}-05-01`,
                gstEnabled: false,
                items: [{ name: `Quotation Item ${i + 1}`, quantity: 1, rate: 1000 }]
            }, testUserId);
        });

        const created = await Promise.all(promises);
        const numbers = created.map(d => d.invoiceNumber).sort();

        for (let i = 0; i < count; i++) {
            assert.strictEqual(numbers[i], `QTN-${testYear}-${String(i + 1).padStart(4, '0')}`);
        }

        const seqRecord = await prisma.invoiceNumberSequence.findUnique({
            where: { documentType_year: { documentType: 'QUOTATION', year: testYear } }
        });
        assert.strictEqual(seqRecord.currentNumber, count);

        // Cleanup
        await prisma.invoice.deleteMany({ where: { invoiceNumber: { startsWith: `QTN-${testYear}-` } } });
        await prisma.invoiceNumberSequence.deleteMany({ where: { year: testYear } });
    });

    // 40. soft-delete transitions (ACTIVE -> DELETED, INACTIVE -> DELETED)
    it('40. soft-delete preserves document, records audit information, and stores previous status', async () => {
        const inv = await invoiceService.createInvoice({
            clientName: 'Soft Delete Target Corp',
            invoiceDate: '2026-04-01',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 500 }]
        }, testUserId);

        // Delete active invoice
        const delRes = await fetch(`${baseUrl}/api/invoices/${inv.id}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ deleteReason: 'Client revoked contract terms' })
        });

        assert.strictEqual(delRes.status, 200);
        const delBody = await delRes.json();
        assert.strictEqual(delBody.data.status, 'DELETED');
        assert.strictEqual(delBody.data.previousStatusBeforeDelete, 'ACTIVE');
        assert.strictEqual(delBody.data.deleteReason, 'Client revoked contract terms');
        assert.strictEqual(delBody.data.deletedById, testUserId);
        assert.ok(delBody.data.deletedAt);

        // Verify revision was recorded
        const history = await invoiceService.getInvoiceHistory(inv.id);
        const delRev = history.revisions.find(r => r.action === 'DELETED');
        assert.ok(delRev);
        assert.strictEqual(delRev.changes.fromStatus, 'ACTIVE');

        // Test INACTIVE -> DELETED
        const inv2 = await invoiceService.createInvoice({
            clientName: 'Inactive Soft Delete Target',
            invoiceDate: '2026-04-02',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 200 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(inv2.id, 'INACTIVE', testUserId);

        const delRes2 = await fetch(`${baseUrl}/api/invoices/${inv2.id}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ deleteReason: 'No longer needed' })
        });
        const delBody2 = await delRes2.json();
        assert.strictEqual(delBody2.data.status, 'DELETED');
        assert.strictEqual(delBody2.data.previousStatusBeforeDelete, 'INACTIVE');

        // Cleanup
        await prisma.invoice.deleteMany({ where: { id: { in: [inv.id, inv2.id] } } });
    });

    // 41. restore soft-deleted document
    it('41. restore operation recovers document to previous status and clears deletion audit fields', async () => {
        const inv = await invoiceService.createInvoice({
            clientName: 'Restore Target Corp',
            invoiceDate: '2026-04-05',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 800 }]
        }, testUserId);

        // Soft delete it
        await invoiceService.softDeleteDocument(inv.id, 'Accidental deletion', testUserId);

        // Restore it
        const restoreRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/restore`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });

        assert.strictEqual(restoreRes.status, 200);
        const body = await restoreRes.json();
        assert.strictEqual(body.data.status, 'ACTIVE');
        assert.strictEqual(body.data.previousStatusBeforeDelete, null);
        assert.strictEqual(body.data.deletedAt, null);
        assert.strictEqual(body.data.deletedById, null);
        assert.strictEqual(body.data.deleteReason, null);

        // Verify RESTORED revision
        const history = await invoiceService.getInvoiceHistory(inv.id);
        const restRev = history.revisions.find(r => r.action === 'RESTORED');
        assert.ok(restRev);
        assert.strictEqual(restRev.changes.toStatus, 'ACTIVE');

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv.id } });
    });

    // 42. disallowed state transitions & editing VOID or DELETED
    it('42. disallowed transitions: cannot delete VOID, cannot edit VOID or DELETED, cannot restore non-deleted', async () => {
        const inv = await invoiceService.createInvoice({
            clientName: 'Immutability Check Corp',
            invoiceDate: '2026-04-10',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);

        // 1. Cannot restore non-deleted
        const invalidRestore = await fetch(`${baseUrl}/api/invoices/${inv.id}/restore`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(invalidRestore.status, 400);

        // 2. Void it
        await invoiceService.updateInvoiceStatus(inv.id, 'VOID', testUserId);

        // 3. Cannot soft delete a VOID document
        const voidDelete = await fetch(`${baseUrl}/api/invoices/${inv.id}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(voidDelete.status, 400);

        // 4. Cannot edit a VOID document
        const voidEdit = await fetch(`${baseUrl}/api/invoices/${inv.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: 2,
                clientName: 'Void Edit Attempt',
                invoiceDate: '2026-04-10',
                items: [{ name: 'Item', quantity: 1, rate: 200 }]
            })
        });
        assert.strictEqual(voidEdit.status, 400);

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv.id } });

        // 5. Cannot edit a DELETED document
        const inv2 = await invoiceService.createInvoice({
            clientName: 'Deleted Edit Target',
            invoiceDate: '2026-04-11',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);
        await invoiceService.softDeleteDocument(inv2.id, 'Test deletion', testUserId);

        const delEdit = await fetch(`${baseUrl}/api/invoices/${inv2.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: 2,
                clientName: 'Deleted Edit Attempt',
                invoiceDate: '2026-04-11',
                items: [{ name: 'Item', quantity: 1, rate: 200 }]
            })
        });
        assert.strictEqual(delEdit.status, 400);

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv2.id } });
    });

    // 43. quotation -> invoice conversion
    it('43. quotation conversion transactionally generates an invoice referencing source quotation', async () => {
        const qtn = await invoiceService.createQuotation({
            clientName: 'Conversion Source Corp',
            invoiceDate: '2026-04-15',
            gstEnabled: true,
            gstRate: 18,
            items: [
                { name: 'Full Stack App', quantity: 1, rate: 80000, unit: 'Project' }
            ]
        }, testUserId);

        const convRes = await fetch(`${baseUrl}/api/invoices/${qtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });

        assert.strictEqual(convRes.status, 201);
        const body = await convRes.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.documentType, 'INVOICE');
        assert.ok(body.data.invoiceNumber.startsWith('INV-2026-'));
        assert.strictEqual(body.data.sourceQuotation.id, qtn.id);
        assert.strictEqual(body.data.sourceQuotation.invoiceNumber, qtn.invoiceNumber);
        assert.strictEqual(Number(body.data.grandTotal), 94400);

        // Check that original quotation retains reference to converted invoice
        const qtnInDb = await invoiceService.getInvoiceById(qtn.id);
        assert.ok(qtnInDb.convertedInvoice);
        assert.strictEqual(qtnInDb.convertedInvoice.id, body.data.id);

        // Check revision on quotation
        const qtnHistory = await invoiceService.getInvoiceHistory(qtn.id);
        const convRev = qtnHistory.revisions.find(r => r.action === 'CONVERTED');
        assert.ok(convRev);
        assert.strictEqual(convRev.changes.convertedInvoiceId, body.data.id);

        // Cleanup
        await prisma.invoice.delete({ where: { id: body.data.id } });
        await prisma.invoice.delete({ where: { id: qtn.id } });
    });

    // 44. duplicate quotation conversion prevented
    it('44. duplicate conversion of the same quotation is rejected with 409 Conflict', async () => {
        const qtn = await invoiceService.createQuotation({
            clientName: 'Duplicate Conv Corp',
            invoiceDate: '2026-04-16',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 5000 }]
        }, testUserId);

        // First conversion succeeds
        const first = await fetch(`${baseUrl}/api/invoices/${qtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(first.status, 201);
        const firstInvoice = (await first.json()).data;

        // Second conversion attempt fails with 409
        const second = await fetch(`${baseUrl}/api/invoices/${qtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(second.status, 409);
        const err = await second.json();
        assert.ok(err.error.includes('already been converted'));

        // Cleanup
        await prisma.invoice.delete({ where: { id: firstInvoice.id } });
        await prisma.invoice.delete({ where: { id: qtn.id } });
    });

    // 45. copy document operation
    it('45. copy document returns an unsaved template with business details and no IDs or revisions', async () => {
        const inv = await invoiceService.createInvoice({
            clientName: 'Template Copy Corp',
            invoiceDate: '2026-04-20',
            gstEnabled: true,
            gstRate: 12,
            items: [{ name: 'Original Item', quantity: 3, rate: 1500 }]
        }, testUserId);

        const copyRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/copy`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(copyRes.status, 200);
        const body = await copyRes.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.clientName, 'Template Copy Corp');
        assert.strictEqual(body.data.gstEnabled, true);
        assert.strictEqual(body.data.gstRate, 12);
        assert.strictEqual(body.data.items.length, 1);
        assert.strictEqual(body.data.items[0].name, 'Original Item');
        // Unsaved template must not have id, invoiceNumber, or status
        assert.strictEqual(body.data.id, undefined);
        assert.strictEqual(body.data.invoiceNumber, undefined);
        assert.strictEqual(body.data.status, undefined);

        // Cleanup
        await prisma.invoice.delete({ where: { id: inv.id } });
    });

    // 46. migration data safety and seed verification
    it('46. migration data safety confirms existing invoices and new quotations are intact', async () => {
        const seededInvoices = await prisma.invoice.findMany({
            where: {
                invoiceNumber: { in: ['INV-2026-0001', 'INV-2026-0002', 'INV-2026-0003'] }
            }
        });
        assert.strictEqual(seededInvoices.length, 3);
        seededInvoices.forEach(inv => {
            assert.strictEqual(inv.documentType, 'INVOICE');
            assert.ok(['ACTIVE', 'INACTIVE', 'VOID'].includes(inv.status));
        });

        const seededQuotations = await prisma.invoice.findMany({
            where: {
                invoiceNumber: { in: ['QTN-2026-0001', 'QTN-2026-0002'] }
            }
        });
        assert.strictEqual(seededQuotations.length, 2);
        seededQuotations.forEach(qtn => {
            assert.strictEqual(qtn.documentType, 'QUOTATION');
            assert.ok(['ACTIVE', 'INACTIVE'].includes(qtn.status));
        });
    });

    // 47. document type immutability and update field restrictions
    it('47. document type, document number, and status cannot be modified via update', async () => {
        const inv = await invoiceService.createInvoice({
            clientName: 'Immutability Corp',
            invoiceDate: '2026-05-01',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 1000 }]
        }, testUserId);

        const qtn = await invoiceService.createQuotation({
            clientName: 'Immutability Quotation Corp',
            invoiceDate: '2026-05-01',
            gstEnabled: false,
            items: [{ name: 'Quote Service', quantity: 1, rate: 500 }]
        }, testUserId);

        // 1. Attempting to change an INVOICE into a QUOTATION returns 400
        const invToQtn = await fetch(`${baseUrl}/api/invoices/${inv.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: inv.version,
                documentType: 'QUOTATION',
                clientName: 'Immutability Corp',
                invoiceDate: '2026-05-01',
                items: [{ name: 'Service', quantity: 1, rate: 1000 }]
            })
        });
        assert.strictEqual(invToQtn.status, 400);
        const invErr = await invToQtn.json();
        assert.ok(invErr.error.includes('Document type cannot be changed once created'));

        // 2. Attempting to change a QUOTATION into an INVOICE returns 400
        const qtnToInv = await fetch(`${baseUrl}/api/invoices/${qtn.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: qtn.version,
                documentType: 'INVOICE',
                clientName: 'Immutability Quotation Corp',
                invoiceDate: '2026-05-01',
                items: [{ name: 'Quote Service', quantity: 1, rate: 500 }]
            })
        });
        assert.strictEqual(qtnToInv.status, 400);
        const qtnErr = await qtnToInv.json();
        assert.ok(qtnErr.error.includes('Document type cannot be changed once created'));

        // 3. Attempting to alter invoiceNumber via PUT returns 400
        const alterNum = await fetch(`${baseUrl}/api/invoices/${inv.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: inv.version,
                invoiceNumber: 'INV-9999-9999',
                clientName: 'Immutability Corp',
                invoiceDate: '2026-05-01',
                items: [{ name: 'Service', quantity: 1, rate: 1000 }]
            })
        });
        assert.strictEqual(alterNum.status, 400);
        const numErr = await alterNum.json();
        assert.ok(numErr.error.includes('Document number cannot be modified'));

        // 4. Attempting to alter status via PUT returns 400
        const alterStatus = await fetch(`${baseUrl}/api/invoices/${inv.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: inv.version,
                status: 'VOID',
                clientName: 'Immutability Corp',
                invoiceDate: '2026-05-01',
                items: [{ name: 'Service', quantity: 1, rate: 1000 }]
            })
        });
        assert.strictEqual(alterStatus.status, 400);
        const statusErr = await alterStatus.json();
        assert.ok(statusErr.error.includes('Document status cannot be changed via update'));

        // Cleanup
        await prisma.invoice.deleteMany({ where: { id: { in: [inv.id, qtn.id] } } });
    });

    // 48. quotation conversion validation & source rules
    it('48. conversion strictly validates source: rejects invoice, void, deleted, non-existent, and quotation source', async () => {
        // 1. Converting an INVOICE returns 400
        const inv = await invoiceService.createInvoice({
            clientName: 'Cannot Convert Invoice',
            invoiceDate: '2026-05-02',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 200 }]
        }, testUserId);

        const convInvRes = await fetch(`${baseUrl}/api/invoices/${inv.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(convInvRes.status, 400);
        const convInvBody = await convInvRes.json();
        assert.ok(convInvBody.error.includes('is an INVOICE, not a QUOTATION'));

        // 2. Converting a non-existent quotation returns 404
        const nonExistentRes = await fetch(`${baseUrl}/api/invoices/999999/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(nonExistentRes.status, 404);

        // 3. Converting a VOID quotation returns 400
        const voidQtn = await invoiceService.createQuotation({
            clientName: 'Void Quotation Target',
            invoiceDate: '2026-05-03',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 300 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(voidQtn.id, 'VOID', testUserId);

        const convVoidRes = await fetch(`${baseUrl}/api/invoices/${voidQtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(convVoidRes.status, 400);
        const convVoidBody = await convVoidRes.json();
        assert.ok(convVoidBody.error.includes('Cannot convert a VOID quotation'));

        // 4. Converting a DELETED quotation returns 400
        const delQtn = await invoiceService.createQuotation({
            clientName: 'Deleted Quotation Target',
            invoiceDate: '2026-05-04',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 400 }]
        }, testUserId);
        await invoiceService.softDeleteDocument(delQtn.id, 'Archived', testUserId);

        const convDelRes = await fetch(`${baseUrl}/api/invoices/${delQtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(convDelRes.status, 400);
        const convDelBody = await convDelRes.json();
        assert.ok(convDelBody.error.includes('Cannot convert a DELETED quotation'));

        // 4b. Converting an INACTIVE quotation returns 400
        const inactiveQtn = await invoiceService.createQuotation({
            clientName: 'Inactive Quotation Target',
            invoiceDate: '2026-05-04',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 450 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(inactiveQtn.id, 'INACTIVE', testUserId);

        const convInactiveRes = await fetch(`${baseUrl}/api/invoices/${inactiveQtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(convInactiveRes.status, 400);
        const convInactiveBody = await convInactiveRes.json();
        assert.ok(convInactiveBody.error.includes('Cannot convert a quotation in INACTIVE status'));

        // 5. Creating a QUOTATION referencing another quotation returns 400
        const validQtn = await invoiceService.createQuotation({
            clientName: 'Valid Quotation Source',
            invoiceDate: '2026-05-05',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 500 }]
        }, testUserId);

        const qtnWithSrcRes = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                documentType: 'QUOTATION',
                clientName: 'Invalid Chained Quotation',
                invoiceDate: '2026-05-05',
                sourceQuotationId: validQtn.id,
                items: [{ name: 'Service', quantity: 1, rate: 500 }]
            })
        });
        assert.strictEqual(qtnWithSrcRes.status, 400);
        const qtnWithSrcBody = await qtnWithSrcRes.json();
        assert.ok(qtnWithSrcBody.error.includes('A quotation cannot reference a source quotation'));

        // Cleanup
        await prisma.invoice.deleteMany({ where: { id: { in: [inv.id, voidQtn.id, delQtn.id, validQtn.id, inactiveQtn.id] } } });
    });

    // 49. concurrent quotation conversion race condition
    it('49. concurrent conversion of the same quotation results in exactly one success and one 409 conflict', async () => {
        const qtn = await invoiceService.createQuotation({
            clientName: 'Concurrent Conversion Target',
            invoiceDate: '2026-05-10',
            gstEnabled: true,
            gstRate: 18,
            items: [{ name: 'Concurrent Service', quantity: 2, rate: 7500 }]
        }, testUserId);

        // Send two simultaneous convert requests
        const [res1, res2] = await Promise.all([
            fetch(`${baseUrl}/api/invoices/${qtn.id}/convert`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ version: qtn.version })
            }),
            fetch(`${baseUrl}/api/invoices/${qtn.id}/convert`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ version: qtn.version })
            })
        ]);

        const statuses = [res1.status, res2.status].sort();
        assert.strictEqual(statuses[0], 201, 'One conversion request must succeed with 201');
        assert.strictEqual(statuses[1], 409, 'The other concurrent conversion request must be rejected with 409');

        // Confirm exactly one invoice was created in database for this quotation
        const converted = await prisma.invoice.findMany({
            where: { sourceQuotationId: qtn.id }
        });
        assert.strictEqual(converted.length, 1);

        // Cleanup
        await prisma.invoice.deleteMany({ where: { id: converted[0].id } });
        await prisma.invoice.delete({ where: { id: qtn.id } });
    });

    // 50. concurrent status, soft-delete, and restore concurrency protection
    it('50. status updates, soft-delete, and restore atomically reject stale concurrent requests with 409', async () => {
        // A. Concurrent status updates
        const doc1 = await invoiceService.createInvoice({
            clientName: 'Concurrent Status Corp',
            invoiceDate: '2026-05-15',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 100 }]
        }, testUserId);

        const [stRes1, stRes2] = await Promise.all([
            fetch(`${baseUrl}/api/invoices/${doc1.id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ status: 'INACTIVE', version: doc1.version })
            }),
            fetch(`${baseUrl}/api/invoices/${doc1.id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ status: 'VOID', version: doc1.version })
            })
        ]);

        const stStatuses = [stRes1.status, stRes2.status].sort();
        assert.strictEqual(stStatuses[0], 200);
        assert.strictEqual(stStatuses[1], 409);

        await prisma.invoice.delete({ where: { id: doc1.id } });

        // B. Concurrent soft-delete
        const doc2 = await invoiceService.createInvoice({
            clientName: 'Concurrent Delete Corp',
            invoiceDate: '2026-05-16',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 100 }]
        }, testUserId);

        const [delRes1, delRes2] = await Promise.all([
            fetch(`${baseUrl}/api/invoices/${doc2.id}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ deleteReason: 'User A deleted', version: doc2.version })
            }),
            fetch(`${baseUrl}/api/invoices/${doc2.id}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ deleteReason: 'User B deleted', version: doc2.version })
            })
        ]);

        const delStatuses = [delRes1.status, delRes2.status].sort();
        assert.strictEqual(delStatuses[0], 200);
        assert.strictEqual(delStatuses[1], 409);

        // C. Concurrent restore
        const deletedDoc = await invoiceService.getInvoiceById(doc2.id);
        const [rstRes1, rstRes2] = await Promise.all([
            fetch(`${baseUrl}/api/invoices/${doc2.id}/restore`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ version: deletedDoc.version })
            }),
            fetch(`${baseUrl}/api/invoices/${doc2.id}/restore`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ version: deletedDoc.version })
            })
        ]);

        const rstStatuses = [rstRes1.status, rstRes2.status].sort();
        assert.strictEqual(rstStatuses[0], 200);
        assert.strictEqual(rstStatuses[1], 409);

        await prisma.invoice.delete({ where: { id: doc2.id } });
    });

    // 51. delete and restore safety lifecycle edge cases
    it('51. delete and restore safety: cannot delete DELETED/VOID, cannot restore VOID, restoring INACTIVE recovers INACTIVE', async () => {
        // 1. Soft-deleting an already DELETED document returns 400
        const doc = await invoiceService.createInvoice({
            clientName: 'Double Delete Target',
            invoiceDate: '2026-05-20',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 100 }]
        }, testUserId);

        await invoiceService.softDeleteDocument(doc.id, 'First delete', testUserId);

        const doubleDelRes = await fetch(`${baseUrl}/api/invoices/${doc.id}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ deleteReason: 'Second delete attempt' })
        });
        assert.strictEqual(doubleDelRes.status, 400);
        const doubleDelBody = await doubleDelRes.json();
        assert.ok(doubleDelBody.error.includes('already deleted'));

        // 2. Direct PATCH status on DELETED document is rejected
        const directPatchDel = await fetch(`${baseUrl}/api/invoices/${doc.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'ACTIVE' })
        });
        assert.strictEqual(directPatchDel.status, 400);
        const directPatchBody = await directPatchDel.json();
        assert.ok(directPatchBody.error.includes('Cannot change status of a DELETED document directly'));

        // 3. Restoring an INACTIVE soft-deleted document strictly restores back to INACTIVE
        const inactDoc = await invoiceService.createInvoice({
            clientName: 'Inactive Restore Target',
            invoiceDate: '2026-05-21',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 100 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(inactDoc.id, 'INACTIVE', testUserId);
        await invoiceService.softDeleteDocument(inactDoc.id, 'Delete inactive', testUserId);

        const rstInactRes = await fetch(`${baseUrl}/api/invoices/${inactDoc.id}/restore`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(rstInactRes.status, 200);
        const rstInactBody = await rstInactRes.json();
        assert.strictEqual(rstInactBody.data.status, 'INACTIVE');
        assert.strictEqual(rstInactBody.data.previousStatusBeforeDelete, null);
        assert.strictEqual(rstInactBody.data.deletedAt, null);
        assert.strictEqual(rstInactBody.data.deletedById, null);

        // 4. VOID document cannot be restored
        const voidDoc = await invoiceService.createInvoice({
            clientName: 'Void Restore Target',
            invoiceDate: '2026-05-22',
            gstEnabled: false,
            items: [{ name: 'Service', quantity: 1, rate: 100 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(voidDoc.id, 'VOID', testUserId);

        const rstVoidRes = await fetch(`${baseUrl}/api/invoices/${voidDoc.id}/restore`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(rstVoidRes.status, 400);
        const rstVoidBody = await rstVoidRes.json();
        assert.ok(rstVoidBody.error.includes('Only DELETED documents can be restored'));

        // 5. Direct PATCH status on VOID document is rejected
        const directPatchVoid = await fetch(`${baseUrl}/api/invoices/${voidDoc.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({ status: 'ACTIVE' })
        });
        assert.strictEqual(directPatchVoid.status, 400);
        const directPatchVoidBody = await directPatchVoid.json();
        assert.ok(directPatchVoidBody.error.includes('Cannot modify or change the status of an invoice that is already VOID'));

        // Cleanup
        await prisma.invoice.deleteMany({ where: { id: { in: [doc.id, inactDoc.id, voidDoc.id] } } });
    });

    // 52. quotation conversion audit trail completeness
    it('52. quotation conversion creates comprehensive audit trail with convertedAt, convertedById, and reciprocal links', async () => {
        const qtn = await invoiceService.createQuotation({
            clientName: 'Audit Trail Target Corp',
            invoiceDate: '2026-05-25',
            gstEnabled: true,
            gstRate: 18,
            items: [{ name: 'Consulting Contract', quantity: 10, rate: 2500, unit: 'Hours' }]
        }, testUserId);

        const convRes = await fetch(`${baseUrl}/api/invoices/${qtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });
        assert.strictEqual(convRes.status, 201);
        const convBody = await convRes.json();
        const newInvoice = convBody.data;

        // Verify foreign key link
        assert.strictEqual(newInvoice.sourceQuotation.id, qtn.id);
        assert.strictEqual(newInvoice.sourceQuotation.invoiceNumber, qtn.invoiceNumber);

        // Verify Invoice revision 1 audit details
        const invHistory = await invoiceService.getInvoiceHistory(newInvoice.id);
        const invRev = invHistory.revisions.find(r => r.revisionNo === 1);
        assert.ok(invRev);
        assert.strictEqual(invRev.action, 'CREATED');
        assert.strictEqual(invRev.changedById, testUserId);
        assert.strictEqual(invRev.changes.sourceQuotationId, qtn.id);
        assert.strictEqual(invRev.changes.sourceQuotationNumber, qtn.invoiceNumber);
        assert.ok(invRev.changes.convertedAt);
        assert.strictEqual(invRev.changes.convertedById, testUserId);

        // Verify Quotation revision audit details
        const qtnHistory = await invoiceService.getInvoiceHistory(qtn.id);
        const qtnRev = qtnHistory.revisions.find(r => r.action === 'CONVERTED');
        assert.ok(qtnRev);
        assert.strictEqual(qtnRev.changedById, testUserId);
        assert.strictEqual(qtnRev.changes.convertedInvoiceId, newInvoice.id);
        assert.strictEqual(qtnRev.changes.convertedInvoiceNumber, newInvoice.invoiceNumber);
        assert.ok(qtnRev.changes.convertedAt);
        assert.strictEqual(qtnRev.changes.convertedById, testUserId);

        // Verify reciprocal link on quotation
        const freshQtn = await invoiceService.getInvoiceById(qtn.id);
        assert.strictEqual(freshQtn.convertedInvoice.id, newInvoice.id);
        assert.strictEqual(freshQtn.convertedInvoice.invoiceNumber, newInvoice.invoiceNumber);

        // Cleanup
        await prisma.invoice.delete({ where: { id: newInvoice.id } });
        await prisma.invoice.delete({ where: { id: qtn.id } });
    });

    // 53. system fields protection against client tampering
    it('53. system fields cannot be overwritten by client during creation or update', async () => {
        // Attempt to spoof system fields on create
        const spoofedCreate = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                id: 99999,
                invoiceNumber: 'INV-FAKE-0001',
                status: 'VOID',
                version: 42,
                createdById: 9999,
                updatedById: 9999,
                deletedAt: new Date().toISOString(),
                previousStatusBeforeDelete: 'INACTIVE',
                clientName: 'Spoof Test Corp',
                invoiceDate: '2026-05-30',
                gstEnabled: false,
                items: [{ name: 'Tamper Item', quantity: 1, rate: 500 }]
            })
        });

        assert.strictEqual(spoofedCreate.status, 201);
        const createdBody = await spoofedCreate.json();
        const createdDoc = createdBody.data;

        // Verify all system fields were server-controlled
        assert.notStrictEqual(createdDoc.id, 99999);
        assert.ok(createdDoc.invoiceNumber.startsWith('INV-2026-'));
        assert.notStrictEqual(createdDoc.invoiceNumber, 'INV-FAKE-0001');
        assert.strictEqual(createdDoc.status, 'ACTIVE');
        assert.strictEqual(createdDoc.version, 1);
        assert.strictEqual(createdDoc.createdById, testUserId);
        assert.strictEqual(createdDoc.updatedById, testUserId);
        assert.strictEqual(createdDoc.deletedAt, null);
        assert.strictEqual(createdDoc.previousStatusBeforeDelete, null);

        // Attempt to spoof system fields on update
        const spoofedUpdate = await fetch(`${baseUrl}/api/invoices/${createdDoc.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                id: 99999,
                version: createdDoc.version,
                createdById: 9999,
                updatedById: 9999,
                deletedAt: new Date().toISOString(),
                previousStatusBeforeDelete: 'INACTIVE',
                clientName: 'Spoof Test Corp Updated',
                invoiceDate: '2026-05-30',
                gstEnabled: false,
                items: [{ name: 'Tamper Item', quantity: 1, rate: 600 }]
            })
        });

        assert.strictEqual(spoofedUpdate.status, 200);
        const updatedBody = await spoofedUpdate.json();
        const updatedDoc = updatedBody.data;

        assert.strictEqual(updatedDoc.id, createdDoc.id);
        assert.strictEqual(updatedDoc.version, 2);
        assert.strictEqual(updatedDoc.createdById, testUserId);
        assert.strictEqual(updatedDoc.updatedById, testUserId);
        assert.strictEqual(updatedDoc.deletedAt, null);
        assert.strictEqual(updatedDoc.previousStatusBeforeDelete, null);

        // Cleanup
        await prisma.invoice.delete({ where: { id: createdDoc.id } });
    });
});
