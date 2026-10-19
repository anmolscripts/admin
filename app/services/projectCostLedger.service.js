'use strict';

const prisma = require('../config/prisma');
const { ValidationError, NotFoundError } = require('./errorTypes');

/**
 * Valid cost categories and source types
 */
const COST_CATEGORIES = ['MATERIALS', 'LABOUR', 'SUBCONTRACTOR', 'EQUIPMENT', 'EXPENSE', 'OTHER'];
const SOURCE_TYPES = ['SUPPLIER_BILL', 'STOCK_MOVEMENT', 'TIMESHEET', 'DAILY_LABOUR', 'CONTRACTOR_ORDER', 'EXPENSE', 'REIMBURSEMENT', 'PURCHASE_ORDER', 'MANUAL'];

/**
 * Idempotently post or update a project cost entry in the subledger.
 */
async function recordCost({
    businessId,
    projectId,
    category = 'OTHER',
    costType = 'EXPENSE',
    sourceType,
    sourceId,
    sourceLineId = 0,
    sourceReference = null,
    amount,
    quantity = null,
    unit = null,
    unitCost = null,
    taxAmount = 0,
    isTaxRecoverable = true,
    status = 'POSTED',
    costDate = new Date(),
    description = null,
    journalEntryId = null,
    createdById = null
}, tx = prisma) {
    if (!businessId || isNaN(Number(businessId))) {
        throw new ValidationError('Authorized businessId is required for cost recording');
    }
    if (!projectId || isNaN(Number(projectId))) {
        throw new ValidationError('Valid projectId is required for cost recording');
    }

    const bId = Number(businessId);
    const pId = Number(projectId);
    const sId = Number(sourceId);
    const sLineId = Number(sourceLineId) || 0;
    const numAmount = Math.round(parseFloat(amount) * 100) / 100;

    if (isNaN(numAmount)) {
        throw new ValidationError('Cost amount must be a valid number');
    }

    // Verify project belongs to tenant
    const project = await tx.project.findFirst({
        where: { id: pId, businessId: bId }
    });
    if (!project) {
        throw new NotFoundError(`Project #${pId} not found or does not belong to authorized business #${bId}`);
    }

    const cat = COST_CATEGORIES.includes(category) ? category : 'OTHER';
    const sType = SOURCE_TYPES.includes(sourceType) ? sourceType : 'MANUAL';
    const cDate = costDate ? new Date(costDate) : new Date();

    const createPayload = {
        business: { connect: { id: bId } },
        project: { connect: { id: pId } },
        category: cat,
        costType: String(costType || cat),
        sourceType: sType,
        sourceId: sId,
        sourceLineId: sLineId,
        sourceReference: sourceReference ? String(sourceReference).trim() : `${sType}:${sId}:${sLineId}`,
        amount: numAmount,
        quantity: quantity !== null && quantity !== undefined ? parseFloat(quantity) : null,
        unit: unit ? String(unit).trim() : null,
        unitCost: unitCost !== null && unitCost !== undefined ? parseFloat(unitCost) : null,
        taxAmount: parseFloat(taxAmount) || 0,
        isTaxRecoverable: Boolean(isTaxRecoverable),
        status: status || 'POSTED',
        costDate: isNaN(cDate.getTime()) ? new Date() : cDate,
        description: description ? String(description).trim() : null,
        createdById: createdById ? Number(createdById) : null
    };
    if (journalEntryId) {
        createPayload.journalEntry = { connect: { id: Number(journalEntryId) } };
    }

    // Idempotent upsert by composite key
    const cost = await tx.projectCost.upsert({
        where: {
            businessId_sourceType_sourceId_sourceLineId: {
                businessId: bId,
                sourceType: sType,
                sourceId: sId,
                sourceLineId: sLineId
            }
        },
        create: createPayload,
        update: {
            amount: numAmount,
            quantity: createPayload.quantity,
            unit: createPayload.unit,
            unitCost: createPayload.unitCost,
            taxAmount: createPayload.taxAmount,
            isTaxRecoverable: createPayload.isTaxRecoverable,
            status: createPayload.status,
            costDate: createPayload.costDate,
            description: createPayload.description
        }
    });

    return cost;
}

/**
 * Void or reverse a cost entry in the subledger.
 */
async function voidCost(firstArg, secondArg, thirdArg, fourthArg, txArg) {
    let bId, sType, sId, sLineId, tx;

    if (typeof firstArg === 'object' && firstArg !== null) {
        bId = Number(firstArg.businessId);
        sType = String(firstArg.sourceType);
        sId = Number(firstArg.sourceId);
        sLineId = Number(firstArg.sourceLineId) || 0;
        tx = secondArg || prisma;
    } else {
        bId = Number(firstArg);
        sType = String(secondArg);
        sId = Number(thirdArg);
        sLineId = Number(fourthArg) || 0;
        tx = txArg || prisma;
    }

    const existing = await tx.projectCost.findUnique({
        where: {
            businessId_sourceType_sourceId_sourceLineId: {
                businessId: bId,
                sourceType: sType,
                sourceId: sId,
                sourceLineId: sLineId
            }
        }
    });

    if (existing) {
        return tx.projectCost.update({
            where: { id: existing.id },
            data: { status: 'VOID' }
        });
    }

    return null;
}

/**
 * List cost entries for a project with strict tenant scoping.
 */
async function listProjectCosts(projectId, businessId, { category, status = 'POSTED', page = 1, limit = 50 } = {}) {
    const bId = Number(businessId);
    const pId = Number(projectId);

    const where = {
        businessId: bId,
        projectId: pId
    };
    if (category) where.category = category;
    if (status) where.status = status;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.projectCost.count({ where }),
        prisma.projectCost.findMany({
            where,
            orderBy: [{ costDate: 'desc' }, { id: 'desc' }],
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

module.exports = {
    COST_CATEGORIES,
    SOURCE_TYPES,
    recordCost,
    voidCost,
    voidCostAllocation: voidCost,
    listProjectCosts
};
