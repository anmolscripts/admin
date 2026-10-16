'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const journalService = require('./journal.service');
const { ensureSystemAccounts } = require('./chartOfAccounts.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');
const businessService = require('./business.service');

const INWARD_TYPES = ['RECEIPT', 'OPENING', 'RETURN_IN'];
const OUTWARD_TYPES = ['ISSUE', 'RETURN_OUT'];
const VALID_MOVEMENT_TYPES = ['RECEIPT', 'ISSUE', 'ADJUSTMENT', 'OPENING', 'RETURN_IN', 'RETURN_OUT'];

const numberingService = require('./numbering.service');

/**
 * Generate sequential movement number: STK/YYYY/MM/INCREMENT
 */
async function generateMovementNumber(tx, options = {}) {
    let rawBizId = options.businessId;
    if (!rawBizId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
        rawBizId = 1;
    }
    if (!rawBizId || isNaN(parseInt(rawBizId, 10)) || parseInt(rawBizId, 10) <= 0) {
        throw new ValidationError('A valid businessId is required for stock movement numbering.');
    }
    const businessId = parseInt(rawBizId, 10);
    const date = options.date || new Date();
    return await numberingService.allocateNumber({
        businessId,
        entityType: 'STOCK_MOVEMENT',
        date,
        tx
    });
}

/**
 * Record a stock movement
 */
async function recordStockMovement(data = {}, userId) {
    const itemId = parseInt(data.itemId, 10);
    if (isNaN(itemId) || itemId <= 0) {
        throw new ValidationError('Valid item ID is required.');
    }

    const item = await prisma.item.findUnique({ where: { id: itemId } });
    if (!item) {
        throw new NotFoundError(`Item with ID ${itemId} not found.`);
    }

    const movementType = (data.movementType || '').toString().trim().toUpperCase();
    if (!VALID_MOVEMENT_TYPES.includes(movementType)) {
        throw new ValidationError(`Invalid movement type "${data.movementType}". Allowed: ${VALID_MOVEMENT_TYPES.join(', ')}.`);
    }

    const rawQty = parseFloat(data.quantity);
    if (isNaN(rawQty) || (movementType !== 'ADJUSTMENT' && rawQty <= 0) || rawQty === 0) {
        throw new ValidationError('Quantity must be a non-zero number.');
    }

    const movementDate = data.movementDate ? new Date(data.movementDate) : new Date();
    if (isNaN(movementDate.getTime())) {
        throw new ValidationError('Invalid movement date.');
    }

    // Calculate current stock to prevent negative stock on outward movements
    const summary = await getItemStockSummary(itemId);
    const isOutward = OUTWARD_TYPES.includes(movementType) || (movementType === 'ADJUSTMENT' && rawQty < 0);
    const netQtyDelta = isOutward ? -Math.abs(rawQty) : Math.abs(rawQty);

    if (summary.currentStock + netQtyDelta < 0) {
        throw new ValidationError(
            `Insufficient stock for item "${item.name}". Current: ${summary.currentStock}, Requested reduction: ${Math.abs(netQtyDelta)}.`
        );
    }

    // Determine unit cost
    let unitCost = parseFloat(data.unitCost);
    if (isNaN(unitCost) || unitCost < 0) {
        if (isOutward) {
            unitCost = summary.weightedAverageCost || parseFloat(item.rate) || 0;
        } else {
            unitCost = parseFloat(item.rate) || 0;
        }
    }
    unitCost = Math.round(unitCost * 100) / 100;

    const absQty = Math.round(Math.abs(rawQty) * 100) / 100;
    const signedQty = movementType === 'ADJUSTMENT' ? (rawQty < 0 ? -absQty : absQty) : (isOutward ? -absQty : absQty);
    let rawBizId = data.businessId || item.businessId;
    if (!rawBizId && userId) {
        try {
            const accessible = await businessService.getUserAccessibleBusinesses(userId);
            if (accessible.length === 1) rawBizId = accessible[0].id;
        } catch (e) {}
    }
    if (!rawBizId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
        rawBizId = 1;
    }
    if (!rawBizId || isNaN(parseInt(rawBizId, 10)) || parseInt(rawBizId, 10) <= 0) {
        throw new ValidationError('A valid businessId is required for stock movements.');
    }
    const businessId = parseInt(rawBizId, 10);
    if (item.businessId && item.businessId !== businessId) {
        throw new ValidationError(`Item ${itemId} does not belong to authorized business ${businessId}. Cross-business access denied.`);
    }

    const totalCost = Math.round(Math.abs(signedQty) * unitCost * 100) / 100;
    const movement = await prisma.$transaction(async (tx) => {
        const movementNumber = await generateMovementNumber(tx, { businessId, date: movementDate });

        const movement = await tx.stockMovement.create({
            data: {
                businessId,
                movementNumber,
                itemId,
                movementType,
                quantity: signedQty,
                unitCost,
                totalCost,
                referenceType: data.referenceType ? String(data.referenceType).trim() : null,
                referenceId: data.referenceId ? parseInt(data.referenceId, 10) : null,
                movementDate,
                notes: data.notes ? String(data.notes).trim() : null,
                createdById: userId
            },
            include: {
                item: true,
                createdBy: { select: { id: true, name: true, email: true } }
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE',
                module: 'INVENTORY',
                targetType: 'STOCK_MOVEMENT',
                targetId: movement.id,
                description: `Recorded stock movement ${movementNumber} (${movementType} ${signedQty} ${item.unit || 'units'} @ $${unitCost}) for ${item.name}`
            });
        }

        return movement;
    });

    if (data.postToLedger === true && parseFloat(movement.totalCost) > 0) {
        const postResult = await postStockMovementToLedger({
            movementId: movement.id,
            debitAccountKey: data.debitAccountKey || 'COGS',
            creditAccountKey: data.creditAccountKey || 'INVENTORY_ASSET',
            notes: data.notes
        }, userId);
        return { ...movement, journalEntry: postResult.journalEntry };
    }

    return movement;
}


