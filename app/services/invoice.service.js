const prisma = require('../config/prisma');
const businessProfileService = require('./businessProfile.service');
const itemService = require('./item.service');
const activityService = require('./activity.service');

function stripSensitiveKeys(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const sensitiveKeys = ['password', 'hash', 'csrftoken', 'token', 'secret', 'cookie', 'session', 'auth'];
    if (Array.isArray(obj)) {
        return obj.map(item => stripSensitiveKeys(item));
    }
    const clean = {};
    for (const [key, value] of Object.entries(obj)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
            continue;
        }
        if (value && typeof value === 'object') {
            clean[key] = stripSensitiveKeys(value);
        } else {
            clean[key] = value;
        }
    }
    return clean;
}

/**
 * Remove sensitive credentials/secrets/tokens from any audit payload or snapshot.
 * Serializes Prisma models (Decimals, Dates) cleanly to plain JSON.
 */
function sanitizeAuditData(data) {
    if (!data) return data;
    try {
        const plain = JSON.parse(JSON.stringify(data));
        return stripSensitiveKeys(plain);
    } catch (_) {
        return stripSensitiveKeys(data);
    }
}

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

function validateEmail(email) {
    if (email === undefined || email === null) return null;
    const str = String(email).trim();
    if (!str) return null;
    if (str.length > 255) {
        throw new ValidationError('Client email must not exceed 255 characters.');
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(str)) {
        throw new ValidationError('Invalid client email format.');
    }
    return str;
}

const PHONE_REGEX = /^[+]?[(]?[0-9]{1,4}[)]?[-\s./0-9]{4,30}$/;

function validatePhone(phone) {
    if (phone === undefined || phone === null) return null;
    const str = String(phone).trim();
    if (!str) return null;
    if (str.length > 50) {
        throw new ValidationError('Client phone number must not exceed 50 characters.');
    }
    if (!PHONE_REGEX.test(str)) {
        throw new ValidationError('Invalid client phone number format.');
    }
    return str;
}

function validateText(text, fieldName, maxLength = 65535) {
    if (text === undefined || text === null) return null;
    const str = String(text).trim();
    if (!str) return null;
    if (str.length > maxLength) {
        throw new ValidationError(`${fieldName} must not exceed ${maxLength} characters.`);
    }
    return str;
}

