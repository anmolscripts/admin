'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const prisma = require('../app/config/prisma');
const items = require('../app/services/item.service');

after(() => prisma.$disconnect());

test('restored Item Master leaves missing HSN blank and preserves shared supplied HSN values', async () => {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const business = await require('../app/services/business.service').createBusiness({ code: `HSN_UNDO_${crypto.randomUUID()}`, name: 'Original HSN behaviour', gstin: '27AABCA1234A1Z5', stateCode: '27' });
    const create = (name, hsnSac) => items.createItem({ businessId: business.id, name, hsnSac });
    assert.equal((await create('Blank HSN')).hsnSac, null);
    assert.equal((await create('First shared HSN', '7304')).hsnSac, '7304');
    assert.equal((await create('Second shared HSN', '7304')).hsnSac, '7304');
    assert.equal(await prisma.item.count({ where: { businessId: business.id, hsnSac: '7304' } }), 2);
    assert.equal(await prisma.numberingSequence.count({ where: { businessId: business.id, entityType: 'ITEM_HSN' } }), 0);
});
