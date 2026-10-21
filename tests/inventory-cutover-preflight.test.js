'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const prisma = require('../app/config/prisma');
const { validatePlan, inspectBusiness } = require('../app/services/inventoryCutoverPreflight.service');

after(() => prisma.$disconnect());

function planFor(businessId, itemId) {
    return { version: 1, businesses: [{ businessId, effectiveDate: '2030-04-01', requestedById: 1, approvedById: 2, configuredById: 1, approvedAt: '2030-03-30T10:00:00Z', configuredAt: '2030-03-30T11:00:00Z', evidenceReference: 'TEST-ONLY-APPROVAL', openingBalances: [{ itemId, quantity: '10.00', value: '200.00' }] }] };
}

test('cutover plans require explicit dates, exact money, approval evidence and separate people', () => {
    const valid = planFor(1, 1);
    assert.equal(validatePlan(valid), valid);
    for (const [key, value] of [['effectiveDate', '2030-02-30'], ['effectiveDate', undefined], ['approvedById', 1], ['approvedAt', '2030-03-30'], ['configuredAt', '2030-03-29T10:00:00Z'], ['evidenceReference', '']]) {
        const plan = structuredClone(valid); plan.businesses[0][key] = value;
        assert.throws(() => validatePlan(plan), { name: 'ValidationError' });
    }
    for (const value of ['0.001', 'NaN', '-1.00', '1e3']) {
        const plan = structuredClone(valid); plan.businesses[0].openingBalances[0].value = value;
        assert.throws(() => validatePlan(plan), { name: 'ValidationError' });
    }
    const duplicate = structuredClone(valid); duplicate.businesses.push(duplicate.businesses[0]);
    assert.throws(() => validatePlan(duplicate), /unique/);
});

test('real database preflight reconciles recorded value without changing stock, journals or project costs', async () => {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const business = await require('../app/services/business.service').createBusiness({ code: `PREFLIGHT_${Date.now()}`, name: 'Preflight regression' });
    const actor = await prisma.user.findFirstOrThrow({ where: { active: true, role: 'ADMIN' } });
    const item = await prisma.item.create({ data: { businessId: business.id, name: 'Inactive valued item', active: false } });
    for (const [index, [quantity, unitCost, totalCost, movementType]] of [[10, 10, 100, 'RECEIPT'], [-10, 10, 100, 'ISSUE'], [10, 20, 200, 'RECEIPT']].entries()) {
        await prisma.stockMovement.create({ data: { businessId: business.id, itemId: item.id, createdById: actor.id, movementNumber: `PREFLIGHT-${index}`, movementType, quantity, unitCost, totalCost, storeLocation: 'Main', movementDate: new Date(`2029-03-0${index + 1}T00:00:00Z`) } });
    }
    const snapshot = async () => JSON.stringify(await Promise.all([
        prisma.stockMovement.findMany({ where: { businessId: business.id }, orderBy: { id: 'asc' } }),
        prisma.journalEntry.findMany({ where: { businessId: business.id }, include: { lines: true }, orderBy: { id: 'asc' } }),
        prisma.projectCost.findMany({ where: { businessId: business.id }, orderBy: { id: 'asc' } })
    ]));
    const before = await snapshot();
    const report = await inspectBusiness(prisma, business.id);
    assert.equal(report.activationAllowed, false);
    assert.equal(report.configurationStatus, 'UNCONFIGURED');
    assert.equal(report.movementValue, '200.00');
    assert.equal(report.inventoryLedger, '0.00');
    assert.equal(report.difference, '200.00');
    assert.deepEqual(report.balances, [{ itemId: item.id, active: false, quantity: '10.00', value: '200.00' }]);
    assert.ok(report.exceptions.some(e => e.code === 'UNEXPLAINED_LEDGER_DIFFERENCE'));
    const plan = planFor(business.id, item.id);
    const proposed = await inspectBusiness(prisma, business.id, plan);
    assert.equal(proposed.configurationStatus, 'PROPOSED_NOT_ACTIVATED');
    assert.equal(proposed.approvalVerification, 'NOT_IMPLEMENTED');
    assert.equal(proposed.activationAllowed, false);
    assert.ok(!proposed.exceptions.some(e => e.code === 'OPENING_BALANCE_UNRECONCILED'));
    const other = await prisma.business.create({ data: { code: `PREFLIGHT_OTHER_${Date.now()}`, name: 'Other business' } });
    const foreign = await prisma.item.create({ data: { businessId: other.id, name: 'Foreign item' } });
    plan.businesses[0].openingBalances.push({ itemId: foreign.id, quantity: '0', value: '0' });
    const scoped = await inspectBusiness(prisma, business.id, plan);
    assert.equal(scoped.balances.length, 1);
    assert.ok(scoped.exceptions.some(e => e.code === 'OPENING_ITEM_OUTSIDE_BUSINESS'));
    assert.equal(await snapshot(), before);
    const cli = spawnSync(process.execPath, ['scripts/inventory-cutover-preflight.js', '--env', '.env.test', '--business', String(business.id)], { encoding: 'utf8', windowsHide: true, timeout: 20000, input: '' });
    assert.equal(cli.status, 2, cli.stderr);
    const output = JSON.parse(cli.stdout);
    assert.equal(output.database, process.env.DATABASE_NAME);
    assert.equal(output.reports[0].activationAllowed, false);
    assert.equal(await snapshot(), before);
});