function formatDocumentResponse(doc) {
    if (!doc) return null;
    return {
        ...doc,
        subtotal: doc.subtotal !== undefined && doc.subtotal !== null ? Number(doc.subtotal) : doc.subtotal,
        gstRate: doc.gstRate !== undefined && doc.gstRate !== null ? Number(doc.gstRate) : doc.gstRate,
        gstAmount: doc.gstAmount !== undefined && doc.gstAmount !== null ? Number(doc.gstAmount) : doc.gstAmount,
        cgstAmount: doc.cgstAmount !== undefined && doc.cgstAmount !== null ? Number(doc.cgstAmount) : doc.cgstAmount,
        sgstAmount: doc.sgstAmount !== undefined && doc.sgstAmount !== null ? Number(doc.sgstAmount) : doc.sgstAmount,
        igstAmount: doc.igstAmount !== undefined && doc.igstAmount !== null ? Number(doc.igstAmount) : doc.igstAmount,
        roundOff: doc.roundOff !== undefined && doc.roundOff !== null ? Number(doc.roundOff) : doc.roundOff,
        grandTotal: doc.grandTotal !== undefined && doc.grandTotal !== null ? Number(doc.grandTotal) : doc.grandTotal,
        paidAmount: doc.paidAmount !== undefined && doc.paidAmount !== null ? Number(doc.paidAmount) : doc.paidAmount,
        outstandingAmount: doc.outstandingAmount !== undefined && doc.outstandingAmount !== null ? Number(doc.outstandingAmount) : doc.outstandingAmount,
        items: Array.isArray(doc.items)
            ? doc.items.map(item => ({
                ...item,
                quantity: item.quantity !== undefined && item.quantity !== null ? Number(item.quantity) : item.quantity,
                rate: item.rate !== undefined && item.rate !== null ? Number(item.rate) : item.rate,
                amount: item.amount !== undefined && item.amount !== null ? Number(item.amount) : item.amount
            }))
            : doc.items
    };
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
function calculateInvoiceTotals({ items, gstEnabled, gstRate, sellerStateCode, placeOfSupplyStateCode }) {
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
        const hsnSac = item.hsnSac && typeof item.hsnSac === 'string' ? item.hsnSac.trim() : null;

        // Precision round to 2 decimal places
        const amount = Math.round(quantity * rate * 100) / 100;
        subtotalCents += Math.round(amount * 100);

        return {
            lineNumber: idx + 1,
            name,
            hsnSac,
            quantity: Math.round(quantity * 100) / 100,
            unit,
            rate: Math.round(rate * 100) / 100,
            amount
        };
    });

    const subtotal = subtotalCents / 100;

    let gstAmount = 0;
    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;

    if (isGstEnabled) {
        gstAmount = Math.round((subtotal * numericGstRate / 100) * 100) / 100;

        const sState = sellerStateCode ? String(sellerStateCode).trim() : '';
        const pState = placeOfSupplyStateCode ? String(placeOfSupplyStateCode).trim() : '';

        if (sState && pState && sState !== pState) {
            // Inter-State supply -> IGST
            igstAmount = gstAmount;
            cgstAmount = 0;
            sgstAmount = 0;
        } else {
            // Intra-State supply (or default) -> CGST + SGST
            cgstAmount = Math.round((gstAmount / 2) * 100) / 100;
            sgstAmount = Math.round((gstAmount - cgstAmount) * 100) / 100;
            igstAmount = 0;
        }
    }

    const totalBeforeRound = Math.round((subtotal + gstAmount) * 100) / 100;
    const grandTotal = Math.round(totalBeforeRound);
    const roundOff = Math.round((grandTotal - totalBeforeRound) * 100) / 100;

    return {
        items: itemsWithAmount,
        itemsWithAmount,
        subtotal,
        gstEnabled: isGstEnabled,
        gstRate: numericGstRate,
        gstAmount,
        cgstAmount,
        sgstAmount,
        igstAmount,
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
    let attempts = 0;
    while (attempts < 3) {
        try {
            await tx.$executeRawUnsafe(
                'INSERT INTO invoice_number_sequences (documentType, year, currentNumber, createdAt, updatedAt) VALUES (?, ?, 0, NOW(), NOW()) ON DUPLICATE KEY UPDATE id = id',
                validDocType,
                year
            );
            break;
        } catch (err) {
            attempts++;
            if ((err.code === 1213 || (err.message && err.message.includes('Deadlock'))) && attempts < 3) {
                await new Promise(r => setTimeout(r, attempts * 25));
            } else {
                throw err;
            }
        }
    }

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
async function createDocument(data, userId, meta = {}) {
    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    if (data.documentType && !ALLOWED_DOCUMENT_TYPES.includes(data.documentType.toUpperCase())) {
        throw new ValidationError(
            `Invalid document type: "${data.documentType}". Allowed types are: ${ALLOWED_DOCUMENT_TYPES.join(', ')}.`
        );
    }
    const documentType = data.documentType === 'QUOTATION' ? 'QUOTATION' : 'INVOICE';

    let clientName = typeof data.clientName === 'string' ? data.clientName.trim() : '';
    if (!clientName) {
        throw new ValidationError('Client name is required.');
    }
    if (clientName.length > 255) {
        throw new ValidationError('Client name must not exceed 255 characters.');
    }

    let clientEmail = validateEmail(data.clientEmail);
    let clientPhone = validatePhone(data.clientPhone);
    let billingAddress = validateText(data.billingAddress, 'Billing address');
    let shippingAddress = validateText(data.shippingAddress, 'Shipping address');
    const termsAndConditions = validateText(
        data.termsAndConditions !== undefined ? data.termsAndConditions : data.terms,
        'Terms and conditions'
    );
    const remarks = validateText(
        data.remarks !== undefined ? data.remarks : data.notes,
        'Remarks'
    );

    if (!data.invoiceDate) {
        throw new ValidationError('Invoice date is required.');
    }
    const invoiceDate = new Date(data.invoiceDate);
    if (isNaN(invoiceDate.getTime())) {
        throw new ValidationError('Invalid invoice date format.');
    }

    let persistedDueDate = null;
    let persistedValidUntil = null;

    if (documentType === 'QUOTATION') {
        const rawExpiry = data.validUntil !== undefined ? data.validUntil : data.dueDate;
        if (rawExpiry) {
            const expDateObj = new Date(rawExpiry);
            if (isNaN(expDateObj.getTime())) {
                throw new ValidationError('Invalid quotation expiry date format.');
            }
            if (expDateObj < invoiceDate) {
                throw new ValidationError('Quotation expiry date cannot be earlier than quotation date.');
            }
            persistedValidUntil = expDateObj;
        }
        persistedDueDate = null;
    } else {
        const rawDue = data.dueDate !== undefined ? data.dueDate : data.validUntil;
        if (rawDue) {
            const dueDateObj = new Date(rawDue);
            if (isNaN(dueDateObj.getTime())) {
                throw new ValidationError('Invalid invoice due date format.');
            }
            if (dueDateObj < invoiceDate) {
                throw new ValidationError('Invoice due date cannot be earlier than invoice date.');
            }
            persistedDueDate = dueDateObj;
        }
        persistedValidUntil = null;
    }

    let clientId = null;
    let clientGSTIN = data.clientGSTIN ? data.clientGSTIN.trim().toUpperCase() : null;
    let placeOfSupplyStateCode = data.placeOfSupplyStateCode ? data.placeOfSupplyStateCode.trim() : null;

    if (data.clientId) {
        const parsedClientId = parseInt(data.clientId, 10);
        if (!isNaN(parsedClientId) && parsedClientId > 0) {
            const clientRecord = await prisma.client.findUnique({ where: { id: parsedClientId } });
            if (clientRecord) {
                clientId = clientRecord.id;
                if (!clientName) clientName = clientRecord.name;
                if (!clientEmail) clientEmail = clientRecord.email;
                if (!clientPhone) clientPhone = clientRecord.phone;
                if (!clientGSTIN) clientGSTIN = clientRecord.gstin;
                if (!placeOfSupplyStateCode) placeOfSupplyStateCode = clientRecord.stateCode;
                if (!billingAddress) billingAddress = clientRecord.billingAddress;
                if (!shippingAddress) shippingAddress = clientRecord.shippingAddress;
            }
        }
    }

    // Default business profile for seller snapshot
    const profile = await businessProfileService.getProfile();
    const sellerName = (data.sellerName || profile.legalName || 'Spark ERP Technologies Pvt Ltd').trim();
    const sellerGSTIN = (data.sellerGSTIN || profile.gstin || '29AAAAA0000A1Z5').trim().toUpperCase();
    const sellerStateCode = (data.sellerStateCode || profile.stateCode || '29').trim();
    const sellerEmail = (data.sellerEmail || profile.email || 'billing@sparkadmin.com').trim();
    const sellerPhone = (data.sellerPhone || profile.phone || '+91 80 4000 1234').trim();
    const sellerAddress = (data.sellerAddress || profile.address || 'Tech Park Tower, 4th Floor, MG Road, Bengaluru, Karnataka 560001').trim();

    const calculated = calculateInvoiceTotals({
        items: data.items,
        gstEnabled: data.gstEnabled,
        gstRate: data.gstRate,
        sellerStateCode,
        placeOfSupplyStateCode
    });

    const createdDoc = await prisma.$transaction(async (tx) => {
        let validatedSourceQuotationId = null;
        let srcDoc = null;
        if (data.sourceQuotationId) {
            if (documentType === 'QUOTATION') {
                throw new ValidationError('A quotation cannot reference a source quotation.');
            }
            const srcId = parseInt(data.sourceQuotationId, 10);
            if (isNaN(srcId) || srcId <= 0) {
                throw new ValidationError('Invalid sourceQuotationId.');
            }
            srcDoc = await tx.invoice.findUnique({
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
                clientId,
                clientName,
                clientEmail,
                clientPhone,
                clientGSTIN,
                placeOfSupplyStateCode,
                sellerName,
                sellerGSTIN,
                sellerStateCode,
                sellerEmail,
                sellerPhone,
                sellerAddress,
                billingAddress,
                shippingAddress,
                termsAndConditions,
                remarks,
                invoiceDate,
                dueDate: persistedDueDate,
                validUntil: persistedValidUntil,
                gstEnabled: calculated.gstEnabled,
                gstRate: calculated.gstRate.toFixed(2),
                subtotal: calculated.subtotal.toFixed(2),
                gstAmount: calculated.gstAmount.toFixed(2),
                cgstAmount: calculated.cgstAmount.toFixed(2),
                sgstAmount: calculated.sgstAmount.toFixed(2),
                igstAmount: calculated.igstAmount.toFixed(2),
                roundOff: calculated.roundOff.toFixed(2),
                grandTotal: calculated.grandTotal.toFixed(2),
                paidAmount: '0.00',
                outstandingAmount: documentType === 'INVOICE' ? calculated.grandTotal.toFixed(2) : '0.00',
                status: 'ACTIVE',
                version: 1,
                sourceQuotationId: validatedSourceQuotationId,
                createdById: userId,
                updatedById: userId,
                items: {
                    create: calculated.itemsWithAmount.map((item) => ({
                        lineNumber: item.lineNumber,
                        name: item.name,
                        hsnSac: item.hsnSac || null,
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

        const copySourceId = data.copyFromId ? parseInt(data.copyFromId, 10) : null;
        let copySourceDoc = null;
        if (copySourceId && !isNaN(copySourceId)) {
            copySourceDoc = await tx.invoice.findUnique({
                where: { id: copySourceId },
                select: { id: true, invoiceNumber: true }
            });
        }

        // Record creation revision (revision 1)
        await tx.invoiceRevision.create({
            data: {
                invoiceId: doc.id,
                revisionNo: 1,
                action: 'CREATED',
                changedById: userId,
                ipAddress: meta ? meta.ipAddress : null,
                userAgent: meta ? meta.userAgent : null,
                changes: {
                    action: 'CREATED',
                    documentType,
                    sourceDocumentId: copySourceDoc ? copySourceDoc.id : (validatedSourceQuotationId || null),
                    sourceDocumentNumber: copySourceDoc ? copySourceDoc.invoiceNumber : (srcDoc ? srcDoc.invoiceNumber : null),
                    summary: copySourceDoc
                        ? `${documentType} ${invoiceNumber} created (copied from ${copySourceDoc.invoiceNumber}) with ${calculated.itemsWithAmount.length} item(s).`
                        : (validatedSourceQuotationId
                            ? `${documentType} ${invoiceNumber} created from Quotation ${srcDoc.invoiceNumber}.`
                            : `${documentType} ${invoiceNumber} created with ${calculated.itemsWithAmount.length} item(s).`)
                },
                snapshot: sanitizeAuditData(doc)
            }
        });

        return formatDocumentResponse(doc);
    });

    // During successful document save, persist newly created items into Item Master
    try {
        await itemService.ensureItemsExistFromDocument(calculated.itemsWithAmount, userId);
    } catch (itemErr) {
        console.warn('[ITEM MASTER] Notice during auto-persist item:', itemErr.message);
    }

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'CREATE_DOCUMENT',
            module: 'DOCUMENTS',
            targetType: createdDoc.documentType,
            targetId: createdDoc.id,
            targetReference: createdDoc.invoiceNumber
        }).catch(() => {});
    }

    return createdDoc;
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
            client: true,
            items: { orderBy: { lineNumber: 'asc' } },
            createdBy: { select: { id: true, name: true, email: true } },
            updatedBy: { select: { id: true, name: true, email: true } },
            deletedBy: { select: { id: true, name: true, email: true } },
            sourceQuotation: { select: { id: true, invoiceNumber: true, clientName: true } },
            convertedInvoice: { select: { id: true, invoiceNumber: true, clientName: true } },
            payments: {
                orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
                include: {
                    createdBy: { select: { id: true, name: true, email: true } }
                }
            },
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
async function updateInvoice(id, data, userId, meta = {}) {
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
    if (clientName.length > 255) {
        throw new ValidationError('Client name must not exceed 255 characters.');
    }

    const clientEmail = validateEmail(data.clientEmail);
    const clientPhone = validatePhone(data.clientPhone);
    const billingAddress = validateText(data.billingAddress, 'Billing address');
    const shippingAddress = validateText(data.shippingAddress, 'Shipping address');
    const termsAndConditions = validateText(
        data.termsAndConditions !== undefined ? data.termsAndConditions : data.terms,
        'Terms and conditions'
    );
    const remarks = validateText(
        data.remarks !== undefined ? data.remarks : data.notes,
        'Remarks'
    );

    if (!data.invoiceDate) {
        throw new ValidationError('Invoice date is required.');
    }
    const invoiceDate = new Date(data.invoiceDate);
    if (isNaN(invoiceDate.getTime())) {
        throw new ValidationError('Invalid invoice date format.');
    }

    let calculatedItems = null;

    const updatedDoc = await prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findUnique({
            where: { id: numericId },
            include: { items: true }
        });

        if (!existing) {
            throw new NotFoundError(`Document with ID ${numericId} was not found.`);
        }

        const clientId = data.clientId !== undefined ? (data.clientId ? parseInt(data.clientId, 10) : null) : existing.clientId;
        const clientGSTIN = data.clientGSTIN !== undefined ? (data.clientGSTIN ? data.clientGSTIN.trim().toUpperCase() : null) : existing.clientGSTIN;
        const placeOfSupplyStateCode = data.placeOfSupplyStateCode !== undefined ? (data.placeOfSupplyStateCode ? data.placeOfSupplyStateCode.trim() : null) : existing.placeOfSupplyStateCode;
        const sellerName = data.sellerName !== undefined ? data.sellerName.trim() : existing.sellerName;
        const sellerGSTIN = data.sellerGSTIN !== undefined ? (data.sellerGSTIN ? data.sellerGSTIN.trim().toUpperCase() : null) : existing.sellerGSTIN;
        const sellerStateCode = data.sellerStateCode !== undefined ? (data.sellerStateCode ? data.sellerStateCode.trim() : null) : existing.sellerStateCode;
        const sellerEmail = data.sellerEmail !== undefined ? (data.sellerEmail ? data.sellerEmail.trim() : null) : existing.sellerEmail;
        const sellerPhone = data.sellerPhone !== undefined ? (data.sellerPhone ? data.sellerPhone.trim() : null) : existing.sellerPhone;
        const sellerAddress = data.sellerAddress !== undefined ? (data.sellerAddress ? data.sellerAddress.trim() : null) : existing.sellerAddress;

        const calculated = calculateInvoiceTotals({
            items: data.items,
            gstEnabled: data.gstEnabled !== undefined ? data.gstEnabled : existing.gstEnabled,
            gstRate: data.gstRate !== undefined ? data.gstRate : existing.gstRate,
            sellerStateCode,
            placeOfSupplyStateCode
        });
        calculatedItems = calculated.itemsWithAmount;

        let updateDueDate = existing.dueDate;
        let updateValidUntil = existing.validUntil;

        if (existing.documentType === 'QUOTATION') {
            const rawExpiry = data.validUntil !== undefined ? data.validUntil : (data.dueDate !== undefined ? data.dueDate : undefined);
            if (rawExpiry !== undefined) {
                if (rawExpiry === null || rawExpiry === '') {
                    updateValidUntil = null;
                } else {
                    const expDateObj = new Date(rawExpiry);
                    if (isNaN(expDateObj.getTime())) {
                        throw new ValidationError('Invalid quotation expiry date format.');
                    }
                    if (expDateObj < invoiceDate) {
                        throw new ValidationError('Quotation expiry date cannot be earlier than quotation date.');
                    }
                    updateValidUntil = expDateObj;
                }
            }
            updateDueDate = null;
        } else {
            const rawDue = data.dueDate !== undefined ? data.dueDate : (data.validUntil !== undefined ? data.validUntil : undefined);
            if (rawDue !== undefined) {
                if (rawDue === null || rawDue === '') {
                    updateDueDate = null;
                } else {
                    const dueDateObj = new Date(rawDue);
                    if (isNaN(dueDateObj.getTime())) {
                        throw new ValidationError('Invalid invoice due date format.');
                    }
                    if (dueDateObj < invoiceDate) {
                        throw new ValidationError('Invoice due date cannot be earlier than invoice date.');
                    }
                    updateDueDate = dueDateObj;
                }
            }
            updateValidUntil = null;
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
                clientId,
                clientName,
                clientEmail,
                clientPhone,
                clientGSTIN,
                placeOfSupplyStateCode,
                sellerName,
                sellerGSTIN,
                sellerStateCode,
                sellerEmail,
                sellerPhone,
                sellerAddress,
                billingAddress,
                shippingAddress,
                termsAndConditions,
                remarks,
                invoiceDate,
                dueDate: updateDueDate,
                validUntil: updateValidUntil,
                gstEnabled: calculated.gstEnabled,
                gstRate: calculated.gstRate.toFixed(2),
                subtotal: calculated.subtotal.toFixed(2),
                gstAmount: calculated.gstAmount.toFixed(2),
                cgstAmount: calculated.cgstAmount.toFixed(2),
                sgstAmount: calculated.sgstAmount.toFixed(2),
                igstAmount: calculated.igstAmount.toFixed(2),
                roundOff: calculated.roundOff.toFixed(2),
                grandTotal: calculated.grandTotal.toFixed(2),
                outstandingAmount: existing.documentType === 'INVOICE'
                    ? Math.max(0, calculated.grandTotal - Number(existing.paidAmount)).toFixed(2)
                    : '0.00',
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
                hsnSac: item.hsnSac || null,
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
                ipAddress: meta ? meta.ipAddress : null,
                userAgent: meta ? meta.userAgent : null,
                changes: {
                    action: 'UPDATED',
                    previousVersion: existing.version,
                    newVersion: updated.version,
                    changedFields
                },
                snapshot: sanitizeAuditData(updated)
            }
        });

        return updated;
    });

    try {
        if (calculatedItems) {
            await itemService.ensureItemsExistFromDocument(calculatedItems, userId);
        }
    } catch (itemErr) {
        console.warn('[ITEM MASTER] Notice during auto-persist item on update:', itemErr.message);
    }

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'EDIT_DOCUMENT',
            module: 'DOCUMENTS',
            targetType: updatedDoc.documentType,
            targetId: updatedDoc.id,
            targetReference: updatedDoc.invoiceNumber
        }).catch(() => {});
    }

    return updatedDoc;
}

