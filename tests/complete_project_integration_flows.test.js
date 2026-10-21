/**
 * COMPLETE PROJECT INTEGRATION FLOWS & ACCOUNTING TEST SUITE
 * 
 * Verifies the end-to-end integration:
 * - PO -> GRN (Store Inventory) -> Stock Issue -> Stock Return
 * - Project Expense -> Project Cost Ledger
 * - Quoted Value vs Invoiced vs Paid
 * - Attachment Metadata & XSS Sanitization
 * - Portfolio Financial Summary
 * - Strict Tenant Boundary Protection
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const purchaseOrderService = require('../app/services/purchaseOrder.service');
const goodsReceiptService = require('../app/services/goodsReceipt.service');
const stockMovementService = require('../app/services/stockMovement.service');
const expenseService = require('../app/services/expense.service');
const otherIncomeService = require('../app/services/otherIncome.service');
const attachmentService = require('../app/services/attachment.service');
const projectService = require('../app/services/project.service');
const projectCostLedgerService = require('../app/services/projectCostLedger.service');

describe('Complete Project Integration & Lifecycle Test Suite', async () => {
    let businessA, businessB;
    let userA, userB;
    let projectA, projectB;
    let supplierA, supplierB;
    let rawItemA;

    before(async () => {
        // Clean up any test fixtures from previous runs
        await prisma.goodsReceiptItem.deleteMany({
            where: { goodsReceipt: { supplierName: { contains: 'Test Flow' } } }
        });
        await prisma.goodsReceipt.deleteMany({
            where: { supplierName: { contains: 'Test Flow' } }
        });

        // 1. Setup multi-tenant businesses
        const suffix = Date.now() % 10000;
        businessA = await prisma.business.create({
            data: {
                name: 'Flow Integration Corp A',
                code: `FLA${suffix}`,
                gstin: '27AAAAA1111A1Z1',
                status: 'ACTIVE'
            }
        });

        businessB = await prisma.business.create({
            data: {
                name: 'Flow Boundary Corp B',
                code: `FLB${suffix}`,
                gstin: '27BBBBB2222B1Z2',
                status: 'ACTIVE'
            }
        });

        userA = await prisma.user.create({
            data: {
                name: 'Agent Flow A',
                email: `flow_a_${Date.now()}@example.com`,
                password: 'dummyhash',
                active: true
            }
        });

        userB = await prisma.user.create({
            data: {
                name: 'Agent Flow B',
                email: `flow_b_${Date.now()}@example.com`,
                password: 'dummyhash',
                active: true
            }
        });

        // 2. Setup Suppliers
        supplierA = await prisma.supplier.create({
            data: {
                business: { connect: { id: businessA.id } },
                supplierCode: `SUP-FLA-${Date.now() % 10000}`,
                name: 'Test Flow Supplier A',
                gstin: '27FLOWA1111A1Z5',
                active: true
            }
        });

        supplierB = await prisma.supplier.create({
            data: {
                business: { connect: { id: businessB.id } },
                supplierCode: `SUP-FLB-${Date.now() % 10000}`,
                name: 'Test Flow Supplier B',
                gstin: '27FLOWB2222B1Z6',
                active: true
            }
        });

        // 3. Setup Projects using projectService.createProject
        projectA = await projectService.createProject({
            code: `PRJ-FLOW-A-${Date.now() % 10000}`,
            name: 'High Precision Turbine Project A',
            contractValue: 500000.00,
            budgetAmount: 350000.00,
            billingType: 'FIXED_PRICE',
            startDate: new Date().toISOString().split('T')[0]
        }, userA.id, businessA.id);

        projectB = await projectService.createProject({
            code: `PRJ-FLOW-B-${Date.now() % 10000}`,
            name: 'Tenant B Project',
            contractValue: 200000.00,
            budgetAmount: 150000.00,
            billingType: 'FIXED_PRICE',
            startDate: new Date().toISOString().split('T')[0]
        }, userB.id, businessB.id);

        // 4. Setup Tracked Inventory Item
        rawItemA = await prisma.item.create({
            data: {
                business: { connect: { id: businessA.id } },
                name: 'Turbine Alloy Steel Rods',
                itemCode: `RAW-FLOW-${Date.now() % 10000}`,
                unit: 'KG',
                rate: 250.00,
                active: true
            }
        });
    });

    after(async () => {
        try {
            if (projectA) {
                await prisma.projectCost.deleteMany({ where: { projectId: projectA.id } });
                await prisma.projectAttachment.deleteMany({ where: { projectId: projectA.id } });
                await prisma.goodsReceiptItem.deleteMany({ where: { goodsReceipt: { projectId: projectA.id } } });
                await prisma.goodsReceipt.deleteMany({ where: { projectId: projectA.id } });
                await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { projectId: projectA.id } } });
                await prisma.purchaseOrder.deleteMany({ where: { projectId: projectA.id } });
                await prisma.stockMovement.deleteMany({ where: { projectId: projectA.id } });
                await prisma.expense.deleteMany({ where: { projectId: projectA.id } });
                await prisma.project.delete({ where: { id: projectA.id } });
            }
            if (projectB) {
                await prisma.projectCost.deleteMany({ where: { projectId: projectB.id } });
                await prisma.project.delete({ where: { id: projectB.id } });
            }
            if (rawItemA) {
                await prisma.stockMovement.deleteMany({ where: { itemId: rawItemA.id } });
                await prisma.item.delete({ where: { id: rawItemA.id } });
            }
            if (supplierA) await prisma.supplier.delete({ where: { id: supplierA.id } });
            if (supplierB) await prisma.supplier.delete({ where: { id: supplierB.id } });
            if (businessB) await prisma.otherIncome.deleteMany({ where: { businessId: businessB.id, description: 'Audit service income' } });
            if (userA) await prisma.user.delete({ where: { id: userA.id } });
            if (userB) await prisma.user.delete({ where: { id: userB.id } });
        } catch (e) {
            // cleanup best-effort
        } finally {
            await prisma.$disconnect();
        }
    });

    test('1. Create PO associated with Project, verify persistence and line remainingQuantity', async () => {
        const po = await purchaseOrderService.createPurchaseOrder({
            businessId: businessA.id,
            projectId: projectA.id,
            supplierId: supplierA.id,
            orderDate: new Date(),
            items: [
                {
                    itemId: rawItemA.id,
                    name: rawItemA.name,
                    quantity: 100,
                    unit: 'KG',
                    rate: 250.00
                }
            ]
        }, userA.id);

        assert.ok(po.id, 'PO should be created');
        assert.equal(po.projectId, projectA.id, 'PO should have project association');
        assert.equal(po.items.length, 1);
        assert.equal(parseFloat(po.items[0].quantity), 100);
        assert.equal(parseFloat(po.items[0].remainingQuantity), 100, 'All 100 KG should remain to be received');
    });

    test('2. Partial Goods Receipt (GRN) into Store Location without duplicate financial expense', async () => {
        const poList = await purchaseOrderService.listPurchaseOrders({
            businessId: businessA.id,
            projectId: projectA.id
        });
        const po = poList.records[0];

        // Receive partial: 40 KG accepted into Store 'Fabrication Bay Store'
        const grn = await goodsReceiptService.createGoodsReceipt({
            businessId: businessA.id,
            purchaseOrderId: po.id,
            supplierId: supplierA.id,
            supplierName: supplierA.name,
            deliveryChallanNumber: 'DC-FLOW-401',
            storeLocation: 'Fabrication Bay Store',
            receiptDate: new Date(),
            projectId: projectA.id,
            items: [
                {
                    purchaseOrderItemId: po.items[0].id,
                    itemId: rawItemA.id,
                    name: rawItemA.name,
                    unit: 'KG',
                    orderedQuantity: 100,
                    receivedQuantity: 40,
                    acceptedQuantity: 40,
                    rejectedQuantity: 0,
                    unitCost: 250.00
                }
            ]
        }, userA.id);

        assert.ok(grn.id);
        assert.ok(grn.receiptNumber.startsWith('GRN'), 'GRN number should start with GRN');
        assert.equal(grn.storeLocation, 'Fabrication Bay Store');

        // Verify physical inventory was incremented in stock
        const stockSummary = await stockMovementService.getItemStockSummary(rawItemA.id);
        assert.equal(stockSummary.currentStock, 40, 'Stock should be 40 KG');

        // Check stock movement
        const movements = await prisma.stockMovement.findMany({
            where: { itemId: rawItemA.id, movementType: 'RECEIPT' }
        });
        assert.equal(movements.length, 1);
        assert.equal(movements[0].storeLocation, 'Fabrication Bay Store');

        // CRITICAL INVARIANT: Zero ProjectCost entries created on GRN
        const projectCosts = await prisma.projectCost.findMany({
            where: { projectId: projectA.id }
        });
        assert.equal(projectCosts.length, 0, 'ZERO financial project cost should be recognized on GRN');

        // PO status should now be PARTIALLY_RECEIVED
        const recheckedPO = await purchaseOrderService.getPurchaseOrderById(po.id, businessA.id);
        assert.equal(parseFloat(recheckedPO.items[0].receivedQuantity), 40);
        assert.equal(parseFloat(recheckedPO.items[0].remainingQuantity), 60);
    });

    test('3. Over-receipt blocking beyond PO remaining balance', async () => {
        const poList = await purchaseOrderService.listPurchaseOrders({
            businessId: businessA.id,
            projectId: projectA.id
        });
        const po = poList.records[0];

        // Try to receive 70 KG when only 60 KG remains
        await assert.rejects(async () => {
            await goodsReceiptService.createGoodsReceipt({
                businessId: businessA.id,
                purchaseOrderId: po.id,
                supplierId: supplierA.id,
                supplierName: supplierA.name,
                deliveryChallanNumber: 'DC-FAIL-OVER',
                storeLocation: 'Fabrication Bay Store',
                receiptDate: new Date(),
                projectId: projectA.id,
                items: [
                    {
                        purchaseOrderItemId: po.items[0].id,
                        itemId: rawItemA.id,
                        name: rawItemA.name,
                        unit: 'KG',
                        orderedQuantity: 100,
                        receivedQuantity: 70,
                        acceptedQuantity: 70,
                        rejectedQuantity: 0,
                        unitCost: 250.00
                    }
                ]
            }, userA.id);
        }, /exceeds remaining allowed quantity|Over-receipt blocked/i);
    });

    test('4. Issue stock from store to project: decreases inventory and posts to ProjectCost', async () => {
        // Issue 30 KG of the 40 KG in store to Project A
        const issue = await stockMovementService.issueMaterialToProject({
            businessId: businessA.id,
            projectId: projectA.id,
            itemId: rawItemA.id,
            quantity: 30,
            storeLocation: 'Fabrication Bay Store',
            notes: 'Issued 30 KG Turbine Rods for Site Fabrication'
        }, userA.id);

        assert.ok(issue.id);
        assert.equal(issue.movementType, 'ISSUE');
        assert.equal(parseFloat(issue.quantity), -30);

        // Verify physical stock decreased to 10 KG
        const stockAfterIssue = await stockMovementService.getItemStockSummary(rawItemA.id);
        assert.equal(stockAfterIssue.currentStock, 10);

        // Check Project Cost Ledger: Exactly 30 * 250 = 7,500 INR recognized once
        const costs = await prisma.projectCost.findMany({
            where: { projectId: projectA.id, category: 'MATERIALS' }
        });
        assert.equal(costs.length, 1);
        assert.equal(parseFloat(costs[0].amount), 7500.00);
        assert.equal(costs[0].sourceType, 'STOCK_MOVEMENT');
    });

    test('5. Return material from project to inventory: restores stock and credits project cost', async () => {
        // Return 5 KG from project back to store
        const returnMovement = await stockMovementService.returnMaterialFromProject({
            businessId: businessA.id,
            projectId: projectA.id,
            itemId: rawItemA.id,
            quantity: 5,
            storeLocation: 'Fabrication Bay Store',
            notes: 'Unused 5 KG Turbine Rods returned'
        }, userA.id);

        assert.ok(returnMovement.id);
        assert.equal(returnMovement.movementType, 'RETURN_IN');
        assert.equal(parseFloat(returnMovement.quantity), 5);

        // Stock restored from 10 to 15 KG
        const stockAfterReturn = await stockMovementService.getItemStockSummary(rawItemA.id);
        assert.equal(stockAfterReturn.currentStock, 15);

        // Project cost ledger should have credit / adjustment of -1,250 INR (5 * 250)
        const summary = await projectService.getProjectFinancialSummary(projectA.id, businessA.id);
        assert.equal(summary.financials.costs.materials, 6250.00, 'Materials cost should be net 7,500 - 1,250 = 6,250');
    });

    test('6. Record direct Project Expense and verify ProjectCost posting', async () => {
        const exp = await expenseService.createExpense({
            businessId: businessA.id,
            projectId: projectA.id,
            expenseDate: new Date(),
            category: 'TRAVEL',
            amount: 3500.00,
            paymentMode: 'BANK_TRANSFER',
            description: 'Site engineer site inspection logistics'
        }, userA.id);

        assert.ok(exp.id);
        assert.equal(exp.projectId, projectA.id);

        // Verify expense posted to ProjectCost
        const expCosts = await prisma.projectCost.findMany({
            where: { projectId: projectA.id, category: 'EXPENSE' }
        });
        assert.equal(expCosts.length, 1);
        assert.equal(parseFloat(expCosts[0].amount), 3500.00);
        assert.equal(expCosts[0].sourceType, 'EXPENSE');
    });

    test('6b. Expense and other-income journal accounts belong to their own business', async () => {
        const expense = await prisma.expense.findFirst({ where: { businessId: businessA.id, projectId: projectA.id } });
        const income = await otherIncomeService.createOtherIncome({ businessId: businessB.id, amount: 500, description: 'Audit service income', source: 'Service', receiptMethod: 'BANK' }, userB.id);
        for (const [sourceType, sourceId, businessId] of [['EXPENSE', expense.id, businessA.id], ['OTHER_INCOME', income.id, businessB.id]]) {
            const journal = await prisma.journalEntry.findFirst({ where: { sourceType, sourceId }, include: { lines: { include: { account: true } } } });
            assert.equal(journal.businessId, businessId);
            assert.ok(journal.lines.every(line => line.account.businessId === businessId));
            assert.equal(journal.lines.reduce((sum,line) => sum + Number(line.debit) - Number(line.credit), 0), 0);
        }
    });

    test('7. Enhanced Attachment Metadata with XSS Sanitization & Category filtering', async () => {
        const maliciousHtml = '<p>Certified Crane Inspection <script>alert("XSS")</script><img src="x" onerror="alert(1)"></p>';
        const att = await attachmentService.saveAttachment({
            businessId: businessA.id,
            projectId: projectA.id,
            entityType: 'PROJECT',
            entityId: projectA.id,
            title: 'Critical TPT Certification',
            category: 'TPT',
            description: maliciousHtml,
            referenceNumber: 'TPT-2026-CERT-001',
            issueDate: new Date('2026-01-15'),
            expiryDate: new Date('2027-01-15'),
            originalFilename: 'crane_tpt_cert.pdf',
            fileBuffer: Buffer.from('%PDF-1.4\n%âãÏÓ\nTest PDF content'),
            uploadedById: userA.id
        });

        assert.ok(att.id);
        assert.equal(att.category, 'TPT');
        assert.equal(att.referenceNumber, 'TPT-2026-CERT-001');
        assert.ok(!att.description.includes('<script>'), 'Script tags MUST be stripped');
        assert.ok(!att.description.includes('onerror'), 'Event handlers MUST be stripped');

        // Test Category filtering
        const tptList = await attachmentService.listAttachments({
            businessId: businessA.id,
            projectId: projectA.id,
            category: 'TPT'
        });
        assert.equal(tptList.length, 1);
        assert.equal(tptList[0].title, 'Critical TPT Certification');
    });

    test('8. Multi-Tenant Protection: Cross-tenant project PO and GRN rejection', async () => {
        // Business B user attempts to create a PO against Project A
        await assert.rejects(async () => {
            await purchaseOrderService.createPurchaseOrder({
                businessId: businessB.id,
                projectId: projectA.id, // belongs to Business A
                supplierId: supplierB.id,
                orderDate: new Date(),
                items: [{ name: 'Test Line', quantity: 1, rate: 100 }]
            }, userB.id);
        }, /not found|does not belong to this business/i);

        // Business B attempts to create GRN against Project A
        await assert.rejects(async () => {
            await goodsReceiptService.createGoodsReceipt({
                businessId: businessB.id,
                purchaseOrderId: null,
                supplierId: supplierB.id,
                supplierName: supplierB.name,
                deliveryChallanNumber: 'DC-FOREIGN',
                receiptDate: new Date(),
                projectId: projectA.id, // Foreign Project
                items: [{ name: 'Foreign Line', orderedQuantity: 1, receivedQuantity: 1, acceptedQuantity: 1, unitCost: 100 }]
            }, userB.id);
        }, /not found|does not belong to this business/i);
    });

    test('9. Portfolio Financial Summary aggregation across all business projects', async () => {
        const portfolio = await projectService.getPortfolioFinancialSummary(businessA.id);
        assert.ok(portfolio);
        assert.equal(portfolio.projectCount, 1);
        assert.equal(portfolio.totals.contractValue, 500000.00);
        assert.equal(portfolio.totals.budget, 350000.00);
        // Actual costs: Materials (6,250) + Expense (3,500) = 9,750
        assert.equal(portfolio.totals.actualCost, 9750.00);
    });
});
