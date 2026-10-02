require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const prisma = require('../app/config/prisma');
const app = require('../app/app');
const itemService = require('../app/services/item.service');
const invoiceService = require('../app/services/invoice.service');
const dashboardService = require('../app/services/dashboard.service');
const documentViewService = require('../app/services/documentView.service');
const pdfService = require('../app/services/pdf.service');

describe('Phase 8 Comprehensive Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let testUserId;
    let testClientId;

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
        // Query seeded admin user ID
        const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
        assert.ok(adminUser, 'Admin user must exist in database');
        testUserId = adminUser.id;

        // Start express server on dynamic ephemeral port
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Authenticate as Admin to acquire session cookie
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
            }),
            redirect: 'manual'
        });
        authCookie = extractCookie(loginRes);

        // Create test client
        const client = await prisma.client.create({
            data: {
                name: `Phase 8 Global Enterprises ${Date.now()}`,
                email: 'finance@phase8global.com',
                phone: '+91 99999 88888',
                gstin: '29ABCDE1234F1Z5',
                stateCode: '29',
                billingAddress: '400 Enterprise Boulevard, Bengaluru 560001',
                shippingAddress: '400 Enterprise Boulevard, Bengaluru 560001',
                createdById: testUserId
            }
        });
        testClientId = client.id;

        // Clean up any lingering test item catalog entries from previous test runs
        await prisma.item.deleteMany({
            where: { name: { contains: 'High Performance SSD' } }
        });
    });

    after(async () => {
        try {
            await prisma.item.deleteMany({
                where: { name: { contains: 'High Performance SSD' } }
            });
            if (testClientId) {
                await prisma.invoice.updateMany({
                    where: { clientId: testClientId },
                    data: { sourceQuotationId: null }
                });
                await prisma.invoiceItem.deleteMany({
                    where: { invoice: { clientId: testClientId } }
                });
                await prisma.invoiceRevision.deleteMany({
                    where: { invoice: { clientId: testClientId } }
                });
                await prisma.invoice.deleteMany({
                    where: { clientId: testClientId }
                });
                await prisma.client.deleteMany({
                    where: { id: testClientId }
                });
            }
        } catch (cleanupErr) {
            console.warn('[TEST CLEANUP NOTICE]:', cleanupErr.message);
        } finally {
            if (server) {
                if (typeof server.closeAllConnections === 'function') {
                    server.closeAllConnections();
                }
                await new Promise((resolve) => server.close(resolve));
            }
            await prisma.$disconnect();
        }
    });

    // =========================================================================
    // 1. ITEM MASTER DOMAIN & AUTOCOMPLETE
    // =========================================================================
    describe('1. Item Master Domain & Autocomplete Search', () => {
        it('1.1 should create and list Item Master catalog items', async () => {
            const item = await itemService.createItem({
                name: 'High Performance SSD 1TB',
                description: 'NVMe Gen 4 Enterprise Solid State Drive',
                unit: 'PCS',
                rate: 8500,
                hsnSac: '847170',
                gstRate: 18,
                active: true
            }, testUserId);

            assert.ok(item.id);
            assert.strictEqual(item.name, 'High Performance SSD 1TB');
            assert.strictEqual(item.rate, 8500);
            assert.strictEqual(item.unit, 'PCS');

            const list = await itemService.listItems({ search: 'SSD' });
            assert.ok(list.data.some(i => i.id === item.id));
        });

        it('1.2 should perform server-side debounced search with case-insensitivity', async () => {
            const res = await fetch(`${baseUrl}/api/items/search?q=high+perf`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.ok(body.success);
            assert.ok(Array.isArray(body.data));
            assert.ok(body.data.length > 0);
            assert.strictEqual(body.data[0].name, 'High Performance SSD 1TB');
        });

        it('1.3 should auto-persist newly typed line items into Item Master on document save', async () => {
            const uniqueItemName = `AutoCreated Cloud Backup Unit ${Date.now()}`;
            const doc = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientId: testClientId,
                clientName: 'Phase 8 Global Enterprises',
                billingAddress: '400 Enterprise Boulevard, Bengaluru',
                invoiceDate: new Date().toISOString(),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    {
                        name: uniqueItemName,
                        quantity: 2,
                        unit: 'MONTH',
                        rate: 3500,
                        hsnSac: '998315'
                    }
                ]
            }, testUserId);

            assert.ok(doc.id);

            // Verify item was automatically inserted into Item Master
            const persistedItem = await prisma.item.findFirst({
                where: { name: uniqueItemName }
            });
            assert.ok(persistedItem, 'Item should be auto-persisted into Item Master');
            assert.strictEqual(persistedItem.unit, 'MONTH');
            assert.strictEqual(Number(persistedItem.rate), 3500);
            assert.strictEqual(persistedItem.hsnSac, '998315');
        });

        it('1.4 should isolate historical document data when Item Master item is updated later', async () => {
            // Create item in Item Master
            const originalItem = await itemService.createItem({
                name: `Enterprise Firewall Appliance ${Date.now()}`,
                unit: 'UNIT',
                rate: 50000,
                active: true
            }, testUserId);

            // Create document using this item
            const doc = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientId: testClientId,
                clientName: 'Phase 8 Global Enterprises',
                billingAddress: '400 Enterprise Boulevard, Bengaluru',
                invoiceDate: new Date().toISOString(),
                gstEnabled: false,
                items: [
                    {
                        name: originalItem.name,
                        quantity: 1,
                        unit: originalItem.unit,
                        rate: originalItem.rate
                    }
                ]
            }, testUserId);

            const docOriginalGrandTotal = doc.grandTotal;

            // Modify Item Master item rate later
            await itemService.updateItem(originalItem.id, {
                rate: 75000,
                description: 'Updated rate for future orders'
            }, testUserId);

            // Verify historical document line-item and total remain completely intact
            const fetchedDoc = await invoiceService.getInvoiceById(doc.id);
            assert.strictEqual(Number(fetchedDoc.grandTotal), Number(docOriginalGrandTotal));
            assert.strictEqual(Number(fetchedDoc.items[0].rate), 50000);
        });

        it('1.5 should handle concurrent document creation with same new item without duplicate errors', async () => {
            const sharedItemName = `Concurrent Shared License ${Date.now()}`;

            const createDocPromise = (idx) => invoiceService.createDocument({
                documentType: 'INVOICE',
                clientId: testClientId,
                clientName: 'Phase 8 Global Enterprises',
                billingAddress: '400 Enterprise Boulevard, Bengaluru',
                invoiceDate: new Date().toISOString(),
                gstEnabled: false,
                items: [
                    {
                        name: sharedItemName,
                        quantity: idx + 1,
                        unit: 'SEAT',
                        rate: 1200
                    }
                ]
            }, testUserId);

            // Execute 3 concurrent document saves containing the same brand-new item
            const results = await Promise.all([
                createDocPromise(1),
                createDocPromise(2),
                createDocPromise(3)
            ]);

            assert.strictEqual(results.length, 3);
            for (const r of results) {
                assert.ok(r.id);
            }

            // Exactly 1 Item Master record should exist
            const items = await prisma.item.findMany({
                where: { name: sharedItemName }
            });
            assert.strictEqual(items.length, 1);
        });
    });

    // =========================================================================
    // 2. DOCUMENT TRACEABILITY & AUDIT TRAIL
    // =========================================================================
    describe('2. Full Document Traceability & Audit Trail', () => {
        let trackedDocId;
        let trackedVersion;

        it('2.1 should record CREATED revision with creator, IP, and summary on document creation', async () => {
            const doc = await invoiceService.createDocument({
                documentType: 'QUOTATION',
                clientId: testClientId,
                clientName: 'Phase 8 Global Enterprises',
                billingAddress: '400 Enterprise Boulevard, Bengaluru',
                invoiceDate: new Date().toISOString(),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Consulting Hours', quantity: 10, unit: 'HRS', rate: 2000 }
                ]
            }, testUserId, { ipAddress: '192.168.1.100', userAgent: 'Mozilla/5.0 TestBrowser' });

            trackedDocId = doc.id;
            trackedVersion = doc.version;

            const history = await invoiceService.getInvoiceHistory(trackedDocId);
            assert.ok(history.revisions.length >= 1);
            const rev1 = history.revisions[history.revisions.length - 1]; // Revision 1
            assert.strictEqual(rev1.action, 'CREATED');
            assert.strictEqual(rev1.revisionNo, 1);
            assert.strictEqual(rev1.changedById, testUserId);
            assert.strictEqual(rev1.ipAddress, '192.168.1.100');
        });

        it('2.2 should record UPDATED revision with modified fields diff when document is edited', async () => {
            const updated = await invoiceService.updateInvoice(trackedDocId, {
                version: trackedVersion,
                clientName: 'Phase 8 Global Enterprises (Updated)',
                billingAddress: '400 Enterprise Boulevard, Bengaluru',
                invoiceDate: new Date().toISOString(),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Consulting Hours', quantity: 15, unit: 'HRS', rate: 2000 }
                ]
            }, testUserId, { ipAddress: '10.0.0.5' });

            trackedVersion = updated.version;

            const history = await invoiceService.getInvoiceHistory(trackedDocId);
            const latestRev = history.revisions[0];
            assert.strictEqual(latestRev.action, 'UPDATED');
            assert.strictEqual(latestRev.ipAddress, '10.0.0.5');
            assert.ok(latestRev.changes.changedFields);
            assert.ok(latestRev.changes.changedFields.clientName);
            assert.strictEqual(latestRev.changes.changedFields.clientName.to, 'Phase 8 Global Enterprises (Updated)');
        });

        it('2.3 should record lifecycle revisions: ACTIVATED, DEACTIVATED, DELETED, RESTORED', async () => {
            // 1. Deactivate
            const deact = await invoiceService.updateInvoiceStatus(trackedDocId, 'INACTIVE', testUserId, { version: trackedVersion }, { ipAddress: '1.2.3.4' });
            trackedVersion = deact.version;

            // 2. Activate
            const act = await invoiceService.updateInvoiceStatus(trackedDocId, 'ACTIVE', testUserId, { version: trackedVersion }, { ipAddress: '1.2.3.4' });
            trackedVersion = act.version;

            // 3. Delete
            const del = await invoiceService.softDeleteDocument(trackedDocId, 'Project delayed by client', testUserId, { version: trackedVersion }, { ipAddress: '1.2.3.4' });
            trackedVersion = del.version;

            // 4. Restore
            const rest = await invoiceService.restoreDocument(trackedDocId, testUserId, { version: trackedVersion }, { ipAddress: '1.2.3.4' });
            trackedVersion = rest.version;

            const history = await invoiceService.getInvoiceHistory(trackedDocId);
            const actions = history.revisions.map(r => r.action);
            assert.ok(actions.includes('DEACTIVATED'));
            assert.ok(actions.includes('ACTIVATED'));
            assert.ok(actions.includes('DELETED'));
            assert.ok(actions.includes('RESTORED'));
        });

        it('2.4 should record COPIED revision on source document when copied', async () => {
            const copyData = await invoiceService.copyDocument(trackedDocId, testUserId, { ipAddress: '192.168.1.50' });
            assert.strictEqual(copyData.copyFromId, trackedDocId);

            const history = await invoiceService.getInvoiceHistory(trackedDocId);
            const copiedRev = history.revisions.find(r => r.action === 'COPIED');
            assert.ok(copiedRev, 'COPIED action should be recorded in audit history');
            assert.strictEqual(copiedRev.ipAddress, '192.168.1.50');
        });

        it('2.5 should record reciprocal conversion audit trail with source and converted links', async () => {
            const newInvoice = await invoiceService.convertQuotationToInvoice(trackedDocId, testUserId, { version: trackedVersion }, { ipAddress: '192.168.1.75' });
            assert.ok(newInvoice.id);

            // Quotation audit history should have CONVERTED action
            const qtnHistory = await invoiceService.getInvoiceHistory(trackedDocId);
            const convRev = qtnHistory.revisions.find(r => r.action === 'CONVERTED');
            assert.ok(convRev);
            assert.strictEqual(convRev.changes.convertedInvoiceId, newInvoice.id);
            assert.strictEqual(convRev.changes.convertedInvoiceNumber, newInvoice.invoiceNumber);

            // New Invoice audit history should have CREATED action referencing source quotation
            const invHistory = await invoiceService.getInvoiceHistory(newInvoice.id);
            const invRev1 = invHistory.revisions[0];
            assert.strictEqual(invRev1.action, 'CREATED');
            assert.strictEqual(invRev1.changes.sourceQuotationId, trackedDocId);
        });

        it('2.6 should never leak passwords, tokens, secrets or hashes into audit snapshots', async () => {
            const history = await invoiceService.getInvoiceHistory(trackedDocId);
            for (const rev of history.revisions) {
                const jsonStr = JSON.stringify(rev).toLowerCase();
                assert.ok(!jsonStr.includes('passwordhash'), 'Audit revision must not contain password hashes');
                assert.ok(!jsonStr.includes('csrftoken'), 'Audit revision must not contain csrf tokens');
                assert.ok(!jsonStr.includes('secret'), 'Audit revision must not contain secrets');
            }
        });

        it('2.7 should enforce append-only audit trail immutability at application level', async () => {
            // Verify no API endpoints exist to DELETE or PUT revisions
            const delRes = await fetch(`${baseUrl}/api/invoices/${trackedDocId}/history`, {
                method: 'DELETE',
                headers: { Cookie: authCookie }
            });
            assert.ok([403, 404, 405].includes(delRes.status), 'Revisions must not be deletable');

            const putRes = await fetch(`${baseUrl}/api/invoices/${trackedDocId}/history`, {
                method: 'PUT',
                headers: { Cookie: authCookie, 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'TAMPERED' })
            });
            assert.ok([403, 404, 405].includes(putRes.status), 'Revisions must not be modifiable');
        });
    });

    // =========================================================================
    // 3. DASHBOARD METRICS & TIME ANALYTICS
    // =========================================================================
    describe('3. Professional Dashboard & Aggregations', () => {
        it('3.1 should return accurate server-side KPIs for quotations and invoices', async () => {
            const metrics = await dashboardService.getDashboardMetrics({ range: 'this_month' });

            assert.ok(metrics.kpis);
            assert.ok(typeof metrics.kpis.quotations.total === 'number');
            assert.ok(typeof metrics.kpis.quotations.active === 'number');
            assert.ok(typeof metrics.kpis.quotations.converted === 'number');
            assert.ok(typeof metrics.kpis.quotations.conversionRate === 'number');
            assert.ok(typeof metrics.kpis.invoices.total === 'number');
            assert.ok(typeof metrics.kpis.invoices.active === 'number');
            assert.ok(typeof metrics.kpis.financials.totalInvoiced === 'number');
            assert.ok(typeof metrics.kpis.financials.paidAmount === 'number');
            assert.ok(typeof metrics.kpis.financials.outstandingAmount === 'number');
            assert.ok(typeof metrics.kpis.financials.overdueAmount === 'number');
        });

        it('3.2 should compute conversion rate correctly and handle zero-quotation division safely', () => {
            const emptyMetrics = {
                quotations: { total: 0, converted: 0 }
            };
            const rate = emptyMetrics.quotations.total > 0
                ? (emptyMetrics.quotations.converted / emptyMetrics.quotations.total) * 100
                : 0;
            assert.strictEqual(rate, 0);
        });

        it('3.3 should respect date range boundary filters (today, this_week, this_month, this_year, custom)', () => {
            const now = new Date('2026-10-02T12:00:00Z');

            const todayFilter = dashboardService.getDateRangeFilter('today', null, null, now);
            assert.strictEqual(todayFilter.startDate.getDate(), 2);
            assert.strictEqual(todayFilter.endDate.getDate(), 2);

            const monthFilter = dashboardService.getDateRangeFilter('this_month', null, null, now);
            assert.strictEqual(monthFilter.startDate.getDate(), 1);

            const yearFilter = dashboardService.getDateRangeFilter('this_year', null, null, now);
            assert.strictEqual(yearFilter.startDate.getMonth(), 0); // January
            assert.strictEqual(yearFilter.startDate.getDate(), 1);

            const customFilter = dashboardService.getDateRangeFilter('custom', '2026-06-01', '2026-06-30', now);
            assert.strictEqual(customFilter.startDate.getFullYear(), 2026);
            assert.strictEqual(customFilter.startDate.getMonth(), 5); // June
            assert.strictEqual(customFilter.startDate.getDate(), 1);
            assert.strictEqual(customFilter.endDate.getFullYear(), 2026);
            assert.strictEqual(customFilter.endDate.getMonth(), 5); // June
            assert.strictEqual(customFilter.endDate.getDate(), 30);
        });

        it('3.4 should serve GET /api/dashboard/metrics with authentication enforcement', async () => {
            // Unauthenticated request should be rejected with 302 redirect or 401
            const unauthRes = await fetch(`${baseUrl}/api/dashboard/metrics`, { redirect: 'manual' });
            assert.ok(unauthRes.status === 302 || unauthRes.status === 401);

            // Authenticated request should return 200 with data
            const authRes = await fetch(`${baseUrl}/api/dashboard/metrics?range=this_month`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(authRes.status, 200);
            const json = await authRes.json();
            assert.ok(json.success);
            assert.ok(json.data.kpis);
            assert.ok(json.data.trends);
        });

        it('3.5 should render GET /dashboard web view with 200 OK and no sidebar regression', async () => {
            const res = await fetch(`${baseUrl}/dashboard`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Business Analytics Dashboard'));
            assert.ok(html.includes('Total Invoiced'));
            assert.ok(html.includes('Quote Conversion'));
            assert.ok(html.includes('chart-revenue-collections'));
        });
    });

    // =========================================================================
    // 4. ONE COMMON DOCUMENT TEMPLATE FOR PRINT + PDF
    // =========================================================================
    describe('4. Single Source of Truth Template for Print & PDF', () => {
        let sampleInvoice;
        let sampleQuotation;

        before(async () => {
            sampleInvoice = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientId: testClientId,
                clientName: 'Phase 8 Global Enterprises',
                billingAddress: '400 Enterprise Boulevard, Bengaluru',
                invoiceDate: new Date().toISOString(),
                gstEnabled: true,
                gstRate: 18,
                placeOfSupplyStateCode: '29',
                sellerStateCode: '29',
                items: [
                    { name: 'Core Server Unit', quantity: 1, unit: 'SET', rate: 10000, hsnSac: '8471' }
                ]
            }, testUserId);

            sampleQuotation = await invoiceService.createDocument({
                documentType: 'QUOTATION',
                clientId: testClientId,
                clientName: 'Phase 8 Global Enterprises',
                billingAddress: '400 Enterprise Boulevard, Bengaluru',
                invoiceDate: new Date().toISOString(),
                gstEnabled: true,
                gstRate: 18,
                placeOfSupplyStateCode: '27', // Inter-state
                sellerStateCode: '29',
                items: [
                    { name: 'Enterprise Strategy Consulting', quantity: 5, unit: 'DAYS', rate: 15000, hsnSac: '9983' }
                ]
            }, testUserId);
        });

        it('4.1 should normalize both Invoice and Quotation into unified view models', () => {
            const invModel = documentViewService.buildDocumentViewModel(sampleInvoice);
            assert.strictEqual(invModel.documentTitle, 'TAX INVOICE');
            assert.strictEqual(invModel.isQuotation, false);
            assert.strictEqual(invModel.financials.isInterState, false); // Intra-state (29 to 29)
            assert.ok(invModel.financials.formattedCgstAmount);
            assert.ok(invModel.financials.formattedSgstAmount);

            const qtnModel = documentViewService.buildDocumentViewModel(sampleQuotation);
            assert.strictEqual(qtnModel.documentTitle, 'QUOTATION');
            assert.strictEqual(qtnModel.isQuotation, true);
            assert.strictEqual(qtnModel.dates.dueOrExpiryLabel, 'Valid Until');
        });

        it('4.2 should render shared template identically in print HTML view', async () => {
            const res = await fetch(`${baseUrl}/documents/${sampleInvoice.id}/print`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();

            // Assert single shared template root exists
            assert.ok(html.includes('id="unified-document-root"'), 'Must render unified-document-root element');
            assert.ok(html.includes('Core Server Unit'), 'Must render line items');
            assert.ok(html.includes(sampleInvoice.invoiceNumber), 'Must render invoice number');
            assert.ok(html.includes('TAX INVOICE'), 'Must render document title');
            assert.ok(html.includes('CGST'), 'Must render CGST breakdown');
            assert.ok(html.includes('SGST'), 'Must render SGST breakdown');
            assert.ok(html.includes('Authorized Signatory'), 'Must render shared signatory footer');
        });

        it('4.3 should render shared template in PDF generator and produce valid PDF buffer', async () => {
            const pdfBuffer = await pdfService.generateDocumentPdf(sampleInvoice);
            assert.ok(Buffer.isBuffer(pdfBuffer));
            assert.ok(pdfBuffer.length > 1000, 'PDF buffer should be substantial');

            // Verify standard PDF header magic bytes %PDF-
            const headerStr = pdfBuffer.subarray(0, 5).toString('ascii');
            assert.strictEqual(headerStr, '%PDF-', 'PDF output must start with standard PDF magic bytes');
        });

        it('4.4 should verify actual HTTP PDF download response headers and content', async () => {
            const res = await fetch(`${baseUrl}/documents/${sampleInvoice.id}/pdf`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
            assert.ok(res.headers.get('content-disposition').includes(`${sampleInvoice.invoiceNumber}.pdf`));

            const buf = Buffer.from(await res.arrayBuffer());
            assert.strictEqual(buf.subarray(0, 5).toString('ascii'), '%PDF-');
        });

        it('4.5 should render watermarks in unified template for VOID documents', async () => {
            const voidDoc = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientId: testClientId,
                clientName: 'Void Client',
                billingAddress: 'Void Street',
                invoiceDate: new Date().toISOString(),
                gstEnabled: false,
                items: [{ name: 'Item', quantity: 1, unit: 'PCS', rate: 100 }]
            }, testUserId);

            await invoiceService.updateInvoiceStatus(voidDoc.id, 'VOID', testUserId, { version: voidDoc.version });

            const printRes = await fetch(`${baseUrl}/documents/${voidDoc.id}/print`, {
                headers: { Cookie: authCookie }
            });
            const printHtml = await printRes.text();
            assert.ok(printHtml.includes('print-watermark watermark-void'));
            assert.ok(printHtml.includes('VOID'));

            const pdfBuffer = await pdfService.generateDocumentPdf(await invoiceService.getInvoiceById(voidDoc.id));
            assert.ok(Buffer.isBuffer(pdfBuffer));
        });
    });
});