/**
 * Update a document status (ACTIVE, INACTIVE, VOID, DELETED) according to state machine.
 */
async function updateInvoiceStatus(id, newStatusInput, userIdOrReason, optionsOrVersion = {}, maybeUserId = null, maybeMeta = null) {
    let userId = userIdOrReason;
    let options = typeof optionsOrVersion === 'object' && optionsOrVersion !== null ? optionsOrVersion : {};
    let meta = options.meta || {};

    if (typeof userIdOrReason === 'string' && isNaN(parseInt(userIdOrReason, 10))) {
        // Called as updateInvoiceStatus(id, newStatus, reason, version, userId, meta)
        userId = maybeUserId || (typeof optionsOrVersion === 'number' ? optionsOrVersion : null);
        options = {
            deleteReason: userIdOrReason,
            version: typeof optionsOrVersion === 'number' ? optionsOrVersion : (optionsOrVersion && optionsOrVersion.version)
        };
        if (maybeMeta && typeof maybeMeta === 'object') {
            meta = maybeMeta;
        }
    } else if (typeof optionsOrVersion === 'number') {
        options = { version: optionsOrVersion };
        if (maybeUserId && typeof maybeUserId === 'object') {
            meta = maybeUserId;
        }
    } else if (maybeUserId && typeof maybeUserId === 'object') {
        meta = maybeUserId;
    }

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
        return softDeleteDocument(numericId, options.deleteReason, userId, options, meta);
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
                ipAddress: meta ? meta.ipAddress : null,
                userAgent: meta ? meta.userAgent : null,
                changes: {
                    action,
                    fromStatus: existing.status,
                    toStatus: newStatus
                },
                snapshot: sanitizeAuditData(updated)
            }
        });

        if (userId) {
            const actName = newStatus === 'VOID' ? 'VOID_DOCUMENT' : (newStatus === 'ACTIVE' ? 'RESTORE_DOCUMENT' : 'EDIT_DOCUMENT');
            await activityService.log({
                actorUserId: userId,
                action: actName,
                module: 'DOCUMENTS',
                targetType: updated.documentType,
                targetId: updated.id,
                targetReference: updated.invoiceNumber,
                metadata: { fromStatus: existing.status, toStatus: newStatus }
            }, tx).catch(() => {});
        }

        return updated;
    });
}

