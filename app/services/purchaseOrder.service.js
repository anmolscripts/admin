'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');
const businessService = require('./business.service');
const numberingService = require('./numbering.service');

/**
 * Generates an atomic, sequential Purchase Order Number (e.g. PO/2026/10/1).
 */
async function generatePurchaseOrderNumber(tx, orderDate = new Date(), businessId) {
    let rawBizId = businessId;
    if (!rawBizId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
        rawBizId = 1;
    }
    if (!rawBizId || isNaN(parseInt(rawBizId, 10)) || parseInt(rawBizId, 10) <= 0) {
        throw new ValidationError('A valid businessId is required for purchase order number generation.');
    }
    const activeBusinessId = parseInt(rawBizId, 10);
    return await numberingService.allocateNumber({
        businessId: activeBusinessId,
        entityType: 'PURCHASE_ORDER',
        date: orderDate,
        tx
    });
}

/**
 * Validate and sanitize line items for a purchase order.
 */
function sanitizeOrderItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError('At least one order line item is required.');
    }

    return items.map((item, idx) => {
        const name = (item.name || '').trim();
        if (!name) throw new ValidationError(`Item name is required for line ${idx + 1}.`);

        const quantity = parseFloat(item.quantity);
        if (isNaN(quantity) || quantity <= 0) {
            throw new ValidationError(`Quantity must be greater than 0 for line ${idx + 1}.`);
        }

        const rate = parseFloat(item.rate);
        if (isNaN(rate) || rate < 0) {
            throw new ValidationError(`Rate must be non-negative for line ${idx + 1}.`);
        }

        const amount = Math.round(quantity * rate * 100) / 100;
        const pId = item.projectId ? parseInt(item.projectId, 10) : null;

        return {
            lineNumber: idx + 1,
            name,
            hsnSac: item.hsnSac ? String(item.hsnSac).trim() : null,
            quantity,
            unit: item.unit ? String(item.unit).trim() : 'PCS',
            rate,
            amount,
            projectId: pId && !isNaN(pId) && pId > 0 ? pId : null
        };
    });
}

/**
 * Create a new Purchase Order.
 * CRITICAL ACCOUNTING INVARIANT:
 * Creating or approving a Purchase Order does NOT create an expense or accounts payable liability.
 * It is purely a procurement commitment document.
 */
async function createPurchaseOrder(data = {}, userId) {
    let rawBizId = data.businessId;
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
        throw new ValidationError('A valid businessId is required to create a purchase order.');
    }
    const activeBusinessId = parseInt(rawBizId, 10);

    if (!data.supplierId) throw new ValidationError('Supplier ID is required.');
    const supplierId = parseInt(data.supplierId, 10);
    if (isNaN(supplierId) || supplierId <= 0) throw new ValidationError('Invalid supplier ID.');

    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundError(`Supplier with ID ${supplierId} not found.`);
    if (supplier.businessId && supplier.businessId !== activeBusinessId) {
        throw new ValidationError(`Supplier ${supplierId} does not belong to authorized business ${activeBusinessId}. Cross-business access denied.`);
    }

    const orderDate = data.orderDate ? new Date(data.orderDate) : new Date();
    if (isNaN(orderDate.getTime())) throw new ValidationError('Invalid order date.');

    let projectId = null;
    if (data.projectId) {
        projectId = parseInt(data.projectId, 10);
        if (isNaN(projectId) || projectId <= 0) throw new ValidationError('Invalid project ID.');
        const project = await prisma.project.findFirst({ where: { id: projectId, businessId: activeBusinessId } });
        if (!project) throw new NotFoundError(`Project with ID ${projectId} not found in this organization.`);
    }

    const sanitizedItems = sanitizeOrderItems(data.items);
    const fy = await ensureFinancialYear(orderDate, activeBusinessId);

    return prisma.$transaction(async (tx) => {
        const orderNumber = data.orderNumber && data.orderNumber.trim()
            ? data.orderNumber.trim()
            : await generatePurchaseOrderNumber(tx, orderDate, activeBusinessId);

        // Check uniqueness within business
        const existing = await tx.purchaseOrder.findFirst({
            where: { businessId: activeBusinessId, orderNumber }
        });
        if (existing) throw new ConflictError(`Purchase Order number '${orderNumber}' already exists.`);

        const po = await tx.purchaseOrder.create({
            data: {
                businessId: activeBusinessId,
                orderNumber,
                supplierId: supplier.id,
                supplierName: supplier.name,
                supplierGSTIN: supplier.gstin || null,
                placeOfSupplyStateCode: data.placeOfSupplyStateCode || supplier.stateCode || null,
                termsAndConditions: data.termsAndConditions || null,
                remarks: data.remarks || null,
                orderDate,
                dueDate: data.dueDate ? new Date(data.dueDate) : null,
                status: 'ACTIVE',
                projectId,
                financialYearId: fy.id,
                createdById: userId,
                updatedById: userId,
                version: 1,
                items: {
                    create: sanitizedItems
                }
            },
            include: { items: true, supplier: true, project: true }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                businessId: activeBusinessId,
                action: 'CREATE',
                module: 'PURCHASES',
                targetType: 'PURCHASE_ORDER',
                targetId: po.id,
                description: `Created Purchase Order ${po.orderNumber} for supplier ${supplier.name}`
            });
        }

        return {
            ...po,
            items: (po.items || []).map(it => ({
                ...it,
                receivedQuantity: 0,
                remainingQuantity: parseFloat(it.quantity) || 0,
                receiptStatus: 'NOT_RECEIVED'
            }))
        };
    });
}

