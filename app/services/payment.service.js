const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const postingService = require('./accounting/posting.service');
const journalService = require('./journal.service');
const numberingService = require('./numbering.service');
const businessService = require('./business.service');

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

const ALLOWED_METHODS = ['BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', 'CARD', 'CREDIT_CARD'];

/**
 * Determine payment status for an invoice
 * @param {Object} invoice
 * @returns {'PAID' | 'PARTIALLY_PAID' | 'OVERDUE' | 'UNPAID'}
 */
function getPaymentStatus(invoice) {
    if (!invoice) return 'UNPAID';
    const paid = Number(invoice.paidAmount) || 0;
    const total = Number(invoice.grandTotal) || 0;

    if (paid >= total && total > 0) {
        return 'PAID';
    }

    if (paid > 0 && paid < total) {
        return 'PARTIALLY_PAID';
    }

    if (invoice.dueDate) {
        const dueDate = new Date(invoice.dueDate);
        if (!isNaN(dueDate.getTime()) && dueDate < new Date()) {
            return 'OVERDUE';
        }
    } else if (invoice.invoiceDate) {
        const dueDate = new Date(invoice.invoiceDate);
        dueDate.setDate(dueDate.getDate() + 30);
        if (dueDate < new Date()) {
            return 'OVERDUE';
        }
    }

    return 'UNPAID';
}

/**
 * Get all payments for a given invoice
 */
async function getInvoicePayments(invoiceIdInput, businessId = null) {
    const invoiceId = parseInt(invoiceIdInput, 10);
    if (isNaN(invoiceId) || invoiceId <= 0) {
        throw new ValidationError('Invalid invoice ID.');
    }

    const where = { invoiceId };
    if (businessId) where.invoice = Number(businessId) === 1
        ? { OR: [{ businessId: 1 }, { businessId: null }] }
        : { businessId: Number(businessId) };
    const payments = await prisma.payment.findMany({
        where,
        orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
        include: {
            createdBy: { select: { id: true, name: true, email: true } }
        }
    });

    return payments.map(p => ({
        ...p,
        amount: Number(p.amount)
    }));
}

/**
 * Record a payment against an invoice
 */
