'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — STANDALONE PURCHASE ORDER & INVENTORY ACCEPTANCE (CDP)
 * ==============================================================================
 *
 * Runs end-to-end browser acceptance verification against the isolated disposable
 * test instance on port 3001 using Chrome DevTools Protocol (CDP):
 *
 * 1. Auth & Session Verification
 * 2. Form Validation: Missing Supplier & Invalid Quantities
 * 3. Multi-Line Item Purchase Order Creation & Calculation (Subtotal, Qty, Total)
 * 4. Document Persistence & Detail View Verification
 * 5. Document Editing: Permitted Fields & Updated Calculations
 * 6. Duplicate PO Number Rejection (HTTP 409 Conflict)
 * 7. Mobile Viewport Layout & Responsiveness (375px)
 * 8. Void / Cancellation Action & Invariant Protection
 * 9. Inventory Receipt & Stock Movement Ledger Balancing (Idempotency, Balance)
 * 10. Order-to-Bill Linking & Liability Recognition
 * ==============================================================================
 */

if (!process.env.NODE_ENV || process.env.NODE_ENV === 'test') {
    process.env.NODE_ENV = 'test';
    require('dotenv').config({ path: '.env.test', override: true });
} else {
    require('dotenv').config();
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const prisma = require('../app/config/prisma');

class CdpSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.msgId = 0;
        this.callbacks = new Map();
        this.ws = null;
        this.consoleErrors = [];
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = () => resolve();
            this.ws.onerror = (err) => reject(err);
            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                if (data.id && this.callbacks.has(data.id)) {
                    const { resolve, reject } = this.callbacks.get(data.id);
                    this.callbacks.delete(data.id);
                    if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
                    else resolve(data.result);
                } else if (data.method === 'Runtime.consoleAPICalled') {
                    if (data.params.type === 'error') {
                        const text = (data.params.args || []).map(a => a.value || a.description || '').join(' ');
                        this.consoleErrors.push(text);
                    }
                } else if (data.method === 'Page.javascriptDialogOpening') {
                    this.send('Page.handleJavaScriptDialog', { accept: true, promptText: 'Acceptance Test Reason' }).catch(() => {});
                }
            };
        });
    }

    async send(method, params = {}) {
        const id = ++this.msgId;
        const msg = JSON.stringify({ id, method, params });
        return new Promise((resolve, reject) => {
            this.callbacks.set(id, { resolve, reject });
            this.ws.send(msg);
        });
    }

    async eval(expression) {
        let code = expression.trim();
        if (!/\breturn\b/.test(code) && !code.includes(';')) {
            code = `return (${code});`;
        }
        const wrapped = `(async () => {\n${code}\n})()`;
        const res = await this.send('Runtime.evaluate', {
            expression: wrapped,
            returnByValue: true,
            awaitPromise: true
        });
        if (res.exceptionDetails) {
            throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result ? res.result.value : undefined;
    }

    async captureScreenshot(filepath) {
        const res = await this.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(filepath, Buffer.from(res.data, 'base64'));
        console.log(`  [SCREENSHOT] Saved: ${filepath}`);
    }

    async close() {
        if (this.ws) this.ws.close();
    }
}

