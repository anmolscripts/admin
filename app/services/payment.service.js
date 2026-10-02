const prisma = require('../config/prisma');

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

    if (invoice.invoiceDate) {
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
async function getInvoicePayments(invoiceIdInput) {
    const invoiceId = parseInt(invoiceIdInput, 10);
    if (isNaN(invoiceId) || invoiceId <= 0) {
        throw new ValidationError('Invalid invoice ID.');
    }

    const payments = await prisma.payment.findMany({
        where: { invoiceId },
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

    let method = (paymentData.method || 'BANK_TRANSFER').toString().trim().toUpperCase();
    if (method === 'CREDIT_CARD') method = 'CARD';
    if (!ALLOWED_METHODS.includes(method)) {
        method = 'BANK_TRANSFER';
    }

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

        if (invoice.documentType !== 'INVOICE') {
            throw new ValidationError('Payments can only be recorded for invoices, not quotations.');
        }

        if (invoice.status === 'VOID') {
            throw new ValidationError('Cannot record payment for a VOID invoice.');
        }

        if (invoice.status === 'DELETED') {
            throw new ValidationError('Cannot record payment for a DELETED invoice.');
        }

        const currentOutstanding = Number(invoice.outstandingAmount);
        if (amount > currentOutstanding + 0.001) {
            throw new ValidationError(
                `Payment amount (₹${amount.toFixed(2)}) exceeds the invoice outstanding balance (₹${currentOutstanding.toFixed(2)}).`
            );
        }

        const payment = await tx.payment.create({
            data: {
                invoiceId: invoice.id,
                amount,
                paymentDate,
                method,
                reference: paymentData.reference ? paymentData.reference.trim() : null,
                notes: paymentData.notes ? paymentData.notes.trim() : null,
                status: 'POSTED',
                createdById: userId || null
            }
        });

        // Recalculate totals from all POSTED payments
        const postedPayments = await tx.payment.findMany({
            where: { invoiceId: invoice.id, status: 'POSTED' }
        });
        const totalPaid = Math.round(postedPayments.reduce((acc, p) => acc + Number(p.amount), 0) * 100) / 100;
        const grandTotal = Number(invoice.grandTotal);

        if (totalPaid > grandTotal + 0.001) {
            throw new ValidationError(
                `Payment cannot be recorded: total paid (₹${totalPaid.toFixed(2)}) would exceed grand total (₹${grandTotal.toFixed(2)}).`
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

        // Append Revision record
        const lastRev = invoice.revisions[0];
        const nextRevNo = (lastRev ? lastRev.revisionNo : 0) + 1;
        await tx.invoiceRevision.create({
            data: {
                invoiceId: invoice.id,
                revisionNo: nextRevNo,
                action: 'PAYMENT_RECORDED',
                changedById: userId || invoice.createdById,
                ipAddress: meta ? meta.ipAddress : null,
                userAgent: meta ? meta.userAgent : null,
                changes: {
                    action: 'PAYMENT_RECORDED',
                    paymentId: payment.id,
                    amount,
                    method,
                    reference: payment.reference,
                    previousOutstandingAmount: Number(invoice.outstandingAmount),
                    newOutstandingAmount: newOutstanding,
                    paidAmount: totalPaid,
                    outstandingAmount: newOutstanding,
                    summary: `Payment of ₹${amount.toFixed(2)} recorded via ${method}.${payment.reference ? ' Ref: ' + payment.reference : ''} Outstanding balance: ₹${newOutstanding.toFixed(2)}.`
                },
                snapshot: {
                    ...updatedInvoice,
                    grandTotal: Number(updatedInvoice.grandTotal),
                    paidAmount: Number(updatedInvoice.paidAmount),
                    outstandingAmount: Number(updatedInvoice.outstandingAmount)
                }
            }
        });

        return {
            payment: {
                ...payment,
                amount: Number(payment.amount)
            },
            invoice: {
                ...updatedInvoice,
                grandTotal: Number(updatedInvoice.grandTotal),
                paidAmount: Number(updatedInvoice.paidAmount),
                outstandingAmount: Number(updatedInvoice.outstandingAmount)
            }
        };
    });
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
            include: { invoice: true }
        });

        if (!payment) {
            throw new NotFoundError(`Payment with ID ${paymentId} not found.`);
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
            }
        };
    });
}

module.exports = {
    ValidationError,
    NotFoundError,
    getPaymentStatus,
    getInvoicePayments,
    recordPayment,
    voidPayment
};
