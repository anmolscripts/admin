'use strict';

const prisma = require('../config/prisma');
const crypto = require('node:crypto');
const receiptInclude={items:{include:{stockMovement:true,purchaseOrderItem:true,item:true}},purchaseOrder:true,project:true,supplier:true,receivedBy:{select:{id:true,name:true,email:true}}};
function canonical(value) { if(Array.isArray(value))return value.map(canonical); if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])]));return value; }
const activityService = require('./activity.service');
const numberingService = require('./numbering.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');
const businessService = require('./business.service');

/**
 * Generate sequential Goods Receipt Number: GRN/YYYY/MM/INCREMENT
 */
async function generateReceiptNumber(tx, receiptDate = new Date(), businessId) {
    let rawBizId = businessId;
    if (!rawBizId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
        rawBizId = 1;
    }
    if (!rawBizId || isNaN(parseInt(rawBizId, 10)) || parseInt(rawBizId, 10) <= 0) {
        throw new ValidationError('A valid businessId is required for goods receipt numbering.');
    }
    const activeBusinessId = parseInt(rawBizId, 10);
    return await numberingService.allocateNumber({
        businessId: activeBusinessId,
        entityType: 'GOODS_RECEIPT',
        date: receiptDate,
        tx
    });
}

/**
 * Creates and posts a Goods Receipt (GRN) against PO lines or direct store receipt.
 *
 * CRITICAL ACCOUNTING INVARIANT:
 * A Goods Receipt records physical goods acceptance and stock subledger entry.
 * It does NOT recognize financial expense or supplier accounts payable liability
 * (that occurs on Supplier Bill posting to prevent double counting).
 */
