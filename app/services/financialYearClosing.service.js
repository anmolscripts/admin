'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — FINANCIAL YEAR CLOSING & OPENING BALANCES SERVICE (MILESTONE 8)
 * ==============================================================================
 *
 * Implements server-authoritative double-entry year-end closing, period locking,
 * and initial opening balances.
 *
 * Accounting Invariants:
 * 1. Nominal Account Zeroing:
 *    All leaf INCOME and EXPENSE accounts for the target Financial Year are
 *    calculated using exact integer cents and zeroed out via opposite movements.
 * 2. Retained Earnings:
 *    Net Profit increases Retained Earnings (Cr account 3120).
 *    Net Loss decreases Retained Earnings (Dr account 3120).
 *    Zero Net Result creates no arbitrary balancing line.
 * 3. Double-Entry Balance:
 *    SUM(Debit) === SUM(Credit) exactly down to the cent without any plug line.
 * 4. Chronological Integrity:
 *    Earlier Financial Years with accounting activity must be CLOSED before
 *    a later year can be closed.
 *    Reopening requires reverse-chronological order (no later closed years).
 * 5. Deterministic Idempotency & Concurrency:
 *    Database row-level locking (SELECT ... FOR UPDATE) and unique idempotency keys
 *    ('YEAR_END_CLOSE:<fyId>') prevent duplicate closing journals or status races.
 * 6. Immutability & Auditability:
 *    Historical transactions are never deleted or rewritten. Reopening creates
 *    an explicit reversing journal entry.
 * ==============================================================================
 */

const prisma = require('../config/prisma');
const coaService = require('./chartOfAccounts.service');
const journalService = require('./journal.service');
const activityService = require('./activity.service');
const { computeFinancialYear } = require('./financialYear.service');

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
 * Server-authoritative integer cent conversions.
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
 * Normalise Financial Year date bounds.
 */
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

/**
 * Preview Financial Year Close (read-only, side-effect free).
 * Calculates nominal account balances, net profit/loss, retained earnings impact,
 * and proposed closing journal lines.
 *
 * @param {number|string} financialYearId
 * @returns {Promise<Object>} Close preview summary
 */