/**
 * Soft-delete a document (ACTIVE/INACTIVE -> DELETED).
 * Only ACTIVE or INACTIVE documents may be soft-deleted. VOID cannot be deleted.
 * Preserves document, line items, revisions, and records delete audit info.
 */
async function softDeleteDocument(id, deleteReason, userId, options = {}, meta = {}) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    const effectiveMeta = options.meta || meta || {};

    return prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findUnique({
            where: { id: numericId }
        });

        if (!existing) {
            throw new NotFoundError(`Document with ID ${numericId} was not found.`);
        }

        // Enforce optimistic concurrency version check if provided
        const expectedVersion = options.version !== undefined ? parseInt(options.version, 10) : existing.version;
        if (options.version !== undefined && (isNaN(expectedVersion) || existing.version !== expectedVersion)) {
            throw new ConflictError(
                `Conflict: Document was modified by another user. Current version is ${existing.version}, submitted version was ${options.version}. Please refresh and try again.`
            );
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
                ipAddress: effectiveMeta ? effectiveMeta.ipAddress : null,
                userAgent: effectiveMeta ? effectiveMeta.userAgent : null,
                changes: {
                    action: 'DELETED',
                    fromStatus: existing.status,
                    deleteReason: deleteReason || 'Deleted by user'
                },
                snapshot: sanitizeAuditData(updated)
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'DELETE_DOCUMENT',
                module: 'DOCUMENTS',
                targetType: updated.documentType,
                targetId: updated.id,
                targetReference: updated.invoiceNumber
            }, tx).catch(() => {});
        }

        return updated;
    });
}

