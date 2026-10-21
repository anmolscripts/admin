'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const prisma = require('../app/config/prisma');
const stock = require('../app/services/stockMovement.service');
const receipts = require('../app/services/goodsReceipt.service');
const businesses = require('../app/services/business.service');

after(() => prisma.$disconnect());

async function fixture() {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const business = await businesses.createBusiness({ code: `ATOMIC_${crypto.randomUUID()}`, name: 'Atomic stock', gstin: '27AABCA1234A1Z5', stateCode: '27' });
    const actor = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN', active: true } });
    const item = await prisma.item.create({ data: { businessId: business.id, name: 'Atomic material', unit: 'PCS', rate: 10 } });
    const project = await prisma.project.create({ data: { businessId: business.id, code: 'ATOMIC-PROJECT', name: 'Atomic project', startDate: new Date(), createdById: actor.id } });
    const supplier = await prisma.supplier.create({ data: { businessId: business.id, name: 'Atomic supplier', createdById: actor.id } });
    await stock.recordStockMovement({ businessId: business.id, itemId: item.id, movementType: 'OPENING', quantity: 10, unitCost: 10 }, actor.id);
    return { business, actor, item, project, supplier };
}
const issue = (f, extra = {}) => stock.recordStockMovement({ businessId: f.business.id, itemId: f.item.id, movementType: 'ISSUE', quantity: 2, postToLedger: true, ...extra }, f.actor.id);
const projectIssue = (f, extra = {}) => stock.issueMaterialToProject({ businessId: f.business.id, projectId: f.project.id, itemId: f.item.id, quantity: 2, ...extra }, f.actor.id);
const receipt = (f, extra = {}) => receipts.createGoodsReceipt({ supplierId: f.supplier.id, items: [{ itemId: f.item.id, name: f.item.name, receivedQuantity: 2, unitCost: 10 }], ...extra }, f.actor.id, f.business.id);

async function snapshot(f) {
    const where = { businessId: f.business.id };
    const state = await Promise.all([
        prisma.stockMovement.findMany({ where, orderBy: { id: 'asc' } }),
        prisma.journalEntry.findMany({ where, include: { lines: true }, orderBy: { id: 'asc' } }),
        prisma.chartOfAccount.findMany({ where, orderBy: { id: 'asc' } }),
        prisma.projectCost.findMany({ where, orderBy: { id: 'asc' } }),
        prisma.numberingSequence.findMany({ where, orderBy: { id: 'asc' } }),
        prisma.goodsReceipt.findMany({ where, include: { items: true }, orderBy: { id: 'asc' } }),
        prisma.financialYear.findMany({ where, orderBy: { id: 'asc' } })
    ]);
    return JSON.stringify(state, (_key, value) => typeof value === 'bigint' ? String(value) : value);
}

// Faults run inside real database transactions; every successful write before them must roll back.
async function injectFailure(stage, operation, transient = false) {
    const original = prisma.$transaction;
    let attempts = 0, fired = 0;
    prisma.$transaction = callback => original.call(prisma, async tx => {
        attempts++;
        const fail = () => { fired++; throw Object.assign(new Error(`Injected ${stage}`), transient ? { code: 'P2034' } : {}); };
        const proxy = new Proxy(tx, { get(target, model) {
            if (model === '$executeRawUnsafe' && stage === 'numbering') return async (...args) => {
                const result = await target.$executeRawUnsafe(...args);
                if (String(args[0]).includes('numbering_sequences') && attempts === 1 && !fired) fail();
                return result;
            };
            if (model === 'stockMovement' || model === 'journalEntry' || model === 'projectCost' || model === 'chartOfAccount') {
                return new Proxy(target[model], { get(delegate, method) {
                    const value = delegate[method];
                    if (typeof value !== 'function') return value;
                    return async (...args) => {
                        const matches = (model === 'stockMovement' && method === 'create' && ['before-stock', 'after-stock'].includes(stage)) ||
                            (model === 'journalEntry' && method === 'upsert' && stage === 'journal') ||
                            (model === 'chartOfAccount' && method === 'update' && stage === 'account') ||
                            (model === 'projectCost' && method === 'upsert' && stage === 'project');
                        if (matches && stage === 'before-stock') fail();
                        const result = await value.apply(delegate, args);
                        if (matches) fail();
                        return result;
                    };
                } });
            }
            const value = target[model];
            return typeof value === 'function' ? value.bind(target) : value;
        } });
        const result = await callback(proxy);
        if (stage === 'commit' && (!transient || attempts === 1)) fail();
        return result;
    });
    try { return { result: await operation(), attempts, fired }; }
    finally { prisma.$transaction = original; }
}