async function previewCloseFinancialYear(financialYearId) {
    const fyId = parseInt(financialYearId, 10);
    if (isNaN(fyId) || fyId <= 0) {
        throw new ValidationError('Invalid Financial Year ID.');
    }

    const fy = await prisma.financialYear.findUnique({
        where: { id: fyId }
    });

    if (!fy) {
        throw new NotFoundError(`Financial Year with ID ${fyId} not found.`);
    }

    const bounds = getFinancialYearDateBounds(fy);
    const blockers = [];
    const warnings = [];

    // 1. Status Check
    const isAlreadyClosed = fy.status === 'CLOSED';
    if (isAlreadyClosed) {
        warnings.push(`Financial Year ${fy.code} is already CLOSED.`);
    }

    // 2. Chronological sequence check
    const earlierOpenFys = await prisma.financialYear.findMany({
        where: {
            startDate: { lt: fy.startDate },
            status: 'OPEN'
        },
        orderBy: { startDate: 'asc' }
    });

    for (const earlier of earlierOpenFys) {
        const activityCount = await prisma.journalEntry.count({
            where: {
                financialYearId: earlier.id,
                status: { in: ['POSTED', 'REVERSED'] }
            }
        });
        if (activityCount > 0) {
            blockers.push(`Earlier Financial Year ${earlier.code} has ${activityCount} accounting transactions and must be closed first.`);
        }
    }

    // 3. Retained Earnings System Account Check
    let retainedEarningsAccount = null;
    try {
        retainedEarningsAccount = await coaService.getSystemAccount('RETAINED_EARNINGS');
        if (!retainedEarningsAccount.active || !retainedEarningsAccount.allowPosting || retainedEarningsAccount.isGroup) {
            blockers.push(`Retained Earnings account (${retainedEarningsAccount.code}) is not eligible for posting.`);
        }
    } catch (err) {
        blockers.push(`Retained Earnings account (system key RETAINED_EARNINGS / code 3120) is missing: ${err.message}`);
    }

    // 4. Query all posted/reversed lines for this Financial Year (excluding any existing year-end close journals)
    const nominalAccounts = await prisma.chartOfAccount.findMany({
        where: {
            type: { in: ['INCOME', 'EXPENSE'] },
            allowPosting: true,
            active: true
        },
        orderBy: { code: 'asc' }
    });

    const lines = await prisma.journalEntryLine.findMany({
        where: {
            journalEntry: {
                financialYearId: fy.id,
                status: { in: ['POSTED', 'REVERSED'] },
                sourceType: { not: 'YEAR_END_CLOSE' }
            }
        },
        select: {
            accountId: true,
            debit: true,
            credit: true
        }
    });

    const movementMap = new Map();
    for (const l of lines) {
        const cur = movementMap.get(l.accountId) || { drCents: 0n, crCents: 0n };
        cur.drCents += toCents(l.debit);
        cur.crCents += toCents(l.credit);
        movementMap.set(l.accountId, cur);
    }

    // 5. Compute Nominal Balances and Closing Movements
    const incomeItems = [];
    const expenseItems = [];
    const proposedClosingLines = [];

    let totalIncomeCents = 0n;
    let totalExpenseCents = 0n;
    let closingDebitSumCents = 0n;
    let closingCreditSumCents = 0n;

    for (const acc of nominalAccounts) {
        const mov = movementMap.get(acc.id) || { drCents: 0n, crCents: 0n };
        if (mov.drCents === 0n && mov.crCents === 0n) continue;

        if (acc.type === 'INCOME') {
            const isContra = acc.code === '4130' || acc.subtype === 'SALES_RETURNS';
            let netIncomeCents;
            if (isContra) {
                // Contra-revenue normal debit
                netIncomeCents = -(mov.drCents - mov.crCents);
            } else {
                netIncomeCents = mov.crCents - mov.drCents;
            }
            totalIncomeCents += netIncomeCents;

            // Closing movement needed to bring account movement to 0
            // If account has net credit (crCents > drCents): Debit account by (cr - dr)
            // If account has net debit (drCents > crCents): Credit account by (dr - cr)
            const netBalance = mov.crCents - mov.drCents; // Positive = Credit, Negative = Debit
            let closingDrCents = 0n;
            let closingCrCents = 0n;

            if (netBalance > 0n) {
                closingDrCents = netBalance;
            } else if (netBalance < 0n) {
                closingCrCents = -netBalance;
            }

            incomeItems.push({
                accountId: acc.id,
                code: acc.code,
                name: acc.name,
                subtype: acc.subtype,
                isContra,
                debitMovement: fromCents(mov.drCents),
                creditMovement: fromCents(mov.crCents),
                netBalance: fromCents(netIncomeCents),
                closingDebit: fromCents(closingDrCents),
                closingCredit: fromCents(closingCrCents)
            });

            if (closingDrCents > 0n || closingCrCents > 0n) {
                closingDebitSumCents += closingDrCents;
                closingCreditSumCents += closingCrCents;
                proposedClosingLines.push({
                    accountId: acc.id,
                    accountCode: acc.code,
                    accountName: acc.name,
                    accountType: acc.type,
                    debit: fromCents(closingDrCents),
                    credit: fromCents(closingCrCents),
                    description: `Close ${acc.name} (${acc.code}) for FY ${fy.code}`
                });
            }
        } else if (acc.type === 'EXPENSE') {
            const netExpenseCents = mov.drCents - mov.crCents;
            totalExpenseCents += netExpenseCents;

            // Closing movement to bring expense to 0
            // If account has net debit (drCents > crCents): Credit account by (dr - cr)
            // If account has net credit (crCents > drCents): Debit account by (cr - dr)
            const netBalance = mov.drCents - mov.crCents; // Positive = Debit, Negative = Credit
            let closingDrCents = 0n;
            let closingCrCents = 0n;

            if (netBalance > 0n) {
                closingCrCents = netBalance;
            } else if (netBalance < 0n) {
                closingDrCents = -netBalance;
            }

            expenseItems.push({
                accountId: acc.id,
                code: acc.code,
                name: acc.name,
                subtype: acc.subtype,
                debitMovement: fromCents(mov.drCents),
                creditMovement: fromCents(mov.crCents),
                netBalance: fromCents(netExpenseCents),
                closingDebit: fromCents(closingDrCents),
                closingCredit: fromCents(closingCrCents)
            });

            if (closingDrCents > 0n || closingCrCents > 0n) {
                closingDebitSumCents += closingDrCents;
                closingCreditSumCents += closingCrCents;
                proposedClosingLines.push({
                    accountId: acc.id,
                    accountCode: acc.code,
                    accountName: acc.name,
                    accountType: acc.type,
                    debit: fromCents(closingDrCents),
                    credit: fromCents(closingCrCents),
                    description: `Close ${acc.name} (${acc.code}) for FY ${fy.code}`
                });
            }
        }
    }

    // 6. Retained Earnings Impact
    const netProfitOrLossCents = totalIncomeCents - totalExpenseCents;
    let retainedEarningsDebitCents = 0n;
    let retainedEarningsCreditCents = 0n;

    if (netProfitOrLossCents > 0n) {
        // Net Profit: Credit Retained Earnings
        retainedEarningsCreditCents = netProfitOrLossCents;
    } else if (netProfitOrLossCents < 0n) {
        // Net Loss: Debit Retained Earnings
        retainedEarningsDebitCents = -netProfitOrLossCents;
    }

    if (retainedEarningsAccount && (retainedEarningsDebitCents > 0n || retainedEarningsCreditCents > 0n)) {
        closingDebitSumCents += retainedEarningsDebitCents;
        closingCreditSumCents += retainedEarningsCreditCents;
        proposedClosingLines.push({
            accountId: retainedEarningsAccount.id,
            accountCode: retainedEarningsAccount.code,
            accountName: retainedEarningsAccount.name,
            accountType: retainedEarningsAccount.type,
            debit: fromCents(retainedEarningsDebitCents),
            credit: fromCents(retainedEarningsCreditCents),
            description: `Transfer FY ${fy.code} Net ${netProfitOrLossCents >= 0n ? 'Profit' : 'Loss'} to Retained Earnings`
        });
    }

    const isBalanced = closingDebitSumCents === closingCreditSumCents;
    if (!isBalanced) {
        blockers.push(`Closing journal would be unbalanced: Debit ₹${fromCents(closingDebitSumCents)} != Credit ₹${fromCents(closingCreditSumCents)}`);
    }

    // Check existing closing journal if FY was previously closed
    let existingClosingJournal = null;
    if (isAlreadyClosed) {
        existingClosingJournal = await prisma.journalEntry.findFirst({
            where: {
                financialYearId: fy.id,
                sourceType: 'YEAR_END_CLOSE',
                status: 'POSTED'
            },
            include: {
                lines: {
                    include: { account: true },
                    orderBy: { lineNumber: 'asc' }
                },
                postedBy: { select: { id: true, name: true, email: true } }
            }
        });
    }

    return {
        financialYear: {
            id: fy.id,
            code: fy.code,
            startDate: bounds.startDate,
            endDate: bounds.endDate,
            status: fy.status,
            isCurrent: fy.isCurrent,
            closedAt: fy.closedAt,
            closedById: fy.closedById
        },
        totals: {
            totalIncome: fromCents(totalIncomeCents),
            totalExpense: fromCents(totalExpenseCents),
            netProfitOrLoss: fromCents(netProfitOrLossCents),
            isProfit: netProfitOrLossCents > 0n,
            isLoss: netProfitOrLossCents < 0n,
            isZeroResult: netProfitOrLossCents === 0n
        },
        retainedEarningsAccount: retainedEarningsAccount ? {
            id: retainedEarningsAccount.id,
            code: retainedEarningsAccount.code,
            name: retainedEarningsAccount.name,
            impact: fromCents(netProfitOrLossCents),
            action: netProfitOrLossCents >= 0n ? 'CREDIT' : 'DEBIT'
        } : null,
        closingJournal: {
            totalDebit: fromCents(closingDebitSumCents),
            totalCredit: fromCents(closingCreditSumCents),
            isBalanced,
            lineCount: proposedClosingLines.length,
            lines: proposedClosingLines
        },
        existingClosingJournal,
        incomeItems,
        expenseItems,
        blockers,
        warnings,
        canClose: blockers.length === 0 && !isAlreadyClosed
    };
}

