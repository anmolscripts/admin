'use strict';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const coaService = require('../app/services/chartOfAccounts.service');
const journalService = require('../app/services/journal.service');
const invoiceService = require('../app/services/invoice.service');
const paymentService = require('../app/services/payment.service');
const postingService = require('../app/services/accounting/posting.service');
const { ensureFinancialYear, createFinancialYear } = require('../app/services/financialYear.service');

describe('Milestone 5: Payment Accounting Posting & Double-Entry Integration', () => {
    let testAdmin = null;
    let testClient = null;
    let testFy = null;

    before(async () => {
        testAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testAdmin) {
            testAdmin = await prisma.user.findFirst();
        }

        testClient = await prisma.client.create({
            data: {
                name: `Payment Test Client ${Date.now()}`,
                email: `payment_${Date.now()}@client.example.com`,
                phone: '9876543210',
                gstin: '27AABCU9603R1ZM',
                stateCode: '27',
                active: true,
                createdById: testAdmin ? testAdmin.id : null
            }
        });

        testFy = await ensureFinancialYear(new Date('2026-05-15'));
        await coaService.ensureSystemAccounts(testAdmin ? testAdmin.id : null);
    });

    after(async () => {
        await prisma.$disconnect();
    });

    describe('1. Double-Entry Posting Fundamentals (Valid Payment, Accounts, Subledger)', () => {
        let invoice = null;
        let paymentRecord = null;
        let journal = null;

        before(async () => {
            // Create and post an invoice
            invoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                clientGSTIN: testClient.gstin,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-05-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Consulting Services', quantity: 1, rate: 10000, unit: 'HRS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            await postingService.postInvoice(invoice.id, { userId: testAdmin ? testAdmin.id : null });
        });

        it('1.1 should record a valid payment against invoice and atomically post balanced journal', async () => {
            const payRes = await paymentService.recordPayment(invoice.id, {
                amount: 6000,
                paymentDate: '2026-05-12',
                method: 'BANK_TRANSFER',
                reference: 'UTR9988776655',
                notes: 'Part payment via NEFT'
            }, testAdmin ? testAdmin.id : 1);

            assert.ok(payRes);
            assert.ok(payRes.payment);
            assert.equal(payRes.payment.amount, 6000);
            assert.equal(payRes.payment.status, 'POSTED');
            assert.ok(payRes.journal);

            paymentRecord = payRes.payment;
            journal = payRes.journal;
        });

        it('1.2 should verify Debit uses the correct Bank account', async () => {
            const bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');
            const debitLine = journal.lines.find(l => postingService.toCents(l.debit) > 0n);

            assert.ok(debitLine);
            assert.equal(debitLine.accountId, bankAccount.id);
            assert.equal(Number(debitLine.debit), 6000.00);
            assert.equal(Number(debitLine.credit), 0.00);
        });

        it('1.3 should verify Credit uses Accounts Receivable', async () => {
            const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');
            const creditLine = journal.lines.find(l => postingService.toCents(l.credit) > 0n);

            assert.ok(creditLine);
            assert.equal(creditLine.accountId, arAccount.id);
            assert.equal(Number(creditLine.credit), 6000.00);
            assert.equal(Number(creditLine.debit), 0.00);
        });

        it('1.4 should verify Accounts Receivable line attaches correct customer/client subledger', async () => {
            const creditLine = journal.lines.find(l => postingService.toCents(l.credit) > 0n);
            assert.equal(creditLine.clientId, testClient.id);
        });

        it('1.5 should verify canonical source linkage and entry number', async () => {
            assert.equal(journal.sourceType, 'PAYMENT');
            assert.equal(journal.sourceId, paymentRecord.id);
            assert.equal(journal.idempotencyKey, `PAYMENT:${paymentRecord.id}`);
            assert.ok(journal.entryNumber.startsWith('JRNL/'));
        });

        it('1.6 should verify exact double-entry balance: SUM(Dr) === SUM(Cr)', async () => {
            let totalDr = 0n;
            let totalCr = 0n;
            for (const line of journal.lines) {
                totalDr += postingService.toCents(line.debit);
                totalCr += postingService.toCents(line.credit);
            }
            assert.equal(totalDr, 600000n);
            assert.equal(totalCr, 600000n);
            assert.equal(totalDr, totalCr);
        });
    });

    describe('2. Cash & Bank Account Mapping', () => {
        let invoice = null;

        before(async () => {
            invoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-06-01'),
                gstEnabled: false,
                items: [{ name: 'Hardware Parts', quantity: 5, rate: 1000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);
        });

        it('2.1 should debit CASH_ON_HAND (code 1111) when method is CASH', async () => {
            const payRes = await paymentService.recordPayment(invoice.id, {
                amount: 1000,
                paymentDate: '2026-06-02',
                method: 'CASH',
                notes: 'Cash payment counter'
            }, testAdmin ? testAdmin.id : 1);

            const cashAccount = await coaService.getSystemAccount('CASH_ON_HAND');
            const debitLine = payRes.journal.lines.find(l => postingService.toCents(l.debit) > 0n);
            assert.equal(debitLine.accountId, cashAccount.id);
            assert.equal(Number(debitLine.debit), 1000.00);
        });

        it('2.2 should debit BANK_ACCOUNT (code 1112) for UPI, CHEQUE, and CARD', async () => {
            const bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');

            for (const method of ['UPI', 'CHEQUE', 'CARD']) {
                const payRes = await paymentService.recordPayment(invoice.id, {
                    amount: 500,
                    paymentDate: '2026-06-03',
                    method,
                    reference: `REF-${method}`
                }, testAdmin ? testAdmin.id : 1);

                const debitLine = payRes.journal.lines.find(l => postingService.toCents(l.debit) > 0n);
                assert.equal(debitLine.accountId, bankAccount.id);
                assert.equal(Number(debitLine.debit), 500.00);
            }
        });

        it('2.3 should reject unsupported payment methods with ValidationError', async () => {
            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(invoice.id, {
                        amount: 500,
                        paymentDate: '2026-06-04',
                        method: 'BITCOIN'
                    }, testAdmin ? testAdmin.id : 1);
                },
                /Unsupported payment method/
            );
        });
    });

    describe('3. Financial Year and Boundary Rules', () => {
        let marchInvoice = null;
        let aprilInvoice = null;

        before(async () => {
            marchInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-03-31'),
                gstEnabled: false,
                items: [{ name: 'Year-End Item', quantity: 1, rate: 2000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            aprilInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-04-01'),
                gstEnabled: false,
                items: [{ name: 'New-Year Item', quantity: 1, rate: 2000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);
        });

        it('3.1 should map payment on 31 March 2026 to FY 2025-26', async () => {
            const payRes = await paymentService.recordPayment(marchInvoice.id, {
                amount: 1000,
                paymentDate: '2026-03-31',
                method: 'BANK_TRANSFER'
            }, testAdmin ? testAdmin.id : 1);

            const fy2025_26 = await ensureFinancialYear(new Date('2026-03-31'));
            assert.equal(payRes.payment.financialYearId, fy2025_26.id);
            assert.equal(payRes.journal.financialYearId, fy2025_26.id);
            assert.ok(payRes.journal.entryNumber.startsWith('JRNL/2026/03/'));
        });

        it('3.2 should map payment on 1 April 2026 to FY 2026-27', async () => {
            const payRes = await paymentService.recordPayment(aprilInvoice.id, {
                amount: 1000,
                paymentDate: '2026-04-01',
                method: 'BANK_TRANSFER'
            }, testAdmin ? testAdmin.id : 1);

            const fy2026_27 = await ensureFinancialYear(new Date('2026-04-01'));
            assert.equal(payRes.payment.financialYearId, fy2026_27.id);
            assert.equal(payRes.journal.financialYearId, fy2026_27.id);
            assert.ok(payRes.journal.entryNumber.startsWith('JRNL/2026/04/'));
        });

        it('3.3 should reject posting when payment date is in a CLOSED Financial Year', async () => {
            const closedFy = await ensureFinancialYear(new Date('2022-10-15'));
            await prisma.financialYear.update({
                where: { id: closedFy.id },
                data: { status: 'CLOSED' }
            });

            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(aprilInvoice.id, {
                        amount: 500,
                        paymentDate: '2022-10-15',
                        method: 'BANK_TRANSFER'
                    }, testAdmin ? testAdmin.id : 1);
                },
                /CLOSED Financial Year/
            );
        });
    });

    describe('4. Invoice Allocations, Outstanding Balances & Overpayment Prevention', () => {
        let testInv = null;

        before(async () => {
            testInv = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-07-01'),
                gstEnabled: false,
                items: [{ name: 'Project Milestone A', quantity: 1, rate: 5000, unit: 'NOS' }]
            }, testAdmin ? testAdmin.id : 1);
        });

        it('4.1 should support partial payment and reduce outstanding balance correctly', async () => {
            const payRes1 = await paymentService.recordPayment(testInv.id, {
                amount: 2000,
                paymentDate: '2026-07-02',
                method: 'BANK_TRANSFER'
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(payRes1.invoice.paidAmount, 2000);
            assert.equal(payRes1.invoice.outstandingAmount, 3000);
        });

        it('4.2 should support settling remaining balance exactly to zero outstanding', async () => {
            const payRes2 = await paymentService.recordPayment(testInv.id, {
                amount: 3000,
                paymentDate: '2026-07-03',
                method: 'BANK_TRANSFER'
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(payRes2.invoice.paidAmount, 5000);
            assert.equal(payRes2.invoice.outstandingAmount, 0);
        });

        it('4.3 should reject payment that exceeds outstanding balance (overpayment protection)', async () => {
            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(testInv.id, {
                        amount: 100,
                        paymentDate: '2026-07-04',
                        method: 'BANK_TRANSFER'
                    }, testAdmin ? testAdmin.id : 1);
                },
                /exceeds the invoice outstanding balance/
            );
        });
    });

    describe('5. Invalid Invoice Lifecycle Rejection', () => {
        it('5.1 should reject payment on a quotation', async () => {
            const quote = await invoiceService.createQuotation({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-07-10'),
                gstEnabled: false,
                items: [{ name: 'Estimate', quantity: 1, rate: 3000, unit: 'NOS' }]
            }, testAdmin ? testAdmin.id : 1);

            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(quote.id, {
                        amount: 1000,
                        paymentDate: '2026-07-11',
                        method: 'BANK_TRANSFER'
                    }, testAdmin ? testAdmin.id : 1);
                },
                /Payments can only be recorded for invoices, not quotations/
            );
        });

        it('5.2 should reject payment on a VOID invoice', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-07-10'),
                gstEnabled: false,
                items: [{ name: 'To Void', quantity: 1, rate: 3000, unit: 'NOS' }]
            }, testAdmin ? testAdmin.id : 1);

            await invoiceService.updateInvoiceStatus(inv.id, 'VOID', testAdmin ? testAdmin.id : 1);

            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(inv.id, {
                        amount: 1000,
                        paymentDate: '2026-07-11',
                        method: 'BANK_TRANSFER'
                    }, testAdmin ? testAdmin.id : 1);
                },
                /Cannot record payment for a VOID invoice/
            );
        });

        it('5.3 should reject payment on a DELETED invoice', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-07-10'),
                gstEnabled: false,
                items: [{ name: 'To Delete', quantity: 1, rate: 3000, unit: 'NOS' }]
            }, testAdmin ? testAdmin.id : 1);

            await invoiceService.softDeleteDocument(inv.id, 'Testing deletion', testAdmin ? testAdmin.id : 1);

            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(inv.id, {
                        amount: 1000,
                        paymentDate: '2026-07-11',
                        method: 'BANK_TRANSFER'
                    }, testAdmin ? testAdmin.id : 1);
                },
                /Cannot record payment for a DELETED invoice/
            );
        });
    });

    describe('6. Idempotency & Concurrency Safety', () => {
        let inv = null;
        let payment = null;

        before(async () => {
            inv = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-08-01'),
                gstEnabled: false,
                items: [{ name: 'Idempotency Test Item', quantity: 1, rate: 10000, unit: 'NOS' }]
            }, testAdmin ? testAdmin.id : 1);

            const res = await paymentService.recordPayment(inv.id, {
                amount: 4000,
                paymentDate: '2026-08-02',
                method: 'BANK_TRANSFER'
            }, testAdmin ? testAdmin.id : 1);
            payment = res.payment;
        });

        it('6.1 repeated posting produces exactly one journal with alreadyPosted flag', async () => {
            const countBefore = await prisma.journalEntry.count({
                where: { idempotencyKey: `PAYMENT:${payment.id}` }
            });
            assert.equal(countBefore, 1);

            // Re-post explicitly
            const repostRes = await postingService.postPayment(payment.id, {
                userId: testAdmin ? testAdmin.id : null
            });

            assert.equal(repostRes.success, true);
            assert.equal(repostRes.alreadyPosted, true);
            assert.ok(repostRes.journal);

            const countAfter = await prisma.journalEntry.count({
                where: { idempotencyKey: `PAYMENT:${payment.id}` }
            });
            assert.equal(countAfter, 1);
        });

        it('6.2 concurrent duplicate posting calls resolve to exactly one journal', async () => {
            const results = await Promise.all([
                postingService.postPayment(payment.id, { userId: testAdmin ? testAdmin.id : null }),
                postingService.postPayment(payment.id, { userId: testAdmin ? testAdmin.id : null }),
                postingService.postPayment(payment.id, { userId: testAdmin ? testAdmin.id : null })
            ]);

            assert.equal(results.length, 3);
            const journalIds = new Set(results.map(r => r.journal.id));
            assert.equal(journalIds.size, 1);
        });
    });

    describe('7. Payment Correction, Voiding & Ledger Reversal Lifecycle', () => {
        let inv = null;
        let payment = null;
        let originalJournal = null;

        before(async () => {
            inv = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-08-10'),
                gstEnabled: false,
                items: [{ name: 'Reversal Item', quantity: 1, rate: 8000, unit: 'NOS' }]
            }, testAdmin ? testAdmin.id : 1);

            const res = await paymentService.recordPayment(inv.id, {
                amount: 3500,
                paymentDate: '2026-08-11',
                method: 'BANK_TRANSFER',
                notes: 'Payment to be voided later'
            }, testAdmin ? testAdmin.id : 1);
            payment = res.payment;
            originalJournal = res.journal;
        });

        it('7.1 voiding a payment marks status VOID and restores invoice outstanding balance', async () => {
            const voidRes = await paymentService.voidPayment(payment.id, testAdmin ? testAdmin.id : 1, 'Erroneous amount deposited');

            assert.equal(voidRes.payment.status, 'VOID');
            assert.equal(voidRes.invoice.paidAmount, 0);
            assert.equal(voidRes.invoice.outstandingAmount, 8000);
            assert.ok(voidRes.reversalJournal);
        });

        it('7.2 voiding creates an offsetting reversal journal and marks original as REVERSED', async () => {
            const updatedOriginal = await journalService.getJournalEntryById(originalJournal.id);
            assert.equal(updatedOriginal.status, 'REVERSED');
            assert.ok(updatedOriginal.reversedEntryId);

            const reversal = await journalService.getJournalEntryById(updatedOriginal.reversedEntryId);
            assert.ok(reversal);
            assert.equal(reversal.status, 'POSTED');

            // Swapped lines check:
            // Original: Dr Bank 3500, Cr AR 3500
            // Reversal: Dr AR 3500, Cr Bank 3500
            const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');
            const bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');

            const revDrLine = reversal.lines.find(l => postingService.toCents(l.debit) > 0n);
            const revCrLine = reversal.lines.find(l => postingService.toCents(l.credit) > 0n);

            assert.equal(revDrLine.accountId, arAccount.id);
            assert.equal(Number(revDrLine.debit), 3500.00);
            assert.equal(revDrLine.clientId, testClient.id);

            assert.equal(revCrLine.accountId, bankAccount.id);
            assert.equal(Number(revCrLine.credit), 3500.00);
        });

        it('7.3 attempting to void an already voided payment is rejected', async () => {
            await assert.rejects(
                async () => {
                    await paymentService.voidPayment(payment.id, testAdmin ? testAdmin.id : 1, 'Second void attempt');
                },
                /Payment has already been voided/
            );
        });

        it('7.4 attempting to post accounting for a VOID payment is rejected', async () => {
            await assert.rejects(
                async () => {
                    await postingService.postPayment(payment.id, { userId: testAdmin ? testAdmin.id : 1 });
                },
                /Cannot post VOID payment/
            );
        });
    });

    describe('8. Atomicity Rollback Verification', () => {
        it('8.1 failed posting rolls back entire transaction without orphan records', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                invoiceDate: new Date('2026-09-01'),
                gstEnabled: false,
                items: [{ name: 'Atomicity Item', quantity: 1, rate: 5000, unit: 'NOS' }]
            }, testAdmin ? testAdmin.id : 1);

            const initialPaymentCount = await prisma.payment.count();
            const initialJournalCount = await prisma.journalEntry.count();

            // Pass an invalid deposit account ID that will cause posting to fail
            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(inv.id, {
                        amount: 2500,
                        paymentDate: '2026-09-02',
                        method: 'BANK_TRANSFER',
                        depositAccountId: 9999999 // non-existent account
                    }, testAdmin ? testAdmin.id : 1);
                },
                /Deposit account with ID 9999999 not found/
            );

            // Assert nothing was committed
            const finalPaymentCount = await prisma.payment.count();
            const finalJournalCount = await prisma.journalEntry.count();
            assert.equal(finalPaymentCount, initialPaymentCount);
            assert.equal(finalJournalCount, initialJournalCount);

            const reloadedInv = await invoiceService.getInvoiceById(inv.id);
            assert.equal(Number(reloadedInv.paidAmount), 0);
            assert.equal(Number(reloadedInv.outstandingAmount), 5000);
        });
    });

    describe('9. Financial Reconciliation Example (Section 12 of Specification)', () => {
        /**
         * Specification Section 12 Realistic Test Case:
         * Invoice:
         *   - Net sales: ₹10,000.00
         *   - GST: ₹1,800.00 (Intra-state: CGST ₹900, SGST ₹900)
         *   - Total: ₹11,800.00
         * Invoice journal:
         *   - Dr Customer ₹11,800.00
         *   - Cr Sales ₹10,000.00
         *   - Cr GST ₹1,800.00 (CGST ₹900, SGST ₹900)
         * Payment received:
         *   - ₹6,000.00
         * Payment journal:
         *   - Dr Bank ₹6,000.00
         *   - Cr Customer ₹6,000.00
         * Expected customer subledger:
         *   - Invoice debit: ₹11,800.00
         *   - Payment credit: ₹6,000.00
         *   - Outstanding debit balance: ₹5,800.00
         */
        it('9.1 should accurately post invoice and payment and reconcile customer subledger to ₹5,800.00', async () => {
            const reconClient = await prisma.client.create({
                data: {
                    name: `Section 12 Recon Client ${Date.now()}`,
                    email: `recon_${Date.now()}@example.com`,
                    stateCode: '27',
                    gstin: '27AABCU9603R1ZM',
                    active: true
                }
            });

            // 1. Create Invoice: Net ₹10,000, 18% GST -> Total ₹11,800
            const invoice = await invoiceService.createInvoice({
                clientName: reconClient.name,
                clientId: reconClient.id,
                clientGSTIN: reconClient.gstin,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Enterprise Accounting Software', quantity: 1, rate: 10000, unit: 'PKG' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(invoice.subtotal), 10000);
            assert.equal(Number(invoice.cgstAmount), 900);
            assert.equal(Number(invoice.sgstAmount), 900);
            assert.equal(Number(invoice.grandTotal), 11800);

            // 2. Post Invoice to General Ledger
            const invPost = await postingService.postInvoice(invoice.id, { userId: testAdmin ? testAdmin.id : 1 });
            assert.equal(invPost.success, true);

            // 3. Record Payment of ₹6,000
            const payRes = await paymentService.recordPayment(invoice.id, {
                amount: 6000,
                paymentDate: '2026-09-15',
                method: 'BANK_TRANSFER',
                reference: 'UTR-RECON-12345'
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(payRes.payment.amount, 6000);
            assert.equal(payRes.invoice.paidAmount, 6000);
            assert.equal(payRes.invoice.outstandingAmount, 5800);

            // 4. Query all journal lines for this client from the general ledger
            const clientLines = await prisma.journalEntryLine.findMany({
                where: { clientId: reconClient.id },
                include: {
                    journalEntry: true,
                    account: true
                },
                orderBy: { createdAt: 'asc' }
            });

            assert.equal(clientLines.length, 2);

            // Line 1: Invoice Debit
            const invLine = clientLines[0];
            assert.equal(invLine.journalEntry.sourceType, 'INVOICE');
            assert.equal(invLine.journalEntry.sourceId, invoice.id);
            assert.equal(invLine.account.systemAccountKey, 'ACCOUNTS_RECEIVABLE');
            assert.equal(Number(invLine.debit), 11800.00);
            assert.equal(Number(invLine.credit), 0.00);

            // Line 2: Payment Credit
            const payLine = clientLines[1];
            assert.equal(payLine.journalEntry.sourceType, 'PAYMENT');
            assert.equal(payLine.journalEntry.sourceId, payRes.payment.id);
            assert.equal(payLine.account.systemAccountKey, 'ACCOUNTS_RECEIVABLE');
            assert.equal(Number(payLine.debit), 0.00);
            assert.equal(Number(payLine.credit), 6000.00);

            // 5. Calculate customer subledger balance from database journal lines
            let totalDebits = 0n;
            let totalCredits = 0n;
            for (const line of clientLines) {
                totalDebits += postingService.toCents(line.debit);
                totalCredits += postingService.toCents(line.credit);
            }

            const netDebitBalance = totalDebits - totalCredits;
            assert.equal(totalDebits, 1180000n);
            assert.equal(totalCredits, 600000n);
            assert.equal(netDebitBalance, 580000n);
            assert.equal(postingService.fromCents(netDebitBalance), '5800.00');

            // 6. Verify operational outstanding balance matches subledger exactly
            const reloadedInvoice = await invoiceService.getInvoiceById(invoice.id);
            assert.equal(Number(reloadedInvoice.outstandingAmount), 5800);
            assert.equal(postingService.fromCents(postingService.toCents(reloadedInvoice.outstandingAmount)), '5800.00');
        });
    });

    describe('10. RBAC Route Authorisation & Journal Immutability', () => {
        const { requirePermission } = require('../app/middleware/permission.middleware');

        it('10.1 requirePermission rejects unauthenticated request with 401', async () => {
            const middleware = requirePermission('JOURNALS', 'CREATE');
            let statusCalled = null;
            let jsonCalled = null;
            const req = {
                session: null,
                originalUrl: '/api/payments/1/post',
                headers: { accept: 'application/json' }
            };
            const res = {
                locals: {},
                status: (code) => { statusCalled = code; return res; },
                json: (payload) => { jsonCalled = payload; }
            };
            await middleware(req, res, () => {});
            assert.equal(statusCalled, 401);
            assert.equal(jsonCalled.success, false);
        });

        it('10.2 requirePermission rejects user lacking permission with 403', async () => {
            const middleware = requirePermission('JOURNALS', 'CREATE');
            let statusCalled = null;
            let jsonCalled = null;

            const viewerRole = await prisma.role.findUnique({ where: { name: 'VIEWER' } });
            let viewerUser = await prisma.user.findFirst({ where: { role: 'VIEWER', active: true } });
            if (!viewerUser) {
                viewerUser = await prisma.user.create({
                    data: {
                        name: 'Viewer Test User',
                        email: `viewer_${Date.now()}@example.com`,
                        password: 'ViewerPassword123!',
                        role: 'VIEWER',
                        roleId: viewerRole ? viewerRole.id : null,
                        active: true
                    }
                });
            } else if (viewerRole && viewerUser.roleId !== viewerRole.id) {
                viewerUser = await prisma.user.update({
                    where: { id: viewerUser.id },
                    data: { roleId: viewerRole.id }
                });
            }

            const req = {
                session: { user: { id: viewerUser.id, role: 'VIEWER', status: 'ACTIVE' } },
                originalUrl: '/api/payments/1/post',
                path: '/api/payments/1/post',
                method: 'POST',
                ip: '127.0.0.1',
                headers: { accept: 'application/json' }
            };
            const res = {
                locals: {},
                status: (code) => { statusCalled = code; return res; },
                json: (payload) => { jsonCalled = payload; return res; },
                render: (view, data) => { res.renderedView = view; return res; }
            };
            await middleware(req, res, () => {});
            assert.equal(statusCalled, 403);
            assert.equal(jsonCalled.success, false);
        });

        it('10.3 journal engine guarantees journal entries cannot be edited or deleted', async () => {
            await assert.rejects(
                async () => {
                    await journalService.updateJournalEntry(1, {});
                },
                /Posted journal entries are immutable/
            );

            await assert.rejects(
                async () => {
                    await journalService.deleteJournalEntry(1);
                },
                /Posted journal entries cannot be deleted/
            );

            assert.equal(typeof journalService.reverseJournalEntry, 'function');
        });
    });
});

