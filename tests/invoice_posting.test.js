'use strict';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const coaService = require('../app/services/chartOfAccounts.service');
const journalService = require('../app/services/journal.service');
const invoiceService = require('../app/services/invoice.service');
const postingService = require('../app/services/accounting/posting.service');
const { ensureFinancialYear, createFinancialYear } = require('../app/services/financialYear.service');

describe('Milestone 4: Invoice Accounting Posting & Double-Entry Ledger Integration', () => {
    let testAdmin = null;
    let testClient = null;
    let testFy = null;

    before(async () => {
        testAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testAdmin) {
            testAdmin = await prisma.user.findFirst();
        }

        testClient = await prisma.client.findFirst({ where: { active: true } });
        if (!testClient) {
            testClient = await prisma.client.create({
                data: {
                    name: 'Acme Technologies Pvt Ltd',
                    email: 'billing@acme.example.com',
                    phone: '9876543210',
                    gstin: '29ABCDE1234F1Z5',
                    stateCode: '29',
                    active: true,
                    createdById: testAdmin ? testAdmin.id : null
                }
            });
        }

        testFy = await ensureFinancialYear(new Date('2026-05-15'));
        await coaService.ensureSystemAccounts(testAdmin ? testAdmin.id : null);
    });

    after(async () => {
        await prisma.$disconnect();
    });

    describe('1. Intra-State Invoice Posting & Double-Entry Invariants', () => {
        let intraInvoice = null;

        it('1.1 should create a valid intra-state invoice with CGST and SGST', async () => {
            intraInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                clientGSTIN: testClient.gstin,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Software Development Services', quantity: 1, rate: 10000, unit: 'HRS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.ok(intraInvoice);
            assert.equal(intraInvoice.status, 'ACTIVE');
            assert.equal(intraInvoice.documentType, 'INVOICE');
            assert.equal(Number(intraInvoice.subtotal), 10000);
            assert.equal(Number(intraInvoice.cgstAmount), 900);
            assert.equal(Number(intraInvoice.sgstAmount), 900);
            assert.equal(Number(intraInvoice.igstAmount), 0);
            assert.equal(Number(intraInvoice.grandTotal), 11800);
        });

        it('1.2 should post invoice and produce a balanced double-entry journal', async () => {
            const initialJournalsCount = await prisma.journalEntry.count();
            const result = await postingService.postInvoice(intraInvoice.id, {
                userId: testAdmin ? testAdmin.id : null
            });

            assert.equal(result.success, true);
            assert.equal(result.alreadyPosted, false);
            assert.ok(result.journal);

            const journal = result.journal;
            assert.equal(journal.sourceType, 'INVOICE');
            assert.equal(journal.sourceId, intraInvoice.id);
            assert.equal(journal.idempotencyKey, `INVOICE:${intraInvoice.id}`);
            assert.ok(journal.entryNumber.startsWith('JRN-2026-27-'));
            assert.equal(journal.status, 'POSTED');

            // 4 lines: Receivable, Sales, Output CGST, Output SGST
            assert.equal(journal.lines.length, 4);

            // Double entry balance check: SUM(Dr) === SUM(Cr)
            let totalDr = 0n;
            let totalCr = 0n;
            for (const line of journal.lines) {
                totalDr += postingService.toCents(line.debit);
                totalCr += postingService.toCents(line.credit);
            }
            assert.equal(totalDr, totalCr, 'Total Debit must equal Total Credit');
            assert.equal(postingService.fromCents(totalDr), '11800.00');

            const finalJournalsCount = await prisma.journalEntry.count();
            assert.equal(finalJournalsCount, initialJournalsCount + 1);
        });

        it('1.3 should verify line accounts: Receivable Debit, Sales Credit, CGST/SGST Credits', async () => {
            const posting = await postingService.getInvoicePosting(intraInvoice.id);
            assert.ok(posting);

            const [arLine, salesLine, cgstLine, sgstLine] = posting.lines;

            // Line 1: Accounts Receivable
            assert.equal(arLine.account.code, '1121');
            assert.equal(arLine.account.type, 'ASSET');
            assert.equal(Number(arLine.debit), 11800.00);
            assert.equal(Number(arLine.credit), 0.00);
            assert.equal(arLine.clientId, testClient.id, 'Receivable line must tag the customer subledger');

            // Line 2: Sales Revenue
            assert.equal(salesLine.account.code, '4110');
            assert.equal(salesLine.account.type, 'INCOME');
            assert.equal(Number(salesLine.debit), 0.00);
            assert.equal(Number(salesLine.credit), 10000.00);

            // Line 3: Output CGST
            assert.equal(cgstLine.account.code, '2111');
            assert.equal(cgstLine.account.type, 'LIABILITY');
            assert.equal(Number(cgstLine.debit), 0.00);
            assert.equal(Number(cgstLine.credit), 900.00);

            // Line 4: Output SGST
            assert.equal(sgstLine.account.code, '2112');
            assert.equal(sgstLine.account.type, 'LIABILITY');
            assert.equal(Number(sgstLine.debit), 0.00);
            assert.equal(Number(sgstLine.credit), 900.00);
        });
    });

    describe('2. Inter-State Invoice Posting & IGST Verification', () => {
        let interInvoice = null;

        it('2.1 should post an inter-state invoice with IGST and zero CGST/SGST', async () => {
            interInvoice = await invoiceService.createInvoice({
                clientName: 'Global Enterprises Inc',
                clientId: testClient.id,
                sellerStateCode: '29', // Karnataka
                placeOfSupplyStateCode: '27', // Maharashtra (Inter-State)
                invoiceDate: new Date('2026-05-12'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Cloud Infrastructure Hosting', quantity: 2, rate: 2500, unit: 'MONTH' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(interInvoice.subtotal), 5000);
            assert.equal(Number(interInvoice.cgstAmount), 0);
            assert.equal(Number(interInvoice.sgstAmount), 0);
            assert.equal(Number(interInvoice.igstAmount), 900);
            assert.equal(Number(interInvoice.grandTotal), 5900);

            const result = await postingService.postInvoice(interInvoice.id);
            assert.equal(result.success, true);
            assert.ok(result.journal);

            // Lines: Receivable, Sales, Output IGST
            const lines = result.journal.lines;
            assert.equal(lines.length, 3);

            const arLine = lines.find(l => l.account.code === '1121');
            const salesLine = lines.find(l => l.account.code === '4110');
            const igstLine = lines.find(l => l.account.code === '2113');

            assert.ok(arLine && Number(arLine.debit) === 5900.00);
            assert.ok(salesLine && Number(salesLine.credit) === 5000.00);
            assert.ok(igstLine && Number(igstLine.credit) === 900.00);

            // Double entry balance invariant
            let totalDr = 0n;
            let totalCr = 0n;
            for (const l of lines) {
                totalDr += postingService.toCents(l.debit);
                totalCr += postingService.toCents(l.credit);
            }
            assert.equal(totalDr, totalCr);
        });
    });

    describe('3. Round-Off Handling & Exact Decimal Balancing', () => {
        it('3.1 should balance invoice with positive round-off (+₹0.01) via Credit to ROUND_OFF', async () => {
            // Rate of 33.33 * 3 = 99.99 with GST 18% = 17.9982 (rounded to 18.00)
            // Total before round = 117.99, grandTotal = 118.00, roundOff = +0.01
            const posRoundInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-14'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Hardware Parts', quantity: 3, rate: 33.33, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(posRoundInvoice.roundOff), 0.01);
            assert.equal(Number(posRoundInvoice.grandTotal), 118.00);

            const result = await postingService.postInvoice(posRoundInvoice.id);
            assert.equal(result.success, true);

            const lines = result.journal.lines;
            let totalDr = 0n;
            let totalCr = 0n;
            for (const l of lines) {
                totalDr += postingService.toCents(l.debit);
                totalCr += postingService.toCents(l.credit);
            }

            assert.equal(totalDr, totalCr, 'SUM(Dr) must equal SUM(Cr) exactly on positive rounded invoice');
            assert.equal(totalDr, postingService.toCents(posRoundInvoice.grandTotal));

            const roundOffLine = lines.find(l => l.account.code === '5230');
            assert.ok(roundOffLine, 'Must include Round Off line for positive discrepancy');
            assert.equal(Number(roundOffLine.credit), 0.01, 'Positive round-off must be credited');
            assert.equal(Number(roundOffLine.debit), 0.00);
        });

        it('3.2 should balance invoice with negative round-off (-₹0.21) via Debit to ROUND_OFF', async () => {
            // Subtotal = 84.92, GST 18% = 15.29, totalBeforeRound = 100.21
            // grandTotal = 100.00, roundOff = -0.21
            const negRoundInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-14'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Precision Cable Assembly', quantity: 1, rate: 84.92, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(negRoundInvoice.roundOff), -0.21);
            assert.equal(Number(negRoundInvoice.grandTotal), 100.00);

            const result = await postingService.postInvoice(negRoundInvoice.id);
            assert.equal(result.success, true);

            const lines = result.journal.lines;
            let totalDr = 0n;
            let totalCr = 0n;
            for (const l of lines) {
                totalDr += postingService.toCents(l.debit);
                totalCr += postingService.toCents(l.credit);
            }

            // Note: On negative round-off, Dr AR (100.00) + Dr Round Off (0.21) = 100.21 = Cr Sales (84.92) + Cr Taxes (15.29)
            assert.equal(totalDr, totalCr, 'SUM(Dr) must equal SUM(Cr) exactly on negative rounded invoice');

            const roundOffLine = lines.find(l => l.account.code === '5230');
            assert.ok(roundOffLine, 'Must include Round Off line for negative discrepancy');
            assert.equal(Number(roundOffLine.debit), 0.21, 'Negative round-off must be debited as balancing expense');
            assert.equal(Number(roundOffLine.credit), 0.00);

            const arLine = lines.find(l => l.account.code === '1121');
            assert.equal(Number(arLine.debit), 100.00, 'Customer Receivable must equal final grandTotal');
        });

        it('3.3 should balance invoice with zero round-off (₹0.00) without creating ROUND_OFF line', async () => {
            const exactInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-14'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Standard Software License', quantity: 1, rate: 1000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(exactInvoice.roundOff), 0.00);
            assert.equal(Number(exactInvoice.grandTotal), 1180.00);

            const result = await postingService.postInvoice(exactInvoice.id);
            assert.equal(result.success, true);

            const lines = result.journal.lines;
            let totalDr = 0n;
            let totalCr = 0n;
            for (const l of lines) {
                totalDr += postingService.toCents(l.debit);
                totalCr += postingService.toCents(l.credit);
            }

            assert.equal(totalDr, totalCr, 'SUM(Dr) must equal SUM(Cr) exactly on exact zero-roundoff invoice');
            assert.equal(totalDr, postingService.toCents(exactInvoice.grandTotal));

            const roundOffLine = lines.find(l => l.account.code === '5230');
            assert.equal(roundOffLine, undefined, 'Zero round-off invoice must NOT generate a ROUND_OFF line');
        });
    });

    describe('4. Idempotency & Concurrency Guarantees', () => {
        let idempotentInvoice = null;

        before(async () => {
            idempotentInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-15'),
                gstEnabled: false,
                items: [
                    { name: 'Consulting Retainer', quantity: 1, rate: 25000, unit: 'MONTH' }
                ]
            }, testAdmin ? testAdmin.id : 1);
        });

        it('4.1 should return existing journal on repeated sequential posting attempt', async () => {
            const firstPost = await postingService.postInvoice(idempotentInvoice.id);
            assert.equal(firstPost.success, true);
            assert.equal(firstPost.alreadyPosted, false);

            const secondPost = await postingService.postInvoice(idempotentInvoice.id);
            assert.equal(secondPost.success, true);
            assert.equal(secondPost.alreadyPosted, true);

            assert.equal(firstPost.journal.id, secondPost.journal.id);
            assert.equal(firstPost.journal.entryNumber, secondPost.journal.entryNumber);
        });

        it('4.2 should resolve concurrent postings to the exact same journal without duplicate entries', async () => {
            const concurrentInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-16'),
                gstEnabled: false,
                items: [
                    { name: 'Security Audit Fee', quantity: 1, rate: 15000, unit: 'JOB' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            const [postA, postB] = await Promise.all([
                postingService.postInvoice(concurrentInvoice.id),
                postingService.postInvoice(concurrentInvoice.id)
            ]);

            assert.equal(postA.journal.id, postB.journal.id);
            assert.equal(postA.journal.entryNumber, postB.journal.entryNumber);

            const matchingCount = await prisma.journalEntry.count({
                where: { idempotencyKey: `INVOICE:${concurrentInvoice.id}` }
            });
            assert.equal(matchingCount, 1, 'Exactly one journal must exist for the invoice');
        });
    });

    describe('5. Lifecycle Protection & Negative Constraints', () => {
        it('5.1 should reject posting a quotation document', async () => {
            const quotation = await invoiceService.createQuotation({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-18'),
                gstEnabled: false,
                items: [
                    { name: 'Project Proposal Item', quantity: 1, rate: 10000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            await assert.rejects(async () => {
                await postingService.postInvoice(quotation.id);
            }, /Quotations are non-posting documents/);
        });

        it('5.2 should reject posting a VOID invoice', async () => {
            const voidInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-19'),
                gstEnabled: false,
                items: [
                    { name: 'Test Void Service', quantity: 1, rate: 5000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            await invoiceService.updateInvoiceStatus(
                voidInvoice.id,
                'VOID',
                testAdmin ? testAdmin.id : 1,
                { version: voidInvoice.version }
            );

            await assert.rejects(async () => {
                await postingService.postInvoice(voidInvoice.id);
            }, /Cannot post VOID invoice/);
        });

        it('5.3 should reject posting a DELETED invoice', async () => {
            const delInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-20'),
                gstEnabled: false,
                items: [
                    { name: 'Test Deleted Service', quantity: 1, rate: 3000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            await invoiceService.softDeleteDocument(
                delInvoice.id,
                'Accidental invoice creation',
                testAdmin ? testAdmin.id : 1,
                { version: delInvoice.version }
            );

            await assert.rejects(async () => {
                await postingService.postInvoice(delInvoice.id);
            }, /Cannot post DELETED invoice/);
        });

        it('5.4 should reject posting an invoice into a CLOSED Financial Year', async () => {
            // Ensure FY is OPEN first to create invoice
            const closedFy = await ensureFinancialYear(new Date('2024-06-01'));
            await prisma.financialYear.update({
                where: { id: closedFy.id },
                data: { status: 'OPEN' }
            });

            const oldInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2024-06-15'),
                gstEnabled: false,
                items: [
                    { name: 'Historical Service', quantity: 1, rate: 4000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            await prisma.financialYear.update({
                where: { id: closedFy.id },
                data: { status: 'CLOSED' }
            });

            await assert.rejects(async () => {
                await postingService.postInvoice(oldInvoice.id);
            }, /Cannot post invoice into CLOSED Financial Year/);

            // Re-open FY for safety
            await prisma.financialYear.update({
                where: { id: closedFy.id },
                data: { status: 'OPEN' }
            });
        });

        it('5.5 should enforce posted journal immutability (cannot edit or delete)', async () => {
            const testInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-22'),
                gstEnabled: false,
                items: [
                    { name: 'Immutability Test Item', quantity: 1, rate: 7500, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            const { journal } = await postingService.postInvoice(testInvoice.id);

            await assert.rejects(async () => {
                await journalService.updateJournalEntry(journal.id, { narration: 'Tampered' });
            }, /Posted journal entries are immutable/);

            await assert.rejects(async () => {
                await journalService.deleteJournalEntry(journal.id);
            }, /Posted journal entries cannot be deleted/);
        });
    });

    describe('6. Accounting Status Inspection & UI Readiness', () => {
        it('6.1 should report unposted status for an unposted invoice', async () => {
            const freshInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-25'),
                gstEnabled: false,
                items: [
                    { name: 'Unposted Check Service', quantity: 1, rate: 1200, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            const status = await postingService.getInvoiceAccountingStatus(freshInvoice.id);
            assert.equal(status.isPosted, false);
            assert.equal(status.journalId, null);
            assert.equal(status.entryNumber, null);
        });

        it('6.2 should report posted status with journal metadata after posting', async () => {
            const invoiceToPost = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-26'),
                gstEnabled: false,
                items: [
                    { name: 'Posted Check Service', quantity: 1, rate: 8800, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            await postingService.postInvoice(invoiceToPost.id);

            const status = await postingService.getInvoiceAccountingStatus(invoiceToPost.id);
            assert.equal(status.isPosted, true);
            assert.ok(status.journalId > 0);
            assert.ok(status.entryNumber.startsWith('JRN-2026-27-'));
            assert.ok(status.postedAt instanceof Date);
        });
    });

    describe('7. Extended Accounting Edge Cases, Rollback & RBAC Protection', () => {
        it('7.1 should post GST-disabled invoice with exactly 2 lines (Receivable Dr, Sales Cr)', async () => {
            const noGstInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-28'),
                gstEnabled: false,
                items: [
                    { name: 'Exempt Agricultural Consulting', quantity: 2, rate: 7500, unit: 'HRS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(noGstInvoice.subtotal), 15000);
            assert.equal(Number(noGstInvoice.cgstAmount), 0);
            assert.equal(Number(noGstInvoice.sgstAmount), 0);
            assert.equal(Number(noGstInvoice.igstAmount), 0);
            assert.equal(Number(noGstInvoice.grandTotal), 15000);

            const result = await postingService.postInvoice(noGstInvoice.id);
            assert.equal(result.success, true);
            assert.equal(result.journal.lines.length, 2);

            const [drLine, crLine] = result.journal.lines;
            assert.equal(drLine.account.code, '1121'); // Accounts Receivable
            assert.equal(Number(drLine.debit), 15000);
            assert.equal(Number(drLine.credit), 0);

            assert.equal(crLine.account.code, '4110'); // Sales Revenue
            assert.equal(Number(crLine.debit), 0);
            assert.equal(Number(crLine.credit), 15000);
        });

        it('7.2 should post multi-item invoice with long industrial descriptions and maintain strict balance', async () => {
            const multiInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-05-30'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Precision CNC 5-Axis Milling Machine - High Torque Spindle Calibration', quantity: 2, rate: 45000, unit: 'SET' },
                    { name: 'Custom Industrial Carbide Drill Bit Tooling and Tungsten Coating Pack', quantity: 10, rate: 3500, unit: 'BOX' },
                    { name: 'On-site Metrology Laser Alignment and ISO-9001 Compliance Certificate', quantity: 1, rate: 20000, unit: 'LOT' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            // Subtotal = 90000 + 35000 + 20000 = 145000
            // GST 18% = 26100 (CGST 13050 + SGST 13050)
            // Grand Total = 171100
            assert.equal(Number(multiInvoice.subtotal), 145000);
            assert.equal(Number(multiInvoice.cgstAmount), 13050);
            assert.equal(Number(multiInvoice.sgstAmount), 13050);
            assert.equal(Number(multiInvoice.grandTotal), 171100);

            const result = await postingService.postInvoice(multiInvoice.id);
            assert.equal(result.success, true);

            let totalDr = 0n;
            let totalCr = 0n;
            for (const l of result.journal.lines) {
                totalDr += postingService.toCents(l.debit);
                totalCr += postingService.toCents(l.credit);
            }
            assert.equal(totalDr, totalCr);
            assert.equal(totalDr, postingService.toCents(171100));
        });

        it('7.3 should isolate historical journal when client master data is mutated after posting', async () => {
            const testClientTemp = await prisma.client.create({
                data: {
                    name: 'Initial Historical Client Name',
                    email: 'initial@client.org',
                    phone: '9888888888',
                    gstin: '29AAAAA0000A1Z5',
                    stateCode: '29',
                    billingAddress: 'Original Street 1, Bengaluru',
                    active: true,
                    createdById: testAdmin ? testAdmin.id : null
                }
            });

            const histInvoice = await invoiceService.createInvoice({
                clientName: testClientTemp.name,
                clientId: testClientTemp.id,
                clientGSTIN: testClientTemp.gstin,
                billingAddress: testClientTemp.billingAddress,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-06-01'),
                gstEnabled: false,
                items: [
                    { name: 'Historical Consulting Contract', quantity: 1, rate: 25000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            const postResult = await postingService.postInvoice(histInvoice.id);
            assert.equal(postResult.success, true);
            const originalJournalId = postResult.journal.id;

            // 1. Now mutate client master record (name, gstin, billingAddress)
            await prisma.client.update({
                where: { id: testClientTemp.id },
                data: {
                    name: 'Completely Renamed Corporate Entity',
                    gstin: '29ZZZZZ9999Z9Z9',
                    billingAddress: 'New Address Boulevard, Mumbai'
                }
            });

            // 2. Verify source invoice preserved immutable frozen commercial snapshot
            const refetchedInvoice = await prisma.invoice.findUnique({
                where: { id: histInvoice.id }
            });
            assert.equal(refetchedInvoice.clientName, 'Initial Historical Client Name');
            assert.equal(refetchedInvoice.clientGSTIN, '29AAAAA0000A1Z5');
            assert.equal(refetchedInvoice.billingAddress, 'Original Street 1, Bengaluru');
            assert.equal(refetchedInvoice.clientId, testClientTemp.id);

            // 3. Re-fetch posted journal and verify integrity
            const journal = await prisma.journalEntry.findUnique({
                where: { id: originalJournalId },
                include: { lines: { include: { account: true, client: true } } }
            });

            // 4. Verify journal narration and lines retain historical snapshot text
            assert.equal(journal.lines.length, 2);
            assert.equal(Number(journal.lines[0].debit), 25000);
            assert.equal(journal.narration.includes('Initial Historical Client Name'), true);
            assert.equal(journal.lines[0].description.includes('Initial Historical Client Name'), true);

            // 5. Verify customer subledger key remains permanently connected
            assert.equal(journal.lines[0].clientId, testClientTemp.id);
            assert.equal(journal.lines[0].client.id, testClientTemp.id);

            // 6. Subledger query by clientId still aggregates this historical invoice
            const subledgerEntries = await prisma.journalEntryLine.findMany({
                where: { clientId: testClientTemp.id }
            });
            assert.equal(subledgerEntries.length, 1);
            assert.equal(Number(subledgerEntries[0].debit), 25000);
        });

        it('7.4 should guarantee atomic rollback if transaction fails mid-flight', async () => {
            const rollbackInvoice = await invoiceService.createInvoice({
                clientName: testClient.name,
                clientId: testClient.id,
                sellerStateCode: '29',
                placeOfSupplyStateCode: '29',
                invoiceDate: new Date('2026-06-05'),
                gstEnabled: false,
                items: [
                    { name: 'Rollback Service', quantity: 1, rate: 5000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            const initialJournalCount = await prisma.journalEntry.count();
            const initialLinesCount = await prisma.journalEntryLine.count();

            // Attempt posting with invalid client/tx that aborts
            await assert.rejects(async () => {
                await prisma.$transaction(async (tx) => {
                    await postingService.postInvoice(rollbackInvoice.id, { userId: testAdmin ? testAdmin.id : 1 }, tx);
                    // Force an intentional rollback exception
                    throw new Error('SIMULATED_LEDGER_FAILURE');
                });
            }, /SIMULATED_LEDGER_FAILURE/);

            const finalJournalCount = await prisma.journalEntry.count();
            const finalLinesCount = await prisma.journalEntryLine.count();

            assert.equal(finalJournalCount, initialJournalCount, 'No partial journal entry should persist');
            assert.equal(finalLinesCount, initialLinesCount, 'No orphan journal lines should persist');

            const status = await postingService.getInvoiceAccountingStatus(rollbackInvoice.id);
            assert.equal(status.isPosted, false, 'Invoice must remain unposted after rollback');
        });

        it('7.5 should enforce RBAC: user without JOURNALS:CREATE permission is denied', async () => {
            const rbacService = require('../app/services/rbac.service');
            const viewerRole = await prisma.role.findUnique({ where: { name: 'VIEWER' } });
            assert.ok(viewerRole);

            // Check if VIEWER has JOURNALS:CREATE
            const viewerMatrix = await rbacService.computeEffectiveAccessMatrix(viewerRole.id);
            assert.equal(viewerMatrix.matrix.JOURNALS.CREATE, false, 'VIEWER role must NOT have JOURNALS:CREATE permission');

            const adminRole = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
            assert.ok(adminRole);
            const adminMatrix = await rbacService.computeEffectiveAccessMatrix(adminRole.id);
            assert.equal(adminMatrix.matrix.JOURNALS.CREATE, true, 'ADMIN role must have JOURNALS:CREATE permission');
        });
    });
});