/**
 * Execute Financial Year Close atomically.
 *
 * Steps:
 * 1. Lock FinancialYear row (SELECT ... FOR UPDATE).
 * 2. Validate status and dependencies.
 * 3. Recompute nominal account movements in integer cents.
 * 4. Generate sequential journal entry.
 * 5. Verify total debit === total credit down to the cent.
 * 6. Persist closing JournalEntry and update account balances.
 * 7. Transition FinancialYear status to 'CLOSED'.
 * 8. Log audit history.
 *
 * @param {number|string} financialYearId
 * @param {number|null} userId
 * @param {Object} [meta={}]
 * @returns {Promise<Object>} { financialYear, closingJournal }
 */
async function closeFinancialYear(financialYearId, userId = null, meta = {}) {
    const fyId = parseInt(financialYearId, 10);
    if (isNaN(fyId) || fyId <= 0) {
        throw new ValidationError('Invalid Financial Year ID.');
    }

    return await prisma.$transaction(async (tx) => {
        // 1. Lock FinancialYear record in MySQL
        await tx.$queryRawUnsafe('SELECT id, status FROM financial_years WHERE id = ? FOR UPDATE', fyId);

        const fy = await tx.financialYear.findUnique({
            where: { id: fyId }
        });

        if (!fy) {
            throw new NotFoundError(`Financial Year with ID ${fyId} not found.`);
        }

        if (fy.status === 'CLOSED') {
            throw new ConflictError(`Financial Year ${fy.code} is already CLOSED.`);
        }

        // 2. Validate chronological sequence: Earlier FYs with accounting activity must be closed
        const earlierOpenFys = await tx.financialYear.findMany({
            where: {
                startDate: { lt: fy.startDate },
                status: 'OPEN'
            },
            orderBy: { startDate: 'asc' }
        });

        for (const earlier of earlierOpenFys) {
            const count = await tx.journalEntry.count({
                where: {
                    financialYearId: earlier.id,
                    status: { in: ['POSTED', 'REVERSED'] }
                }
            });
            if (count > 0) {
                throw new ValidationError(`Cannot close Financial Year ${fy.code}. Earlier Financial Year ${earlier.code} has ${count} accounting transactions and must be closed first.`);
            }
        }

        // 3. Fast-path Idempotency Check
        const idempotencyKey = `YEAR_END_CLOSE:${fy.id}`;
        const existingJournal = await tx.journalEntry.findUnique({
            where: { idempotencyKey },
            include: { lines: true }
        });
        if (existingJournal) {
            // Already created, ensure FY is marked closed
            const updatedFy = await tx.financialYear.update({
                where: { id: fy.id },
                data: { status: 'CLOSED', closedAt: fy.closedAt || new Date(), closedById: fy.closedById || userId }
            });
            return { financialYear: updatedFy, closingJournal: existingJournal };
        }

        // 4. Resolve Retained Earnings System Account
        const retainedEarningsAccount = await coaService.getSystemAccount('RETAINED_EARNINGS');
        if (!retainedEarningsAccount || !retainedEarningsAccount.active || !retainedEarningsAccount.allowPosting || retainedEarningsAccount.isGroup) {
            throw new ValidationError('Retained Earnings system account (code 3120) must be active and allow postings.');
        }

        // 5. Query nominal accounts and movements
        const nominalAccounts = await tx.chartOfAccount.findMany({
            where: {
                type: { in: ['INCOME', 'EXPENSE'] },
                allowPosting: true,
                active: true
            },
            orderBy: { code: 'asc' }
        });

        const lines = await tx.journalEntryLine.findMany({
            where: {
                journalEntry: {
                    financialYearId: fy.id,
                    status: { in: ['POSTED', 'REVERSED'] },
                    sourceType: { not: 'YEAR_END_CLOSE' }
                }
            },
            select: {
                accountId: true,
                debit: true,
                credit: true
            }
        });

        const movementMap = new Map();
        for (const l of lines) {
            const cur = movementMap.get(l.accountId) || { drCents: 0n, crCents: 0n };
            cur.drCents += toCents(l.debit);
            cur.crCents += toCents(l.credit);
            movementMap.set(l.accountId, cur);
        }

        const validatedLines = [];
        let totalIncomeCents = 0n;
        let totalExpenseCents = 0n;
        let closingDebitSumCents = 0n;
        let closingCreditSumCents = 0n;

        for (const acc of nominalAccounts) {
            const mov = movementMap.get(acc.id) || { drCents: 0n, crCents: 0n };
            if (mov.drCents === 0n && mov.crCents === 0n) continue;

            if (acc.type === 'INCOME') {
                const isContra = acc.code === '4130' || acc.subtype === 'SALES_RETURNS';
                const netIncomeCents = isContra ? -(mov.drCents - mov.crCents) : (mov.crCents - mov.drCents);
                totalIncomeCents += netIncomeCents;

                const netBalance = mov.crCents - mov.drCents; // Positive = Net Credit
                let drCents = 0n;
                let crCents = 0n;

                if (netBalance > 0n) drCents = netBalance;
                else if (netBalance < 0n) crCents = -netBalance;

                if (drCents > 0n || crCents > 0n) {
                    closingDebitSumCents += drCents;
                    closingCreditSumCents += crCents;
                    validatedLines.push({
                        lineNumber: validatedLines.length + 1,
                        accountId: acc.id,
                        debitCents: drCents,
                        creditCents: crCents,
                        debitStr: fromCents(drCents),
                        creditStr: fromCents(crCents),
                        description: `Close ${acc.name} (${acc.code}) for FY ${fy.code}`,
                        clientId: null
                    });
                }
            } else if (acc.type === 'EXPENSE') {
                const netExpenseCents = mov.drCents - mov.crCents;
                totalExpenseCents += netExpenseCents;

                const netBalance = mov.drCents - mov.crCents; // Positive = Net Debit
                let drCents = 0n;
                let crCents = 0n;

                if (netBalance > 0n) crCents = netBalance;
                else if (netBalance < 0n) drCents = -netBalance;

                if (drCents > 0n || crCents > 0n) {
                    closingDebitSumCents += drCents;
                    closingCreditSumCents += crCents;
                    validatedLines.push({
                        lineNumber: validatedLines.length + 1,
                        accountId: acc.id,
                        debitCents: drCents,
                        creditCents: crCents,
                        debitStr: fromCents(drCents),
                        creditStr: fromCents(crCents),
                        description: `Close ${acc.name} (${acc.code}) for FY ${fy.code}`,
                        clientId: null
                    });
                }
            }
        }

        // 6. Retained Earnings Line
        const netProfitOrLossCents = totalIncomeCents - totalExpenseCents;
        let retainedEarningsDebitCents = 0n;
        let retainedEarningsCreditCents = 0n;

        if (netProfitOrLossCents > 0n) {
            retainedEarningsCreditCents = netProfitOrLossCents;
        } else if (netProfitOrLossCents < 0n) {
            retainedEarningsDebitCents = -netProfitOrLossCents;
        }

        if (retainedEarningsDebitCents > 0n || retainedEarningsCreditCents > 0n) {
            closingDebitSumCents += retainedEarningsDebitCents;
            closingCreditSumCents += retainedEarningsCreditCents;
            validatedLines.push({
                lineNumber: validatedLines.length + 1,
                accountId: retainedEarningsAccount.id,
                debitCents: retainedEarningsDebitCents,
                creditCents: retainedEarningsCreditCents,
                debitStr: fromCents(retainedEarningsDebitCents),
                creditStr: fromCents(retainedEarningsCreditCents),
                description: `Transfer FY ${fy.code} Net ${netProfitOrLossCents >= 0n ? 'Profit' : 'Loss'} to Retained Earnings`,
                clientId: null
            });
        }

        // 7. Verify Double-Entry Balance Invariant: Debit === Credit exactly down to the cent
        if (closingDebitSumCents !== closingCreditSumCents) {
            throw new ValidationError(`Closing journal double-entry imbalance: Debit ₹${fromCents(closingDebitSumCents)} != Credit ₹${fromCents(closingCreditSumCents)}.`);
        }

        // If there are zero nominal movements in the entire FY, a zero-movement year can be closed safely
        let closingJournal = null;
        if (validatedLines.length >= 2) {
            const entryNumber = await journalService.generateJournalNumber(tx, fy);
            const bounds = getFinancialYearDateBounds(fy);
            // Post on the last day of the financial year
            const entryDate = bounds.endDate;

            try {
                closingJournal = await tx.journalEntry.create({
                    data: {
                        entryNumber,
                        entryDate,
                        financialYearId: fy.id,
                        sourceType: 'YEAR_END_CLOSE',
                        sourceId: fy.id,
                        narration: `Financial Year ${fy.code} Closing Entry - Transfer of Nominal Balances to Retained Earnings`,
                        status: 'POSTED',
                        idempotencyKey,
                        postedAt: new Date(),
                        postedById: userId,
                        lines: {
                            create: validatedLines.map(vl => ({
                                lineNumber: vl.lineNumber,
                                accountId: vl.accountId,
                                debit: vl.debitStr,
                                credit: vl.creditStr,
                                description: vl.description,
                                clientId: vl.clientId
                            }))
                        }
                    },
                    include: {
                        lines: {
                            include: { account: true },
                            orderBy: { lineNumber: 'asc' }
                        },
                        postedBy: { select: { id: true, name: true, email: true } },
                        financialYear: true
                    }
                });
            } catch (err) {
                // Handle unique constraint violation (P2002) – journal already exists
                if (err.code === 'P2002') {
                    closingJournal = await tx.journalEntry.findUnique({
                        where: { idempotencyKey },
                        include: {
                            lines: { include: { account: true }, orderBy: { lineNumber: 'asc' } },
                            postedBy: { select: { id: true, name: true, email: true } },
                            financialYear: true
                        }
                    });
                } else {
                    throw err;
                }
            }
}

            // Adjust account current balances atomically
            for (const vl of validatedLines) {
                const acc = await tx.chartOfAccount.findUnique({ where: { id: vl.accountId } });
                const currentCents = toCents(acc.currentBalance);

                let newCents;
                if (acc.type === 'ASSET' || acc.type === 'EXPENSE') {
                    newCents = currentCents + vl.debitCents - vl.creditCents;
                } else {
                    newCents = currentCents + vl.creditCents - vl.debitCents;
                }

                await tx.chartOfAccount.update({
                    where: { id: acc.id },
                    data: { currentBalance: fromCents(newCents) }
                });
            }
        

        // 8. Update FinancialYear status to CLOSED
        const closedAt = new Date();
        const updatedFy = await tx.financialYear.update({
            where: { id: fy.id },
            data: {
                status: 'CLOSED',
                closedAt,
                closedById: userId
            }
        });
        

        // 9. Activity Log
        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CLOSE_FINANCIAL_YEAR',
                module: 'FINANCIAL_YEARS',
                targetType: 'FINANCIAL_YEAR',
                targetId: String(fy.id),
                targetReference: fy.code,
                ipAddress: meta.ip || null,
                userAgent: meta.userAgent || null,
                metadata: {
                    financialYearCode: fy.code,
                    netProfitOrLoss: fromCents(netProfitOrLossCents),
                    journalId: closingJournal ? closingJournal.id : null,
                    entryNumber: closingJournal ? closingJournal.entryNumber : null,
                    lineCount: validatedLines.length
                }
            }, tx).catch(() => {});
        }

        return {
            financialYear: updatedFy,
            closingJournal,
            summary: {
                netProfitOrLoss: fromCents(netProfitOrLossCents),
                totalIncome: fromCents(totalIncomeCents),
                totalExpense: fromCents(totalExpenseCents),
                linesCount: validatedLines.length
            }
        };
    }, { timeout: 20000, maxWait: 10000 });
}

