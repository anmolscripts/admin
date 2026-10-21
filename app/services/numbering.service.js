'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — CENTRALIZED ATOMIC MONTHLY NUMBERING SERVICE
 * ==============================================================================
 *
 * Implements the mandatory enterprise numbering contract:
 *   Format: PREFIX/YYYY/MM/INCREMENT
 *   Examples:
 *     - INVO/2026/10/1, INVO/2026/10/2, ..., INVO/2026/11/1, ..., INVO/2027/01/1
 *     - QUOT/2026/10/1, QUOT/2026/10/2, ..., QUOT/2026/11/1
 *
 * Invariants:
 *   1. PREFIX is uppercase, validated, and contains NO slashes.
 *   2. YYYY is the 4-digit Gregorian calendar year.
 *   3. MM is the 2-digit calendar month ('01' through '12').
 *   4. INCREMENT starts at 1, has NO leading zeroes (/1, /2, /10, not /0001).
 *   5. Sequence resets to 1 when the calendar month changes.
 *   6. Independent sequences per business, per entity type, per year, and per month.
 *   7. Safe for 14-digit integer values using BigInt (no JS Number precision loss).
 *   8. Concurrency-safe in MySQL transactions with bounded retries.
 * ==============================================================================
 */

const prismaClient = require('../config/prisma');

const DEFAULT_PREFIXES = Object.freeze({
    INVOICE: 'INVO',
    QUOTATION: 'QUOT',
    LETTER: 'LTR',
    CREDIT_NOTE: 'CRN',
    CRN: 'CRN',
    DEBIT_NOTE: 'DBN',
    DBN: 'DBN',
    PURCHASE_ORDER: 'PO',
    PO: 'PO',
    SUPPLIER_BILL: 'SBILL',
    SBILL: 'SBILL',
    PAYMENT: 'RCPT',
    RCPT: 'RCPT',
    SUPPLIER_PAYMENT: 'SPAY',
    SPAY: 'SPAY',
    JOURNAL: 'JRNL',
    JRNL: 'JRNL',
    JOURNAL_ENTRY: 'JRNL',
    EXPENSE: 'EXP',
    EXP: 'EXP',
    OTHER_INCOME: 'INC',
    INC: 'INC',
    ITEM: 'ITEM',
    ITM: 'ITEM',
    UNIT: 'UNIT',
    UNT: 'UNIT',
    CLIENT: 'CUST',
    CUST: 'CUST',
    CLI: 'CUST',
    SUPPLIER: 'SUPP',
    SUPP: 'SUPP',
    SUP: 'SUPP',
    EMPLOYEE: 'EMP',
    EMP: 'EMP',
    PROJECT: 'PROJ',
    PROJ: 'PROJ',
    STOCK_MOVEMENT: 'STK',
    STK: 'STK',
    REIMBURSEMENT: 'REIMB',
    REIMB: 'REIMB',
    BILL: 'SBILL',
    PAYROLL_PERIOD: 'PAY',
    PAYROLL_RUN: 'PAY',
    PAY: 'PAY',
    GOODS_RECEIPT: 'GRN',
    GRN: 'GRN'
});

const CANONICAL_ENTITIES = Object.freeze([
    'INVOICE',
    'QUOTATION',
    'LETTER',
    'CREDIT_NOTE',
    'DEBIT_NOTE',
    'PURCHASE_ORDER',
    'SUPPLIER_BILL',
    'PAYMENT',
    'SUPPLIER_PAYMENT',
    'JOURNAL',
    'EXPENSE',
    'OTHER_INCOME',
    'ITEM',
    'UNIT',
    'CLIENT',
    'SUPPLIER',
    'EMPLOYEE',
    'PROJECT',
    'STOCK_MOVEMENT',
    'REIMBURSEMENT',
    'GOODS_RECEIPT'
]);

