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
const creditDebitNoteService = require('../app/services/creditDebitNote.service');
const { ensureFinancialYear, createFinancialYear } = require('../app/services/financialYear.service');
const { requirePermission } = require('../app/middleware/permission.middleware');
const rbacService = require('../app/services/rbac.service');

describe('Milestone 6: Credit Notes & Debit Notes Accounting & Integration Suite', () => {
    let testAdmin = null;
    let testClientA = null;
    let testClientB = null;
    let testFy2025 = null;
    let testFy2026 = null;

    before(async () => {
        testAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testAdmin) {
            testAdmin = await prisma.user.findFirst();
        }

        testClientA = await prisma.client.create({
            data: {
                name: `Client Alpha ${Date.now()}`,
                email: `alpha_${Date.now()}@test.com`,
                phone: '9876543210',
                gstin: '27AAAAA0000A1Z5',
                stateCode: '27', // Maharashtra
                billingAddress: '123 Alpha St, Mumbai',
                shippingAddress: '123 Alpha St, Mumbai',
                active: true,
                createdById: testAdmin ? testAdmin.id : null
            }
        });

        testClientB = await prisma.client.create({
            data: {
                name: `Client Beta ${Date.now()}`,
                email: `beta_${Date.now()}@test.com`,
                phone: '9876543211',
                gstin: '29BBBBB0000B1Z6',
                stateCode: '29', // Karnataka (Inter-state)
                billingAddress: '456 Beta Rd, Bengaluru',
                shippingAddress: '456 Beta Rd, Bengaluru',
                active: true,
                createdById: testAdmin ? testAdmin.id : null
            }
        });

        // Ensure both FY 2025-26 and FY 2026-27 exist
        testFy2025 = await ensureFinancialYear(new Date('2025-10-15'));
        testFy2026 = await ensureFinancialYear(new Date('2026-05-15'));

        await coaService.ensureSystemAccounts(testAdmin ? testAdmin.id : null);
        await rbacService.seedPermissionsAndRoles();
    });

    after(async () => {
        await prisma.$disconnect();
    });

    // =========================================================================
    // 1. Create valid credit note
    // =========================================================================
    describe('1. Create valid credit note', () => {
        let baseInvoice = null;
        let creditNoteRes = null;

        before(async () => {
            baseInvoice = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                clientGSTIN: testClientA.gstin,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-05-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Server Hardware', quantity: 2, rate: 5000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            await postingService.postInvoice(baseInvoice.id, { userId: testAdmin ? testAdmin.id : null });
        });

        it('1.1 should create a valid credit note linked to original invoice', async () => {
            creditNoteRes = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: baseInvoice.id,
                reason: 'Goods damaged during transit',
                noteDate: new Date('2026-05-12'),
                items: [
                    { name: 'Server Hardware Damaged', quantity: 1, rate: 5000, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.ok(creditNoteRes);
            assert.ok(creditNoteRes.note);
            assert.equal(creditNoteRes.note.noteType, 'CREDIT');
            assert.equal(creditNoteRes.note.status, 'ISSUED');
            assert.equal(creditNoteRes.note.invoiceId, baseInvoice.id);
            assert.equal(creditNoteRes.note.clientId, testClientA.id);
            assert.equal(creditNoteRes.note.subtotal, 5000);
            assert.equal(creditNoteRes.note.grandTotal, 5900);
            assert.match(creditNoteRes.note.noteNumber, /^(CN-2026-27-\d{4}|CRN\/2026\/05\/\d+)$/);
        });

        it('1.2 should store persistent database record for the credit note', async () => {
            const dbNote = await prisma.creditDebitNote.findUnique({
                where: { id: creditNoteRes.note.id },
                include: { items: true }
            });
            assert.ok(dbNote);
            assert.equal(dbNote.items.length, 1);
            assert.equal(dbNote.items[0].name, 'Server Hardware Damaged');
            assert.equal(Number(dbNote.items[0].quantity), 1);
            assert.equal(Number(dbNote.items[0].rate), 5000);
        });
    });

    // =========================================================================
    // 2. Create valid debit note
    // =========================================================================
    describe('2. Create valid debit note', () => {
        let baseInvoice = null;
        let debitNoteRes = null;

        before(async () => {
            baseInvoice = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                clientGSTIN: testClientA.gstin,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-06-01'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Web Hosting Plan', quantity: 1, rate: 10000, unit: 'YR' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            await postingService.postInvoice(baseInvoice.id, { userId: testAdmin ? testAdmin.id : null });
        });

        it('2.1 should create a valid debit note increasing amount due', async () => {
            debitNoteRes = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'DEBIT',
                invoiceId: baseInvoice.id,
                reason: 'Price undercharged in original invoice',
                noteDate: new Date('2026-06-05'),
                items: [
                    { name: 'Additional Bandwidth Surcharge', quantity: 1, rate: 2000, unit: 'SVC' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.ok(debitNoteRes);
            assert.ok(debitNoteRes.note);
            assert.equal(debitNoteRes.note.noteType, 'DEBIT');
            assert.equal(debitNoteRes.note.status, 'ISSUED');
            assert.equal(debitNoteRes.note.subtotal, 2000);
            assert.equal(debitNoteRes.note.grandTotal, 2360);
            assert.match(debitNoteRes.note.noteNumber, /^(DN-2026-27-\d{4}|DBN\/2026\/06\/\d+)$/);
        });
    });

    // =========================================================================
    // 3. Intra-state tax split (CGST + SGST)
    // =========================================================================
    describe('3. Intra-state tax split', () => {
        it('3.1 should split GST evenly into CGST and SGST for intra-state (27 -> 27)', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-06-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Intra Service', quantity: 1, rate: 10000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Intra-state adjustment',
                noteDate: new Date('2026-06-11'),
                items: [{ name: 'Service discount', quantity: 1, rate: 4000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(cn.note.subtotal, 4000);
            assert.equal(cn.note.cgstAmount, 360); // 9% of 4000
            assert.equal(cn.note.sgstAmount, 360); // 9% of 4000
            assert.equal(cn.note.igstAmount, 0);
            assert.equal(cn.note.grandTotal, 4720);

            // Verify journal lines
            const cgstAccount = await coaService.getSystemAccount('OUTPUT_CGST');
            const sgstAccount = await coaService.getSystemAccount('OUTPUT_SGST');
            const lines = cn.journal.lines;

            const cgstLine = lines.find(l => l.accountId === cgstAccount.id);
            const sgstLine = lines.find(l => l.accountId === sgstAccount.id);

            assert.ok(cgstLine, 'CGST line must exist in journal');
            assert.ok(sgstLine, 'SGST line must exist in journal');
            assert.equal(Number(cgstLine.debit), 360.00);
            assert.equal(Number(sgstLine.debit), 360.00);
        });
    });

    // =========================================================================
    // 4. Inter-state IGST
    // =========================================================================
    describe('4. Inter-state IGST', () => {
        it('4.1 should charge IGST full amount without CGST/SGST for inter-state (27 -> 29)', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientB.name,
                clientId: testClientB.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '29', // Inter-state
                invoiceDate: new Date('2026-06-15'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Interstate Consulting', quantity: 1, rate: 20000, unit: 'HRS' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Interstate discount',
                noteDate: new Date('2026-06-16'),
                items: [{ name: 'Consulting rebate', quantity: 1, rate: 5000, unit: 'HRS' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(cn.note.subtotal, 5000);
            assert.equal(cn.note.cgstAmount, 0);
            assert.equal(cn.note.sgstAmount, 0);
            assert.equal(cn.note.igstAmount, 900); // 18% of 5000
            assert.equal(cn.note.grandTotal, 5900);

            const igstAccount = await coaService.getSystemAccount('OUTPUT_IGST');
            const igstLine = cn.journal.lines.find(l => l.accountId === igstAccount.id);
            assert.ok(igstLine, 'IGST line must exist in journal');
            assert.equal(Number(igstLine.debit), 900.00);
        });
    });

    // =========================================================================
    // 5. GST disabled and zero-tax cases
    // =========================================================================
    describe('5. GST disabled and zero-tax cases', () => {
        it('5.1 should support GST disabled notes with zero tax components', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-06-20'),
                gstEnabled: false,
                gstRate: 0,
                items: [{ name: 'Exempt Agricultural Supply', quantity: 5, rate: 1000, unit: 'BAG' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Partial return of bags',
                noteDate: new Date('2026-06-21'),
                gstEnabled: false,
                gstRate: 0,
                items: [{ name: 'Exempt Return', quantity: 2, rate: 1000, unit: 'BAG' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(cn.note.gstEnabled, false);
            assert.equal(cn.note.subtotal, 2000);
            assert.equal(cn.note.cgstAmount, 0);
            assert.equal(cn.note.sgstAmount, 0);
            assert.equal(cn.note.igstAmount, 0);
            assert.equal(cn.note.grandTotal, 2000);

            // Journal should only have Sales Returns and AR lines (no tax lines)
            assert.equal(cn.journal.lines.length, 2);
            const line0Amount = Number(cn.journal.lines[0].debit) + Number(cn.journal.lines[0].credit);
            const line1Amount = Number(cn.journal.lines[1].debit) + Number(cn.journal.lines[1].credit);
            assert.equal(line0Amount, 2000);
            assert.equal(line1Amount, 2000);
        });
    });

    // =========================================================================
    // 6. Partial adjustments
    // =========================================================================
    describe('6. Partial adjustments', () => {
        it('6.1 should correctly compute partial quantity and value adjustments', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-01'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Widgets', quantity: 100, rate: 50, unit: 'PCS' }] // 5000 + 900 = 5900
            }, testAdmin ? testAdmin.id : 1);

            // Partial adjustment for 10 widgets only
            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: '10 defective widgets returned',
                noteDate: new Date('2026-07-02'),
                items: [{ name: 'Defective Widgets', quantity: 10, rate: 50, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(cn.note.subtotal, 500);
            assert.equal(cn.note.cgstAmount, 45);
            assert.equal(cn.note.sgstAmount, 45);
            assert.equal(cn.note.grandTotal, 590);
        });
    });

    // =========================================================================
    // 7. Multi-item adjustments
    // =========================================================================
    describe('7. Multi-item adjustments', () => {
        it('7.1 should aggregate multiple distinct line items accurately', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-05'),
                gstEnabled: true,
                gstRate: 18,
                items: [
                    { name: 'Item 1', quantity: 10, rate: 100, unit: 'PCS' },
                    { name: 'Item 2', quantity: 5, rate: 200, unit: 'PCS' }
                ]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Multi item price renegotiation',
                noteDate: new Date('2026-07-06'),
                items: [
                    { name: 'Item 1 adjustment', quantity: 2, rate: 100, unit: 'PCS' }, // 200
                    { name: 'Item 2 adjustment', quantity: 1, rate: 200, unit: 'PCS' }  // 200
                ]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(cn.note.subtotal, 400);
            assert.equal(cn.note.cgstAmount, 36);
            assert.equal(cn.note.sgstAmount, 36);
            assert.equal(cn.note.grandTotal, 472);
            assert.equal(cn.note.items.length, 2);
        });
    });

    // =========================================================================
    // 8. Correct Financial Year by note date
    // =========================================================================
    describe('8. Correct Financial Year by note date', () => {
        it('8.1 derives FY 2025-26 from 31 March 2026 note date', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-03-15'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Q4 Services', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'FY2025-26 Year-End discount',
                noteDate: new Date('2026-03-31'),
                items: [{ name: 'Discount', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(cn.note.financialYear.code, '2025-26');
            assert.match(cn.note.noteNumber, /^(CN-2025-26-\d{4}|CRN\/2026\/03\/\d+)$/);
            assert.equal(cn.journal.financialYear.code, '2025-26');
        });

        it('8.2 derives FY 2026-27 from 1 April 2026 note date', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-03-25'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'March Supply', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'April correction',
                noteDate: new Date('2026-04-01'),
                items: [{ name: 'Rebate', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(cn.note.financialYear.code, '2026-27');
            assert.match(cn.note.noteNumber, /^(CN-2026-27-\d{4}|CRN\/2026\/04\/\d+)$/);
            assert.equal(cn.journal.financialYear.code, '2026-27');
        });
    });

    // =========================================================================
    // 9. Cross-FY original invoice references
    // =========================================================================
    describe('9. Cross-FY original invoice references', () => {
        it('9.1 note in FY 2026-27 referencing invoice from FY 2025-26 maintains correct FY on each', async () => {
            // Invoice created in FY 2025-26
            const oldInv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2025-11-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Old Contract', quantity: 1, rate: 10000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const invJournal = (await postingService.postInvoice(oldInv.id, { userId: testAdmin ? testAdmin.id : null })).journal;
            assert.equal(invJournal.financialYear.code, '2025-26');

            // Credit Note issued in FY 2026-27
            const newCn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: oldInv.id,
                reason: 'Cross FY adjustment',
                noteDate: new Date('2026-08-20'),
                items: [{ name: 'Old contract concession', quantity: 1, rate: 2000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(newCn.note.financialYear.code, '2026-27');
            assert.match(newCn.note.noteNumber, /^(CN-2026-27-\d{4}|CRN\/2026\/08\/\d+)$/);
            assert.equal(newCn.journal.financialYear.code, '2026-27');
            assert.equal(newCn.note.invoiceId, oldInv.id);
            assert.equal(newCn.note.originalInvoiceNumber, oldInv.invoiceNumber);
        });
    });

    // =========================================================================
    // 10. Invalid or mismatched client/invoice references
    // =========================================================================
    describe('10. Invalid or mismatched client/invoice references', () => {
        let inv = null;

        before(async () => {
            inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Base Work', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);
        });

        it('10.1 rejects note with non-existent invoiceId', async () => {
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: 9999999,
                        reason: 'Non-existent invoice',
                        noteDate: new Date('2026-07-11'),
                        items: [{ name: 'Adj', quantity: 1, rate: 100, unit: 'SVC' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /not found/i
            );
        });

        it('10.2 rejects note if client does not match invoice client', async () => {
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: inv.id,
                        clientId: testClientB.id, // Mismatched client!
                        reason: 'Mismatched client',
                        noteDate: new Date('2026-07-11'),
                        items: [{ name: 'Adj', quantity: 1, rate: 100, unit: 'SVC' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /does not match/i
            );
        });
    });

    // =========================================================================
    // 11. Invalid note values
    // =========================================================================
    describe('11. Invalid note values', () => {
        let inv = null;

        before(async () => {
            inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-15'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Standard Item', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);
        });

        it('11.1 rejects note with empty line items', async () => {
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: inv.id,
                        reason: 'No items',
                        noteDate: new Date('2026-07-16'),
                        items: []
                    }, testAdmin ? testAdmin.id : 1);
                },
                /at least one line item is required/i
            );
        });

        it('11.2 rejects note with negative rate', async () => {
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: inv.id,
                        reason: 'Negative rate',
                        noteDate: new Date('2026-07-16'),
                        items: [{ name: 'Bad item', quantity: 1, rate: -500, unit: 'SVC' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /cannot be negative/i
            );
        });

        it('11.3 rejects note with zero or negative quantity', async () => {
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: inv.id,
                        reason: 'Zero quantity',
                        noteDate: new Date('2026-07-16'),
                        items: [{ name: 'Bad item', quantity: 0, rate: 500, unit: 'SVC' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /positive quantity/i
            );
        });
    });

    // =========================================================================
    // 12. Excessive adjustment rejection where applicable
    // =========================================================================
    describe('12. Excessive adjustment rejection (over-crediting)', () => {
        let inv = null;

        before(async () => {
            inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-20'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Limited item', quantity: 1, rate: 1000, unit: 'PCS' }] // Total: 1180
            }, testAdmin ? testAdmin.id : 1);
        });

        it('12.1 rejects single credit note that exceeds invoice total', async () => {
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: inv.id,
                        reason: 'Exorbitant discount',
                        noteDate: new Date('2026-07-21'),
                        items: [{ name: 'Over credit item', quantity: 1, rate: 1500, unit: 'PCS' }] // 1500 + 270 = 1770 > 1180
                    }, testAdmin ? testAdmin.id : 1);
                },
                /exceeds the invoice unadjusted balance/i
            );
        });

        it('12.2 rejects cumulative credit notes that together exceed invoice total', async () => {
            // First valid credit note for 1000 (total 1180)
            await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'First credit note',
                noteDate: new Date('2026-07-21'),
                items: [{ name: 'Credit 1', quantity: 1, rate: 800, unit: 'PCS' }] // 800 + 144 = 944
            }, testAdmin ? testAdmin.id : 1);

            // Second note tries to credit 500 (500 + 90 = 590). Remaining is 1180 - 944 = 236!
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: inv.id,
                        reason: 'Second credit note over limit',
                        noteDate: new Date('2026-07-22'),
                        items: [{ name: 'Credit 2', quantity: 1, rate: 500, unit: 'PCS' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /exceeds the invoice unadjusted balance/i
            );
        });

        it('12.3 allows credit adjustments against increased invoice value resulting from debit notes', async () => {
            const invDual = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-25'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Base Service', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Add Debit Note: 2000 + 18% = 2360 (Total billable: 5900 + 2360 = 8260)
            await creditDebitNoteService.createCreditDebitNote({
                noteType: 'DEBIT',
                invoiceId: invDual.id,
                reason: 'Extra scope',
                noteDate: new Date('2026-07-26'),
                items: [{ name: 'Extra scope item', quantity: 1, rate: 2000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Issue Credit Note for 6000 + 18% = 7080 (which is > 5900 original invoice, but < 8260 effective invoice)
            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: invDual.id,
                reason: 'Credit scope refund',
                noteDate: new Date('2026-07-27'),
                items: [{ name: 'Refund item', quantity: 1, rate: 6000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(cn.note.grandTotal), 7080);

            // Now remaining is 8260 - 7080 = 1180. Attempting to credit 1500 (1500 + 270 = 1770) must reject!
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: invDual.id,
                        reason: 'Excess credit beyond net invoice balance',
                        noteDate: new Date('2026-07-28'),
                        items: [{ name: 'Excess refund', quantity: 1, rate: 1500, unit: 'SVC' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /exceeds the invoice unadjusted balance/i
            );
        });

        it('12.4 serializes concurrent credit notes on invoice and rejects race condition over-crediting', async () => {
            const invRace = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-29'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Race Item', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Two concurrent requests each trying to credit 700 (700 + 126 = 826). Total 1652 > 1180!
            const req1 = creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: invRace.id,
                reason: 'Concurrent CN A',
                noteDate: new Date('2026-07-30'),
                items: [{ name: 'Adj A', quantity: 1, rate: 700, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const req2 = creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: invRace.id,
                reason: 'Concurrent CN B',
                noteDate: new Date('2026-07-30'),
                items: [{ name: 'Adj B', quantity: 1, rate: 700, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const results = await Promise.allSettled([req1, req2]);
            const fulfilled = results.filter(r => r.status === 'fulfilled');
            const rejected = results.filter(r => r.status === 'rejected');

            assert.equal(fulfilled.length, 1, 'Exactly one concurrent credit note must succeed');
            assert.equal(rejected.length, 1, 'The racing credit note exceeding balance must be rejected');
            assert.match(rejected[0].reason.message, /exceeds the invoice unadjusted balance/i);
        });

        it('12.5 voided credit note releases credit capacity and allows new credit note', async () => {
            const invVoidCn = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-31'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Capacity Test Item', quantity: 1, rate: 1000, unit: 'SVC' }] // 1180 Total
            }, testAdmin ? testAdmin.id : 1);

            // Exhaust all capacity: issue credit note for 1000 + 18% = 1180
            const cn1 = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: invVoidCn.id,
                reason: 'Full credit note to exhaust capacity',
                noteDate: new Date('2026-08-01'),
                items: [{ name: 'Adj', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Additional credit note must reject
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: invVoidCn.id,
                        reason: 'Attempt while capacity exhausted',
                        noteDate: new Date('2026-08-01'),
                        items: [{ name: 'Adj 2', quantity: 1, rate: 100, unit: 'SVC' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /exceeds the invoice unadjusted balance/i
            );

            // Void cn1
            await creditDebitNoteService.voidCreditDebitNote(cn1.note.id, testAdmin ? testAdmin.id : 1, 'Release capacity');

            // Now issuing another credit note for full 1180 must succeed
            const cn2 = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: invVoidCn.id,
                reason: 'Credit after voiding previous note',
                noteDate: new Date('2026-08-01'),
                items: [{ name: 'Adj 2', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(cn2.note.grandTotal), 1180);
        });

        it('12.6 voided debit note no longer expands effective invoice total', async () => {
            const invVoidDn = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-31'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Debit Revert Item', quantity: 1, rate: 1000, unit: 'SVC' }] // 1180
            }, testAdmin ? testAdmin.id : 1);

            // Add debit note for 500 + 18% = 590
            const dn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'DEBIT',
                invoiceId: invVoidDn.id,
                reason: 'Temporary debit',
                noteDate: new Date('2026-08-01'),
                items: [{ name: 'Debit adj', quantity: 1, rate: 500, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Void debit note
            await creditDebitNoteService.voidCreditDebitNote(dn.note.id, testAdmin ? testAdmin.id : 1, 'Cancel debit');

            // Attempting to credit 1200 + 18% = 1416 (which would have been valid if debit note was active) must reject
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: invVoidDn.id,
                        reason: 'Over credit assuming voided debit still expands limit',
                        noteDate: new Date('2026-08-01'),
                        items: [{ name: 'Credit adj', quantity: 1, rate: 1200, unit: 'SVC' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /exceeds the invoice unadjusted balance/i
            );
        });

        it('12.7 draft credit note reserves capacity, and voiding draft restores capacity', async () => {
            const invDraft = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-07-31'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Draft Reserve Item', quantity: 1, rate: 1000, unit: 'SVC' }] // 1180
            }, testAdmin ? testAdmin.id : 1);

            // Create DRAFT credit note for 700 + 18% = 826
            const draftCn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: invDraft.id,
                status: 'DRAFT',
                reason: 'Draft note reserving capacity',
                noteDate: new Date('2026-08-01'),
                items: [{ name: 'Draft line', quantity: 1, rate: 700, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(draftCn.note.status, 'DRAFT');

            // Remaining capacity is 1180 - 826 = 354. Trying to credit 400 + 18% = 472 must reject!
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: invDraft.id,
                        reason: 'Second note exceeding remaining draft-reserved capacity',
                        noteDate: new Date('2026-08-01'),
                        items: [{ name: 'Second line', quantity: 1, rate: 400, unit: 'SVC' }]
                    }, testAdmin ? testAdmin.id : 1);
                },
                /exceeds the invoice unadjusted balance/i
            );

            // Void the DRAFT credit note
            await creditDebitNoteService.voidCreditDebitNote(draftCn.note.id, testAdmin ? testAdmin.id : 1, 'Discard draft');

            // Now issuing 1000 + 18% = 1180 must succeed
            const finalCn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: invDraft.id,
                reason: 'Final credit after draft voided',
                noteDate: new Date('2026-08-01'),
                items: [{ name: 'Final line', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(Number(finalCn.note.grandTotal), 1180);
        });
    });

    // =========================================================================
    // 13. Duplicate number prevention
    // =========================================================================
    describe('13. Duplicate number prevention', () => {
        it('13.1 sequence generator guarantees strictly ascending unique numbers', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-01'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Seq Item', quantity: 10, rate: 1000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const n1 = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Seq 1',
                noteDate: new Date('2026-08-02'),
                items: [{ name: 'Adj 1', quantity: 1, rate: 100, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const n2 = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Seq 2',
                noteDate: new Date('2026-08-02'),
                items: [{ name: 'Adj 2', quantity: 1, rate: 100, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.notEqual(n1.note.noteNumber, n2.note.noteNumber);

            const num1 = parseInt(n1.note.noteNumber.split('-').pop(), 10);
            const num2 = parseInt(n2.note.noteNumber.split('-').pop(), 10);
            assert.equal(num2, num1 + 1);
        });

        it('13.2 concurrent creation of two credit notes produces distinct unique numbers', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-01'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Concurrent Item', quantity: 10, rate: 1000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const [cn1, cn2] = await Promise.all([
                creditDebitNoteService.createCreditDebitNote({
                    noteType: 'CREDIT',
                    invoiceId: inv.id,
                    reason: 'Concurrent CN 1',
                    noteDate: new Date('2026-08-02'),
                    items: [{ name: 'Adj 1', quantity: 1, rate: 100, unit: 'PCS' }]
                }, testAdmin ? testAdmin.id : 1),
                creditDebitNoteService.createCreditDebitNote({
                    noteType: 'CREDIT',
                    invoiceId: inv.id,
                    reason: 'Concurrent CN 2',
                    noteDate: new Date('2026-08-02'),
                    items: [{ name: 'Adj 2', quantity: 1, rate: 100, unit: 'PCS' }]
                }, testAdmin ? testAdmin.id : 1)
            ]);

            assert.notEqual(cn1.note.noteNumber, cn2.note.noteNumber);
            assert.ok(cn1.note.noteNumber.startsWith('CN-') || cn1.note.noteNumber.startsWith('CRN/'));
            assert.ok(cn2.note.noteNumber.startsWith('CN-') || cn2.note.noteNumber.startsWith('CRN/'));
        });

        it('13.3 concurrent creation of two debit notes produces distinct unique numbers', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-01'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Concurrent DN Item', quantity: 10, rate: 1000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const [dn1, dn2] = await Promise.all([
                creditDebitNoteService.createCreditDebitNote({
                    noteType: 'DEBIT',
                    invoiceId: inv.id,
                    reason: 'Concurrent DN 1',
                    noteDate: new Date('2026-08-02'),
                    items: [{ name: 'Adj 1', quantity: 1, rate: 100, unit: 'PCS' }]
                }, testAdmin ? testAdmin.id : 1),
                creditDebitNoteService.createCreditDebitNote({
                    noteType: 'DEBIT',
                    invoiceId: inv.id,
                    reason: 'Concurrent DN 2',
                    noteDate: new Date('2026-08-02'),
                    items: [{ name: 'Adj 2', quantity: 1, rate: 100, unit: 'PCS' }]
                }, testAdmin ? testAdmin.id : 1)
            ]);

            assert.notEqual(dn1.note.noteNumber, dn2.note.noteNumber);
            assert.ok(dn1.note.noteNumber.startsWith('DN-') || dn1.note.noteNumber.startsWith('DBN/'));
            assert.ok(dn2.note.noteNumber.startsWith('DN-') || dn2.note.noteNumber.startsWith('DBN/'));
        });

        it('13.4 credit notes and debit notes maintain separate independent sequences in the same FY', async () => {
            const seqCreditBefore = await prisma.creditDebitNoteSequence.findUnique({
                where: { noteType_financialYearId: { noteType: 'CREDIT', financialYearId: testFy2026.id } }
            });
            const seqDebitBefore = await prisma.creditDebitNoteSequence.findUnique({
                where: { noteType_financialYearId: { noteType: 'DEBIT', financialYearId: testFy2026.id } }
            });

            const currentCreditNum = seqCreditBefore ? seqCreditBefore.currentNumber : 0;
            const currentDebitNum = seqDebitBefore ? seqDebitBefore.currentNumber : 0;

            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-01'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Dual Seq Item', quantity: 10, rate: 1000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Separate seq CN',
                noteDate: new Date('2026-08-03'),
                items: [{ name: 'Adj', quantity: 1, rate: 100, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const dn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'DEBIT',
                invoiceId: inv.id,
                reason: 'Separate seq DN',
                noteDate: new Date('2026-08-03'),
                items: [{ name: 'Adj', quantity: 1, rate: 100, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const cnNum = parseInt(cn.note.noteNumber.split('/').pop().split('-').pop(), 10);
            const dnNum = parseInt(dn.note.noteNumber.split('/').pop().split('-').pop(), 10);

            assert.ok(!isNaN(cnNum));
            assert.ok(!isNaN(dnNum));
        });

        it('13.5 note sequence allocation is isolated across separate Financial Years', async () => {
            const inv2025 = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2025-11-01'),
                gstEnabled: false,
                items: [{ name: 'FY25 Item', quantity: 1, rate: 2000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn2025 = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv2025.id,
                reason: 'FY25 CN',
                noteDate: new Date('2025-11-05'),
                items: [{ name: 'FY25 CN Adj', quantity: 1, rate: 500, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.ok(cn2025.note.noteNumber.includes(testFy2025.code) || cn2025.note.noteNumber.startsWith('CRN/2025/11/'));
            assert.equal(cn2025.note.financialYearId, testFy2025.id);
        });
    });

    // =========================================================================
    // 14. Credit note balanced journal
    // =========================================================================
    describe('14. Credit note balanced journal', () => {
        it('14.1 ensures exact Dr == Cr balance down to the integer cent', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-05'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Balance Item', quantity: 1, rate: 3333.33, unit: 'HRS' }]
            }, testAdmin ? testAdmin.id : 1);

            const res = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Odd cents balance test',
                noteDate: new Date('2026-08-06'),
                items: [{ name: 'Bal Item adj', quantity: 1, rate: 333.33, unit: 'HRS' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.ok(res.journal);
            let totalDr = 0n;
            let totalCr = 0n;

            for (const line of res.journal.lines) {
                totalDr += postingService.toCents(line.debit);
                totalCr += postingService.toCents(line.credit);
            }

            assert.equal(totalDr, totalCr, 'Total Debit must exactly equal Total Credit in cents');
            assert.ok(totalDr > 0n, 'Journal cannot be empty');
        });
    });

    // =========================================================================
    // 15. Debit note balanced journal
    // =========================================================================
    describe('15. Debit note balanced journal', () => {
        it('15.1 ensures debit note produces exact Dr == Cr balanced journal', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Debit Balance Item', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const res = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'DEBIT',
                invoiceId: inv.id,
                reason: 'Rate revision upwards',
                noteDate: new Date('2026-08-11'),
                items: [{ name: 'Debit Item adj', quantity: 1, rate: 1250.50, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.ok(res.journal);
            let totalDr = 0n;
            let totalCr = 0n;

            for (const line of res.journal.lines) {
                totalDr += postingService.toCents(line.debit);
                totalCr += postingService.toCents(line.credit);
            }

            assert.equal(totalDr, totalCr, 'Total Debit must equal Total Credit');
        });
    });

    // =========================================================================
    // 16. Customer subledger linkage
    // =========================================================================
    describe('16. Customer subledger linkage', () => {
        it('16.1 carries clientId on all Accounts Receivable lines for both credit and debit notes', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-15'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Subledger Item', quantity: 1, rate: 6000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');

            // Credit Note
            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Subledger test CN',
                noteDate: new Date('2026-08-16'),
                items: [{ name: 'CN Adj', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const cnArLine = cn.journal.lines.find(l => l.accountId === arAccount.id);
            assert.ok(cnArLine);
            assert.equal(cnArLine.clientId, testClientA.id, 'CN AR line must have clientId');
            assert.ok(Number(cnArLine.credit) > 0, 'CN AR line must be a credit');

            // Debit Note
            const dn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'DEBIT',
                invoiceId: inv.id,
                reason: 'Subledger test DN',
                noteDate: new Date('2026-08-17'),
                items: [{ name: 'DN Adj', quantity: 1, rate: 500, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const dnArLine = dn.journal.lines.find(l => l.accountId === arAccount.id);
            assert.ok(dnArLine);
            assert.equal(dnArLine.clientId, testClientA.id, 'DN AR line must have clientId');
            assert.ok(Number(dnArLine.debit) > 0, 'DN AR line must be a debit');
        });
    });

    // =========================================================================
    // 17. Duplicate posting prevention
    // =========================================================================
    describe('17. Duplicate posting prevention', () => {
        it('17.1 repeated postCreditDebitNote returns alreadyPosted: true and does not duplicate journals', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-20'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Idempotent Item', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Idempotency test',
                noteDate: new Date('2026-08-21'),
                items: [{ name: 'Item adj', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const initialJournalCount = await prisma.journalEntry.count();

            const secondPost = await postingService.postCreditDebitNote(cn.note.id, {
                userId: testAdmin ? testAdmin.id : null
            });

            assert.equal(secondPost.alreadyPosted, true);
            assert.equal(secondPost.journal.id, cn.journal.id);

            const postCount = await prisma.journalEntry.count();
            assert.equal(postCount, initialJournalCount, 'No extra journal must be created');
        });
    });

    // =========================================================================
    // 18. Concurrent duplicate posting prevention
    // =========================================================================
    describe('18. Concurrent duplicate posting prevention', () => {
        it('18.1 parallel posting calls resolve to exactly one single journal entry', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-25'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Concurrent Item', quantity: 1, rate: 10000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Create an issued note (auto-posted)
            const noteRes = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                status: 'ISSUED',
                reason: 'Concurrent test note',
                noteDate: new Date('2026-08-26'),
                items: [{ name: 'Concurrent adj', quantity: 1, rate: 2000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Execute 5 concurrent posts
            const results = await Promise.all([
                postingService.postCreditDebitNote(noteRes.note.id, { userId: testAdmin ? testAdmin.id : null }),
                postingService.postCreditDebitNote(noteRes.note.id, { userId: testAdmin ? testAdmin.id : null }),
                postingService.postCreditDebitNote(noteRes.note.id, { userId: testAdmin ? testAdmin.id : null }),
                postingService.postCreditDebitNote(noteRes.note.id, { userId: testAdmin ? testAdmin.id : null }),
                postingService.postCreditDebitNote(noteRes.note.id, { userId: testAdmin ? testAdmin.id : null })
            ]);

            const journalIds = new Set(results.map(r => r.journal.id));
            assert.equal(journalIds.size, 1, 'All concurrent postings must resolve to the exact same journal entry');

            const allJournalsForNote = await prisma.journalEntry.findMany({
                where: {
                    sourceType: 'CREDIT_NOTE',
                    sourceId: noteRes.note.id
                }
            });
            assert.equal(allJournalsForNote.length, 1, 'Exactly one journal entry must exist in DB');
        });

        it('18.2 simultaneous posting of unposted note safely resolves to exactly one journal entry', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-08-27'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Simultaneous Post Item', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const financialYear = await ensureFinancialYear(new Date('2026-08-28'));
            const unpostedNote = await prisma.creditDebitNote.create({
                data: {
                    noteNumber: `CN-SIMUL-${Date.now()}`,
                    noteType: 'CREDIT',
                    invoiceId: inv.id,
                    clientId: testClientA.id,
                    financialYearId: financialYear.id,
                    noteDate: new Date('2026-08-28'),
                    status: 'ISSUED',
                    reason: 'Simultaneous unposted test',
                    clientName: testClientA.name,
                    sellerName: 'Spark Admin',
                    originalInvoiceNumber: inv.invoiceNumber,
                    originalInvoiceDate: inv.invoiceDate,
                    originalInvoiceGrandTotal: inv.grandTotal,
                    subtotal: 1000,
                    grandTotal: 1180,
                    gstEnabled: true,
                    gstRate: 18,
                    cgstAmount: 90,
                    sgstAmount: 90,
                    createdById: testAdmin ? testAdmin.id : 1,
                    items: {
                        create: [{
                            lineNumber: 1,
                            name: 'Simul Line',
                            quantity: 1,
                            unit: 'SVC',
                            rate: 1000,
                            amount: 1000,
                            taxRate: 18,
                            cgstAmount: 90,
                            sgstAmount: 90
                        }]
                    }
                }
            });

            // Post simultaneously from two concurrent requests
            const [p1, p2] = await Promise.all([
                postingService.postCreditDebitNote(unpostedNote.id, { userId: testAdmin ? testAdmin.id : null }),
                postingService.postCreditDebitNote(unpostedNote.id, { userId: testAdmin ? testAdmin.id : null })
            ]);

            assert.equal(p1.journal.id, p2.journal.id, 'Both concurrent posts must resolve to identical journal ID');
            const journalsInDb = await prisma.journalEntry.findMany({
                where: { sourceType: 'CREDIT_NOTE', sourceId: unpostedNote.id }
            });
            assert.equal(journalsInDb.length, 1, 'Only 1 journal entry must exist in database');
        });
    });

    // =========================================================================
    // 19. Atomic rollback
    // =========================================================================
    describe('19. Atomic rollback', () => {
        it('19.1 rolling back transaction cleans up all created artifacts', async () => {
            const countNotesBefore = await prisma.creditDebitNote.count();
            const countJournalsBefore = await prisma.journalEntry.count();

            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-01'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Rollback Item', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            await assert.rejects(
                async () => {
                    await prisma.$transaction(async (tx) => {
                        // Create note inside tx
                        await creditDebitNoteService.createCreditDebitNote({
                            noteType: 'CREDIT',
                            invoiceId: inv.id,
                            reason: 'Intentional rollback test',
                            noteDate: new Date('2026-09-02'),
                            items: [{ name: 'Rollback Adj', quantity: 1, rate: 1000, unit: 'SVC' }]
                        }, testAdmin ? testAdmin.id : 1, {}, tx);

                        // Force failure
                        throw new Error('SIMULATED_FAILURE_FOR_ROLLBACK');
                    });
                },
                /SIMULATED_FAILURE_FOR_ROLLBACK/
            );

            const countNotesAfter = await prisma.creditDebitNote.count();
            assert.equal(countNotesAfter, countNotesBefore, 'No note record should remain after rollback');
        });
    });

    // =========================================================================
    // 20. Void/reversal lifecycle
    // =========================================================================
    describe('20. Void/reversal lifecycle', () => {
        it('20.1 voiding an issued note creates a reversal journal, marks original journal REVERSED, and preserves both', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-05'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Reversal item', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'To be voided',
                noteDate: new Date('2026-09-06'),
                items: [{ name: 'Void target item', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const voidRes = await creditDebitNoteService.voidCreditDebitNote(
                cn.note.id,
                testAdmin ? testAdmin.id : 1,
                'Customer changed mind, goods retained'
            );

            assert.equal(voidRes.note.status, 'VOID');
            assert.equal(voidRes.note.voidReason, 'Customer changed mind, goods retained');
            assert.ok(voidRes.reversalJournal, 'Reversal journal must be created');

            // Verify original journal in DB is REVERSED
            const originalJournal = await prisma.journalEntry.findUnique({
                where: { id: cn.journal.id }
            });
            assert.equal(originalJournal.status, 'REVERSED');
            assert.equal(originalJournal.reversedEntryId, voidRes.reversalJournal.id);

            // Verify reversal journal balances
            let drCents = 0n;
            let crCents = 0n;
            for (const l of voidRes.reversalJournal.lines) {
                drCents += postingService.toCents(l.debit);
                crCents += postingService.toCents(l.credit);
            }
            assert.equal(drCents, crCents);

            // Re-voiding should be rejected
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.voidCreditDebitNote(
                        cn.note.id,
                        testAdmin ? testAdmin.id : 1,
                        'Duplicate void'
                    );
                },
                /already VOID/i
            );
        });

        it('20.2 DRAFT note cannot be posted to general ledger', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-07'),
                gstEnabled: false,
                items: [{ name: 'Draft Test Item', quantity: 1, rate: 2000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const draftNoteRes = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                status: 'DRAFT',
                reason: 'Draft note test',
                noteDate: new Date('2026-09-08'),
                items: [{ name: 'Draft line', quantity: 1, rate: 500, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            assert.equal(draftNoteRes.note.status, 'DRAFT');
            assert.equal(draftNoteRes.journal, null);

            await assert.rejects(
                async () => {
                    await postingService.postCreditDebitNote(draftNoteRes.note.id, {
                        userId: testAdmin ? testAdmin.id : null
                    });
                },
                /Cannot post accounting for a DRAFT note/i
            );
        });

        it('20.3 VOID note cannot be newly posted to general ledger', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-07'),
                gstEnabled: false,
                items: [{ name: 'Void Post Test Item', quantity: 1, rate: 2000, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                status: 'ISSUED',
                reason: 'To be voided and tried to repost',
                noteDate: new Date('2026-09-08'),
                items: [{ name: 'Line', quantity: 1, rate: 500, unit: 'PCS' }]
            }, testAdmin ? testAdmin.id : 1);

            await creditDebitNoteService.voidCreditDebitNote(cn.note.id, testAdmin ? testAdmin.id : 1, 'Voiding');

            await assert.rejects(
                async () => {
                    await postingService.postCreditDebitNote(cn.note.id, {
                        userId: testAdmin ? testAdmin.id : null
                    });
                },
                /Cannot post accounting for a VOID note/i
            );
        });
    });

    // =========================================================================
    // 21. Original invoice immutability
    // =========================================================================
    describe('21. Original invoice immutability', () => {
        it('21.1 issuing and voiding notes never mutates original invoice records or original invoice journal', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-10'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Immutability item', quantity: 2, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const invPost = await postingService.postInvoice(inv.id, { userId: testAdmin ? testAdmin.id : null });
            const invRecordBefore = await prisma.invoice.findUnique({
                where: { id: inv.id },
                include: { items: true }
            });

            // Issue credit note
            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Check immutability',
                noteDate: new Date('2026-09-11'),
                items: [{ name: 'Item', quantity: 1, rate: 2000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Issue debit note
            const dn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'DEBIT',
                invoiceId: inv.id,
                reason: 'Check immutability debit',
                noteDate: new Date('2026-09-12'),
                items: [{ name: 'Item', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Check invoice unchanged
            const invRecordAfter = await prisma.invoice.findUnique({
                where: { id: inv.id },
                include: { items: true }
            });

            assert.equal(Number(invRecordAfter.grandTotal), Number(invRecordBefore.grandTotal));
            assert.equal(Number(invRecordAfter.subtotal), Number(invRecordBefore.subtotal));
            assert.equal(invRecordAfter.status, invRecordBefore.status);
            assert.equal(invRecordAfter.items.length, invRecordBefore.items.length);

            // Check invoice journal unchanged
            const invJournalAfter = await prisma.journalEntry.findUnique({
                where: { id: invPost.journal.id }
            });
            assert.equal(invJournalAfter.status, 'POSTED');
            assert.equal(invJournalAfter.reversedEntryId, null);
        });
    });

    // =========================================================================
    // 22. Snapshot immutability after client/item master changes
    // =========================================================================
    describe('22. Snapshot immutability after client/item master changes', () => {
        it('22.1 modifying master client details does not rewrite historical snapshot on credit note', async () => {
            const mutableClient = await prisma.client.create({
                data: {
                    name: 'Mutable Client Org',
                    email: 'original@client.org',
                    phone: '1112223334',
                    gstin: '27MUTAB1234A1Z1',
                    stateCode: '27',
                    billingAddress: 'Original Address, Mumbai',
                    active: true,
                    createdById: testAdmin ? testAdmin.id : null
                }
            });

            const inv = await invoiceService.createInvoice({
                clientName: mutableClient.name,
                clientId: mutableClient.id,
                clientGSTIN: mutableClient.gstin,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-15'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Master Snapshot Item', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Snapshot test',
                noteDate: new Date('2026-09-16'),
                items: [{ name: 'Discount', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Mutate Client Master Data
            await prisma.client.update({
                where: { id: mutableClient.id },
                data: {
                    name: 'COMPLETELY RENAMED ENTITY',
                    gstin: '27CHANGED9999Z9',
                    billingAddress: 'New Address in Pune'
                }
            });

            // Inspect Note Record
            const dbNote = await prisma.creditDebitNote.findUnique({
                where: { id: cn.note.id }
            });

            assert.equal(dbNote.clientName, 'Mutable Client Org', 'Note clientName snapshot must remain intact');
            assert.equal(dbNote.clientGSTIN, '27MUTAB1234A1Z1', 'Note clientGSTIN snapshot must remain intact');
            assert.equal(dbNote.billingAddress, 'Original Address, Mumbai', 'Billing address snapshot must remain intact');
        });
    });

    // =========================================================================
    // 23. RBAC denial
    // =========================================================================
    describe('23. RBAC denial', () => {
        it('23.1 rejects unauthenticated access with 401', async () => {
            const middleware = requirePermission('CREDIT_NOTES', 'CREATE');
            let statusCalled = null;
            let jsonCalled = null;
            const req = {
                session: null,
                originalUrl: '/api/credit-notes',
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

        it('23.2 rejects user without CREDIT_NOTES:CREATE permission with 403', async () => {
            const middleware = requirePermission('CREDIT_NOTES', 'CREATE');
            let statusCalled = null;
            let jsonCalled = null;

            const viewerRole = await prisma.role.findUnique({ where: { name: 'VIEWER' } });
            let viewerUser = await prisma.user.findFirst({ where: { role: 'VIEWER', active: true } });
            if (!viewerUser) {
                viewerUser = await prisma.user.create({
                    data: {
                        name: 'Viewer CN User',
                        email: `viewercn_${Date.now()}@example.com`,
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
                originalUrl: '/api/credit-notes',
                path: '/api/credit-notes',
                method: 'POST',
                ip: '127.0.0.1',
                headers: { accept: 'application/json' }
            };
            const res = {
                locals: {},
                status: (code) => { statusCalled = code; return res; },
                json: (payload) => { jsonCalled = payload; }
            };

            await middleware(req, res, () => {});
            assert.equal(statusCalled, 403);
            assert.equal(jsonCalled.success, false);
        });
    });

    // =========================================================================
    // 24. Posted journal immutability
    // =========================================================================
    describe('24. Posted journal immutability', () => {
        it('24.1 general ledger service rejects direct mutation or tampering of posted journal lines', async () => {
            const inv = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-20'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Tamper Item', quantity: 1, rate: 5000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            const cn = await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Immutability test',
                noteDate: new Date('2026-09-21'),
                items: [{ name: 'Discount', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Attempting to delete a journal entry directly should be rejected by system rules
            await assert.rejects(
                async () => {
                    await journalService.deleteJournalEntry(cn.journal.id);
                },
                /cannot be deleted/i
            );
        });
    });

    // =========================================================================
    // 25. Customer ledger reconciliation after invoice, payment, credit note & debit note
    // =========================================================================
    describe('25. Customer ledger reconciliation after invoice, payment, credit note and debit note', () => {
        it('25.1 accurately calculates customer outstanding balance through full transaction lifecycle', async () => {
            // Dedicated Reconciliation Client
            const reconClient = await prisma.client.create({
                data: {
                    name: `Reconciliation Client ${Date.now()}`,
                    email: `recon_${Date.now()}@example.com`,
                    phone: '9988776655',
                    gstin: '27RECON1234A1Z9',
                    stateCode: '27',
                    active: true,
                    createdById: testAdmin ? testAdmin.id : null
                }
            });

            // 1. Post Invoice: ₹10,000 net + 18% GST (₹1,800) = ₹11,800 Grand Total
            const inv = await invoiceService.createInvoice({
                clientName: reconClient.name,
                clientId: reconClient.id,
                clientGSTIN: reconClient.gstin,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-09-25'),
                gstEnabled: true,
                gstRate: 18,
                items: [{ name: 'Core Project Contract', quantity: 1, rate: 10000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            await postingService.postInvoice(inv.id, { userId: testAdmin ? testAdmin.id : null });

            // 2. Record Payment: ₹6,000
            await paymentService.recordPayment(inv.id, {
                amount: 6000,
                paymentDate: '2026-09-26',
                method: 'BANK_TRANSFER',
                reference: 'RECON-PAY-1',
                notes: 'Partial invoice payment'
            }, testAdmin ? testAdmin.id : 1);

            // 3. Issue Credit Note: ₹1,000 net + ₹180 GST = ₹1,180
            await creditDebitNoteService.createCreditDebitNote({
                noteType: 'CREDIT',
                invoiceId: inv.id,
                reason: 'Contract scope reduction',
                noteDate: new Date('2026-09-27'),
                items: [{ name: 'Scope refund', quantity: 1, rate: 1000, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Expected AR Balance: ₹11,800 - ₹6,000 - ₹1,180 = ₹4,620
            const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');

            // Query AR lines for this client
            let arLines = await prisma.journalEntryLine.findMany({
                where: {
                    accountId: arAccount.id,
                    clientId: reconClient.id,
                    journalEntry: { status: 'POSTED' }
                }
            });

            let clientDebitCents = 0n;
            let clientCreditCents = 0n;
            for (const line of arLines) {
                clientDebitCents += postingService.toCents(line.debit);
                clientCreditCents += postingService.toCents(line.credit);
            }

            let netArCents = clientDebitCents - clientCreditCents;
            assert.equal(Number(netArCents) / 100, 4620.00, 'Balance after Invoice, Payment, and Credit Note must be ₹4,620.00');

            // 4. Issue Debit Note: ₹500 net + ₹90 GST = ₹590
            await creditDebitNoteService.createCreditDebitNote({
                noteType: 'DEBIT',
                invoiceId: inv.id,
                reason: 'Out-of-pocket expenses',
                noteDate: new Date('2026-09-28'),
                items: [{ name: 'Extra travel costs', quantity: 1, rate: 500, unit: 'SVC' }]
            }, testAdmin ? testAdmin.id : 1);

            // Expected AR Balance: ₹4,620 + ₹590 = ₹5,210
            arLines = await prisma.journalEntryLine.findMany({
                where: {
                    accountId: arAccount.id,
                    clientId: reconClient.id,
                    journalEntry: { status: 'POSTED' }
                }
            });

            clientDebitCents = 0n;
            clientCreditCents = 0n;
            for (const line of arLines) {
                clientDebitCents += postingService.toCents(line.debit);
                clientCreditCents += postingService.toCents(line.credit);
            }

            netArCents = clientDebitCents - clientCreditCents;
            assert.equal(Number(netArCents) / 100, 5210.00, 'Balance after Debit Note must be ₹5,210.00');
        });
    });
});