/**
 * Restore a soft-deleted document back to its previous status (DELETED -> previousStatus).
 * Only DELETED documents can be restored. VOID documents can never be restored.
 */
async function restoreDocument(id, userId, options = {}, meta = {}) {
    const numericId = parseInt(id, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid document ID.');
    }

    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    const effectiveMeta = options.meta || meta || {};

    return prisma.$transaction(async (tx) => {
        const existing = await tx.invoice.findUnique({
            where: { id: numericId }
        });

        if (!existing) {
            throw new NotFoundError(`Document with ID ${numericId} was not found.`);
        }

        // Enforce optimistic concurrency version check if provided
        const expectedVersion = options.version !== undefined ? parseInt(options.version, 10) : existing.version;
        if (options.version !== undefined && (isNaN(expectedVersion) || existing.version !== expectedVersion)) {
            throw new ConflictError(
                `Conflict: Document was modified by another user. Current version is ${existing.version}, submitted version was ${options.version}. Please refresh and try again.`
            );
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
                ipAddress: effectiveMeta ? effectiveMeta.ipAddress : null,
                userAgent: effectiveMeta ? effectiveMeta.userAgent : null,
                changes: {
                    action: 'RESTORED',
                    fromStatus: 'DELETED',
                    toStatus: targetStatus
                },
                snapshot: sanitizeAuditData(updated)
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'RESTORE_DOCUMENT',
                module: 'DOCUMENTS',
                targetType: updated.documentType,
                targetId: updated.id,
                targetReference: updated.invoiceNumber
            }, tx).catch(() => {});
        }

        return updated;
    });
}