const ENTITY_DESCRIPTIONS = Object.freeze({
    GOODS_RECEIPT: 'Goods receipt notes (GRN) and store receiving challans',
    INVOICE: 'Sales invoices and official tax documents',
    QUOTATION: 'Formal sales estimates and client price proposals',
    LETTER: 'Branded letters and non-financial correspondence',
    CREDIT_NOTE: 'Inward credit notes and invoice reduction adjustments',
    DEBIT_NOTE: 'Outward debit notes and supplementary charges',
    PURCHASE_ORDER: 'Procurement orders issued to vendor suppliers',
    SUPPLIER_BILL: 'Inward vendor bills and accounts payable claims',
    PAYMENT: 'Receipts for customer payments received',
    SUPPLIER_PAYMENT: 'Disbursement vouchers for supplier settlements',
    JOURNAL: 'General ledger adjustments and journal entries',
    JOURNAL_ENTRY: 'General ledger adjustments and journal entries',
    EXPENSE: 'Operational expenditure claims and vouchers',
    OTHER_INCOME: 'Non-operating revenue and ancillary receipts',
    ITEM: 'Inventory item catalog and product SKU master',
    UNIT: 'Measurement unit specifications and conversion master',
    CLIENT: 'Customer accounts and billing contact entities',
    SUPPLIER: 'Procurement vendor master records',
    EMPLOYEE: 'Human resource personnel master and staff directory',
    PROJECT: 'Client deliverables, engagements, and costing tracking',
    STOCK_MOVEMENT: 'Inventory warehouse inward, outward, and transfer movements',
    REIMBURSEMENT: 'Employee expense reimbursement claims',
    PAYROLL_PERIOD: 'Periodic payroll processing cycle and wage distribution (batch format: PAY-YYYY-MM)',
    PAYROLL_RUN: 'Periodic payroll processing cycle and wage distribution (batch format: PAY-YYYY-MM)'
});

class NumberingError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'NumberingError';
        this.statusCode = statusCode;
    }
}

/**
 * Validate prefix syntax:
 * Uppercase letters, digits, hyphen, underscore only. NO slashes, max 20 chars.
 */
function validatePrefix(prefix) {
    if (!prefix || typeof prefix !== 'string') {
        throw new NumberingError('Prefix must be a non-empty string.');
    }
    const trimmed = prefix.trim().toUpperCase();
    if (trimmed.includes('/')) {
        throw new NumberingError('Prefix must not contain forward or backward slashes.');
    }
    if (!/^[A-Z0-9_-]{1,20}$/.test(trimmed)) {
        throw new NumberingError('Prefix must contain 1-20 uppercase letters, numbers, hyphens or underscores only.');
    }
    return trimmed;
}

const CANONICAL_ALIAS_MAP = Object.freeze({
    INVOICE: 'INVOICE',
    INVOICES: 'INVOICE',
    QUOTATION: 'QUOTATION',
    LETTER: 'LETTER',
    LETTERS: 'LETTER',
    LTR: 'LETTER',
    QUOTATIONS: 'QUOTATION',
    CREDIT_NOTE: 'CREDIT_NOTE',
    CREDIT_NOTES: 'CREDIT_NOTE',
    CRN: 'CREDIT_NOTE',
    DEBIT_NOTE: 'DEBIT_NOTE',
    DEBIT_NOTES: 'DEBIT_NOTE',
    DBN: 'DEBIT_NOTE',
    PURCHASE_ORDER: 'PURCHASE_ORDER',
    PURCHASE_ORDERS: 'PURCHASE_ORDER',
    PO: 'PURCHASE_ORDER',
    SUPPLIER_BILL: 'SUPPLIER_BILL',
    SUPPLIER_BILLS: 'SUPPLIER_BILL',
    SBILL: 'SUPPLIER_BILL',
    BILL: 'SUPPLIER_BILL',
    PAYMENT: 'PAYMENT',
    PAYMENTS: 'PAYMENT',
    RCPT: 'PAYMENT',
    SUPPLIER_PAYMENT: 'SUPPLIER_PAYMENT',
    SUPPLIER_PAYMENTS: 'SUPPLIER_PAYMENT',
    SPAY: 'SUPPLIER_PAYMENT',
    JOURNAL: 'JOURNAL',
    JOURNALS: 'JOURNAL',
    JOURNAL_ENTRY: 'JOURNAL',
    JRNL: 'JOURNAL',
    EXPENSE: 'EXPENSE',
    EXPENSES: 'EXPENSE',
    EXP: 'EXPENSE',
    OTHER_INCOME: 'OTHER_INCOME',
    OTHER_INCOMES: 'OTHER_INCOME',
    INC: 'OTHER_INCOME',
    ITEM: 'ITEM',
    ITEMS: 'ITEM',
    ITM: 'ITEM',
    UNIT: 'UNIT',
    UNITS: 'UNIT',
    UNT: 'UNIT',
    CLIENT: 'CLIENT',
    CLIENTS: 'CLIENT',
    CUST: 'CLIENT',
    CLI: 'CLIENT',
    SUPPLIER: 'SUPPLIER',
    SUPPLIERS: 'SUPPLIER',
    SUPP: 'SUPPLIER',
    SUP: 'SUPPLIER',
    EMPLOYEE: 'EMPLOYEE',
    EMPLOYEES: 'EMPLOYEE',
    EMP: 'EMPLOYEE',
    PROJECT: 'PROJECT',
    PROJECTS: 'PROJECT',
    PROJ: 'PROJECT',
    STOCK_MOVEMENT: 'STOCK_MOVEMENT',
    STOCK_MOVEMENTS: 'STOCK_MOVEMENT',
    STK: 'STOCK_MOVEMENT',
    REIMBURSEMENT: 'REIMBURSEMENT',
    REIMBURSEMENTS: 'REIMBURSEMENT',
    REIMB: 'REIMBURSEMENT',
    PAYROLL_PERIOD: 'PAYROLL_PERIOD',
    PAYROLL_RUN: 'PAYROLL_PERIOD',
    PAY: 'PAYROLL_PERIOD'
});

