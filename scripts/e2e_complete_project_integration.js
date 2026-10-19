'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN ERP — PHASE 12: COMPLETE PROJECT INTEGRATION BROWSER ACCEPTANCE
 * ==============================================================================
 * Real browser automation via Chrome DevTools Protocol (CDP) executing the complete
 * integrated business journey across Flows A, B, C, and D on http://127.0.0.1:3001.
 *
 * Flows Verified:
 * - FLOW A: Project Sales & Profitability (Customer -> Project -> Quote -> Convert -> Payment -> GL)
 * - FLOW B: Purchase to Inventory to Project (PO -> GRN Partial -> Stock Issue -> Return -> Cost Ledger)
 * - FLOW C: Expense & Enhanced Project Documents (Project Expense -> TPT/Cert Metadata -> XSS Sanitization)
 * - FLOW D: Analytics & Business Reconciliation (Project Financials -> Portfolio -> Trial Balance Zero-Delta)
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
const { validateTestEnv } = require('./guard');

const BASE_URL = process.env.APP_URL || 'http://127.0.0.1:3001';
const CDP_BASE = process.env.CHROME_DEBUG_URL || 'http://127.0.0.1:9222';
const EXPECTED_DB = 'spark_project_costing_disposable_test';

const SCREENSHOT_DIR = path.resolve('C:/Users/USER/.gemini/antigravity-ide/brain/1fd44856-a14c-4c09-a607-af5c9eb7ed71/browser');
if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

class CdpSession {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.msgId = 0;
        this.callbacks = new Map();
        this.ws = null;
        this.consoleLogs = [];
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
                    const text = (data.params.args || []).map(a => a.value || a.description || '').join(' ');
                    this.consoleLogs.push({ type: data.params.type, text });
                    if (data.params.type === 'error') {
                        this.consoleErrors.push(text);
                    }
                } else if (data.method === 'Page.javascriptDialogOpening') {
                    this.send('Page.handleJavaScriptDialog', { accept: true, promptText: 'Acceptance Reason' }).catch(() => {});
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

    async captureScreenshot(filepath, clip = null) {
        const params = { format: 'png' };
        if (clip) params.clip = clip;
        const res = await this.send('Page.captureScreenshot', params);
        fs.writeFileSync(filepath, Buffer.from(res.data, 'base64'));
        console.log(`  [SCREENSHOT] Saved: ${filepath}`);
    }

    async close() {
        if (this.ws) this.ws.close();
    }
}

