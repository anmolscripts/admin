const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const invoiceService = require('../app/services/invoice.service');

describe('Print, PDF & Excel Export (Phase 5) Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let testUserId;
    let testInvoiceId;
    let testQuotationId;
    let testVoidInvoiceId;

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
        const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
        assert.ok(adminUser, 'Admin user must exist in database');
        testUserId = adminUser.id;

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

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
        assert.ok(authCookie, 'Authentication must yield session cookie');

        // Create test invoice
        const inv = await invoiceService.createDocument({
            documentType: 'INVOICE',
            invoiceDate: new Date(),
            clientName: 'Export Test Corp',
            clientEmail: 'export@testcorp.in',
            clientPhone: '+91 9988776655',
            billingAddress: '42 Export Blvd, Export City',
            gstEnabled: true,
            gstRate: 18,
            items: [
                { lineNumber: 1, name: 'Cloud Hosting Services', quantity: 2, rate: 5000, unit: 'MONTH' },
                { lineNumber: 2, name: 'Technical Support', quantity: 5, rate: 1200, unit: 'HOURS' }
            ]
        }, testUserId);
        testInvoiceId = inv.id;

        // Create test quotation
        const qtn = await invoiceService.createDocument({
            documentType: 'QUOTATION',
            invoiceDate: new Date(),
            clientName: 'Quotation Test Corp',
            clientEmail: 'quotes@testcorp.in',
            items: [
                { lineNumber: 1, name: 'Architecture Review', quantity: 1, rate: 25000, unit: 'SERVICE' }
            ]
        }, testUserId);
        testQuotationId = qtn.id;

        // Create void invoice for watermark testing
        const voidInv = await invoiceService.createDocument({
            documentType: 'INVOICE',
            invoiceDate: new Date(),
            clientName: 'Voided Test Corp',
            items: [
                { lineNumber: 1, name: 'Cancelled Setup', quantity: 1, rate: 1000, unit: 'PCS' }
            ]
        }, testUserId);
        const voided = await invoiceService.updateInvoiceStatus(voidInv.id, 'VOID', testUserId, {
            version: voidInv.version,
            reason: 'Testing VOID watermark'
        });
        testVoidInvoiceId = voided.id;
    });

    after(async () => {
        if (server) {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });

    // =========================================================================
    // 1. PDF EXPORT TESTS
    // =========================================================================
    it('1. GET /api/invoices/:id/pdf returns 200 with PDF content-type and valid PDF magic bytes', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/${testInvoiceId}/pdf`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('application/pdf'));
        assert.ok(res.headers.get('content-disposition').includes('.pdf'));

        const buffer = Buffer.from(await res.arrayBuffer());
        assert.ok(buffer.length > 500, 'PDF buffer must contain content');
        const magic = buffer.subarray(0, 5).toString('ascii');
        assert.strictEqual(magic, '%PDF-', 'PDF file must start with %PDF- header');
    });

    it('2. GET /documents/:id/pdf route returns 200 with valid PDF stream', async () => {
        const res = await fetch(`${baseUrl}/documents/${testInvoiceId}/pdf`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('application/pdf'));
        const buffer = Buffer.from(await res.arrayBuffer());
        const magic = buffer.subarray(0, 5).toString('ascii');
        assert.strictEqual(magic, '%PDF-');
    });

    it('3. GET /api/invoices/:id/pdf returns valid PDF for a QUOTATION', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/${testQuotationId}/pdf`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('application/pdf'));
        const buffer = Buffer.from(await res.arrayBuffer());
        assert.strictEqual(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
    });

    it('4. GET /api/invoices/:id/pdf returns valid PDF for a VOID document with watermark', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/${testVoidInvoiceId}/pdf`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('application/pdf'));
        const buffer = Buffer.from(await res.arrayBuffer());
        assert.strictEqual(buffer.subarray(0, 5).toString('ascii'), '%PDF-');
    });

    it('5. GET /api/invoices/999999/pdf returns 404 for nonexistent document', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/999999/pdf`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 404);
        const data = await res.json();
        assert.strictEqual(data.success, false);
    });

    it('6. GET /api/invoices/invalid/pdf returns 400 for invalid document ID', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/invalid/pdf`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 400);
        const data = await res.json();
        assert.strictEqual(data.success, false);
    });

    // =========================================================================
    // 2. PRINT HTML VIEW TESTS
    // =========================================================================
    it('7. GET /documents/:id/print returns 200 HTML with document details and no dashboard sidebar', async () => {
        const res = await fetch(`${baseUrl}/documents/${testInvoiceId}/print`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('text/html'));
        const html = await res.text();

        assert.ok(html.includes('Export Test Corp'), 'Must render client name');
        assert.ok(html.includes('Cloud Hosting Services'), 'Must render item description');
        assert.ok(html.includes('TAX INVOICE'), 'Must render TAX INVOICE header');
        assert.ok(html.includes('window.print()'), 'Must include print trigger button');
        assert.ok(!html.includes('sidebar-nav'), 'Must not render dashboard sidebar');
    });

    it('8. GET /documents/:id/print displays VOID watermark for voided documents', async () => {
        const res = await fetch(`${baseUrl}/documents/${testVoidInvoiceId}/print`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.ok(html.includes('print-watermark watermark-void'), 'Must render VOID watermark element');
        assert.ok(html.includes('VOID'));
    });

    it('9. GET /documents/999999/print returns 404 for nonexistent document', async () => {
        const res = await fetch(`${baseUrl}/documents/999999/print`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 404);
    });

    // =========================================================================
    // 3. EXCEL EXPORT TESTS
    // =========================================================================
    it('10. GET /api/invoices/export/excel returns 200 with Excel content-type and valid XLSX magic bytes', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/export/excel`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('spreadsheetml.sheet'));
        assert.ok(res.headers.get('content-disposition').includes('.xlsx'));

        const buffer = Buffer.from(await res.arrayBuffer());
        assert.ok(buffer.length > 500, 'Excel buffer must contain valid workbook');
        // PK\x03\x04 is the ZIP magic bytes for standard OOXML .xlsx files
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
        assert.ok(isZip, 'XLSX file must begin with PK ZIP signature');
    });

    it('11. GET /api/invoices/export/excel?type=QUOTATION respects document type filters', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/export/excel?type=QUOTATION`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        const buffer = Buffer.from(await res.arrayBuffer());
        const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
        assert.ok(isZip);
    });

    it('12. GET /documents/export/excel web route successfully exports Excel', async () => {
        const res = await fetch(`${baseUrl}/documents/export/excel`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(res.status, 200);
        assert.ok(res.headers.get('content-type').includes('spreadsheetml.sheet'));
    });

    // =========================================================================
    // 4. AUTHENTICATION PROTECTION
    // =========================================================================
    it('13. Unauthenticated requests to /api/invoices/:id/pdf are protected', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/${testInvoiceId}/pdf`, {
            redirect: 'manual'
        });
        assert.ok(res.status === 401 || res.status === 302);
        if (res.status === 302) {
            assert.ok(res.headers.get('location').includes('/login'));
        }
    });

    it('14. Unauthenticated requests to /api/invoices/export/excel are protected', async () => {
        const res = await fetch(`${baseUrl}/api/invoices/export/excel`, {
            redirect: 'manual'
        });
        assert.ok(res.status === 401 || res.status === 302);
        if (res.status === 302) {
            assert.ok(res.headers.get('location').includes('/login'));
        }
    });

    it('15. Unauthenticated requests to /documents/:id/print redirect to /login', async () => {
        const res = await fetch(`${baseUrl}/documents/${testInvoiceId}/print`, {
            redirect: 'manual'
        });
        assert.strictEqual(res.status, 302);
        assert.ok(res.headers.get('location').includes('/login'));
    });
});