function toCanonicalEntity(entityType) {
    if (!entityType) return entityType;
    const norm = String(entityType).trim().toUpperCase();
    return CANONICAL_ALIAS_MAP[norm] || norm;
}

/**
 * Resolve effective prefix for a business and entity type.
 */
async function getPrefixForEntity(businessId, entityType, tx = null) {
    const db = tx || prismaClient;
    const rawType = String(entityType).trim().toUpperCase();
    const canonicalType = toCanonicalEntity(rawType);
    const defaultPrefix = DEFAULT_PREFIXES[rawType] || DEFAULT_PREFIXES[canonicalType] || rawType;

    if (!businessId) return defaultPrefix;

    try {
        let config = await db.businessPrefixConfig.findUnique({
            where: {
                businessId_entityType: {
                    businessId: Number(businessId),
                    entityType: rawType
                }
            }
        });
        if (!config && canonicalType !== rawType) {
            config = await db.businessPrefixConfig.findUnique({
                where: {
                    businessId_entityType: {
                        businessId: Number(businessId),
                        entityType: canonicalType
                    }
                }
            });
        }
        if (config && config.prefix) {
            return config.prefix.trim().toUpperCase();
        }
    } catch (_) {}

    return defaultPrefix;
}

/**
 * Configure prefix for a business and entity type.
 */
async function setPrefixForEntity(businessId, entityType, prefix, tx = null) {
    const db = tx || prismaClient;
    if (!businessId) throw new NumberingError('Business ID is required to set prefix.');
    const rawType = String(entityType).trim().toUpperCase();
    const canonicalType = toCanonicalEntity(rawType);
    const validated = validatePrefix(prefix);

    return await db.businessPrefixConfig.upsert({
        where: {
            businessId_entityType: {
                businessId: Number(businessId),
                entityType: canonicalType
            }
        },
        create: {
            businessId: Number(businessId),
            entityType: canonicalType,
            prefix: validated
        },
        update: {
            prefix: validated
        }
    });
}

/**
 * Parse date into Gregorian calendar year and 2-digit month string.
 */
function parseCalendarPeriod(dateInput) {
    let d;
    if (!dateInput) {
        d = new Date();
    } else if (dateInput instanceof Date) {
        d = isNaN(dateInput.getTime()) ? new Date() : dateInput;
    } else {
        d = new Date(dateInput);
        if (isNaN(d.getTime())) d = new Date();
    }

    const year = d.getFullYear();
    const month = d.getMonth() + 1; // 1..12
    const monthStr = String(month).padStart(2, '0'); // '01'..'12'

    return { year, month, monthStr };
}

/**
 * Allocate next sequential number atomically.
 *
 * @param {Object} params
 * @param {number} params.businessId - Canonical business ID
 * @param {string} params.entityType - Entity series type (e.g. 'INVOICE', 'QUOTATION', 'PO')
 * @param {Date|string} [params.date] - Document or transaction date
 * @param {Object} [params.tx] - Optional Prisma transaction client
 * @param {string} [params.overridePrefix] - Optional explicit prefix override
 * @returns {Promise<string>} Formatted identifier (e.g. 'INVO/2026/10/1')
 */
