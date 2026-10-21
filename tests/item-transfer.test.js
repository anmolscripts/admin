'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const transfer = require('../app/services/itemTransfer.service');
const prisma = require('../app/config/prisma');
const service = require('../app/services/item.service');
const { context } = require('../app/config/creationTracking');
after(() => prisma.$disconnect());

test('every application model has the tracking columns and an auto-increment primary key', async () => {
    const keys = await prisma.$queryRawUnsafe("SELECT TABLE_NAME, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_KEY = 'PRI'");
    for (const model of require('@prisma/client').Prisma.dmmf.datamodel.models) {
        assert.ok(keys.some(key => key.TABLE_NAME === model.dbName && key.EXTRA.includes('auto_increment')), model.name);
        for (const name of ['CREATED_BY','CREATED_AT','IP_ADDRESS']) assert.ok(model.fields.some(field => field.name === name), `${model.name}.${name}`);
    }
});

test('CSV and XLSX preserve quoted multiline descriptions, leading-zero HSN and active status', async () => {
    const csv = 'name,description,unit,hsnSac,rate,gstRate,active,itemCode\n"Transfer, widget","Line one\nLine two",PCS,0012,15.50,18,false,TRANSFER-1';
    const result = await service.parseAndValidateItemCsv(csv);
    assert.equal(result.errors.length, 0);
    assert.equal(result.preview[0].name, 'Transfer, widget');
    assert.equal(result.preview[0].description, 'Line one\nLine two');
    assert.equal(result.preview[0].hsnSac, '0012');
    assert.equal(result.preview[0].active, false);
    assert.equal(result.preview[0].itemCode, 'TRANSFER-1');
    const book = await transfer.workbookFor([], {}, true);
    const rows = await transfer.readImport(await book.xlsx.writeBuffer(), 'items.xlsx');
    assert.deepEqual(rows[0], transfer.editable);
    assert.equal(rows[1][4], 100);
    book.worksheets[0].getCell('A2').value = { formula: '1+1' };
    await assert.rejects(transfer.readImport(await book.xlsx.writeBuffer(), 'bad.xlsx'), /plain cell/);
    const bad = await service.parseAndValidateItemCsv('name,rate,gstrate,active\nInfinity item,Infinity,18,true\nInvalid active,10,18,maybe');
    assert.equal(bad.errors.length, 2);
});

test('exports contain branding, all columns, safe CSV cells and the requested local date format', async () => {
    assert.equal(transfer.exportDate(new Date('2026-10-21T16:07:00Z')), '21-OCT-2026 | 09:37 PM');
    const brand = { companyName: 'Transfer & Co', timeZone: 'Asia/Kolkata', logoUrl: '/images/document-templates/rajesh-international-logo.png' };
    const items = [{ name: '=1+1', description: '<script>alert(1)</script>', unit: 'PCS', rate: new (require('@prisma/client').Prisma.Decimal)('12.50'), gstRate: 18, active: false, id: 1, CREATED_BY: 7, CREATED_AT: new Date('2026-10-21T00:00:00Z'), IP_ADDRESS: '127.0.0.1' }];
    const book = await transfer.workbookFor(items, brand);
    const copy = new ExcelJS.Workbook();
    await copy.xlsx.load(await book.xlsx.writeBuffer());
    assert.equal(copy.worksheets[0].getCell('A1').value, brand.companyName);
    assert.equal(copy.worksheets[0].getCell('A3').value, "'=1+1");
    assert.equal(copy.worksheets[0].getCell('E3').value, 12.5);
    assert.equal(copy.worksheets[0].getImages().length, 1);
    const rows = await transfer.readImport(await book.csv.writeBuffer());
    assert.deepEqual(rows[0], transfer.columns);
    assert.equal(rows[1][4], '12.5');
    const html = transfer.printHtml(items, brand);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('Brand logo'));
    assert.ok(!html.includes('<script>alert'));
    const pdf = await transfer.pdf(items, brand);
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});

test('creation tracking covers nested writes and transactions; updates retain original metadata', async () => {
    const business = await context.run({ session: { user: { id: 7 } }, ip: '127.0.0.17' }, () => prisma.$transaction(tx => tx.business.create({ data: {
        code: `TRANSFER-${Date.now()}`, name: 'Transfer audit', CREATED_BY: 999, IP_ADDRESS: 'forged',
        units: { create: { name: 'Transfer unit', symbol: 'TU', CREATED_BY: 999 } }
    }, include: { units: true } })));
    try {
        assert.equal(business.CREATED_BY, 7);
        assert.equal(business.IP_ADDRESS, '127.0.0.17');
        assert.equal(business.units[0].CREATED_BY, 7);
        assert.equal(business.units[0].IP_ADDRESS, '127.0.0.17');
        assert.ok(business.CREATED_AT instanceof Date);
        const changed = await context.run({ session: { user: { id: 8 } }, ip: '127.0.0.18' }, () => prisma.business.update({ where: { id: business.id }, data: { name: 'Changed', CREATED_BY: 999, CREATED_AT: new Date(0), IP_ADDRESS: 'forged' } }));
        assert.equal(changed.CREATED_BY, 7);
        assert.equal(changed.IP_ADDRESS, business.IP_ADDRESS);
        assert.equal(changed.CREATED_AT.toISOString(), business.CREATED_AT.toISOString());
        await context.run({ session: { user: { id: 7 } }, ip: '127.0.0.17' }, () => service.importItemsFromCsv([{ name: 'Transfer import', description: 'All data', unit: 'TU', rate: 12, gstRate: 18, hsnSac: '0012', active: false, itemCode: 'TRANSFER-1', action: 'CREATE' }], null, business.id));
        const item = await prisma.item.findFirst({ where: { businessId: business.id } });
        assert.equal(item.active, false);
        assert.equal(item.hsnSac, '0012');
        assert.equal(item.CREATED_BY, 7);
        assert.equal(item.IP_ADDRESS, '127.0.0.17');
        const details = await require('../app/services/recordDesk.service').inspect('item', item.id, { businessId: business.id, permissions: { hasPermission: () => true } });
        assert.equal(details.data.CREATED_BY, 7);
        assert.equal(details.data.IP_ADDRESS, '127.0.0.17');
        assert.ok(!details.editableFields.includes('CREATED_BY'));
        await service.importItemsFromCsv([{ name: item.name, existingId: item.id, action: 'UPDATE', rate: 23, gstRate: 5, unit: 'TU', active: true }], null, business.id);
        const updated = await prisma.item.findUnique({ where: { id: item.id } });
        assert.equal(updated.active, true);
        assert.equal(Number(updated.rate), 23);
        assert.equal(updated.CREATED_BY, 7);
    } finally { await prisma.userActivityLog.deleteMany({ where: { businessId: business.id } }); await prisma.business.delete({ where: { id: business.id } }); }
});
