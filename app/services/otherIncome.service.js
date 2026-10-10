'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const journalService = require('./journal.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');

/**
 * Creates a non-invoice other income entry and posts it to the accounting ledger.
 */
async function createOtherIncome(data = {}, userId) {
    const amount = parseFloat(data.amount);
    if (isNaN(amount) || amount <= 0) {
        throw new ValidationError('Income amount must be a positive number.');
    }

    const incomeDate = data.incomeDate ? new Date(data.incomeDate) : new Date();
    if (isNaN(incomeDate.getTime())) {
        throw new ValidationError('Invalid income date.');
    }

    const description = (data.description || '').trim();
    if (!description) {
        throw new ValidationError('Income description is required.');
    }

    const source = (data.source || 'Other Income').trim();
    const receiptMethod = (data.receiptMethod || 'BANK').toUpperCase();

    // Enforce FY
    const fy = await ensureFinancialYear(incomeDate);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot record income in closed Financial Year ${fy.code}.`);
    }

    const roundAmount = Math.round(amount * 100) / 100;

    return prisma.$transaction(async (tx) => {
        // 1. Create OtherIncome record
        const income = await tx.otherIncome.create({
            data: {
                incomeDate,
                amount: roundAmount,
                description,
                source,
                financialYearId: fy.id,
                createdById: userId,
                updatedById: userId,
                version: 1
            }
        });

        // 2. Identify double-entry accounts
        // Debit: Bank (1112) or Cash (1111)
        const debitAccountKey = receiptMethod === 'CASH' ? 'CASH_ON_HAND' : 'BANK_ACCOUNT';
        let cashBankAccount = await tx.chartOfAccount.findFirst({
            where: { systemAccountKey: debitAccountKey }
        });
        if (!cashBankAccount) {
            cashBankAccount = await tx.chartOfAccount.findFirst({
                where: { type: 'ASSET', subtype: 'CASH_BANK', allowPosting: true }
            });
        }

        // Credit: Service Income (4120) or Other Income
        let incomeAccount = await tx.chartOfAccount.findFirst({
            where: { systemAccountKey: 'SERVICE_INCOME' }
        });
        if (!incomeAccount) {
            incomeAccount = await tx.chartOfAccount.findFirst({
                where: { type: 'INCOME', allowPosting: true }
            });
        }

        if (!cashBankAccount || !incomeAccount) {
            throw new Error('Required Cash/Bank or Income account missing from chart of accounts.');
        }

        // 3. Post double-entry journal
        await journalService.postJournalEntry({
            entryDate: incomeDate,
            financialYearId: fy.id,
            sourceType: 'OTHER_INCOME',
            sourceId: income.id,
            idempotencyKey: `OTHER_INCOME:${income.id}`,
            narration: `Other Income: ${source} - ${description}`,
            lines: [
                {
                    accountId: cashBankAccount.id,
                    debit: roundAmount,
                    credit: 0,
                    description: `Received via ${receiptMethod}: ${description}`
                },
                {
                    accountId: incomeAccount.id,
                    debit: 0,
                    credit: roundAmount,
                    description: `Income (${source}): ${description}`
                }
            ],
            userId
        }, tx);

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE',
                module: 'FINANCIALS',
                targetType: 'OTHER_INCOME',
                targetId: income.id,
                description: `Recorded other income of $${roundAmount} from ${source}`
            });
        }

        return income;
    });
}

async function getOtherIncomeById(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid income ID.');
    const income = await prisma.otherIncome.findUnique({
        where: { id: numId },
        include: { financialYear: true, createdBy: true }
    });
    if (!income) throw new NotFoundError(`Other income with ID ${numId} not found.`);
    return income;
}

async function listOtherIncomes({ source, dateFrom, dateTo, search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (source) where.source = source;
    if (dateFrom || dateTo) {
        where.incomeDate = {};
        if (dateFrom) where.incomeDate.gte = new Date(dateFrom);
        if (dateTo) where.incomeDate.lte = new Date(dateTo);
    }
    if (search) {
        where.description = { contains: search };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.otherIncome.count({ where }),
        prisma.otherIncome.findMany({
            where,
            orderBy: { incomeDate: 'desc' },
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

module.exports = {
    createOtherIncome,
    getOtherIncomeById,
    listOtherIncomes,
    ValidationError,
    NotFoundError,
    ConflictError
};