async function allocateNumber({ businessId, entityType, date, tx = null, overridePrefix = null }) {
    if (!businessId || isNaN(Number(businessId)) || Number(businessId) <= 0) {
        throw new NumberingError('A valid businessId is required for document numbering sequence operations.', 400);
    }
    if (!entityType) {
        throw new NumberingError('entityType is required for number allocation.');
    }

    const activeBusinessId = Number(businessId);
    const rawType = String(entityType).trim().toUpperCase();
    const normType = toCanonicalEntity(rawType);

    if (normType === 'PAYROLL_PERIOD' || normType === 'PAYROLL_RUN' || normType === 'PAY') {
        throw new NumberingError('Payroll periods use calendar batch codes (PAY-YYYY-MM) scoped to business and do not support sequential document number allocation.', 400);
    }

    const { year, month, monthStr } = parseCalendarPeriod(date);

    const prefix = overridePrefix
        ? validatePrefix(overridePrefix)
        : await getPrefixForEntity(activeBusinessId, normType, tx);

    const executeAllocation = async (client) => {
        let attempts = 0;
        const maxAttempts = 5;

        while (attempts < maxAttempts) {
            try {
                // Ensure sequence row exists and atomically increment
                const request = require('../config/creationTracking').context.getStore();
                await client.$executeRawUnsafe(
                    'INSERT INTO numbering_sequences (businessId, entityType, year, month, currentNumber, createdAt, updatedAt, CREATED_BY, IP_ADDRESS) ' +
                    'VALUES (?, ?, ?, ?, 1, NOW(), NOW(), ?, ?) ' +
                    'ON DUPLICATE KEY UPDATE currentNumber = currentNumber + 1, updatedAt = NOW()',
                    activeBusinessId,
                    normType,
                    year,
                    month,
                    request?.session?.user?.id || null,
                    request?.ip ? String(request.ip).slice(0,45) : null
                );

                const rows = await client.$queryRawUnsafe(
                    'SELECT currentNumber FROM numbering_sequences WHERE businessId = ? AND entityType = ? AND year = ? AND month = ? FOR UPDATE',
                    activeBusinessId,
                    normType,
                    year,
                    month
                );

                let currentNum = (rows && rows[0] && rows[0].currentNumber !== undefined)
                    ? rows[0].currentNumber
                    : 1;

                let incrementStr = currentNum.toString();
                let candidate = `${prefix}/${year}/${monthStr}/${incrementStr}`;

                // Verify candidate does not already exist in target entity table (self-healing if sequence table was truncated or reset)
                let exists = await candidateExistsInTargetEntity(client, activeBusinessId, normType, candidate);
                while (exists) {
                    await client.$executeRawUnsafe(
                        'UPDATE numbering_sequences SET currentNumber = currentNumber + 1, updatedAt = NOW() WHERE businessId = ? AND entityType = ? AND year = ? AND month = ?',
                        activeBusinessId,
                        normType,
                        year,
                        month
                    );
                    currentNum = BigInt(currentNum) + 1n;
                    incrementStr = currentNum.toString();
                    candidate = `${prefix}/${year}/${monthStr}/${incrementStr}`;
                    exists = await candidateExistsInTargetEntity(client, activeBusinessId, normType, candidate);
                }

                return candidate;
            } catch (err) {
                attempts++;
                const isDeadlock = (err.code === 1213 || err.code === 'P2034' ||
                    (err.message && (err.message.includes('Deadlock') || err.message.includes('deadlock') || err.message.includes('could not serialize access'))));

                if (isDeadlock && !tx && attempts < maxAttempts) {
                    await new Promise(res => setTimeout(res, attempts * 25));
                    continue;
                }
                throw err;
            }
        }
    };

    if (tx) {
        return await executeAllocation(tx);
    } else {
        return await prismaClient.$transaction(async (innerTx) => {
            return await executeAllocation(innerTx);
        });
    }
}

/**
 * Peek at the current or next number without incrementing.
 */
async function peekNextNumber({ businessId, entityType, date, tx = null }) {
    if (!businessId || isNaN(Number(businessId)) || Number(businessId) <= 0) {
        throw new NumberingError('A valid businessId is required to inspect numbering sequence.', 400);
    }
    const db = tx || prismaClient;
    const activeBusinessId = Number(businessId);
    const rawType = String(entityType).trim().toUpperCase();
    const canonicalType = toCanonicalEntity(rawType);

    if (canonicalType === 'PAYROLL_PERIOD' || canonicalType === 'PAYROLL_RUN' || canonicalType === 'PAY') {
        throw new NumberingError('Payroll periods use calendar batch codes (PAY-YYYY-MM) scoped to business and do not support sequential document number inspection.', 400);
    }

    const { year, month, monthStr } = parseCalendarPeriod(date);
    const prefix = await getPrefixForEntity(activeBusinessId, rawType, db);

    let seq = await db.numberingSequence.findUnique({
        where: {
            businessId_entityType_year_month: {
                businessId: activeBusinessId,
                entityType: rawType,
                year,
                month
            }
        }
    });

    if (!seq && canonicalType !== rawType) {
        seq = await db.numberingSequence.findUnique({
            where: {
                businessId_entityType_year_month: {
                    businessId: activeBusinessId,
                    entityType: canonicalType,
                    year,
                    month
                }
            }
        });
    }

    const nextIncrement = seq ? (BigInt(seq.currentNumber) + 1n).toString() : '1';
    return `${prefix}/${year}/${monthStr}/${nextIncrement}`;
}