async function recordPayment(invoiceIdInput, paymentData, userId, meta = {}) {
    const invoiceId = parseInt(invoiceIdInput, 10);
    if (isNaN(invoiceId) || invoiceId <= 0) {
        throw new ValidationError('Invalid invoice ID.');
    }

    if (!paymentData || typeof paymentData !== 'object') {
        throw new ValidationError('Payment details are required.');
    }

    const rawAmount = Number(paymentData.amount);
    if (isNaN(rawAmount) || rawAmount <= 0) {
        throw new ValidationError('Payment amount must be a positive number greater than 0.');
    }
    const amount = Math.round(rawAmount * 100) / 100;

    const rawMethod = (paymentData.method || 'BANK_TRANSFER').toString().trim().toUpperCase();
    let method = rawMethod === 'CREDIT_CARD' ? 'CARD' : rawMethod;
    if (!ALLOWED_METHODS.includes(rawMethod) && !ALLOWED_METHODS.includes(method)) {
        throw new ValidationError(`Unsupported payment method: "${paymentData.method}". Allowed methods are ${ALLOWED_METHODS.join(', ')}.`);
    }
    const reference = typeof paymentData.reference === 'string' ? paymentData.reference.trim() : '';
    if (method === 'CHEQUE' && !reference) {
        throw new ValidationError('A cheque number or reference is required for cheque payments.');
    }
    const isPendingCheque = method === 'CHEQUE';

    const paymentDate = paymentData.paymentDate ? new Date(paymentData.paymentDate) : new Date();
    if (isNaN(paymentDate.getTime())) {
        throw new ValidationError('Invalid payment date.');
    }

    return prisma.$transaction(async (tx) => {
        // Acquire row lock on invoice in MySQL to serialize concurrent payment operations
        await tx.$executeRawUnsafe('SELECT id FROM invoices WHERE id = ? FOR UPDATE', invoiceId);

        const invoice = await tx.invoice.findUnique({
            where: { id: invoiceId },
            include: {
                revisions: { orderBy: { revisionNo: 'desc' }, take: 1 }
            }
        });

        if (!invoice) {
            throw new NotFoundError(`Invoice with ID ${invoiceId} not found.`);
        }

        await businessService.assertUserBusinessAccess(userId, invoice.businessId, meta.businessId || invoice.businessId);

        if (invoice.documentType !== 'INVOICE') {
            throw new ValidationError('Payments can only be recorded for invoices, not quotations.');
        }

        if (invoice.status === 'VOID') {
            throw new ValidationError('Cannot record payment for a VOID invoice.');
        }

        if (invoice.status === 'DELETED') {
            throw new ValidationError('Cannot record payment for a DELETED invoice.');
        }

        if (invoice.status === 'INACTIVE') {
            throw new ValidationError('Cannot record payment for an INACTIVE invoice.');
        }

        const currentOutstanding = Number(invoice.outstandingAmount);
        const pendingCheques = await tx.payment.findMany({
            where: { invoiceId: invoice.id, status: 'PENDING_CLEARANCE' },
            select: { amount: true }
        });
        const reservedAmount = pendingCheques.reduce((sum, payment) => sum + Number(payment.amount), 0);
        const availableOutstanding = Math.max(0, Math.round((currentOutstanding - reservedAmount) * 100) / 100);
        if (amount > availableOutstanding + 0.001) {
            if (reservedAmount > 0) {
                throw new ValidationError(
                    `Payment amount (₹${amount.toFixed(2)}) exceeds the available balance after pending cheques (₹${availableOutstanding.toFixed(2)}).`
                );
            }
            throw new ValidationError(
                `Payment amount (₹${amount.toFixed(2)}) exceeds the invoice outstanding balance (₹${currentOutstanding.toFixed(2)}).`
            );
        }

        const activeBusinessId = Number(invoice.businessId || (meta && meta.businessId)) || null;
        if (!activeBusinessId) {
            throw new ValidationError('Invoice is missing business context.');
        }
        if (meta && meta.businessId && parseInt(meta.businessId, 10) !== activeBusinessId) {
            throw new ValidationError(`Invoice ${invoice.id} does not belong to authorized business ${meta.businessId}. Cross-business access denied.`);
        }
        const invoiceJournal = await tx.journalEntry.findUnique({
            where: { idempotencyKey: postingService.getInvoiceIdempotencyKey(invoice.id) },
            select: { id: true }
        });
        if (!invoiceJournal) {
            await postingService.postInvoice(invoice.id, { userId, externalTx: tx });
        }
        const financialYear = await ensureFinancialYear(paymentDate, activeBusinessId, tx);
        if (financialYear && financialYear.status === 'CLOSED') {
            throw new ValidationError(`Cannot record payment in CLOSED Financial Year ${financialYear.code}.`);
        }

        const receiptNumber = await numberingService.allocateNumber({
            businessId: activeBusinessId,
            entityType: 'PAYMENT',
            date: paymentDate,
            tx
        });

        const payment = await tx.payment.create({
            data: {
                businessId: activeBusinessId,
                receiptNumber,
                invoiceId: invoice.id,
                financialYearId: financialYear ? financialYear.id : null,
                amount,
                paymentDate,
                method,
                reference: reference || null,
                notes: typeof paymentData.notes === 'string' && paymentData.notes.trim() ? paymentData.notes.trim() : null,
                status: isPendingCheque ? 'PENDING_CLEARANCE' : 'POSTED',
                createdById: userId || null
            }
        });

        let updatedInvoice;
        let totalPaid = Number(invoice.paidAmount);
        let newOutstanding = Number(invoice.outstandingAmount);

        if (isPendingCheque) {
            updatedInvoice = await tx.invoice.update({
                where: { id: invoice.id },
                data: { version: { increment: 1 } }
            });
        } else {
            // Recalculate totals from all POSTED payments
            const postedPayments = await tx.payment.findMany({
                where: { invoiceId: invoice.id, status: 'POSTED' }
            });
            totalPaid = Math.round(postedPayments.reduce((acc, p) => acc + Number(p.amount), 0) * 100) / 100;
            const grandTotal = Number(invoice.grandTotal);

            if (totalPaid > grandTotal + 0.001) {
                throw new ValidationError(
                    `Payment cannot be recorded: total paid (₹${totalPaid.toFixed(2)}) would exceed grand total (₹${grandTotal.toFixed(2)}).`
                );
            }

            newOutstanding = Math.max(0, Math.round((grandTotal - totalPaid) * 100) / 100);

            updatedInvoice = await tx.invoice.update({
                where: { id: invoice.id },
                data: {
                    paidAmount: totalPaid,
                    outstandingAmount: newOutstanding,
                    version: { increment: 1 }
                }
            });
        }

        // Append Revision record
        const lastRev = invoice.revisions[0];
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;
        const revisionAction = isPendingCheque ? 'CHEQUE_RECEIVED' : 'PAYMENT_RECORDED';
        await tx.invoiceRevision.create({
            data: {
                invoiceId: invoice.id,
                revisionNo: nextRevNo,
                action: revisionAction,
                changedById: userId || invoice.createdById,
                ipAddress: meta ? meta.ipAddress : null,
                userAgent: meta ? meta.userAgent : null,
                changes: {
                    action: revisionAction,
                    paymentId: payment.id,
                    amount,
                    method,
                    reference: payment.reference,
                    previousOutstandingAmount: Number(invoice.outstandingAmount),
                    newOutstandingAmount: newOutstanding,
                    paidAmount: totalPaid,
                    outstandingAmount: newOutstanding,
                    summary: isPendingCheque
                        ? `Cheque of ₹${amount.toFixed(2)} received and is pending clearance.${payment.reference ? ' Cheque: ' + payment.reference + '.' : ''} Invoice balance remains ₹${newOutstanding.toFixed(2)} until cleared.`
                        : `Payment of ₹${amount.toFixed(2)} recorded via ${method}.${payment.reference ? ' Ref: ' + payment.reference : ''} Outstanding balance: ₹${newOutstanding.toFixed(2)}.`
                },
                snapshot: {
                    ...updatedInvoice,
                    grandTotal: Number(updatedInvoice.grandTotal),
                    paidAmount: Number(updatedInvoice.paidAmount),
                    outstandingAmount: Number(updatedInvoice.outstandingAmount)
                }
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE_PAYMENT',
                module: 'PAYMENTS',
                targetType: 'PAYMENT',
                targetId: payment.id,
                targetReference: payment.reference || `Payment #${payment.id}`,
                metadata: { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, amount: Number(payment.amount), method: payment.method, status: payment.status }
            }, tx);
        }

        const postingResult = isPendingCheque
            ? { journal: null }
            : await postingService.postPayment(
                payment.id,
                {
                    userId,
                    depositAccountId: paymentData.depositAccountId || null
                },
                tx
            );

        return {
            payment: {
                ...payment,
                amount: Number(payment.amount),
                journal: postingResult.journal
            },
            invoice: {
                ...updatedInvoice,
                grandTotal: Number(updatedInvoice.grandTotal),
                paidAmount: Number(updatedInvoice.paidAmount),
                outstandingAmount: Number(updatedInvoice.outstandingAmount)
            },
            journal: postingResult.journal
        };
    }, { timeout: 30000, maxWait: 10000 });
}