async function runPurchaseOrderAcceptance() {
    const BASE_URL = 'http://127.0.0.1:3001';
    const screenshotDir = path.resolve('C:/Users/USER/.gemini/antigravity-ide/brain/1fd44856-a14c-4c09-a607-af5c9eb7ed71/browser');
    if (!fs.existsSync(screenshotDir)) {
        fs.mkdirSync(screenshotDir, { recursive: true });
    }

    console.log('================================================================');
    console.log('SPARK ADMIN — STANDALONE PURCHASE ORDER & INVENTORY ACCEPTANCE');
    console.log(`Target Instance: ${BASE_URL}`);
    console.log('================================================================\n');

    // 0. Database Safety Check
    const dbRows = await prisma.$queryRaw`SELECT DATABASE() as db`;
    const activeDb = dbRows[0]?.db;
    console.log(`[SAFETY CHECK] Connected database: "${activeDb}"`);
    const protectedDbs = ['admin', 'spark_admin', 'spark_admin_test', 'spark_admin_prod', 'spark_admin_prod_test'];
    if (protectedDbs.includes(activeDb)) {
        throw new Error(`CRITICAL: Prohibited attempt to run test against protected database "${activeDb}"!`);
    }

    // Connect to Chrome target
    const targetRes = await fetch('http://127.0.0.1:9222/json/new?' + encodeURIComponent(`${BASE_URL}/login`), { method: 'PUT' });
    const targetInfo = await targetRes.json();
    console.log(`[CHROME] Opened page target: ${targetInfo.id}`);

    const cdp = new CdpSession(targetInfo.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    const testResults = [];

    function recordTest(scenario, route, action, expected, actual, passed) {
        testResults.push({ scenario, route, action, expected, actual, passed });
        const tag = passed ? '[PASS]' : '[FAIL]';
        console.log(`${tag} [${scenario}] ${action} -> ${actual}`);
    }

    try {
        await new Promise(r => setTimeout(r, 1000));

        // -------------------------------------------------------------
        // STEP 1: AUTHENTICATION
        // -------------------------------------------------------------
        console.log('\n--- STEP 1: Authenticating Test Administrator ---');
        const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@email.com';
        const adminPassword = process.env.SEED_ADMIN_PASSWORD;

        await cdp.send('Page.navigate', { url: `${BASE_URL}/login` });
        await new Promise(r => setTimeout(r, 1500));

        const isLoginPage = await cdp.eval(`document.getElementById('email') !== null`);
        if (isLoginPage) {
            await cdp.eval(`
                document.getElementById('email').value = ${JSON.stringify(adminEmail)};
                document.getElementById('password').value = ${JSON.stringify(adminPassword)};
                document.getElementById('loginForm').submit();
            `);
            await new Promise(r => setTimeout(r, 2500));
        }

        const afterLoginUrl = await cdp.eval('window.location.href');
        recordTest(
            'Auth',
            '/login',
            'Log in with test administrator credentials',
            'Redirect to dashboard or workspace',
            `Current URL: ${afterLoginUrl}`,
            afterLoginUrl.includes('/dashboard') || afterLoginUrl === `${BASE_URL}/` || afterLoginUrl.includes('/select-business')
        );

        // Fetch or create a test supplier in the disposable test database
        let supplier = await prisma.supplier.findFirst({ where: { businessId: 1 } });
        if (!supplier) {
            supplier = await prisma.supplier.create({
                data: {
                    businessId: 1,
                    name: 'SHREE MAHALAXMI ENTERPRISES',
                    gstin: '09AMAPG1241K1ZC',
                    address: 'B-31, Sector-9, Noida, Uttar Pradesh',
                    stateCode: '09'
                }
            });
        }

        // -------------------------------------------------------------
        // STEP 2: INVALID DATA REJECTION (MISSING SUPPLIER & INVALID QTY)
        // -------------------------------------------------------------
        console.log('\n--- STEP 2: Form Validation & Client Error Rejection ---');
        await cdp.send('Page.navigate', { url: `${BASE_URL}/purchases/orders/new` });
        await new Promise(r => setTimeout(r, 1500));

        // 2.1 Submit without selecting a supplier
        const missingSupplierResult = await cdp.eval(`
            document.getElementById('supplierSelect').value = '';
            const form = document.getElementById('poForm');
            return form.checkValidity();
        `);
        recordTest(
            'PO Validation',
            '/purchases/orders/new',
            'Check HTML5 required validation when supplier is empty',
            'Form validity is false (submission blocked)',
            `Validity: ${missingSupplierResult}`,
            missingSupplierResult === false
        );

        // 2.2 Attempt API creation with invalid quantity (<= 0)
        const invalidQtyRes = await cdp.eval(`
            const csrfToken = document.getElementById('csrfToken')?.value || '';
            const res = await fetch('/api/purchase-orders', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CSRF-Token': csrfToken,
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({
                    _csrf: csrfToken,
                    supplierId: ${supplier.id},
                    orderDate: '2026-10-18',
                    items: [{ name: 'Invalid Quantity Item', quantity: 0, rate: 100 }]
                })
            });
            const data = await res.json();
            return { status: res.status, ok: res.ok, error: data.error };
        `);
        recordTest(
            'PO Validation',
            '/api/purchase-orders',
            'Submit item line with invalid quantity = 0',
            'HTTP 400 Bad Request with client validation message',
            `Status: ${invalidQtyRes.status}, Error: ${invalidQtyRes.error}`,
            invalidQtyRes.status === 400 && invalidQtyRes.ok === false
        );

        // -------------------------------------------------------------
        // STEP 3: CREATE MULTI-LINE ITEM PURCHASE ORDER
        // -------------------------------------------------------------
        console.log('\n--- STEP 3: Multi-Line Standalone Purchase Order Creation ---');
        const customPoNumber = `PO-E2E-${Date.now().toString().slice(-6)}`;

        // Fill form via browser UI
        await cdp.eval(`
            document.getElementById('orderNumberInput').value = ${JSON.stringify(customPoNumber)};
            document.getElementById('supplierSelect').value = '${supplier.id}';
            
            // Row 1
            const rows = document.querySelectorAll('#itemsBody tr');
            rows[0].querySelector('.item-name').value = 'Structural MS Beams 100mm';
            rows[0].querySelector('.item-hsn').value = '7216';
            rows[0].querySelector('.item-qty').value = '15.00';
            rows[0].querySelector('.item-rate').value = '1200.00';
            
            // Add Row 2
            addItem();
            const updatedRows = document.querySelectorAll('#itemsBody tr');
            updatedRows[1].querySelector('.item-name').value = 'High-Tensile Galvanized Fasteners M16';
            updatedRows[1].querySelector('.item-hsn').value = '7318';
            updatedRows[1].querySelector('.item-qty').value = '50.00';
            updatedRows[1].querySelector('.item-rate').value = '85.50';

            calcTotals();
        `);
        await new Promise(r => setTimeout(r, 600));

        // Verify live UI calculation
        const liveCalc = await cdp.eval(`
            return {
                totalQty: document.getElementById('totalQtyDisplay').textContent.trim(),
                subtotal: document.getElementById('subtotalDisplay').textContent.trim(),
                grandTotal: document.getElementById('grandTotalDisplay').textContent.trim()
            };
        `);

        // Row 1: 15 * 1200 = 18,000. Row 2: 50 * 85.50 = 4,275. Subtotal = 22,275.00. Total Qty = 65.00.
        const expectedSubtotal = '₹22275.00';
        const expectedQty = '65.00';
        recordTest(
            'PO Live Totals',
            '/purchases/orders/new',
            'Calculate line totals, quantity sum and subtotal live in DOM',
            `Qty: ${expectedQty}, Subtotal: ${expectedSubtotal}`,
            `Actual: Qty ${liveCalc.totalQty}, Subtotal ${liveCalc.subtotal}`,
            liveCalc.totalQty === expectedQty && liveCalc.subtotal === expectedSubtotal && liveCalc.grandTotal === expectedSubtotal
        );

        // Submit PO via browser
        try {
            await cdp.eval(`document.getElementById('savePoBtn').click();`);
        } catch (e) {
            // Target navigation is expected when submit redirects to detail page
        }
        await new Promise(r => setTimeout(r, 2500));

        // Find the newly created PO in the database
        const createdPo = await prisma.purchaseOrder.findFirst({
            where: { orderNumber: customPoNumber },
            include: { items: true, supplier: true }
        });

        recordTest(
            'PO Creation',
            '/api/purchase-orders',
            `Persist Purchase Order ${customPoNumber} with 2 line items`,
            'Record created in DB with status ACTIVE and 2 items',
            `Created ID: ${createdPo ? createdPo.id : 'NONE'}, Items: ${createdPo ? createdPo.items.length : 0}`,
            createdPo !== null && createdPo.status === 'ACTIVE' && createdPo.items.length === 2
        );

        const poId = createdPo.id;

        // -------------------------------------------------------------
        // STEP 4: PERSISTED DOCUMENT & DETAIL VIEW VERIFICATION
        // -------------------------------------------------------------
        console.log('\n--- STEP 4: Persisted Document View Verification ---');
        await cdp.send('Page.navigate', { url: `${BASE_URL}/purchases/orders/${poId}` });
        await new Promise(r => setTimeout(r, 1500));

        const persistedData = await cdp.eval(`
            return {
                orderNumber: document.getElementById('orderNumberInput').value,
                supplierId: document.getElementById('supplierSelect').value,
                totalQty: document.getElementById('totalQtyDisplay').textContent.trim(),
                grandTotal: document.getElementById('grandTotalDisplay').textContent.trim(),
                rowCount: document.querySelectorAll('#itemsBody tr').length
            };
        `);

        recordTest(
            'PO Persistence',
            `/purchases/orders/${poId}`,
            'Load saved PO and verify all line items and totals match database',
            `PO: ${customPoNumber}, Rows: 2, Total: ₹22275.00`,
            `Loaded: PO ${persistedData.orderNumber}, Rows: ${persistedData.rowCount}, Total: ${persistedData.grandTotal}`,
            persistedData.orderNumber === customPoNumber &&
            persistedData.rowCount === 2 &&
            persistedData.grandTotal === '₹22275.00'
        );

        // Capture Desktop Screenshot
        const desktopScreenshot = path.join(screenshotDir, 'e2e_po_detail_desktop.png');
        await cdp.captureScreenshot(desktopScreenshot);

        // -------------------------------------------------------------
        // STEP 5: PERMITTED FIELD EDITING
        // -------------------------------------------------------------
        console.log('\n--- STEP 5: Permitted Field Editing ---');
        const updatedRemarks = 'Approved for structural steel assembly delivery at Site A';
        await cdp.eval(`
            document.querySelector('textarea[name="remarks"]').value = ${JSON.stringify(updatedRemarks)};
            // Update line 2 qty from 50 to 60 (New total = 18000 + (60 * 85.50) = 18000 + 5130 = 23130)
            const rows = document.querySelectorAll('#itemsBody tr');
            rows[1].querySelector('.item-qty').value = '60.00';
            calcTotals();
        `);
        await new Promise(r => setTimeout(r, 500));

        // Submit update via UI button
        try {
            await cdp.eval(`document.getElementById('savePoBtn').click();`);
        } catch (e) {
            // Target navigation is expected
        }
        await new Promise(r => setTimeout(r, 2000));

        // Re-read updated PO from DB
        const updatedPo = await prisma.purchaseOrder.findUnique({
            where: { id: poId },
            include: { items: true }
        });

        const totalUpdatedAmount = updatedPo.items.reduce((acc, i) => acc + parseFloat(i.amount), 0);
        recordTest(
            'PO Editing',
            `/purchases/orders/${poId}`,
            'Update line item quantity to 60 and update remarks',
            'Line 2 recalculated to 5130.00, total PO value becomes 23130.00, version incremented',
            `Updated total: ₹${totalUpdatedAmount.toFixed(2)}, Version: ${updatedPo.version}`,
            totalUpdatedAmount === 23130.00 && updatedPo.remarks === updatedRemarks && updatedPo.version >= 2
        );

        // -------------------------------------------------------------
        // STEP 6: DUPLICATE DOCUMENT NUMBER REJECTION
        // -------------------------------------------------------------
        console.log('\n--- STEP 6: Duplicate Document Number Protection ---');
        const dupRes = await cdp.eval(`
            const csrfToken = document.getElementById('csrfToken')?.value || '';
            const res = await fetch('/api/purchase-orders', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CSRF-Token': csrfToken,
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({
                    _csrf: csrfToken,
                    supplierId: ${supplier.id},
                    orderNumber: ${JSON.stringify(customPoNumber)},
                    orderDate: '2026-10-18',
                    items: [{ name: 'Duplicate Test Line', quantity: 1, rate: 500 }]
                })
            });
            const data = await res.json();
            return { status: res.status, ok: res.ok, error: data.error };
        `);

        recordTest(
            'PO Duplicate Guard',
            '/api/purchase-orders',
            `Attempt to create second PO with duplicate orderNumber '${customPoNumber}'`,
            'HTTP 409 Conflict with message indicating number already exists',
            `Status: ${dupRes.status}, Error: ${dupRes.error}`,
            dupRes.status === 409 && dupRes.ok === false && dupRes.error.includes('already exists')
        );

        // -------------------------------------------------------------
        // STEP 7: MOBILE VIEWPORT LAYOUT & RESPONSIVENESS (375PX)
        // -------------------------------------------------------------
        console.log('\n--- STEP 7: Mobile Viewport Layout & Responsiveness ---');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
        await new Promise(r => setTimeout(r, 800));

        const mobileScreenshot = path.join(screenshotDir, 'e2e_po_detail_mobile_375px.png');
        await cdp.captureScreenshot(mobileScreenshot);

        const hasMobileOverflow = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 5`);
        recordTest(
            'Responsive Layout',
            `/purchases/orders/${poId}`,
            'Inspect mobile layout at 375px viewport for horizontal overflow',
            'No unconstrained horizontal page overflow beyond viewport',
            `Overflow detected: ${hasMobileOverflow}`,
            hasMobileOverflow === false
        );

        // Clear device metrics
        await cdp.send('Emulation.clearDeviceMetricsOverride');

        // -------------------------------------------------------------
        // STEP 8: VOID / CANCELLATION LIFECYCLE
        // -------------------------------------------------------------
        console.log('\n--- STEP 8: Void / Cancellation Lifecycle ---');
        const voidRes = await cdp.eval(`
            const csrfToken = document.getElementById('csrfToken')?.value || '';
            const res = await fetch('/api/purchase-orders/${poId}/void', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CSRF-Token': csrfToken,
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ reason: 'E2E Cancellation Acceptance Test', _csrf: csrfToken })
            });
            const data = await res.json();
            return { status: res.status, ok: res.ok, statusField: data.purchaseOrder?.status };
        `);

        recordTest(
            'PO Void Action',
            `/api/purchase-orders/${poId}/void`,
            'Execute void action on active purchase order',
            'HTTP 200 with status updated to VOID',
            `Status: ${voidRes.status}, PO Status: ${voidRes.statusField}`,
            voidRes.status === 200 && voidRes.statusField === 'VOID'
        );

        // Attempting to edit a voided PO must be rejected
        const editVoidRes = await cdp.eval(`
            const csrfToken = document.getElementById('csrfToken')?.value || '';
            const res = await fetch('/api/purchase-orders/${poId}', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'CSRF-Token': csrfToken,
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ remarks: 'Illegal edit on void order', _csrf: csrfToken })
            });
            const data = await res.json();
            return { status: res.status, ok: res.ok, error: data.error };
        `);

        recordTest(
            'PO Invariant Guard',
            `/api/purchase-orders/${poId}`,
            'Attempt to edit permitted fields on a VOID purchase order',
            'HTTP 400 rejection preventing modification of voided commitment',
            `Status: ${editVoidRes.status}, Error: ${editVoidRes.error}`,
            editVoidRes.status === 400 && editVoidRes.ok === false && editVoidRes.error.includes('VOID')
        );

        // -------------------------------------------------------------
        // STEP 9: INVENTORY ACCOUNTING & STOCK MOVEMENT INTEGRATION
        // -------------------------------------------------------------
        console.log('\n--- STEP 9: Inventory Accounting & Stock Movement ---');
        const stockMovementService = require('../app/services/stockMovement.service');

        // Find or create an inventory item in disposable DB
        let item = await prisma.item.findFirst({ where: { businessId: 1 } });
        if (!item) {
            item = await prisma.item.create({
                data: {
                    businessId: 1,
                    name: 'Structural Steel Flange 150mm',
                    itemCode: `ITEM-STL-${Date.now().toString().slice(-4)}`,
                    rate: 850.00,
                    unit: 'PCS'
                }
            });
        }

        // 9.1 Record Purchase Receipt of 50 units @ 850.00 into inventory
        const receiptMovement = await stockMovementService.recordStockMovement({
            businessId: 1,
            itemId: item.id,
            movementType: 'RECEIPT',
            quantity: 50,
            unitCost: 850.00,
            referenceType: 'PURCHASE_ORDER',
            referenceId: poId,
            notes: 'Stock received from PO warehouse intake',
            postToLedger: true
        }, 1);

        recordTest(
            'Inventory Receipt',
            'stockMovementService.recordStockMovement',
            'Record RECEIPT of 50 units into stock and post to general ledger',
            'Movement created with positive qty and balanced Journal Entry',
            `Movement #: ${receiptMovement.movementNumber}, Journal Entry: ${receiptMovement.journalEntry?.entryNumber}`,
            receiptMovement.id > 0 && parseFloat(receiptMovement.quantity) === 50 && !!receiptMovement.journalEntry
        );

        // 9.2 Verify Stock Summary (On-hand quantity)
        const summaryAfterReceipt = await stockMovementService.getItemStockSummary(item.id);
        recordTest(
            'Inventory On-Hand',
            'stockMovementService.getItemStockSummary',
            'Query item stock summary after purchase receipt',
            'Stock reflects at least 50 units on hand',
            `Current Stock: ${summaryAfterReceipt.currentStock}, Average Cost: ₹${summaryAfterReceipt.weightedAverageCost}`,
            summaryAfterReceipt.currentStock >= 50
        );

        // 9.3 Idempotency: Attempt to double-post same movement to GL
        let dupPostThrew = false;
        try {
            await stockMovementService.postStockMovementToLedger({
                movementId: receiptMovement.id
            }, 1);
        } catch (e) {
            dupPostThrew = e.name === 'ConflictError' || e.message.includes('already been posted');
        }
        recordTest(
            'Inventory Idempotency',
            'stockMovementService.postStockMovementToLedger',
            'Attempt to post the same stock movement to GL a second time',
            'ConflictError thrown with duplicate posting prevention message',
            `Duplicate post rejected: ${dupPostThrew}`,
            dupPostThrew === true
        );

        // 9.4 Project Stock Issue (Issue 20 units to project)
        let testProject = await prisma.project.findFirst({ where: { businessId: 1 } });
        if (!testProject) {
            testProject = await prisma.project.create({
                data: {
                    businessId: 1,
                    code: `PRJ-INV-${Date.now().toString().slice(-4)}`,
                    name: 'Steel Truss Construction Project',
                    status: 'ACTIVE',
                    billingType: 'FIXED_PRICE'
                }
            });
        }

        const issueMovement = await stockMovementService.recordStockMovement({
            businessId: 1,
            itemId: item.id,
            movementType: 'ISSUE',
            quantity: 20,
            unitCost: 850.00,
            referenceType: 'PROJECT',
            referenceId: testProject.id,
            notes: 'Issued steel flanges to site fabrication',
            postToLedger: true
        }, 1);

        const summaryAfterIssue = await stockMovementService.getItemStockSummary(item.id);
        recordTest(
            'Project Stock Issue',
            'stockMovementService.recordStockMovement',
            'Issue 20 units to project and verify stock reduction without double counting',
            'On-hand stock decreased by 20 units; COGS / project expense recognised at consumption',
            `New Stock: ${summaryAfterIssue.currentStock} (Decreased by 20)`,
            summaryAfterIssue.currentStock === summaryAfterReceipt.currentStock - 20
        );

        // 9.5 Negative Stock Rejection
        let negStockThrew = false;
        try {
            await stockMovementService.recordStockMovement({
                businessId: 1,
                itemId: item.id,
                movementType: 'ISSUE',
                quantity: 99999, // Exceeds stock
                unitCost: 850.00
            }, 1);
        } catch (e) {
            negStockThrew = e.name === 'ValidationError' || e.message.includes('Insufficient stock');
        }
        recordTest(
            'Negative Stock Guard',
            'stockMovementService.recordStockMovement',
            'Attempt outward stock movement exceeding current on-hand inventory',
            'ValidationError thrown: Insufficient stock',
            `Rejection observed: ${negStockThrew}`,
            negStockThrew === true
        );

        // 9.6 Cross-Business Tenancy Isolation on Inventory
        let crossBizThrew = false;
        try {
            // Attempt to record movement for business 2 with item belonging to business 1
            await stockMovementService.recordStockMovement({
                businessId: 2,
                itemId: item.id,
                movementType: 'RECEIPT',
                quantity: 10
            }, 1);
        } catch (e) {
            crossBizThrew = e.message.includes('Cross-business access denied') || e.name === 'ValidationError';
        }
        recordTest(
            'Cross-Business Inventory Guard',
            'stockMovementService.recordStockMovement',
            'Attempt stock movement on item belonging to another business ID',
            'Rejection with Cross-business access denied',
            `Cross-business rejection: ${crossBizThrew}`,
            crossBizThrew === true
        );

        // -------------------------------------------------------------
        // STEP 10: ORDER-TO-BILL LINKING & LIABILITY RECOGNITION
        // -------------------------------------------------------------
        console.log('\n--- STEP 10: Order-to-Bill Linking ---');
        const supplierBillService = require('../app/services/supplierBill.service');

        const activePoForBill = await prisma.purchaseOrder.create({
            data: {
                businessId: 1,
                orderNumber: `PO-BILL-${Date.now().toString().slice(-4)}`,
                supplierId: supplier.id,
                supplierName: supplier.name,
                orderDate: new Date(),
                status: 'ACTIVE',
                createdById: 1,
                updatedById: 1,
                items: {
                    create: [
                        { lineNumber: 1, name: 'Precision CNC Machined Shaft', quantity: 10, rate: 1500, amount: 15000 }
                    ]
                }
            }
        });

        // Create linked supplier bill with tax
        const linkedBill = await supplierBillService.createSupplierBill({
            businessId: 1,
            billNumber: `BILL-PO-${Date.now().toString().slice(-4)}`,
            supplierId: supplier.id,
            billDate: new Date(),
            orderReference: activePoForBill.orderNumber,
            taxableAmount: 15000.00,
            cgstAmount: 1350.00,
            sgstAmount: 1350.00,
            totalAmount: 17700.00,
            items: [
                {
                    lineNumber: 1,
                    name: 'Precision CNC Machined Shaft',
                    quantity: 10,
                    rate: 1500,
                    amount: 15000,
                    taxableAmount: 15000,
                    gstRate: 18,
                    cgstAmount: 1350,
                    sgstAmount: 1350
                }
            ]
        }, 1);

        recordTest(
            'Order-To-Bill Linking',
            'supplierBillService.createSupplierBill',
            `Create supplier bill linked to Purchase Order ${activePoForBill.orderNumber}`,
            'Supplier bill created with orderReference, liability ₹17,700.00 recognized',
            `Bill ID: ${linkedBill.id}, Ref: ${linkedBill.orderReference}, Total: ₹${linkedBill.totalAmount}`,
            linkedBill.id > 0 && linkedBill.orderReference === activePoForBill.orderNumber && parseFloat(linkedBill.totalAmount) === 17700.00
        );

        console.log('\n================================================================');
        console.log('STANDALONE PURCHASE ORDER & INVENTORY ACCEPTANCE SUMMARY');
        console.log('================================================================');
        const passedCount = testResults.filter(t => t.passed).length;
        const totalCount = testResults.length;
        console.log(`Total Scenarios Tested: ${totalCount}`);
        console.log(`Passed: ${passedCount}`);
        console.log(`Failed: ${totalCount - passedCount}`);

        return {
            total: totalCount,
            passed: passedCount,
            failed: totalCount - passedCount,
            results: testResults
        };

    } finally {
        await cdp.close();
        await fetch(`http://127.0.0.1:9222/json/close/${targetInfo.id}`);
    }
}

if (require.main === module) {
    runPurchaseOrderAcceptance()
        .then((summary) => {
            if (summary.failed > 0) {
                console.error(`[COMPLETION] Acceptance failed with ${summary.failed} errors.`);
                process.exit(1);
            } else {
                console.log('[COMPLETION] All 15 Standalone PO & Inventory acceptance scenarios PASSED cleanly.');
                process.exit(0);
            }
        })
        .catch((err) => {
            console.error('[FATAL] Acceptance execution error:', err);
            process.exit(1);
        });
}

module.exports = { runPurchaseOrderAcceptance };