/**
 * Reopen a closed Financial Year in a controlled, audited workflow.
 *
 * Rules:
 * 1. Financial Year must be currently CLOSED.
 * 2. Dedicated reason is mandatory.
 * 3. Reverse chronological constraint: No later Financial Year may be CLOSED.
 * 4. Atomically reverses the closing journal entry.
 * 5. Restores FinancialYear status to 'OPEN'.
 *
 * @param {number|string} financialYearId
 * @param {number|null} userId
 * @param {string} reason
 * @param {Object} [meta={}]
 * @returns {Promise<Object>} { financialYear, reversalJournal }
 */
async function reopenFinancialYear(financialYearId, userId = null, reason = '', meta = {}) {
    const fyId = parseInt(financialYearId, 10);
    if (isNaN(fyId) || fyId <= 0) {
        throw new ValidationError('Invalid Financial Year ID.');
    }

    const cleanReason = (reason || '').toString().trim();
    if (!cleanReason) {
        throw new ValidationError('A non-empty reason is required to reopen a closed Financial Year.');
    }

    return await prisma.$transaction(async (tx) => {
        // 1. Lock FinancialYear row
        await tx.$queryRawUnsafe('SELECT id, status FROM financial_years WHERE id = ? FOR UPDATE', fyId);

        const fy = await tx.financialYear.findUnique({
            where: { id: fyId }
        });

        if (!fy) {
            throw new NotFoundError(`Financial Year with ID ${fyId} not found.`);
        }

        if (fy.status !== 'CLOSED') {
            throw new ConflictError(`Financial Year ${fy.code} is not closed (current status: ${fy.status}).`);
        }

        // 2. Chronological constraint: No later Financial Year can be CLOSED
        const laterClosedFy = await tx.financialYear.findFirst({
            where: {
                startDate: { gt: fy.startDate },
                status: 'CLOSED'
            },
            orderBy: { startDate: 'desc' }
        });

        if (laterClosedFy) {
            throw new ValidationError(`Cannot reopen Financial Year ${fy.code} because subsequent Financial Year ${laterClosedFy.code} is closed. Please reopen subsequent years first in reverse chronological order.`);
        }

        // 3. Find active closing journal
        const closingJournal = await tx.journalEntry.findFirst({
            where: {
                financialYearId: fy.id,
                sourceType: 'YEAR_END_CLOSE',
                status: 'POSTED'
            },
            include: {
                lines: true
            }
        });

        let reversalJournal = null;
        if (closingJournal) {
            // Create reversing journal entry
            const bounds = getFinancialYearDateBounds(fy);
            const reversalEntryNumber = await journalService.generateJournalNumber(tx, fy);

            const reversedLines = closingJournal.lines.map(line => ({
                lineNumber: line.lineNumber,
                accountId: line.accountId,
                debit: line.credit, // swap
                credit: line.debit, // swap
                description: `Reversal of closing entry ${closingJournal.entryNumber} line ${line.lineNumber}`,
                clientId: line.clientId
            }));

            reversalJournal = await tx.journalEntry.create({
                data: {
                    entryNumber: reversalEntryNumber,
                    entryDate: bounds.endDate,
                    financialYearId: fy.id,
                    sourceType: 'YEAR_END_CLOSE_REVERSAL',
                    sourceId: fy.id,
                    narration: `[REVERSAL OF CLOSING ENTRY ${closingJournal.entryNumber}] Reopen Financial Year ${fy.code}: ${cleanReason}`,
                    status: 'POSTED',
                    idempotencyKey: `REOPEN_YEAR_END:${fy.id}`,
                    postedAt: new Date(),
                    postedById: userId,
                    lines: {
                        create: reversedLines.map(rl => ({
                            lineNumber: rl.lineNumber,
                            accountId: rl.accountId,
                            debit: rl.debit,
                            credit: rl.credit,
                            description: rl.description,
                            clientId: rl.clientId
                        }))
                    }
                },
                include: {
                    lines: { include: { account: true } }
                }
            });

            // Mark original closing journal as REVERSED
            await tx.journalEntry.update({
                where: { id: closingJournal.id },
                data: {
                    status: 'REVERSED',
                    reversedEntryId: reversalJournal.id
                }
            });

            // Restore account balances
            for (const rl of reversedLines) {
                const acc = await tx.chartOfAccount.findUnique({ where: { id: rl.accountId } });
                const currentCents = toCents(acc.currentBalance);
                const drCents = toCents(rl.debit);
                const crCents = toCents(rl.credit);

                let newCents;
                if (acc.type === 'ASSET' || acc.type === 'EXPENSE') {
                    newCents = currentCents + drCents - crCents;
                } else {
                    newCents = currentCents + crCents - drCents;
                }

                await tx.chartOfAccount.update({
                    where: { id: acc.id },
                    data: { currentBalance: fromCents(newCents) }
                });
            }
        }

        // 4. Update FinancialYear status back to OPEN
        const updatedFy = await tx.financialYear.update({
            where: { id: fy.id },
            data: {
                status: 'OPEN',
                closedAt: null,
                closedById: null
            }
        });

        // 5. Activity Audit Log
        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'REOPEN_FINANCIAL_YEAR',
                module: 'FINANCIAL_YEARS',
                targetType: 'FINANCIAL_YEAR',
                targetId: String(fy.id),
                targetReference: fy.code,
                ipAddress: meta.ip || null,
                userAgent: meta.userAgent || null,
                metadata: {
                    financialYearCode: fy.code,
                    reason: cleanReason,
                    originalClosingJournalId: closingJournal ? closingJournal.id : null,
                    reversalJournalId: reversalJournal ? reversalJournal.id : null
                }
            }, tx).catch(() => {});
        }

        return {
            financialYear: updatedFy,
            reversalJournal
        };
    }, { timeout: 20000, maxWait: 10000 });
}

