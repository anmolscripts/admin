'use strict';

// Pending acceptance tests: TODO is intentional until the R11 schema proposal
// receives approval. A successful process exit is NOT acceptance of R11.
// No Prisma client, environment files, sockets or filesystem fixtures are used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { ValidationError, NotFoundError, ConflictError } = require('../app/services/errorTypes');

function loadReceiptService(prisma, numbering) {
    const filename = require.resolve('../app/services/goodsReceipt.service');
    const previous = require.cache[filename];
    const originalLoad = Module._load;
    delete require.cache[filename];
    Module._load = function (request, parent, ...rest) {
        if (parent?.filename === filename) {
            if (request === '../config/prisma') return prisma;
            if (request === 'node:crypto') return require('node:crypto');
            if (request === './numbering.service') return numbering;
            if (request === './activity.service') return { log: async () => {} };
            if (request === './business.service') return { assertUserBusinessAccess: async () => {} };
            if (request === './stockTransaction.service') return { withStockTransaction: async (businessId, callback) => prisma.$transaction(async tx => {
                await tx.$queryRawUnsafe('SELECT id FROM businesses WHERE id = ? FOR UPDATE', businessId);
                return callback(tx);
            }) };
            if (request === './errorTypes') return { ValidationError, NotFoundError, ConflictError };
            throw new Error(`Unapproved receipt-service dependency: ${request}`);
        }
        return originalLoad.call(this, request, parent, ...rest);
    };
    try {
        return require(filename);
    } finally {
        Module._load = originalLoad;
        if (previous) require.cache[filename] = previous;
        else delete require.cache[filename];
    }
}

test('R11: replaying one request key returns the original receipt without another write', async () => {
    const receipts = [];
    let sequence = 0;
    const tx = {
        $queryRawUnsafe:async()=>[],
        supplier:{findFirst:async()=>({id:3,name:'Mock supplier',businessId:2})},
        goodsReceipt: {
            findFirst: async ({ where }) => receipts.find(row => where.requestKey ? row.requestKey === where.requestKey : row.receiptNumber === where.receiptNumber) || null,
            create: async ({ data }) => {
                const row = { id: receipts.length + 1, ...data };
                receipts.push(row);
                return row;
            },
            findUnique: async ({ where }) => receipts.find(row => row.id === where.id)
        },
        goodsReceiptItem: { create: async () => ({}) }
    };
    const service = loadReceiptService({
        supplier: { findFirst: async () => ({ id: 3, name: 'Mock supplier', businessId: 2 }) },
        $transaction: async callback => callback(tx)
    }, { allocateNumber: async () => `MOCK-GRN-${++sequence}` });
    const request = {
        idempotencyKey: '9329aa71-a330-4e5a-aa44-c34ab161a882',
        supplierId: 3,
        receiptDate: '2026-10-19',
        items: [{ name: 'Rejected mock item', receivedQuantity: 1, acceptedQuantity: 0, rejectedQuantity: 1, unitCost: 2 }]
    };
    const first = await service.createGoodsReceipt(request, 7, 2);
    const replay = await service.createGoodsReceipt(request, 7, 2);
    assert.equal(receipts.length, 1, 'a retry must not create another receipt');
    assert.equal(replay.id, first.id);
});

test('R11: PO remaining quantity is never read before entering the write transaction', async () => {
    const outsideReads = [];
    const transactionBoundary = new Error('Mock stopped before any write');
    const service = loadReceiptService({
        purchaseOrder: { findFirst: async () => ({
            id: 4, businessId: 2, orderNumber: 'MOCK-PO', status: 'ACTIVE',
            supplierId: 3, supplierName: 'Mock supplier',
            items: [{ id: 5, quantity: 10, rate: 2, unit: 'PCS' }]
        }) },
        goodsReceiptItem: { findMany: async () => { outsideReads.push('remaining'); return []; } },
        $transaction: async () => { throw transactionBoundary; }
    }, {});
    await assert.rejects(service.createGoodsReceipt({
        purchaseOrderId: 4, receiptDate: '2026-10-19',
        items: [{ purchaseOrderItemId: 5, name: 'Mock item', receivedQuantity: 1 }]
    }, 7, 2), error => error === transactionBoundary);
    assert.deepEqual(outsideReads, [], 'all remaining-quantity reads must use the locked transaction');
});
