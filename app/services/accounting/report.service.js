'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — FINANCIAL REPORTS & RECONCILIATION SERVICE (MILESTONE 7)
 * ==============================================================================
 *
 * Provides server-authoritative financial reporting and accounting reconciliation
 * built on double-entry general ledger journal entries and chart of accounts:
 *
 * 1. Journal Register: Searchable entries with filterable dimensions and control totals.
 * 2. General Ledger: Account-level transaction statement with running balances.
 * 3. Trial Balance: Cutoff debit/credit balances verifying control total equality.
 * 4. Profit & Loss: Revenue, Cost of Sales, Gross Profit, Expenses, Net Profit/(Loss).
 * 5. Balance Sheet: Assets, Liabilities, Equity + Current Period Earnings.
 * 6. Customer Receivables & Subledger Reconciliation:
 *    Ageing buckets (0-30, 31-60, 61-90, 90+ days) and AR subledger-to-GL reconciliation.
 *
 * Invariants:
 * - Integer-cent BigInt arithmetic down to exact cents.
 * - Reversals naturally offset original entries; both are included to preserve history.
 * - Draft/non-posted records never affect accounting reports.
 * ==============================================================================
 */

const prisma = require('../../config/prisma');
const coaService = require('../chartOfAccounts.service');
const { computeFinancialYear } = require('../financialYear.service');

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

/**
 * Server-authoritative integer-cent conversion helpers
 */
function toCents(amount) {
    if (amount === undefined || amount === null) return 0n;
    const str = String(amount).trim();
    if (!str) return 0n;
    const isNegative = str.startsWith('-');
    const cleanStr = isNegative ? str.slice(1) : str;
    const parts = cleanStr.split('.');
    const whole = BigInt(parts[0] || '0');
    const fracStr = (parts[1] || '').padEnd(2, '0').slice(0, 2);
    const frac = BigInt(fracStr);
    const total = whole * 100n + frac;
    return isNegative ? -total : total;
}

function fromCents(cents) {
    const isNegative = cents < 0n;
    const abs = isNegative ? -cents : cents;
    const whole = abs / 100n;
    const frac = abs % 100n;
    const sign = isNegative ? '-' : '';
    return `${sign}${whole.toString()}.${frac.toString().padStart(2, '0')}`;
}

/**
 * Server-authoritative date boundary parsing helpers
 */
function parseStartOfDay(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;
    const s = String(dateStr).trim();
    if (s.length === 10) {
        return new Date(`${s}T00:00:00.000Z`);
    }
    return new Date(s);
}

function parseEndOfDay(dateStr) {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;
    const s = String(dateStr).trim();
    if (s.length === 10) {
        return new Date(`${s}T23:59:59.999Z`);
    }
    return new Date(s);
}

function getFinancialYearDateBounds(fy) {
    if (!fy) return { startDate: null, endDate: null };
    const startYear = parseInt(String(fy.code).split('-')[0], 10);
    if (!isNaN(startYear) && startYear > 1900) {
        const nextYear = startYear + 1;
        return {
            startDate: new Date(`${startYear}-04-01T00:00:00.000Z`),
            endDate: new Date(`${nextYear}-03-31T23:59:59.999Z`)
        };
    }
    return { startDate: new Date(fy.startDate), endDate: new Date(fy.endDate) };
}

function resolveBusinessScoping(filters = {}, fy = null) {
    if (filters.allBusinesses === true) {
        return { targetBizId: null, accountBusinessFilter: undefined, journalBusinessFilter: undefined, clientBusinessFilter: undefined };
    }
    let targetBizId = null;
    if (filters.businessId !== undefined) {
        if (filters.businessId !== null && filters.businessId !== '' && filters.businessId !== 'null') {
            const parsed = parseInt(filters.businessId, 10);
            targetBizId = isNaN(parsed) ? null : parsed;
        }
    } else if (fy && fy.businessId !== undefined && fy.businessId !== null) {
        targetBizId = fy.businessId;
    }

    if (!targetBizId || targetBizId === 1) {
        return {
            targetBizId: 1,
            accountBusinessFilter: null,
            journalBusinessFilter: 'DEFAULT_COMPANY',
            clientBusinessFilter: 'DEFAULT_COMPANY'
        };
    } else {
        return {
            targetBizId,
            accountBusinessFilter: targetBizId,
            journalBusinessFilter: targetBizId,
            clientBusinessFilter: targetBizId
        };
    }
}

function applyJournalBusinessScope(targetObj, scoping) {
    if (!scoping || scoping.journalBusinessFilter === undefined) return;
    if (scoping.journalBusinessFilter === 'DEFAULT_COMPANY') {
        targetObj.OR = [{ businessId: 1 }, { businessId: null }];
    } else {
        targetObj.businessId = scoping.journalBusinessFilter;
    }
}

/**
 * 1. JOURNAL REGISTER
 * Searchable register of journal entries with debit/credit balance verification.
 *
 * @param {Object} filters
 * @returns {Promise<Object>}
 */
