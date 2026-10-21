'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const journal = require('../app/services/journal.service');
const reporting = require('../app/services/accounting/report.service');
const stock = require('../app/services/stockMovement.service');
after(() => prisma.$disconnect());

test('journal cents retain negative signs and match reporting at decimal precision boundaries', () => {
    for (const [input, cents] of [
        ['-0.50', -50n], ['-0.01', -1n], ['0.50', 50n], ['0.01', 1n], ['0', 0n], ['-0.00', 0n],
        ['-1.99', -199n], ['1.99', 199n], ['-0.009', 0n], ['0.009', 0n], ['-1.999', -199n],
        ['1.999', 199n], ['9999999999.99', 999999999999n], ['-9999999999.99', -999999999999n],
        [-0.5, -50n], [0, 0n], ['', 0n], [null, 0n], [undefined, 0n]
    ]) {
        assert.equal(journal.toCents(input), cents, String(input));
        assert.equal(journal.toCents(input), reporting.toCents(input));
        assert.equal(journal.toCents(journal.fromCents(cents)), cents);
    }
    assert.throws(() => journal.toCents('not money'));
});

test('posting from a negative fractional account balance agrees with the ledger and rejects negative inputs', async () => {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const business = await require('../app/services/business.service').createBusiness({ code: 'CENTS_' + Date.now(), name: 'Cents regression' });
    const accounts = await prisma.chartOfAccount.findMany({ where: { businessId: business.id, systemAccountKey: { in: ['CASH_ON_HAND', 'OWNER_CAPITAL'] } } });
    const cash = accounts.find(account => account.systemAccountKey === 'CASH_ON_HAND');
    const capital = accounts.find(account => account.id !== cash.id) || await prisma.chartOfAccount.findFirstOrThrow({ where: { businessId: business.id, type: 'EQUITY', allowPosting: true, isGroup: false } });
    await prisma.chartOfAccount.update({ where: { id: cash.id }, data: { openingBalance: '-0.50', currentBalance: '-0.50' } });
    await journal.postJournalEntry({ businessId: business.id, entryDate: new Date(), narration: 'Fractional balance regression', lines: [{ accountId: cash.id, debit: '0.01' }, { accountId: capital.id, credit: '0.01' }] });
    assert.equal(String((await prisma.chartOfAccount.findUnique({ where: { id: cash.id } })).currentBalance), '-0.49');
    const ledger = await journal.getAccountLedger(cash.id);
    assert.equal(reporting.toCents(ledger.closingBalance ?? ledger.summary?.closingBalance ?? ledger.transactions.at(-1).runningBalance), -49n);
    await assert.rejects(journal.postJournalEntry({ businessId: business.id, entryDate: new Date(), narration: 'Reject negative', lines: [{ accountId: cash.id, debit: '-0.01' }, { accountId: capital.id, credit: '-0.01' }] }), /cannot be negative/);
});

test('real concurrent issues and negative adjustments cannot consume the same stock twice', async () => {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const business = await require('../app/services/business.service').createBusiness({ code: 'RACE_' + Date.now(), name: 'Stock concurrency regression' });
    const actor = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN', active: true } });
    for (const movementType of ['ISSUE', 'ADJUSTMENT', 'RETURN_OUT']) {
        const item = await prisma.item.create({ data: { businessId: business.id, name: movementType + Date.now(), unit: 'PCS', rate: 10 } });
        await stock.recordStockMovement({ businessId: business.id, itemId: item.id, movementType: 'OPENING', quantity: 10, unitCost: 10 }, actor.id);
        let unlock, entered;
        const waiting = new Promise(resolve => { entered = resolve; });
        const release = new Promise(resolve => { unlock = resolve; });
        const held = prisma.$transaction(async tx => {
            await tx.$queryRawUnsafe('SELECT id FROM businesses WHERE id = ? FOR UPDATE', business.id);
            entered(); await release;
        });
        await waiting;
        let attempts;
        try {
            const write = () => stock.recordStockMovement({ businessId: business.id, itemId: item.id, movementType, quantity: movementType === 'ADJUSTMENT' ? -7 : 7 }, actor.id);
            attempts = Promise.allSettled([write(), write()]);
            await new Promise(resolve => setTimeout(resolve, 250));
        } finally { unlock(); await held; }
        const results = await attempts;
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, movementType);
        assert.match(results.find(result => result.status === 'rejected').reason.message, /Insufficient stock/);
        assert.equal((await stock.getItemStockSummary(item.id)).currentStock, 3);
        assert.equal(await prisma.stockMovement.count({ where: { itemId: item.id } }), 2);
    }
});

test('stock retries roll back failed attempts and stop after three conflicts', async () => {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const business = await require('../app/services/business.service').createBusiness({ code: 'RETRY_' + Date.now(), name: 'Stock retry regression' });
    const actor = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN', active: true } });
    const item = await prisma.item.create({ data: { businessId: business.id, name: 'Retry stock', unit: 'PCS', rate: 10 } });
    await stock.recordStockMovement({ businessId: business.id, itemId: item.id, movementType: 'OPENING', quantity: 10, unitCost: 10 }, actor.id);
    const transaction = prisma.$transaction;
    let attempts = 0, conflicts = 1;
    prisma.$transaction = callback => transaction.call(prisma, async tx => {
        attempts++;
        const result = await callback(tx);
        if (attempts <= conflicts) throw Object.assign(new Error('Injected transaction conflict after write'), { code: 'P2034' });
        return result;
    });
    const issue = () => stock.recordStockMovement({ businessId: business.id, itemId: item.id, movementType: 'ISSUE', quantity: 2 }, actor.id);
    try {
        await issue();
        assert.equal(attempts, 2);
        attempts = 0; conflicts = 3;
        await assert.rejects(issue(), /Injected transaction conflict/);
        assert.equal(attempts, 3);
    } finally { prisma.$transaction = transaction; }
    assert.equal((await stock.getItemStockSummary(item.id)).currentStock, 8);
    assert.equal(await prisma.stockMovement.count({ where: { itemId: item.id } }), 2);
});
