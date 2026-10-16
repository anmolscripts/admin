'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const postingService = require('./accounting/posting.service');
const journalService = require('./journal.service');

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

const numberingService = require('./numbering.service');
const businessProfileService = require('./businessProfile.service');

/**
 * Generates an atomic sequential Credit/Debit Note number using central numbering:
 * CRN/YYYY/MM/INCREMENT or DBN/YYYY/MM/INCREMENT
 */
async function generateNoteNumber(tx, noteType, financialYear, options = {}) {
    const businessId = options.businessId ? parseInt(options.businessId, 10) : 1;
    const date = options.date || new Date();
    const entityType = noteType === 'DEBIT' ? 'DEBIT_NOTE' : 'CREDIT_NOTE';
    return await numberingService.allocateNumber({
        businessId,
        entityType,
        date,
        tx
    });
}

/**
 * Validates and calculates note totals (subtotal, taxes, round-off, grandTotal).
 */
function calculateNoteTotals(itemsInput, invoice, options = {}) {
    if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
        throw new ValidationError('At least one line item is required for a credit/debit note.');
    }

    const gstEnabled = options.gstEnabled !== undefined ? Boolean(options.gstEnabled) : Boolean(invoice.gstEnabled);
    const gstRate = options.gstRate !== undefined ? Number(options.gstRate) : Number(invoice.gstRate || 0);

    const sellerState = (options.sellerStateCode || invoice.sellerStateCode || '').toString().trim();
    const posState = (options.placeOfSupplyStateCode || invoice.placeOfSupplyStateCode || invoice.client?.stateCode || '').toString().trim();
    const isInterState = Boolean(sellerState && posState && sellerState !== posState);

    let subtotalCents = 0n;
    const validatedItems = [];

    for (let i = 0; i < itemsInput.length; i++) {
        const raw = itemsInput[i];
        const name = (raw.name || '').toString().trim();
        if (!name) {
            throw new ValidationError(`Item row #${i + 1} must have a name.`);
        }

        const quantity = Math.round((Number(raw.quantity) || 0) * 100) / 100;
        if (quantity <= 0) {
            throw new ValidationError(`Item row #${i + 1} ("${name}") must have a positive quantity.`);
        }

        const rate = Math.round((Number(raw.rate) || 0) * 100) / 100;
        if (rate < 0) {
            throw new ValidationError(`Item row #${i + 1} ("${name}") rate cannot be negative.`);
        }

        const amountCents = BigInt(Math.round(quantity * rate * 100));
        subtotalCents += amountCents;

        const itemTaxRate = raw.taxRate !== undefined ? Number(raw.taxRate) : gstRate;
        let itemCgstCents = 0n;
        let itemSgstCents = 0n;
        let itemIgstCents = 0n;

        if (gstEnabled && itemTaxRate > 0) {
            const taxCents = (amountCents * BigInt(Math.round(itemTaxRate * 100))) / 10000n;
            if (isInterState) {
                itemIgstCents = taxCents;
            } else {
                itemCgstCents = taxCents / 2n;
                itemSgstCents = taxCents - itemCgstCents;
            }
        }

        validatedItems.push({
            invoiceItemId: raw.invoiceItemId ? parseInt(raw.invoiceItemId, 10) : null,
            lineNumber: i + 1,
            name,
            description: raw.description ? raw.description.toString().trim() : null,
            hsnSac: raw.hsnSac ? raw.hsnSac.toString().trim() : null,
            quantity,
            unit: raw.unit ? raw.unit.toString().trim().toUpperCase() : 'PCS',
            rate,
            amount: Number(amountCents) / 100,
            taxRate: itemTaxRate,
            cgstAmount: Number(itemCgstCents) / 100,
            sgstAmount: Number(itemSgstCents) / 100,
            igstAmount: Number(itemIgstCents) / 100
        });
    }

    const subtotal = Number(subtotalCents) / 100;
    let cgstAmount = 0;
    let sgstAmount = 0;
    let igstAmount = 0;
    let gstAmount = 0;

    if (gstEnabled && gstRate > 0) {
        const totalTaxCents = (subtotalCents * BigInt(Math.round(gstRate * 100))) / 10000n;
        gstAmount = Number(totalTaxCents) / 100;
        if (isInterState) {
            igstAmount = gstAmount;
        } else {
            cgstAmount = Math.round((gstAmount / 2) * 100) / 100;
            sgstAmount = Math.round((gstAmount - cgstAmount) * 100) / 100;
        }
    }

    const unrounded = Math.round((subtotal + gstAmount) * 100) / 100;
    const grandTotal = Math.round(unrounded);
    const roundOff = Math.round((grandTotal - unrounded) * 100) / 100;

    return {
        gstEnabled,
        gstRate,
        subtotal,
        cgstAmount,
        sgstAmount,
        igstAmount,
        gstAmount,
        roundOff,
        grandTotal,
        items: validatedItems,
        isInterState
    };
}

