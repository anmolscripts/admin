const prisma = require('../config/prisma');

const ALLOWED_GST_RATES = [5, 12, 18, 28];
const ALLOWED_STATUSES = ['ACTIVE', 'INACTIVE', 'VOID', 'DELETED'];
const ALLOWED_DOCUMENT_TYPES = ['QUOTATION', 'INVOICE'];

const ALLOWED_TRANSITIONS = {
    ACTIVE: ['INACTIVE', 'VOID', 'DELETED'],
    INACTIVE: ['ACTIVE', 'VOID', 'DELETED'],
    VOID: [],
    DELETED: [] // Can only transition via restoreDocument
};

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
        this.statusCode = 404;
    }
}

class ConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConflictError';
        this.statusCode = 409;
    }
}

/**
 * Server-side calculation of invoice item amounts and overall totals.
 * Client-submitted totals and amounts are strictly ignored.
 *
 * Rules:
 * amount = quantity * rate
 * subtotal = sum(item amounts)
 * if gstEnabled: gstAmount = round(subtotal * gstRate / 100)
 * else: gstAmount = 0, gstRate = 0
 * totalBeforeRound = subtotal + gstAmount
 * grandTotal = Math.round(totalBeforeRound)
 * roundOff = grandTotal - totalBeforeRound
 */
function calculateInvoiceTotals({ items, gstEnabled, gstRate }) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError('Document must contain at least one line item.');
    }

    const isGstEnabled = Boolean(gstEnabled);
    let numericGstRate = 0;

    if (isGstEnabled) {
        numericGstRate = Number(gstRate);
        if (!ALLOWED_GST_RATES.includes(numericGstRate)) {
            throw new ValidationError(
                `Invalid GST rate: ${gstRate}%. Allowed rates are: ${ALLOWED_GST_RATES.join('%, ')}%.`
            );
        }
    }

    let subtotalCents = 0;
    const itemsWithAmount = items.map((item, idx) => {
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!name) {
            throw new ValidationError(`Item ${idx + 1}: Name is required.`);
        }

        const quantity = Number(item.quantity);
        if (isNaN(quantity) || quantity <= 0) {
            throw new ValidationError(`Item ${idx + 1} (${name}): Quantity must be greater than zero.`);
        }

        const rate = Number(item.rate);
        if (isNaN(rate) || rate < 0) {
            throw new ValidationError(`Item ${idx + 1} (${name}): Rate must be greater than or equal to zero.`);
        }

        const unit = typeof item.unit === 'string' && item.unit.trim() ? item.unit.trim() : 'PCS';

        // Precision round to 2 decimal places
        const amount = Math.round(quantity * rate * 100) / 100;
        subtotalCents += Math.round(amount * 100);

        return {
            lineNumber: idx + 1,
            name,
            quantity: Math.round(quantity * 100) / 100,
            unit,
            rate: Math.round(rate * 100) / 100,
            amount
        };
    });

    const subtotal = subtotalCents / 100;

    let gstAmount = 0;
    if (isGstEnabled) {
        gstAmount = Math.round((subtotal * numericGstRate / 100) * 100) / 100;
    }

    const totalBeforeRound = Math.round((subtotal + gstAmount) * 100) / 100;
    const grandTotal = Math.round(totalBeforeRound);
    const roundOff = Math.round((grandTotal - totalBeforeRound) * 100) / 100;

    return {
        itemsWithAmount,
        subtotal,
        gstEnabled: isGstEnabled,
        gstRate: numericGstRate,
        gstAmount,
        roundOff,
        grandTotal
    };
}

/**
 * Generate yearly sequential document number in a concurrency-safe transaction.
 * Supports independent sequences for QUOTATION (QTN-YYYY-NNNN) and INVOICE (INV-YYYY-NNNN).
 */
async function generateDocumentNumber(tx, documentType = 'INVOICE', dateInput) {
    const validDocType = documentType === 'QUOTATION' ? 'QUOTATION' : 'INVOICE';
    const prefix = validDocType === 'QUOTATION' ? 'QTN' : 'INV';
    const d = dateInput ? new Date(dateInput) : new Date();
    const year = isNaN(d.getFullYear()) ? new Date().getFullYear() : d.getFullYear();

    // Ensure sequence row exists atomically in MySQL without throwing duplicate key errors
    await tx.$executeRawUnsafe(
        'INSERT INTO invoice_number_sequences (documentType, year, currentNumber, createdAt, updatedAt) VALUES (?, ?, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE id = id',
        validDocType,
        year
    );

    // Atomically increment and lock row for this documentType + year
    const sequence = await tx.invoiceNumberSequence.update({
        where: {
            documentType_year: {
                documentType: validDocType,
                year
            }
        },
        data: { currentNumber: { increment: 1 } }
    });

    const formattedNum = String(sequence.currentNumber).padStart(4, '0');
    return `${prefix}-${year}-${formattedNum}`;
}

