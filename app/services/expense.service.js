'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const journalService = require('./journal.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');

/**
 * Creates an expense and posts it to the double-entry accounting ledger.
 */
async function createExpense(data = {}, userId) {
    const amount = parseFloat(data.amount);
    if (isNaN(amount) || amount <= 0) {
        throw new ValidationError('Expense amount must be a positive number.');
    }

    const expenseDate = data.expenseDate ? new Date(data.expenseDate) : new Date();
    if (isNaN(expenseDate.getTime())) {
        throw new ValidationError('Invalid expense date.');
    }

    const description = (data.description || '').trim();
    if (!description) {
        throw new ValidationError('Expense description is required.');
    }

    const category = (data.category || 'General Expense').trim();
    const paymentMethod = (data.paymentMethod || 'BANK').toUpperCase();

    // Enforce FY
    const fy = await ensureFinancialYear(expenseDate);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot record expense in closed Financial Year ${fy.code}.`);
    }

    const roundAmount = Math.round(amount * 100) / 100;

    return prisma.$transaction(async (tx) => {
        // 1. Create Expense record
        const expense = await tx.expense.create({
            data: {
                expenseDate,
                amount: roundAmount,
                description,
                category,
                financialYearId: fy.id,
                createdById: userId,
                updatedById: userId,
                version: 1
            }
        });

        // 2. Identify double-entry accounts
        // Debit: Admin Expense (5210)
        let expenseAccount = await tx.chartOfAccount.findFirst({
            where: { code: '5210' }
        });
        if (!expenseAccount) {
            expenseAccount = await tx.chartOfAccount.findFirst({
                where: { type: 'EXPENSE', allowPosting: true }
            });
        }

        // Credit: Bank (1112) or Cash (1111)
        const creditAccountKey = paymentMethod === 'CASH' ? 'CASH_ON_HAND' : 'BANK_ACCOUNT';
        let cashBankAccount = await tx.chartOfAccount.findFirst({
            where: { systemAccountKey: creditAccountKey }
        });
        if (!cashBankAccount) {
            cashBankAccount = await tx.chartOfAccount.findFirst({
                where: { type: 'ASSET', subtype: 'CASH_BANK', allowPosting: true }
            });
        }

        if (!expenseAccount || !cashBankAccount) {
            throw new Error('Required Expense or Cash/Bank account missing from chart of accounts.');
        }

        // 3. Post double-entry journal
        await journalService.postJournalEntry({
            entryDate: expenseDate,
            financialYearId: fy.id,
            sourceType: 'EXPENSE',
            sourceId: expense.id,
            idempotencyKey: `EXPENSE:${expense.id}`,
            narration: `Expense: ${category} - ${description}`,
            lines: [
                {
                    accountId: expenseAccount.id,
                    debit: roundAmount,
                    credit: 0,
                    description: `Expense (${category}): ${description}`
                },
                {
                    accountId: cashBankAccount.id,
                    debit: 0,
                    credit: roundAmount,
                    description: `Payment via ${paymentMethod} for ${description}`
                }
            ],
            userId
        }, tx);

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE',
                module: 'FINANCIALS',
                targetType: 'EXPENSE',
                targetId: expense.id,
                description: `Recorded expense of $${roundAmount} (${category})`
            });
        }

        return expense;
    });
}

async function getExpenseById(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid expense ID.');
    const expense = await prisma.expense.findUnique({
        where: { id: numId },
        include: { financialYear: true, createdBy: true }
    });
    if (!expense) throw new NotFoundError(`Expense with ID ${numId} not found.`);
    return expense;
}

async function listExpenses({ category, dateFrom, dateTo, search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (category) where.category = category;
    if (dateFrom || dateTo) {
        where.expenseDate = {};
        if (dateFrom) where.expenseDate.gte = new Date(dateFrom);
        if (dateTo) where.expenseDate.lte = new Date(dateTo);
    }
    if (search) {
        where.description = { contains: search };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.expense.count({ where }),
        prisma.expense.findMany({
            where,
            orderBy: { expenseDate: 'desc' },
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

module.exports = {
    createExpense,
    getExpenseById,
    listExpenses,
    ValidationError,
    NotFoundError,
    ConflictError
};