async function getJournalRegister(filters = {}) {
    const page = Math.max(1, parseInt(filters.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit || '25', 10)));
    const skip = (page - 1) * limit;

    const where = {};
    const scoping = resolveBusinessScoping(filters);
    applyJournalBusinessScope(where, scoping);

    // Financial Year filter
    if (filters.financialYearId) {
        where.financialYearId = parseInt(filters.financialYearId, 10);
    }

    // Date range filter
    if (filters.fromDate || filters.toDate) {
        where.entryDate = {};
        if (filters.fromDate) where.entryDate.gte = parseStartOfDay(filters.fromDate);
        if (filters.toDate) where.entryDate.lte = parseEndOfDay(filters.toDate);
    }

    // Source Type filter
    if (filters.sourceType) {
        where.sourceType = String(filters.sourceType).trim().toUpperCase();
    }

    // Status filter (default: POSTED & REVERSED, excludes any drafts if ever present)
    if (filters.status && filters.status !== 'ALL') {
        where.status = String(filters.status).trim().toUpperCase();
    } else {
        where.status = { in: ['POSTED', 'REVERSED'] };
    }

    // Account or Client subledger filter
    if (filters.accountId || filters.clientId) {
        where.lines = {
            some: {
                ...(filters.accountId ? { accountId: parseInt(filters.accountId, 10) } : {}),
                ...(filters.clientId ? { clientId: parseInt(filters.clientId, 10) } : {})
            }
        };
    }

    // Search query filter (narration or entryNumber)
    if (filters.search) {
        const q = String(filters.search).trim();
        where.OR = [
            { entryNumber: { contains: q } },
            { narration: { contains: q } }
        ];
    }

    const [total, entries] = await Promise.all([
        prisma.journalEntry.count({ where }),
        prisma.journalEntry.findMany({
            where,
            orderBy: [
                { entryDate: 'desc' },
                { id: 'desc' }
            ],
            skip,
            take: limit,
            include: {
                financialYear: { select: { id: true, code: true } },
                postedBy: { select: { id: true, name: true, email: true } },
                reversedEntry: { select: { id: true, entryNumber: true } },
                reversingEntry: { select: { id: true, entryNumber: true } },
                lines: {
                    include: {
                        account: { select: { id: true, code: true, name: true, type: true } },
                        client: { select: { id: true, name: true } }
                    },
                    orderBy: { lineNumber: 'asc' }
                }
            }
        })
    ]);

    // Aggregate summary for all matching entries (using integer-cents)
    let totalDebitCents = 0n;
    let totalCreditCents = 0n;

    const formattedEntries = entries.map(entry => {
        let entryDebitCents = 0n;
        let entryCreditCents = 0n;

        entry.lines.forEach(line => {
            const dr = toCents(line.debit);
            const cr = toCents(line.credit);
            entryDebitCents += dr;
            entryCreditCents += cr;
        });

        totalDebitCents += entryDebitCents;
        totalCreditCents += entryCreditCents;

        return {
            ...entry,
            totalDebit: fromCents(entryDebitCents),
            totalCredit: fromCents(entryCreditCents),
            isBalanced: entryDebitCents === entryCreditCents
        };
    });

    return {
        entries: formattedEntries,
        summary: {
            totalEntries: total,
            pageDebit: fromCents(totalDebitCents),
            pageCredit: fromCents(totalCreditCents),
            isBalanced: totalDebitCents === totalCreditCents
        },
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        },
        filters
    };
}

/**
 * 2. GENERAL LEDGER
 * Detailed account statement with running balance or multi-account ledger overview.
 *
 * @param {Object} filters
 * @returns {Promise<Object>}
 */
