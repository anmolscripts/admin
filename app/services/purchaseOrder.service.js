'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');
const businessService = require('./business.service');
const numberingService = require('./numbering.service');
const businessProfileService = require('./businessProfile.service');

const ALLOWED_GST_RATES = [0, 5, 12, 18, 28];
const money = value => Math.round((Number(value) || 0) * 100) / 100;

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
function sanitizeOrderItems(items, isInterState = false) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError('At least one order line item is required.');
    }

    return items.map((item, idx) => {
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!name) throw new ValidationError(`Item name is required for line ${idx + 1}.`);

        const rawQuantity = Number(item.quantity);
        if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) {
            throw new ValidationError(`Quantity must be greater than 0 for line ${idx + 1}.`);
        }
        const quantity = money(rawQuantity);
        if (quantity <= 0) throw new ValidationError(`Quantity must be at least 0.01 for line ${idx + 1}.`);

        const rawRate = Number(item.rate);
        if (!Number.isFinite(rawRate) || rawRate < 0) {
            throw new ValidationError(`Rate must be non-negative for line ${idx + 1}.`);
        }
        const rate = money(rawRate);

        const amount = money(quantity * rate);
        const rawDiscountAmount = item.discountAmount === undefined || item.discountAmount === '' ? 0 : Number(item.discountAmount);
        if (!Number.isFinite(rawDiscountAmount) || rawDiscountAmount < 0) {
            throw new ValidationError(`Discount must be non-negative for line ${idx + 1}.`);
        }
        const discountAmount = money(rawDiscountAmount);
        if (discountAmount > amount) throw new ValidationError(`Discount cannot exceed amount for line ${idx + 1}.`);
        const taxableAmount = money(amount - discountAmount);
        const gstRate = item.gstRate === undefined || item.gstRate === '' ? 0 : Number(item.gstRate);
        if (!Number.isFinite(gstRate) || !ALLOWED_GST_RATES.includes(gstRate)) throw new ValidationError(`Invalid GST rate for line ${idx + 1}. Allowed rates are: ${ALLOWED_GST_RATES.join('%, ')}%.`);
        const tax = money(taxableAmount * gstRate / 100);
        const cgstAmount = isInterState ? 0 : money(tax / 2);
        const sgstAmount = isInterState ? 0 : money(tax - cgstAmount);
        const igstAmount = isInterState ? tax : 0;
        const pId = item.projectId ? parseInt(item.projectId, 10) : null;

        return {
            lineNumber: idx + 1,
            name,
            hsnSac: item.hsnSac ? String(item.hsnSac).trim() : null,
            quantity,
            unit: item.unit ? String(item.unit).trim() : 'PCS',
            rate,
            amount,
            discountAmount,
            taxableAmount,
            gstRate,
            cgstAmount,
            sgstAmount,
            igstAmount,
            totalAmount: money(taxableAmount + tax),
            projectId: pId && !isNaN(pId) && pId > 0 ? pId : null
        };
    });
}

function calculatePurchaseOrderTotals(items) {
    const totals = items.reduce((sum, item) => ({
        taxableSubtotal: sum.taxableSubtotal + item.taxableAmount,
        cgstAmount: sum.cgstAmount + item.cgstAmount,
        sgstAmount: sum.sgstAmount + item.sgstAmount,
        igstAmount: sum.igstAmount + item.igstAmount
    }), { taxableSubtotal: 0, cgstAmount: 0, sgstAmount: 0, igstAmount: 0 });
    totals.taxableSubtotal = money(totals.taxableSubtotal);
    totals.cgstAmount = money(totals.cgstAmount);
    totals.sgstAmount = money(totals.sgstAmount);
    totals.igstAmount = money(totals.igstAmount);
    totals.totalTaxAmount = money(totals.cgstAmount + totals.sgstAmount + totals.igstAmount);
    totals.totalAmount = money(totals.taxableSubtotal + totals.totalTaxAmount);
    return totals;
}

async function getPurchaseTaxContext(businessId, supplier) {
    const profile = await businessProfileService.getProfile(businessId);
    const businessStateCode = String(profile?.stateCode || profile?.gstin?.slice(0, 2) || '').trim();
    const supplierStateCode = String(supplier?.stateCode || supplier?.gstin?.slice(0, 2) || '').trim();
    return resolvePurchaseTaxContext(businessStateCode, supplierStateCode);
}