async function getPurchaseOrderById(id, businessId = null) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid Purchase Order ID.');
    const where = { id: numId };
    if (businessId) where.businessId = Number(businessId);

    const po = await prisma.purchaseOrder.findFirst({
        where,
        include: {
            items: true,
            supplier: true,
            financialYear: true,
            project: { select: { id: true, code: true, name: true } },
            goodsReceipts: {
                where: { status: { not: 'CANCELLED' } },
                include: { items: true }
            }
        }
    });
    if (!po) throw new NotFoundError(`Purchase Order with ID ${numId} not found.`);

    // Annotate line items with received & remaining quantities
    const enrichedItems = po.items.map(item => {
        const ordered = parseFloat(item.quantity) || 0;
        let received = 0;
        if (po.goodsReceipts) {
            for (const gr of po.goodsReceipts) {
                for (const gri of gr.items) {
                    if (gri.purchaseOrderItemId === item.id) {
                        received += parseFloat(gri.receivedQuantity) || 0;
                    }
                }
            }
        }
        received = Math.round(received * 100) / 100;
        const remaining = Math.max(0, Math.round((ordered - received) * 100) / 100);
        let receiptStatus = 'NOT_RECEIVED';
        if (received >= ordered - 0.001 && ordered > 0) receiptStatus = 'RECEIVED';
        else if (received > 0) receiptStatus = 'PARTIALLY_RECEIVED';

        return {
            ...item,
            receivedQuantity: received,
            remainingQuantity: remaining,
            receiptStatus
        };
    });

    return {
        ...po,
        items: enrichedItems
    };
}