async function getGeneralLedgerReport(filters = {}) {
    if (filters.accountId) {
        // Detailed ledger for a specific account
        const accountId = parseInt(filters.accountId, 10);
        if (isNaN(accountId) || accountId <= 0) throw new ValidationError('Invalid account ID.');

        const account = await prisma.chartOfAccount.findUnique({
            where: { id: accountId },
            include: { parent: { select: { id: true, code: true, name: true } } }
        });
        if (!account) throw new NotFoundError(`Account ID ${accountId} not found.`);

        const isDebitNormal = account.type === 'ASSET' || account.type === 'EXPENSE';

        let fromDateObj = null;
        let toDateObj = null;

        if (filters.financialYearId) {
            const fy = await prisma.financialYear.findUnique({
                where: { id: parseInt(filters.financialYearId, 10) }
            });
            if (fy) {
                const bounds = getFinancialYearDateBounds(fy);
                if (!filters.fromDate) fromDateObj = bounds.startDate;
                if (!filters.toDate) toDateObj = bounds.endDate;
            }
        }

        if (filters.fromDate) fromDateObj = parseStartOfDay(filters.fromDate);
        if (filters.toDate) toDateObj = parseEndOfDay(filters.toDate);

        // 1. Calculate opening balance before fromDateObj (including all prior posted journals)
        let openingBalanceCents = toCents(account.openingBalance);
        if (account.openingBalanceType === 'CREDIT' && isDebitNormal) {
            openingBalanceCents = -openingBalanceCents;
        } else if (account.openingBalanceType === 'DEBIT' && !isDebitNormal) {
            openingBalanceCents = -openingBalanceCents;
        }

        if (fromDateObj) {
            const priorLines = await prisma.journalEntryLine.findMany({
                where: {
                    accountId,
                    journalEntry: {
                        status: { in: ['POSTED', 'REVERSED'] },
                        entryDate: { lt: fromDateObj }
                    }
                },
                select: { debit: true, credit: true }
            });

            for (const line of priorLines) {
                const dr = toCents(line.debit);
                const cr = toCents(line.credit);
                if (isDebitNormal) {
                    openingBalanceCents += (dr - cr);
                } else {
                    openingBalanceCents += (cr - dr);
                }
            }
        }

        // 2. Query transactions in the period
        const lineWhere = {
            accountId,
            journalEntry: {
                status: { in: ['POSTED', 'REVERSED'] }
            }
        };

        if (fromDateObj || toDateObj) {
            lineWhere.journalEntry.entryDate = {};
            if (fromDateObj) lineWhere.journalEntry.entryDate.gte = fromDateObj;
            if (toDateObj) lineWhere.journalEntry.entryDate.lte = toDateObj;
        }

        const lines = await prisma.journalEntryLine.findMany({
            where: lineWhere,
            orderBy: [
                { journalEntry: { entryDate: 'asc' } },
                { journalEntry: { id: 'asc' } },
                { lineNumber: 'asc' }
            ],
            include: {
                journalEntry: {
                    select: {
                        id: true,
                        entryNumber: true,
                        entryDate: true,
                        sourceType: true,
                        sourceId: true,
                        narration: true,
                        status: true
                    }
                },
                client: { select: { id: true, name: true } }
            }
        });

        let runningBalanceCents = openingBalanceCents;
        let totalDebitCents = 0n;
        let totalCreditCents = 0n;

        const transactions = lines.map(line => {
            const dr = toCents(line.debit);
            const cr = toCents(line.credit);
            totalDebitCents += dr;
            totalCreditCents += cr;

            if (isDebitNormal) {
                runningBalanceCents += (dr - cr);
            } else {
                runningBalanceCents += (cr - dr);
            }

            return {
                id: line.id,
                journalId: line.journalEntry.id,
                entryNumber: line.journalEntry.entryNumber,
                entryDate: line.journalEntry.entryDate,
                sourceType: line.journalEntry.sourceType,
                sourceId: line.journalEntry.sourceId,
                narration: line.journalEntry.narration,
                description: line.description,
                client: line.client,
                debit: fromCents(dr),
                credit: fromCents(cr),
                runningBalance: fromCents(runningBalanceCents),
                status: line.journalEntry.status
            };
        });

        return {
            account: {
                id: account.id,
                code: account.code,
                name: account.name,
                type: account.type,
                subtype: account.subtype,
                isDebitNormal,
                openingBalance: fromCents(openingBalanceCents),
                closingBalance: fromCents(runningBalanceCents)
            },
            summary: {
                totalDebit: fromCents(totalDebitCents),
                totalCredit: fromCents(totalCreditCents),
                netMovement: fromCents(isDebitNormal ? totalDebitCents - totalCreditCents : totalCreditCents - totalDebitCents),
                transactionCount: transactions.length
            },
            transactions,
            filters
        };
    }

    let fy = null;
    if (filters.financialYearId) {
        fy = await prisma.financialYear.findUnique({
            where: { id: parseInt(filters.financialYearId, 10) }
        });
    }

    const scoping = resolveBusinessScoping(filters, fy);

    // Multi-account General Ledger Summary
    const accounts = await prisma.chartOfAccount.findMany({
        where: {
            allowPosting: true,
            active: true,
            ...(scoping.accountBusinessFilter !== undefined ? { businessId: scoping.accountBusinessFilter } : {})
        },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        include: { parent: { select: { id: true, code: true, name: true } } }
    });

    let fromDateObj = null;
    let toDateObj = null;

    if (fy) {
        const bounds = getFinancialYearDateBounds(fy);
        if (!filters.fromDate) fromDateObj = bounds.startDate;
        if (!filters.toDate) toDateObj = bounds.endDate;
    }

    if (filters.fromDate) fromDateObj = parseStartOfDay(filters.fromDate);
    if (filters.toDate) toDateObj = parseEndOfDay(filters.toDate);

    const whereLines = {
        journalEntry: {
            status: { in: ['POSTED', 'REVERSED'] }
        }
    };
    applyJournalBusinessScope(whereLines.journalEntry, scoping);

    if (fromDateObj || toDateObj) {
        whereLines.journalEntry.entryDate = {};
        if (fromDateObj) whereLines.journalEntry.entryDate.gte = fromDateObj;
        if (toDateObj) whereLines.journalEntry.entryDate.lte = toDateObj;
    }

    const lines = await prisma.journalEntryLine.findMany({
        where: whereLines,
        select: {
            accountId: true,
            debit: true,
            credit: true
        }
    });

    const accountMovements = new Map();
    for (const line of lines) {
        const existing = accountMovements.get(line.accountId) || { drCents: 0n, crCents: 0n };
        existing.drCents += toCents(line.debit);
        existing.crCents += toCents(line.credit);
        accountMovements.set(line.accountId, existing);
    }

    let overallDrCents = 0n;
    let overallCrCents = 0n;

    const accountRows = accounts.map(acc => {
        const isDebitNormal = acc.type === 'ASSET' || acc.type === 'EXPENSE';
        let openingCents = toCents(acc.openingBalance);
        if (acc.openingBalanceType === 'CREDIT' && isDebitNormal) openingCents = -openingCents;
        else if (acc.openingBalanceType === 'DEBIT' && !isDebitNormal) openingCents = -openingCents;

        const mov = accountMovements.get(acc.id) || { drCents: 0n, crCents: 0n };
        overallDrCents += mov.drCents;
        overallCrCents += mov.crCents;

        const closingCents = isDebitNormal
            ? openingCents + mov.drCents - mov.crCents
            : openingCents + mov.crCents - mov.drCents;

        return {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            type: acc.type,
            subtype: acc.subtype,
            isDebitNormal,
            openingBalance: fromCents(openingCents),
            debit: fromCents(mov.drCents),
            credit: fromCents(mov.crCents),
            closingBalance: fromCents(closingCents)
        };
    });

    return {
        accounts: accountRows,
        summary: {
            totalDebit: fromCents(overallDrCents),
            totalCredit: fromCents(overallCrCents),
            isBalanced: overallDrCents === overallCrCents
        },
        filters
    };
}