test('real preflight flags residuals, returns, inconsistent signs and missing project costs', async () => {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const business = await prisma.business.create({ data: { code: `PREFLIGHT_BAD_${Date.now()}`, name: 'Exceptions', timeZone: 'Invalid/Zone' } });
    const actor = await prisma.user.findFirstOrThrow({ where: { active: true } });
    const item = await prisma.item.create({ data: { businessId: business.id, name: 'Residual item' } });
    for (const [i, data] of [
        { quantity: 1, unitCost: 10, totalCost: 10, movementType: 'OPENING' },
        { quantity: -1, unitCost: 9, totalCost: 9, movementType: 'ISSUE', referenceType: 'PROJECT_ISSUE' },
        { quantity: -1, unitCost: 2, totalCost: 2, movementType: 'RETURN_IN' }
    ].entries()) await prisma.stockMovement.create({ data: { ...data, businessId: business.id, itemId: item.id, createdById: actor.id, movementNumber: `BAD-${i}`, movementDate: new Date('2029-01-01') } });
    const report = await inspectBusiness(prisma, business.id);
    const codes = new Set(report.exceptions.map(e => e.code));
    for (const code of ['INVALID_BUSINESS_TIMEZONE', 'ZERO_QUANTITY_RESIDUAL_VALUE', 'NEGATIVE_RUNNING_BALANCE', 'RETURN_ORIGIN_UNVERIFIED', 'MOVEMENT_TYPE_OR_SIGN_INVALID', 'PROJECT_COST_MISMATCH', 'LOCATION_UNSPECIFIED']) assert.ok(codes.has(code), code);
    assert.equal(report.movementValue, '-1.00', 'Negative values are exposed, never clamped');
    await assert.rejects(inspectBusiness(prisma, 0), /explicit business ID/);
});

test('preflight command rejects mutation flags and malformed arguments without prompting', () => {
    for (const args of [[], ['--approve', '1'], ['--env', '.env.test', '--business', '-1'], ['--env', '.env.test', '--env', '.env.test']]) {
        const result = spawnSync(process.execPath, ['scripts/inventory-cutover-preflight.js', ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000, input: 'n\n' });
        assert.equal(result.status, 1, result.stderr);
        assert.doesNotMatch(result.stderr, /mysql:\/\//);
    }
    const help = spawnSync(process.execPath, ['scripts/inventory-cutover-preflight.js', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /No activation/);
});