/**
 * Preview Initial Company Opening Balances.
 *
 * @param {number|string} financialYearId
 * @param {Array<Object>} lines - [{ accountId, debit, credit }]
 * @returns {Promise<Object>}
 */
async function previewOpeningBalances(financialYearId, lines = []) {
    const fyId = parseInt(financialYearId, 10);
    if (isNaN(fyId) || fyId <= 0) {
        throw new ValidationError('Invalid Financial Year ID.');
    }

    const fy = await prisma.financialYear.findUnique({ where: { id: fyId } });
    if (!fy) throw new NotFoundError(`Financial Year with ID ${fyId} not found.`);

    if (!Array.isArray(lines) || lines.length === 0) {
        throw new ValidationError('At least one opening balance account line is required.');
    }

    let totalDebitCents = 0n;
    let totalCreditCents = 0n;
    const validatedLines = [];
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
        const item = lines[i];
        const accountId = parseInt(item.accountId, 10);
        if (isNaN(accountId) || accountId <= 0) {
            errors.push(`Row ${i + 1}: Valid account ID is required.`);
            continue;
        }

        const account = await prisma.chartOfAccount.findUnique({ where: { id: accountId } });
        if (!account) {
            errors.push(`Row ${i + 1}: Account ID ${accountId} not found.`);
            continue;
        }

        if (!['ASSET', 'LIABILITY', 'EQUITY'].includes(account.type)) {
            errors.push(`Row ${i + 1}: Account ${account.code} (${account.name}) is of type ${account.type}. Opening balances can only be set for permanent accounts (ASSET, LIABILITY, EQUITY).`);
            continue;
        }

        if (account.isGroup || !account.allowPosting || !account.active) {
            errors.push(`Row ${i + 1}: Account ${account.code} (${account.name}) is not an active, postable leaf account.`);
            continue;
        }

        const drCents = toCents(item.debit || 0);
        const crCents = toCents(item.credit || 0);

        if (drCents < 0n || crCents < 0n) {
            errors.push(`Row ${i + 1}: Debit and credit amounts cannot be negative.`);
            continue;
        }
        if (drCents === 0n && crCents === 0n) {
            continue; // Skip zero line
        }
        if (drCents > 0n && crCents > 0n) {
            errors.push(`Row ${i + 1}: A row cannot have both debit and credit.`);
            continue;
        }

        totalDebitCents += drCents;
        totalCreditCents += crCents;

        validatedLines.push({
            lineNumber: validatedLines.length + 1,
            accountId: account.id,
            accountCode: account.code,
            accountName: account.name,
            accountType: account.type,
            debit: fromCents(drCents),
            credit: fromCents(crCents),
            debitCents: drCents,
            creditCents: crCents,
            description: item.description ? String(item.description).trim() : `Opening Balance for ${account.name}`
        });
    }

    const diffCents = totalDebitCents - totalCreditCents;
    const isBalanced = diffCents === 0n;

    return {
        financialYear: {
            id: fy.id,
            code: fy.code,
            startDate: fy.startDate,
            endDate: fy.endDate,
            status: fy.status
        },
        lines: validatedLines,
        summary: {
            totalDebit: fromCents(totalDebitCents),
            totalCredit: fromCents(totalCreditCents),
            difference: fromCents(diffCents),
            isBalanced
        },
        errors,
        isValid: errors.length === 0 && isBalanced && validatedLines.length >= 2
    };
}