/**
 * 3. TRIAL BALANCE
 * Verifies mathematical debit/credit equilibrium as of a cutoff date or for a Financial Year.
 *
 * @param {Object} filters
 * @returns {Promise<Object>}
 */
async function getTrialBalance(filters = {}) {
    let fy = null;
    if (filters.financialYearId) {
        fy = await prisma.financialYear.findUnique({
            where: { id: parseInt(filters.financialYearId, 10) }
        });
    }

    const scoping = resolveBusinessScoping(filters, fy);

    let cutoffDate = null;
    if (filters.asOfDate) {
        cutoffDate = parseEndOfDay(filters.asOfDate);
    } else if (fy && !filters.fromDate && !filters.toDate) {
        // As of the close of the selected Financial Year (carrying forward historical balances)
        const bounds = getFinancialYearDateBounds(fy);
        cutoffDate = bounds.endDate;
    }

    const whereLines = {
        journalEntry: {
            status: { in: ['POSTED', 'REVERSED'] }
        }
    };
    applyJournalBusinessScope(whereLines.journalEntry, scoping);

    if (cutoffDate) {
        whereLines.journalEntry.entryDate = { lte: cutoffDate };
    } else if (filters.fromDate || filters.toDate) {
        whereLines.journalEntry.entryDate = {};
        if (filters.fromDate) whereLines.journalEntry.entryDate.gte = parseStartOfDay(filters.fromDate);
        if (filters.toDate) whereLines.journalEntry.entryDate.lte = parseEndOfDay(filters.toDate);
    }

    const [accounts, lines] = await Promise.all([
        prisma.chartOfAccount.findMany({
            where: {
                allowPosting: true,
                active: true,
                ...(scoping.accountBusinessFilter !== undefined ? { businessId: scoping.accountBusinessFilter } : {})
            },
            orderBy: [{ code: 'asc' }, { id: 'asc' }],
            include: { parent: { select: { id: true, code: true, name: true } } }
        }),
        prisma.journalEntryLine.findMany({
            where: whereLines,
            select: {
                accountId: true,
                debit: true,
                credit: true
            }
        })
    ]);

    // Aggregate movements per account
    const movementMap = new Map();
    for (const line of lines) {
        const cur = movementMap.get(line.accountId) || { drCents: 0n, crCents: 0n };
        cur.drCents += toCents(line.debit);
        cur.crCents += toCents(line.credit);
        movementMap.set(line.accountId, cur);
    }

    let totalDebitMovementCents = 0n;
    let totalCreditMovementCents = 0n;
    let totalDebitBalanceCents = 0n;
    let totalCreditBalanceCents = 0n;

    const groupedByType = {
        ASSET: [],
        LIABILITY: [],
        EQUITY: [],
        INCOME: [],
        EXPENSE: []
    };

    const rows = accounts.map(acc => {
        const mov = movementMap.get(acc.id) || { drCents: 0n, crCents: 0n };
        totalDebitMovementCents += mov.drCents;
        totalCreditMovementCents += mov.crCents;

        const isDebitNormal = acc.type === 'ASSET' || acc.type === 'EXPENSE' || acc.openingBalanceType === 'DEBIT';

        let netCents = 0n;
        const opCents = toCents(acc.openingBalance);

        if (acc.openingBalanceType === 'DEBIT') {
            netCents = opCents + mov.drCents - mov.crCents;
        } else {
            netCents = -(opCents) + mov.drCents - mov.crCents;
        }

        let debitBalanceCents = 0n;
        let creditBalanceCents = 0n;

        if (netCents >= 0n) {
            debitBalanceCents = netCents;
        } else {
            creditBalanceCents = -netCents;
        }

        totalDebitBalanceCents += debitBalanceCents;
        totalCreditBalanceCents += creditBalanceCents;

        const row = {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            type: acc.type,
            subtype: acc.subtype,
            parentName: acc.parent ? acc.parent.name : null,
            openingBalance: acc.openingBalance,
            openingBalanceType: acc.openingBalanceType,
            periodDebit: fromCents(mov.drCents),
            periodCredit: fromCents(mov.crCents),
            debitBalance: fromCents(debitBalanceCents),
            creditBalance: fromCents(creditBalanceCents)
        };

        if (groupedByType[acc.type]) {
            groupedByType[acc.type].push(row);
        }

        return row;
    });

    const isBalanced = totalDebitBalanceCents === totalCreditBalanceCents;
    const diffCents = totalDebitBalanceCents - totalCreditBalanceCents;

    return {
        rows,
        groupedByType,
        summary: {
            totalDebitMovement: fromCents(totalDebitMovementCents),
            totalCreditMovement: fromCents(totalCreditMovementCents),
            totalDebitBalance: fromCents(totalDebitBalanceCents),
            totalCreditBalance: fromCents(totalCreditBalanceCents),
            isBalanced,
            difference: fromCents(diffCents)
        },
        filters
    };
}

/**
 * 4. PROFIT AND LOSS STATEMENT
 * Revenue, Cost of Goods Sold, Operating Expenses, and Net Profit / (Loss).
 *
 * @param {Object} filters
 * @returns {Promise<Object>}
 */