async function generateInvoiceNumber(tx, dateInput) {
    return generateDocumentNumber(tx, 'INVOICE', dateInput);
}

/**
 * Create a new document (QUOTATION or INVOICE) with line items, server-calculated totals, and revision 1.
 */
async function createDocument(data, userId) {
    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    if (data.documentType && !ALLOWED_DOCUMENT_TYPES.includes(data.documentType.toUpperCase())) {
        throw new ValidationError(
            `Invalid document type: "${data.documentType}". Allowed types are: ${ALLOWED_DOCUMENT_TYPES.join(', ')}.`
        );
    }
    const documentType = data.documentType === 'QUOTATION' ? 'QUOTATION' : 'INVOICE';

    const clientName = typeof data.clientName === 'string' ? data.clientName.trim() : '';
    if (!clientName) {
        throw new ValidationError('Client name is required.');
    }

    if (!data.invoiceDate) {
        throw new ValidationError('Invoice date is required.');
    }
    const invoiceDate = new Date(data.invoiceDate);
    if (isNaN(invoiceDate.getTime())) {
        throw new ValidationError('Invalid invoice date format.');
    }

    const calculated = calculateInvoiceTotals({
        items: data.items,
        gstEnabled: data.gstEnabled,
        gstRate: data.gstRate
    });

    return prisma.$transaction(async (tx) => {
        let validatedSourceQuotationId = null;
        if (data.sourceQuotationId) {
            if (documentType === 'QUOTATION') {
                throw new ValidationError('A quotation cannot reference a source quotation.');
            }
            const srcId = parseInt(data.sourceQuotationId, 10);
            if (isNaN(srcId) || srcId <= 0) {
                throw new ValidationError('Invalid sourceQuotationId.');
            }
            const srcDoc = await tx.invoice.findUnique({
                where: { id: srcId },
                include: { convertedInvoice: true }
            });
            if (!srcDoc) {
                throw new NotFoundError(`Source quotation with ID ${srcId} was not found.`);
            }
            if (srcDoc.documentType !== 'QUOTATION') {
                throw new ValidationError(`Document with ID ${srcId} is an INVOICE, not a QUOTATION.`);
            }
            if (srcDoc.status === 'VOID') {
                throw new ValidationError('Cannot convert a VOID quotation.');
            }
            if (srcDoc.status === 'DELETED') {
                throw new ValidationError('Cannot convert a DELETED quotation.');
            }
            if (srcDoc.convertedInvoice) {
                throw new ConflictError(`Quotation ${srcDoc.invoiceNumber} has already been converted.`);
            }
            validatedSourceQuotationId = srcDoc.id;
        }

        const invoiceNumber = await generateDocumentNumber(tx, documentType, invoiceDate);

        const doc = await tx.invoice.create({
            data: {
                documentType,
                invoiceNumber,
                clientName,
                invoiceDate,
                gstEnabled: calculated.gstEnabled,
                gstRate: calculated.gstRate.toFixed(2),
                subtotal: calculated.subtotal.toFixed(2),
                gstAmount: calculated.gstAmount.toFixed(2),
                roundOff: calculated.roundOff.toFixed(2),
                grandTotal: calculated.grandTotal.toFixed(2),
                status: 'ACTIVE',
                version: 1,
                sourceQuotationId: validatedSourceQuotationId,
                createdById: userId,
                updatedById: userId,
                items: {
                    create: calculated.itemsWithAmount.map((item) => ({
                        lineNumber: item.lineNumber,
                        name: item.name,
                        quantity: item.quantity.toFixed(2),
                        unit: item.unit,
                        rate: item.rate.toFixed(2),
                        amount: item.amount.toFixed(2)
                    }))
                }
            },
            include: {
                items: { orderBy: { lineNumber: 'asc' } },
                createdBy: { select: { id: true, name: true, email: true } },
                updatedBy: { select: { id: true, name: true, email: true } },
                sourceQuotation: { select: { id: true, invoiceNumber: true, clientName: true } },
                convertedInvoice: { select: { id: true, invoiceNumber: true, clientName: true } }
            }
        });

        // Record creation revision (revision 1)
        await tx.invoiceRevision.create({
            data: {
                invoiceId: doc.id,
                revisionNo: 1,
                action: 'CREATED',
                changedById: userId,
                changes: {
                    action: 'CREATED',
                    documentType,
                    summary: `${documentType} ${invoiceNumber} created with ${calculated.itemsWithAmount.length} item(s).`
                },
                snapshot: doc
            }
        });

        return doc;
    });
}

