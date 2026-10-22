const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const invoiceService = require('../app/services/invoice.service');
const pdfService = require('../app/services/pdf.service');
const documentViewService = require('../app/services/documentView.service');
const templateService = require('../app/services/template.service');

describe('Quotation & Invoice Shared Template Redesign Verification Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let testUserId;
    let testClientId;
    let sampleInvoice;
    let sampleQuotationLongDesc;

    const adminEmail = 'admin@email.com';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;

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
        assert.ok(authCookie, 'Authentication session cookie must be established');

        // Ensure industrial-bold is active for template assertions
        templateService.setActiveTemplates(1, { invoiceTemplate: 'industrial-bold', quotationTemplate: 'executive-emerald' });

        // Create client
        const client = await prisma.client.create({
            data: {
                name: 'Precision Heavy Industries Ltd',
                email: 'procurement@precisionheavy.example.com',
                phone: '+91 91234 56789',
                billingAddress: 'Plot 45-B, Peenya Industrial Area, Phase 2, Bengaluru, Karnataka 560058',
                gstin: '29ABCDE1234F1Z5',
                stateCode: '29'
            }
        });
        testClientId = client.id;

        // Create Invoice
        sampleInvoice = await invoiceService.createDocument({
            documentType: 'INVOICE',
            clientId: testClientId,
            clientName: client.name,
            clientEmail: client.email,
            clientPhone: client.phone,
            billingAddress: client.billingAddress,
            clientGSTIN: client.gstin,
            invoiceDate: new Date().toISOString(),
            gstEnabled: true,
            gstRate: 18,
            sellerStateCode: '29',
            placeOfSupplyStateCode: '29',
            termsAndConditions: 'Payment due within 30 days. Cheques payable to Spark Admin Technologies Pvt Ltd.',
            remarks: 'Prompt payment is appreciated.',
            items: [
                { lineNumber: 1, name: 'Industrial CNC Lathe Spindle Assembly', quantity: 2, unit: 'SET', rate: 45000, hsnSac: '8466' },
                { lineNumber: 2, name: 'High-Precision Carbide Cutting Inserts Grade ISO-P25', quantity: 50, unit: 'PCS', rate: 420, hsnSac: '8209' }
            ]
        }, testUserId);

        // Create Quotation with long industrial descriptions (fitting in VarChar(255))
        const longIndustrialDesc1 = 'Heavy-duty 5-Axis Horizontal Machining Center Spindle Cartridge: Ceramic hybrid bearings, direct drive motor, and calibrated ISO 50 taper shank rated for 15,000 RPM operation under load.';
        const longIndustrialDesc2 = 'Precision Thermal Dissipation Heat Exchanger: Dual-circuit shell-and-tube fabricated with ASME Section VIII certified Type 316L stainless steel tubes, flanged ANSI nozzles, helium tested.';

        sampleQuotationLongDesc = await invoiceService.createDocument({
            documentType: 'QUOTATION',
            clientId: testClientId,
            clientName: client.name,
            clientEmail: client.email,
            clientPhone: client.phone,
            billingAddress: client.billingAddress,
            clientGSTIN: client.gstin,
            invoiceDate: new Date().toISOString(),
            validUntil: new Date(Date.now() + 15 * 86400000).toISOString(),
            gstEnabled: true,
            gstRate: 18,
            sellerStateCode: '29',
            placeOfSupplyStateCode: '27', // Inter-state IGST
            termsAndConditions: 'Quotation valid for 15 days. Delivery: 4-6 weeks ex-factory upon receipt of advance PO.',
            remarks: 'Special project pricing based on bulk manufacturing requirements.',
            items: [
                { lineNumber: 1, name: longIndustrialDesc1, quantity: 1, unit: 'UNIT', rate: 285000, hsnSac: '8457' },
                { lineNumber: 2, name: longIndustrialDesc2, quantity: 2, unit: 'UNIT', rate: 165000, hsnSac: '8419' }
            ]
        }, testUserId);
    });

    after(async () => {
        if (server && server.closeAllConnections) server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await prisma.$disconnect();
    });

    it('1. should render Invoice print view with red-accent design matching reference', async () => {
        const res = await fetch(`${baseUrl}/documents/${sampleInvoice.id}/print`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        const html = await res.text();

        // Structural elements
        assert.ok(html.includes('id="unified-document-root"'));
        assert.ok(html.includes('doc-top-bar'));
        assert.ok(html.includes('BILL TO'));
        assert.ok(html.includes(sampleInvoice.clientName));
        assert.ok(html.includes(sampleInvoice.invoiceNumber));
        assert.ok(html.includes('INVOICE'));
        assert.ok(html.includes('TAX INVOICE'));

        // Table & columns
        assert.ok(html.includes('doc-items-table'));
        assert.ok(html.includes('Industrial CNC Lathe Spindle Assembly'));
        assert.ok(html.includes('45,000.00'));

        // Totals & Red Badge
        assert.ok(html.includes('doc-total-badge-row'));
        assert.ok(html.includes('doc-total-underline'));
        assert.ok(html.includes('TOTAL'));

        // Bank strip & Thank you
        assert.ok(html.includes('doc-payment-strip'));
        assert.ok(html.includes('Bank Transfer :'));
        assert.ok(html.includes('Thanks for your Business!'));

        // Computer-generated notice & full-width footer
        assert.ok(html.includes('does not require a physical signature'));
        assert.ok(!html.includes('Authorized Signatory for'));
        assert.ok(html.includes('doc-footer-bar'));
    });

    it('2. should render Quotation print view with long industrial descriptions without truncation', async () => {
        const res = await fetch(`${baseUrl}/documents/${sampleQuotationLongDesc.id}/print`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        const html = await res.text();

        // Quotation headers
        assert.ok(html.includes('QUOTATION'));
        assert.ok(html.includes('Quotation Date'));
        assert.ok(html.includes('Valid Until'));

        // Verify long descriptions are completely preserved (no substring / truncation)
        assert.ok(html.includes('Heavy-duty 5-Axis Horizontal Machining Center Spindle Cartridge'));
        assert.ok(html.includes('Ceramic hybrid bearings'));
        assert.ok(html.includes('calibrated ISO 50 taper shank'));
        assert.ok(html.includes('Precision Thermal Dissipation Heat Exchanger'));
        assert.ok(html.includes('Dual-circuit shell-and-tube fabricated'));

        // IGST check for inter-state quotation
        assert.ok(html.includes('IGST'));

        // Quotation validity strip
        assert.ok(html.includes('Quotation Validity :'));
    });

    it('3. should generate valid PDF for quotation with long industrial descriptions', async () => {
        const fullQuotation = await invoiceService.getInvoiceById(sampleQuotationLongDesc.id);
        const pdfBuffer = await pdfService.generateDocumentPdf(fullQuotation);
        assert.ok(Buffer.isBuffer(pdfBuffer));
        assert.ok(pdfBuffer.length > 2000, 'PDF buffer should contain complete rendered content');
        assert.strictEqual(pdfBuffer.subarray(0, 5).toString('ascii'), '%PDF-');
    });

    it('4. should generate valid PDF for invoice via HTTP download route', async () => {
        const res = await fetch(`${baseUrl}/documents/${sampleInvoice.id}/pdf`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
        assert.ok(res.headers.get('content-disposition').includes(`${sampleInvoice.invoiceNumber}.pdf`));
        const buf = Buffer.from(await res.arrayBuffer());
        assert.strictEqual(buf.subarray(0, 5).toString('ascii'), '%PDF-');
    });

    it('5. should correctly render VOID watermark on voided documents', async () => {
        const voidDoc = await invoiceService.createDocument({
            documentType: 'INVOICE',
            clientId: testClientId,
            clientName: 'Void Target Client',
            billingAddress: 'Industrial Zone',
            invoiceDate: new Date().toISOString(),
            gstEnabled: false,
            items: [{ name: 'Test Void Machine Part', quantity: 1, unit: 'PCS', rate: 1000 }]
        }, testUserId);

        await invoiceService.updateInvoiceStatus(voidDoc.id, 'VOID', testUserId, { version: voidDoc.version });

        const printRes = await fetch(`${baseUrl}/documents/${voidDoc.id}/print`, {
            headers: { Cookie: authCookie }
        });
        const printHtml = await printRes.text();
        assert.ok(printHtml.includes('print-watermark watermark-void'));
        assert.ok(printHtml.includes('VOID'));
    });

    it('6. should render multi-page invoice with 25 line items across pages and generate PDF cleanly', async () => {
        const multiItems = [];
        for (let i = 1; i <= 25; i++) {
            multiItems.push({
                lineNumber: i,
                name: `Industrial Heavy Component #${i}: Precision CNC Turned Shaft Grade En24 with Ground Journals and Keyways`,
                quantity: i * 2,
                unit: 'PCS',
                rate: 1500 + (i * 50),
                hsnSac: '8483'
            });
        }

        const multiPageDoc = await invoiceService.createDocument({
            documentType: 'INVOICE',
            clientId: testClientId,
            clientName: 'Multi-Page Heavy Manufacturing Corp',
            billingAddress: 'Plant 4, Phase 3, Industrial Estate, Bengaluru',
            invoiceDate: new Date().toISOString(),
            gstEnabled: true,
            gstRate: 18,
            items: multiItems
        }, testUserId);

        const printRes = await fetch(`${baseUrl}/documents/${multiPageDoc.id}/print`, {
            headers: { Cookie: authCookie }
        });
        assert.strictEqual(printRes.status, 200);
        const printHtml = await printRes.text();
        assert.ok(printHtml.includes('Industrial Heavy Component #1'));
        assert.ok(printHtml.includes('Industrial Heavy Component #25'));

        // Multi-page PDF generation test
        const pdfBuffer = await pdfService.generateDocumentPdf(await invoiceService.getInvoiceById(multiPageDoc.id));
        assert.ok(Buffer.isBuffer(pdfBuffer));
        assert.ok(pdfBuffer.length > 5000, 'Multi-page PDF buffer should be substantial for 25 items');
        assert.strictEqual(pdfBuffer.subarray(0, 5).toString('ascii'), '%PDF-');
    });

    it('existing document print route loads the current saved brand under the item name', async () => {
        const line = sampleInvoice.items[0];
        const brand = 'Current catalog brand <img src=x onerror=alert(1)>';
        const changed = await prisma.item.updateMany({
            where: { businessId: sampleInvoice.businessId, name: line.name }, data: { description: brand }
        });
        assert.strictEqual(changed.count, 1);
        const response = await fetch(`${baseUrl}/documents/${sampleInvoice.id}/print`, { headers: { Cookie: authCookie } });
        assert.strictEqual(response.status, 200);
        const dom = new (require('jsdom').JSDOM)(await response.text());
        try {
            const row = dom.window.document.querySelector('.doc-items-table tbody tr');
            assert.strictEqual(row.querySelector('.item-description').textContent, brand);
            assert.strictEqual(row.querySelector('.item-description img'), null);
            assert.strictEqual(row.querySelector('.col-unit').textContent.trim(), line.unit);
            assert.strictEqual(row.cells.length, 7);
        } finally { dom.window.close(); }
    });

    it('7. should include responsive styling rules and CSS variables in document template', async () => {
        const res = await fetch(`${baseUrl}/documents/${sampleInvoice.id}/print`, {
            headers: { Cookie: authCookie }
        });
        const html = await res.text();

        // Verify CSS variables
        assert.ok(html.includes('--doc-accent: #c8102e'));
        assert.ok(html.includes('--doc-border: #e5e7eb'));
        assert.ok(html.includes('--doc-text-dark: #111827'));

        // Verify responsive rules and print media queries
        assert.ok(html.includes('@media (max-width: 720px)'));
        assert.ok(html.includes('@media print'));
        assert.ok(html.includes('table-header-group'));
        assert.ok(html.includes('page-break-inside: avoid'));
    });
});