async function getProfitAndLoss(filters = {}) {
    let fy = null;
    if (filters.financialYearId) {
        fy = await prisma.financialYear.findUnique({
            where: { id: parseInt(filters.financialYearId, 10) }
        });
    }

    const scoping = resolveBusinessScoping(filters, fy);

    let fromDateObj = null;
    let toDateObj = null;
    if (fy) {
        const bounds = getFinancialYearDateBounds(fy);
        if (!filters.fromDate) fromDateObj = bounds.startDate;
        if (!filters.toDate) toDateObj = bounds.endDate;
    }
    if (filters.fromDate) fromDateObj = parseStartOfDay(filters.fromDate);
    if (filters.toDate) toDateObj = parseEndOfDay(filters.toDate);

    const whereLines = {
        journalEntry: {
            status: { in: ['POSTED', 'REVERSED'] },
            sourceType: { notIn: ['YEAR_END_CLOSE', 'YEAR_END_CLOSE_REVERSAL'] }
        }
    };
    applyJournalBusinessScope(whereLines.journalEntry, scoping);

    if (fromDateObj || toDateObj) {
        whereLines.journalEntry.entryDate = {};
        if (fromDateObj) whereLines.journalEntry.entryDate.gte = fromDateObj;
        if (toDateObj) whereLines.journalEntry.entryDate.lte = toDateObj;
    }

    const [incomeAccounts, expenseAccounts, lines] = await Promise.all([
        prisma.chartOfAccount.findMany({
            where: {
                type: 'INCOME',
                allowPosting: true,
                active: true,
                ...(scoping.accountBusinessFilter !== undefined ? { businessId: scoping.accountBusinessFilter } : {})
            },
            orderBy: [{ code: 'asc' }, { id: 'asc' }]
        }),
        prisma.chartOfAccount.findMany({
            where: {
                type: 'EXPENSE',
                allowPosting: true,
                active: true,
                ...(scoping.accountBusinessFilter !== undefined ? { businessId: scoping.accountBusinessFilter } : {})
            },
            orderBy: [{ code: 'asc' }, { id: 'asc' }]
        }),
        prisma.journalEntryLine.findMany({
            where: whereLines,
            select: {
                accountId: true,
                debit: true,
                credit: true
            }
        })
    ]);

    const movementMap = new Map();
    for (const line of lines) {
        const cur = movementMap.get(line.accountId) || { drCents: 0n, crCents: 0n };
        cur.drCents += toCents(line.debit);
        cur.crCents += toCents(line.credit);
        movementMap.set(line.accountId, cur);
    }

    // 1. Calculate Revenue
    let grossRevenueCents = 0n;
    let salesReturnsCents = 0n;
    const revenueItems = [];

    for (const acc of incomeAccounts) {
        const mov = movementMap.get(acc.id) || { drCents: 0n, crCents: 0n };
        if (acc.code === '4130' || acc.subtype === 'SALES_RETURNS') {
            // Contra-revenue account: normal balance is Debit
            const netReturn = mov.drCents - mov.crCents;
            salesReturnsCents += netReturn;
            revenueItems.push({
                ...acc,
                isContra: true,
                amount: fromCents(netReturn)
            });
        } else {
            // Normal revenue accounts: Credit - Debit
            const netIncome = mov.crCents - mov.drCents;
            grossRevenueCents += netIncome;
            revenueItems.push({
                ...acc,
                isContra: false,
                amount: fromCents(netIncome)
            });
        }
    }

    const netRevenueCents = grossRevenueCents - salesReturnsCents;

    // 2. Calculate Cost of Goods Sold (COGS)
    let cogsCents = 0n;
    const cogsItems = [];

    // 3. Calculate Operating Expenses
    let operatingExpenseCents = 0n;
    const expenseItems = [];

    for (const acc of expenseAccounts) {
        const mov = movementMap.get(acc.id) || { drCents: 0n, crCents: 0n };
        const netExp = mov.drCents - mov.crCents;

        if (acc.subtype === 'COGS' || acc.code.startsWith('51')) {
            cogsCents += netExp;
            cogsItems.push({
                ...acc,
                amount: fromCents(netExp)
            });
        } else {
            operatingExpenseCents += netExp;
            expenseItems.push({
                ...acc,
                amount: fromCents(netExp)
            });
        }
    }

    const grossProfitCents = netRevenueCents - cogsCents;
    const totalExpensesCents = cogsCents + operatingExpenseCents;
    const netProfitCents = netRevenueCents - totalExpensesCents;

    return {
        revenue: {
            grossRevenue: fromCents(grossRevenueCents),
            salesReturns: fromCents(salesReturnsCents),
            netRevenue: fromCents(netRevenueCents),
            items: revenueItems
        },
        cogs: {
            totalCOGS: fromCents(cogsCents),
            items: cogsItems
        },
        grossProfit: fromCents(grossProfitCents),
        operatingExpenses: {
            totalExpenses: fromCents(operatingExpenseCents),
            items: expenseItems
        },
        summary: {
            totalIncome: fromCents(netRevenueCents),
            totalExpenses: fromCents(totalExpensesCents),
            netProfitOrLoss: fromCents(netProfitCents),
            isProfit: netProfitCents >= 0n
        },
        filters
    };
}

/**
 * 5. BALANCE SHEET
 * Statement of Assets, Liabilities, and Equity verifying Assets = Liabilities + Equity.
 *
 * @param {Object} filters
 * @returns {Promise<Object>}
 */