/**
 * Post Initial Company Opening Balances via an immutable, audited opening journal entry.
 *
 * @param {number|string} financialYearId
 * @param {number|null} userId
 * @param {Array<Object>} lines
 * @param {string} [narration='Initial Company Opening Balances']
 * @param {Object} [meta={}]
 * @returns {Promise<Object>} { journal }
 */
async function postOpeningBalances(financialYearId, userId = null, lines = [], narration = '', meta = {}) {
    const fyId = parseInt(financialYearId, 10);
    if (isNaN(fyId) || fyId <= 0) {
        throw new ValidationError('Invalid Financial Year ID.');
    }

    const preview = await previewOpeningBalances(fyId, lines);
    if (!preview.isValid) {
        const errMsg = preview.errors.length > 0
            ? preview.errors.join(' ')
            : `Double-entry imbalance: Total Debit (₹${preview.summary.totalDebit}) must equal Total Credit (₹${preview.summary.totalCredit}). Difference: ₹${preview.summary.difference}.`;
        throw new ValidationError(`Cannot post opening balances: ${errMsg}`);
    }

    const cleanNarration = (narration || '').toString().trim() || `Initial Company Opening Balances for FY ${preview.financialYear.code}`;

    return await prisma.$transaction(async (tx) => {
        const fy = await tx.financialYear.findUnique({ where: { id: fyId } });
        if (!fy) throw new NotFoundError(`Financial Year with ID ${fyId} not found.`);
        if (fy.status === 'CLOSED') {
            throw new ValidationError(`Cannot post opening balances into CLOSED Financial Year ${fy.code}.`);
        }

        const idempotencyKey = `OPENING_BALANCE:${fy.id}`;
        const existing = await tx.journalEntry.findUnique({
            where: { idempotencyKey },
            include: { lines: { include: { account: true } } }
        });
        if (existing) {
            throw new ConflictError(`Opening balances have already been posted for Financial Year ${fy.code} (Journal #${existing.entryNumber}).`);
        }

        const entryNumber = await journalService.generateJournalNumber(tx, fy);
        const bounds = getFinancialYearDateBounds(fy);
        const entryDate = bounds.startDate;

        const journal = await tx.journalEntry.create({
            data: {
                entryNumber,
                entryDate,
                financialYearId: fy.id,
                sourceType: 'OPENING_BALANCE',
                sourceId: fy.id,
                narration: cleanNarration,
                status: 'POSTED',
                idempotencyKey,
                postedAt: new Date(),
                postedById: userId,
                lines: {
                    create: preview.lines.map(vl => ({
                        lineNumber: vl.lineNumber,
                        accountId: vl.accountId,
                        debit: vl.debit,
                        credit: vl.credit,
                        description: vl.description,
                        clientId: null
                    }))
                }
            },
            include: {
                lines: {
                    include: { account: true },
                    orderBy: { lineNumber: 'asc' }
                },
                financialYear: true,
                postedBy: { select: { id: true, name: true, email: true } }
            }
        });

        // Adjust account balances
        for (const vl of preview.lines) {
            const acc = await tx.chartOfAccount.findUnique({ where: { id: vl.accountId } });
            const currentCents = toCents(acc.currentBalance);

            let newCents;
            if (acc.type === 'ASSET' || acc.type === 'EXPENSE') {
                newCents = currentCents + vl.debitCents - vl.creditCents;
            } else {
                newCents = currentCents + vl.creditCents - vl.debitCents;
            }

            await tx.chartOfAccount.update({
                where: { id: acc.id },
                data: { currentBalance: fromCents(newCents) }
            });
        }

        // Audit log
        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'POST_OPENING_BALANCE',
                module: 'FINANCIAL_YEARS',
                targetType: 'JOURNAL_ENTRY',
                targetId: String(journal.id),
                targetReference: journal.entryNumber,
                ipAddress: meta.ip || null,
                userAgent: meta.userAgent || null,
                metadata: {
                    financialYearCode: fy.code,
                    totalDebit: preview.summary.totalDebit,
                    totalCredit: preview.summary.totalCredit,
                    lineCount: preview.lines.length
                }
            }, tx).catch(() => {});
        }

        return {
            journal,
            summary: preview.summary
        };
    }, { timeout: 20000, maxWait: 10000 });
}

module.exports = {
    ValidationError,
    NotFoundError,
    ConflictError,
    previewCloseFinancialYear,
    closeFinancialYear,
    reopenFinancialYear,
    previewOpeningBalances,
    postOpeningBalances,
    toCents,
    fromCents,
    getFinancialYearDateBounds
};