test('actual stock/journal/project transactions roll back at every required write boundary', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    for (const stage of ['before-stock', 'after-stock', 'journal', 'account', 'project', 'commit']) {
        await assert.rejects(injectFailure(stage, () => stage === 'project' ? projectIssue(f) : issue(f)), new RegExp(`Injected ${stage}`));
        assert.equal(await snapshot(f), before, stage);
    }
    for (const stage of ['after-stock', 'commit']) {
        await assert.rejects(injectFailure(stage, () => receipt(f)), new RegExp(`Injected ${stage}`));
        assert.equal(await snapshot(f), before, `receipt ${stage}`);
    }
});

test('invalid accounts and closed years roll back physical stock and newly created financial years', async () => {
    const f = await fixture();
    let before = await snapshot(f);
    await assert.rejects(issue(f, { debitAccountKey: 'NOT_AN_ACCOUNT' }), /Required ledger accounts/);
    assert.equal(await snapshot(f), before);
    const fy = await require('../app/services/financialYear.service').ensureFinancialYear(new Date(), f.business.id);
    await prisma.financialYear.update({ where: { id: fy.id }, data: { status: 'CLOSED' } });
    before = await snapshot(f);
    await assert.rejects(issue(f), /closed Financial Year/);
    assert.equal(await snapshot(f), before);
    const accounts = await prisma.chartOfAccount.findMany({ where: { businessId: f.business.id, systemAccountKey: 'COGS' } });
    await prisma.chartOfAccount.update({ where: { id: accounts[0].id }, data: { active: false } });
    await prisma.financialYear.update({ where: { id: fy.id }, data: { status: 'OPEN' } });
    before = await snapshot(f);
    await assert.rejects(issue(f), /inactive/);
    assert.equal(await snapshot(f), before);
});

test('keyed stock retries, concurrency and changed payloads produce exactly one movement and journal', async () => {
    const f = await fixture(), key = crypto.randomUUID();
    const historic = await prisma.stockMovement.findMany({ where: { businessId: f.business.id } });
    const pair = await Promise.all([issue(f, { idempotencyKey: key }), issue(f, { idempotencyKey: key })]);
    assert.equal(pair[0].id, pair[1].id);
    assert.equal(pair[0].journalEntry.id, pair[1].journalEntry.id);
    const after = await snapshot(f);
    assert.equal((await issue(f, { idempotencyKey: key })).id, pair[0].id, 'Retry after a lost response returns the committed result');
    assert.equal(await snapshot(f), after);
    await assert.rejects(issue(f, { idempotencyKey: key, quantity: 3 }), { statusCode: 409 });
    assert.equal(await snapshot(f), after);
    const movements = await prisma.stockMovement.findMany({ where: { businessId: f.business.id }, orderBy: { id: 'asc' } });
    assert.deepEqual(movements[0], historic[0]);
    assert.equal(movements.reduce((sum, m) => sum + Number(m.quantity), 0), 8);
    assert.equal(movements.reduce((sum, m) => sum + (Number(m.quantity) > 0 ? 1 : -1) * Number(m.totalCost), 0), 80);
    const journal = await prisma.journalEntry.findUnique({ where: { id: pair[0].journalEntry.id }, include: { lines: true } });
    assert.equal(journal.lines.reduce((sum, l) => sum + Number(l.debit), 0), 20);
    assert.equal(journal.lines.reduce((sum, l) => sum + Number(l.credit), 0), 20);
    const inventory = await prisma.chartOfAccount.findFirstOrThrow({ where: { businessId: f.business.id, systemAccountKey: 'INVENTORY_ASSET' } });
    assert.equal(Number(inventory.currentBalance), -20, 'Opening stock was intentionally not posted: explain the 100 opening difference');
    const retry = await injectFailure('commit', () => issue(f, { idempotencyKey: crypto.randomUUID() }), true);
    assert.equal(retry.attempts, 2);
    assert.equal(await prisma.stockMovement.count({ where: { businessId: f.business.id } }), 3);
    assert.equal(await prisma.journalEntry.count({ where: { businessId: f.business.id } }), 2);
});