async function getBalanceSheet(filters = {}) {
    let fy = null;
    if (filters.financialYearId) {
        fy = await prisma.financialYear.findUnique({
            where: { id: parseInt(filters.financialYearId, 10) }
        });
    }

    const scoping = resolveBusinessScoping(filters, fy);

    let cutoffDate = new Date();
    if (filters.asOfDate) {
        cutoffDate = parseEndOfDay(filters.asOfDate);
    } else if (fy) {
        const bounds = getFinancialYearDateBounds(fy);
        cutoffDate = bounds.endDate;
    }

    const whereLines = {
        journalEntry: {
            status: { in: ['POSTED', 'REVERSED'] },
            entryDate: { lte: cutoffDate }
        }
    };
    applyJournalBusinessScope(whereLines.journalEntry, scoping);

    const [accounts, lines] = await Promise.all([
        prisma.chartOfAccount.findMany({
            where: {
                allowPosting: true,
                active: true,
                ...(scoping.accountBusinessFilter !== undefined ? { businessId: scoping.accountBusinessFilter } : {})
            },
            orderBy: [{ code: 'asc' }, { id: 'asc' }],
            include: { parent: { select: { id: true, code: true, name: true } } }
        }),
        prisma.journalEntryLine.findMany({
            where: whereLines,
            select: {
                accountId: true,
                debit: true,
                credit: true
            }
        })
    ]);

    const movementMap = new Map();
    for (const line of lines) {
        const cur = movementMap.get(line.accountId) || { drCents: 0n, crCents: 0n };
        cur.drCents += toCents(line.debit);
        cur.crCents += toCents(line.credit);
        movementMap.set(line.accountId, cur);
    }

    let totalAssetsCents = 0n;
    let totalLiabilitiesCents = 0n;
    let totalEquityCents = 0n;

    let periodIncomeCents = 0n;
    let periodExpenseCents = 0n;

    const assetItems = [];
    const liabilityItems = [];
    const equityItems = [];

    for (const acc of accounts) {
        const mov = movementMap.get(acc.id) || { drCents: 0n, crCents: 0n };
        const opCents = toCents(acc.openingBalance);

        if (acc.type === 'ASSET') {
            const netCents = (acc.openingBalanceType === 'DEBIT' ? opCents : -opCents) + mov.drCents - mov.crCents;
            totalAssetsCents += netCents;
            assetItems.push({
                ...acc,
                balance: fromCents(netCents)
            });
        } else if (acc.type === 'LIABILITY') {
            const netCents = (acc.openingBalanceType === 'CREDIT' ? opCents : -opCents) + mov.crCents - mov.drCents;
            totalLiabilitiesCents += netCents;
            liabilityItems.push({
                ...acc,
                balance: fromCents(netCents)
            });
        } else if (acc.type === 'EQUITY') {
            const netCents = (acc.openingBalanceType === 'CREDIT' ? opCents : -opCents) + mov.crCents - mov.drCents;
            totalEquityCents += netCents;
            equityItems.push({
                ...acc,
                balance: fromCents(netCents)
            });
        } else if (acc.type === 'INCOME') {
            if (acc.code === '4130' || acc.subtype === 'SALES_RETURNS') {
                periodIncomeCents -= (mov.drCents - mov.crCents);
            } else {
                periodIncomeCents += (mov.crCents - mov.drCents);
            }
        } else if (acc.type === 'EXPENSE') {
            periodExpenseCents += (mov.drCents - mov.crCents);
        }
    }

    // Current period net earnings are added to Equity
    const currentPeriodEarningsCents = periodIncomeCents - periodExpenseCents;
    const effectiveEquityCents = totalEquityCents + currentPeriodEarningsCents;
    const totalLiabilitiesAndEquityCents = totalLiabilitiesCents + effectiveEquityCents;

    const isBalanced = totalAssetsCents === totalLiabilitiesAndEquityCents;
    const diffCents = totalAssetsCents - totalLiabilitiesAndEquityCents;

    return {
        assets: {
            items: assetItems,
            totalAssets: fromCents(totalAssetsCents)
        },
        liabilities: {
            items: liabilityItems,
            totalLiabilities: fromCents(totalLiabilitiesCents)
        },
        equity: {
            items: equityItems,
            baseEquity: fromCents(totalEquityCents),
            currentPeriodEarnings: fromCents(currentPeriodEarningsCents),
            effectiveEquity: fromCents(effectiveEquityCents)
        },
        summary: {
            totalAssets: fromCents(totalAssetsCents),
            totalLiabilitiesAndEquity: fromCents(totalLiabilitiesAndEquityCents),
            isBalanced,
            difference: fromCents(diffCents)
        },
        filters: {
            ...filters,
            asOfDate: cutoffDate.toISOString().slice(0, 10)
        }
    };
}

/**
 * 6. CUSTOMER RECEIVABLES & SUBLEDGER RECONCILIATION
 * Ageing analysis (0-30, 31-60, 61-90, 90+ days) and cross-reconciliation against GL 1121.
 *
 * @param {Object} filters
 * @returns {Promise<Object>}
 */