/**
 * Calculate stock summary and weighted-average cost for an item
 */
async function getItemStockSummary(itemId, asOfDate = null) {
    const numId = parseInt(itemId, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid item ID.');

    const where = { itemId: numId };
    if (asOfDate) {
        const d = new Date(asOfDate);
        if (!isNaN(d.getTime())) where.movementDate = { lte: d };
    }

    const movements = await prisma.stockMovement.findMany({
        where,
        orderBy: { movementDate: 'asc' }
    });

    let currentStock = 0;
    let totalInwardQty = 0;
    let totalInwardCost = 0;
    let totalOutwardQty = 0;

    for (const m of movements) {
        const qty = parseFloat(m.quantity);
        const cost = parseFloat(m.unitCost);

        if (qty > 0) {
            totalInwardQty += qty;
            totalInwardCost += qty * cost;
            currentStock += qty;
        } else {
            totalOutwardQty += Math.abs(qty);
            currentStock += qty; // qty is negative
        }
    }

    currentStock = Math.round(currentStock * 100) / 100;
    const weightedAverageCost = totalInwardQty > 0
        ? Math.round((totalInwardCost / totalInwardQty) * 100) / 100
        : 0;
    const valuation = Math.max(0, Math.round(currentStock * weightedAverageCost * 100) / 100);

    return {
        itemId: numId,
        currentStock,
        totalInwardQty: Math.round(totalInwardQty * 100) / 100,
        totalOutwardQty: Math.round(totalOutwardQty * 100) / 100,
        weightedAverageCost,
        valuation
    };
}

/**
 * Inventory Valuation Report across items (scoped by businessId)
 */
async function getInventoryValuationReport(options = {}) {
    const asOfDate = typeof options === 'object' && options !== null ? options.asOfDate : options;
    const businessId = typeof options === 'object' && options !== null && options.businessId ? parseInt(options.businessId, 10) : null;

    const where = { active: true };
    if (businessId) where.businessId = businessId;

    const items = await prisma.item.findMany({
        where,
        orderBy: { name: 'asc' }
    });

    const report = [];
    let grandTotalValuation = 0;
    let totalItemsInStock = 0;

    for (const item of items) {
        const summary = await getItemStockSummary(item.id, asOfDate);
        report.push({
            itemId: item.id,
            name: item.name,
            unit: item.unit,
            rate: parseFloat(item.rate),
            currentStock: summary.currentStock,
            weightedAverageCost: summary.weightedAverageCost,
            valuation: summary.valuation
        });
        grandTotalValuation += summary.valuation;
        if (summary.currentStock > 0) totalItemsInStock++;
    }

    return {
        asOfDate: asOfDate ? new Date(asOfDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
        totalItemsCount: items.length,
        totalItemsInStock,
        grandTotalValuation: Math.round(grandTotalValuation * 100) / 100,
        items: report
    };
}

/**
 * List stock movements with filtering & pagination
 */
async function listStockMovements({ businessId, itemId, movementType, referenceType, dateFrom, dateTo, page = 1, limit = 20 } = {}) {
    const where = {};
    if (businessId) where.businessId = parseInt(businessId, 10);
    if (itemId) where.itemId = parseInt(itemId, 10);
    if (movementType) where.movementType = movementType;
    if (referenceType) where.referenceType = referenceType;
    if (dateFrom || dateTo) {
        where.movementDate = {};
        if (dateFrom) where.movementDate.gte = new Date(dateFrom);
        if (dateTo) where.movementDate.lte = new Date(dateTo);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.stockMovement.count({ where }),
        prisma.stockMovement.findMany({
            where,
            include: {
                item: true,
                createdBy: { select: { id: true, name: true, email: true } }
            },
            orderBy: [{ movementDate: 'desc' }, { id: 'desc' }],
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

/**
 * Post an authorized stock movement to the double-entry accounting ledger.
 * For OUTWARD movements (e.g. ISSUE for production, sale, project):
 *   Dr COGS (Account 5110)
 *   Cr Inventory Asset (Account 1141)
 * Reconciles inventory balance on balance sheet with physical stock valuation.
 */
async function postStockMovementToLedger({ movementId, debitAccountKey = 'COGS', creditAccountKey = 'INVENTORY_ASSET', notes = null }, userId) {
    const numId = parseInt(movementId, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid stock movement ID.');

    const movement = await prisma.stockMovement.findUnique({
        where: { id: numId },
        include: { item: true }
    });
    if (!movement) throw new NotFoundError(`Stock movement with ID ${numId} not found.`);

    const idempotencyKey = `STOCK_MOVEMENT:${movement.id}`;
    const existing = await prisma.journalEntry.findUnique({ where: { idempotencyKey } });
    if (existing) {
        throw new ConflictError(`Stock movement ${movement.movementNumber} has already been posted to the general ledger (Journal #${existing.entryNumber}).`);
    }

    const fy = await ensureFinancialYear(movement.movementDate, movement.businessId || movement.item?.businessId);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot post stock movement into closed Financial Year ${fy.code}.`);
    }

    await ensureSystemAccounts(userId);

    const costAmount = Math.round(parseFloat(movement.totalCost) * 100) / 100;
    if (costAmount <= 0) {
        throw new ValidationError('Cannot post stock movement with zero total cost.');
    }

    return prisma.$transaction(async (tx) => {
        const isOutward = OUTWARD_TYPES.includes(movement.movementType) || 
                          (movement.movementType === 'ADJUSTMENT' && parseFloat(movement.quantity) < 0);

        const drKey = isOutward ? debitAccountKey : creditAccountKey;
        const crKey = isOutward ? creditAccountKey : debitAccountKey;

        const drAccount = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: drKey } });
        const crAccount = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: crKey } });

        if (!drAccount || !crAccount) {
            throw new Error(`Required ledger accounts (${drKey}, ${crKey}) not found in Chart of Accounts.`);
        }

        const journalLines = [
            {
                accountId: drAccount.id,
                debit: costAmount,
                credit: 0,
                description: `${movement.movementType} ${Math.abs(parseFloat(movement.quantity))} ${movement.item.unit || 'units'} of ${movement.item.name} - ${movement.movementNumber}`
            },
            {
                accountId: crAccount.id,
                debit: 0,
                credit: costAmount,
                description: `Inventory Asset Adjustment for ${movement.item.name} - ${movement.movementNumber}`
            }
        ];

        const journal = await journalService.postJournalEntry({
            businessId: movement.businessId || movement.item?.businessId,
            entryDate: movement.movementDate,
            financialYearId: fy.id,
            sourceType: 'STOCK_MOVEMENT',
            sourceId: movement.id,
            idempotencyKey,
            narration: notes || `Stock Movement ${movement.movementNumber} (${movement.movementType} for ${movement.item.name}, Cost: ₹${costAmount})`,
            lines: journalLines,
            userId
        }, tx);

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'POST',
                module: 'INVENTORY',
                targetType: 'STOCK_MOVEMENT',
                targetId: movement.id,
                description: `Posted stock movement ${movement.movementNumber} to GL Journal #${journal.entryNumber} (Cost: ₹${costAmount})`
            });
        }

        return { movement, journalEntry: journal };
    });
}

module.exports = {
    recordStockMovement,
    postStockMovementToLedger,
    getItemStockSummary,
    getInventoryValuationReport,
    listStockMovements,
    VALID_MOVEMENT_TYPES,
    INWARD_TYPES,
    OUTWARD_TYPES,
    ValidationError,
    NotFoundError,
    ConflictError
};

