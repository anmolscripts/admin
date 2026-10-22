'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const prisma = require('../app/config/prisma');
const items = require('../app/services/item.service');
const transfer = require('../app/services/itemTransfer.service');
const desk = require('../app/services/recordDesk.service');

after(() => prisma.$disconnect());
async function fixture() {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    return require('../app/services/business.service').createBusiness({ code: `NAME_${crypto.randomUUID()}`, name: 'Long item names', gstin: '27AABCA1234A1Z5', stateCode: '27' });
}

test('CSV and Excel previews accept 500-character names and report the 501-character row accurately', async () => {
    const b = await fixture();
    const name = 'N'.repeat(500);
    for (const format of ['csv', 'xlsx']) {
        const book = new ExcelJS.Workbook();
        book.addWorksheet('Items').addRows([['name', 'rate'], [name, 12], ['X'.repeat(501), 12]]);
        const buffer = format === 'csv' ? await book.csv.writeBuffer() : await book.xlsx.writeBuffer();
        const rows = await transfer.readImport(buffer, `items.${format}`);
        const csvBook = new ExcelJS.Workbook();
        csvBook.addWorksheet('Items').addRows(rows);
        const result = await items.parseAndValidateItemCsv((await csvBook.csv.writeBuffer()).toString(), b.id);
        assert.equal(result.summary.validCount, 1);
        assert.equal(result.preview[0].name, name);
        assert.deepEqual(result.errors, [{ row: 3, error: 'Item name must not exceed 500 characters.' }]);
    }
});

test('create, import, import update and record editing persist full 500-character item names', async () => {
    const b = await fixture();
    const actor = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN', active: true } });
    const manual = await items.createItem({ businessId: b.id, name: 'A'.repeat(500) }, actor.id);
    assert.equal(manual.name.length, 500);
    assert.equal((await items.updateItem(manual.id, { name: 'B'.repeat(500) }, actor.id)).name, 'B'.repeat(500));
    for (const [action, name] of [['CREATE_ITEM', 'A'.repeat(500)], ['EDIT_ITEM', 'B'.repeat(500)]]) {
        const log = await prisma.userActivityLog.findFirstOrThrow({ where: { action, targetId: String(manual.id) } });
        assert.ok(log.targetReference.length <= 100);
        assert.equal(log.metadata.name, name);
    }
    const context = { businessId: b.id, userId: null, permissions: { hasPermission: () => true } };
    const inspected = await desk.inspect('item', manual.id, context);
    const edited = await desk.update('item', manual.id, { version: inspected.version, changes: { name: 'C'.repeat(500) } }, context);
    assert.equal(edited.data.name, 'C'.repeat(500));
    const name = 'D'.repeat(500);
    await items.importItemsFromCsv([{ action: 'CREATE', name }], null, b.id);
    const imported = await prisma.item.findFirstOrThrow({ where: { businessId: b.id, name } });
    await items.importItemsFromCsv([{ action: 'UPDATE', existingId: imported.id, name, description: 'Updated long item' }], null, b.id);
    assert.equal((await prisma.item.findUniqueOrThrow({ where: { id: imported.id } })).name, name);
    await assert.rejects(items.createItem({ businessId: b.id, name: 'X'.repeat(501) }), /500 characters/);
    await assert.rejects(items.updateItem(manual.id, { name: 'X'.repeat(501) }), /500 characters/);
    await assert.rejects(items.importItemsFromCsv([{ action: 'CREATE', name: 'X'.repeat(501) }], null, b.id));
    await assert.rejects(items.importItemsFromCsv([{ action: 'UPDATE', existingId: imported.id, name: 'X'.repeat(501) }], null, b.id));
    const latest = await desk.inspect('item', manual.id, context);
    await assert.rejects(desk.update('item', manual.id, { version: latest.version, changes: { name: 'X'.repeat(501) } }, context), /500 characters/);
    for (const suffix of ['1', '2']) await items.createItem({ businessId: b.id, name: 'E'.repeat(499) + suffix });
    await assert.rejects(items.createItem({ businessId: b.id, name: 'E'.repeat(499) + '1' }), /already exists/);
    assert.equal(await prisma.item.count({ where: { businessId: b.id } }), 4);
});

test('500-character names survive quotation/invoice storage and every linked line-item column is wide enough', async () => {
    const b = await fixture();
    const actor = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN', active: true } });
    const client = await prisma.client.create({ data: { businessId: b.id, name: 'Long name customer', stateCode: '27' } });
    const name = 'Long catalog description '.padEnd(500, 'Z');
    for (const documentType of ['QUOTATION', 'INVOICE']) {
        const doc = await require('../app/services/invoice.service').createDocument({ businessId: b.id, documentType, clientId: client.id, clientName: client.name, billingAddress: 'Test address', invoiceDate: new Date().toISOString(), gstEnabled: false, items: [{ name, quantity: 1, rate: 10, unit: 'PCS' }] }, actor.id);
        assert.equal(doc.items[0].name, name);
        assert.equal((await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId: doc.id } })).name, name);
    }
    assert.equal((await prisma.item.findFirstOrThrow({ where: { businessId: b.id, name } })).name, name);
    const tables = ['items', 'invoice_items', 'purchase_order_items', 'supplier_bill_items', 'credit_debit_note_items', 'goods_receipt_items'];
    const columns = await prisma.$queryRawUnsafe("SELECT TABLE_NAME, CHARACTER_MAXIMUM_LENGTH AS capacity FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'name'");
    for (const table of tables) assert.equal(Number(columns.find(c => c.TABLE_NAME === table)?.capacity), 500, table);
});