async function getCustomerReceivablesReport(filters = {}) {
    const asOfDate = filters.asOfDate ? parseEndOfDay(filters.asOfDate) : new Date();
    const scoping = resolveBusinessScoping(filters);

    // 1. Fetch Accounts Receivable control account (1121)
    const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE', scoping.accountBusinessFilter);
    if (!arAccount) throw new Error('Accounts Receivable (1121) control account not found.');

    // 2. Fetch all clients
    const clientWhere = { active: true };
    if (scoping.clientBusinessFilter === 'DEFAULT_COMPANY') {
        clientWhere.OR = [{ businessId: 1 }, { businessId: null }];
    } else if (scoping.clientBusinessFilter !== undefined) {
        clientWhere.businessId = scoping.clientBusinessFilter;
    }
    if (filters.clientId) {
        clientWhere.id = parseInt(filters.clientId, 10);
    }
    if (filters.search) {
        clientWhere.name = { contains: String(filters.search).trim() };
    }

    const clients = await prisma.client.findMany({
        where: clientWhere,
        orderBy: { name: 'asc' },
        include: {
            invoices: {
                where: {
                    documentType: 'INVOICE',
                    status: 'ACTIVE'
                },
                select: {
                    id: true,
                    invoiceNumber: true,
                    invoiceDate: true,
                    dueDate: true,
                    grandTotal: true,
                    paidAmount: true,
                    outstandingAmount: true
                }
            },
            creditDebitNotes: {
                where: {
                    status: 'ISSUED'
                },
                select: {
                    id: true,
                    noteType: true,
                    grandTotal: true
                }
            }
        }
    });

    // 3. Query all journal entry lines on Account 1121 for subledger verification
    const arLineWhere = {
        accountId: arAccount.id,
        journalEntry: {
            status: { in: ['POSTED', 'REVERSED'] },
            entryDate: { lte: asOfDate }
        }
    };
    applyJournalBusinessScope(arLineWhere.journalEntry, scoping);
    if (filters.clientId) {
        arLineWhere.clientId = parseInt(filters.clientId, 10);
    }

    const arLines = await prisma.journalEntryLine.findMany({
        where: arLineWhere,
        select: {
            clientId: true,
            debit: true,
            credit: true
        }
    });

    // Map subledger totals per client
    const subledgerMap = new Map();
    let totalGLArCents = 0n;
    let totalTaggedSubledgerCents = 0n;

    for (const line of arLines) {
        const dr = toCents(line.debit);
        const cr = toCents(line.credit);
        totalGLArCents += (dr - cr);

        if (line.clientId) {
            const current = subledgerMap.get(line.clientId) || 0n;
            subledgerMap.set(line.clientId, current + dr - cr);
            totalTaggedSubledgerCents += (dr - cr);
        }
    }

    // 4. Calculate client-level ageing and balances
    let totalInvoicedCents = 0n;
    let totalPaidCents = 0n;
    let totalOutstandingCents = 0n;
    let totalSubledgerCents = 0n;

    let totalCurrentCents = 0n;
    let total30to60Cents = 0n;
    let total60to90Cents = 0n;
    let totalOver90Cents = 0n;

    const clientRows = [];

    for (const client of clients) {
        let clientInvoicedCents = 0n;
        let clientPaidCents = 0n;
        let clientOutstandingCents = 0n;

        let clientCurrentCents = 0n;
        let client30to60Cents = 0n;
        let client60to90Cents = 0n;
        let clientOver90Cents = 0n;

        for (const inv of client.invoices) {
            const invTotal = toCents(inv.grandTotal);
            const invPaid = toCents(inv.paidAmount);
            const invOut = toCents(inv.outstandingAmount);

            clientInvoicedCents += invTotal;
            clientPaidCents += invPaid;
            clientOutstandingCents += invOut;

            if (invOut > 0n) {
                // Calculate age from invoiceDate or dueDate
                const refDate = inv.dueDate ? new Date(inv.dueDate) : new Date(inv.invoiceDate);
                const diffTime = asOfDate.getTime() - refDate.getTime();
                const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

                if (diffDays <= 30) {
                    clientCurrentCents += invOut;
                } else if (diffDays <= 60) {
                    client30to60Cents += invOut;
                } else if (diffDays <= 90) {
                    client60to90Cents += invOut;
                } else {
                    clientOver90Cents += invOut;
                }
            }
        }

        // Apply credit/debit notes to client adjustments
        let creditNoteAdjustmentsCents = 0n;
        let debitNoteAdjustmentsCents = 0n;
        for (const note of client.creditDebitNotes) {
            const noteVal = toCents(note.grandTotal);
            if (note.noteType === 'CREDIT') {
                creditNoteAdjustmentsCents += noteVal;
            } else {
                debitNoteAdjustmentsCents += noteVal;
            }
        }

        const subledgerBalanceCents = subledgerMap.get(client.id) || 0n;
        totalSubledgerCents += subledgerBalanceCents;

        totalInvoicedCents += clientInvoicedCents;
        totalPaidCents += clientPaidCents;
        totalOutstandingCents += clientOutstandingCents;

        totalCurrentCents += clientCurrentCents;
        total30to60Cents += client30to60Cents;
        total60to90Cents += client60to90Cents;
        totalOver90Cents += clientOver90Cents;

        // Include client if they have outstanding balance, invoices, or GL subledger balance
        if (clientInvoicedCents > 0n || subledgerBalanceCents !== 0n || clientOutstandingCents > 0n) {
            clientRows.push({
                id: client.id,
                name: client.name,
                email: client.email,
                phone: client.phone,
                gstin: client.gstin,
                totalInvoiced: fromCents(clientInvoicedCents),
                totalPaid: fromCents(clientPaidCents),
                creditNotes: fromCents(creditNoteAdjustmentsCents),
                debitNotes: fromCents(debitNoteAdjustmentsCents),
                outstanding: fromCents(clientOutstandingCents),
                subledgerBalance: fromCents(subledgerBalanceCents),
                ageing: {
                    current: fromCents(clientCurrentCents),
                    days31to60: fromCents(client30to60Cents),
                    days61to90: fromCents(client60to90Cents),
                    daysOver90: fromCents(clientOver90Cents)
                }
            });
        }
    }

    const unassignedArCents = totalGLArCents - totalTaggedSubledgerCents;
    const isReconciled = filters.clientId
        ? totalSubledgerCents === totalGLArCents
        : (totalSubledgerCents + unassignedArCents) === totalGLArCents;
    const diffCents = filters.clientId
        ? totalSubledgerCents - totalGLArCents
        : (totalSubledgerCents + unassignedArCents) - totalGLArCents;

    return {
        clients: clientRows,
        summary: {
            totalClients: clientRows.length,
            totalInvoiced: fromCents(totalInvoicedCents),
            totalPaid: fromCents(totalPaidCents),
            totalOutstanding: fromCents(totalOutstandingCents),
            totalSubledger: fromCents(totalSubledgerCents),
            unassignedAR: fromCents(unassignedArCents),
            glAccountsReceivable: fromCents(totalGLArCents),
            isReconciled,
            difference: fromCents(diffCents),
            ageingSummary: {
                current: fromCents(totalCurrentCents),
                days31to60: fromCents(total30to60Cents),
                days61to90: fromCents(total60to90Cents),
                daysOver90: fromCents(totalOver90Cents)
            }
        },
        filters: {
            ...filters,
            asOfDate: asOfDate.toISOString().slice(0, 10)
        }
    };
}

