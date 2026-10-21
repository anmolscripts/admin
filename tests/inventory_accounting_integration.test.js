'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const coaService = require('../app/services/chartOfAccounts.service');
const financialYearService = require('../app/services/financialYear.service');
const supplierService = require('../app/services/supplier.service');
const purchaseOrderService = require('../app/services/purchaseOrder.service');
const supplierBillService = require('../app/services/supplierBill.service');
const supplierPaymentService = require('../app/services/supplierPayment.service');
const stockService = require('../app/services/stockMovement.service');
const itemService = require('../app/services/item.service');
const reportService = require('../app/services/accounting/report.service');

test('TASK 3 — Inventory and Supplier-Bill Accounting Integration Suite', async (t) => {
    let testUser;
    let testSupplier;
    let testItem;
    let openFY;
    let initialInvAssetBal = 0;
    let initialCogsBal = 0;
    let initialApBal = 0;

    // Helper to get GL balance for an account key
    async function getGlBalance(systemAccountKey) {
        const account = await prisma.chartOfAccount.findFirst({
            where: { systemAccountKey, businessId: 1 }
        });
        if (!account) return 0;
        const rep = await reportService.getGeneralLedgerReport({
            accountId: account.id,
            financialYearId: openFY.id
        });
        return parseFloat(rep.account ? rep.account.closingBalance : 0) || 0;
    }

    await t.test('Setup dependencies: System Accounts, Financial Year, User, Supplier, Item', async () => {
        // Ensure standard system accounts including 1141 INVENTORY_ASSET
        await coaService.ensureSystemAccounts(null, 1);

        testUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testUser) {
            testUser = await prisma.user.create({
                data: {
                    email: `inv_admin_${Date.now()}@example.com`,
                    name: 'Inventory Audit Admin',
                    passwordHash: 'dummyhash',
                    role: 'ADMIN'
                }
            });
        }

        openFY = await financialYearService.ensureFinancialYear(new Date());

        // Create test supplier
        const timestamp = Date.now();
        testSupplier = await supplierService.createSupplier({
            name: `Apex Metals Ltd ${timestamp}`,
            email: `apex_${timestamp}@example.com`,
            gstin: '27AABCA1234A1Z5',
            stateCode: '27',
            paymentTerms: 'NET30'
        }, testUser.id);
        assert.ok(testSupplier.id);

        // Create test inventory item
        testItem = await itemService.createItem({
            name: `Raw Material Titanium Grade 5 ${timestamp}`,
            rate: 250.0,
            unit: 'KG'
        }, testUser.id);
        assert.ok(testItem.id);

        initialInvAssetBal = await getGlBalance('INVENTORY_ASSET');
        initialCogsBal = await getGlBalance('COGS');
        initialApBal = await getGlBalance('ACCOUNTS_PAYABLE');
    });

    let po;
    await t.test('1. Purchase Order Creation (Commitment Invariant)', async () => {
        // Invariant: PO creation must NOT post any double-entry journal entry or affect GL
        po = await purchaseOrderService.createPurchaseOrder({
            supplierId: testSupplier.id,
            orderDate: new Date(),
            items: [
                {
                    name: testItem.name,
                    quantity: 200,
                    rate: 250.0,
                    unit: 'KG'
                }
            ],
            termsAndConditions: 'Standard 30 days credit'
        }, testUser.id);

        assert.ok(po.id);
        assert.equal(po.status, 'ACTIVE');
        assert.equal(po.items.length, 1);
        assert.equal(Number(po.items[0].amount), 50000.0);

        // Verify zero GL journals created for PO
        const journals = await prisma.journalEntry.findMany({
            where: {
                sourceType: 'PURCHASE_ORDER',
                sourceId: po.id
            }
        });
        assert.equal(journals.length, 0, 'Purchase Order must not create GL entries');

        // Verify accounts remain unchanged
        const currentInvAsset = await getGlBalance('INVENTORY_ASSET');
        const currentAp = await getGlBalance('ACCOUNTS_PAYABLE');
        assert.equal(currentInvAsset, initialInvAssetBal);
        assert.equal(currentAp, initialApBal);
    });

    let inwardMovement;
    await t.test('2. Authorised Receipt / Inward Stock Movement', async () => {
        // Record receipt of 200 KG @ 250.00
        inwardMovement = await stockService.recordStockMovement({
            itemId: testItem.id,
            movementType: 'RECEIPT',
            quantity: 200,
            unitCost: 250.0,
            referenceType: 'PURCHASE_ORDER',
            referenceId: po.id,
            notes: `Received 200 KG against PO ${po.orderNumber}`
        }, testUser.id);

        assert.ok(inwardMovement.id);
        assert.equal(Number(inwardMovement.quantity), 200);

        // Verify Stock Summary & Valuation
        const summary = await stockService.getItemStockSummary(testItem.id);
        assert.equal(summary.currentStock, 200);
        assert.equal(summary.weightedAverageCost, 250.0);
        assert.equal(summary.valuation, 50000.0);
    });

    let bill;
    await t.test('3. Supplier Bill for Inventory: Debits Inventory Asset (1141), NOT COGS', async () => {
        const billNumber = `BILL-INV-${Date.now()}`;
        bill = await supplierBillService.createSupplierBill({
            billNumber,
            supplierId: testSupplier.id,
            billDate: new Date(),
            isInventory: true, // Flags acquisition as inventory asset
            gstRate: 18,
            items: [
                {
                    name: testItem.name,
                    quantity: 200,
                    rate: 250.0,
                    unit: 'KG'
                }
            ]
        }, testUser.id);

        assert.ok(bill.id);
        assert.equal(Number(bill.totalAmount), 59000.0); // 50000 + 18% (4500 CGST + 4500 SGST)

        // Verify Journal Entry
        const journal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_BILL:${bill.id}` },
            include: { lines: { include: { account: true } } }
        });
        assert.ok(journal, 'Journal entry for supplier bill must exist');
        assert.equal(journal.status, 'POSTED');

        // Check debit line debits INVENTORY_ASSET (1141)
        const invLine = journal.lines.find(l => l.account.systemAccountKey === 'INVENTORY_ASSET');
        assert.ok(invLine, 'Journal must contain INVENTORY_ASSET debit line');
        assert.equal(Number(invLine.debit), 50000.0);
        assert.equal(Number(invLine.credit), 0);

        // Check COGS was NOT debited
        const cogsLine = journal.lines.find(l => l.account.systemAccountKey === 'COGS');
        assert.equal(cogsLine, undefined, 'Inventory purchase must NOT debit COGS');

        // Check AP credit line
        const apLine = journal.lines.find(l => l.account.systemAccountKey === 'ACCOUNTS_PAYABLE');
        assert.ok(apLine, 'Journal must contain ACCOUNTS_PAYABLE credit line');
        assert.equal(Number(apLine.credit), 59000.0);

        // Check GST lines
        const cgstLine = journal.lines.find(l => l.account.systemAccountKey === 'INPUT_CGST');
        const sgstLine = journal.lines.find(l => l.account.systemAccountKey === 'INPUT_SGST');
        assert.equal(Number(cgstLine.debit), 4500.0);
        assert.equal(Number(sgstLine.debit), 4500.0);

        // RECONCILIATION CHECK:
        // GL Account 1141 balance must reconcile with Physical Valuation
        const invAssetBal = await getGlBalance('INVENTORY_ASSET');
        const summary = await stockService.getItemStockSummary(testItem.id);
        assert.equal(invAssetBal - initialInvAssetBal, summary.valuation,
            'GL Account 1141 (Inventory Asset) balance must match physical stock valuation');
    });

    await t.test('4. Operating Expense Bill Treatment vs Inventory Purchase', async () => {
        // Direct non-inventory expense bill (e.g., Office Supplies)
        const expBillNumber = `BILL-EXP-${Date.now()}`;
        const expBill = await supplierBillService.createSupplierBill({
            billNumber: expBillNumber,
            supplierId: testSupplier.id,
            billDate: new Date(),
            isInventory: false, // NOT inventory
            gstRate: 0,
            items: [
                {
                    name: 'Office Consumables',
                    quantity: 1,
                    rate: 4500.0,
                    unit: 'MONTH'
                }
            ]
        }, testUser.id);

        const expJournal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_BILL:${expBill.id}` },
            include: { lines: { include: { account: true } } }
        });

        // Verify operating expense debits COGS / Expense account, NOT Inventory Asset
        const invLine = expJournal.lines.find(l => l.account.systemAccountKey === 'INVENTORY_ASSET');
        assert.equal(invLine, undefined, 'Operating expense must NOT debit INVENTORY_ASSET');

        const expDebitLine = expJournal.lines.find(l => l.account.systemAccountKey === 'COGS');
        assert.ok(expDebitLine, 'Operating expense bill debits purchase/expense account');
        assert.equal(Number(expDebitLine.debit), 4500.0);
    });

    let payment;
    await t.test('5. Supplier Payment Allocation & AP Reconciliation', async () => {
        // Record payment of 59,000 against inventory bill
        payment = await supplierPaymentService.recordSupplierPayment({
            supplierId: testSupplier.id,
            supplierBillId: bill.id,
            amount: 59000.0,
            paymentDate: new Date(),
            method: 'BANK_TRANSFER',
            referenceNumber: 'IMPS-20261010-9988'
        }, testUser.id);

        assert.ok(payment.id);
        assert.equal(Number(payment.amount), 59000.0);

        // Verify journal entry: Dr ACCOUNTS_PAYABLE, Cr BANK_ACCOUNT
        const payJournal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_PAYMENT:${payment.id}` },
            include: { lines: { include: { account: true } } }
        });
        assert.ok(payJournal);
        const apDebit = payJournal.lines.find(l => l.account.systemAccountKey === 'ACCOUNTS_PAYABLE');
        const bankCredit = payJournal.lines.find(l => l.account.systemAccountKey === 'BANK_ACCOUNT');
        assert.equal(Number(apDebit.debit), 59000.0);
        assert.equal(Number(bankCredit.credit), 59000.0);

        // Overpayment / duplicate allocation protection
        await assert.rejects(
            supplierPaymentService.recordSupplierPayment({
                supplierId: testSupplier.id,
                supplierBillId: bill.id,
                amount: 100.0, // Bill already fully settled
                paymentDate: new Date(),
                method: 'BANK_TRANSFER'
            }, testUser.id),
            /exceeds supplier bill outstanding balance/
        );
    });

    let issueMovement;
    await t.test('6. Stock Issue / Consumption: Debits COGS (5110), Credits Inventory Asset (1141)', async () => {
        const preIssueInvBal = await getGlBalance('INVENTORY_ASSET');
        const preIssueCogsBal = await getGlBalance('COGS');

        // Issue 80 KG for production
        issueMovement = await stockService.recordStockMovement({
            itemId: testItem.id,
            movementType: 'ISSUE',
            quantity: 80,
            referenceType: 'PROJECT_DISBURSEMENT',
            referenceId: 101,
            postToLedger: true,
            notes: 'Issued 80 KG for Project Titanium'
        }, testUser.id);

        assert.ok(issueMovement.id);
        assert.equal(Number(issueMovement.quantity), -80);
        assert.equal(Number(issueMovement.unitCost), 250.0);
        assert.equal(Number(issueMovement.totalCost), 20000.0); // 80 * 250

        // Verify Stock Movement Journal Entry
        const moveJournal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `STOCK_MOVEMENT:${issueMovement.id}` },
            include: { lines: { include: { account: true } } }
        });
        assert.ok(moveJournal);
        assert.ok(moveJournal.lines.every(line => line.account.businessId === 1),
            'Stock journals must use accounts belonging to the movement business');
        const cogsLine = moveJournal.lines.find(l => l.account.systemAccountKey === 'COGS');
        const invLine = moveJournal.lines.find(l => l.account.systemAccountKey === 'INVENTORY_ASSET');
        assert.equal(Number(cogsLine.debit), 20000.0);
        assert.equal(Number(invLine.credit), 20000.0);

        // RECONCILIATION:
        // Remaining stock = 200 - 80 = 120 KG @ 250 = 30,000 valuation
        const summary = await stockService.getItemStockSummary(testItem.id);
        assert.equal(summary.currentStock, 120);
        assert.equal(summary.valuation, 30000.0);

        // GL Account 1141 must decrease by exactly 20,000
        const postIssueInvBal = await getGlBalance('INVENTORY_ASSET');
        assert.equal(Math.round((preIssueInvBal - postIssueInvBal) * 100) / 100, 20000.0);

        // COGS must increase by exactly 20,000
        const postIssueCogsBal = await getGlBalance('COGS');
        assert.equal(Math.round((postIssueCogsBal - preIssueCogsBal) * 100) / 100, 20000.0);

        // Exact equality: GL Asset balance matches QOH * WAC
        assert.equal(postIssueInvBal - initialInvAssetBal, summary.valuation,
            'GL Account 1141 balance must match QOH * WAC after stock issue');
    });

    await t.test('7. Weighted-Average Cost Re-calculation on Second Receipt and Subsequent Issue', async () => {
        // Second receipt: 80 KG @ 300.00 = 24,000 cost
        const m2 = await stockService.recordStockMovement({
            itemId: testItem.id,
            movementType: 'RECEIPT',
            quantity: 80,
            unitCost: 300.0,
            notes: 'Second batch at higher market price'
        }, testUser.id);
        assert.ok(m2.id);

        // Post supplier bill for second batch
        const bill2Number = `BILL-INV2-${Date.now()}`;
        const bill2 = await supplierBillService.createSupplierBill({
            billNumber: bill2Number,
            supplierId: testSupplier.id,
            billDate: new Date(),
            isInventory: true,
            gstRate: 0,
            items: [
                {
                    name: testItem.name,
                    quantity: 80,
                    rate: 300.0,
                    unit: 'KG'
                }
            ]
        }, testUser.id);
        assert.ok(bill2.id);

        // Before issue:
        // Stock = 120 + 80 = 200 KG
        // Total inward cost = (200 * 250) + (80 * 300) = 50000 + 24000 = 74000
        // Total inward qty = 200 + 80 = 280 KG
        // Weighted Average Cost = 74000 / 280 = 264.29 per KG
        // Current Valuation = 200 * 264.29 = 52858.00
        const sum2 = await stockService.getItemStockSummary(testItem.id);
        assert.equal(sum2.currentStock, 200);
        assert.equal(sum2.weightedAverageCost, 264.29);

        // Issue 50 KG using weighted average cost
        const m3 = await stockService.recordStockMovement({
            itemId: testItem.id,
            movementType: 'ISSUE',
            quantity: 50,
            postToLedger: true
        }, testUser.id);

        assert.equal(Number(m3.unitCost), 264.29);
        assert.equal(Number(m3.totalCost), 13214.50); // 50 * 264.29

        // Remaining stock = 200 - 50 = 150 KG
        const sum3 = await stockService.getItemStockSummary(testItem.id);
        assert.equal(sum3.currentStock, 150);
        assert.equal(sum3.valuation, Math.round(150 * 264.29 * 100) / 100);
    });

    await t.test('8. Error & Boundary Protections: Duplicates, Negative Stock, Closed FY & Void Reversals', async () => {
        // A. Prevent negative stock
        await assert.rejects(
            stockService.recordStockMovement({
                itemId: testItem.id,
                movementType: 'ISSUE',
                quantity: 9999 // Exceeds 150 KG on hand
            }, testUser.id),
            /Insufficient stock/
        );

        // B. Prevent duplicate bill posting
        await assert.rejects(
            supplierBillService.createSupplierBill({
                billNumber: bill.billNumber, // Already exists
                supplierId: testSupplier.id,
                items: [{ name: 'Test', quantity: 1, rate: 100, unit: 'PCS' }]
            }, testUser.id),
            /already exists/
        );

        // C. Prevent duplicate ledger posting of stock movement
        await assert.rejects(
            stockService.postStockMovementToLedger({
                movementId: issueMovement.id
            }, testUser.id),
            /has already been posted/
        );

        // D. Voiding bill performs clean ledger reversal
        const voidBillNumber = `BILL-VOID-${Date.now()}`;
        const tempBill = await supplierBillService.createSupplierBill({
            billNumber: voidBillNumber,
            supplierId: testSupplier.id,
            billDate: new Date(),
            isInventory: true,
            gstRate: 0,
            items: [{ name: 'Voidable Item', quantity: 10, rate: 100.0, unit: 'KG' }]
        }, testUser.id);

        const journalBeforeVoid = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_BILL:${tempBill.id}` }
        });
        assert.equal(journalBeforeVoid.status, 'POSTED');

        const voided = await supplierBillService.voidSupplierBill(tempBill.id, testUser.id, 'Test reversal');
        assert.equal(voided.status, 'VOID');

        // Check original journal is marked REVERSED
        const journalAfterVoid = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_BILL:${tempBill.id}` }
        });
        assert.equal(journalAfterVoid.status, 'REVERSED');

        // Check reversing journal entry was posted
        assert.ok(journalAfterVoid.reversedEntryId, 'Original journal must link to reversing entry ID');
        const reversingJournal = await prisma.journalEntry.findUnique({
            where: { id: journalAfterVoid.reversedEntryId }
        });
        assert.ok(reversingJournal, 'Reversing journal must exist');
        assert.equal(reversingJournal.status, 'POSTED');
    });

    await t.test('9. Timing Sequence Invariance: Bill posted BEFORE Stock Receipt (Reverse Sequence)', async () => {
        const itemSeq2 = await itemService.createItem({
            name: `Electronic Actuator Component ${Date.now()}`,
            rate: 400.0,
            unit: 'PCS'
        }, testUser.id);
        assert.ok(itemSeq2.id);

        const preBillInvBal = await getGlBalance('INVENTORY_ASSET');
        const preBillApBal = await getGlBalance('ACCOUNTS_PAYABLE');

        // STEP 1: Supplier Bill is posted FIRST (before goods arrive physically)
        const earlyBillNumber = `BILL-EARLY-${Date.now()}`;
        const earlyBill = await supplierBillService.createSupplierBill({
            billNumber: earlyBillNumber,
            supplierId: testSupplier.id,
            billDate: new Date(),
            isInventory: true,
            gstRate: 18,
            items: [
                {
                    name: itemSeq2.name,
                    quantity: 100,
                    rate: 400.0,
                    unit: 'PCS'
                }
            ]
        }, testUser.id);
        assert.ok(earlyBill.id);
        assert.equal(Number(earlyBill.totalAmount), 47200.0); // 40000 + 18% GST (3600 CGST + 3600 SGST)

        // Verify Journal Entry for early bill: Dr INVENTORY_ASSET 40k, Dr CGST 3.6k, Dr SGST 3.6k, Cr AP 47.2k
        const earlyJournal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_BILL:${earlyBill.id}` },
            include: { lines: { include: { account: true } } }
        });
        assert.ok(earlyJournal);
        const invAssetLine = earlyJournal.lines.find(l => l.account.systemAccountKey === 'INVENTORY_ASSET');
        const apLine = earlyJournal.lines.find(l => l.account.systemAccountKey === 'ACCOUNTS_PAYABLE');
        assert.equal(Number(invAssetLine.debit), 40000.0);
        assert.equal(Number(apLine.credit), 47200.0);

        // STEP 2: Settle Supplier Payment
        const earlyPayment = await supplierPaymentService.recordSupplierPayment({
            supplierId: testSupplier.id,
            supplierBillId: earlyBill.id,
            amount: 47200.0,
            paymentDate: new Date(),
            method: 'BANK_TRANSFER',
            referenceNumber: `NEFT-EARLY-${Date.now()}`
        }, testUser.id);
        assert.ok(earlyPayment.id);

        // STEP 3: Goods physically arrive afterwards (Receipt recorded)
        const laterReceipt = await stockService.recordStockMovement({
            itemId: itemSeq2.id,
            movementType: 'RECEIPT',
            quantity: 100,
            unitCost: 400.0,
            notes: `Physical receipt against earlier bill ${earlyBillNumber}`
        }, testUser.id);
        assert.ok(laterReceipt.id);

        // Verify stock summary & valuation matches GL asset balance
        const summarySeq2 = await stockService.getItemStockSummary(itemSeq2.id);
        assert.equal(summarySeq2.currentStock, 100);
        assert.equal(summarySeq2.weightedAverageCost, 400.0);
        assert.equal(summarySeq2.valuation, 40000.0);

        // STEP 4: Issue 40 PCS for manufacturing / project
        const preIssueCogs = await getGlBalance('COGS');
        const laterIssue = await stockService.recordStockMovement({
            itemId: itemSeq2.id,
            movementType: 'ISSUE',
            quantity: 40,
            postToLedger: true,
            notes: 'Issued 40 PCS for production run'
        }, testUser.id);
        assert.ok(laterIssue.id);
        assert.equal(Number(laterIssue.totalCost), 16000.0); // 40 * 400

        // Verify Issue Journal: Dr COGS 16k, Cr INVENTORY_ASSET 16k
        const issueJournal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `STOCK_MOVEMENT:${laterIssue.id}` },
            include: { lines: { include: { account: true } } }
        });
        const cogsLine = issueJournal.lines.find(l => l.account.systemAccountKey === 'COGS');
        const invCreditLine = issueJournal.lines.find(l => l.account.systemAccountKey === 'INVENTORY_ASSET');
        assert.equal(Number(cogsLine.debit), 16000.0);
        assert.equal(Number(invCreditLine.credit), 16000.0);

        // Verify Net Asset Balance matches remaining QOH * WAC (60 * 400 = 24,000)
        const postIssueInvBal = await getGlBalance('INVENTORY_ASSET');
        assert.equal(Math.round((postIssueInvBal - preBillInvBal) * 100) / 100, 24000.0);
        const postIssueSummary = await stockService.getItemStockSummary(itemSeq2.id);
        assert.equal(postIssueSummary.currentStock, 60);
        assert.equal(postIssueSummary.valuation, 24000.0);
    });

    await t.test('10. Server-Side Anti-Spoofing: Client flags cannot bypass Inventory Capitalization', async () => {
        // Attempt 1: Client explicitly sends isInventory: false for a tracked Item Master item
        const spoofBillNumber = `BILL-SPOOF-${Date.now()}`;
        await assert.rejects(
            supplierBillService.createSupplierBill({
                billNumber: spoofBillNumber,
                supplierId: testSupplier.id,
                billDate: new Date(),
                isInventory: false, // Malicious / erroneous client flag
                gstRate: 0,
                items: [
                    {
                        name: testItem.name, // Tracked inventory item in Item Master
                        quantity: 10,
                        rate: 250.0,
                        unit: 'KG'
                    }
                ]
            }, testUser.id),
            /Inventory acquisitions cannot be classified as direct expenses/
        );

        // Attempt 2: Client omits isInventory flag entirely for a tracked Item Master item
        // Server must automatically classify as INVENTORY_ASSET (1141)
        const autoClassifyBillNumber = `BILL-AUTOCLASS-${Date.now()}`;
        const autoBill = await supplierBillService.createSupplierBill({
            billNumber: autoClassifyBillNumber,
            supplierId: testSupplier.id,
            billDate: new Date(),
            // isInventory omitted
            gstRate: 0,
            items: [
                {
                    name: testItem.name, // Tracked inventory item
                    quantity: 10,
                    rate: 250.0,
                    unit: 'KG'
                }
            ]
        }, testUser.id);
        assert.ok(autoBill.id);

        const autoJournal = await prisma.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_BILL:${autoBill.id}` },
            include: { lines: { include: { account: true } } }
        });
        const invDebit = autoJournal.lines.find(l => l.account.systemAccountKey === 'INVENTORY_ASSET');
        const cogsDebit = autoJournal.lines.find(l => l.account.systemAccountKey === 'COGS');
        assert.ok(invDebit, 'Server must classify tracked item purchase to INVENTORY_ASSET even if flag omitted');
        assert.equal(Number(invDebit.debit), 2500.0);
        assert.equal(cogsDebit, undefined, 'Must not debit COGS for tracked inventory purchase');
    });

    await prisma.$disconnect();
});
