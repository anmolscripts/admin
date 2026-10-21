'use strict';

const { ValidationError, NotFoundError } = require('./errorTypes');

function decimalUnits(value) {
    const text = String(value ?? '');
    if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new ValidationError('Expected an exact decimal with at most two places.');
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
    const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
    return negative ? -result : result;
}

function formatUnits(value) {
    const absolute = value < 0n ? -value : value;
    return `${value < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function validatePlan(plan) {
    if (!plan || plan.version !== 1 || !Array.isArray(plan.businesses)) throw new ValidationError('Expected version 1 and a businesses array.');
    const ids = new Set();
    for (const entry of plan.businesses) {
        if (!Number.isSafeInteger(entry.businessId) || entry.businessId <= 0 || ids.has(entry.businessId)) throw new ValidationError('Business IDs must be unique positive integers.');
        ids.add(entry.businessId);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.effectiveDate || '') ||
            !Number.isFinite(Date.parse(entry.effectiveDate)) || new Date(entry.effectiveDate).toISOString().slice(0, 10) !== entry.effectiveDate) throw new ValidationError('An explicit valid effectiveDate is required.');
        for (const key of ['requestedById', 'approvedById', 'configuredById']) {
            if (!Number.isSafeInteger(entry[key]) || entry[key] <= 0) throw new ValidationError(`${key} must be a positive user ID.`);
        }
        if (entry.requestedById === entry.approvedById) throw new ValidationError('Requester and approver must be different users.');
        for (const key of ['approvedAt', 'configuredAt']) {
            if (typeof entry[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(entry[key]) || !Number.isFinite(Date.parse(entry[key]))) throw new ValidationError(`${key} must include an explicit timestamp and timezone.`);
        }
        if (Date.parse(entry.configuredAt) < Date.parse(entry.approvedAt)) throw new ValidationError('Configuration cannot precede approval.');
        if (typeof entry.evidenceReference !== 'string' || !entry.evidenceReference.trim()) throw new ValidationError('Approval evidenceReference is required.');
        if (!Array.isArray(entry.openingBalances)) throw new ValidationError('Explicit openingBalances are required.');
        const items = new Set();
        for (const opening of entry.openingBalances) {
            if (!Number.isSafeInteger(opening.itemId) || opening.itemId <= 0 || items.has(opening.itemId)) throw new ValidationError('Opening item IDs must be unique positive integers.');
            items.add(opening.itemId);
            const quantity = decimalUnits(opening.quantity), value = decimalUnits(opening.value);
            if (quantity < 0n || value < 0n || (quantity === 0n && value !== 0n)) throw new ValidationError('Invalid opening quantity/value.');
        }
    }
    return plan;
}

// Read-only operator tool. A plan is evidence to review, never activation authority.
async function inspectBusiness(db, businessId, plan = { version: 1, businesses: [] }) {
    if (!Number.isSafeInteger(businessId) || businessId <= 0) throw new ValidationError('An explicit business ID is required.');
    validatePlan(plan);
    return db.$transaction(async tx => {
        const business = await tx.business.findUnique({ where: { id: businessId }, select: { id: true, code: true, timeZone: true } });
        if (!business) throw new NotFoundError('Business not found.');
        const configuration = plan.businesses.find(entry => entry.businessId === businessId) || null;
        const exceptions = [];
        const add = (code, details = {}) => exceptions.push({ code, ...details });
        if (!configuration) add('CUTOVER_UNCONFIGURED');
        try { new Intl.DateTimeFormat('en-CA', { timeZone: business.timeZone }).format(new Date(0)); }
        catch { add('INVALID_BUSINESS_TIMEZONE'); }
        const items = await tx.item.findMany({ where: { businessId }, select: { id: true, active: true } });
        const movements = await tx.stockMovement.findMany({ where: { businessId }, include: { item: { select: { businessId: true } } }, orderBy: [{ movementDate: 'asc' }, { id: 'asc' }] });
        const journals = await tx.journalEntry.findMany({ where: { businessId, sourceType: 'STOCK_MOVEMENT' }, select: { sourceId: true, status: true } });
        const costs = await tx.projectCost.findMany({ where: { businessId, sourceType: 'STOCK_MOVEMENT', status: 'POSTED' } });
        const accounts = await tx.chartOfAccount.findMany({ where: { businessId, systemAccountKey: 'INVENTORY_ASSET' }, select: { id: true, openingBalance: true, openingBalanceType: true } });
        const lines = await tx.journalEntryLine.findMany({ where: { accountId: { in: accounts.map(a => a.id) }, journalEntry: { businessId, status: { in: ['POSTED', 'REVERSED'] } } }, select: { debit: true, credit: true } });
        const receipts = await tx.goodsReceipt.findMany({ where: { businessId, status: 'ACCEPTED' }, select: { id: true, items: { select: { id: true, stockMovementId: true, acceptedQuantity: true } } } });
        const bills = await tx.supplierBill.findMany({ where: { businessId, status: { not: 'VOID' } }, select: { id: true, billNumber: true } });
        const balances = new Map(items.map(item => [item.id, { itemId: item.id, active: item.active, quantity: 0n, value: 0n }]));
        for (const m of movements) {
            if (m.item.businessId !== businessId) add('ITEM_BUSINESS_MISMATCH', { movementId: m.id });
            if (!balances.has(m.itemId)) continue;
            const balance = balances.get(m.itemId);
            let quantity, cost;
            try { quantity = decimalUnits(m.quantity); cost = decimalUnits(m.totalCost); decimalUnits(m.unitCost); }
            catch { add('INVALID_MOVEMENT_COST_OR_QUANTITY', { movementId: m.id }); continue; }
            if (!quantity || cost < 0n || decimalUnits(m.unitCost) < 0n) add('INVALID_MOVEMENT_COST_OR_QUANTITY', { movementId: m.id });
            balance.quantity += quantity;
            balance.value += quantity > 0n ? cost : -cost;
            if (balance.quantity < 0n || balance.value < 0n) add('NEGATIVE_RUNNING_BALANCE', { movementId: m.id });
            if (balance.quantity === 0n && balance.value !== 0n) add('ZERO_QUANTITY_RESIDUAL_VALUE', { movementId: m.id, value: formatUnits(balance.value) });
            if (!['OPENING', 'RECEIPT', 'ISSUE', 'RETURN_IN', 'RETURN_OUT', 'ADJUSTMENT'].includes(m.movementType) ||
                (['OPENING', 'RECEIPT', 'RETURN_IN'].includes(m.movementType) && quantity < 0n) ||
                (['ISSUE', 'RETURN_OUT'].includes(m.movementType) && quantity > 0n)) add('MOVEMENT_TYPE_OR_SIGN_INVALID', { movementId: m.id });
            if (m.movementType.startsWith('RETURN')) add('RETURN_ORIGIN_UNVERIFIED', { movementId: m.id });
            if (!m.storeLocation) add('LOCATION_UNSPECIFIED', { movementId: m.id });
            if (configuration && m.movementDate.toISOString().slice(0, 10) >= configuration.effectiveDate) add('MOVEMENT_ON_OR_AFTER_PROPOSED_CUTOVER', { movementId: m.id });
            const linked = journals.filter(j => j.sourceId === m.id && j.status === 'POSTED');
            if (cost > 0n && quantity < 0n && !linked.length) add('OUTWARD_POSTING_REQUIREMENT_UNVERIFIED', { movementId: m.id });
            if (['PROJECT_ISSUE', 'PROJECT_RETURN'].includes(m.referenceType)) {
                const projectCosts = costs.filter(c => c.sourceId === m.id);
                const expected = m.referenceType === 'PROJECT_RETURN' ? -cost : cost;
                if (cost > 0n && (!projectCosts.length || projectCosts.some(c => c.projectId !== m.projectId) || projectCosts.reduce((sum, c) => sum + decimalUnits(c.amount), 0n) !== expected)) add('PROJECT_COST_MISMATCH', { movementId: m.id });
            }
        }
        for (const receipt of receipts) {
            add('RECEIPT_BILL_MATCH_UNVERIFIED', { receiptId: receipt.id });
            for (const line of receipt.items) if (decimalUnits(line.acceptedQuantity) > 0n && !line.stockMovementId) add('RECEIPT_WITHOUT_STOCK_MOVEMENT', { receiptId: receipt.id, lineId: line.id });
        }
        for (const bill of bills) add('BILL_RECEIPT_MATCH_UNVERIFIED', { billId: bill.id });
        if (!accounts.length) add('INVENTORY_ACCOUNT_MISSING');
        const inventoryLedger = accounts.reduce((sum, a) => sum + (a.openingBalanceType === 'CREDIT' ? -decimalUnits(a.openingBalance) : decimalUnits(a.openingBalance)), 0n) + lines.reduce((sum, l) => sum + decimalUnits(l.debit) - decimalUnits(l.credit), 0n);
        const movementValue = [...balances.values()].reduce((sum, b) => sum + b.value, 0n);
        if (movementValue !== inventoryLedger) add('UNEXPLAINED_LEDGER_DIFFERENCE', { difference: formatUnits(movementValue - inventoryLedger) });
        if (configuration) {
            const openingIds = new Set(configuration.openingBalances.map(b => b.itemId));
            for (const item of balances.values()) {
                const opening = configuration.openingBalances.find(b => b.itemId === item.itemId);
                if (!opening || decimalUnits(opening.quantity) !== item.quantity || decimalUnits(opening.value) !== item.value) add('OPENING_BALANCE_UNRECONCILED', { itemId: item.itemId });
            }
            for (const itemId of openingIds) if (!balances.has(itemId)) add('OPENING_ITEM_OUTSIDE_BUSINESS', { itemId });
        }
        return {
            business, mode: 'FOUNDATION_ONLY', activationAllowed: false,
            configurationStatus: configuration ? 'PROPOSED_NOT_ACTIVATED' : 'UNCONFIGURED',
            approvalVerification: 'NOT_IMPLEMENTED', proposedConfiguration: configuration,
            chronology: 'PROPOSED: business-local date, then immutable movement ID; not enforced',
            exceptions, balances: [...balances.values()].map(b => ({ ...b, quantity: formatUnits(b.quantity), value: formatUnits(b.value) })),
            movementValue: formatUnits(movementValue), inventoryLedger: formatUnits(inventoryLedger),
            difference: formatUnits(movementValue - inventoryLedger),
            limitations: ['Receipt/bill timing and price differences require source-document review; no reliable matching key exists.', 'Optional historical posting intent and return origins cannot be proven from this schema.', 'This snapshot is not approval; repeat under a controlled write freeze before rollout.']
        };
    });
}

module.exports = { validatePlan, inspectBusiness };