/**
 * 7. CUSTOMER STATEMENT
 * Chronological account statement for a specific customer.
 *
 * @param {number|string} clientId
 * @param {Object} filters
 * @returns {Promise<Object>}
 */
async function getCustomerStatement(clientId, filters = {}) {
    const numClientId = parseInt(clientId, 10);
    if (isNaN(numClientId) || numClientId <= 0) throw new ValidationError('Invalid customer ID.');

    const client = await prisma.client.findUnique({
        where: { id: numClientId }
    });
    if (!client) throw new NotFoundError(`Client ID ${numClientId} was not found.`);

    const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');
    if (!arAccount) throw new Error('Accounts Receivable account (1121) not configured.');

    // 1. Calculate opening balance before fromDate
    let openingBalanceCents = 0n;
    if (filters.fromDate) {
        const fromDateObj = parseStartOfDay(filters.fromDate);
        const priorLines = await prisma.journalEntryLine.findMany({
            where: {
                accountId: arAccount.id,
                clientId: numClientId,
                journalEntry: {
                    status: { in: ['POSTED', 'REVERSED'] },
                    entryDate: { lt: fromDateObj }
                }
            },
            select: { debit: true, credit: true }
        });

        for (const line of priorLines) {
            openingBalanceCents += (toCents(line.debit) - toCents(line.credit));
        }
    }

    // 2. Query period lines
    const lineWhere = {
        accountId: arAccount.id,
        clientId: numClientId,
        journalEntry: {
            status: { in: ['POSTED', 'REVERSED'] }
        }
    };

    if (filters.fromDate || filters.toDate) {
        lineWhere.journalEntry.entryDate = {};
        if (filters.fromDate) lineWhere.journalEntry.entryDate.gte = parseStartOfDay(filters.fromDate);
        if (filters.toDate) lineWhere.journalEntry.entryDate.lte = parseEndOfDay(filters.toDate);
    }

    const lines = await prisma.journalEntryLine.findMany({
        where: lineWhere,
        orderBy: [
            { journalEntry: { entryDate: 'asc' } },
            { journalEntry: { id: 'asc' } },
            { lineNumber: 'asc' }
        ],
        include: {
            journalEntry: {
                select: {
                    id: true,
                    entryNumber: true,
                    entryDate: true,
                    sourceType: true,
                    sourceId: true,
                    narration: true,
                    status: true
                }
            }
        }
    });

    let runningBalanceCents = openingBalanceCents;
    let totalDebitCents = 0n;
    let totalCreditCents = 0n;

    const transactions = lines.map(line => {
        const dr = toCents(line.debit);
        const cr = toCents(line.credit);
        totalDebitCents += dr;
        totalCreditCents += cr;
        runningBalanceCents += (dr - cr);

        return {
            id: line.id,
            journalId: line.journalEntry.id,
            entryNumber: line.journalEntry.entryNumber,
            entryDate: line.journalEntry.entryDate,
            sourceType: line.journalEntry.sourceType,
            sourceId: line.journalEntry.sourceId,
            narration: line.journalEntry.narration,
            description: line.description,
            debit: fromCents(dr),
            credit: fromCents(cr),
            runningBalance: fromCents(runningBalanceCents),
            status: line.journalEntry.status
        };
    });

    return {
        client,
        statement: {
            openingBalance: fromCents(openingBalanceCents),
            closingBalance: fromCents(runningBalanceCents),
            totalDebit: fromCents(totalDebitCents),
            totalCredit: fromCents(totalCreditCents),
            netChange: fromCents(totalDebitCents - totalCreditCents)
        },
        transactions,
        filters
    };
}

module.exports = {
    getJournalRegister,
    getGeneralLedgerReport,
    getTrialBalance,
    getProfitAndLoss,
    getBalanceSheet,
    getCustomerReceivablesReport,
    getCustomerStatement,
    toCents,
    fromCents,
    ValidationError,
    NotFoundError
};