async function createGoodsReceipt(data = {}, userId, authorizedBusinessId) {
    let rawBizId = authorizedBusinessId || data.businessId;
    if (!rawBizId && userId) {
        try {
            const accessible = await businessService.getUserAccessibleBusinesses(userId);
            if (accessible.length === 1) rawBizId = accessible[0].id;
        } catch (_) {}
    }
    if (!rawBizId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
        rawBizId = 1;
    }
    if (!rawBizId || isNaN(parseInt(rawBizId, 10)) || parseInt(rawBizId, 10) <= 0) {
        throw new ValidationError('A valid businessId is required to record a goods receipt.');
    }
    const activeBusinessId = parseInt(rawBizId, 10);

    const receiptDate = data.receiptDate ? new Date(data.receiptDate) : new Date();
    if (isNaN(receiptDate.getTime())) throw new ValidationError('Invalid receipt date.');

    const storeLocation = (data.storeLocation || 'Main Warehouse').trim();
    const deliveryChallanNumber = data.deliveryChallanNumber ? String(data.deliveryChallanNumber).trim() : null;
    const notes = data.notes ? String(data.notes).trim() : null;

    const requestKey=data.idempotencyKey ? String(data.idempotencyKey).trim() : null;
    if(requestKey && !/^[A-Za-z0-9._:-]{8,100}$/.test(requestKey)) throw new ValidationError('Invalid receipt request key.');
    const fingerprint=Object.fromEntries(['purchaseOrderId','supplierId','supplierName','projectId','receiptNumber','receiptDate','storeLocation','deliveryChallanNumber','notes','items'].map(key=>[key,data[key]??null]));
    const requestHash=requestKey ? crypto.createHash('sha256').update(JSON.stringify(canonical(fingerprint))).digest('hex') : null;
    const execute = async (tx) => {
        // Keep a consistent business -> PO lock order for keyed and legacy requests.
        await tx.$queryRawUnsafe('SELECT id FROM businesses WHERE id = ? FOR UPDATE', activeBusinessId);
        if (typeof businessService.assertUserBusinessAccess === 'function') {
            await businessService.assertUserBusinessAccess(userId, activeBusinessId, activeBusinessId, tx);
        }
        if(requestKey) {
            const replay=await tx.goodsReceipt.findFirst({where:{businessId:activeBusinessId,requestKey},include:receiptInclude});
            if(replay) {
                if(replay.requestHash!==requestHash) throw new ConflictError('This request key was already used with different receipt details.');
                return replay;
            }
        }
        let purchaseOrder = null;
        let supplier = null;
        let supplierId = data.supplierId ? parseInt(data.supplierId, 10) : null;
        let supplierName = (data.supplierName || '').trim();
        let projectId = data.projectId ? parseInt(data.projectId, 10) : null;

        if (data.purchaseOrderId) {
            const poId = parseInt(data.purchaseOrderId, 10);
            await tx.$queryRawUnsafe('SELECT id FROM purchase_orders WHERE id = ? AND businessId = ? FOR UPDATE',poId,activeBusinessId);
            purchaseOrder = await tx.purchaseOrder.findFirst({
                where: { id: poId, businessId: activeBusinessId },
                include: { items: true, supplier: true }
            });
            if (!purchaseOrder) {
                throw new NotFoundError(`Purchase Order #${poId} not found in this organization.`);
            }
            if (purchaseOrder.status === 'VOID' || purchaseOrder.status === 'CANCELLED') {
                throw new ValidationError(`Cannot receive goods against ${purchaseOrder.status} Purchase Order.`);
            }
            if (purchaseOrder.status === 'RECEIVED') {
                throw new ValidationError(`Purchase Order ${purchaseOrder.orderNumber} is already fully received.`);
            }

            supplierId = purchaseOrder.supplierId;
            supplierName = purchaseOrder.supplierName;
            if (!projectId && purchaseOrder.projectId) {
                projectId = purchaseOrder.projectId;
            }
        } else {
            if (!supplierId) throw new ValidationError('Supplier is required for direct goods receipt.');
            supplier = await tx.supplier.findFirst({
                where: { id: supplierId, businessId: activeBusinessId }
            });
            if (!supplier) throw new NotFoundError(`Supplier #${supplierId} not found in this organization.`);
            supplierName = supplier.name;
        }

        if (projectId) {
            const project = await tx.project.findFirst({
                where: { id: projectId, businessId: activeBusinessId }
            });
            if (!project) throw new NotFoundError(`Project #${projectId} not found in this organization.`);
        }

        if (!Array.isArray(data.items) || data.items.length === 0) {
            throw new ValidationError('At least one receipt line item is required.');
        }

        // Validate receipt lines against PO remaining quantities if linked
        const validatedLines = [];
        const seenPoLines=new Set();
        for (let idx = 0; idx < data.items.length; idx++) {
            const line = data.items[idx];
            const lineNum = idx + 1;
            const name = (line.name || '').trim();
            if (!name) throw new ValidationError(`Item name is required for line ${lineNum}.`);

            const receivedQty = parseFloat(line.receivedQuantity);
            if (!Number.isFinite(receivedQty) || receivedQty <= 0) {
                throw new ValidationError(`Received quantity must be greater than 0 for line ${lineNum} (${name}).`);
            }

            const acceptedQty = line.acceptedQuantity !== undefined ? parseFloat(line.acceptedQuantity) : receivedQty;
            const rejectedQty = line.rejectedQuantity !== undefined ? parseFloat(line.rejectedQuantity) : 0;

            if (!Number.isFinite(acceptedQty) || acceptedQty < 0) {
                throw new ValidationError(`Accepted quantity must be non-negative for line ${lineNum}.`);
            }
            if (!Number.isFinite(rejectedQty) || rejectedQty < 0) {
                throw new ValidationError(`Rejected quantity must be non-negative for line ${lineNum}.`);
            }

            const totalReconciled = Math.round((acceptedQty + rejectedQty) * 100) / 100;
            const totalReceived = Math.round(receivedQty * 100) / 100;
            if (Math.abs(totalReconciled - totalReceived) > 0.01) {
                throw new ValidationError(
                    `Line ${lineNum} (${name}): Accepted (${acceptedQty}) + Rejected (${rejectedQty}) does not equal Received (${receivedQty}).`
                );
            }

            let poItem = null;
            let orderedQty = 0;
            if (line.purchaseOrderItemId && purchaseOrder) {
                const poItemId = parseInt(line.purchaseOrderItemId, 10);
                if(seenPoLines.has(poItemId)) throw new ValidationError('A purchase-order line may appear only once per receipt.');
                seenPoLines.add(poItemId);
                poItem = purchaseOrder.items.find(i => i.id === poItemId);
                if (!poItem) {
                    throw new ValidationError(`PO Item line #${poItemId} does not belong to Purchase Order #${purchaseOrder.id}.`);
                }
                orderedQty = parseFloat(poItem.quantity) || 0;

                // Compute previously received quantity for this PO line
                const pastReceiptItems = await tx.goodsReceiptItem.findMany({
                    where: {
                        purchaseOrderItemId: poItemId,
                        goodsReceipt: { status: { not: 'CANCELLED' } }
                    }
                });
                const previouslyReceived = pastReceiptItems.reduce((acc, it) => acc + (parseFloat(it.receivedQuantity) || 0), 0);
                const remainingAllowed = Math.round((orderedQty - previouslyReceived) * 100) / 100;

                if (receivedQty > remainingAllowed + 0.001) {
                    throw new ValidationError(
                        `Line ${lineNum} (${name}): Received quantity (${receivedQty}) exceeds remaining allowed quantity (${remainingAllowed}) against PO #${purchaseOrder.orderNumber}. Over-receipt blocked.`
                    );
                }
            }

            const unitCost = line.unitCost !== undefined ? parseFloat(line.unitCost) : (poItem ? parseFloat(poItem.rate) : 0);
            if(!Number.isFinite(unitCost) || unitCost<0) throw new ValidationError(`Invalid unit cost for line ${lineNum}.`);
            const totalCost = Math.round(acceptedQty * unitCost * 100) / 100;

            validatedLines.push({
                purchaseOrderItemId: poItem ? poItem.id : null,
                itemId: line.itemId ? parseInt(line.itemId, 10) : null,
                name,
                unit: line.unit ? String(line.unit).trim() : (poItem ? poItem.unit : 'PCS'),
                orderedQuantity: orderedQty,
                receivedQuantity: totalReceived,
                acceptedQuantity: acceptedQty,
                rejectedQuantity: rejectedQty,
                unitCost,
                totalCost
            });
        }


        const receiptNumber = data.receiptNumber && data.receiptNumber.trim()
            ? data.receiptNumber.trim()
            : await generateReceiptNumber(tx, receiptDate, activeBusinessId);

        const existing = await tx.goodsReceipt.findFirst({
            where: { businessId: activeBusinessId, receiptNumber }
        });
        if (existing) throw new ConflictError(`Goods Receipt number '${receiptNumber}' already exists.`);

        // 1. Create Goods Receipt Header
        const grn = await tx.goodsReceipt.create({
            data: {
                businessId: activeBusinessId,
                receiptNumber,
                requestKey,
                requestHash,
                purchaseOrderId: purchaseOrder ? purchaseOrder.id : null,
                supplierId,
                supplierName,
                deliveryChallanNumber,
                receiptDate,
                storeLocation,
                status: 'ACCEPTED',
                notes,
                projectId,
                receivedById: userId || 1
            }
        });

        // 2. Process each receipt line and auto-record stock movements for accepted items
        for (const line of validatedLines) {
            let stockMovementId = null;

            if (line.acceptedQuantity > 0) {
                // Find or match item in Item catalog
                let itemRecord = null;
                if (line.itemId) {
                    itemRecord = await tx.item.findFirst({ where: { id: line.itemId, businessId: activeBusinessId } });
                }
                if (!itemRecord) {
                    itemRecord = await tx.item.findFirst({ where: { name: line.name, businessId: activeBusinessId } });
                }

                if (itemRecord) {
                    const movementNumber = await numberingService.allocateNumber({
                        businessId: activeBusinessId,
                        entityType: 'STOCK_MOVEMENT',
                        date: receiptDate,
                        tx
                    });

                    const movement = await tx.stockMovement.create({
                        data: {
                            businessId: activeBusinessId,
                            movementNumber,
                            itemId: itemRecord.id,
                            movementType: 'RECEIPT',
                            quantity: line.acceptedQuantity,
                            unitCost: line.unitCost,
                            totalCost: line.totalCost,
                            referenceType: 'GOODS_RECEIPT',
                            referenceId: grn.id,
                            storeLocation,
                            movementDate: receiptDate,
                            notes: `GRN #${receiptNumber} - ${supplierName}${deliveryChallanNumber ? ` (Challan: ${deliveryChallanNumber})` : ''}`,
                            projectId,
                            createdById: userId || 1
                        }
                    });
                    stockMovementId = movement.id;
                }
            }

            await tx.goodsReceiptItem.create({
                data: {
                    goodsReceiptId: grn.id,
                    purchaseOrderItemId: line.purchaseOrderItemId,
                    itemId: line.itemId,
                    name: line.name,
                    unit: line.unit,
                    orderedQuantity: line.orderedQuantity,
                    receivedQuantity: line.receivedQuantity,
                    acceptedQuantity: line.acceptedQuantity,
                    rejectedQuantity: line.rejectedQuantity,
                    unitCost: line.unitCost,
                    totalCost: line.totalCost,
                    stockMovementId
                }
            });
        }

        // 3. Update Purchase Order status if linked
        if (purchaseOrder) {
            const allPoItems = await tx.purchaseOrderItem.findMany({
                where: { purchaseOrderId: purchaseOrder.id }
            });
            const allReceiptItems = await tx.goodsReceiptItem.findMany({
                where: {
                    purchaseOrderItemId: { in: allPoItems.map(i => i.id) },
                    goodsReceipt: { status: { not: 'CANCELLED' } }
                }
            });

            let allFulfilled = true;
            for (const poItem of allPoItems) {
                const totalRcvd = allReceiptItems
                    .filter(ri => ri.purchaseOrderItemId === poItem.id)
                    .reduce((acc, ri) => acc + (parseFloat(ri.receivedQuantity) || 0), 0);
                if (totalRcvd < (parseFloat(poItem.quantity) || 0) - 0.001) {
                    allFulfilled = false;
                    break;
                }
            }

            const newPoStatus = allFulfilled ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
            await tx.purchaseOrder.update({
                where: { id: purchaseOrder.id },
                data: { status: newPoStatus }
            });
        }

        // 4. Audit logging
        if (userId) {
            await activityService.log({
                actorUserId: userId,
                businessId: activeBusinessId,
                action: 'CREATE',
                module: 'PURCHASES',
                targetType: 'GOODS_RECEIPT',
                targetId: grn.id,
                description: `Created Goods Receipt ${grn.receiptNumber} from ${supplierName} (${validatedLines.length} lines)`
            }, tx);
        }

        return await tx.goodsReceipt.findUnique({
            where: { id: grn.id },
            include: {
                items: { include: { stockMovement: true, purchaseOrderItem: true, item: true } },
                purchaseOrder: true,
                project: true,
                supplier: true,
                receivedBy: { select: { id: true, name: true, email: true } }
            }
        });
    };
    for (let attempt = 0; attempt < 3; attempt++) {
        try { return await prisma.$transaction(execute); }
        catch (error) {
            const transient = error.code === 'P2034' || error.code === 1213 || /deadlock|could not serialize access/i.test(error.message);
            if (!transient || attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 25));
        }
    }
}