async function createInvoice(data, userId) {
    return createDocument({ ...data, documentType: 'INVOICE' }, userId);
}

async function createQuotation(data, userId) {
    return createDocument({ ...data, documentType: 'QUOTATION' }, userId);
}

/**
 * Get a document by ID with items, creator/updater, revisions, sourceQuotation, and convertedInvoice.
 */
async function getInvoiceById(id) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    const doc = await prisma.invoice.findUnique({
        where: { id: numericId },
        include: {
            items: { orderBy: { lineNumber: 'asc' } },
            createdBy: { select: { id: true, name: true, email: true } },
            updatedBy: { select: { id: true, name: true, email: true } },
            deletedBy: { select: { id: true, name: true, email: true } },
            sourceQuotation: { select: { id: true, invoiceNumber: true, clientName: true } },
            convertedInvoice: { select: { id: true, invoiceNumber: true, clientName: true } },
            revisions: {
                orderBy: { revisionNo: 'desc' },
                include: {
                    changedBy: { select: { id: true, name: true, email: true } }
                }
            }
        }
    });

    if (!doc) {
        throw new NotFoundError(`Document with ID ${numericId} was not found.`);
    }

    return doc;
}

/**
 * Update an invoice or quotation with atomic optimistic concurrency control at database level.
 * Cannot edit VOID or DELETED documents.
 * Document type, document number, and status cannot be modified via update.
 */