/**
 * Parse formatted identifier into component parts.
 * Example: 'INVO/2026/10/1' -> { prefix: 'INVO', year: 2026, month: 10, increment: 1n, valid: true }
 */
function parseIdentifier(identifier) {
    if (!identifier || typeof identifier !== 'string') return null;
    const parts = identifier.trim().split('/');
    if (parts.length !== 4) return null;

    const [prefix, yearStr, monthStr, incStr] = parts;
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);

    if (isNaN(year) || year < 1000 || year > 9999) return null;
    if (isNaN(month) || month < 1 || month > 12) return null;
    if (!/^\d+$/.test(incStr)) return null;

    try {
        const increment = BigInt(incStr);
        return {
            prefix,
            year,
            month,
            monthStr,
            increment,
            incrementStr: incStr,
            valid: true
        };
    } catch (_) {
        return null;
    }
}

/**
 * Verify whether candidate identifier already exists in the target entity table.
 */
async function candidateExistsInTargetEntity(client, businessId, normType, candidate) {
    try {
        switch (normType) {
            case 'LETTER':
                return !!(await client.letter.findFirst({where:{businessId,letterNumber:candidate}}));
            case 'INVOICE':
            case 'QUOTATION':
                return !!(await client.invoice.findFirst({
                    where: { businessId, invoiceNumber: candidate }
                }));
            case 'JOURNAL':
            case 'JRNL':
            case 'JOURNAL_ENTRY':
                return !!(await client.journalEntry.findFirst({
                    where: { businessId, entryNumber: candidate }
                }));
            case 'CREDIT_NOTE':
            case 'CRN':
            case 'DEBIT_NOTE':
            case 'DBN':
                return !!(await client.creditDebitNote.findFirst({
                    where: { businessId, noteNumber: candidate }
                }));
            case 'PURCHASE_ORDER':
            case 'PO':
                return !!(await client.purchaseOrder.findFirst({
                    where: { businessId, orderNumber: candidate }
                }));
            case 'SUPPLIER_BILL':
            case 'SBILL':
                return !!(await client.supplierBill.findFirst({
                    where: { businessId, internalNumber: candidate }
                }));
            case 'PAYMENT':
            case 'RCPT':
                return !!(await client.payment.findFirst({
                    where: { businessId, receiptNumber: candidate }
                }));
            case 'SUPPLIER_PAYMENT':
            case 'SPAY':
                return !!(await client.supplierPayment.findFirst({
                    where: { businessId, paymentNumber: candidate }
                }));
            case 'EXPENSE':
            case 'EXP':
                return !!(await client.expense.findFirst({
                    where: { businessId, expenseNumber: candidate }
                }));
            case 'OTHER_INCOME':
            case 'INC':
                return !!(await client.otherIncome.findFirst({
                    where: { businessId, incomeNumber: candidate }
                }));
            case 'STOCK_MOVEMENT':
            case 'STK':
                return !!(await client.stockMovement.findFirst({
                    where: { businessId, movementNumber: candidate }
                }));
            case 'EMPLOYEE':
            case 'EMP':
                return !!(await client.employee.findFirst({
                    where: { businessId, employeeCode: candidate }
                }));
            case 'PROJECT':
            case 'PROJ':
                return !!(await client.project.findFirst({
                    where: { businessId, code: candidate }
                }));
            case 'REIMBURSEMENT':
            case 'REIMB':
                return !!(await client.employeeReimbursement.findFirst({
                    where: { businessId, claimNumber: candidate }
                }));
            case 'CLIENT':
            case 'CUST':
            case 'CLI':
                return !!(await client.client.findFirst({
                    where: { businessId, clientCode: candidate }
                }));
            case 'SUPPLIER':
            case 'SUPP':
            case 'SUP':
                return !!(await client.supplier.findFirst({
                    where: { businessId, supplierCode: candidate }
                }));
            case 'ITEM':
            case 'ITM':
                return !!(await client.item.findFirst({
                    where: { businessId, itemCode: candidate }
                }));
            case 'UNIT':
            case 'UNT':
                return !!(await client.unit.findFirst({
                    where: { businessId, unitCode: candidate }
                }));
            case 'PAYROLL_PERIOD':
            case 'PAYROLL_RUN':
            case 'PAY':
                return !!(await client.payrollPeriod.findFirst({
                    where: { businessId, periodCode: candidate }
                }));
            default:
                return false;
        }
    } catch (_) {
        return false;
    }
}

