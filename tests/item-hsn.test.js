'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const prisma = require('../app/config/prisma');
const items = require('../app/services/item.service');
const businesses = require('../app/services/business.service');

after(() => prisma.$disconnect());
async function fixture() {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    return businesses.createBusiness({ code: `HSN_${crypto.randomUUID()}`, name: 'HSN regression', gstin: '27AABCA1234A1Z5', stateCode: '27' });
}
const create = (businessId, name, hsnSac) => items.createItem({ businessId, name, hsnSac });

test('HSN generation preserves unique supplied values and allocates sequentially within each business', async () => {
    const a = await fixture(), b = await fixture();
    assert.equal((await create(a.id, 'First')).hsnSac, '1000');
    assert.equal((await create(a.id, 'Reserved', '1001')).hsnSac, '1001');
    assert.equal((await create(a.id, 'Duplicate', '1000')).hsnSac, '1002');
    assert.equal((await create(a.id, 'Leading zero', '0012')).hsnSac, '0012');
    assert.equal((await create(b.id, 'Other business', '1000')).hsnSac, '1000');
    const changed = await items.updateItem((await create(a.id, 'Editable', '2300')).id, { hsnSac: '1000' });
    assert.equal(changed.hsnSac, '1003');
    assert.equal((await items.updateItem(changed.id, { hsnSac: '1003' })).hsnSac, '1003');
});

test('concurrent manual creates, imports and document saves cannot allocate duplicate HSN values', async () => {
    const b = await fixture();
    await Promise.all([
        ...Array.from({ length: 6 }, (_, i) => create(b.id, `Concurrent ${i}`, '1000')),
        items.importItemsFromCsv([{ name: 'Imported', action: 'CREATE', hsnSac: '1000' }], null, b.id),
        items.ensureItemsExistFromDocument([{ name: 'Document', hsnSac: '1000' }], null, prisma, b.id)
    ]);
    const saved = await prisma.item.findMany({ where: { businessId: b.id } });
    assert.equal(saved.length, 8);
    assert.deepEqual(saved.map(i => i.hsnSac).sort(), Array.from({ length: 8 }, (_, i) => String(1000 + i)));
    const imported = saved.find(i => i.name === 'Imported');
    await items.importItemsFromCsv([{ name: imported.name, existingId: imported.id, action: 'UPDATE', hsnSac: saved.find(i => i.id !== imported.id).hsnSac }], null, b.id);
    const updated = await prisma.item.findUnique({ where: { id: imported.id } });
    assert.equal(updated.hsnSac, '1008');
});

test('generated HSN grows to six digits and exhaustion rolls back item and numbering writes', async () => {
    const b = await fixture();
    await create(b.id, 'Initial');
    const where = { businessId_entityType_year_month: { businessId: b.id, entityType: 'ITEM_HSN', year: 0, month: 0 } };
    for (const [previous, expected] of [[9999, '10000'], [99999, '100000'], [999998, '999999']]) {
        await prisma.numberingSequence.update({ where, data: { currentNumber: previous } });
        assert.equal((await create(b.id, `Boundary ${expected}`)).hsnSac, expected);
    }
    const before = await prisma.numberingSequence.findMany({ where: { businessId: b.id } });
    await assert.rejects(create(b.id, 'Exhausted'), /HSN.*exhaust/i);
    assert.equal(await prisma.item.count({ where: { businessId: b.id, name: 'Exhausted' } }), 0);
    assert.deepEqual(await prisma.numberingSequence.findMany({ where: { businessId: b.id } }), before);
    assert.equal((await create(b.id, 'Unused supplied', '0001')).hsnSac, '0001');
});

test('database rejects duplicate HSN writes and document snapshots remain unchanged', async () => {
    const b = await fixture();
    await create(b.id, 'Reserved', '2300');
    await assert.rejects(prisma.item.create({ data: { businessId: b.id, name: 'Bypass', hsnSac: '2300' } }), { code: 'P2002' });
    const line = { name: 'Saved document item', hsnSac: '2300' };
    await items.ensureItemsExistFromDocument([line], null, prisma, b.id);
    assert.equal(line.hsnSac, '2300');
    const saved = await prisma.item.findFirstOrThrow({ where: { businessId: b.id, name: line.name } });
    assert.equal(saved.hsnSac, '1000');
    const before = await prisma.numberingSequence.findMany({ where: { businessId: b.id } });
    await items.ensureItemsExistFromDocument([line], null, prisma, b.id);
    assert.deepEqual(await prisma.numberingSequence.findMany({ where: { businessId: b.id } }), before);
    const editable = await create(b.id, 'Clearable', '2345');
    assert.equal((await items.updateItem(editable.id, { hsnSac: '' })).hsnSac, '1001');
});