/**
 * Transactionally convert a QUOTATION into an INVOICE.
 * Enforces quotation-type verification, non-void/non-deleted checks,
 * atomic concurrency lock on quotation, and complete audit tracking.
 */
async function convertQuotationToInvoice(quotationId, userId, options = {}, meta = {}) {
    const numericId = parseInt(quotationId, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid quotation ID.');
    }

    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    const effectiveMeta = options.meta || meta || {};

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

        if (quotation.status !== 'ACTIVE') {
            throw new ValidationError(
                `Cannot convert a quotation in ${quotation.status} status. Only ACTIVE quotations can be converted to an invoice.`
            );
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
                status: 'ACTIVE',
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

        // Conversion due date rule: explicit options.dueDate if supplied, otherwise standard 30 days from quotation invoiceDate
        let convertedDueDate = null;
        if (options && options.dueDate) {
            const parsedDueDate = new Date(options.dueDate);
            if (isNaN(parsedDueDate.getTime())) {
                throw new ValidationError('Invalid invoice due date format.');
            }
            if (parsedDueDate < quotation.invoiceDate) {
                throw new ValidationError('Invoice due date cannot be earlier than quotation date.');
            }
            convertedDueDate = parsedDueDate;
        } else {
            convertedDueDate = new Date(quotation.invoiceDate);
            convertedDueDate.setDate(convertedDueDate.getDate() + 30);
        }

        let newInvoice;
        try {
            newInvoice = await tx.invoice.create({
                data: {
                    documentType: 'INVOICE',
                    invoiceNumber,
                    clientId: quotation.clientId,
                    clientName: quotation.clientName,
                    clientEmail: quotation.clientEmail,
                    clientPhone: quotation.clientPhone,
                    clientGSTIN: quotation.clientGSTIN,
                    placeOfSupplyStateCode: quotation.placeOfSupplyStateCode,
                    sellerName: quotation.sellerName,
                    sellerGSTIN: quotation.sellerGSTIN,
                    sellerStateCode: quotation.sellerStateCode,
                    sellerEmail: quotation.sellerEmail,
                    sellerPhone: quotation.sellerPhone,
                    sellerAddress: quotation.sellerAddress,
                    billingAddress: quotation.billingAddress,
                    shippingAddress: quotation.shippingAddress,
                    termsAndConditions: quotation.termsAndConditions,
                    remarks: quotation.remarks,
                    invoiceDate: quotation.invoiceDate,
                    dueDate: convertedDueDate,
                    validUntil: null,
                    gstEnabled: quotation.gstEnabled,
                    gstRate: quotation.gstRate,
                    subtotal: quotation.subtotal,
                    gstAmount: quotation.gstAmount,
                    cgstAmount: quotation.cgstAmount,
                    sgstAmount: quotation.sgstAmount,
                    igstAmount: quotation.igstAmount,
                    roundOff: quotation.roundOff,
                    grandTotal: quotation.grandTotal,
                    paidAmount: '0.00',
                    outstandingAmount: quotation.grandTotal,
                    status: 'ACTIVE',
                    version: 1,
                    sourceQuotationId: quotation.id,
                    createdById: userId,
                    updatedById: userId,
                    items: {
                        create: quotation.items.map((item) => ({
                            lineNumber: item.lineNumber,
                            name: item.name,
                            hsnSac: item.hsnSac || null,
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
                ipAddress: effectiveMeta ? effectiveMeta.ipAddress : null,
                userAgent: effectiveMeta ? effectiveMeta.userAgent : null,
                changes: {
                    action: 'CREATED',
                    documentType: 'INVOICE',
                    sourceQuotationId: quotation.id,
                    sourceQuotationNumber: quotation.invoiceNumber,
                    convertedAt: conversionTimestamp,
                    convertedById: userId,
                    summary: `Invoice created by converting Quotation ${quotation.invoiceNumber}.`
                },
                snapshot: sanitizeAuditData(newInvoice)
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
                ipAddress: effectiveMeta ? effectiveMeta.ipAddress : null,
                userAgent: effectiveMeta ? effectiveMeta.userAgent : null,
                changes: {
                    action: 'CONVERTED',
                    convertedInvoiceId: newInvoice.id,
                    convertedInvoiceNumber: newInvoice.invoiceNumber,
                    convertedAt: conversionTimestamp,
                    convertedById: userId,
                    summary: `Quotation converted to Invoice ${newInvoice.invoiceNumber}.`
                },
                snapshot: sanitizeAuditData(quotation)
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CONVERT_DOCUMENT',
                module: 'DOCUMENTS',
                targetType: 'QUOTATION',
                targetId: quotation.id,
                targetReference: quotation.invoiceNumber,
                metadata: { convertedInvoiceId: newInvoice.id, convertedInvoiceNumber: newInvoice.invoiceNumber }
            }, tx).catch(() => {});
        }

        return newInvoice;
    });
}

/**
 * Prepares an unsaved copy of a document.
 * Records a COPIED revision on the source document and returns template data.
 */
async function copyDocument(id, userId = null, meta = {}) {
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

    if (userId) {
        const lastRev = await prisma.invoiceRevision.findFirst({
            where: { invoiceId: numericId },
            orderBy: { revisionNo: 'desc' }
        });
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;
        await prisma.invoiceRevision.create({
            data: {
                invoiceId: numericId,
                revisionNo: nextRevNo,
                action: 'COPIED',
                changedById: userId,
                ipAddress: meta ? meta.ipAddress : null,
                userAgent: meta ? meta.userAgent : null,
                changes: {
                    action: 'COPIED',
                    copiedAt: new Date().toISOString(),
                    copiedById: userId,
                    summary: `${doc.documentType} ${doc.invoiceNumber} was copied as a template for a new document.`
                },
                snapshot: sanitizeAuditData(doc)
            }
        });

        await activityService.log({
            actorUserId: userId,
            action: 'COPY_DOCUMENT',
            module: 'DOCUMENTS',
            targetType: doc.documentType,
            targetId: doc.id,
            targetReference: doc.invoiceNumber
        }).catch(() => {});
    }

    return {
        copyFromId: doc.id,
        documentType: doc.documentType,
        clientId: doc.clientId || null,
        clientName: doc.clientName,
        clientEmail: doc.clientEmail,
        clientPhone: doc.clientPhone,
        clientGSTIN: doc.clientGSTIN || null,
        placeOfSupplyStateCode: doc.placeOfSupplyStateCode || null,
        sellerName: doc.sellerName || null,
        sellerGSTIN: doc.sellerGSTIN || null,
        sellerStateCode: doc.sellerStateCode || null,
        sellerEmail: doc.sellerEmail || null,
        sellerPhone: doc.sellerPhone || null,
        sellerAddress: doc.sellerAddress || null,
        billingAddress: doc.billingAddress,
        shippingAddress: doc.shippingAddress,
        termsAndConditions: doc.termsAndConditions,
        remarks: doc.remarks,
        invoiceDate: new Date().toISOString().split('T')[0],
        dueDate: doc.documentType === 'INVOICE' && doc.dueDate ? new Date(doc.dueDate).toISOString().split('T')[0] : null,
        validUntil: doc.documentType === 'QUOTATION' && doc.validUntil ? new Date(doc.validUntil).toISOString().split('T')[0] : null,
        gstEnabled: doc.gstEnabled,
        gstRate: Number(doc.gstRate),
        items: doc.items.map((item) => ({
            name: item.name,
            hsnSac: item.hsnSac || null,
            quantity: Number(item.quantity),
            unit: item.unit,
            rate: Number(item.rate)
        }))
    };
}

/**
 * List documents with search, documentType filtering, status filtering, and pagination.
 */
async function listInvoices({ documentType, search, status, paymentStatus, dateFrom, dateTo, page = 1, limit = 10 } = {}) {
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

    if (paymentStatus && typeof paymentStatus === 'string') {
        const ps = paymentStatus.trim().toUpperCase();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        if (ps === 'PAID') {
            where.documentType = 'INVOICE';
            where.outstandingAmount = 0;
            where.paidAmount = { gt: 0 };
        } else if (ps === 'PARTIALLY_PAID') {
            where.documentType = 'INVOICE';
            where.paidAmount = { gt: 0 };
            where.outstandingAmount = { gt: 0 };
        } else if (ps === 'OVERDUE') {
            where.documentType = 'INVOICE';
            where.outstandingAmount = { gt: 0 };
            where.invoiceDate = { ...(where.invoiceDate || {}), lt: thirtyDaysAgo };
        } else if (ps === 'UNPAID') {
            where.documentType = 'INVOICE';
            where.paidAmount = 0;
        }
    }

    if (dateFrom || dateTo) {
        where.invoiceDate = where.invoiceDate || {};
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
                client: { select: { id: true, name: true } },
                _count: { select: { items: true, revisions: true, payments: true } },
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
 * Retrieve high-level KPI metrics for quotations and invoices dashboard
 */
async function getDashboardKPIs() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [activeQuotations, activeInvoices, outstandingAgg, overdueCount] = await Promise.all([
        prisma.invoice.count({
            where: { documentType: 'QUOTATION', status: 'ACTIVE' }
        }),
        prisma.invoice.count({
            where: { documentType: 'INVOICE', status: 'ACTIVE' }
        }),
        prisma.invoice.aggregate({
            _sum: { outstandingAmount: true },
            where: {
                documentType: 'INVOICE',
                status: { in: ['ACTIVE', 'INACTIVE'] }
            }
        }),
        prisma.invoice.count({
            where: {
                documentType: 'INVOICE',
                status: { in: ['ACTIVE', 'INACTIVE'] },
                outstandingAmount: { gt: 0 },
                invoiceDate: { lt: thirtyDaysAgo }
            }
        })
    ]);

    return {
        activeQuotations,
        activeInvoices,
        totalOutstanding: Number(outstandingAgg._sum.outstandingAmount) || 0,
        overdueInvoices: overdueCount
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
    updateDocument: updateInvoice,
    updateInvoice,
    updateInvoiceStatus,
    softDeleteDocument,
    restoreDocument,
    convertQuotationToInvoice,
    copyDocument,
    listInvoices,
    getInvoiceHistory,
    getDashboardKPIs
};