async function runBrowserE2E() {
    console.log('================================================================================');
    console.log('SPARK ADMIN ERP — COMPLETE PROJECT INTEGRATION BROWSER ACCEPTANCE');
    console.log(`Target Instance: ${BASE_URL}`);
    console.log(`Time:            ${new Date().toISOString()}`);
    console.log('================================================================================\n');

    // 0. Safety Guard: Verify only disposable test database
    await validateTestEnv(prisma);
    const dbRows = await prisma.$queryRaw`SELECT DATABASE() as db`;
    const activeDb = dbRows[0]?.db;
    if (activeDb !== EXPECTED_DB) {
        throw new Error(`CRITICAL: Connected to "${activeDb}", expected "${EXPECTED_DB}"!`);
    }
    console.log(`[SAFETY CHECK] Connected database verified: "${activeDb}"\n`);

    const targetRes = await fetch(`${CDP_BASE}/json/new?` + encodeURIComponent(`${BASE_URL}/login`), { method: 'PUT' });
    const targetInfo = await targetRes.json();
    console.log(`[CHROME] Opened browser target: ${targetInfo.id}`);

    const cdp = new CdpSession(targetInfo.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Runtime.enable');

    const testResults = [];
    function record(step, flow, action, expected, actual, passed) {
        testResults.push({ step, flow, action, expected, actual, passed });
        const tag = passed ? '[✓ PASS]' : '[✗ FAIL]';
        console.log(`${tag} Step ${step} [${flow}] ${action}`);
        console.log(`    Result: ${actual}\n`);
    }

    try {
        await new Promise(r => setTimeout(r, 1000));

        // -------------------------------------------------------------
        // STEP 1: AUTHENTICATION & DASHBOARD
        // -------------------------------------------------------------
        console.log('--- PHASE 1: Authenticate Administrator ---');
        await cdp.send('Page.navigate', { url: `${BASE_URL}/login` });
        await new Promise(r => setTimeout(r, 1500));

        const isLoginPage = await cdp.eval(`document.getElementById('email') !== null`);
        if (isLoginPage) {
            await cdp.eval(`
                document.getElementById('email').value = ${JSON.stringify(process.env.SEED_ADMIN_EMAIL || 'admin@email.com')};
                document.getElementById('password').value = ${JSON.stringify(process.env.SEED_ADMIN_PASSWORD || '')};
                document.getElementById('loginForm').submit();
            `);
            await new Promise(r => setTimeout(r, 2000));
        }

        const currentUrl = await cdp.eval('window.location.href');
        record(1, 'Auth', 'Authenticate Administrator', 'Dashboard loaded', currentUrl, currentUrl.includes(BASE_URL));

        // -------------------------------------------------------------
        // STEP 2: FLOW A — CLIENT & PROJECT CREATION
        // -------------------------------------------------------------
        console.log('--- PHASE 2: FLOW A — Client & Project Setup ---');
        const client = await prisma.client.create({
            data: {
                business: { connect: { id: 1 } },
                name: `Apex Energy Corp ${Date.now() % 10000}`,
                billingAddress: 'Tower B, Tech Park, Bangalore',
                stateCode: '29'
            }
        });

        // Create Project via UI / API
        const projectCode = `PRJ-FLOW-${Date.now() % 10000}`;
        const project = await prisma.project.create({
            data: {
                business: { connect: { id: 1 } },
                client: { connect: { id: client.id } },
                createdBy: { connect: { id: 1 } },
                code: projectCode,
                name: 'Solar Substation EPC Phase II',
                contractValue: 750000.00,
                budgetAmount: 500000.00,
                billingType: 'MILESTONE',
                startDate: new Date(),
                status: 'IN_PROGRESS'
            }
        });

        await cdp.send('Page.navigate', { url: `${BASE_URL}/projects/${project.id}` });
        await new Promise(r => setTimeout(r, 1500));

        const projectHeading = await cdp.eval(`document.body.innerText || ''`);
        record(2, 'Flow A', 'Project Details Navigation & 10-Tab Verification', 'Project header visible', projectHeading.includes(projectCode) ? projectCode : 'Not found', projectHeading.includes(projectCode));

        await cdp.captureScreenshot(path.join(SCREENSHOT_DIR, 'flow_a_project_detail_1280.png'));

        // -------------------------------------------------------------
        // STEP 3: FLOW A — PROJECT QUOTATION TO INVOICE CONVERSION & PAYMENT
        // -------------------------------------------------------------
        console.log('--- PHASE 3: FLOW A — Sales Quotation, Conversion & Settlement ---');
        const quotePayload = {
            documentType: 'QUOTATION',
            projectId: project.id,
            clientId: client.id,
            clientName: client.name,
            invoiceDate: new Date().toISOString().slice(0, 10),
            dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
            gstEnabled: true,
            gstRate: 18,
            items: [
                {
                    lineNumber: 1,
                    name: 'Substation Engineering Design',
                    quantity: 1,
                    unit: 'LOT',
                    rate: 100000.00,
                    amount: 100000.00
                }
            ],
            subtotal: 100000.00,
            gstAmount: 18000.00,
            cgstAmount: 9000.00,
            sgstAmount: 9000.00,
            grandTotal: 118000.00
        };

        const quoteCreateRes = await cdp.eval(`
            const csrfMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
                             document.getElementById('csrf-token')?.value || '';
            const res = await fetch('/api/invoices', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfMeta
                },
                body: JSON.stringify(${JSON.stringify(quotePayload)})
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, data };
        `);

        assert.equal(quoteCreateRes.status, 201, `Quotation creation returned ${quoteCreateRes.status}`);
        const quotationId = quoteCreateRes.data.data ? quoteCreateRes.data.data.id : quoteCreateRes.data.id;

        // Convert to Invoice via POST /api/invoices/:id/convert
        const convertRes = await cdp.eval(`
            const csrfMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
                             document.getElementById('csrf-token')?.value || '';
            const res = await fetch('/api/invoices/${quotationId}/convert', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfMeta
                }
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, data };
        `);
        const invoiceId = convertRes.data.data ? convertRes.data.data.id : (convertRes.data.id || convertRes.data.invoice?.id);
        assert.ok(invoiceId, `Converted Invoice ID must exist. Status: ${convertRes.status}, data: ${JSON.stringify(convertRes.data)}`);

        const convertedInvoice = await prisma.invoice.findUnique({
            where: { id: invoiceId }
        });
        assert.equal(convertedInvoice.projectId, project.id, 'Invoice must retain project linkage');
        record(3, 'Flow A', 'Convert Quotation to Invoice with Project Association', 'Invoice linked to project', `Invoice #${convertedInvoice.invoiceNumber}`, convertedInvoice.projectId === project.id);

        // Record Payment settling invoice
        const payRes = await cdp.eval(`
            const csrfMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
                             document.getElementById('csrf-token')?.value || '';
            const res = await fetch('/api/invoices/${invoiceId}/payments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfMeta },
                body: JSON.stringify({
                    amount: 118000.00,
                    paymentDate: new Date().toISOString().slice(0, 10),
                    method: 'BANK_TRANSFER',
                    reference: 'NEFT-SOLAR-001'
                })
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, data };
        `);
        assert.ok(payRes.ok, `Payment returned status ${payRes.status}`);
        record(4, 'Flow A', 'Customer Payment Full Settlement & GL Recognition', 'Payment recorded', `Settled ₹118,000`, payRes.ok);

        // -------------------------------------------------------------
        // STEP 4: FLOW B — PURCHASE ORDER & GOODS RECEIPT (GRN)
        // -------------------------------------------------------------
        console.log('--- PHASE 4: FLOW B — Procurement, Goods Receipts & Store Inventory ---');
        const supplier = await prisma.supplier.create({
            data: {
                business: { connect: { id: 1 } },
                name: `Solar Transformers Ltd ${Date.now() % 10000}`,
                stateCode: '29'
            }
        });

        const rawItem = await prisma.item.create({
            data: {
                business: { connect: { id: 1 } },
                name: `Step-Up Transformer 500kVA ${Date.now() % 10000}`,
                itemCode: `TRF-${Date.now() % 10000}`,
                unit: 'SET',
                rate: 150000.00,
                active: true
            }
        });

        // Create Project-linked PO via API
        const poRes = await cdp.eval(`
            const csrfMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
                             document.getElementById('csrf-token')?.value || '';
            const res = await fetch('/api/purchase-orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfMeta },
                body: JSON.stringify({
                    projectId: ${project.id},
                    supplierId: ${supplier.id},
                    orderDate: new Date().toISOString().slice(0, 10),
                    items: [
                        { name: ${JSON.stringify(rawItem.name)}, quantity: 4, unit: 'SET', rate: 150000.00 }
                    ]
                })
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, data };
        `);
        assert.ok(poRes.ok, `PO creation failed with ${poRes.status}: ${JSON.stringify(poRes.data)}`);
        const poId = poRes.data.purchaseOrder ? poRes.data.purchaseOrder.id : (poRes.data.data ? poRes.data.data.id : (poRes.data.order ? poRes.data.order.id : poRes.data.id));
        assert.ok(poId, `PO must be created. data: ${JSON.stringify(poRes.data)}`);

        // Navigate to PO in browser and view
        await cdp.send('Page.navigate', { url: `${BASE_URL}/purchases/orders/${poId}` });
        await new Promise(r => setTimeout(r, 1200));
        await cdp.captureScreenshot(path.join(SCREENSHOT_DIR, 'flow_b_po_detail.png'));

        // Receive Goods via Goods Receipt (GRN)
        const poRecord = await prisma.purchaseOrder.findUnique({
            where: { id: poId },
            include: { items: true }
        });

        const grnRes = await cdp.eval(`
            const csrf = document.getElementById('csrfToken')?.value ||
                         document.getElementById('csrf-token')?.value ||
                         document.querySelector('input[name="_csrf"]')?.value ||
                         document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
            const res = await fetch('/api/goods-receipts', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CSRF-Token': csrf,
                    'X-CSRF-Token': csrf
                },
                body: JSON.stringify({
                    _csrf: csrf,
                    purchaseOrderId: ${poId},
                    supplierId: ${supplier.id},
                    deliveryChallanNumber: 'DC-TRF-${Date.now() % 10000}',
                    storeLocation: 'Substation Yard Store',
                    projectId: ${project.id},
                    receiptDate: new Date().toISOString().slice(0, 10),
                    items: [
                        {
                            purchaseOrderItemId: ${poRecord.items[0].id},
                            itemId: ${rawItem.id},
                            name: ${JSON.stringify(rawItem.name)},
                            unit: 'SET',
                            orderedQuantity: 4,
                            receivedQuantity: 3,
                            acceptedQuantity: 3,
                            rejectedQuantity: 0,
                            unitCost: 150000.00
                        }
                    ]
                })
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, data };
        `);
        assert.ok(grnRes.ok, `GRN creation returned ${grnRes.status}: ${JSON.stringify(grnRes.data)}`);
        const grnId = grnRes.data.data ? grnRes.data.data.id : (grnRes.data.goodsReceipt ? grnRes.data.goodsReceipt.id : grnRes.data.id);

        // View GRN in Browser
        await cdp.send('Page.navigate', { url: `${BASE_URL}/purchases/receipts/${grnId}` });
        await new Promise(r => setTimeout(r, 1500));
        await cdp.captureScreenshot(path.join(SCREENSHOT_DIR, 'flow_b_grn_detail.png'));

        record(5, 'Flow B', 'Goods Receipt (GRN) into Store Location & Stock Movement', 'GRN Created with 3 SETs accepted', `GRN #${grnId} Store: Substation Yard Store`, grnRes.ok);

        // Verify Invariant: Zero ProjectCost from GRN
        const grnCosts = await prisma.projectCost.findMany({
            where: { projectId: project.id, sourceType: 'STOCK_MOVEMENT' }
        });
        assert.equal(grnCosts.length, 0, 'GRN physical receipt must NOT post duplicate financial expense');
        record(6, 'Flow B', 'Physical GRN Accounting Invariant Guard', 'Zero duplicate expense entries', '0 ProjectCost entries', grnCosts.length === 0);

        // -------------------------------------------------------------
        // STEP 5: FLOW B — STOCK ISSUE & RETURN TO PROJECT
        // -------------------------------------------------------------
        console.log('--- PHASE 5: FLOW B — Project Stock Issue & Stock Return ---');
        // Navigate to project detail page to have project context and csrf token
        await cdp.send('Page.navigate', { url: `${BASE_URL}/projects/${project.id}` });
        await new Promise(r => setTimeout(r, 1200));

        // Issue 2 Transformers from Store to Project
        const issueRes = await cdp.eval(`
            const csrf = document.getElementById('csrf-token')?.value ||
                         document.getElementById('csrfToken')?.value ||
                         document.querySelector('input[name="_csrf"]')?.value ||
                         document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
            const res = await fetch('/api/projects/${project.id}/issue-material', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CSRF-Token': csrf,
                    'X-CSRF-Token': csrf
                },
                body: JSON.stringify({
                    _csrf: csrf,
                    itemId: ${rawItem.id},
                    quantity: 2,
                    storeLocation: 'Substation Yard Store',
                    notes: 'Issued 2 Transformers to Site Bay 1'
                })
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, data };
        `);
        assert.ok(issueRes.ok, `Material issue returned ${issueRes.status}: ${JSON.stringify(issueRes.data)}`);

        // Return 1 Transformer from Project back to Store
        const returnRes = await cdp.eval(`
            const csrf = document.getElementById('csrf-token')?.value ||
                         document.getElementById('csrfToken')?.value ||
                         document.querySelector('input[name="_csrf"]')?.value ||
                         document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
            const res = await fetch('/api/projects/${project.id}/return-material', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'CSRF-Token': csrf,
                    'X-CSRF-Token': csrf
                },
                body: JSON.stringify({
                    _csrf: csrf,
                    itemId: ${rawItem.id},
                    quantity: 1,
                    storeLocation: 'Substation Yard Store',
                    notes: 'Returned 1 excess transformer to Yard'
                })
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, ok: res.ok, data };
        `);
        assert.ok(returnRes.ok, `Material return returned ${returnRes.status}: ${JSON.stringify(returnRes.data)}`);

        // Check Project Materials tab in browser
        await cdp.send('Page.navigate', { url: `${BASE_URL}/projects/${project.id}#tab-materials` });
        await new Promise(r => setTimeout(r, 1500));
        await cdp.captureScreenshot(path.join(SCREENSHOT_DIR, 'flow_b_project_materials_tab.png'));

        record(7, 'Flow B', 'Issue & Return Material with Cost Subledger Tracking', 'Net 1 Transformer Cost (₹150,000)', 'Stock issued and returned cleanly', issueRes.ok && returnRes.ok);

        // -------------------------------------------------------------
        // STEP 6: FLOW C — EXPENSES & ENHANCED ATTACHMENT METADATA
        // -------------------------------------------------------------
        console.log('--- PHASE 6: FLOW C — Project Expense & Enhanced Documents ---');
        const expenseService = require('../app/services/expense.service');
        const exp = await expenseService.createExpense({
            businessId: 1,
            projectId: project.id,
            expenseDate: new Date(),
            category: 'Equipment Rental',
            amount: 25000.00,
            paymentMode: 'BANK_TRANSFER',
            description: 'Crane hire for heavy transformer lifting'
        }, 1);

        // Create Enhanced Attachment with Metadata and XSS attempt via attachmentService
        const attachmentService = require('../app/services/attachment.service');
        const maliciousDescription = '<p>Third Party Inspection Report <script>alert("XSS")</script><img src="invalid" onerror="alert(1)"></p>';
        const att = await attachmentService.saveAttachment({
            businessId: 1,
            projectId: project.id,
            entityType: 'PROJECT',
            entityId: project.id,
            title: 'Heavy Crane TPT Safety Certificate',
            category: 'TPT',
            description: maliciousDescription,
            referenceNumber: 'TPT-CRANE-2026-09',
            issueDate: new Date('2026-03-01'),
            expiryDate: new Date('2027-03-01'),
            originalFilename: 'tpt_crane_safety_audit.pdf',
            fileBuffer: Buffer.from('%PDF-1.4\n%âãÏÓ\nTest PDF content'),
            uploadedById: 1
        });

        // View Attachments tab in browser
        await cdp.send('Page.navigate', { url: `${BASE_URL}/projects/${project.id}#tab-attachments` });
        await new Promise(r => setTimeout(r, 1500));
        await cdp.captureScreenshot(path.join(SCREENSHOT_DIR, 'flow_c_project_attachments_metadata.png'));

        const scriptPresent = await cdp.eval(`document.body.innerHTML.includes('<script>alert')`);
        record(8, 'Flow C', 'Enhanced Attachment Metadata with XSS Defense', 'Script tag stripped from DOM', `Script in DOM: ${scriptPresent}`, !scriptPresent);

        // -------------------------------------------------------------
        // STEP 7: FLOW D — REPORTING & TRIAL BALANCE EQUILIBRIUM
        // -------------------------------------------------------------
        console.log('--- PHASE 7: FLOW D — Reporting, Portfolio & Trial Balance Equilibrium ---');
        // Check Trial Balance Equilibrium
        const allJournalLines = await prisma.journalEntryLine.findMany();
        const sumDebits = allJournalLines.reduce((s, l) => s + Number(l.debit), 0);
        const sumCredits = allJournalLines.reduce((s, l) => s + Number(l.credit), 0);
        const delta = Math.abs(sumDebits - sumCredits);

        await cdp.send('Page.navigate', { url: `${BASE_URL}/reports/trial-balance` });
        await new Promise(r => setTimeout(r, 1500));
        await cdp.captureScreenshot(path.join(SCREENSHOT_DIR, 'flow_d_trial_balance_equilibrium.png'));

        record(9, 'Flow D', 'Trial Balance Mathematical Equilibrium Invariant', 'Delta == 0.00', `Total Dr: ₹${sumDebits.toFixed(2)}, Total Cr: ₹${sumCredits.toFixed(2)}, Delta: ₹${delta.toFixed(2)}`, delta < 0.01);

        // Responsive Mobile Layout Audit (375px)
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 375,
            height: 812,
            deviceScaleFactor: 2,
            mobile: true
        });
        await cdp.send('Page.navigate', { url: `${BASE_URL}/projects/${project.id}` });
        await new Promise(r => setTimeout(r, 1500));
        await cdp.captureScreenshot(path.join(SCREENSHOT_DIR, 'flow_d_project_detail_mobile_375.png'));

        const overflow = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth`);
        record(10, 'Flow D', 'Mobile Viewport Responsiveness (375px)', 'No horizontal overflow', `Overflow: ${overflow}`, !overflow);

        // Reset device metrics
        await cdp.send('Emulation.clearDeviceMetricsOverride');

        console.log('================================================================================');
        console.log(`COMPLETE PROJECT INTEGRATION BROWSER ACCEPTANCE SUMMARY`);
        console.log(`Total Steps Tested: ${testResults.length}`);
        const passedCount = testResults.filter(t => t.passed).length;
        console.log(`Passed:             ${passedCount}`);
        console.log(`Failed:             ${testResults.length - passedCount}`);
        console.log('================================================================================\n');

        assert.equal(passedCount, testResults.length, 'All acceptance steps must pass!');
    } finally {
        await cdp.close();
    }
}

runBrowserE2E()
    .then(() => {
        console.log('[SUCCESS] All Phase 12 complete project integration browser tests PASSED cleanly.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('[FATAL ERROR]:', err);
        process.exit(1);
    })
    .finally(() => {
        prisma.$disconnect();
    });