async function updateInvoice(id, data, userId) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    const expectedVersion = parseInt(data.version, 10);
    if (isNaN(expectedVersion) || expectedVersion <= 0) {
        throw new ValidationError('Current document version is required for optimistic concurrency.');
    }

    const clientName = typeof data.clientName === 'string' ? data.clientName.trim() : '';
    if (!clientName) {
        throw new ValidationError('Client name is required.');
    }

    if (!data.invoiceDate) {
        throw new ValidationError('Invoice date is required.');
    }
    const invoiceDate = new Date(data.invoiceDate);
    if (isNaN(invoiceDate.getTime())) {
        throw new ValidationError('Invalid invoice date format.');
    }

    const calculated = calculateInvoiceTotals({
        items: data.items,
        gstEnabled: data.gstEnabled,
        gstRate: data.gstRate
    });

    return prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findUnique({
            where: { id: numericId },
            include: { items: true }
        });

        if (!existing) {
            throw new NotFoundError(`Document with ID ${numericId} was not found.`);
        }

        if (data.documentType && String(data.documentType).trim().toUpperCase() !== existing.documentType) {
            throw new ValidationError('Document type cannot be changed once created.');
        }

        if (data.invoiceNumber && String(data.invoiceNumber).trim() !== existing.invoiceNumber) {
            throw new ValidationError('Document number cannot be modified.');
        }

        if (data.status && String(data.status).trim().toUpperCase() !== existing.status) {
            throw new ValidationError('Document status cannot be changed via update. Use status transition endpoints.');
        }

        if (existing.status === 'VOID') {
            throw new ValidationError('Cannot modify an invoice in VOID status.');
        }

        if (existing.status === 'DELETED') {
            throw new ValidationError('Cannot modify an invoice in DELETED status.');
        }

        // Atomic database update condition: WHERE id = ? AND version = ?
        const updateResult = await tx.invoice.updateMany({
            where: {
                id: numericId,
                version: expectedVersion
            },
            data: {
                clientName,
                invoiceDate,
                gstEnabled: calculated.gstEnabled,
                gstRate: calculated.gstRate.toFixed(2),
                subtotal: calculated.subtotal.toFixed(2),
                gstAmount: calculated.gstAmount.toFixed(2),
                roundOff: calculated.roundOff.toFixed(2),
                grandTotal: calculated.grandTotal.toFixed(2),
                version: { increment: 1 },
                updatedById: userId
            }
        });

        if (updateResult.count === 0) {
            const current = await tx.invoice.findUnique({ where: { id: numericId } });
            const currentVer = current ? current.version : 'unknown';
            throw new ConflictError(
                `Conflict: Document was modified by another user. Current version is ${currentVer}, submitted version was ${expectedVersion}. Please refresh and try again.`
            );
        }

        // Replace existing items
        await tx.invoiceItem.deleteMany({
            where: { invoiceId: existing.id }
        });

        await tx.invoiceItem.createMany({
            data: calculated.itemsWithAmount.map((item) => ({
                invoiceId: existing.id,
                lineNumber: item.lineNumber,
                name: item.name,
                quantity: item.quantity.toFixed(2),
                unit: item.unit,
                rate: item.rate.toFixed(2),
                amount: item.amount.toFixed(2)
            }))
        });

        const updated = await tx.invoice.findUnique({
            where: { id: existing.id },
            include: {
                items: { orderBy: { lineNumber: 'asc' } },
                createdBy: { select: { id: true, name: true, email: true } },
                updatedBy: { select: { id: true, name: true, email: true } },
                sourceQuotation: { select: { id: true, invoiceNumber: true, clientName: true } },
                convertedInvoice: { select: { id: true, invoiceNumber: true, clientName: true } }
            }
        });

        // Determine next revision number
        const lastRev = await tx.invoiceRevision.findFirst({
            where: { invoiceId: existing.id },
            orderBy: { revisionNo: 'desc' }
        });
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;

        // Build actual changed fields diff
        const changedFields = {};
        if (existing.clientName !== clientName) {
            changedFields.clientName = { from: existing.clientName, to: clientName };
        }
        if (new Date(existing.invoiceDate).getTime() !== invoiceDate.getTime()) {
            changedFields.invoiceDate = {
                from: new Date(existing.invoiceDate).toISOString(),
                to: invoiceDate.toISOString()
            };
        }
        if (existing.gstEnabled !== calculated.gstEnabled) {
            changedFields.gstEnabled = { from: existing.gstEnabled, to: calculated.gstEnabled };
        }
        if (Number(existing.gstRate) !== calculated.gstRate) {
            changedFields.gstRate = { from: Number(existing.gstRate), to: calculated.gstRate };
        }
        if (Number(existing.grandTotal) !== calculated.grandTotal) {
            changedFields.grandTotal = { from: Number(existing.grandTotal), to: calculated.grandTotal };
        }
        changedFields.items = {
            previousCount: existing.items.length,
            newCount: calculated.itemsWithAmount.length
        };

        await tx.invoiceRevision.create({
            data: {
                invoiceId: existing.id,
                revisionNo: nextRevNo,
                action: 'UPDATED',
                changedById: userId,
                changes: {
                    action: 'UPDATED',
                    previousVersion: existing.version,
                    newVersion: updated.version,
                    changedFields
                },
                snapshot: updated
            }
        });

        return updated;
    });
}

/**
 * Update a document status (ACTIVE, INACTIVE, VOID, DELETED) according to state machine.
 */
