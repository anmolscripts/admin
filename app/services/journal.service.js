'use strict';

const prisma = require('../config/prisma');
const { ensureFinancialYear, computeFinancialYear } = require('./financialYear.service');

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
 * Server-authoritative Decimal helper for 2 decimal places.
 * Avoids floating point inaccuracies.
 */
function toCents(amount) {
    if (amount === undefined || amount === null) return 0n;
    const str = String(amount).trim();
    if (!str) return 0n;
    const parts = str.split('.');
    const whole = BigInt(parts[0] || '0');
    const fracStr = (parts[1] || '').padEnd(2, '0').slice(0, 2);
    const frac = BigInt(fracStr);
    return (whole >= 0n ? whole * 100n + frac : whole * 100n - frac);
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
 * Generate atomic sequential journal number: JRN-<FY_CODE>-NNNN (e.g. JRN-2026-27-0001)
 * Scoped strictly to the Financial Year via financialYearId foreign key.
 */
async function generateJournalNumber(tx, financialYear) {
    if (!financialYear || !financialYear.id || !financialYear.code) {
        throw new Error('Valid financialYear is required to generate journal number.');
    }

    const seq = await tx.journalNumberSequence.upsert({
        where: { financialYearId: financialYear.id },
        update: {
            currentNumber: { increment: 1 }
        },
        create: {
            financialYearId: financialYear.id,
            currentNumber: 1
        }
    });

    const paddedNumber = String(seq.currentNumber).padStart(4, '0');
    return `JRN-${financialYear.code}-${paddedNumber}`;
}

/**
 * Validates and posts an atomic double-entry Journal Entry.
 *
 * Rules:
 * 1. Entry belongs to a valid, OPEN Financial Year matching entryDate.
 * 2. Minimum 2 lines.
 * 3. Each line: either debit > 0 or credit > 0 (strictly mutually exclusive, neither negative).
 * 4. Account must exist, be active, not be a group, and allow posting.
 * 5. SUM(debit) === SUM(credit) exactly.
 * 6. Historical records immutable once posted.
 * 7. Idempotent posting when idempotencyKey is supplied.
 * 8. Atomically updates account balances.
 *
 * @param {Object} params
 * @param {Date|string} params.entryDate
 * @param {number} [params.financialYearId]
 * @param {string} [params.sourceType='MANUAL']
 * @param {number} [params.sourceId]
 * @param {string} [params.idempotencyKey]
 * @param {string} params.narration
 * @param {Array<Object>} params.lines - [{ accountId, debit, credit, description, clientId }]
 * @param {number|null} [params.userId=null]
 * @param {Object} [externalTx=null]
 * @returns {Promise<Object>} Created JournalEntry
 */
async function postJournalEntry(params, externalTx = null) {
    const {
        entryDate: rawEntryDate,
        financialYearId: explicitFyId,
        sourceType = 'MANUAL',
        sourceId = null,
        idempotencyKey = null,
        narration: rawNarration,
        lines: rawLines,
        userId = null
    } = params;

    if (!rawEntryDate) throw new ValidationError('Journal entry date is required.');
    const entryDate = new Date(rawEntryDate);
    if (isNaN(entryDate.getTime())) throw new ValidationError('Invalid entry date format.');

    const cleanIdempotencyKey = idempotencyKey ? String(idempotencyKey).trim() : null;

    // Fast-path idempotency check before transaction
    if (cleanIdempotencyKey) {
        const clientOrTx = externalTx || prisma;
        const existingJournal = await clientOrTx.journalEntry.findUnique({
            where: { idempotencyKey: cleanIdempotencyKey },
            include: {
                lines: {
                    include: {
                        account: { select: { id: true, code: true, name: true, type: true, systemAccountKey: true } },
                        client: { select: { id: true, name: true } }
                    },
                    orderBy: { lineNumber: 'asc' }
                },
                financialYear: { select: { id: true, code: true, status: true } },
                postedBy: { select: { id: true, name: true, email: true } }
            }
        });
        if (existingJournal) {
            return existingJournal;
        }
    }

    const narration = (rawNarration || '').trim();
    if (!narration) throw new ValidationError('Narration is required for journal posting.');

    if (!Array.isArray(rawLines) || rawLines.length < 2) {
        throw new ValidationError('A journal entry must contain at least two lines.');
    }

    // Determine & validate Financial Year
    let fy = null;
    if (explicitFyId) {
        fy = await prisma.financialYear.findUnique({ where: { id: parseInt(explicitFyId, 10) } });
        if (!fy) throw new NotFoundError(`Financial year with ID ${explicitFyId} not found.`);
        const expectedFy = computeFinancialYear(entryDate);
        if (fy.code !== expectedFy.code || entryDate < fy.startDate || entryDate > fy.endDate) {
            throw new ValidationError(`Journal entry date ${entryDate.toISOString().slice(0, 10)} does not fall within Financial Year ${fy.code}.`);
        }
    } else {
        fy = await ensureFinancialYear(entryDate);
    }

    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot post journal entry into CLOSED financial year ${fy.code}.`);
    }

    // Server-authoritative line parsing and balance verification
    let totalDebitCents = 0n;
    let totalCreditCents = 0n;
    const validatedLines = [];

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        const accountId = parseInt(line.accountId, 10);
        if (isNaN(accountId) || accountId <= 0) {
            throw new ValidationError(`Line ${i + 1}: Valid accountId is required.`);
        }

        const debitCents = toCents(line.debit || 0);
        const creditCents = toCents(line.credit || 0);

        if (debitCents < 0n || creditCents < 0n) {
            throw new ValidationError(`Line ${i + 1}: Debit and credit amounts cannot be negative.`);
        }
        if (debitCents === 0n && creditCents === 0n) {
            throw new ValidationError(`Line ${i + 1}: Line must specify either a debit or credit amount.`);
        }
        if (debitCents > 0n && creditCents > 0n) {
            throw new ValidationError(`Line ${i + 1}: A line cannot have both debit and credit. Create separate lines.`);
        }

        totalDebitCents += debitCents;
        totalCreditCents += creditCents;

        validatedLines.push({
            lineNumber: i + 1,
            accountId,
            debitCents,
            creditCents,
            debitStr: fromCents(debitCents),
            creditStr: fromCents(creditCents),
            description: line.description ? String(line.description).trim() : null,
            clientId: line.clientId ? parseInt(line.clientId, 10) : null
        });
    }

    // Double entry balance invariant: SUM(debit) === SUM(credit)
    if (totalDebitCents !== totalCreditCents) {
        const drStr = fromCents(totalDebitCents);
        const crStr = fromCents(totalCreditCents);
        throw new ValidationError(`Double entry imbalance: Total Debit (₹${drStr}) must equal Total Credit (₹${crStr}).`);
    }

    const runInTransaction = async (tx) => {
        // Validate each account's status and posting eligibility
        for (const line of validatedLines) {
            const account = await tx.chartOfAccount.findUnique({
                where: { id: line.accountId }
            });
            if (!account) {
                throw new NotFoundError(`Account ID ${line.accountId} in line ${line.lineNumber} does not exist.`);
            }
            if (!account.active) {
                throw new ValidationError(`Account ${account.code} (${account.name}) is inactive and cannot accept postings.`);
            }
            if (account.isGroup) {
                throw new ValidationError(`Account ${account.code} (${account.name}) is a group account. Postings are only allowed to leaf accounts.`);
            }
            if (!account.allowPosting) {
                throw new ValidationError(`Account ${account.code} (${account.name}) does not allow posting.`);
            }

            // Subledger validation: if client is referenced, verify client exists
            if (line.clientId) {
                const client = await tx.client.findUnique({ where: { id: line.clientId } });
                if (!client) {
                    throw new NotFoundError(`Client subledger ID ${line.clientId} in line ${line.lineNumber} does not exist.`);
                }
            }
        }

        // Generate sequential entry number scoped to Financial Year
        const entryNumber = await generateJournalNumber(tx, fy);

        // Create JournalEntry
        const journal = await tx.journalEntry.create({
            data: {
                entryNumber,
                entryDate,
                financialYearId: fy.id,
                sourceType,
                sourceId,
                narration,
                status: 'POSTED',
                idempotencyKey: cleanIdempotencyKey,
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
                    include: {
                        account: { select: { id: true, code: true, name: true, type: true, systemAccountKey: true } },
                        client: { select: { id: true, name: true } }
                    },
                    orderBy: { lineNumber: 'asc' }
                },
                financialYear: { select: { id: true, code: true, status: true } },
                postedBy: { select: { id: true, name: true, email: true } }
            }
        });

        // Atomically adjust account balances
        for (const vl of validatedLines) {
            const acc = await tx.chartOfAccount.findUnique({ where: { id: vl.accountId } });
            const currentCents = toCents(acc.currentBalance);

            // Asset & Expense normal balance is DEBIT (+Dr, -Cr)
            // Liability, Equity & Income normal balance is CREDIT (+Cr, -Dr)
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

        return journal;
    };

    const fetchExistingByIdempotency = async () => {
        return await prisma.journalEntry.findUnique({
            where: { idempotencyKey: cleanIdempotencyKey },
            include: {
                lines: {
                    include: {
                        account: { select: { id: true, code: true, name: true, type: true, systemAccountKey: true } },
                        client: { select: { id: true, name: true } }
                    },
                    orderBy: { lineNumber: 'asc' }
                },
                financialYear: { select: { id: true, code: true, status: true } },
                postedBy: { select: { id: true, name: true, email: true } }
            }
        });
    };

    if (externalTx) {
        try {
            return await runInTransaction(externalTx);
        } catch (err) {
            if (cleanIdempotencyKey && (err.code === 'P2002' || err.message?.includes('idempotencyKey'))) {
                const existing = await fetchExistingByIdempotency();
                if (existing) return existing;
            }
            throw err;
        }
    } else {
        try {
            return await prisma.$transaction(runInTransaction);
        } catch (err) {
            if (cleanIdempotencyKey && (err.code === 'P2002' || err.message?.includes('idempotencyKey'))) {
                const existing = await fetchExistingByIdempotency();
                if (existing) return existing;
            }
            throw err;
        }
    }
}

/**
 * Reverse a posted journal entry immutably.
 * Creates an offsetting reversal entry (swapped debit and credit) and links them.
 */
async function reverseJournalEntry(id, options = {}, externalTx = null) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid journal entry ID.');

    const {
        reason = 'Reversal of entry',
        reversalDate = new Date(),
        userId = null
    } = options;

    const executeInTx = async (tx) => {
        const original = await tx.journalEntry.findUnique({
            where: { id: numId },
            include: {
                lines: true,
                financialYear: true
            }
        });

        if (!original) throw new NotFoundError(`Journal entry with ID ${numId} not found.`);
        if (original.status === 'REVERSED') {
            throw new ConflictError(`Journal entry ${original.entryNumber} has already been reversed.`);
        }
        if (original.status === 'VOID') {
            throw new ValidationError(`Journal entry ${original.entryNumber} is VOID and cannot be reversed.`);
        }

        const revDate = new Date(reversalDate);
        const revFy = await ensureFinancialYear(revDate);
        if (revFy.status === 'CLOSED') {
            throw new ValidationError(`Cannot post reversal into CLOSED financial year ${revFy.code}.`);
        }

        // Swapped lines
        const reversalLines = original.lines.map((line, idx) => ({
            accountId: line.accountId,
            debit: line.credit, // swap
            credit: line.debit, // swap
            description: `Reversal of ${original.entryNumber} Line ${line.lineNumber}: ${line.description || ''}`.trim(),
            clientId: line.clientId
        }));

        const revNarration = `[REVERSAL OF ${original.entryNumber}] ${reason}`.trim();

        // Post the reversing entry
        const reversingEntry = await postJournalEntry({
            entryDate: revDate,
            financialYearId: revFy.id,
            sourceType: original.sourceType,
            sourceId: original.sourceId,
            narration: revNarration,
            lines: reversalLines,
            userId
        }, tx);

        // Mark original as REVERSED and link
        await tx.journalEntry.update({
            where: { id: original.id },
            data: {
                status: 'REVERSED',
                reversedEntryId: reversingEntry.id
            }
        });

        return reversingEntry;
    };

    if (externalTx) {
        return await executeInTx(externalTx);
    }
    return await prisma.$transaction(executeInTx);
}

/**
 * Get single journal entry by ID
 */
async function getJournalEntryById(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid journal entry ID.');

    const entry = await prisma.journalEntry.findUnique({
        where: { id: numId },
        include: {
            financialYear: true,
            postedBy: { select: { id: true, name: true, email: true } },
            reversedEntry: { select: { id: true, entryNumber: true, entryDate: true, status: true } },
            reversingEntry: { select: { id: true, entryNumber: true, entryDate: true, status: true } },
            lines: {
                include: {
                    account: { select: { id: true, code: true, name: true, type: true, systemAccountKey: true } },
                    client: { select: { id: true, name: true } }
                },
                orderBy: { lineNumber: 'asc' }
            }
        }
    });

    if (!entry) throw new NotFoundError(`Journal entry with ID ${numId} was not found.`);
    return entry;
}

/**
 * List journal entries with filters and pagination
 */
async function listJournalEntries(filters = {}) {
    const where = {};
    if (filters.financialYearId) {
        where.financialYearId = parseInt(filters.financialYearId, 10);
    }
    if (filters.sourceType) {
        where.sourceType = String(filters.sourceType).toUpperCase();
    }
    if (filters.sourceId !== undefined) {
        where.sourceId = parseInt(filters.sourceId, 10);
    }
    if (filters.status) {
        where.status = String(filters.status).toUpperCase();
    }
    if (filters.fromDate || filters.toDate) {
        where.entryDate = {};
        if (filters.fromDate) where.entryDate.gte = new Date(filters.fromDate);
        if (filters.toDate) where.entryDate.lte = new Date(filters.toDate);
    }
    if (filters.accountId) {
        where.lines = {
            some: { accountId: parseInt(filters.accountId, 10) }
        };
    }
    if (filters.search) {
        const q = String(filters.search).trim();
        where.OR = [
            { entryNumber: { contains: q } },
            { narration: { contains: q } }
        ];
    }

    const page = Math.max(1, parseInt(filters.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit || 25, 10)));
    const skip = (page - 1) * limit;

    const [total, entries] = await Promise.all([
        prisma.journalEntry.count({ where }),
        prisma.journalEntry.findMany({
            where,
            orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
            skip,
            take: limit,
            include: {
                financialYear: { select: { id: true, code: true } },
                postedBy: { select: { id: true, name: true } },
                lines: {
                    include: {
                        account: { select: { id: true, code: true, name: true, type: true, systemAccountKey: true } },
                        client: { select: { id: true, name: true } }
                    },
                    orderBy: { lineNumber: 'asc' }
                }
            }
        })
    ]);

    return {
        entries,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit)
        }
    };
}

/**
 * Get complete Account Ledger (Account Statement)
 * Computes running balance across journal transactions.
 */
async function getAccountLedger(accountId, filters = {}) {
    const numId = parseInt(accountId, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid account ID.');

    const account = await prisma.chartOfAccount.findUnique({
        where: { id: numId },
        include: { parent: { select: { id: true, code: true, name: true } } }
    });
    if (!account) throw new NotFoundError(`Account with ID ${numId} was not found.`);

    const where = {
        accountId: numId,
        journalEntry: {
            status: { in: ['POSTED', 'REVERSED'] }
        }
    };

    if (filters.financialYearId) {
        where.journalEntry.financialYearId = parseInt(filters.financialYearId, 10);
    }
    if (filters.fromDate || filters.toDate) {
        where.journalEntry.entryDate = {};
        if (filters.fromDate) where.journalEntry.entryDate.gte = new Date(filters.fromDate);
        if (filters.toDate) where.journalEntry.entryDate.lte = new Date(filters.toDate);
    }

    const lines = await prisma.journalEntryLine.findMany({
        where,
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

    const isDebitNormal = account.type === 'ASSET' || account.type === 'EXPENSE';
    let runningBalanceCents = toCents(account.openingBalance);
    let totalDebitCents = 0n;
    let totalCreditCents = 0n;

    const ledgerEntries = lines.map(line => {
        const drCents = toCents(line.debit);
        const crCents = toCents(line.credit);
        totalDebitCents += drCents;
        totalCreditCents += crCents;

        if (isDebitNormal) {
            runningBalanceCents = runningBalanceCents + drCents - crCents;
        } else {
            runningBalanceCents = runningBalanceCents + crCents - drCents;
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
            debit: line.debit,
            credit: line.credit,
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
            openingBalance: account.openingBalance,
            openingBalanceType: account.openingBalanceType,
            closingBalance: fromCents(runningBalanceCents),
            currentBalance: account.currentBalance
        },
        summary: {
            totalDebit: fromCents(totalDebitCents),
            totalCredit: fromCents(totalCreditCents),
            transactionCount: ledgerEntries.length
        },
        transactions: ledgerEntries
    };
}

/**
 * Enforce posted journal immutability
 */
async function updateJournalEntry() {
    throw new ValidationError('Posted journal entries are immutable. Once posted, accounting lines and amounts cannot be edited. Create a reversal entry instead.');
}

async function deleteJournalEntry() {
    throw new ValidationError('Posted journal entries cannot be deleted. Accounting records are immutable. Create a reversal entry instead.');
}

module.exports = {
    generateJournalNumber,
    postJournalEntry,
    reverseJournalEntry,
    getJournalEntryById,
    listJournalEntries,
    getAccountLedger,
    updateJournalEntry,
    deleteJournalEntry,
    toCents,
    fromCents,
    ValidationError,
    NotFoundError,
    ConflictError
};