async function listPurchaseOrders({ businessId, supplierId, projectId, status, dateFrom, dateTo, search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (businessId) where.businessId = Number(businessId);
    if (supplierId) where.supplierId = parseInt(supplierId, 10);
    if (projectId) where.projectId = parseInt(projectId, 10);
    if (status) where.status = status;
    if (dateFrom || dateTo) {
        where.orderDate = {};
        if (dateFrom) where.orderDate.gte = new Date(dateFrom);
        if (dateTo) where.orderDate.lte = new Date(dateTo);
    }
    if (search) {
        where.OR = [
            { orderNumber: { contains: search } },
            { supplierName: { contains: search } }
        ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.purchaseOrder.count({ where }),
        prisma.purchaseOrder.findMany({
            where,
            include: {
                supplier: true,
                items: true,
                project: { select: { id: true, code: true, name: true } }
            },
            orderBy: { orderDate: 'desc' },
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

async function updatePurchaseOrder(id, data = {}, userId) {
    const existing = await getPurchaseOrderById(id);
    if (['VOID', 'DELETED'].includes(existing.status)) {
        throw new ValidationError(`Cannot update Purchase Order in ${existing.status} status.`);
    }

    let supplierUpdate = {};
    if (data.supplierId && data.supplierId !== existing.supplierId) {
        const supplier = await prisma.supplier.findUnique({ where: { id: parseInt(data.supplierId, 10) } });
        if (!supplier) throw new NotFoundError(`Supplier with ID ${data.supplierId} not found.`);
        supplierUpdate = {
            supplierId: supplier.id,
            supplierName: supplier.name,
            supplierGSTIN: supplier.gstin
        };
    }

    return prisma.$transaction(async (tx) => {
        if (data.items) {
            const sanitizedItems = sanitizeOrderItems(data.items);
            await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: existing.id } });
            await tx.purchaseOrderItem.createMany({
                data: sanitizedItems.map(item => ({ ...item, purchaseOrderId: existing.id }))
            });
        }

        let projectUpdate = {};
        if (data.projectId !== undefined) {
            if (data.projectId === null || data.projectId === '' || data.projectId === 0) {
                projectUpdate = { projectId: null };
            } else {
                const pId = parseInt(data.projectId, 10);
                const proj = await tx.project.findFirst({ where: { id: pId, businessId: existing.businessId } });
                if (!proj) throw new NotFoundError(`Project #${pId} not found in this organization.`);
                projectUpdate = { projectId: pId };
            }
        }

        const updated = await tx.purchaseOrder.update({
            where: { id: existing.id },
            data: {
                ...supplierUpdate,
                ...projectUpdate,
                termsAndConditions: data.termsAndConditions !== undefined ? data.termsAndConditions : existing.termsAndConditions,
                remarks: data.remarks !== undefined ? data.remarks : existing.remarks,
                dueDate: data.dueDate ? new Date(data.dueDate) : existing.dueDate,
                updatedById: userId,
                version: { increment: 1 }
            },
            include: { items: true, supplier: true, project: true }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'UPDATE',
                module: 'PURCHASES',
                targetType: 'PURCHASE_ORDER',
                targetId: updated.id,
                description: `Updated Purchase Order ${updated.orderNumber}`
            });
        }

        return updated;
    });
}

async function voidPurchaseOrder(id, userId, reason = '') {
    const existing = await getPurchaseOrderById(id);
    if (existing.status === 'VOID') throw new ConflictError('Purchase Order is already VOID.');

    const updated = await prisma.purchaseOrder.update({
        where: { id: existing.id },
        data: {
            status: 'VOID',
            remarks: reason ? `${existing.remarks || ''}\n[VOID REASON]: ${reason}`.trim() : existing.remarks,
            updatedById: userId,
            version: { increment: 1 }
        }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'VOID',
            module: 'PURCHASES',
            targetType: 'PURCHASE_ORDER',
            targetId: updated.id,
            description: `Voided Purchase Order ${updated.orderNumber}. Reason: ${reason}`
        });
    }

    return updated;
}

async function deletePurchaseOrder(id, userId) {
    const existing = await getPurchaseOrderById(id);
    if (existing.status === 'DELETED') throw new ConflictError('Purchase Order is already deleted.');

    const updated = await prisma.purchaseOrder.update({
        where: { id: existing.id },
        data: {
            status: 'DELETED',
            updatedById: userId,
            version: { increment: 1 }
        }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'DELETE',
            module: 'PURCHASES',
            targetType: 'PURCHASE_ORDER',
            targetId: updated.id,
            description: `Soft-deleted Purchase Order ${updated.orderNumber}`
        });
    }

    return updated;
}

module.exports = {
    createPurchaseOrder,
    getPurchaseOrderById,
    listPurchaseOrders,
    updatePurchaseOrder,
    voidPurchaseOrder,
    deletePurchaseOrder,
    generatePurchaseOrderNumber,
    ValidationError,
    NotFoundError,
    ConflictError
};