/**
 * Retrieve a Goods Receipt by ID with strict tenant boundary enforcement.
 */
async function getGoodsReceiptById(id, authorizedBusinessId) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid Goods Receipt ID.');

    const where = { id: numId };
    if (authorizedBusinessId) {
        where.businessId = parseInt(authorizedBusinessId, 10);
    }

    const grn = await prisma.goodsReceipt.findFirst({
        where,
        include: {
            items: { include: { stockMovement: true, purchaseOrderItem: true, item: true } },
            purchaseOrder: { include: { items: true } },
            project: true,
            supplier: true,
            receivedBy: { select: { id: true, name: true, email: true } }
        }
    });

    if (!grn) throw new NotFoundError(`Goods Receipt #${numId} not found.`);
    return grn;
}

/**
 * List Goods Receipts with tenant isolation, search, and pagination.
 */
async function listGoodsReceipts({ businessId, projectId, purchaseOrderId, supplierId, status, search, page = 1, limit = 20 } = {}) {
    if (!businessId) throw new ValidationError('Authorized businessId is required.');
    const where = { businessId: parseInt(businessId, 10) };

    if (projectId) where.projectId = parseInt(projectId, 10);
    if (purchaseOrderId) where.purchaseOrderId = parseInt(purchaseOrderId, 10);
    if (supplierId) where.supplierId = parseInt(supplierId, 10);
    if (status) where.status = status;

    if (search) {
        where.OR = [
            { receiptNumber: { contains: search } },
            { supplierName: { contains: search } },
            { deliveryChallanNumber: { contains: search } },
            { storeLocation: { contains: search } }
        ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [total, records] = await Promise.all([
        prisma.goodsReceipt.count({ where }),
        prisma.goodsReceipt.findMany({
            where,
            include: {
                items: true,
                purchaseOrder: { select: { id: true, orderNumber: true } },
                project: { select: { id: true, code: true, name: true } },
                supplier: { select: { id: true, name: true } }
            },
            orderBy: { receiptDate: 'desc' },
            skip,
            take: limitNum
        })
    ]);

    return { total, records, page: pageNum, limit: limitNum };
}

module.exports = {
    generateReceiptNumber,
    createGoodsReceipt,
    getGoodsReceiptById,
    listGoodsReceipts
};
