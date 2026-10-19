'use strict';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const supplierService = require('../app/services/supplier.service');
const purchaseOrderService = require('../app/services/purchaseOrder.service');
const supplierBillService = require('../app/services/supplierBill.service');
const expenseService = require('../app/services/expense.service');
const otherIncomeService = require('../app/services/otherIncome.service');
const financialYearService = require('../app/services/financialYear.service');
const coaService = require('../app/services/chartOfAccounts.service');

describe('Phase 4: Purchases, Supplier Bills, Expenses & Financial Reporting Tests', () => {
    let server = null;
    let baseUrl = null;
    let authCookie = null;
    let csrfToken = null;
    let testUser = null;
    let supplier = null;
    let openFY = null;
    let closedFY = null;

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
        // Ensure system accounts
        await coaService.ensureSystemAccounts();

        // Ensure test user
        testUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        assert.ok(testUser, 'Admin user must exist');

        // Setup financial years
        openFY = await financialYearService.ensureFinancialYear(new Date());

        // Create a closed FY in the past for testing closed-period invariant
        const pastDate = new Date('2021-05-15');
        closedFY = await financialYearService.ensureFinancialYear(pastDate);
        if (closedFY.status !== 'CLOSED') {
            closedFY = await prisma.financialYear.update({
                where: { id: closedFY.id },
                data: { status: 'CLOSED', closedAt: new Date() }
            });
        }

        // Start HTTP test server
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Login as admin
        const getLoginRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getLoginRes);
        const loginCsrf = extractCsrfToken(await getLoginRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': initialCookie || ''
            },
            body: new URLSearchParams({
                email: testUser.email,
                password: process.env.SEED_ADMIN_PASSWORD || 'test-secret-2026',
                _csrf: loginCsrf || ''
            }),
            redirect: 'manual'
        });

        authCookie = extractCookie(loginRes) || initialCookie;
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


    describe('1. Supplier Master Management', () => {
        it('1.1 creates a supplier with valid GSTIN and details', async () => {
            const timestamp = Date.now();
            supplier = await supplierService.createSupplier({
                name: `Test Acme Vendor ${timestamp}`,
                email: `vendor_${timestamp}@example.com`,
                phone: '+91 98765 43210',
                gstin: '27AABCT3518Q1ZV',
                stateCode: '27',
                address: 'Plot 42, MIDC Industrial Area, Pune'
            }, testUser.id);

            assert.ok(supplier.id > 0);
            assert.equal(supplier.stateCode, '27');
            assert.equal(supplier.active, true);
        });

        it('1.2 rejects invalid GSTIN format', async () => {
            await assert.rejects(
                () => supplierService.createSupplier({
                    name: 'Invalid GSTIN Supplier',
                    gstin: 'INVALID_GSTIN_123'
                }, testUser.id),
                { name: 'ValidationError' }
            );
        });

        it('1.3 rejects blank supplier name', async () => {
            await assert.rejects(
                () => supplierService.createSupplier({ name: '   ' }, testUser.id),
                { name: 'ValidationError' }
            );
        });
    });

    describe('2. Purchase Order Workflow & Invariants', () => {
        let createdPo = null;

        it('2.1 creates a purchase order with items and sequential PO number', async () => {
            createdPo = await purchaseOrderService.createPurchaseOrder({
                supplierId: supplier.id,
                orderDate: new Date(),
                termsAndConditions: 'Standard 30-day payment terms upon delivery.',
                remarks: 'Urgent procurement',
                items: [
                    { name: 'Raw Material Grade A', quantity: 10, rate: 150.00, unit: 'KG' },
                    { name: 'Precision Machine Bearings', quantity: 4, rate: 325.50, unit: 'PCS' }
                ]
            }, testUser.id);

            assert.ok(createdPo.id > 0);
            assert.ok(createdPo.orderNumber.startsWith('PO/') || createdPo.orderNumber.startsWith('PO-'));
            assert.equal(createdPo.supplierName, supplier.name);
            assert.equal(createdPo.status, 'ACTIVE');
            assert.equal(createdPo.items.length, 2);
        });

        it('2.2 CRITICAL INVARIANT: Purchase Order creation strictly does NOT affect accounting ledger', async () => {
            // Check that no journal entries were created with sourceType 'PURCHASE_ORDER' or for this PO
            const journal = await prisma.journalEntry.findFirst({
                where: {
                    OR: [
                        { sourceType: 'PURCHASE_ORDER' },
                        { idempotencyKey: `PO:${createdPo.id}` }
                    ]
                }
            });
            assert.equal(journal, null, 'Purchase orders must NOT post journal entries or create expenses/liabilities!');
        });

        it('2.3 allows voiding an active purchase order', async () => {
            const voided = await purchaseOrderService.voidPurchaseOrder(
                createdPo.id,
                testUser.id,
                'Supplier out of stock',
                createdPo.businessId
            );
            assert.equal(voided.status, 'VOID');
            assert.ok(voided.remarks.includes('Supplier out of stock'));
        });

        it('2.4 rejects modifying a VOID purchase order', async () => {
            await assert.rejects(
                () => purchaseOrderService.updatePurchaseOrder(createdPo.id, { remarks: 'New remarks' }, testUser.id),
                { name: 'ValidationError' }
            );
        });
    });

    describe('3. Supplier Bills & Double-Entry Accounting Ledger', () => {
        let billNumber = null;
        let createdBill = null;

        it('3.1 creates a supplier bill with GST and posts balanced journal entry', async () => {
            billNumber = `BILL-${Date.now()}`;
            createdBill = await supplierBillService.createSupplierBill({
                billNumber,
                supplierId: supplier.id,
                billDate: new Date(),
                gstRate: 18,
                items: [
                    { name: 'Server Hardware Component', quantity: 2, rate: 500.00 }, // subtotal 1000
                    { name: 'Installation & Cabling', quantity: 1, rate: 200.00 }      // subtotal 200
                ]
            }, testUser.id);

            // Subtotal = 1200. GST @ 18% = 216. Grand Total = 1416.
            assert.ok(createdBill.id > 0);
            assert.equal(parseFloat(createdBill.totalAmount), 1416.00);

            // Verify Double-Entry Journal Entry
            const journal = await prisma.journalEntry.findUnique({
                where: { idempotencyKey: `SUPPLIER_BILL:${createdBill.id}` },
                include: { lines: { include: { account: true } } }
            });

            assert.ok(journal, 'Journal entry must be posted for Supplier Bill');
            assert.equal(journal.status, 'POSTED');

            // Check exact double-entry balance: SUM(Dr) === SUM(Cr)
            let totalDebit = 0;
            let totalCredit = 0;
            for (const line of journal.lines) {
                totalDebit += parseFloat(line.debit);
                totalCredit += parseFloat(line.credit);
            }

            assert.equal(totalDebit.toFixed(2), '1416.00');
            assert.equal(totalCredit.toFixed(2), '1416.00');
            assert.equal(totalDebit.toFixed(2), totalCredit.toFixed(2), 'Debits must equal Credits down to the cent');

            // Verify account breakdown
            const apLine = journal.lines.find(l => l.account.systemAccountKey === 'ACCOUNTS_PAYABLE');
            assert.ok(apLine, 'Accounts Payable line must exist');
            assert.equal(parseFloat(apLine.credit), 1416.00);

            const cogsLine = journal.lines.find(l => l.account.systemAccountKey === 'COGS');
            assert.ok(cogsLine, 'COGS/Expense line must exist');
            assert.equal(parseFloat(cogsLine.debit), 1200.00);
        });

        it('3.2 prevents duplicate supplier bill numbers', async () => {
            await assert.rejects(
                () => supplierBillService.createSupplierBill({
                    billNumber,
                    supplierId: supplier.id,
                    billDate: new Date(),
                    items: [{ name: 'Test', quantity: 1, rate: 100 }]
                }, testUser.id),
                { name: 'ConflictError' }
            );
        });

        it('3.3 enforces closed financial year period locking', async () => {
            await assert.rejects(
                () => supplierBillService.createSupplierBill({
                    billNumber: `BILL-CLOSED-${Date.now()}`,
                    supplierId: supplier.id,
                    billDate: new Date('2021-05-15'), // in closed FY
                    items: [{ name: 'Historical Item', quantity: 1, rate: 500 }]
                }, testUser.id),
                /closed Financial Year/
            );
        });

        it('3.4 voiding a supplier bill reverses its accounting ledger entry', async () => {
            const voided = await supplierBillService.voidSupplierBill(createdBill.id, testUser.id, 'Bill issued in error');
            assert.equal(voided.status, 'VOID');

            const originalJournal = await prisma.journalEntry.findUnique({
                where: { idempotencyKey: `SUPPLIER_BILL:${createdBill.id}` }
            });

            assert.equal(originalJournal.status, 'REVERSED', 'Original journal must be flagged reversed');
            assert.ok(originalJournal.reversedEntryId, 'Reversal entry must be linked');
        });
    });

    describe('4. Operating Expenses & Ledger Integration', () => {
        it('4.1 records operating expense and posts Dr Expense / Cr Bank', async () => {
            const expense = await expenseService.createExpense({
                expenseDate: new Date(),
                category: 'Office Electricity & Power',
                amount: 345.50,
                paymentMethod: 'BANK',
                description: 'Monthly electricity bill utility payment'
            }, testUser.id);

            assert.ok(expense.id > 0);
            assert.equal(parseFloat(expense.amount), 345.50);

            // Verify journal entry
            const journal = await prisma.journalEntry.findUnique({
                where: { idempotencyKey: `EXPENSE:${expense.id}` },
                include: { lines: true }
            });

            assert.ok(journal, 'Journal must be posted for expense');
            let sumDr = 0;
            let sumCr = 0;
            journal.lines.forEach(l => {
                sumDr += parseFloat(l.debit);
                sumCr += parseFloat(l.credit);
            });
            assert.equal(sumDr.toFixed(2), '345.50');
            assert.equal(sumCr.toFixed(2), '345.50');
        });

        it('4.2 rejects negative or zero expense amount', async () => {
            await assert.rejects(
                () => expenseService.createExpense({
                    amount: -50,
                    description: 'Invalid'
                }, testUser.id),
                { name: 'ValidationError' }
            );
        });
    });

    describe('5. Other Income & Ledger Integration', () => {
        it('5.1 records other income and posts Dr Bank / Cr Income', async () => {
            const income = await otherIncomeService.createOtherIncome({
                incomeDate: new Date(),
                source: 'Bank Savings Interest',
                amount: 182.25,
                receiptMethod: 'BANK',
                description: 'Q3 interest credit from operational bank account'
            }, testUser.id);

            assert.ok(income.id > 0);
            assert.equal(parseFloat(income.amount), 182.25);

            // Verify journal entry
            const journal = await prisma.journalEntry.findUnique({
                where: { idempotencyKey: `OTHER_INCOME:${income.id}` },
                include: { lines: true }
            });

            assert.ok(journal, 'Journal must be posted for other income');
            let sumDr = 0;
            let sumCr = 0;
            journal.lines.forEach(l => {
                sumDr += parseFloat(l.debit);
                sumCr += parseFloat(l.credit);
            });
            assert.equal(sumDr.toFixed(2), '182.25');
            assert.equal(sumCr.toFixed(2), '182.25');
        });
    });

    describe('6. Web UI Routes & End-to-End Delivery', () => {
        it('6.1 GET /purchases/orders renders 200 OK', async () => {
            const res = await fetch(`${baseUrl}/purchases/orders`, {
                headers: { 'Cookie': authCookie || '' }
            });
            assert.equal(res.status, 200);
            const text = await res.text();
            assert.ok(text.includes('Purchase Orders'));
        });

        it('6.2 GET /purchases/orders/new renders 200 OK', async () => {
            const res = await fetch(`${baseUrl}/purchases/orders/new`, {
                headers: { 'Cookie': authCookie || '' }
            });
            assert.equal(res.status, 200);
            const text = await res.text();
            assert.ok(text.includes('New Purchase Order'));
        });

        it('6.3 GET /purchases/bills renders 200 OK', async () => {
            const res = await fetch(`${baseUrl}/purchases/bills`, {
                headers: { 'Cookie': authCookie || '' }
            });
            assert.equal(res.status, 200);
            const text = await res.text();
            assert.ok(text.includes('Supplier Bills'));
        });

        it('6.4 GET /financials/expenses renders 200 OK', async () => {
            const res = await fetch(`${baseUrl}/financials/expenses`, {
                headers: { 'Cookie': authCookie || '' }
            });
            assert.equal(res.status, 200);
            const text = await res.text();
            assert.ok(text.includes('Operating Expenses'));
        });

        it('6.5 GET /financials/other-income renders 200 OK', async () => {
            const res = await fetch(`${baseUrl}/financials/other-income`, {
                headers: { 'Cookie': authCookie || '' }
            });
            assert.equal(res.status, 200);
            const text = await res.text();
            assert.ok(text.includes('Other Income'));
        });
    });
});