test('project issues and returns atomically post material costs once without introducing GL postings', async () => {
    const f = await fixture();
    const key = crypto.randomUUID();
    const issueResult = await projectIssue(f, { idempotencyKey: key });
    assert.equal((await projectIssue(f, { idempotencyKey: key })).id, issueResult.id);
    const payload = { businessId: f.business.id, projectId: f.project.id, itemId: f.item.id, quantity: 1, unitCost: 10, idempotencyKey: crypto.randomUUID() };
    const returns = await Promise.all([stock.returnMaterialFromProject(payload, f.actor.id), stock.returnMaterialFromProject(payload, f.actor.id)]);
    assert.equal(returns[0].id, returns[1].id);
    const costs = await prisma.projectCost.findMany({ where: { businessId: f.business.id }, orderBy: { id: 'asc' } });
    assert.deepEqual(costs.map(c => Number(c.amount)), [20, -10]);
    assert.deepEqual(costs.map(c => Number(c.quantity)), [2, -1]);
    assert.equal((await stock.getItemStockSummary(f.item.id)).currentStock, 9);
    assert.equal(await prisma.journalEntry.count({ where: { businessId: f.business.id } }), 0);
    const before = await snapshot(f);
    await assert.rejects(injectFailure('project', () => stock.returnMaterialFromProject({ ...payload, idempotencyKey: crypto.randomUUID() }, f.actor.id)), /Injected project/);
    assert.equal(await snapshot(f), before);
});

test('caller transactions use current stock despite old snapshots and numbering conflicts retry the whole operation', async () => {
    const f = await fixture();
    await prisma.$transaction(async tx => {
        await tx.stockMovement.findMany({ where: { itemId: f.item.id } });
        await issue(f, { quantity: 7 });
        await assert.rejects(stock.recordStockMovement({ businessId: f.business.id, itemId: f.item.id, movementType: 'ISSUE', quantity: 7 }, f.actor.id, tx), /Insufficient stock/);
    });
    assert.equal((await stock.getItemStockSummary(f.item.id)).currentStock, 3);
    const retried = await injectFailure('numbering', () => issue(f, { idempotencyKey: crypto.randomUUID() }), true);
    assert.equal(retried.attempts, 2);
    assert.equal(retried.fired, 1);
    assert.equal((await stock.getItemStockSummary(f.item.id)).currentStock, 1);
    assert.equal(await prisma.stockMovement.count({ where: { businessId: f.business.id } }), 3);
    assert.equal(await prisma.journalEntry.count({ where: { businessId: f.business.id } }), 2);
});