async function updateInvoiceStatus(id, newStatusInput, userId, options = {}) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    const newStatus = typeof newStatusInput === 'string' ? newStatusInput.trim().toUpperCase() : '';
    if (!ALLOWED_STATUSES.includes(newStatus)) {
        throw new ValidationError(
            `Invalid status: "${newStatusInput}". Allowed values are: ${ALLOWED_STATUSES.join(', ')}.`
        );
    }

    // Direct routing for DELETED
    if (newStatus === 'DELETED') {
        return softDeleteDocument(numericId, options.deleteReason, userId, options);
    }

    return prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findUnique({
            where: { id: numericId },
            include: { items: true }
        });

        if (!existing) {
            throw new NotFoundError(`Document with ID ${numericId} was not found.`);
        }

        // Disallow ANY transition from VOID (VOID -> ACTIVE, VOID -> INACTIVE, VOID -> VOID, VOID -> DELETED)
        if (existing.status === 'VOID') {
            throw new ValidationError('Cannot modify or change the status of an invoice that is already VOID.');
        }

        // Disallow direct status change on DELETED document (must use restore)
        if (existing.status === 'DELETED') {
            throw new ValidationError('Cannot change status of a DELETED document directly. Use restore operation.');
        }

        // Sensible behaviour for no-ops (ACTIVE -> ACTIVE, INACTIVE -> INACTIVE):
        // Return existing document without creating meaningless revision records
        if (existing.status === newStatus) {
            return existing;
        }

        // Enforce allowed state transitions
        const allowed = ALLOWED_TRANSITIONS[existing.status] || [];
        if (!allowed.includes(newStatus)) {
            throw new ValidationError(
                `Invalid status transition from ${existing.status} to ${newStatus}.`
            );
        }

        let action = 'STATUS_CHANGED';
        if (newStatus === 'ACTIVE') action = 'ACTIVATED';
        if (newStatus === 'INACTIVE') action = 'DEACTIVATED';
        if (newStatus === 'VOID') action = 'VOIDED';

        // Enforce optimistic concurrency version check if provided
        const expectedVersion = options.version !== undefined ? parseInt(options.version, 10) : existing.version;
        if (options.version !== undefined && (isNaN(expectedVersion) || existing.version !== expectedVersion)) {
            throw new ConflictError(
                `Conflict: Document was modified by another user. Current version is ${existing.version}, submitted version was ${options.version}. Please refresh and try again.`
            );
        }

        // Atomic database update condition: WHERE id = ? AND status = ? AND version = ?
        const whereCondition = {
            id: existing.id,
            status: existing.status,
            version: expectedVersion
        };

        const updateResult = await tx.invoice.updateMany({
            where: whereCondition,
            data: {
                status: newStatus,
                version: { increment: 1 },
                updatedById: userId
            }
        });

        if (updateResult.count === 0) {
            throw new ConflictError('Conflict: Document was modified or status changed concurrently by another user.');
        }

        const updated = await tx.invoice.findUnique({
            where: { id: existing.id },
            include: {
                items: { orderBy: { lineNumber: 'asc' } },
                createdBy: { select: { id: true, name: true, email: true } },
                updatedBy: { select: { id: true, name: true, email: true } },
                sourceQuotation: { select: { id: true, invoiceNumber: true, clientName: true } },
                convertedInvoice: { select: { id: true, invoiceNumber: true, clientName: true } }
            }
        });

        const lastRev = await tx.invoiceRevision.findFirst({
            where: { invoiceId: existing.id },
            orderBy: { revisionNo: 'desc' }
        });
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;

        await tx.invoiceRevision.create({
            data: {
                invoiceId: existing.id,
                revisionNo: nextRevNo,
                action,
                changedById: userId,
                changes: {
                    action,
                    fromStatus: existing.status,
                    toStatus: newStatus
                },
                snapshot: updated
            }
        });

        return updated;
    });
}

/**
 * Soft-delete a document (ACTIVE/INACTIVE -> DELETED).
 * Only ACTIVE or INACTIVE documents may be soft-deleted. VOID cannot be deleted.
 * Preserves document, line items, revisions, and records delete audit info.
 */
async function softDeleteDocument(id, deleteReason, userId, options = {}) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    return prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findUnique({
            where: { id: numericId }
        });

        if (!existing) {
            throw new NotFoundError(`Document with ID ${numericId} was not found.`);
        }

        if (existing.status === 'VOID') {
            throw new ValidationError('Cannot delete an invoice in VOID status.');
        }

        if (existing.status === 'DELETED') {
            throw new ValidationError('Document is already deleted.');
        }

        if (existing.status !== 'ACTIVE' && existing.status !== 'INACTIVE') {
            throw new ValidationError(
                `Cannot delete a document in ${existing.status} status. Only ACTIVE or INACTIVE documents can be deleted.`
            );
        }

        // Enforce optimistic concurrency version check if provided
        const expectedVersion = options.version !== undefined ? parseInt(options.version, 10) : existing.version;
        if (options.version !== undefined && (isNaN(expectedVersion) || existing.version !== expectedVersion)) {
            throw new ConflictError(
                `Conflict: Document was modified by another user. Current version is ${existing.version}, submitted version was ${options.version}. Please refresh and try again.`
            );
        }

        const whereCondition = {
            id: numericId,
            status: existing.status,
            version: expectedVersion
        };

        const updateResult = await tx.invoice.updateMany({
            where: whereCondition,
            data: {
                status: 'DELETED',
                previousStatusBeforeDelete: existing.status,
                deletedAt: new Date(),
                deletedById: userId,
                deleteReason: deleteReason || 'Deleted by user',
                version: { increment: 1 },
                updatedById: userId
            }
        });

        if (updateResult.count === 0) {
            throw new ConflictError('Conflict: Document was modified or deleted concurrently by another user.');
        }

        const updated = await tx.invoice.findUnique({
            where: { id: numericId },
            include: {
                items: { orderBy: { lineNumber: 'asc' } },
                createdBy: { select: { id: true, name: true, email: true } },
                updatedBy: { select: { id: true, name: true, email: true } },
                deletedBy: { select: { id: true, name: true, email: true } },
                sourceQuotation: { select: { id: true, invoiceNumber: true, clientName: true } },
                convertedInvoice: { select: { id: true, invoiceNumber: true, clientName: true } }
            }
        });

        const lastRev = await tx.invoiceRevision.findFirst({
            where: { invoiceId: numericId },
            orderBy: { revisionNo: 'desc' }
        });
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;

        await tx.invoiceRevision.create({
            data: {
                invoiceId: numericId,
                revisionNo: nextRevNo,
                action: 'DELETED',
                changedById: userId,
                changes: {
                    action: 'DELETED',
                    fromStatus: existing.status,
                    deleteReason: deleteReason || 'Deleted by user'
                },
                snapshot: updated
            }
        });

        return updated;
    });
}