/**
 * Clear a pending customer cheque and post it on the date it cleared.
 */
async function clearPayment(paymentIdInput, userId, clearedAtInput, meta = {}) {
    const paymentId = parseInt(paymentIdInput, 10);
    if (isNaN(paymentId) || paymentId <= 0) {
        throw new ValidationError('Invalid payment ID.');
    }

    let clearedAt;
    if (!clearedAtInput) {
        clearedAt = new Date();
    } else if (typeof clearedAtInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(clearedAtInput)) {
        clearedAt = new Date(`${clearedAtInput}T00:00:00.000Z`);
        if (clearedAt.toISOString().slice(0, 10) !== clearedAtInput) {
            throw new ValidationError('Invalid cheque clearance date.');
        }
    } else {
        clearedAt = new Date(clearedAtInput);
    }
    if (isNaN(clearedAt.getTime())) {
        throw new ValidationError('Invalid cheque clearance date.');
    }

    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT id FROM payments WHERE id = ? FOR UPDATE', paymentId);
        const payment = await tx.payment.findUnique({
            where: { id: paymentId },
            include: { invoice: true }
        });

        if (!payment) {
            throw new NotFoundError(`Payment with ID ${paymentId} not found.`);
        }
        await businessService.assertUserBusinessAccess(userId, payment.invoice.businessId, meta.businessId || payment.invoice.businessId);
        if (payment.businessId && payment.businessId !== (payment.invoice.businessId || 1)) {
            throw new ValidationError('Payment business does not match its invoice business.');
        }
        if (payment.method !== 'CHEQUE' || payment.status !== 'PENDING_CLEARANCE') {
            throw new ValidationError('Only pending cheque payments can be marked cleared.');
        }
        if (payment.invoice.status !== 'ACTIVE') {
            throw new ValidationError(`Cannot clear a cheque for an invoice with status ${payment.invoice.status}.`);
        }
        if (clearedAt < new Date(payment.paymentDate)) {
            throw new ValidationError('Cheque clearance date cannot be before the payment date.');
        }
        const clearanceDay = new Date(clearedAt);
        clearanceDay.setUTCHours(0, 0, 0, 0);
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        if (clearanceDay > today) {
            throw new ValidationError('Cheque clearance date cannot be in the future.');
        }

        await tx.$executeRawUnsafe('SELECT id FROM invoices WHERE id = ? FOR UPDATE', payment.invoiceId);
        const invoice = await tx.invoice.findUnique({
            where: { id: payment.invoiceId },
            include: { revisions: { orderBy: { revisionNo: 'desc' }, take: 1 } }
        });
        if (!invoice) {
            throw new NotFoundError(`Invoice with ID ${payment.invoiceId} not found.`);
        }

        const activeBusinessId = Number(invoice.businessId || payment.businessId || (meta && meta.businessId)) || null;
        if (!activeBusinessId) {
            throw new ValidationError('Invoice is missing business context.');
        }
        if (payment.businessId && invoice.businessId && payment.businessId !== invoice.businessId) {
            throw new ValidationError('Payment business does not match its invoice business.');
        }
        if (meta && meta.businessId && parseInt(meta.businessId, 10) !== activeBusinessId) {
            throw new ValidationError(`Payment ${payment.id} does not belong to authorized business ${meta.businessId}. Cross-business access denied.`);
        }

        const financialYear = await ensureFinancialYear(clearedAt, activeBusinessId, tx);
        if (financialYear && financialYear.status === 'CLOSED') {
            throw new ValidationError(`Cannot clear cheque in CLOSED Financial Year ${financialYear.code}.`);
        }

        const outstanding = Number(invoice.outstandingAmount);
        if (Number(payment.amount) > outstanding + 0.001) {
            throw new ValidationError(
                `Cheque amount (₹${Number(payment.amount).toFixed(2)}) exceeds the invoice outstanding balance (₹${outstanding.toFixed(2)}).`
            );
        }

        const updatedPayment = await tx.payment.update({
            where: { id: payment.id },
            data: {
                status: 'POSTED',
                clearedAt,
                financialYearId: financialYear ? financialYear.id : null
            }
        });

        const postedPayments = await tx.payment.findMany({
            where: { invoiceId: invoice.id, status: 'POSTED' },
            select: { amount: true }
        });
        const totalPaid = Math.round(postedPayments.reduce((sum, item) => sum + Number(item.amount), 0) * 100) / 100;
        const grandTotal = Number(invoice.grandTotal);
        if (totalPaid > grandTotal + 0.001) {
            throw new ValidationError(
                `Cheque cannot be cleared: total paid (₹${totalPaid.toFixed(2)}) would exceed grand total (₹${grandTotal.toFixed(2)}).`
            );
        }
        const newOutstanding = Math.max(0, Math.round((grandTotal - totalPaid) * 100) / 100);
        const updatedInvoice = await tx.invoice.update({
            where: { id: invoice.id },
            data: {
                paidAmount: totalPaid,
                outstandingAmount: newOutstanding,
                version: { increment: 1 }
            }
        });

        const lastRev = invoice.revisions[0];
        await tx.invoiceRevision.create({
            data: {
                invoiceId: invoice.id,
                revisionNo: (lastRev ? lastRev.revisionNo : 0) + 1,
                action: 'CHEQUE_CLEARED',
                changedById: userId || invoice.createdById,
                ipAddress: meta ? meta.ipAddress : null,
                userAgent: meta ? meta.userAgent : null,
                changes: {
                    action: 'CHEQUE_CLEARED',
                    paymentId: payment.id,
                    amount: Number(payment.amount),
                    reference: payment.reference,
                    clearedAt: clearedAt.toISOString().slice(0, 10),
                    previousOutstandingAmount: Number(invoice.outstandingAmount),
                    newOutstandingAmount: newOutstanding,
                    paidAmount: totalPaid,
                    outstandingAmount: newOutstanding,
                    summary: `Cheque ${payment.reference || `#${payment.id}`} cleared on ${clearedAt.toISOString().slice(0, 10)}. Outstanding balance: ₹${newOutstanding.toFixed(2)}.`
                },
                snapshot: {
                    ...updatedInvoice,
                    grandTotal: Number(updatedInvoice.grandTotal),
                    paidAmount: Number(updatedInvoice.paidAmount),
                    outstandingAmount: Number(updatedInvoice.outstandingAmount)
                }
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CLEAR_PAYMENT',
                module: 'PAYMENTS',
                targetType: 'PAYMENT',
                targetId: payment.id,
                targetReference: payment.reference || `Payment #${payment.id}`,
                metadata: {
                    invoiceId: invoice.id,
                    invoiceNumber: invoice.invoiceNumber,
                    amount: Number(payment.amount),
                    method: payment.method,
                    clearedAt: clearedAt.toISOString().slice(0, 10)
                }
            }, tx);
        }

        const postingResult = await postingService.postPayment(payment.id, { userId }, tx);
        return {
            payment: { ...updatedPayment, amount: Number(updatedPayment.amount), journal: postingResult.journal },
            invoice: {
                ...updatedInvoice,
                grandTotal: Number(updatedInvoice.grandTotal),
                paidAmount: Number(updatedInvoice.paidAmount),
                outstandingAmount: Number(updatedInvoice.outstandingAmount)
            },
            journal: postingResult.journal
        };
    }, { timeout: 30000, maxWait: 10000 });
}

