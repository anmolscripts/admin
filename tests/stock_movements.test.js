'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const itemService = require('../app/services/item.service');
const stockService = require('../app/services/stockMovement.service');

test('Inventory Stock Movements & Valuation Test Suite', async (t) => {
    let testUser;
    let itemA;
    let itemB;

    await t.test('Setup test dependencies (User & Items)', async () => {
        testUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testUser) {
            testUser = await prisma.user.create({
                data: {
                    email: `stk_admin_${Date.now()}@example.com`,
                    name: 'Stock Test Admin',
                    passwordHash: 'dummyhash',
                    role: 'ADMIN'
                }
            });
        }

        itemA = await itemService.createItem({
            name: `Widget Alpha ${Date.now()}`,
            rate: 50.0,
            unit: 'PCS'
        }, testUser.id);

        itemB = await itemService.createItem({
            name: `Widget Beta ${Date.now()}`,
            rate: 120.0,
            unit: 'BOX'
        }, testUser.id);

        assert.ok(itemA.id);
        assert.ok(itemB.id);
    });

    await t.test('Initial stock summary should be 0', async () => {
        const summary = await stockService.getItemStockSummary(itemA.id);
        assert.equal(summary.currentStock, 0);
        assert.equal(summary.valuation, 0);
    });

    await t.test('Record opening stock and stock receipts', async () => {
        // Opening stock 10 units @ 40
        const m1 = await stockService.recordStockMovement({
            itemId: itemA.id,
            movementType: 'OPENING',
            quantity: 10,
            unitCost: 40.0,
            notes: 'Initial inventory'
        }, testUser.id);
        assert.ok(m1.id);
        assert.equal(Number(m1.quantity), 10);

        // Receipt 20 units @ 55
        const m2 = await stockService.recordStockMovement({
            itemId: itemA.id,
            movementType: 'RECEIPT',
            quantity: 20,
            unitCost: 55.0,
            referenceType: 'SUPPLIER_BILL',
            referenceId: 999
        }, testUser.id);
        assert.ok(m2.id);

        // Current stock = 10 + 20 = 30
        // Total cost = (10 * 40) + (20 * 55) = 400 + 1100 = 1500
        // Weighted average cost = 1500 / 30 = 50.00
        const summary = await stockService.getItemStockSummary(itemA.id);
        assert.equal(summary.currentStock, 30);
        assert.equal(summary.weightedAverageCost, 50.00);
        assert.equal(summary.valuation, 1500.00);
    });

    await t.test('Cannot issue more stock than available (negative stock prevention)', async () => {
        await assert.rejects(
            stockService.recordStockMovement({
                itemId: itemA.id,
                movementType: 'ISSUE',
                quantity: 35 // only 30 available
            }, testUser.id),
            /Insufficient stock/
        );
    });

    await t.test('Issue stock and verify valuation preservation', async () => {
        // Issue 10 units. Should inherit weighted average cost 50.00
        const m3 = await stockService.recordStockMovement({
            itemId: itemA.id,
            movementType: 'ISSUE',
            quantity: 10,
            referenceType: 'PRODUCTION_ORDER'
        }, testUser.id);

        assert.equal(Number(m3.quantity), -10);
        assert.equal(Number(m3.unitCost), 50.00);

        // Stock remaining = 20 units @ 50.00 = 1000.00
        const summary = await stockService.getItemStockSummary(itemA.id);
        assert.equal(summary.currentStock, 20);
        assert.equal(summary.valuation, 1000.00);
    });

    await t.test('Stock adjustment upwards and downwards', async () => {
        // Upward adjustment of +5 units @ 60
        await stockService.recordStockMovement({
            itemId: itemA.id,
            movementType: 'ADJUSTMENT',
            quantity: 5,
            unitCost: 60.0,
            notes: 'Physical count surplus'
        }, testUser.id);

        let summary = await stockService.getItemStockSummary(itemA.id);
        assert.equal(summary.currentStock, 25);

        // Downward adjustment of -3 units
        await stockService.recordStockMovement({
            itemId: itemA.id,
            movementType: 'ADJUSTMENT',
            quantity: -3,
            notes: 'Damaged in transit'
        }, testUser.id);

        summary = await stockService.getItemStockSummary(itemA.id);
        assert.equal(summary.currentStock, 22);
    });

    await t.test('Generate inventory valuation report across multiple items', async () => {
        // Add stock to itemB: 15 units @ 100.00
        await stockService.recordStockMovement({
            itemId: itemB.id,
            movementType: 'RECEIPT',
            quantity: 15,
            unitCost: 100.0
        }, testUser.id);

        const report = await stockService.getInventoryValuationReport();
        assert.ok(report.totalItemsCount >= 2);
        assert.ok(report.totalItemsInStock >= 2);
        assert.ok(report.grandTotalValuation > 0);

        const foundA = report.items.find(i => i.itemId === itemA.id);
        const foundB = report.items.find(i => i.itemId === itemB.id);
        assert.ok(foundA && foundA.currentStock === 22);
        assert.ok(foundB && foundB.currentStock === 15);
        assert.equal(foundB.valuation, 1500.00);
    });

    await prisma.$disconnect();
});