/**
 * Restore a soft-deleted document back to its previous status (DELETED -> previousStatus).
 * Only DELETED documents can be restored. VOID documents can never be restored.
 */
async function restoreDocument(id, userId, options = {}) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    return prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findUnique({
            where: { id: numericId }
        });

        if (!existing) {
            throw new NotFoundError(`Document with ID ${numericId} was not found.`);
        }

        if (existing.status !== 'DELETED') {
            throw new ValidationError('Only DELETED documents can be restored.');
        }

        const targetStatus = existing.previousStatusBeforeDelete;
        if (targetStatus !== 'ACTIVE' && targetStatus !== 'INACTIVE') {
            throw new ValidationError(
                'Cannot restore document: previous status is invalid or missing. VOID documents cannot be restored.'
            );
        }

        // Enforce optimistic concurrency version check if provided
        const expectedVersion = options.version !== undefined ? parseInt(options.version, 10) : existing.version;
        if (options.version !== undefined && (isNaN(expectedVersion) || existing.version !== expectedVersion)) {
            throw new ConflictError(
                `Conflict: Document was modified by another user. Current version is ${existing.version}, submitted version was ${options.version}. Please refresh and try again.`
            );
        }

        const whereCondition = {
            id: numericId,
            status: 'DELETED',
            version: expectedVersion
        };

        const updateResult = await tx.invoice.updateMany({
            where: whereCondition,
            data: {
                status: targetStatus,
                previousStatusBeforeDelete: null,
                deletedAt: null,
                deletedById: null,
                deleteReason: null,
                version: { increment: 1 },
                updatedById: userId
            }
        });

        if (updateResult.count === 0) {
            throw new ConflictError('Conflict: Document was modified or restored concurrently by another user.');
        }

        const updated = await tx.invoice.findUnique({
            where: { id: numericId },
            include: {
                items: { orderBy: { lineNumber: 'asc' } },
                createdBy: { select: { id: true, name: true, email: true } },
                updatedBy: { select: { id: true, name: true, email: true } },
                sourceQuotation: { select: { id: true, invoiceNumber: true, clientName: true } },
                convertedInvoice: { select: { id: true, invoiceNumber: true, clientName: true } }
            }
        });

        const lastRev = await tx.invoiceRevision.findFirst({
            where: { invoiceId: numericId },
            orderBy: { revisionNo: 'desc' }
        });
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;

        await tx.invoiceRevision.create({
            data: {
                invoiceId: numericId,
                revisionNo: nextRevNo,
                action: 'RESTORED',
                changedById: userId,
                changes: {
                    action: 'RESTORED',
                    fromStatus: 'DELETED',
                    toStatus: targetStatus
                },
                snapshot: updated
            }
        });

        return updated;
    });
}

/**
 * Transactionally convert a QUOTATION into an INVOICE.
 * Enforces quotation-type verification, non-void/non-deleted checks,
 * atomic concurrency lock on quotation, and complete audit tracking.
 */