test('goods receipt and supplier bill recognise acquisition once; concurrent issues/receipts conserve stock', async () => {
    const f = await fixture();
    const request = { idempotencyKey: crypto.randomUUID() };
    const received = await receipt(f, request);
    assert.equal((await receipt(f, request)).id, received.id);
    assert.equal(await prisma.journalEntry.count({ where: { businessId: f.business.id } }), 0);
    const bill = await require('../app/services/supplierBill.service').createSupplierBill({ businessId: f.business.id, supplierId: f.supplier.id, billNumber: `ATOMIC-${crypto.randomUUID()}`, isInventory: true, gstRate: 0, items: [{ name: f.item.name, quantity: 2, rate: 10, unit: 'PCS' }] }, f.actor.id);
    assert.ok(bill.id);
    await Promise.all([receipt(f, { idempotencyKey: crypto.randomUUID() }), issue(f, { quantity: 7, idempotencyKey: crypto.randomUUID() })]);
    const outcomes = await Promise.allSettled([issue(f, { quantity: 7, idempotencyKey: crypto.randomUUID() }), issue(f, { quantity: 7, idempotencyKey: crypto.randomUUID() })]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const movements = await prisma.stockMovement.findMany({ where: { businessId: f.business.id } });
    assert.equal(movements.reduce((sum, m) => sum + Number(m.quantity), 0), 0);
    assert.equal(movements.reduce((sum, m) => sum + (Number(m.quantity) > 0 ? 1 : -1) * Number(m.totalCost), 0), 0);
    const inventory = await prisma.chartOfAccount.findFirstOrThrow({ where: { businessId: f.business.id, systemAccountKey: 'INVENTORY_ASSET' } });
    assert.equal(Number(inventory.currentBalance), -120, '100 unposted opening + 20 second receipt not yet billed explains GL difference');
});

test('business membership is checked before request replay or posting and keys are business-scoped', async () => {
    const a = await fixture(), b = await fixture(), key = crypto.randomUUID();
    const outsider = await prisma.user.create({ data: { name: 'Stock outsider', email: `stock-${crypto.randomUUID()}@test.invalid`, role: 'STAFF', password: 'not-a-login-hash' } });
    await businesses.setBusinessMembership(a.business.id, outsider.id);
    const before = await snapshot(b);
    await assert.rejects(stock.recordStockMovement({ businessId: b.business.id, itemId: b.item.id, movementType: 'ISSUE', quantity: 1, idempotencyKey: key }, outsider.id), { statusCode: 403 });
    await assert.rejects(stock.recordStockMovement({ businessId: a.business.id, itemId: b.item.id, movementType: 'ISSUE', quantity: 1 }, outsider.id), /Cross-business/);
    assert.equal(await snapshot(b), before);
    const first = await issue(a, { idempotencyKey: key }), second = await issue(b, { idempotencyKey: key });
    assert.notEqual(first.id, second.id);
    await assert.rejects(stock.postStockMovementToLedger({ movementId: second.id }, outsider.id), { statusCode: 403 });
    await assert.rejects(projectIssue(a, { projectId: b.project.id }), /not found/);
});

test('real HTTP stock routes enforce authentication, permissions, business context and idempotency', async () => {
    const f = await fixture();
    const password = 'Atomic-stock-test-2026!';
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
    const user = await prisma.user.create({ data: { name: 'Atomic owner', email: `atomic-owner-${crypto.randomUUID()}@test.invalid`, password: await require('bcrypt').hash(password, 10), role: 'STAFF', roleId: role.id } });
    await businesses.setBusinessMembership(f.business.id, user.id);
    const server = http.createServer(require('../app/app'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const page = await fetch(base + '/login');
        const cookie = page.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
        const csrf = (await page.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
        const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, email: user.email, password }) });
        assert.equal(login.status, 302);
        const session = login.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
        const dashboard = await fetch(base + '/', { headers: { Cookie: session } });
        const token = (await dashboard.text()).match(/name="_csrf"\s+value="([^"]+)"|name="csrf-token" content="([^"]+)"/);
        const key = crypto.randomUUID();
        const headers = { Cookie: session, Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': token[1] || token[2], 'Idempotency-Key': key };
        const send = () => fetch(base + `/api/projects/${f.project.id}/issue-material`, { method: 'POST', headers, body: JSON.stringify({ itemId: f.item.id, quantity: 1 }) });
        const first = await send(); assert.equal(first.status, 201, await first.clone().text());
        const second = await send(); assert.equal(second.status, 201);
        assert.equal((await first.json()).stockMovement.id, (await second.json()).stockMovement.id);
        const anonymous = await fetch(base + '/api/inventory/movements', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}' });
        assert.ok([401, 403].includes(anonymous.status));
        const viewer = await prisma.role.findUniqueOrThrow({ where: { name: 'VIEWER' } });
        await prisma.user.update({ where: { id: user.id }, data: { roleId: viewer.id } });
        require('../app/services/rbac.service').invalidateAll();
        const denied = await send(); assert.equal(denied.status, 403, await denied.text());
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('project form handlers use the project endpoint and retain keys after uncertain responses', async () => {
    const source = fs.readFileSync('app/views/projects/details.ejs', 'utf8');
    const code = source.slice(source.indexOf('function stockRequestKey('), source.indexOf('// 3. Record Daily Labour Handler'));
    const elements = new Map();
    const get = id => {
        if (!elements.has(id)) elements.set(id, { value: id.includes('date') ? '2026-10-21' : id.includes('notes') ? '' : '1', dataset: {}, addEventListener(_event, handler) { this.handler = handler; } });
        return elements.get(id);
    };
    const calls = [];
    vm.runInNewContext(code, { document: { getElementById: get }, crypto, projectId: 123, csrfToken: 'test', alert() {}, window: { location: { reload() {} } }, fetch: async (url, options) => { calls.push({ url, options }); throw new Error('Simulated lost response'); } });
    const form = get('form-issue-stock');
    await form.handler.call(form, { preventDefault() {} });
    await form.handler.call(form, { preventDefault() {} });
    assert.equal(calls[0].url, '/api/projects/123/issue-material');
    assert.equal(calls[0].options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
    get('stock-qty').value = '2';
    await form.handler.call(form, { preventDefault() {} });
    assert.notEqual(calls[0].options.headers['Idempotency-Key'], calls[2].options.headers['Idempotency-Key']);
    const returned = get('form-return-stock');
    await returned.handler.call(returned, { preventDefault() {} });
    await returned.handler.call(returned, { preventDefault() {} });
    assert.equal(calls[3].url, '/api/projects/123/return-material');
    assert.equal(calls[3].options.headers['Idempotency-Key'], calls[4].options.headers['Idempotency-Key']);
});
