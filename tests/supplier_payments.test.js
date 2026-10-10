'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const supplierService = require('../app/services/supplier.service');
const supplierBillService = require('../app/services/supplierBill.service');
const supplierPaymentService = require('../app/services/supplierPayment.service');
const { ensureFinancialYear } = require('../app/services/financialYear.service');
const { ensureSystemAccounts } = require('../app/services/chartOfAccounts.service');

test('Supplier Payments & Allocations Integration Test Suite', async (t) => {
    let testUser;
    let testSupplier;
    let testBill;

    await t.test('Setup test dependencies (User, Accounts, Supplier, Bill)', async () => {
        // Ensure test user
        testUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testUser) {
            testUser = await prisma.user.create({
                data: {
                    email: `spay_admin_${Date.now()}@example.com`,
                    name: 'Supplier Payment Test Admin',
                    passwordHash: 'dummyhash',
                    role: 'ADMIN'
                }
            });
        }

        // Ensure system accounts & financial year
        await ensureSystemAccounts(testUser.id);
        const fy = await ensureFinancialYear(new Date());
        assert.ok(fy && fy.id, 'Financial year ensured');

        // Create test supplier
        testSupplier = await supplierService.createSupplier({
            name: `Test Supplier For Payments ${Date.now()}`,
            email: `spay_supp_${Date.now()}@example.com`,
            stateCode: '27'
        }, testUser.id);
        assert.ok(testSupplier.id);

        // Create test supplier bill for 1000 + tax
        testBill = await supplierBillService.createSupplierBill({
            billNumber: `BILL-SPAY-${Date.now()}`,
            supplierId: testSupplier.id,
            billDate: new Date(),
            items: [
                { name: 'Hardware Components', quantity: 10, rate: 100 }
            ]
        }, testUser.id);
        assert.equal(Number(testBill.totalAmount), 1000);
    });

    await t.test('Cannot record payment with invalid amount or unsupported method', async () => {
        await assert.rejects(
            supplierPaymentService.recordSupplierPayment({
                supplierId: testSupplier.id,
                amount: 0,
                method: 'BANK_TRANSFER'
            }, testUser.id),
            /greater than 0/
        );

        await assert.rejects(
            supplierPaymentService.recordSupplierPayment({
                supplierId: testSupplier.id,
                amount: 500,
                method: 'BITCOIN'
            }, testUser.id),
            /Unsupported payment method/
        );
    });

    await t.test('Cannot over-allocate payment against supplier bill', async () => {
        await assert.rejects(
            supplierPaymentService.recordSupplierPayment({
                supplierId: testSupplier.id,
                supplierBillId: testBill.id,
                amount: 1500, // bill total is 1000
                method: 'BANK_TRANSFER'
            }, testUser.id),
            /exceeds supplier bill outstanding balance/
        );
    });

    await t.test('Record valid partial payment against bill and verify double-entry journal', async () => {
        const payment = await supplierPaymentService.recordSupplierPayment({
            supplierId: testSupplier.id,
            supplierBillId: testBill.id,
            amount: 600,
            method: 'BANK_TRANSFER',
            reference: 'NEFT-123456',
            notes: 'Partial payment for bill'
        }, testUser.id);

        assert.ok(payment.id);
        assert.equal(Number(payment.amount), 600);
        assert.equal(payment.status, 'POSTED');

        // Verify Journal Entry posted
        const journal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_PAYMENT:${payment.id}` },
            include: { lines: { include: { account: true } } }
        });

        assert.ok(journal, 'Journal entry must exist for supplier payment');
        assert.equal(journal.lines.length, 2);

        // Verify balanced debits and credits
        const totalDebit = journal.lines.reduce((s, l) => s + Number(l.debit), 0);
        const totalCredit = journal.lines.reduce((s, l) => s + Number(l.credit), 0);
        assert.equal(totalDebit, 600);
        assert.equal(totalCredit, 600);

        // Debit should be Accounts Payable (2121), Credit should be Bank Account (1112)
        const debitLine = journal.lines.find(l => Number(l.debit) > 0);
        const creditLine = journal.lines.find(l => Number(l.credit) > 0);
        assert.equal(debitLine.account.systemAccountKey, 'ACCOUNTS_PAYABLE');
        assert.equal(creditLine.account.systemAccountKey, 'BANK_ACCOUNT');
    });

    await t.test('Prevent subsequent payment exceeding remaining outstanding balance', async () => {
        // Bill was 1000, 600 paid, remaining 400
        await assert.rejects(
            supplierPaymentService.recordSupplierPayment({
                supplierId: testSupplier.id,
                supplierBillId: testBill.id,
                amount: 450,
                method: 'CASH'
            }, testUser.id),
            /exceeds supplier bill outstanding balance/
        );

        // Exactly 400 must succeed (paid with CASH -> Cr CASH_ON_HAND)
        const payment2 = await supplierPaymentService.recordSupplierPayment({
            supplierId: testSupplier.id,
            supplierBillId: testBill.id,
            amount: 400,
            method: 'CASH',
            reference: 'CASH-RCPT-1'
        }, testUser.id);

        assert.equal(Number(payment2.amount), 400);

        const journal2 = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_PAYMENT:${payment2.id}` },
            include: { lines: { include: { account: true } } }
        });
        assert.ok(journal2);
        const creditLine = journal2.lines.find(l => Number(l.credit) > 0);
        assert.equal(creditLine.account.systemAccountKey, 'CASH_ON_HAND');
    });

    await t.test('Voiding supplier payment reverses the accounting journal', async () => {
        const payment = await supplierPaymentService.recordSupplierPayment({
            supplierId: testSupplier.id,
            amount: 250,
            method: 'BANK_TRANSFER'
        }, testUser.id);

        const voided = await supplierPaymentService.voidSupplierPayment(payment.id, testUser.id, 'Test reversal');
        assert.equal(voided.status, 'VOID');

        // Original journal entry must be marked REVERSED
        const origJournal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_PAYMENT:${payment.id}` }
        });
        assert.equal(origJournal.status, 'REVERSED');
    });

    await prisma.$disconnect();
});