/**
 * Creates a Credit Note or Debit Note against an existing Invoice.
 *
 * @param {Object} data
 * @param {number} userId
 * @param {Object} [meta={}]
 * @returns {Promise<Object>} Created note with lines and journal
 */
async function createCreditDebitNote(data, userId, meta = {}, externalTx = null) {
    if (!userId) {
        throw new ValidationError('Authenticated user ID is required.');
    }

    const rawType = (data.noteType || 'CREDIT').toString().trim().toUpperCase();
    if (!['CREDIT', 'DEBIT'].includes(rawType)) {
        throw new ValidationError(`Invalid note type: "${data.noteType}". Allowed types are CREDIT, DEBIT.`);
    }
    const noteType = rawType;

    const invoiceId = parseInt(data.invoiceId, 10);
    if (isNaN(invoiceId) || invoiceId <= 0) {
        throw new ValidationError('A valid original invoiceId is required.');
    }

    const reason = (data.reason || '').toString().trim();
    if (!reason) {
        throw new ValidationError('Reason is required when issuing a credit/debit note.');
    }

    const noteDate = data.noteDate ? new Date(data.noteDate) : new Date();
    if (isNaN(noteDate.getTime())) {
        throw new ValidationError('Invalid noteDate provided.');
    }

    const status = data.status === 'DRAFT' ? 'DRAFT' : 'ISSUED';

    const executeInContext = async (tx) => {
        // Acquire exclusive row-level lock on invoice to serialize concurrent note creation
        await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;

        // 1. Fetch and validate invoice
        const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: {
                client: true,
                items: true,
                creditDebitNotes: {
                    where: { status: { in: ['ISSUED', 'DRAFT'] } }
                }
            }
        });

        if (!invoice) {
            throw new NotFoundError(`Invoice with ID ${invoiceId} not found.`);
        }

        if (invoice.documentType !== 'INVOICE') {
            throw new ValidationError('Credit and debit notes can only be issued against invoices, not quotations.');
        }

        if (invoice.status === 'VOID') {
            throw new ValidationError('Cannot issue a credit/debit note against a VOID invoice.');
        }

        if (invoice.status === 'DELETED') {
            throw new ValidationError('Cannot issue a credit/debit note against a DELETED invoice.');
        }

        if (invoice.status === 'INACTIVE') {
            throw new ValidationError('Cannot issue a credit/debit note against an INACTIVE invoice.');
        }

        // Validate client reference match if provided
        if (data.clientId && invoice.clientId && parseInt(data.clientId, 10) !== invoice.clientId) {
            throw new ValidationError('The specified client does not match the referenced invoice client.');
        }

        // Resolve business context
        let businessId = invoice.businessId || (data && data.businessId);
        if (!businessId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
            businessId = 1;
        }
        if (!businessId) {
            throw new ValidationError('Invoice is missing business context.');
        }
        if (invoice.businessId && data.businessId && parseInt(data.businessId, 10) !== invoice.businessId) {
            throw new ValidationError(`Invoice ${invoice.id} does not belong to authorized business ${data.businessId}. Cross-business access denied.`);
        }

        // 2. Resolve Financial Year for noteDate
        const financialYear = await ensureFinancialYear(noteDate, businessId);
        if (!financialYear) {
            throw new ValidationError(`Could not resolve Financial Year for note date ${noteDate.toISOString().slice(0, 10)}.`);
        }

        if (financialYear.status === 'CLOSED') {
            throw new ValidationError(`Cannot issue note in closed Financial Year ${financialYear.code}.`);
        }

        // 3. Calculate Totals & Items
        const totals = calculateNoteTotals(data.items, invoice, {
            gstEnabled: data.gstEnabled !== undefined ? data.gstEnabled : invoice.gstEnabled,
            gstRate: data.gstRate !== undefined ? data.gstRate : invoice.gstRate,
            sellerStateCode: invoice.sellerStateCode,
            placeOfSupplyStateCode: data.placeOfSupplyStateCode || invoice.placeOfSupplyStateCode
        });

        if (totals.grandTotal <= 0) {
            throw new ValidationError('Note grand total must be greater than zero.');
        }

        // 4. Over-adjustment validation for Credit Notes across both note types
        if (noteType === 'CREDIT') {
            const existingCreditSum = invoice.creditDebitNotes
                .filter(n => n.noteType === 'CREDIT')
                .reduce((acc, n) => acc + Number(n.grandTotal), 0);

            const existingDebitSum = invoice.creditDebitNotes
                .filter(n => n.noteType === 'DEBIT')
                .reduce((acc, n) => acc + Number(n.grandTotal), 0);

            const effectiveInvoiceTotal = Math.round((Number(invoice.grandTotal) + existingDebitSum) * 100) / 100;
            const remainingPermitted = Math.round((effectiveInvoiceTotal - existingCreditSum) * 100) / 100;

            if (totals.grandTotal > remainingPermitted + 0.001) {
                throw new ValidationError(
                    `Credit note amount (₹${totals.grandTotal.toFixed(2)}) exceeds the invoice unadjusted balance (₹${remainingPermitted.toFixed(2)}).`
                );
            }
        }

        // 5. Generate Atomic Note Number
        const noteNumber = await generateNoteNumber(tx, noteType, financialYear, { businessId, date: noteDate });

        // 6. Capture Immutable Commercial & Client Snapshots
        const profile = await businessProfileService.getProfile(businessId) || await tx.businessProfile.findFirst() || {};

        const note = await tx.creditDebitNote.create({
            data: {
                businessId,
                noteNumber,
                noteType,
                invoiceId: invoice.id,
                clientId: invoice.clientId || null,
                financialYearId: financialYear.id,
                noteDate,
                status,
                reason,
                currency: data.currency ? data.currency.trim().toUpperCase() : 'INR',

                // Immutable Client Snapshot
                clientName: invoice.clientName,
                clientEmail: invoice.clientEmail || null,
                clientPhone: invoice.clientPhone || null,
                clientGSTIN: invoice.clientGSTIN || null,
                placeOfSupplyStateCode: data.placeOfSupplyStateCode || invoice.placeOfSupplyStateCode || null,
                billingAddress: invoice.billingAddress || null,
                shippingAddress: invoice.shippingAddress || null,

                // Immutable Seller Snapshot
                sellerName: profile.legalName || invoice.sellerName || 'Spark Admin',
                sellerGSTIN: profile.gstin || invoice.sellerGSTIN || null,
                sellerStateCode: profile.stateCode || invoice.sellerStateCode || null,
                sellerAddress: profile.address || invoice.sellerAddress || null,

                // Original Invoice Snapshot
                originalInvoiceNumber: invoice.invoiceNumber,
                originalInvoiceDate: invoice.invoiceDate,
                originalInvoiceGrandTotal: invoice.grandTotal,

                // Computed Financial Values
                gstEnabled: totals.gstEnabled,
                gstRate: totals.gstRate,
                subtotal: totals.subtotal,
                cgstAmount: totals.cgstAmount,
                sgstAmount: totals.sgstAmount,
                igstAmount: totals.igstAmount,
                gstAmount: totals.gstAmount,
                roundOff: totals.roundOff,
                grandTotal: totals.grandTotal,
                remarks: data.remarks ? data.remarks.trim() : null,

                createdById: userId,

                // Line Items
                items: {
                    create: totals.items.map(item => ({
                        invoiceItemId: item.invoiceItemId,
                        lineNumber: item.lineNumber,
                        name: item.name,
                        description: item.description,
                        hsnSac: item.hsnSac,
                        quantity: item.quantity,
                        unit: item.unit,
                        rate: item.rate,
                        amount: item.amount,
                        taxRate: item.taxRate,
                        cgstAmount: item.cgstAmount,
                        sgstAmount: item.sgstAmount,
                        igstAmount: item.igstAmount
                    }))
                }
            },
            include: {
                items: { orderBy: { lineNumber: 'asc' } },
                invoice: true,
                client: true,
                financialYear: true
            }
        });

        // 7. Post Double-Entry Journal Entry if ISSUED
        let postingResult = null;
        if (status === 'ISSUED') {
            postingResult = await postingService.postCreditDebitNote(
                note.id,
                { userId },
                tx
            );
        }

        // 8. User Activity Audit Log
        if (activityService && typeof activityService.logUserActivity === 'function') {
            activityService.logUserActivity({
                userId,
                action: `CREATE_${noteType}_NOTE`,
                module: 'CREDIT_NOTES',
                targetType: `${noteType}_NOTE`,
                targetId: String(note.id),
                meta: {
                    noteNumber: note.noteNumber,
                    invoiceId: invoice.id,
                    invoiceNumber: invoice.invoiceNumber,
                    grandTotal: Number(note.grandTotal),
                    ip: meta.ip,
                    userAgent: meta.userAgent
                }
            }, tx).catch(() => {});
        }

        return {
            note: {
                ...note,
                subtotal: Number(note.subtotal),
                gstAmount: Number(note.gstAmount),
                cgstAmount: Number(note.cgstAmount),
                sgstAmount: Number(note.sgstAmount),
                igstAmount: Number(note.igstAmount),
                roundOff: Number(note.roundOff),
                grandTotal: Number(note.grandTotal)
            },
            journal: postingResult ? postingResult.journal : null
        };
    };

    if (externalTx) {
        return await executeInContext(externalTx);
    }
    return await prisma.$transaction(executeInContext, { timeout: 15000, maxWait: 10000 });
}

