const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const invoiceService = require('../app/services/invoice.service');

describe('Document View & Lifecycle (Phase 4) Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let csrfToken;
    let testUserId;

    let activeInvoiceId;
    let inactiveInvoiceId;
    let voidInvoiceId;
    let deletedInvoiceId;
    let activeQuotationId;
    let inactiveQuotationId;
    let convertedQuotationId;
    let convertedInvoiceId;

    const adminEmail = 'admin@email.com';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'choose-a-local-development-password';

    function extractCookie(res) {
        const setCookie = res.headers.get('set-cookie');
        if (!setCookie) return null;
        const match = setCookie.match(/spark\.sid=[^;]+/);
        return match ? match[0] : null;
    }

    function extractCsrfToken(html) {
        const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/id="csrf-token"\s+value="([^"]+)"/);
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

        // Extract fresh CSRF token
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        csrfToken = extractCsrfToken(await dashRes.text());
        assert.ok(csrfToken, 'Should successfully obtain post-auth CSRF token');

        // 1. Create ACTIVE Invoice
        const invActive = await invoiceService.createInvoice({
            clientName: 'View Test Active Client Corp',
            clientEmail: 'billing@activeclient.com',
            clientPhone: '+91 98765 11111',
            billingAddress: '100 Active Street, Tech Park, Bengaluru',
            shippingAddress: '100 Active Street, Warehouse 2, Bengaluru',
            termsAndConditions: 'Payment due within 30 days of invoice date.',
            remarks: 'Priority client account.',
            invoiceDate: '2026-08-01',
            gstEnabled: true,
            gstRate: 18,
            items: [
                { name: 'Cloud Architecture Setup', quantity: 2, unit: 'Project', rate: 25000 },
                { name: 'DevOps Support', quantity: 10, unit: 'Hours', rate: 2000 }
            ]
        }, testUserId);
        activeInvoiceId = invActive.id;

        // 2. Create INACTIVE Invoice
        const invInactive = await invoiceService.createInvoice({
            clientName: 'View Test Inactive Client',
            invoiceDate: '2026-08-02',
            gstEnabled: false,
            items: [{ name: 'Consulting Hours', quantity: 5, unit: 'Hours', rate: 1500 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(invInactive.id, 'INACTIVE', testUserId);
        inactiveInvoiceId = invInactive.id;

        // 3. Create VOID Invoice
        const invVoid = await invoiceService.createInvoice({
            clientName: 'View Test Void Client',
            invoiceDate: '2026-08-03',
            gstEnabled: false,
            items: [{ name: 'Cancelled Order Item', quantity: 1, unit: 'PCS', rate: 10000 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(invVoid.id, 'VOID', testUserId, { deleteReason: 'Client cancelled contract' });
        voidInvoiceId = invVoid.id;

        // 4. Create DELETED Invoice
        const invDeleted = await invoiceService.createInvoice({
            clientName: 'View Test Deleted Client',
            invoiceDate: '2026-08-04',
            gstEnabled: false,
            items: [{ name: 'Mistaken Entry', quantity: 1, unit: 'PCS', rate: 5000 }]
        }, testUserId);
        await invoiceService.softDeleteDocument(invDeleted.id, 'Duplicate record created by accident', testUserId);
        deletedInvoiceId = invDeleted.id;

        // 5. Create ACTIVE Quotation
        const qtnActive = await invoiceService.createQuotation({
            clientName: 'View Test Quotation Prospect',
            clientEmail: 'procurement@prospect.com',
            clientPhone: '+91 91234 56789',
            billingAddress: '500 Commercial Tower, Mumbai',
            shippingAddress: '500 Commercial Tower, Mumbai',
            termsAndConditions: 'Quotation valid for 15 days.',
            remarks: 'Proposal submitted for Q3.',
            invoiceDate: '2026-08-05',
            gstEnabled: true,
            gstRate: 18,
            items: [{ name: 'Enterprise Software Subscription', quantity: 1, unit: 'Year', rate: 120000 }]
        }, testUserId);
        activeQuotationId = qtnActive.id;

        // 6. Create Converted Quotation & Invoice pair
        const qtnToConvert = await invoiceService.createQuotation({
            clientName: 'View Test Converted Client Ltd',
            invoiceDate: '2026-08-06',
            gstEnabled: true,
            gstRate: 18,
            items: [{ name: 'Hardware Appliance', quantity: 3, unit: 'Units', rate: 45000 }]
        }, testUserId);
        convertedQuotationId = qtnToConvert.id;
        const convertedInv = await invoiceService.convertQuotationToInvoice(convertedQuotationId, testUserId);
        convertedInvoiceId = convertedInv.id;

        // 7. Create INACTIVE Quotation
        const qtnInactive = await invoiceService.createQuotation({
            clientName: 'View Test Inactive Quotation Prospect',
            invoiceDate: '2026-08-07',
            gstEnabled: false,
            items: [{ name: 'Trial Consultation', quantity: 1, rate: 5000 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(qtnInactive.id, 'INACTIVE', testUserId);
        inactiveQuotationId = qtnInactive.id;
    });

    after(async () => {
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });

    // =========================================================================
    // 1. ROUTES
    // =========================================================================
    it('1. authenticated document view returns 200 OK', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('View Test Active Client Corp'));
    });

    it('2. unauthenticated document view redirects to /login', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            redirect: 'manual'
        });
        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/login');
    });

    it('3. nonexistent document returns 404 Not Found', async () => {
        const res = await fetch(`${baseUrl}/documents/999999`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 404);
    });

    it('4. malformed document ID returns 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/documents/not-a-valid-id`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 400);
    });

    // =========================================================================
    // 2. SERVER-AUTHORITATIVE RENDERING
    // =========================================================================
    it('5. invoice details render document number, client, dates, and version', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();
        const doc = await invoiceService.getInvoiceById(activeInvoiceId);

        assert.ok(html.includes(doc.invoiceNumber), 'Should display document number');
        assert.ok(html.includes('View Test Active Client Corp'), 'Should display client name');
        assert.ok(html.includes('INVOICE'), 'Should display INVOICE type badge');
        assert.ok(html.includes('ACTIVE'), 'Should display ACTIVE status badge');
        assert.ok(html.includes(`v${doc.version}`), 'Should display version');
    });

    it('6. quotation details render quotation badge and validity information', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeQuotationId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();
        const doc = await invoiceService.getInvoiceById(activeQuotationId);

        assert.ok(html.includes(doc.invoiceNumber));
        assert.ok(html.includes('QUOTATION'), 'Should display QUOTATION type badge');
        assert.ok(html.includes('Valid Until'), 'Should display Valid Until label for quotation');
    });

    it('7. line items render with descriptions, quantities, units, rates, and amounts', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(html.includes('Cloud Architecture Setup'));
        assert.ok(html.includes('DevOps Support'));
        assert.ok(html.includes('Project'));
        assert.ok(html.includes('Hours'));
        assert.ok(html.includes('25,000.00'));
        assert.ok(html.includes('50,000.00'));
    });

    it('8. totals render authoritative server data (subtotal, CGST, SGST, GST total, grandTotal)', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();
        const doc = await invoiceService.getInvoiceById(activeInvoiceId);

        assert.strictEqual(Number(doc.subtotal), 70000);
        assert.strictEqual(Number(doc.gstAmount), 12600);
        assert.strictEqual(Number(doc.grandTotal), 82600);

        assert.ok(html.includes('70,000.00'), 'Subtotal should be 70,000.00');
        assert.ok(html.includes('12,600.00'), 'Total GST should be 12,600.00');
        assert.ok(html.includes('82,600.00'), 'Grand total should be 82,600.00');
        assert.ok(html.includes('CGST (9.00%)'));
        assert.ok(html.includes('SGST (9.00%)'));
    });

    it('9. persisted snapshot fields render in client and address sections', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(html.includes('billing@activeclient.com'), 'Email should render');
        assert.ok(html.includes('+91 98765 11111'), 'Phone should render');
        assert.ok(html.includes('100 Active Street, Tech Park, Bengaluru'), 'Billing address should render');
        assert.ok(html.includes('100 Active Street, Warehouse 2, Bengaluru'), 'Shipping address should render');
        assert.ok(html.includes('Payment due within 30 days'), 'Terms should render');
        assert.ok(html.includes('Priority client account'), 'Remarks should render');
    });

    it('10. conversion relationship renders on converted quotation with link to invoice', async () => {
        const res = await fetch(`${baseUrl}/documents/${convertedQuotationId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();
        const inv = await invoiceService.getInvoiceById(convertedInvoiceId);

        assert.ok(html.includes('Converted to Invoice'));
        assert.ok(html.includes(inv.invoiceNumber));
        assert.ok(html.includes(`/documents/${convertedInvoiceId}`));
    });

    it('11. source quotation renders on converted invoice with link to quotation', async () => {
        const res = await fetch(`${baseUrl}/documents/${convertedInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();
        const qtn = await invoiceService.getInvoiceById(convertedQuotationId);

        assert.ok(html.includes('Generated from Quotation'));
        assert.ok(html.includes(qtn.invoiceNumber));
        assert.ok(html.includes(`/documents/${convertedQuotationId}`));
    });

    // =========================================================================
    // 3. STATUS-AWARE ACTION VISIBILITY
    // =========================================================================
    it('12. ACTIVE document exposes Edit, Copy, and status actions (Deactivate, Void, Delete)', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(html.includes('id="btn-action-edit"'), 'ACTIVE must expose Edit');
        assert.ok(html.includes('id="btn-action-copy"'), 'ACTIVE must expose Copy');
        assert.ok(html.includes('id="dropdown-btn-deactivate"'), 'ACTIVE must expose Deactivate');
        assert.ok(html.includes('id="dropdown-btn-void"'), 'ACTIVE must expose Void');
        assert.ok(html.includes('id="dropdown-btn-delete"'), 'ACTIVE must expose Delete');
        assert.ok(!html.includes('id="btn-action-activate"'), 'ACTIVE must NOT expose Activate');
        assert.ok(!html.includes('id="btn-action-restore"'), 'ACTIVE must NOT expose Restore');
    });

    it('13. INACTIVE document exposes Activate, Edit, Copy, Void, Delete', async () => {
        const res = await fetch(`${baseUrl}/documents/${inactiveInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(html.includes('id="btn-action-activate"'), 'INACTIVE must expose Activate');
        assert.ok(html.includes('id="btn-action-edit"'), 'INACTIVE must expose Edit');
        assert.ok(html.includes('id="btn-action-copy"'), 'INACTIVE must expose Copy');
        assert.ok(html.includes('id="dropdown-btn-void"'), 'INACTIVE must expose Void');
        assert.ok(html.includes('id="dropdown-btn-delete"'), 'INACTIVE must expose Delete');
        assert.ok(!html.includes('id="dropdown-btn-deactivate"'), 'INACTIVE must NOT expose Deactivate');
        assert.ok(!html.includes('id="btn-action-restore"'), 'INACTIVE must NOT expose Restore');
    });

    it('14. VOID document does NOT expose Edit, Activate, Deactivate, Void, Delete, or Convert', async () => {
        const res = await fetch(`${baseUrl}/documents/${voidInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(html.includes('Permanently Voided'));
        assert.ok(html.includes('id="btn-action-copy"'), 'VOID exposes Copy');
        assert.ok(!html.includes('id="btn-action-edit"'), 'VOID must NOT expose Edit');
        assert.ok(!html.includes('id="btn-action-activate"'), 'VOID must NOT expose Activate');
        assert.ok(!html.includes('id="dropdown-btn-deactivate"'), 'VOID must NOT expose Deactivate');
        assert.ok(!html.includes('id="dropdown-btn-void"'), 'VOID must NOT expose Void');
        assert.ok(!html.includes('id="dropdown-btn-delete"'), 'VOID must NOT expose Delete');
        assert.ok(!html.includes('id="btn-action-convert"'), 'VOID must NOT expose Convert');
    });

    it('15. DELETED document exposes Restore and Copy, and does NOT expose Edit, Activate, Deactivate, Void, Delete', async () => {
        const res = await fetch(`${baseUrl}/documents/${deletedInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(html.includes('Document Soft-Deleted'));
        assert.ok(html.includes('id="btn-action-restore"'), 'DELETED must expose Restore');
        assert.ok(html.includes('id="btn-action-copy"'), 'DELETED exposes Copy');
        assert.ok(!html.includes('id="btn-action-edit"'), 'DELETED must NOT expose Edit');
        assert.ok(!html.includes('id="btn-action-activate"'), 'DELETED must NOT expose Activate');
        assert.ok(!html.includes('id="dropdown-btn-deactivate"'), 'DELETED must NOT expose Deactivate');
        assert.ok(!html.includes('id="dropdown-btn-void"'), 'DELETED must NOT expose Void');
        assert.ok(!html.includes('id="dropdown-btn-delete"'), 'DELETED must NOT expose Delete');
    });

    it('16. quotation exposes Convert to Invoice when ACTIVE and not yet converted', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeQuotationId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(html.includes('id="btn-action-convert"'), 'Active quotation must expose Convert');
        assert.ok(html.includes('Convert to Invoice'));
    });

    it('17. invoice does NOT expose Convert to Invoice', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(!html.includes('id="btn-action-convert"'), 'Invoice must NOT expose Convert');
    });

    it('18. converted quotation does NOT expose Convert to Invoice', async () => {
        const res = await fetch(`${baseUrl}/documents/${convertedQuotationId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(!html.includes('id="btn-action-convert"'), 'Already converted quotation must NOT expose Convert');
    });

    it('18b. INACTIVE quotation does NOT expose Convert to Invoice', async () => {
        const res = await fetch(`${baseUrl}/documents/${inactiveQuotationId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(!html.includes('id="btn-action-convert"'), 'Inactive quotation must NOT expose Convert');
    });

    // =========================================================================
    // 4. LIFECYCLE ACTION APIS
    // =========================================================================
    it('19. Activate transitions status from INACTIVE to ACTIVE via PATCH /api/invoices/:id/status', async () => {
        const doc = await invoiceService.getInvoiceById(inactiveInvoiceId);

        const res = await fetch(`${baseUrl}/api/invoices/${inactiveInvoiceId}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                status: 'ACTIVE',
                version: doc.version
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.data.status, 'ACTIVE');
        assert.strictEqual(body.data.version, doc.version + 1);

        // Verify database
        const updated = await invoiceService.getInvoiceById(inactiveInvoiceId);
        assert.strictEqual(updated.status, 'ACTIVE');
    });

    it('20. Deactivate transitions status from ACTIVE to INACTIVE via PATCH /api/invoices/:id/status', async () => {
        const doc = await invoiceService.getInvoiceById(inactiveInvoiceId);

        const res = await fetch(`${baseUrl}/api/invoices/${inactiveInvoiceId}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                status: 'INACTIVE',
                version: doc.version
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.data.status, 'INACTIVE');
        assert.strictEqual(body.data.version, doc.version + 1);
    });

    it('21. Void transitions document to VOID and permanently locks it', async () => {
        const docToVoid = await invoiceService.createInvoice({
            clientName: 'Void Lifecycle Test Client',
            invoiceDate: '2026-08-10',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 500 }]
        }, testUserId);

        const res = await fetch(`${baseUrl}/api/invoices/${docToVoid.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                status: 'VOID',
                deleteReason: 'Permanent cancellation',
                version: docToVoid.version
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.data.status, 'VOID');

        // Cannot transition from VOID
        const attemptReactivate = await fetch(`${baseUrl}/api/invoices/${docToVoid.id}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                status: 'ACTIVE',
                version: body.data.version
            })
        });
        assert.strictEqual(attemptReactivate.status, 400);
    });

    it('22. Delete soft-deletes document to DELETED status with reason and audit info', async () => {
        const docToDelete = await invoiceService.createInvoice({
            clientName: 'Soft Delete Lifecycle Client',
            invoiceDate: '2026-08-11',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 300 }]
        }, testUserId);

        const res = await fetch(`${baseUrl}/api/invoices/${docToDelete.id}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                deleteReason: 'Soft deleted during view test',
                version: docToDelete.version
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.data.status, 'DELETED');
        assert.strictEqual(body.data.deleteReason, 'Soft deleted during view test');
        assert.strictEqual(body.data.previousStatusBeforeDelete, 'ACTIVE');

        const inDb = await invoiceService.getInvoiceById(docToDelete.id);
        assert.strictEqual(inDb.status, 'DELETED');
        assert.ok(inDb.deletedAt !== null);
    });

    it('23. Restore recovers document back to previous status', async () => {
        const doc = await invoiceService.getInvoiceById(deletedInvoiceId);

        const res = await fetch(`${baseUrl}/api/invoices/${deletedInvoiceId}/restore`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: doc.version
            })
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.data.status, 'ACTIVE');
        assert.strictEqual(body.data.deletedAt, null);
        assert.strictEqual(body.data.deleteReason, null);

        const inDb = await invoiceService.getInvoiceById(deletedInvoiceId);
        assert.strictEqual(inDb.status, 'ACTIVE');
    });

    // =========================================================================
    // 5. QUOTATION TO INVOICE CONVERSION
    // =========================================================================
    let newlyConvertedInvoiceId;

    it('24. quotation conversion creates a new invoice with unique INV number and reciprocal links', async () => {
        const doc = await invoiceService.getInvoiceById(activeQuotationId);

        const res = await fetch(`${baseUrl}/api/invoices/${activeQuotationId}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: doc.version
            })
        });

        assert.strictEqual(res.status, 201);
        const body = await res.json();
        const newInv = body.data;
        newlyConvertedInvoiceId = newInv.id;

        assert.strictEqual(newInv.documentType, 'INVOICE');
        assert.ok(newInv.invoiceNumber.startsWith('INV-'));
        assert.strictEqual(newInv.sourceQuotationId, activeQuotationId);
        assert.strictEqual(newInv.clientName, doc.clientName);
        assert.strictEqual(Number(newInv.grandTotal), Number(doc.grandTotal));

        // Re-query quotation to verify conversion relation
        const updatedQtn = await invoiceService.getInvoiceById(activeQuotationId);
        assert.ok(updatedQtn.convertedInvoice !== null);
        assert.strictEqual(updatedQtn.convertedInvoice.id, newInv.id);
    });

    it('25. duplicate conversion of the same quotation returns 409 Conflict', async () => {
        const doc = await invoiceService.getInvoiceById(activeQuotationId);

        const res = await fetch(`${baseUrl}/api/invoices/${activeQuotationId}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: doc.version
            })
        });

        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.ok(body.error.includes('already been converted'));
    });

    it('26. generated invoice links back to source quotation', async () => {
        const res = await fetch(`${baseUrl}/documents/${newlyConvertedInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();
        const qtn = await invoiceService.getInvoiceById(activeQuotationId);

        assert.ok(html.includes('Generated from Quotation'));
        assert.ok(html.includes(qtn.invoiceNumber));
    });

    it('26b. attempting to convert an INACTIVE quotation returns 400 Bad Request', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/${inactiveQuotationId}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Only ACTIVE quotations can be converted'));
    });

    it('26c. attempting to convert a VOID quotation returns 400 Bad Request', async () => {
        const voidQtn = await invoiceService.createQuotation({
            clientName: 'Void Conversion Target View',
            invoiceDate: '2026-08-08',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);
        await invoiceService.updateInvoiceStatus(voidQtn.id, 'VOID', testUserId);

        const res = await fetch(`${baseUrl}/api/invoices/${voidQtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Cannot convert a VOID quotation'));

        await prisma.invoice.delete({ where: { id: voidQtn.id } });
    });

    it('26d. attempting to convert a DELETED quotation returns 400 Bad Request', async () => {
        const delQtn = await invoiceService.createQuotation({
            clientName: 'Deleted Conversion Target View',
            invoiceDate: '2026-08-09',
            gstEnabled: false,
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);
        await invoiceService.softDeleteDocument(delQtn.id, 'Soft delete test', testUserId);

        const res = await fetch(`${baseUrl}/api/invoices/${delQtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            }
        });

        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.ok(body.error.includes('Cannot convert a DELETED quotation'));

        await prisma.invoice.delete({ where: { id: delQtn.id } });
    });

    // =========================================================================
    // 6. COPY DOCUMENT WORKFLOW
    // =========================================================================
    it('27. GET /documents/new?copyFrom=:id renders editor with prefilled business content', async () => {
        const res = await fetch(`${baseUrl}/documents/new?copyFrom=${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const html = await res.text();
        const sourceDoc = await invoiceService.getInvoiceById(activeInvoiceId);

        assert.ok(html.includes(`Copy of ${sourceDoc.invoiceNumber}`));
        assert.ok(html.includes('View Test Active Client Corp'));
        assert.ok(html.includes('billing@activeclient.com'));
        assert.ok(html.includes('100 Active Street, Tech Park, Bengaluru'));
        assert.ok(html.includes('Cloud Architecture Setup'));
    });

    it('28. copy endpoint does not reuse ID, document number, status, or revisions', async () => {
        const copyRes = await fetch(`${baseUrl}/api/invoices/${activeInvoiceId}/copy`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(copyRes.status, 200);
        const body = await copyRes.json();
        const copyData = body.data;

        assert.strictEqual(copyData.id, undefined);
        assert.strictEqual(copyData.invoiceNumber, undefined);
        assert.strictEqual(copyData.status, undefined);
        assert.strictEqual(copyData.version, undefined);
        assert.strictEqual(copyData.revisions, undefined);

        // Business data is preserved
        assert.strictEqual(copyData.clientName, 'View Test Active Client Corp');
        assert.strictEqual(copyData.clientEmail, 'billing@activeclient.com');
        assert.strictEqual(copyData.items.length, 2);
    });

    it('29. saving copied document creates a new document with distinct sequence number', async () => {
        const copyRes = await fetch(`${baseUrl}/api/invoices/${activeInvoiceId}/copy`, {
            headers: { Cookie: authCookie }
        });
        const copyBody = await copyRes.json();
        const payload = copyBody.data;

        const saveRes = await fetch(`${baseUrl}/api/invoices`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify(payload)
        });

        assert.strictEqual(saveRes.status, 201);
        const saveBody = await saveRes.json();
        const newDoc = saveBody.data;

        assert.notStrictEqual(newDoc.id, activeInvoiceId);
        assert.ok(newDoc.invoiceNumber.startsWith('INV-'));
        assert.strictEqual(newDoc.status, 'ACTIVE');
        assert.strictEqual(newDoc.version, 1);
    });

    it('29b. copy endpoint successfully prepares clean template from INACTIVE, VOID, and DELETED documents', async () => {
        // Copy from INACTIVE
        const copyInactive = await invoiceService.copyDocument(inactiveInvoiceId);
        assert.strictEqual(copyInactive.clientName, 'View Test Inactive Client');
        assert.strictEqual(copyInactive.id, undefined);
        assert.strictEqual(copyInactive.status, undefined);
        assert.strictEqual(copyInactive.version, undefined);

        // Copy from VOID
        const copyVoid = await invoiceService.copyDocument(voidInvoiceId);
        assert.strictEqual(copyVoid.clientName, 'View Test Void Client');
        assert.strictEqual(copyVoid.id, undefined);
        assert.strictEqual(copyVoid.status, undefined);
        assert.strictEqual(copyVoid.version, undefined);

        // Copy from DELETED
        const copyDeleted = await invoiceService.copyDocument(deletedInvoiceId);
        assert.strictEqual(copyDeleted.clientName, 'View Test Deleted Client');
        assert.strictEqual(copyDeleted.id, undefined);
        assert.strictEqual(copyDeleted.status, undefined);
        assert.strictEqual(copyDeleted.version, undefined);
    });

    // =========================================================================
    // 7. OPTIMISTIC CONCURRENCY
    // =========================================================================
    it('30. stale version status mutation returns 409 Conflict', async () => {
        const doc = await invoiceService.getInvoiceById(activeInvoiceId);
        const staleVersion = doc.version - 1;

        const res = await fetch(`${baseUrl}/api/invoices/${activeInvoiceId}/status`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                status: 'INACTIVE',
                version: staleVersion
            })
        });

        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.ok(body.error.includes('Conflict'));
    });

    it('31. stale version soft-delete returns 409 Conflict', async () => {
        const doc = await invoiceService.getInvoiceById(activeInvoiceId);
        const staleVersion = doc.version - 1;

        const res = await fetch(`${baseUrl}/api/invoices/${activeInvoiceId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                deleteReason: 'Attempted stale delete',
                version: staleVersion
            })
        });

        assert.strictEqual(res.status, 409);
    });

    it('32. stale version restore returns 409 Conflict', async () => {
        // Soft delete a doc to test restore concurrency
        const docToTest = await invoiceService.createInvoice({
            clientName: 'Restore Concurrency Client',
            invoiceDate: '2026-08-15',
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);

        const delRes = await invoiceService.softDeleteDocument(docToTest.id, 'Test', testUserId);
        const staleVersion = delRes.version - 1;

        const res = await fetch(`${baseUrl}/api/invoices/${docToTest.id}/restore`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: staleVersion
            })
        });

        assert.strictEqual(res.status, 409);
    });

    it('33. stale version quotation conversion returns 409 Conflict', async () => {
        const newQtn = await invoiceService.createQuotation({
            clientName: 'Conversion Concurrency Prospect',
            invoiceDate: '2026-08-16',
            items: [{ name: 'Item', quantity: 1, rate: 100 }]
        }, testUserId);

        const staleVersion = newQtn.version - 1;

        const res = await fetch(`${baseUrl}/api/invoices/${newQtn.id}/convert`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': csrfToken,
                Cookie: authCookie
            },
            body: JSON.stringify({
                version: staleVersion
            })
        });

        assert.strictEqual(res.status, 409);
    });

    // =========================================================================
    // 8. REVISION HISTORY & TIMELINE
    // =========================================================================
    it('34. GET /api/invoices/:id/history returns revision history records', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/${activeInvoiceId}/history`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.strictEqual(body.success, true);
        assert.strictEqual(body.data.invoiceId, activeInvoiceId);
        assert.ok(Array.isArray(body.data.revisions));
        assert.ok(body.data.revisions.length >= 1);
        assert.strictEqual(body.data.revisions[body.data.revisions.length - 1].action, 'CREATED');
    });

    it('35. document view HTML renders activity timeline entries for revisions', async () => {
        const res = await fetch(`${baseUrl}/documents/${activeInvoiceId}`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        assert.ok(html.includes('Activity & Revision History'));
        assert.ok(html.includes('Created'));
        assert.ok(html.includes('Rev 1'));
    });
});