function resolvePurchaseTaxContext(businessStateCode, supplierStateCode) {
    const sellerState = String(businessStateCode || '').trim();
    const supplierState = String(supplierStateCode || '').trim();
    return {
        businessStateCode: sellerState,
        supplierStateCode: supplierState,
        // Match the invoice and supplier-bill convention: missing state codes default to intra-state.
        isInterState: Boolean(sellerState && supplierState && sellerState !== supplierState)
    };
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

    const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, businessId: activeBusinessId } });
    if (!supplier) throw new NotFoundError(`Supplier with ID ${supplierId} not found.`);
    if (!supplier.active) throw new ValidationError('Inactive suppliers cannot be selected for a new purchase order.');

    const orderDate = data.orderDate ? new Date(data.orderDate) : new Date();
    if (isNaN(orderDate.getTime())) throw new ValidationError('Invalid order date.');

    let projectId = null;
    if (data.projectId) {
        projectId = parseInt(data.projectId, 10);
        if (isNaN(projectId) || projectId <= 0) throw new ValidationError('Invalid project ID.');
        const project = await prisma.project.findFirst({ where: { id: projectId, businessId: activeBusinessId } });
        if (!project) throw new NotFoundError(`Project with ID ${projectId} not found in this organization.`);
    }

    const taxContext = await getPurchaseTaxContext(activeBusinessId, supplier);
    const sanitizedItems = sanitizeOrderItems(data.items, taxContext.isInterState);
    const totals = calculatePurchaseOrderTotals(sanitizedItems);
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
                placeOfSupplyStateCode: taxContext.supplierStateCode || null,
                ...totals,
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
        if (dateFrom) where.orderDate.gte = new Date(/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? dateFrom + 'T00:00:00' : dateFrom);
        if (dateTo) where.orderDate.lte = new Date(/^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? dateTo + 'T23:59:59.999' : dateTo);
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
                goodsReceipts: { where: { status: { not: 'CANCELLED' } }, include: { items: true } },
                project: { select: { id: true, code: true, name: true } }
            },
            orderBy: { orderDate: 'desc' },
            skip,
            take: pageSize
        })
    ]);

    const enriched = records.map(po => {
        const storedTotal = Number(po.totalAmount) || 0;
        const legacySubtotal = po.items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
        const hasTaxSnapshots = po.items.some(item =>
            Number(item.taxableAmount) > 0 ||
            Number(item.discountAmount) > 0 ||
            Number(item.gstRate) > 0 ||
            Number(item.cgstAmount) > 0 ||
            Number(item.sgstAmount) > 0 ||
            Number(item.igstAmount) > 0 ||
            Number(item.totalAmount) > 0
        );
        const orderTotal = hasTaxSnapshots ? storedTotal : legacySubtotal;
        const orderedQuantity = po.items.reduce((sum, item) => sum + (parseFloat(item.quantity) || 0), 0);
        const receivedQuantity = po.goodsReceipts.reduce((sum, receipt) => sum + receipt.items.reduce((lineSum, item) => lineSum + (parseFloat(item.receivedQuantity) || 0), 0), 0);
        return {
            ...po,
            orderTotal: Math.round(orderTotal * 100) / 100,
            receiptProgress: { orderedQuantity, receivedQuantity, remainingQuantity: Math.max(0, orderedQuantity - receivedQuantity) }
        };
    });
    return { total, page: pageNum, limit: pageSize, records: enriched };
}

async function updatePurchaseOrder(id, data = {}, userId, businessId = null) {
    if (!businessId) throw new ValidationError('Authorized business context is required to update a purchase order.');
    const existing = await getPurchaseOrderById(id, businessId);
    if (existing.status !== 'ACTIVE') {
        throw new ValidationError(`Cannot update Purchase Order in ${existing.status} status.`);
    }

    let supplier = existing.supplier;
    let supplierUpdate = {};
    const hasSupplierId = data.supplierId !== undefined && data.supplierId !== null && data.supplierId !== '';
    const requestedSupplierId = hasSupplierId ? parseInt(data.supplierId, 10) : existing.supplierId;
    if (hasSupplierId && (!requestedSupplierId || isNaN(requestedSupplierId))) throw new ValidationError('Invalid supplier ID.');
    const supplierChanged = hasSupplierId && requestedSupplierId !== existing.supplierId;
    if (supplierChanged) {
        supplier = await prisma.supplier.findFirst({
            where: { id: requestedSupplierId, businessId: existing.businessId }
        });
        if (!supplier) throw new NotFoundError(`Supplier with ID ${data.supplierId} not found.`);
        if (!supplier.active) throw new ValidationError('Inactive suppliers cannot be selected for a purchase order.');
        supplierUpdate = {
            supplierId: supplier.id,
            supplierName: supplier.name,
            supplierGSTIN: supplier.gstin || null
        };
    }

    const taxContext = await getPurchaseTaxContext(existing.businessId, supplierChanged ? supplier : {
        stateCode: existing.placeOfSupplyStateCode || supplier?.stateCode,
        gstin: existing.supplierGSTIN || supplier?.gstin
    });
    const sourceItems = data.items || existing.items;
    const sanitizedItems = sanitizeOrderItems(sourceItems, taxContext.isInterState);
    const totals = calculatePurchaseOrderTotals(sanitizedItems);

    return prisma.$transaction(async (tx) => {
        const receiptCount = await tx.goodsReceipt.count({ where: { purchaseOrderId: existing.id, status: { not: 'CANCELLED' } } });
        if (data.items && receiptCount > 0) {
            throw new ValidationError('Purchase-order lines cannot be replaced after goods receipts exist. Use a correction workflow instead.');
        }
        if ((supplierChanged || data.projectId !== undefined) && receiptCount > 0) {
            throw new ValidationError('Supplier or project allocation cannot be changed after goods receipts exist.');
        }
        if (data.items || supplierChanged) {
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
                placeOfSupplyStateCode: taxContext.supplierStateCode || null,
                ...totals,
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

async function voidPurchaseOrder(id, userId, reason = '', businessId = null) {
    if (!businessId) throw new ValidationError('Authorized business context is required to void a purchase order.');
    const existing = await getPurchaseOrderById(id, businessId);
    if (existing.status === 'VOID') throw new ConflictError('Purchase Order is already VOID.');
    const receiptCount = await prisma.goodsReceipt.count({ where: { purchaseOrderId: existing.id, status: { not: 'CANCELLED' } } });
    if (receiptCount > 0) throw new ValidationError('A purchase order with goods receipts cannot be voided. Use a documented correction workflow.');

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
    sanitizeOrderItems,
    calculatePurchaseOrderTotals,
    resolvePurchaseTaxContext,
    ValidationError,
    NotFoundError,
    ConflictError
};