/**
 * Voids an issued Credit or Debit Note and atomically reverses its General Ledger journal.
 *
 * @param {number|string} noteId
 * @param {number} userId
 * @param {string} [reason='']
 * @param {Object} [meta={}]
 * @param {Object} [externalTx=null]
 * @returns {Promise<Object>} Updated note and reversal journal
 */
async function voidCreditDebitNote(noteId, userId, reason = '', meta = {}, externalTx = null) {
    const numId = parseInt(noteId, 10);
    if (isNaN(numId) || numId <= 0) {
        throw new ValidationError('Invalid credit/debit note ID.');
    }

    const executeInContext = async (tx) => {
        // Acquire exclusive row-level lock on note to serialize concurrent void requests
        await tx.$queryRaw`SELECT id FROM credit_debit_notes WHERE id = ${numId} FOR UPDATE`;

        const note = await tx.creditDebitNote.findUnique({
            where: { id: numId },
            include: {
                invoice: true,
                client: true,
                financialYear: true
            }
        });

        if (!note) {
            throw new NotFoundError(`Credit/Debit Note #${numId} not found.`);
        }

        if (note.status === 'VOID') {
            throw new ValidationError(`Note ${note.noteNumber} is already VOID.`);
        }

        if (note.financialYear && note.financialYear.status === 'CLOSED') {
            throw new ValidationError(`Cannot void credit/debit note in CLOSED Financial Year ${note.financialYear.code}.`);
        }

        // 1. Update Note Status to VOID
        const voidReasonClean = (reason || '').toString().trim() || 'Voided by user';
        const updatedNote = await tx.creditDebitNote.update({
            where: { id: numId },
            data: {
                status: 'VOID',
                voidedById: userId || null,
                voidReason: voidReasonClean,
                voidedAt: new Date()
            },
            include: {
                items: { orderBy: { lineNumber: 'asc' } },
                invoice: true,
                client: true,
                financialYear: true
            }
        });

        // 2. Reverse Double-Entry Journal Entry if posted
        const idempotencyKey = postingService.getCreditDebitNoteIdempotencyKey(note.noteType, note.id);
        const existingJournal = await tx.journalEntry.findUnique({
            where: { idempotencyKey }
        });

        let reversalJournal = null;
        if (existingJournal && existingJournal.status !== 'REVERSED') {
            reversalJournal = await journalService.reverseJournalEntry(
                existingJournal.id,
                {
                    reason: `Voided ${note.noteType} Note #${note.noteNumber}: ${voidReasonClean}`,
                    reversalDate: new Date(),
                    userId
                },
                tx
            );
        }

        // 3. User Activity Audit Log
        if (activityService && typeof activityService.logUserActivity === 'function') {
            activityService.logUserActivity({
                userId,
                action: `VOID_${note.noteType}_NOTE`,
                module: 'CREDIT_NOTES',
                targetType: `${note.noteType}_NOTE`,
                targetId: String(note.id),
                meta: {
                    noteNumber: note.noteNumber,
                    invoiceNumber: note.originalInvoiceNumber,
                    reason: voidReasonClean,
                    ip: meta.ip,
                    userAgent: meta.userAgent
                }
            }, tx).catch(() => {});
        }

        return {
            note: {
                ...updatedNote,
                subtotal: Number(updatedNote.subtotal),
                gstAmount: Number(updatedNote.gstAmount),
                grandTotal: Number(updatedNote.grandTotal)
            },
            reversalJournal
        };
    };

    if (externalTx) {
        return await executeInContext(externalTx);
    }
    return await prisma.$transaction(executeInContext, { timeout: 15000, maxWait: 10000 });
}

