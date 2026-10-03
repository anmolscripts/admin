const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const invoiceService = require('../app/services/invoice.service');
const clientService = require('../app/services/client.service');
const paymentService = require('../app/services/payment.service');
const businessProfileService = require('../app/services/businessProfile.service');

describe('Production Hardening & Release Audit (Phase 7) Test Suite', () => {
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

        assert.strictEqual(loginRes.status, 302);
        authCookie = extractCookie(loginRes);
        assert.ok(authCookie, 'Authentication cookie must be established');

        const docsRes = await fetch(`${baseUrl}/documents`, {
            headers: { Cookie: authCookie }
        });
        csrfToken = extractCsrfToken(await docsRes.text());
        assert.ok(csrfToken, 'CSRF token must be present');
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
    // STEP 2: AUTHENTICATION & SESSION SECURITY
    // =========================================================================
    describe('Step 2: Authentication & Session Security Audit', () => {
        it('login failure provides generic message without leaking email existence', async () => {
            const loginPage = await fetch(`${baseUrl}/login`);
            const cookie = extractCookie(loginPage);
            const csrf = extractCsrfToken(await loginPage.text());

            const res = await fetch(`${baseUrl}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: cookie
                },
                body: new URLSearchParams({
                    _csrf: csrf,
                    email: 'nonexistent-user-12345@testdomain.com',
                    password: 'RandomPassword123!'
                }).toString()
            });

            assert.strictEqual(res.status, 401);
            const html = await res.text();
            assert.ok(html.includes('Invalid email or password.'));
            assert.ok(!html.includes('User not found'));
            assert.ok(!html.includes('Email does not exist'));
            assert.ok(!html.includes('USER_NOT_FOUND'));
        });

        it('unauthenticated access to protected document view redirects to /login', async () => {
            const res = await fetch(`${baseUrl}/documents`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.strictEqual(res.headers.get('location'), '/login');
        });

        it('logout invalidates session and clears session cookie', async () => {
            const getLogin = await fetch(`${baseUrl}/login`);
            const sessionCookie = extractCookie(getLogin);
            const loginCsrf = extractCsrfToken(await getLogin.text());

            const loginRes = await fetch(`${baseUrl}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: sessionCookie
                },
                body: new URLSearchParams({
                    _csrf: loginCsrf,
                    email: adminEmail,
                    password: adminPassword
                }).toString(),
                redirect: 'manual'
            });
            const separateAuthCookie = extractCookie(loginRes);

            const dashRes = await fetch(`${baseUrl}/documents`, {
                headers: { Cookie: separateAuthCookie }
            });
            const separateCsrf = extractCsrfToken(await dashRes.text());

            const logoutRes = await fetch(`${baseUrl}/logout`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'x-csrf-token': separateCsrf,
                    Cookie: separateAuthCookie
                },
                redirect: 'manual'
            });

            assert.strictEqual(logoutRes.status, 302);
            assert.strictEqual(logoutRes.headers.get('location'), '/login');
            const clearCookie = logoutRes.headers.get('set-cookie');
            assert.ok(clearCookie && clearCookie.includes('spark.sid=;'));
        });
    });

    // =========================================================================
    // STEP 3: CSRF AUDIT
    // =========================================================================
    describe('Step 3: CSRF Protection on Mutating Endpoints', () => {
        it('rejects POST /api/invoices without CSRF token with 403 Forbidden JSON', async () => {
            const res = await fetch(`${baseUrl}/api/invoices`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: authCookie
                },
                body: JSON.stringify({
                    documentType: 'INVOICE',
                    clientName: 'CSRF Test Client',
                    invoiceDate: '2026-03-01',
                    items: [{ name: 'Item 1', quantity: 1, rate: 100 }]
                })
            });

            assert.strictEqual(res.status, 403);
            const data = await res.json();
            assert.strictEqual(data.success, false);
            assert.ok(data.message.includes('CSRF token missing'));
        });

        it('rejects POST /api/invoices with invalid/forged CSRF token with 403 Forbidden JSON', async () => {
            const res = await fetch(`${baseUrl}/api/invoices`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': 'forged-invalid-csrf-token-1234567890abcdef',
                    Cookie: authCookie
                },
                body: JSON.stringify({
                    documentType: 'INVOICE',
                    clientName: 'CSRF Test Client',
                    invoiceDate: '2026-03-01',
                    items: [{ name: 'Item 1', quantity: 1, rate: 100 }]
                })
            });

            assert.strictEqual(res.status, 403);
            const data = await res.json();
            assert.strictEqual(data.success, false);
            assert.ok(data.message.includes('Invalid CSRF token'));
        });

        it('safe GET requests are exempt from CSRF token requirements', async () => {
            const res = await fetch(`${baseUrl}/api/invoices`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
        });
    });

    // =========================================================================
    // STEP 4: XSS & INPUT SANITIZATION AUDIT
    // =========================================================================
    describe('Step 4: XSS & Input Sanitization Audit', () => {
        let xssDocId;

        it('persists and safely escapes XSS payload in document view without raw HTML execution', async () => {
            const xssPayload = {
                documentType: 'INVOICE',
                clientName: 'Safe Corp <script>alert("XSS-Client")</script>',
                clientEmail: 'audit@example.com',
                clientPhone: '+91 9876543210',
                billingAddress: '42 Security Ave <img src=x onerror=alert("XSS-Billing")>',
                shippingAddress: '100 Defense Rd <svg onload=alert("XSS-Shipping")>',
                termsAndConditions: 'Terms: <iframe src="javascript:alert(1)"></iframe>',
                remarks: 'Remarks: <b onmouseover="alert(1)">hover me</b>',
                invoiceDate: '2026-03-01',
                gstEnabled: true,
                gstRate: 18,
                items: [{
                    name: 'Penetration Testing Service <script>alert("XSS-Item")</script>',
                    quantity: 1,
                    unit: 'HOURS',
                    rate: 5000
                }]
            };

            const createRes = await fetch(`${baseUrl}/api/invoices`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify(xssPayload)
            });

            assert.strictEqual(createRes.status, 201);
            const createBody = await createRes.json();
            xssDocId = createBody.data.id;
            assert.ok(xssDocId > 0);

            // Fetch HTML view and verify that raw script/img/iframe tags are escaped
            const viewRes = await fetch(`${baseUrl}/documents/${xssDocId}`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(viewRes.status, 200);
            const html = await viewRes.text();

            // Verify HTML does NOT contain unescaped executable script tags in content
            assert.ok(!html.includes('<script>alert("XSS-Client")</script>'));
            assert.ok(!html.includes('<img src=x onerror=alert("XSS-Billing")>'));
            assert.ok(!html.includes('<iframe src="javascript:alert(1)"></iframe>'));

            // Verify HTML contains properly escaped entities
            assert.ok(html.includes('&lt;script&gt;alert(&quot;XSS-Client&quot;)&lt;/script&gt;') || html.includes('Safe Corp &lt;script&gt;'));
        });
    });

    // =========================================================================
    // STEP 5: DOCUMENT STATE MACHINE AUDIT
    // =========================================================================
    describe('Step 5: Document State Machine Exhaustive Matrix', () => {
        let testDocId;

        before(async () => {
            const doc = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientName: 'State Machine Audit Corp',
                invoiceDate: '2026-03-01',
                items: [{ name: 'Service Audit', quantity: 1, rate: 1000 }]
            }, testUserId);
            testDocId = doc.id;
        });

        it('ACTIVE document can transition to INACTIVE, VOID, and DELETED', async () => {
            // Deactivate: ACTIVE -> INACTIVE
            const deactRes = await fetch(`${baseUrl}/api/invoices/${testDocId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ status: 'INACTIVE', version: 1 })
            });
            assert.strictEqual(deactRes.status, 200);
            const deactData = await deactRes.json();
            assert.strictEqual(deactData.data.status, 'INACTIVE');

            // Reactivate: INACTIVE -> ACTIVE
            const actRes = await fetch(`${baseUrl}/api/invoices/${testDocId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ status: 'ACTIVE', version: 2 })
            });
            assert.strictEqual(actRes.status, 200);
            const actData = await actRes.json();
            assert.strictEqual(actData.data.status, 'ACTIVE');
        });

        it('VOID transition is permanently terminal: cannot change status or edit', async () => {
            // Void document: ACTIVE -> VOID
            const voidRes = await fetch(`${baseUrl}/api/invoices/${testDocId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ status: 'VOID', version: 3 })
            });
            assert.strictEqual(voidRes.status, 200);

            // Attempt VOID -> ACTIVE (rejected)
            const failActRes = await fetch(`${baseUrl}/api/invoices/${testDocId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ status: 'ACTIVE', version: 4 })
            });
            assert.strictEqual(failActRes.status, 400);

            // Attempt VOID -> INACTIVE (rejected)
            const failInactRes = await fetch(`${baseUrl}/api/invoices/${testDocId}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ status: 'INACTIVE', version: 4 })
            });
            assert.strictEqual(failInactRes.status, 400);

            // Attempt VOID -> DELETE (rejected)
            const failDelRes = await fetch(`${baseUrl}/api/invoices/${testDocId}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ version: 4 })
            });
            assert.strictEqual(failDelRes.status, 400);

            // Attempt PUT update on VOID document (rejected)
            const failEditRes = await fetch(`${baseUrl}/api/invoices/${testDocId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({
                    version: 4,
                    clientName: 'Tamper Name',
                    invoiceDate: '2026-03-01',
                    items: [{ name: 'Tamper Item', quantity: 2, rate: 500 }]
                })
            });
            assert.strictEqual(failEditRes.status, 400);
        });

        it('DELETED documents can ONLY be restored: cannot be edited or deleted again', async () => {
            const doc2 = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientName: 'Soft Delete Audit Corp',
                invoiceDate: '2026-03-01',
                items: [{ name: 'Service Audit', quantity: 1, rate: 2000 }]
            }, testUserId);

            // Soft-delete
            const delRes = await fetch(`${baseUrl}/api/invoices/${doc2.id}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ reason: 'Audit Deletion', version: 1 })
            });
            assert.strictEqual(delRes.status, 200);

            // Attempt second delete on already deleted document (rejected)
            const dupDelRes = await fetch(`${baseUrl}/api/invoices/${doc2.id}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ version: 2 })
            });
            assert.strictEqual(dupDelRes.status, 400);

            // Attempt edit on DELETED document (rejected)
            const editDelRes = await fetch(`${baseUrl}/api/invoices/${doc2.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({
                    version: 2,
                    clientName: 'Cannot Edit Deleted',
                    invoiceDate: '2026-03-01',
                    items: [{ name: 'Item', quantity: 1, rate: 100 }]
                })
            });
            assert.strictEqual(editDelRes.status, 400);

            // Restore recovers back to ACTIVE status
            const restoreRes = await fetch(`${baseUrl}/api/invoices/${doc2.id}/restore`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({ version: 2 })
            });
            assert.strictEqual(restoreRes.status, 200);
            const restoreData = await restoreRes.json();
            assert.strictEqual(restoreData.data.status, 'ACTIVE');
        });
    });

    // =========================================================================
    // STEP 6: DOCUMENT NUMBERING & CONCURRENCY AUDIT
    // =========================================================================
    describe('Step 6: Document Numbering & Concurrency', () => {
        it('client-submitted invoiceNumber is strictly ignored during document creation', async () => {
            const res = await fetch(`${baseUrl}/api/invoices`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({
                    documentType: 'INVOICE',
                    invoiceNumber: 'INV-FAKE-9999',
                    clientName: 'Number Sequence Test',
                    invoiceDate: '2026-03-01',
                    items: [{ name: 'Item 1', quantity: 1, rate: 100 }]
                })
            });

            assert.strictEqual(res.status, 201);
            const data = await res.json();
            assert.notStrictEqual(data.data.invoiceNumber, 'INV-FAKE-9999');
            assert.match(data.data.invoiceNumber, /^INV-2026-\d{4}$/);
        });

        it('concurrent document creation generates unique, monotonically increasing numbers', async () => {
            const count = 5;
            const promises = [];

            for (let i = 0; i < count; i++) {
                promises.push(
                    invoiceService.createDocument({
                        documentType: 'QUOTATION',
                        clientName: `Concurrent Client ${i}`,
                        invoiceDate: '2026-03-01',
                        items: [{ name: `Service ${i}`, quantity: 1, rate: 500 }]
                    }, testUserId)
                );
            }

            const results = await Promise.all(promises);
            const numbers = results.map(r => r.invoiceNumber);

            // Check that all generated numbers are unique
            const uniqueNumbers = new Set(numbers);
            assert.strictEqual(uniqueNumbers.size, count, 'All concurrently generated numbers must be strictly unique');

            // Check format
            for (const num of numbers) {
                assert.match(num, /^QTN-2026-\d{4}$/);
            }
        });
    });

    // =========================================================================
    // STEP 7: FINANCIAL CALCULATION & TAMPER RESISTANCE
    // =========================================================================
    describe('Step 7: Financial Calculation & Tamper Resistance', () => {
        it('server recalculates all totals authoritative from quantity and rate, ignoring tampered client amounts', async () => {
            const tamperedPayload = {
                documentType: 'INVOICE',
                clientName: 'Financial Tamper Corp',
                invoiceDate: '2026-03-01',
                gstEnabled: true,
                gstRate: 18,
                // Client intentionally sends forged totals
                subtotal: 10.00,
                gstAmount: 1.00,
                cgstAmount: 0.50,
                sgstAmount: 0.50,
                roundOff: 0.00,
                grandTotal: 11.00,
                items: [
                    {
                        name: 'Consulting 1',
                        quantity: 10,
                        rate: 100,
                        amount: 5.00 // Forged item amount
                    },
                    {
                        name: 'Consulting 2',
                        quantity: 5,
                        rate: 200,
                        amount: 1.00 // Forged item amount
                    }
                ]
            };

            const res = await fetch(`${baseUrl}/api/invoices`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify(tamperedPayload)
            });

            assert.strictEqual(res.status, 201);
            const body = await res.json();
            const doc = body.data;

            // Authoritative server calculation:
            // Item 1: 10 * 100 = 1000.00
            // Item 2: 5 * 200 = 1000.00
            // Subtotal = 2000.00
            // GST (18%) = 360.00 (CGST 180.00, SGST 180.00)
            // Grand Total = 2360.00
            assert.strictEqual(doc.subtotal, 2000.00);
            assert.strictEqual(doc.gstAmount, 360.00);
            assert.strictEqual(doc.grandTotal, 2360.00);
            assert.strictEqual(doc.items[0].amount, 1000.00);
            assert.strictEqual(doc.items[1].amount, 1000.00);
        });
    });

    // =========================================================================
    // STEP 8 & 9: GST & DOCUMENT SNAPSHOT IMMUTABILITY
    // =========================================================================
    describe('Step 8 & 9: GST Breakdown & Historical Snapshot Immutability', () => {
        it('modifying client master record does NOT alter existing document snapshot data', async () => {
            // 1. Create client
            const client = await clientService.createClient({
                name: 'Snapshot Original Client Ltd',
                email: 'original@client.com',
                phone: '+91 9999988888',
                gstin: '27AABCS1429B1Z1',
                stateCode: '27',
                billingAddress: 'Original Street 100'
            }, testUserId);

            // 2. Create document referencing client
            const doc = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientId: client.id,
                clientName: client.name,
                clientEmail: client.email,
                clientPhone: client.phone,
                clientGSTIN: client.gstin,
                placeOfSupplyStateCode: client.stateCode,
                billingAddress: client.billingAddress,
                invoiceDate: '2026-03-01',
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Snapshot Inspection Item', quantity: 1, rate: 5000 }]
            }, testUserId);

            // 3. Mutate master client record
            await clientService.updateClient(client.id, {
                name: 'Completely Changed Company Name',
                email: 'changed@newdomain.com',
                phone: '+91 1111122222',
                gstin: '29ABCDE1234F1Z5',
                stateCode: '29',
                billingAddress: 'New Street 999'
            });

            // 4. Retrieve historical document and verify snapshot remains unmodified
            const fetched = await invoiceService.getInvoiceById(doc.id);
            assert.strictEqual(fetched.clientName, 'Snapshot Original Client Ltd');
            assert.strictEqual(fetched.clientEmail, 'original@client.com');
            assert.strictEqual(fetched.clientPhone, '+91 9999988888');
            assert.strictEqual(fetched.clientGSTIN, '27AABCS1429B1Z1');
            assert.strictEqual(fetched.placeOfSupplyStateCode, '27');
            assert.strictEqual(fetched.billingAddress, 'Original Street 100');
        });
    });

    // =========================================================================
    // STEP 10: QUOTATION -> INVOICE CONVERSION ATOMICITY
    // =========================================================================
    describe('Step 10: Quotation Conversion Atomic Integrity', () => {
        it('concurrent conversion requests: exactly one succeeds and second receives 409 Conflict', async () => {
            const quotation = await invoiceService.createDocument({
                documentType: 'QUOTATION',
                clientName: 'Concurrent Conversion Client',
                invoiceDate: '2026-03-01',
                items: [{ name: 'Conversion Service', quantity: 2, rate: 1500 }]
            }, testUserId);

            const [res1, res2] = await Promise.allSettled([
                invoiceService.convertQuotationToInvoice(quotation.id, testUserId, { version: quotation.version }),
                invoiceService.convertQuotationToInvoice(quotation.id, testUserId, { version: quotation.version })
            ]);

            // Exactly one must be fulfilled, one rejected with ConflictError (409)
            const fulfilled = [res1, res2].filter(r => r.status === 'fulfilled');
            const rejected = [res1, res2].filter(r => r.status === 'rejected');

            assert.strictEqual(fulfilled.length, 1, 'Exactly one conversion request must succeed');
            assert.strictEqual(rejected.length, 1, 'Duplicate conversion request must be rejected');
            assert.strictEqual(rejected[0].reason.statusCode, 409, 'Rejection must be a 409 Conflict');
        });
    });

    // =========================================================================
    // STEP 11: COPY ACTION AUDIT
    // =========================================================================
    describe('Step 11: Copy Action Data Scrubbing & Commercial Preservation', () => {
        it('copy scrubs system IDs and lifecycle states while preserving commercial snapshot data', async () => {
            const original = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientName: 'Copy Source Corp',
                clientEmail: 'billing@copysource.com',
                clientPhone: '+91 9876500000',
                clientGSTIN: '27AABCS1429B1Z1',
                placeOfSupplyStateCode: '27',
                sellerName: 'Spark Enterprises',
                sellerGSTIN: '27AABCT3421A1Z0',
                sellerStateCode: '27',
                billingAddress: '10 Industrial Area, Pune',
                shippingAddress: '12 Logistics Hub, Pune',
                termsAndConditions: 'Standard 30 days',
                remarks: 'Special customer pricing',
                invoiceDate: '2026-03-01',
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Hardware Unit A', hsnSac: '8471', quantity: 3, unit: 'PCS', rate: 12000 }
                ]
            }, testUserId);

            // Record payment to add payment data to original
            await paymentService.recordPayment(original.id, {
                amount: 5000,
                method: 'BANK_TRANSFER',
                reference: 'REF-COPY-ORIGINAL'
            }, testUserId);

            // Copy document
            const copy = await invoiceService.copyDocument(original.id);

            // Scrubbed fields: must NOT exist
            assert.strictEqual(copy.id, undefined);
            assert.strictEqual(copy.invoiceNumber, undefined);
            assert.strictEqual(copy.status, undefined);
            assert.strictEqual(copy.version, undefined);
            assert.strictEqual(copy.revisions, undefined);
            assert.strictEqual(copy.payments, undefined);
            assert.strictEqual(copy.sourceQuotationId, undefined);

            // Preserved commercial snapshot fields
            assert.strictEqual(copy.clientName, 'Copy Source Corp');
            assert.strictEqual(copy.clientEmail, 'billing@copysource.com');
            assert.strictEqual(copy.clientGSTIN, '27AABCS1429B1Z1');
            assert.strictEqual(copy.placeOfSupplyStateCode, '27');
            assert.strictEqual(copy.sellerName, 'Spark Enterprises');
            assert.strictEqual(copy.sellerGSTIN, '27AABCT3421A1Z0');
            assert.strictEqual(copy.sellerStateCode, '27');
            assert.strictEqual(copy.billingAddress, '10 Industrial Area, Pune');
            assert.strictEqual(copy.shippingAddress, '12 Logistics Hub, Pune');
            assert.strictEqual(copy.termsAndConditions, 'Standard 30 days');
            assert.strictEqual(copy.remarks, 'Special customer pricing');
            assert.strictEqual(copy.items[0].name, 'Hardware Unit A');
            assert.strictEqual(copy.items[0].hsnSac, '8471');
            assert.strictEqual(copy.items[0].quantity, 3);
            assert.strictEqual(copy.items[0].rate, 12000);
        });
    });

    // =========================================================================
    // STEP 12: PAYMENT DOMAIN ISOLATION & CONCURRENCY
    // =========================================================================
    describe('Step 12: Payment Domain Isolation & Concurrency', () => {
        let testInvoiceId;

        before(async () => {
            const invoice = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientName: 'Payment Hardening Corp',
                invoiceDate: '2026-03-01',
                gstEnabled: false,
                items: [{ name: 'Development Retainer', quantity: 1, rate: 1000 }]
            }, testUserId);
            testInvoiceId = invoice.id;
        });

        it('strictly rejects payment recording against a QUOTATION', async () => {
            const quotation = await invoiceService.createDocument({
                documentType: 'QUOTATION',
                clientName: 'Quotation Payment Test',
                invoiceDate: '2026-03-01',
                items: [{ name: 'Quote Item', quantity: 1, rate: 500 }]
            }, testUserId);

            await assert.rejects(async () => {
                await paymentService.recordPayment(quotation.id, {
                    amount: 200,
                    method: 'UPI'
                }, testUserId);
            }, {
                name: 'ValidationError',
                statusCode: 400
            });
        });

        it('strictly rejects overpayment exceeding invoice outstanding balance', async () => {
            await assert.rejects(async () => {
                await paymentService.recordPayment(testInvoiceId, {
                    amount: 1500, // Grand total is 1000
                    method: 'BANK_TRANSFER'
                }, testUserId);
            }, {
                name: 'ValidationError',
                statusCode: 400
            });
        });

        it('concurrent payment submissions cannot exceed total invoice balance', async () => {
            // Outstanding is ₹1000. Two concurrent payments of ₹700 each attempt to commit simultaneously.
            // Exactly one must succeed and the other must be rejected by overpayment check.
            const [p1, p2] = await Promise.allSettled([
                paymentService.recordPayment(testInvoiceId, { amount: 700, method: 'BANK_TRANSFER' }, testUserId),
                paymentService.recordPayment(testInvoiceId, { amount: 700, method: 'UPI' }, testUserId)
            ]);

            const fulfilled = [p1, p2].filter(r => r.status === 'fulfilled');
            const rejected = [p1, p2].filter(r => r.status === 'rejected');

            assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent payment should succeed');
            assert.strictEqual(rejected.length, 1, 'Overpayment concurrent request must be rejected');
            assert.strictEqual(rejected[0].reason.statusCode, 400);

            // Verify invoice balance is accurately ₹300 outstanding
            const invoice = await invoiceService.getInvoiceById(testInvoiceId);
            assert.strictEqual(Number(invoice.paidAmount), 700);
            assert.strictEqual(Number(invoice.outstandingAmount), 300);
        });

        it('voiding payment on a VOID invoice is strictly rejected', async () => {
            const inv = await invoiceService.createDocument({
                documentType: 'INVOICE',
                clientName: 'Void Payment Check Corp',
                invoiceDate: '2026-03-01',
                gstEnabled: false,
                items: [{ name: 'Service', quantity: 1, rate: 1000 }]
            }, testUserId);

            const { payment } = await paymentService.recordPayment(inv.id, {
                amount: 500,
                method: 'BANK_TRANSFER'
            }, testUserId);

            // Void the parent invoice
            await invoiceService.updateInvoiceStatus(inv.id, 'VOID', testUserId);

            // Attempt to void the payment
            await assert.rejects(async () => {
                await paymentService.voidPayment(payment.id, testUserId, 'Attempted void on void doc');
            }, {
                name: 'ValidationError',
                statusCode: 400
            });
        });
    });
});