/**
 * Void an existing posted payment
 */
async function voidPayment(paymentIdInput, userId, reason = '', meta = {}) {
    const paymentId = parseInt(paymentIdInput, 10);
    if (isNaN(paymentId) || paymentId <= 0) {
        throw new ValidationError('Invalid payment ID.');
    }

    return prisma.$transaction(async (tx) => {
        // Acquire row lock on payment and invoice in MySQL
        await tx.$executeRawUnsafe('SELECT id FROM payments WHERE id = ? FOR UPDATE', paymentId);

        const payment = await tx.payment.findUnique({
            where: { id: paymentId },
            include: { invoice: true, financialYear: true }
        });

        if (!payment) {
            throw new NotFoundError(`Payment with ID ${paymentId} not found.`);
        }

        const invoiceBusinessId = payment.invoice.businessId || 1;
        await businessService.assertUserBusinessAccess(userId, invoiceBusinessId, meta.businessId || invoiceBusinessId);
        if ((payment.businessId && payment.businessId !== invoiceBusinessId) ||
            (payment.financialYear?.businessId && payment.financialYear.businessId !== invoiceBusinessId)) {
            throw new ValidationError('Payment and financial year must belong to the invoice business.');
        }
        const journalKey = postingService.getPaymentIdempotencyKey(payment.id);
        const existingJournal = await tx.journalEntry.findUnique({
            where: { idempotencyKey: journalKey },
            include: { financialYear: true, lines: { include: { account: true, client: true } } }
        });
        if (existingJournal && ((existingJournal.businessId || 1) !== invoiceBusinessId ||
            (existingJournal.financialYear?.businessId || 1) !== invoiceBusinessId ||
            existingJournal.lines.some(line => (line.account.businessId || 1) !== invoiceBusinessId ||
                (line.client && (line.client.businessId || 1) !== invoiceBusinessId)))) {
            throw new ValidationError('Payment journal does not belong to the invoice business.');
        }

        if (payment.status === 'POSTED' && payment.financialYear && payment.financialYear.status === 'CLOSED') {
            throw new ValidationError(`Cannot void payment in CLOSED Financial Year ${payment.financialYear.code}.`);
        }

        if (payment.status === 'VOID') {
            throw new ValidationError('Payment has already been voided.');
        }

        if (payment.invoice.status === 'VOID') {
            throw new ValidationError('Cannot void payment for a VOID invoice.');
        }

        if (payment.invoice.status === 'DELETED') {
            throw new ValidationError('Cannot void payment for a DELETED invoice.');
        }

        const voidNote = `Voided: ${reason ? reason.trim() : 'No reason provided'}`;
        const updatedPayment = await tx.payment.update({
            where: { id: payment.id },
            data: {
                status: 'VOID',
                notes: payment.notes ? `${payment.notes} | ${voidNote}` : voidNote
            }
        });

        // Recalculate totals
        const postedPayments = await tx.payment.findMany({
            where: { invoiceId: payment.invoiceId, status: 'POSTED' }
        });
        const totalPaid = postedPayments.reduce((acc, p) => acc + Number(p.amount), 0);
        const grandTotal = Number(payment.invoice.grandTotal);
        const newOutstanding = Math.max(0, Math.round((grandTotal - totalPaid) * 100) / 100);

        const updatedInvoice = await tx.invoice.update({
            where: { id: payment.invoiceId },
            data: {
                paidAmount: totalPaid,
                outstandingAmount: newOutstanding,
                version: { increment: 1 }
            }
        });

        // Add Revision
        const lastRev = await tx.invoiceRevision.findFirst({
            where: { invoiceId: payment.invoiceId },
            orderBy: { revisionNo: 'desc' }
        });
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;
        await tx.invoiceRevision.create({
            data: {
                invoiceId: payment.invoiceId,
                revisionNo: nextRevNo,
                action: 'PAYMENT_VOIDED',
                changedById: userId || payment.invoice.createdById,
                ipAddress: meta ? meta.ipAddress : null,
                userAgent: meta ? meta.userAgent : null,
                changes: {
                    action: 'PAYMENT_VOIDED',
                    paymentId: payment.id,
                    voidReason: reason || 'Voided by user',
                    previousOutstandingAmount: Number(payment.invoice.outstandingAmount),
                    restoredOutstandingAmount: newOutstanding,
                    paidAmount: totalPaid,
                    outstandingAmount: newOutstanding,
                    summary: `Payment #${payment.id} of ₹${Number(payment.amount).toFixed(2)} voided.${reason ? ' Reason: ' + reason : ''} Outstanding balance restored to ₹${newOutstanding.toFixed(2)}.`
                },
                snapshot: {
                    ...updatedInvoice,
                    grandTotal: Number(updatedInvoice.grandTotal),
                    paidAmount: Number(updatedInvoice.paidAmount),
                    outstandingAmount: Number(updatedInvoice.outstandingAmount)
                }
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'VOID_PAYMENT',
                module: 'PAYMENTS',
                targetType: 'PAYMENT',
                targetId: updatedPayment.id,
                targetReference: updatedPayment.reference || `Payment #${updatedPayment.id}`,
                metadata: { invoiceId: payment.invoice.id, invoiceNumber: payment.invoice.invoiceNumber, amount: Number(updatedPayment.amount), reason }
            }, tx).catch(() => {});
        }

        // If payment has a posted ledger journal, atomically reverse it
        let reversalJournal = null;
        if (existingJournal && existingJournal.status !== 'REVERSED') {
            reversalJournal = await journalService.reverseJournalEntry(
                existingJournal.id,
                {
                    reason: `Voided payment #${payment.id}: ${reason ? reason.trim() : 'Voided by user'}`,
                    reversalDate: new Date(),
                    userId
                },
                tx
            );
        }

        return {
            payment: {
                ...updatedPayment,
                amount: Number(updatedPayment.amount)
            },
            invoice: {
                ...updatedInvoice,
                grandTotal: Number(updatedInvoice.grandTotal),
                paidAmount: Number(updatedInvoice.paidAmount),
                outstandingAmount: Number(updatedInvoice.outstandingAmount)
            },
            reversalJournal
        };
    }, { timeout: 15000, maxWait: 10000 });
}

module.exports = {
    ValidationError,
    NotFoundError,
    getPaymentStatus,
    getInvoicePayments,
    recordPayment,
    clearPayment,
    voidPayment
};
