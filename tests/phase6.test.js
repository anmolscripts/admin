const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const invoiceService = require('../app/services/invoice.service');
const clientService = require('../app/services/client.service');
const paymentService = require('../app/services/payment.service');
const businessProfileService = require('../app/services/businessProfile.service');

describe('Clients, Business Profile, GST & Payments (Phase 6) Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let csrfToken;
    let testUserId;

    const adminEmail = 'admin@email.com';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!adminPassword) throw new Error('SEED_ADMIN_PASSWORD environment variable is required to run tests');

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

        const docsRes = await fetch(`${baseUrl}/documents`, {
            headers: { Cookie: authCookie }
        });
        csrfToken = extractCsrfToken(await docsRes.text());

        await prisma.businessProfile.deleteMany();
    });

    after(async () => {
        try {
            await prisma.client.deleteMany({ where: { email: 'billing@tcs.example.com' } });
        } catch (_) {}
        if (server) {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });

    // -------------------------------------------------------------------------
    // 1. CLIENT MANAGEMENT TESTS
    // -------------------------------------------------------------------------
    describe('1. Client Management & GSTIN Validation', () => {
        let createdClientId;

        it('creates a client with valid details and 15-character GSTIN', async () => {
            const client = await clientService.createClient({
                name: 'Tata Consultancy Services',
                email: 'billing@tcs.example.com',
                phone: '+91 22 6778 9999',
                gstin: '27AAACT2727Q1ZW',
                stateCode: '27',
                billingAddress: 'TCS House, Raveline Street, Fort, Mumbai 400001',
                shippingAddress: 'TCS Olympus, Thane West, Mumbai 400607'
            });

            assert.ok(client.id > 0);
            assert.strictEqual(client.name, 'Tata Consultancy Services');
            assert.strictEqual(client.gstin, '27AAACT2727Q1ZW');
            assert.strictEqual(client.stateCode, '27');
            assert.strictEqual(client.isActive, true);
            createdClientId = client.id;
        });

        it('rejects invalid GSTIN format with ValidationError', async () => {
            await assert.rejects(
                async () => {
                    await clientService.createClient({
                        name: 'Invalid GSTIN Corp',
                        gstin: 'INVALID-GSTIN-123'
                    });
                },
                (err) => {
                    assert.strictEqual(err.name, 'ValidationError');
                    assert.match(err.message, /GSTIN/i);
                    return true;
                }
            );
        });

        it('rejects client creation when required name is missing', async () => {
            await assert.rejects(
                async () => {
                    await clientService.createClient({
                        name: '',
                        email: 'noname@example.com'
                    });
                },
                (err) => {
                    assert.strictEqual(err.name, 'ValidationError');
                    assert.match(err.message, /name is required/i);
                    return true;
                }
            );
        });

        it('searches clients by name, email, or GSTIN', async () => {
            const results = await clientService.searchClients('Tata');
            assert.ok(Array.isArray(results));
            const found = results.find(c => c.id === createdClientId);
            assert.ok(found, 'Created client should appear in search results');

            const gstinResults = await clientService.searchClients('27AAACT');
            assert.ok(gstinResults.some(c => c.id === createdClientId));
        });

        it('updates client details and toggles status', async () => {
            const updated = await clientService.updateClient(createdClientId, {
                phone: '+91 22 1111 2222'
            });
            assert.strictEqual(updated.phone, '+91 22 1111 2222');

            const deactivated = await clientService.toggleClientStatus(createdClientId);
            assert.strictEqual(deactivated.isActive, false);

            const reactivated = await clientService.toggleClientStatus(createdClientId);
            assert.strictEqual(reactivated.isActive, true);
        });

        it('API endpoint GET /api/clients returns client list', async () => {
            const res = await fetch(`${baseUrl}/api/clients`, {
                headers: { Cookie: authCookie, 'Accept': 'application/json' }
            });
            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.ok(Array.isArray(body.data));
        });
    });

    // -------------------------------------------------------------------------
    // 2. BUSINESS PROFILE & SETTINGS
    // -------------------------------------------------------------------------
    describe('2. Business Profile & Defaults Settings', () => {
        it('retrieves default business profile', async () => {
            const profile = await businessProfileService.getProfile();
            assert.ok(profile);
            assert.ok(profile.companyName);
            assert.strictEqual(profile.stateCode, '27');
        });

        it('updates business profile defaults via API', async () => {
            const res = await fetch(`${baseUrl}/api/settings`, {
                method: 'PUT',
                headers: {
                    Cookie: authCookie,
                    'x-csrf-token': csrfToken,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    companyName: 'Spark Enterprises Pvt Ltd',
                    gstin: '27AABCS1429B1ZB',
                    stateCode: '27',
                    email: 'billing@sparkadmin.io',
                    phone: '+91 98765 00000',
                    address: 'Level 5, Spark Tower, BKC, Mumbai 400051',
                    defaultTerms: 'Payment due within 15 days of invoice date.',
                    defaultRemarks: 'Thank you for choosing Spark Enterprises.'
                })
            });

            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.data.companyName, 'Spark Enterprises Pvt Ltd');
            assert.strictEqual(body.data.defaultTerms, 'Payment due within 15 days of invoice date.');
        });
    });

    // -------------------------------------------------------------------------
    // 3. INDIA GST ENGINE (INTRA-STATE VS INTER-STATE)
    // -------------------------------------------------------------------------
    describe('3. India GST Engine & Tax Breakdown', () => {
        it('calculates Intra-State GST (CGST + SGST split 50/50, IGST = 0) when seller & buyer state match', () => {
            const result = invoiceService.calculateInvoiceTotals({
                items: [{ name: 'Web Development', quantity: 1, rate: 10000, hsnSac: '998314' }],
                gstEnabled: true,
                gstRate: 18,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27'
            });

            assert.strictEqual(result.subtotal, 10000);
            assert.strictEqual(result.gstAmount, 1800);
            assert.strictEqual(result.cgstAmount, 900);
            assert.strictEqual(result.sgstAmount, 900);
            assert.strictEqual(result.igstAmount, 0);
            assert.strictEqual(result.grandTotal, 11800);
            assert.strictEqual(result.items[0].hsnSac, '998314');
        });

        it('calculates Inter-State GST (100% IGST, CGST = 0, SGST = 0) when seller & buyer state differ', () => {
            const result = invoiceService.calculateInvoiceTotals({
                items: [{ name: 'Server Hardware', quantity: 2, rate: 25000, hsnSac: '8471' }],
                gstEnabled: true,
                gstRate: 18,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '29'
            });

            assert.strictEqual(result.subtotal, 50000);
            assert.strictEqual(result.gstAmount, 9000);
            assert.strictEqual(result.cgstAmount, 0);
            assert.strictEqual(result.sgstAmount, 0);
            assert.strictEqual(result.igstAmount, 9000);
            assert.strictEqual(result.grandTotal, 59000);
            assert.strictEqual(result.items[0].hsnSac, '8471');
        });

        it('persists GST amounts, seller snapshot, and HSN/SAC on invoice creation', async () => {
            const inv = await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: new Date(),
                clientName: 'Infosys Technologies',
                clientGSTIN: '29AAACI4818H1ZP',
                placeOfSupplyStateCode: '29',
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { lineNumber: 1, name: 'Cloud Consultation', quantity: 10, rate: 2000, unit: 'HOURS', hsnSac: '998311' }
                ]
            }, testUserId);

            assert.strictEqual(inv.igstAmount, 3600);
            assert.strictEqual(inv.cgstAmount, 0);
            assert.strictEqual(inv.sgstAmount, 0);
            assert.strictEqual(inv.grandTotal, 23600);
            assert.strictEqual(inv.paidAmount, 0);
            assert.strictEqual(inv.outstandingAmount, 23600);
            assert.ok(inv.sellerName);
            assert.strictEqual(inv.items[0].hsnSac, '998311');
        });
    });

    // -------------------------------------------------------------------------
    // 4. PAYMENT RECORDING & RECONCILIATION
    // -------------------------------------------------------------------------
    describe('4. Payment Tracking & Lifecycle Boundaries', () => {
        let testInvoice;

        before(async () => {
            testInvoice = await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: new Date(),
                clientName: 'Payment Test Corp',
                gstEnabled: false,
                items: [{ lineNumber: 1, name: 'Consulting Retainer', quantity: 1, rate: 50000 }]
            }, testUserId);
            assert.strictEqual(testInvoice.grandTotal, 50000);
            assert.strictEqual(testInvoice.outstandingAmount, 50000);
        });

        it('records partial payment and updates outstanding balance', async () => {
            const { payment, invoice } = await paymentService.recordPayment(testInvoice.id, {
                amount: 20000,
                method: 'BANK_TRANSFER',
                reference: 'NEFT-12345678',
                notes: 'First installment'
            }, testUserId);

            assert.strictEqual(payment.status, 'POSTED');
            assert.strictEqual(Number(payment.amount), 20000);
            assert.strictEqual(invoice.paidAmount, 20000);
            assert.strictEqual(invoice.outstandingAmount, 30000);

            const status = paymentService.getPaymentStatus(invoice);
            assert.strictEqual(status, 'PARTIALLY_PAID');
        });

        it('records remaining payment to complete invoice and sets status to PAID', async () => {
            const { payment, invoice } = await paymentService.recordPayment(testInvoice.id, {
                amount: 30000,
                method: 'UPI',
                reference: 'UPI-99887766'
            }, testUserId);

            assert.strictEqual(payment.status, 'POSTED');
            assert.strictEqual(invoice.paidAmount, 50000);
            assert.strictEqual(invoice.outstandingAmount, 0);

            const status = paymentService.getPaymentStatus(invoice);
            assert.strictEqual(status, 'PAID');
        });

        it('strictly rejects overpayment beyond outstanding balance with ValidationError (400)', async () => {
            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(testInvoice.id, {
                        amount: 100,
                        method: 'CASH'
                    }, testUserId);
                },
                (err) => {
                    assert.strictEqual(err.name, 'ValidationError');
                    assert.match(err.message, /exceeds the invoice outstanding balance/i);
                    return true;
                }
            );
        });

        it('strictly rejects payment recording against a QUOTATION', async () => {
            const qtn = await invoiceService.createDocument({
                documentType: 'QUOTATION',
                invoiceDate: new Date(),
                clientName: 'Quotation Payment Test',
                items: [{ lineNumber: 1, name: 'Quote Item', quantity: 1, rate: 10000 }]
            }, testUserId);

            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(qtn.id, {
                        amount: 5000,
                        method: 'BANK_TRANSFER'
                    }, testUserId);
                },
                (err) => {
                    assert.strictEqual(err.name, 'ValidationError');
                    assert.match(err.message, /invoices, not quotations/i);
                    return true;
                }
            );
        });

        it('strictly rejects payment recording against a VOID invoice', async () => {
            const inv = await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: new Date(),
                clientName: 'Void Invoice Payment Test',
                items: [{ lineNumber: 1, name: 'Item', quantity: 1, rate: 10000 }]
            }, testUserId);

            await invoiceService.updateInvoiceStatus(inv.id, 'VOID', 'Voided for testing', inv.version, testUserId);

            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(inv.id, {
                        amount: 5000,
                        method: 'BANK_TRANSFER'
                    }, testUserId);
                },
                (err) => {
                    assert.strictEqual(err.name, 'ValidationError');
                    assert.match(err.message, /VOID/i);
                    return true;
                }
            );
        });

        it('strictly rejects payment recording against a DELETED invoice', async () => {
            const inv = await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: new Date(),
                clientName: 'Deleted Invoice Payment Test',
                items: [{ lineNumber: 1, name: 'Item', quantity: 1, rate: 10000 }]
            }, testUserId);

            await invoiceService.softDeleteDocument(inv.id, 'Deleted for testing', inv.version, testUserId);

            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(inv.id, {
                        amount: 5000,
                        method: 'BANK_TRANSFER'
                    }, testUserId);
                },
                (err) => {
                    assert.strictEqual(err.name, 'ValidationError');
                    assert.match(err.message, /DELETED/i);
                    return true;
                }
            );
        });

        it('voids an existing payment and restores the outstanding balance', async () => {
            const inv = await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: new Date(),
                clientName: 'Void Payment Test Corp',
                gstEnabled: false,
                items: [{ lineNumber: 1, name: 'Service', quantity: 1, rate: 15000 }]
            }, testUserId);

            const { payment } = await paymentService.recordPayment(inv.id, {
                amount: 15000,
                method: 'CHEQUE',
                reference: 'CHQ-556677'
            }, testUserId);

            const voidResult = await paymentService.voidPayment(payment.id, testUserId, 'Cheque bounced');
            assert.strictEqual(voidResult.payment.status, 'VOID');
            assert.strictEqual(voidResult.invoice.paidAmount, 0);
            assert.strictEqual(voidResult.invoice.outstandingAmount, 15000);

            await assert.rejects(
                async () => {
                    await paymentService.voidPayment(payment.id, testUserId, 'Try voiding again');
                },
                (err) => {
                    assert.strictEqual(err.name, 'ValidationError');
                    assert.match(err.message, /already been voided/i);
                    return true;
                }
            );
        });
    });

    // -------------------------------------------------------------------------
    // 5. DASHBOARD KPIS & PAYMENT FILTERING
    // -------------------------------------------------------------------------
    describe('5. Dashboard KPIs & Payment Status Filtering', () => {
        it('GET /api/invoices/kpis returns valid metric counts', async () => {
            const res = await fetch(`${baseUrl}/api/invoices/kpis`, {
                headers: { Cookie: authCookie, 'Accept': 'application/json' }
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.ok(typeof data.activeQuotations === 'number');
            assert.ok(typeof data.activeInvoices === 'number');
            assert.ok(typeof data.totalOutstanding === 'number');
            assert.ok(typeof data.overdueInvoices === 'number');
        });

        it('GET /api/invoices?paymentStatus=PAID filters by payment status', async () => {
            const res = await fetch(`${baseUrl}/api/invoices?paymentStatus=PAID`, {
                headers: { Cookie: authCookie, 'Accept': 'application/json' }
            });

            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.ok(Array.isArray(body.data));
            body.data.forEach(inv => {
                if (inv.documentType === 'INVOICE') {
                    assert.ok(Number(inv.paidAmount) >= Number(inv.grandTotal));
                }
            });
        });

        it('GET /api/invoices?paymentStatus=UNPAID filters invoices with zero payments', async () => {
            const res = await fetch(`${baseUrl}/api/invoices?paymentStatus=UNPAID`, {
                headers: { Cookie: authCookie, 'Accept': 'application/json' }
            });

            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.ok(Array.isArray(body.data));
            body.data.forEach(inv => {
                if (inv.documentType === 'INVOICE') {
                    assert.strictEqual(Number(inv.paidAmount), 0);
                }
            });
        });
    });

    // -------------------------------------------------------------------------
    // 6. CLIENT & SETTINGS WEB VIEWS
    // -------------------------------------------------------------------------
    describe('6. Web Views for Clients and Settings', () => {
        it('GET /clients renders the client directory screen with 200 OK', async () => {
            const res = await fetch(`${baseUrl}/clients`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Clients Directory'));
        });

        it('GET /clients/new renders the new client form with 200 OK', async () => {
            const res = await fetch(`${baseUrl}/clients/new`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('New Client'));
        });

        it('GET /settings renders the organization settings screen with 200 OK', async () => {
            const res = await fetch(`${baseUrl}/settings`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Organization Profile & Defaults'));
        });
    });
});