async function convertQuotationToInvoice(quotationId, userId, options = {}) {
    const numericId = parseInt(quotationId, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid quotation ID.');
    }

    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    return prisma.$transaction(async (tx) => {
        const quotation = await tx.invoice.findUnique({
            where: { id: numericId },
            include: {
                items: { orderBy: { lineNumber: 'asc' } },
                convertedInvoice: true
            }
        });

        if (!quotation) {
            throw new NotFoundError(`Quotation with ID ${numericId} was not found.`);
        }

        if (quotation.documentType !== 'QUOTATION') {
            throw new ValidationError(`Document with ID ${numericId} is an INVOICE, not a QUOTATION.`);
        }

        if (quotation.status === 'VOID') {
            throw new ValidationError('Cannot convert a VOID quotation.');
        }

        if (quotation.status === 'DELETED') {
            throw new ValidationError('Cannot convert a DELETED quotation.');
        }

        if (quotation.convertedInvoice) {
            throw new ConflictError(
                `Quotation ${quotation.invoiceNumber} has already been converted to invoice ${quotation.convertedInvoice.invoiceNumber}.`
            );
        }

        // Enforce optimistic concurrency version check if provided
        const expectedVersion = options.version !== undefined ? parseInt(options.version, 10) : quotation.version;
        if (options.version !== undefined && (isNaN(expectedVersion) || quotation.version !== expectedVersion)) {
            throw new ConflictError(
                `Conflict: Quotation was modified by another user. Current version is ${quotation.version}, submitted version was ${options.version}. Please refresh and try again.`
            );
        }

        // Atomic optimistic lock on the quotation to prevent concurrent double conversion
        const qtnLock = await tx.invoice.updateMany({
            where: {
                id: quotation.id,
                documentType: 'QUOTATION',
                status: { in: ['ACTIVE', 'INACTIVE'] },
                version: expectedVersion
            },
            data: {
                version: { increment: 1 },
                updatedById: userId
            }
        });

        if (qtnLock.count === 0) {
            throw new ConflictError(
                `Quotation ${quotation.invoiceNumber} was modified or already converted concurrently by another user.`
            );
        }

        // Generate independent new invoice number (INV-YYYY-NNNN)
        const invoiceNumber = await generateDocumentNumber(tx, 'INVOICE', quotation.invoiceDate);
        const conversionTimestamp = new Date().toISOString();

        let newInvoice;
        try {
            newInvoice = await tx.invoice.create({
                data: {
                    documentType: 'INVOICE',
                    invoiceNumber,
                    clientName: quotation.clientName,
                    invoiceDate: quotation.invoiceDate,
                    gstEnabled: quotation.gstEnabled,
                    gstRate: quotation.gstRate,
                    subtotal: quotation.subtotal,
                    gstAmount: quotation.gstAmount,
                    roundOff: quotation.roundOff,
                    grandTotal: quotation.grandTotal,
                    status: 'ACTIVE',
                    version: 1,
                    sourceQuotationId: quotation.id,
                    createdById: userId,
                    updatedById: userId,
                    items: {
                        create: quotation.items.map((item) => ({
                            lineNumber: item.lineNumber,
                            name: item.name,
                            quantity: item.quantity,
                            unit: item.unit,
                            rate: item.rate,
                            amount: item.amount
                        }))
                    }
                },
                include: {
                    items: { orderBy: { lineNumber: 'asc' } },
                    createdBy: { select: { id: true, name: true, email: true } },
                    updatedBy: { select: { id: true, name: true, email: true } },
                    sourceQuotation: { select: { id: true, invoiceNumber: true, clientName: true } }
                }
            });
        } catch (err) {
            if (err.code === 'P2002') {
                throw new ConflictError(
                    `Quotation ${quotation.invoiceNumber} has already been converted to an invoice.`
                );
            }
            throw err;
        }

        // Revision on new invoice: CREATED with conversion metadata
        await tx.invoiceRevision.create({
            data: {
                invoiceId: newInvoice.id,
                revisionNo: 1,
                action: 'CREATED',
                changedById: userId,
                changes: {
                    action: 'CREATED',
                    documentType: 'INVOICE',
                    sourceQuotationId: quotation.id,
                    sourceQuotationNumber: quotation.invoiceNumber,
                    convertedAt: conversionTimestamp,
                    convertedById: userId,
                    summary: `Invoice created by converting Quotation ${quotation.invoiceNumber}.`
                },
                snapshot: newInvoice
            }
        });

        // Revision on quotation: CONVERTED with conversion metadata
        const lastRev = await tx.invoiceRevision.findFirst({
            where: { invoiceId: quotation.id },
            orderBy: { revisionNo: 'desc' }
        });
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;

        await tx.invoiceRevision.create({
            data: {
                invoiceId: quotation.id,
                revisionNo: nextRevNo,
                action: 'CONVERTED',
                changedById: userId,
                changes: {
                    action: 'CONVERTED',
                    convertedInvoiceId: newInvoice.id,
                    convertedInvoiceNumber: newInvoice.invoiceNumber,
                    convertedAt: conversionTimestamp,
                    convertedById: userId,
                    summary: `Quotation converted to Invoice ${newInvoice.invoiceNumber}.`
                },
                snapshot: quotation
            }
        });

        return newInvoice;
    });
}