/**
 * Retrieves a single note by ID with complete relations and accounting status.
 */
async function getCreditDebitNoteById(noteId) {
    const numId = parseInt(noteId, 10);
    if (isNaN(numId) || numId <= 0) {
        throw new ValidationError('Invalid note ID.');
    }

    const note = await prisma.creditDebitNote.findUnique({
        where: { id: numId },
        include: {
            items: { orderBy: { lineNumber: 'asc' } },
            invoice: { select: { id: true, invoiceNumber: true, status: true, grandTotal: true, invoiceDate: true } },
            client: true,
            financialYear: true,
            createdBy: { select: { id: true, name: true, email: true } },
            voidedBy: { select: { id: true, name: true, email: true } }
        }
    });

    if (!note) {
        throw new NotFoundError(`Credit/Debit Note #${numId} not found.`);
    }

    const accounting = await postingService.getCreditDebitNoteAccountingStatus(note.noteType, note.id);

    return {
        ...note,
        subtotal: Number(note.subtotal),
        cgstAmount: Number(note.cgstAmount),
        sgstAmount: Number(note.sgstAmount),
        igstAmount: Number(note.igstAmount),
        gstAmount: Number(note.gstAmount),
        roundOff: Number(note.roundOff),
        grandTotal: Number(note.grandTotal),
        items: note.items.map(it => ({
            ...it,
            quantity: Number(it.quantity),
            rate: Number(it.rate),
            amount: Number(it.amount),
            taxRate: Number(it.taxRate),
            cgstAmount: Number(it.cgstAmount),
            sgstAmount: Number(it.sgstAmount),
            igstAmount: Number(it.igstAmount)
        })),
        accounting
    };
}