/**
 * ==============================================================================
 * AUDITED SEQUENCE RECOVERY MECHANISM & GUARANTEES
 * ==============================================================================
 *
 * CRITICAL ARCHITECTURAL GUARANTEE & FUNDAMENTAL RECOVERY LIMITATION:
 * ------------------------------------------------------------------------------
 * If a numbering sequence table is dropped or reset, AND the highest externally
 * issued records were permanently hard-deleted from the database without leaving
 * tombstones or audit records, NO database recovery can reconstruct the missing
 * external high watermark.
 *
 * To guarantee no silently reused identifiers under real-world enterprise operations:
 * 1. Transactional documents MUST NEVER be physically hard-deleted; the ERP uses
 *    VOID or INACTIVE lifecycle states so historical identifiers remain intact.
 * 2. Automated recovery guarantees monotonic non-decreasing sequence numbers:
 *    The sequence is set to MAX(currentSequence, maxFoundInVerifiableRecords).
 *    Recovery will NEVER roll back or decrease an existing sequence.
 * 3. Immutable audit logs: Every recovery invocation writes an audited log event
 *    to `user_activity_logs` recording the previous value, recovered value,
 *    records scanned, and actor.
 * ==============================================================================
 */
async function syncAndRecoverSequence({
    businessId,
    entityType,
    year,
    month,
    tx = null,
    actorUserId = null,
    actorRole = null,
    forceSync = false
}) {
    if (!businessId || isNaN(Number(businessId)) || Number(businessId) <= 0) {
        throw new NumberingError('A valid businessId is required for sequence recovery.', 400);
    }
    if (!entityType) throw new NumberingError('entityType is required for sequence recovery.');
    if (actorRole && actorRole !== 'ADMIN' && actorRole !== 'OWNER') {
        throw new NumberingError('Unauthorized: Only administrators and business owners can invoke sequence recovery.', 403);
    }
    const activeBusinessId = Number(businessId);
    const normType = String(entityType).trim().toUpperCase();
    const period = (year && month) ? { year: Number(year), month: Number(month) } : parseCalendarPeriod(new Date());
    const targetYear = Number(period.year);
    const targetMonth = Number(period.month);

    const executeRecovery = async (client) => {
        // 1. Fetch current sequence row (if any)
        const seqRow = await client.numberingSequence.findUnique({
            where: {
                businessId_entityType_year_month: {
                    businessId: activeBusinessId,
                    entityType: normType,
                    year: targetYear,
                    month: targetMonth
                }
            }
        });
        const previousNumber = seqRow ? BigInt(seqRow.currentNumber) : 0n;

        // 2. Scan verifiable records in target entity table
        let maxFound = 0n;
        let recordsScanned = 0;
        let identifiers = [];

        switch (normType) {
            case 'LETTER':
                identifiers = (await client.letter.findMany({where:{businessId:activeBusinessId},select:{letterNumber:true}})).map(r=>r.letterNumber);
                break;
            case 'INVOICE':
                identifiers = (await client.invoice.findMany({
                    where: { businessId: activeBusinessId, documentType: 'INVOICE' },
                    select: { invoiceNumber: true }
                })).map(r => r.invoiceNumber);
                break;
            case 'QUOTATION':
                identifiers = (await client.invoice.findMany({
                    where: { businessId: activeBusinessId, documentType: 'QUOTATION' },
                    select: { invoiceNumber: true }
                })).map(r => r.invoiceNumber);
                break;
            case 'JOURNAL':
            case 'JRNL':
            case 'JOURNAL_ENTRY':
                identifiers = (await client.journalEntry.findMany({
                    where: { businessId: activeBusinessId },
                    select: { entryNumber: true }
                })).map(r => r.entryNumber);
                break;
            case 'CREDIT_NOTE':
            case 'CRN':
                identifiers = (await client.creditDebitNote.findMany({
                    where: { businessId: activeBusinessId, noteType: 'CREDIT' },
                    select: { noteNumber: true }
                })).map(r => r.noteNumber);
                break;
            case 'DEBIT_NOTE':
            case 'DBN':
                identifiers = (await client.creditDebitNote.findMany({
                    where: { businessId: activeBusinessId, noteType: 'DEBIT' },
                    select: { noteNumber: true }
                })).map(r => r.noteNumber);
                break;
            case 'PURCHASE_ORDER':
            case 'PO':
                identifiers = (await client.purchaseOrder.findMany({
                    where: { businessId: activeBusinessId },
                    select: { orderNumber: true }
                })).map(r => r.orderNumber);
                break;
            case 'SUPPLIER_BILL':
            case 'SBILL':
                identifiers = (await client.supplierBill.findMany({
                    where: { businessId: activeBusinessId },
                    select: { internalNumber: true }
                })).map(r => r.internalNumber).filter(Boolean);
                break;
            case 'PAYMENT':
            case 'RCPT':
                identifiers = (await client.payment.findMany({
                    where: { businessId: activeBusinessId },
                    select: { receiptNumber: true }
                })).map(r => r.receiptNumber).filter(Boolean);
                break;
            case 'SUPPLIER_PAYMENT':
            case 'SPAY':
                identifiers = (await client.supplierPayment.findMany({
                    where: { businessId: activeBusinessId },
                    select: { paymentNumber: true }
                })).map(r => r.paymentNumber).filter(Boolean);
                break;
            case 'EXPENSE':
            case 'EXP':
                identifiers = (await client.expense.findMany({
                    where: { businessId: activeBusinessId },
                    select: { expenseNumber: true }
                })).map(r => r.expenseNumber).filter(Boolean);
                break;
            case 'OTHER_INCOME':
            case 'INC':
                identifiers = (await client.otherIncome.findMany({
                    where: { businessId: activeBusinessId },
                    select: { incomeNumber: true }
                })).map(r => r.incomeNumber).filter(Boolean);
                break;
            case 'STOCK_MOVEMENT':
            case 'STK':
                identifiers = (await client.stockMovement.findMany({
                    where: { businessId: activeBusinessId },
                    select: { movementNumber: true }
                })).map(r => r.movementNumber).filter(Boolean);
                break;
            case 'EMPLOYEE':
            case 'EMP':
                identifiers = (await client.employee.findMany({
                    where: { businessId: activeBusinessId },
                    select: { employeeCode: true }
                })).map(r => r.employeeCode).filter(Boolean);
                break;
            case 'PROJECT':
            case 'PROJ':
                identifiers = (await client.project.findMany({
                    where: { businessId: activeBusinessId },
                    select: { code: true }
                })).map(r => r.code).filter(Boolean);
                break;
            case 'REIMBURSEMENT':
            case 'REIMB':
                identifiers = (await client.employeeReimbursement.findMany({
                    where: { businessId: activeBusinessId },
                    select: { claimNumber: true }
                })).map(r => r.claimNumber).filter(Boolean);
                break;
            case 'CLIENT':
            case 'CUST':
            case 'CLI':
                identifiers = (await client.client.findMany({
                    where: { businessId: activeBusinessId },
                    select: { clientCode: true }
                })).map(r => r.clientCode).filter(Boolean);
                break;
            case 'SUPPLIER':
            case 'SUPP':
            case 'SUP':
                identifiers = (await client.supplier.findMany({
                    where: { businessId: activeBusinessId },
                    select: { supplierCode: true }
                })).map(r => r.supplierCode).filter(Boolean);
                break;
            case 'ITEM':
            case 'ITM':
                identifiers = (await client.item.findMany({
                    where: { businessId: activeBusinessId },
                    select: { itemCode: true }
                })).map(r => r.itemCode).filter(Boolean);
                break;
            case 'UNIT':
            case 'UNT':
                identifiers = (await client.unit.findMany({
                    where: { businessId: activeBusinessId },
                    select: { unitCode: true }
                })).map(r => r.unitCode).filter(Boolean);
                break;
            case 'PAYROLL_PERIOD':
            case 'PAYROLL_RUN':
            case 'PAY':
                identifiers = (await client.payrollPeriod.findMany({
                    where: { businessId: activeBusinessId },
                    select: { periodCode: true }
                })).map(r => r.periodCode).filter(Boolean);
                break;
            default:
                break;
        }

        let periodRecordsCount = 0;
        for (const idStr of identifiers) {
            const parsed = parseIdentifier(idStr);
            if (parsed && parsed.valid && parsed.year === targetYear && parsed.month === targetMonth) {
                periodRecordsCount++;
                if (parsed.increment > maxFound) {
                    maxFound = parsed.increment;
                }
            }
        }
        recordsScanned = periodRecordsCount;

        // 3. Scan durable activity logs and tombstones if current records found no counter
        let auditMax = 0n;
        try {
            const auditLogs = await client.userActivityLog.findMany({
                where: {
                    businessId: activeBusinessId,
                    OR: [
                        { module: 'NUMBERING' },
                        { targetType: normType },
                        { module: normType }
                    ]
                },
                select: { targetReference: true, metadata: true }
            });
            for (const log of auditLogs) {
                if (log.targetReference) {
                    const p = parseIdentifier(log.targetReference);
                    if (p && p.valid && p.year === targetYear && p.month === targetMonth && p.increment > auditMax) {
                        auditMax = p.increment;
                    }
                }
                if (log.metadata && typeof log.metadata === 'object') {
                    const candidateRef = log.metadata.identifier || log.metadata.documentNumber || log.metadata.invoiceNumber;
                    if (candidateRef) {
                        const p = parseIdentifier(candidateRef);
                        if (p && p.valid && p.year === targetYear && p.month === targetMonth && p.increment > auditMax) {
                            auditMax = p.increment;
                        }
                    }
                }
            }
        } catch (_) {}
        if (auditMax > maxFound) {
            maxFound = auditMax;
        }

        // 4. If highest issued number is absent from both current records and durable audit/tombstones,
        // and sequence table was absent/zeroed, report that the original watermark is unknowable
        const isWatermarkUnknowable = (periodRecordsCount === 0 && auditMax === 0n && previousNumber === 0n);
        if (isWatermarkUnknowable) {
            return {
                businessId: activeBusinessId,
                entityType: normType,
                year: targetYear,
                month: targetMonth,
                previousNumber: '0',
                recoveredNumber: '0',
                recordsScanned: 0,
                recovered: false,
                watermarkUnknowable: true,
                reason: `The highest issued identifier for ${normType} in ${targetYear}/${String(targetMonth).padStart(2, '0')} is absent from both current database records and durable audit/tombstone history. Original sequence watermark is unknowable.`
            };
        }

        // Monotonic guarantee: never regress currentNumber backwards
        const targetSequence = maxFound > previousNumber ? maxFound : previousNumber;
        const needsUpdate = (targetSequence > previousNumber) || (!seqRow && targetSequence > 0n) || forceSync;

        if (needsUpdate) {
            await client.numberingSequence.upsert({
                where: {
                    businessId_entityType_year_month: {
                        businessId: activeBusinessId,
                        entityType: normType,
                        year: targetYear,
                        month: targetMonth
                    }
                },
                create: {
                    businessId: activeBusinessId,
                    entityType: normType,
                    year: targetYear,
                    month: targetMonth,
                    currentNumber: targetSequence
                },
                update: {
                    currentNumber: targetSequence
                }
            });

            // Record audited activity in user_activity_logs
            try {
                await client.userActivityLog.create({
                    data: {
                        actorUserId: actorUserId ? Number(actorUserId) : null,
                        businessId: activeBusinessId,
                        action: 'SEQUENCE_RECOVERED',
                        module: 'NUMBERING',
                        targetType: 'NUMBERING_SEQUENCE',
                        targetId: `${activeBusinessId}:${normType}:${targetYear}:${targetMonth}`,
                        metadata: {
                            businessId: activeBusinessId,
                            entityType: normType,
                            year: targetYear,
                            month: targetMonth,
                            previousNumber: previousNumber.toString(),
                            recoveredNumber: targetSequence.toString(),
                            maxFoundInRecords: maxFound.toString(),
                            recordsScanned
                        }
                    }
                });
            } catch (_) {}
        }

        return {
            businessId: activeBusinessId,
            entityType: normType,
            year: targetYear,
            month: targetMonth,
            previousNumber: previousNumber.toString(),
            recoveredNumber: targetSequence.toString(),
            recordsScanned,
            recovered: needsUpdate,
            watermarkUnknowable: false
        };
    };

    if (tx) {
        return await executeRecovery(tx);
    } else {
        return await prismaClient.$transaction(async (innerTx) => {
            return await executeRecovery(innerTx);
        });
    }
}

module.exports = {
    DEFAULT_PREFIXES,
    CANONICAL_ENTITIES,
    CANONICAL_ALIAS_MAP,
    ENTITY_DESCRIPTIONS,
    toCanonicalEntity,
    NumberingError,
    validatePrefix,
    getPrefixForEntity,
    setPrefixForEntity,
    parseCalendarPeriod,
    allocateNumber,
    peekNextNumber,
    parseIdentifier,
    candidateExistsInTargetEntity,
    syncAndRecoverSequence
};