/**
 * Prepares an unsaved copy of a document.
 * Strips IDs, invoice number, status, revision history, and conversion relationships.
 */
async function copyDocument(id) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    const doc = await prisma.invoice.findUnique({
        where: { id: numericId },
        include: {
            items: { orderBy: { lineNumber: 'asc' } }
        }
    });

    if (!doc) {
        throw new NotFoundError(`Document with ID ${numericId} was not found.`);
    }

    return {
        documentType: doc.documentType,
        clientName: doc.clientName,
        invoiceDate: new Date().toISOString().split('T')[0],
        gstEnabled: doc.gstEnabled,
        gstRate: Number(doc.gstRate),
        items: doc.items.map((item) => ({
            name: item.name,
            quantity: Number(item.quantity),
            unit: item.unit,
            rate: Number(item.rate)
        }))
    };
}

/**
 * List documents with search, documentType filtering, status filtering, and pagination.
 */
async function listInvoices({ documentType, search, status, dateFrom, dateTo, page = 1, limit = 10 } = {}) {
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const skip = (parsedPage - 1) * parsedLimit;

    const where = {};

    if (documentType && ALLOWED_DOCUMENT_TYPES.includes(documentType.toUpperCase())) {
        where.documentType = documentType.toUpperCase();
    }

    if (search && typeof search === 'string' && search.trim()) {
        const query = search.trim();
        where.OR = [
            { invoiceNumber: { contains: query } },
            { clientName: { contains: query } }
        ];
    }

    if (status && typeof status === 'string' && status.toLowerCase() !== 'all') {
        const normalized = status.trim().toUpperCase();
        if (ALLOWED_STATUSES.includes(normalized)) {
            where.status = normalized;
        }
    }

    if (dateFrom || dateTo) {
        where.invoiceDate = {};
        if (dateFrom) {
            const dFrom = new Date(dateFrom);
            if (!isNaN(dFrom.getTime())) {
                where.invoiceDate.gte = dFrom;
            }
        }
        if (dateTo) {
            const dTo = new Date(dateTo);
            if (!isNaN(dTo.getTime())) {
                where.invoiceDate.lte = dTo;
            }
        }
    }

    const [total, invoices] = await Promise.all([
        prisma.invoice.count({ where }),
        prisma.invoice.findMany({
            where,
            orderBy: { id: 'desc' },
            skip,
            take: parsedLimit,
            include: {
                _count: { select: { items: true, revisions: true } },
                createdBy: { select: { id: true, name: true, email: true } },
                updatedBy: { select: { id: true, name: true, email: true } },
                sourceQuotation: { select: { id: true, invoiceNumber: true } },
                convertedInvoice: { select: { id: true, invoiceNumber: true } }
            }
        })
    ]);

    const totalPages = Math.ceil(total / parsedLimit) || 1;

    return {
        data: invoices,
        pagination: {
            total,
            page: parsedPage,
            limit: parsedLimit,
            totalPages
        }
    };
}

/**
 * Retrieve revision history for an invoice.
 */
async function getInvoiceHistory(id) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    const existing = await prisma.invoice.findUnique({
        where: { id: numericId },
        select: { id: true, invoiceNumber: true, documentType: true }
    });

    if (!existing) {
        throw new NotFoundError(`Document with ID ${numericId} was not found.`);
    }

    const revisions = await prisma.invoiceRevision.findMany({
        where: { invoiceId: numericId },
        orderBy: { revisionNo: 'desc' },
        include: {
            changedBy: { select: { id: true, name: true, email: true } }
        }
    });

    return {
        invoiceId: existing.id,
        invoiceNumber: existing.invoiceNumber,
        documentType: existing.documentType,
        revisions
    };
}

module.exports = {
    ALLOWED_GST_RATES,
    ALLOWED_STATUSES,
    ALLOWED_DOCUMENT_TYPES,
    ALLOWED_TRANSITIONS,
    ValidationError,
    NotFoundError,
    ConflictError,
    calculateInvoiceTotals,
    generateDocumentNumber,
    generateInvoiceNumber,
    createDocument,
    createInvoice,
    createQuotation,
    getInvoiceById,
    updateInvoice,
    updateInvoiceStatus,
    softDeleteDocument,
    restoreDocument,
    convertQuotationToInvoice,
    copyDocument,
    listInvoices,
    getInvoiceHistory
};
