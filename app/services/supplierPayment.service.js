'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const journalService = require('./journal.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');

const ALLOWED_METHODS = ['BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', 'CARD'];

/**
 * Generate sequential payment number: SPAY-YYYYMMDD-XXXX
 */
async function generatePaymentNumber() {
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `SPAY-${todayStr}-`;
    const lastPayment = await prisma.supplierPayment.findFirst({
        where: { paymentNumber: { startsWith: prefix } },
        orderBy: { paymentNumber: 'desc' },
        select: { paymentNumber: true }
    });

    let nextSeq = 1;
    if (lastPayment && lastPayment.paymentNumber) {
        const parts = lastPayment.paymentNumber.split('-');
        const seqNum = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(seqNum)) nextSeq = seqNum + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

/**
 * Record an outgoing supplier payment and post double-entry accounting entry.
 * Debit: Accounts Payable (ACCOUNTS_PAYABLE / 2121)
 * Credit: Bank Account (BANK_ACCOUNT / 1112) or Cash (CASH_ON_HAND / 1111)
 */
async function recordSupplierPayment(data = {}, userId) {
    const supplierId = parseInt(data.supplierId, 10);
    if (isNaN(supplierId) || supplierId <= 0) {
        throw new ValidationError('Valid supplier ID is required.');
    }

    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) {
        throw new NotFoundError(`Supplier with ID ${supplierId} not found.`);
    }

    const rawAmount = parseFloat(data.amount);
    if (isNaN(rawAmount) || rawAmount <= 0) {
        throw new ValidationError('Payment amount must be greater than 0.');
    }
    const amount = Math.round(rawAmount * 100) / 100;

    const paymentDate = data.paymentDate ? new Date(data.paymentDate) : new Date();
    if (isNaN(paymentDate.getTime())) {
        throw new ValidationError('Invalid payment date.');
    }

    // Enforce open financial year
    const fy = await ensureFinancialYear(paymentDate);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot record payment into closed Financial Year ${fy.code}.`);
    }

    const rawMethod = (data.method || 'BANK_TRANSFER').toString().trim().toUpperCase();
    if (!ALLOWED_METHODS.includes(rawMethod)) {
        throw new ValidationError(`Unsupported payment method "${data.method}". Allowed methods: ${ALLOWED_METHODS.join(', ')}.`);
    }

    let supplierBillId = null;
    let bill = null;
    if (data.supplierBillId) {
        supplierBillId = parseInt(data.supplierBillId, 10);
        if (isNaN(supplierBillId) || supplierBillId <= 0) {
            throw new ValidationError('Invalid supplier bill ID.');
        }
        bill = await prisma.supplierBill.findUnique({
            where: { id: supplierBillId },
            include: { supplierPayments: { where: { status: { not: 'VOID' } } } }
        });
        if (!bill) {
            throw new NotFoundError(`Supplier Bill with ID ${supplierBillId} not found.`);
        }
        if (bill.supplierId !== supplierId) {
            throw new ValidationError(`Supplier Bill ${bill.billNumber} does not belong to supplier ${supplier.name}.`);
        }
        if (bill.status === 'VOID') {
            throw new ValidationError(`Cannot allocate payment to a VOID supplier bill.`);
        }

        const totalPaidSoFar = bill.supplierPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
        const billTotal = parseFloat(bill.totalAmount);
        const outstanding = Math.round((billTotal - totalPaidSoFar) * 100) / 100;

        if (amount > outstanding + 0.001) {
            throw new ValidationError(
                `Payment amount (${amount}) exceeds supplier bill outstanding balance (${outstanding}).`
            );
        }
    }

    return prisma.$transaction(async (tx) => {
        const paymentNumber = await generatePaymentNumber();

        // 1. Create SupplierPayment
        const payment = await tx.supplierPayment.create({
            data: {
                paymentNumber,
                supplierId,
                supplierBillId,
                paymentDate,
                amount,
                method: rawMethod,
                reference: data.reference ? String(data.reference).trim() : null,
                notes: data.notes ? String(data.notes).trim() : null,
                status: 'POSTED',
                financialYearId: fy.id,
                createdById: userId
            },
            include: {
                supplier: true,
                supplierBill: true,
                financialYear: true
            }
        });

        // 2. Fetch Chart of Accounts
        const apAccount = await tx.chartOfAccount.findFirst({
            where: { systemAccountKey: 'ACCOUNTS_PAYABLE' }
        });
        const paymentAccountKey = rawMethod === 'CASH' ? 'CASH_ON_HAND' : 'BANK_ACCOUNT';
        const paymentAccount = await tx.chartOfAccount.findFirst({
            where: { systemAccountKey: paymentAccountKey }
        });

        if (!apAccount || !paymentAccount) {
            throw new Error(`System chart of accounts missing required Accounts Payable or ${paymentAccountKey} account.`);
        }

        // 3. Prepare balanced journal lines:
        // Dr: Accounts Payable (reduces liability to supplier)
        // Cr: Cash/Bank (reduces asset)
        const journalLines = [
            {
                accountId: apAccount.id,
                debit: amount,
                credit: 0,
                description: `Payment to ${supplier.name} - ${paymentNumber}${bill ? ` against Bill #${bill.billNumber}` : ''}`
            },
            {
                accountId: paymentAccount.id,
                debit: 0,
                credit: amount,
                description: `Payment to ${supplier.name} via ${rawMethod} - ${paymentNumber}`
            }
        ];

        // 4. Post journal entry
        await journalService.postJournalEntry({
            entryDate: paymentDate,
            financialYearId: fy.id,
            sourceType: 'SUPPLIER_PAYMENT',
            sourceId: payment.id,
            idempotencyKey: `SUPPLIER_PAYMENT:${payment.id}`,
            narration: `Supplier Payment ${paymentNumber} to ${supplier.name} (${rawMethod})`,
            lines: journalLines,
            userId
        }, tx);

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE',
                module: 'PURCHASES',
                targetType: 'SUPPLIER_PAYMENT',
                targetId: payment.id,
                description: `Recorded supplier payment ${paymentNumber} for $${amount} to ${supplier.name}`
            });
        }

        return payment;
    });
}

/**
 * Get supplier payment by ID
 */
async function getSupplierPaymentById(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid supplier payment ID.');

    const payment = await prisma.supplierPayment.findUnique({
        where: { id: numId },
        include: {
            supplier: true,
            supplierBill: true,
            financialYear: true,
            createdBy: { select: { id: true, name: true, email: true } }
        }
    });

    if (!payment) throw new NotFoundError(`Supplier payment with ID ${numId} not found.`);
    return payment;
}

/**
 * List supplier payments with filtering & pagination
 */
async function listSupplierPayments({ supplierId, supplierBillId, status, dateFrom, dateTo, search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (supplierId) where.supplierId = parseInt(supplierId, 10);
    if (supplierBillId) where.supplierBillId = parseInt(supplierBillId, 10);
    if (status) where.status = status;
    if (dateFrom || dateTo) {
        where.paymentDate = {};
        if (dateFrom) where.paymentDate.gte = new Date(dateFrom);
        if (dateTo) where.paymentDate.lte = new Date(dateTo);
    }
    if (search) {
        where.OR = [
            { paymentNumber: { contains: search } },
            { reference: { contains: search } },
            { supplier: { name: { contains: search } } }
        ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.supplierPayment.count({ where }),
        prisma.supplierPayment.findMany({
            where,
            include: { supplier: true, supplierBill: true, financialYear: true },
            orderBy: { paymentDate: 'desc' },
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

/**
 * Void supplier payment and reverse accounting entries
 */
async function voidSupplierPayment(id, userId, reason = '') {
    const payment = await getSupplierPaymentById(id);
    if (payment.status === 'VOID') {
        throw new ConflictError('Supplier payment is already VOID.');
    }

    return prisma.$transaction(async (tx) => {
        // Reverse journal entry if posted
        const originalEntry = await tx.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_PAYMENT:${payment.id}` }
        });

        if (originalEntry && originalEntry.status !== 'REVERSED') {
            await journalService.reverseJournalEntry(originalEntry.id, {
                reversalDate: new Date(),
                reason: reason || `Voided Supplier Payment ${payment.paymentNumber}`,
                userId
            }, tx);
        }

        const updated = await tx.supplierPayment.update({
            where: { id: payment.id },
            data: {
                status: 'VOID'
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'VOID',
                module: 'PURCHASES',
                targetType: 'SUPPLIER_PAYMENT',
                targetId: payment.id,
                description: `Voided Supplier Payment ${payment.paymentNumber}. Reason: ${reason}`
            });
        }

        return updated;
    });
}

module.exports = {
    recordSupplierPayment,
    getSupplierPaymentById,
    listSupplierPayments,
    voidSupplierPayment,
    ALLOWED_METHODS,
    ValidationError,
    NotFoundError,
    ConflictError
};