/**
 * Lists credit and debit notes with filtering and pagination.
 */
async function listCreditDebitNotes(query = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const where = {};

    if (query.noteType && ['CREDIT', 'DEBIT'].includes(query.noteType.toUpperCase())) {
        where.noteType = query.noteType.toUpperCase();
    }

    if (query.status && ['DRAFT', 'ISSUED', 'VOID'].includes(query.status.toUpperCase())) {
        where.status = query.status.toUpperCase();
    }

    if (query.businessId) {
        where.businessId = parseInt(query.businessId, 10);
    }

    if (query.invoiceId) {
        where.invoiceId = parseInt(query.invoiceId, 10);
    }

    if (query.clientId) {
        where.clientId = parseInt(query.clientId, 10);
    }

    if (query.financialYearId) {
        where.financialYearId = parseInt(query.financialYearId, 10);
    }

    if (query.search) {
        const term = query.search.trim();
        where.OR = [
            { noteNumber: { contains: term } },
            { originalInvoiceNumber: { contains: term } },
            { clientName: { contains: term } },
            { reason: { contains: term } }
        ];
    }

    const [total, notes] = await Promise.all([
        prisma.creditDebitNote.count({ where }),
        prisma.creditDebitNote.findMany({
            where,
            include: {
                client: { select: { id: true, name: true } },
                invoice: { select: { id: true, invoiceNumber: true } },
                financialYear: { select: { id: true, code: true } }
            },
            orderBy: { id: 'desc' },
            skip,
            take: limit
        })
    ]);

    const enrichedNotes = await Promise.all(
        notes.map(async (n) => {
            const accounting = await postingService.getCreditDebitNoteAccountingStatus(n.noteType, n.id);
            return {
                ...n,
                subtotal: Number(n.subtotal),
                gstAmount: Number(n.gstAmount),
                grandTotal: Number(n.grandTotal),
                accounting
            };
        })
    );

    return {
        notes: enrichedNotes,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

module.exports = {
    ValidationError,
    NotFoundError,
    ConflictError,
    generateNoteNumber,
    calculateNoteTotals,
    createCreditDebitNote,
    voidCreditDebitNote,
    getCreditDebitNoteById,
    listCreditDebitNotes
};
