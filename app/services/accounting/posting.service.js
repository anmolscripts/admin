'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — INVOICE ACCOUNTING POSTING SERVICE (MILESTONE 4)
 * ==============================================================================
 *
 * Owns the double-entry accounting posting pipeline for invoices:
 *
 * Rules:
 * 1. Only valid, ACTIVE documents of documentType 'INVOICE' can be posted.
 *    Quotations, VOID, and DELETED documents are strictly non-posting.
 * 2. Deterministic Idempotency: idempotencyKey = 'INVOICE:<id>'.
 *    Repeated or concurrent posting resolves to the same journal entry safely.
 * 3. Double Entry Invariant:
 *    - Dr Customer / Accounts Receivable (Total Grand Total, tagged with clientId)
 *    - Cr Sales Revenue (Taxable Subtotal)
 *    - Cr Output CGST + Output SGST (Intra-state GST) OR Cr Output IGST (Inter-state GST)
 *    - Cr / Dr Round Off (if non-zero rounding exists)
 *    SUM(Debit) === SUM(Credit) exactly down to the cent.
 * 4. Financial Year Integrity:
 *    The journal is posted to the Financial Year matching invoice.invoiceDate.
 *    Closed Financial Years reject posting server-side.
 * 5. Traceability:
 *    sourceType = 'INVOICE'
 *    sourceId = invoice.id
 * ==============================================================================
 */

const prisma = require('../../config/prisma');
const coaService = require('../chartOfAccounts.service');
const journalService = require('../journal.service');
const { ensureFinancialYear, computeFinancialYear } = require('../financialYear.service');
const activityService = require('../activity.service');

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
 * Returns canonical idempotency key for an invoice.
 */
function getInvoiceIdempotencyKey(invoiceId) {
    return `INVOICE:${parseInt(invoiceId, 10)}`;
}

/**
 * Posts an invoice to the double-entry accounting ledger.
 *
 * @param {number|string} invoiceId - Primary key of the invoice
 * @param {Object} [options={}]
 * @param {number|null} [options.userId=null] - Actor initiating posting
 * @param {Object|null} [options.externalTx=null] - Optional outer Prisma transaction
 * @returns {Promise<Object>} { success, alreadyPosted, journal }
 */
async function postInvoice(invoiceId, options = {}, clientOrTxArg = null) {
    const numericId = parseInt(invoiceId, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid invoice ID.');
    }

    const { userId = null } = options;
    const externalTx = options.externalTx || (clientOrTxArg && clientOrTxArg !== prisma ? clientOrTxArg : null);
    const clientOrTx = externalTx || prisma;

    // 1. Fetch invoice with relations
    const invoice = await clientOrTx.invoice.findUnique({
        where: { id: numericId },
        include: {
            client: true,
            financialYear: true
        }
    });

    if (!invoice) {
        throw new NotFoundError(`Invoice with ID ${numericId} not found.`);
    }

    // 2. Lifecycle and document type rules
    if (invoice.documentType !== 'INVOICE') {
        throw new ValidationError('Only invoices can be posted to the accounting ledger. Quotations are non-posting documents.');
    }

    if (invoice.status === 'VOID') {
        throw new ValidationError(`Cannot post VOID invoice ${invoice.invoiceNumber} to the accounting ledger.`);
    }

    if (invoice.status === 'DELETED') {
        throw new ValidationError(`Cannot post DELETED invoice ${invoice.invoiceNumber} to the accounting ledger.`);
    }

    if (invoice.status === 'INACTIVE') {
        throw new ValidationError(`Cannot post INACTIVE invoice ${invoice.invoiceNumber} to the accounting ledger.`);
    }

    if (invoice.status !== 'ACTIVE') {
        throw new ValidationError(`Cannot post invoice ${invoice.invoiceNumber} with status ${invoice.status}.`);
    }

    // 3. Financial Year validation
    const invoiceDate = new Date(invoice.invoiceDate);
    if (isNaN(invoiceDate.getTime())) {
        throw new ValidationError(`Invoice ${invoice.invoiceNumber} has an invalid invoiceDate.`);
    }

    const fy = await ensureFinancialYear(invoiceDate, invoice.businessId);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot post invoice into CLOSED Financial Year ${fy.code}.`);
    }

    // Explicit cross-check against invoice's stored financialYearId if present
    if (invoice.financialYearId && invoice.financialYearId !== fy.id) {
        const expectedFy = computeFinancialYear(invoiceDate);
        if (expectedFy.code !== fy.code) {
            throw new ValidationError(`Invoice date ${invoiceDate.toISOString().slice(0, 10)} does not match assigned Financial Year.`);
        }
    }

    // 4. Deterministic Idempotency Check
    const idempotencyKey = getInvoiceIdempotencyKey(numericId);
    const existingJournal = await clientOrTx.journalEntry.findUnique({
        where: { idempotencyKey },
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
        return {
            success: true,
            alreadyPosted: true,
            journal: existingJournal
        };
    }

    // 5. Ensure System Accounts Exist
    const bizId = (invoice.businessId && invoice.businessId !== 1) ? invoice.businessId : null;
    await coaService.ensureSystemAccounts(userId, bizId);

    const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE', bizId);
    const salesAccount = await coaService.getSystemAccount('SALES_REVENUE', bizId);

    // 6. Precise Integer-Cent Financial Arithmetic
    const grandTotalCents = toCents(invoice.grandTotal);
    const subtotalCents = toCents(invoice.subtotal);
    const cgstCents = toCents(invoice.cgstAmount || 0);
    const sgstCents = toCents(invoice.sgstAmount || 0);
    const igstCents = toCents(invoice.igstAmount || 0);
    const roundOffCents = toCents(invoice.roundOff || 0);

    if (grandTotalCents <= 0n) {
        throw new ValidationError(`Invoice ${invoice.invoiceNumber} has a zero or negative grand total and cannot be posted.`);
    }

    // 7. Construct Balanced Double-Entry Lines
    const lines = [];

    // Line 1: Debit Accounts Receivable (Customer Control Account)
    lines.push({
        accountId: arAccount.id,
        debit: fromCents(grandTotalCents),
        credit: '0.00',
        description: `Tax Invoice ${invoice.invoiceNumber} - ${invoice.clientName}`,
        clientId: invoice.clientId || null
    });

    // Line 2: Credit Sales Revenue
    lines.push({
        accountId: salesAccount.id,
        debit: '0.00',
        credit: fromCents(subtotalCents),
        description: `Sales Revenue - Invoice ${invoice.invoiceNumber}`,
        clientId: null
    });

    // GST Lines: Intra-state (CGST + SGST) vs Inter-state (IGST)
    if (cgstCents > 0n || sgstCents > 0n) {
        const cgstAccount = await coaService.getSystemAccount('OUTPUT_CGST', bizId);
        const sgstAccount = await coaService.getSystemAccount('OUTPUT_SGST', bizId);

        if (cgstCents > 0n) {
            lines.push({
                accountId: cgstAccount.id,
                debit: '0.00',
                credit: fromCents(cgstCents),
                description: `Output CGST - Invoice ${invoice.invoiceNumber}`,
                clientId: null
            });
        }

        if (sgstCents > 0n) {
            lines.push({
                accountId: sgstAccount.id,
                debit: '0.00',
                credit: fromCents(sgstCents),
                description: `Output SGST - Invoice ${invoice.invoiceNumber}`,
                clientId: null
            });
        }
    } else if (igstCents > 0n) {
        const igstAccount = await coaService.getSystemAccount('OUTPUT_IGST', bizId);
        lines.push({
            accountId: igstAccount.id,
            debit: '0.00',
            credit: fromCents(igstCents),
            description: `Output IGST - Invoice ${invoice.invoiceNumber}`,
            clientId: null
        });
    }

    // Round-Off Adjustment Line (if non-zero)
    if (roundOffCents !== 0n) {
        const roundOffAccount = await coaService.getSystemAccount('ROUND_OFF', bizId);
        if (roundOffCents > 0n) {
            // Rounding up increases grand total; credit Round Off as gain/balancing credit
            lines.push({
                accountId: roundOffAccount.id,
                debit: '0.00',
                credit: fromCents(roundOffCents),
                description: `Round Off Gain - Invoice ${invoice.invoiceNumber}`,
                clientId: null
            });
        } else {
            // Rounding down decreases grand total; debit Round Off as expense/balancing debit
            lines.push({
                accountId: roundOffAccount.id,
                debit: fromCents(-roundOffCents),
                credit: '0.00',
                description: `Round Off Expense - Invoice ${invoice.invoiceNumber}`,
                clientId: null
            });
        }
    }

    // 8. Server-Side Double-Entry Balance Verification
    let totalDrCents = 0n;
    let totalCrCents = 0n;
    for (const line of lines) {
        totalDrCents += toCents(line.debit);
        totalCrCents += toCents(line.credit);
    }

    if (totalDrCents !== totalCrCents) {
        throw new ValidationError(
            `Double-entry imbalance for invoice ${invoice.invoiceNumber}: Debit ₹${fromCents(totalDrCents)} !== Credit ₹${fromCents(totalCrCents)}.`
        );
    }

    // 9. Post Atomic Journal Entry via journalService
    const narration = `Tax Invoice ${invoice.invoiceNumber} posted to ledger for customer ${invoice.clientName}`;

    const journal = await journalService.postJournalEntry({
        entryDate: invoiceDate,
        financialYearId: fy.id,
        sourceType: 'INVOICE',
        sourceId: invoice.id,
        idempotencyKey,
        narration,
        lines,
        userId,
        businessId: invoice.businessId || 1
    }, externalTx);

    // 10. Audit Activity Logging
    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'POST_INVOICE_LEDGER',
            module: 'JOURNALS',
            targetType: 'INVOICE',
            targetId: invoice.id,
            targetReference: invoice.invoiceNumber
        }).catch(() => {});
    }

    return {
        success: true,
        alreadyPosted: false,
        journal
    };
}

/**
 * Returns accounting details for an invoice (journal entry, accounts, lines).
 *
 * @param {number|string} invoiceId
 * @returns {Promise<Object|null>} Journal entry or null if unposted
 */
async function getInvoicePosting(invoiceId) {
    const numericId = parseInt(invoiceId, 10);
    if (isNaN(numericId) || numericId <= 0) return null;

    const idempotencyKey = getInvoiceIdempotencyKey(numericId);
    return await prisma.journalEntry.findUnique({
        where: { idempotencyKey },
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
}

/**
 * Returns high-level accounting status for an invoice.
 *
 * @param {number|string} invoiceId
 * @returns {Promise<Object>} { isPosted, journalId, entryNumber, postedAt }
 */
async function getInvoiceAccountingStatus(invoiceId) {
    const journal = await getInvoicePosting(invoiceId);
    if (!journal) {
        return {
            isPosted: false,
            journalId: null,
            entryNumber: null,
            postedAt: null
        };
    }
    return {
        isPosted: true,
        journalId: journal.id,
        entryNumber: journal.entryNumber,
        postedAt: journal.postedAt
    };
}

/**
 * Returns canonical idempotency key for a payment.
 */
function getPaymentIdempotencyKey(paymentId) {
    return `PAYMENT:${parseInt(paymentId, 10)}`;
}

const SUPPORTED_PAYMENT_METHODS = ['BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', 'CARD'];

/**
 * Resolves the Cash/Bank asset account for a given payment method or custom deposit account.
 */
async function resolvePaymentAssetAccount(method, customDepositAccountId = null, clientOrTx = prisma, businessId = null) {
    if (customDepositAccountId) {
        const depositAccId = parseInt(customDepositAccountId, 10);
        if (isNaN(depositAccId) || depositAccId <= 0) {
            throw new ValidationError('Invalid deposit account ID.');
        }
        const customAccount = await clientOrTx.chartOfAccount.findUnique({
            where: { id: depositAccId }
        });
        if (!customAccount) {
            throw new ValidationError(`Deposit account with ID ${depositAccId} not found.`);
        }
        if (!customAccount.active) {
            throw new ValidationError(`Deposit account ${customAccount.code} is inactive.`);
        }
        if (customAccount.isGroup || !customAccount.allowPosting) {
            throw new ValidationError(`Deposit account ${customAccount.code} does not allow direct posting.`);
        }
        if (customAccount.type !== 'ASSET') {
            throw new ValidationError(`Deposit account ${customAccount.code} must be an ASSET account.`);
        }
        return customAccount;
    }

    const rawMethod = String(method || '').trim().toUpperCase();
    const normMethod = rawMethod === 'CREDIT_CARD' ? 'CARD' : rawMethod;

    if (!SUPPORTED_PAYMENT_METHODS.includes(normMethod)) {
        throw new ValidationError(
            `Unsupported payment method: "${method}". Allowed methods are ${SUPPORTED_PAYMENT_METHODS.join(', ')}.`
        );
    }

    if (normMethod === 'CASH') {
        return await coaService.getSystemAccount('CASH_ON_HAND', businessId, clientOrTx);
    }

    // Default operating bank account for BANK_TRANSFER, UPI, CHEQUE, CARD
    return await coaService.getSystemAccount('BANK_ACCOUNT', businessId, clientOrTx);
}

/**
 * Posts a payment to the double-entry accounting ledger.
 *
 * Debit: Cash/Bank Asset Account
 * Credit: Accounts Receivable (Customer Control)
 *
 * @param {number|string} paymentId
 * @param {Object} [options={}]
 * @param {number|null} [options.userId=null]
 * @param {number|string|null} [options.depositAccountId=null]
 * @param {Object|null} [options.externalTx=null]
 * @returns {Promise<Object>} { success, alreadyPosted, journal }
 */
async function postPayment(paymentId, options = {}, clientOrTxArg = null) {
    const numericId = parseInt(paymentId, 10);
    if (isNaN(numericId) || numericId <= 0) {
        throw new ValidationError('Invalid payment ID.');
    }

    const { userId = null, depositAccountId = null } = options;
    const externalTx = options.externalTx || (clientOrTxArg && clientOrTxArg !== prisma ? clientOrTxArg : null);
    const clientOrTx = externalTx || prisma;

    // 1. Fetch payment with invoice and client
    const payment = await clientOrTx.payment.findUnique({
        where: { id: numericId },
        include: {
            invoice: {
                include: {
                    client: true
                }
            },
            financialYear: true
        }
    });

    if (!payment) {
        throw new NotFoundError(`Payment with ID ${numericId} not found.`);
    }

    // 2. Validate Payment Lifecycle & Invoice Status
    if (payment.status === 'VOID') {
        throw new ValidationError(`Cannot post VOID payment #${payment.id} to the accounting ledger.`);
    }

    if (payment.status !== 'POSTED') {
        throw new ValidationError(`Cannot post payment #${payment.id} with status "${payment.status}".`);
    }

    if (!payment.invoice) {
        throw new ValidationError(`Payment #${payment.id} is not linked to any invoice.`);
    }

    if (payment.invoice.documentType !== 'INVOICE') {
        throw new ValidationError('Payments can only be posted for invoices, not quotations.');
    }

    if (payment.invoice.status === 'VOID') {
        throw new ValidationError(`Cannot post payment for VOID invoice ${payment.invoice.invoiceNumber}.`);
    }

    if (payment.invoice.status === 'DELETED') {
        throw new ValidationError(`Cannot post payment for DELETED invoice ${payment.invoice.invoiceNumber}.`);
    }

    if (payment.invoice.status === 'INACTIVE') {
        throw new ValidationError(`Cannot post payment for INACTIVE invoice ${payment.invoice.invoiceNumber}.`);
    }

    // Cleared cheques use the date funds entered the bank; other payments use their receipt date.
    const accountingDate = new Date(payment.clearedAt || payment.paymentDate);
    if (isNaN(accountingDate.getTime())) {
        throw new ValidationError(`Payment #${payment.id} has an invalid accounting date.`);
    }

    const businessId = payment.invoice && payment.invoice.businessId ? payment.invoice.businessId : null;
    const fy = await ensureFinancialYear(accountingDate, businessId, clientOrTx);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot post payment into CLOSED Financial Year ${fy.code}.`);
    }

    if (payment.financialYearId && payment.financialYearId !== fy.id) {
        const expectedFy = computeFinancialYear(accountingDate);
        if (expectedFy.code !== fy.code) {
            throw new ValidationError(
                `Payment accounting date ${accountingDate.toISOString().slice(0, 10)} does not match assigned Financial Year.`
            );
        }
    }

    // 4. Deterministic Idempotency Check
    const idempotencyKey = getPaymentIdempotencyKey(numericId);
    const existingJournal = await clientOrTx.journalEntry.findUnique({
        where: { idempotencyKey },
        include: {
            lines: {
                include: {
                    account: { select: { id: true, code: true, name: true, type: true, systemAccountKey: true } },
                    client: { select: { id: true, name: true } }
                },
                orderBy: { lineNumber: 'asc' }
            },
            financialYear: { select: { id: true, code: true, status: true } },
            postedBy: { select: { id: true, name: true, email: true } },
            reversedEntry: { select: { id: true, entryNumber: true, status: true } },
            reversingEntry: { select: { id: true, entryNumber: true, status: true } }
        }
    });

    if (existingJournal) {
        return {
            success: true,
            alreadyPosted: true,
            journal: existingJournal
        };
    }

    // 5. Ensure System Accounts Exist
    const bizId = (payment.invoice && payment.invoice.businessId && payment.invoice.businessId !== 1) ? payment.invoice.businessId : null;
    await coaService.ensureSystemAccounts(userId, bizId, clientOrTx);

    const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE', bizId, clientOrTx);
    const assetAccount = await resolvePaymentAssetAccount(payment.method, depositAccountId, clientOrTx, bizId);

    // 6. Precise Integer-Cent Financial Arithmetic
    const paymentCents = toCents(payment.amount);
    if (paymentCents <= 0n) {
        throw new ValidationError(`Payment #${payment.id} has a zero or negative amount and cannot be posted.`);
    }

    // 7. Balanced Double-Entry Lines:
    // Debit: Cash/Bank Asset Account
    // Credit: Accounts Receivable (Customer Control with clientId)
    const lines = [
        {
            accountId: assetAccount.id,
            debit: fromCents(paymentCents),
            credit: '0.00',
            description: `Payment received for Invoice ${payment.invoice.invoiceNumber} via ${payment.method}${payment.reference ? ' (' + payment.reference + ')' : ''}`,
            clientId: null
        },
        {
            accountId: arAccount.id,
            debit: '0.00',
            credit: fromCents(paymentCents),
            description: `Payment against Invoice ${payment.invoice.invoiceNumber} - ${payment.invoice.clientName}`,
            clientId: payment.invoice.clientId || null
        }
    ];

    // 8. Server-Side Double-Entry Balance Verification
    let totalDrCents = 0n;
    let totalCrCents = 0n;
    for (const line of lines) {
        totalDrCents += toCents(line.debit);
        totalCrCents += toCents(line.credit);
    }

    if (totalDrCents !== totalCrCents) {
        throw new ValidationError(
            `Double-entry imbalance for payment #${payment.id}: Debit ₹${fromCents(totalDrCents)} !== Credit ₹${fromCents(totalCrCents)}.`
        );
    }

    // 9. Post Atomic Journal Entry via journalService
    const narration = `Customer payment of ₹${fromCents(paymentCents)} received for Invoice ${payment.invoice.invoiceNumber} (${payment.method})`;

    const journal = await journalService.postJournalEntry({
        entryDate: accountingDate,
        financialYearId: fy.id,
        sourceType: 'PAYMENT',
        sourceId: payment.id,
        idempotencyKey,
        narration,
        lines,
        userId,
        businessId: (payment.invoice && payment.invoice.businessId) || 1
    }, externalTx);

    // 10. Audit Activity Logging
    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'POST_PAYMENT_LEDGER',
            module: 'JOURNALS',
            targetType: 'PAYMENT',
            targetId: payment.id,
            targetReference: payment.reference || `Payment #${payment.id}`
        }, externalTx || clientOrTx);
    }

    return {
        success: true,
        alreadyPosted: false,
        journal
    };
}

/**
 * Returns accounting details for a payment (journal entry, accounts, lines).
 *
 * @param {number|string} paymentId
 * @returns {Promise<Object|null>}
 */
async function getPaymentPosting(paymentId) {
    const numericId = parseInt(paymentId, 10);
    if (isNaN(numericId) || numericId <= 0) return null;

    const idempotencyKey = getPaymentIdempotencyKey(numericId);
    return await prisma.journalEntry.findUnique({
        where: { idempotencyKey },
        include: {
            lines: {
                include: {
                    account: { select: { id: true, code: true, name: true, type: true, systemAccountKey: true } },
                    client: { select: { id: true, name: true } }
                },
                orderBy: { lineNumber: 'asc' }
            },
            financialYear: { select: { id: true, code: true, status: true } },
            postedBy: { select: { id: true, name: true, email: true } },
            reversedEntry: { select: { id: true, entryNumber: true, status: true } },
            reversingEntry: { select: { id: true, entryNumber: true, status: true } }
        }
    });
}

/**
 * Returns high-level accounting status for a payment.
 *
 * @param {number|string} paymentId
 * @returns {Promise<Object>} { isPosted, journalId, entryNumber, status, reversedEntryId, postedAt }
 */
async function getPaymentAccountingStatus(paymentId) {
    const journal = await getPaymentPosting(paymentId);
    if (!journal) {
        return {
            isPosted: false,
            journalId: null,
            entryNumber: null,
            status: 'UNPOSTED',
            reversedEntryId: null,
            postedAt: null
        };
    }
    return {
        isPosted: true,
        journalId: journal.id,
        entryNumber: journal.entryNumber,
        status: journal.status,
        reversedEntryId: journal.reversedEntryId,
        postedAt: journal.postedAt
    };
}

/**
 * ==============================================================================
 * CREDIT NOTE & DEBIT NOTE ACCOUNTING POSTING ENGINE (MILESTONE 6)
 * ==============================================================================
 */

/**
 * Deterministic idempotency key for Credit and Debit Notes.
 * @param {'CREDIT'|'DEBIT'} noteType
 * @param {number|string} noteId
 * @returns {string} e.g. 'CREDIT_NOTE:42' or 'DEBIT_NOTE:42'
 */
function getCreditDebitNoteIdempotencyKey(noteType, noteId) {
    const norm = String(noteType).trim().toUpperCase();
    const prefix = norm === 'DEBIT' ? 'DEBIT_NOTE' : 'CREDIT_NOTE';
    return `${prefix}:${noteId}`;
}

/**
 * Posts an atomic double-entry journal entry for a Credit Note or Debit Note.
 *
 * Credit Note Accounting:
 *   Debit:  Sales Returns & Rebates (4130)  [Taxable subtotal]
 *   Debit:  Output CGST / SGST / IGST       [Tax reversal]
 *   Debit/Credit: Round Off Discrepancy (5230)
 *   Credit: Accounts Receivable (1121)      [Grand total, tagged with clientId]
 *
 * Debit Note Accounting:
 *   Debit:  Accounts Receivable (1121)      [Grand total, tagged with clientId]
 *   Credit: Sales Revenue (4110)            [Taxable subtotal]
 *   Credit: Output CGST / SGST / IGST       [Output tax liability]
 *   Debit/Credit: Round Off Discrepancy (5230)
 *
 * @param {number|string} noteId
 * @param {Object} [options={}]
 * @param {number} [options.userId]
 * @param {Object} [clientOrTxArg=null]
 * @returns {Promise<{ success: boolean, alreadyPosted?: boolean, journal: Object }>}
 */
async function postCreditDebitNote(noteId, options = {}, clientOrTxArg = null) {
    const numId = parseInt(noteId, 10);
    if (isNaN(numId) || numId <= 0) {
        throw new ValidationError('Invalid credit/debit note ID.');
    }

    const userId = options.userId || null;
    const executeInContext = async (tx) => {
        // 1. Fetch note with items and relations
        const note = await tx.creditDebitNote.findUnique({
            where: { id: numId },
            include: {
                invoice: true,
                client: true,
                financialYear: true,
                items: true
            }
        });

        if (!note) {
            throw new NotFoundError(`Credit/Debit Note #${numId} not found.`);
        }

        // 2. Validate lifecycle status
        if (note.status === 'VOID') {
            throw new ValidationError(`Cannot post accounting for a VOID note (#${note.noteNumber}).`);
        }

        if (note.status === 'DRAFT') {
            throw new ValidationError(`Cannot post accounting for a DRAFT note (#${note.noteNumber}). Note must be ISSUED.`);
        }

        // 3. Check Financial Year validity
        const noteDate = new Date(note.noteDate);
        if (isNaN(noteDate.getTime())) {
            throw new ValidationError(`Invalid note date on note #${note.noteNumber}.`);
        }

        const financialYear = await ensureFinancialYear(noteDate, note.businessId);
        if (!financialYear) {
            throw new ValidationError(`Could not resolve Financial Year for note date ${noteDate.toISOString().slice(0, 10)}.`);
        }

        if (financialYear.status === 'CLOSED') {
            throw new ValidationError(`Cannot post note to closed Financial Year ${financialYear.code}.`);
        }

        // 4. Idempotency Check
        const idempotencyKey = getCreditDebitNoteIdempotencyKey(note.noteType, note.id);
        const existingJournal = await tx.journalEntry.findUnique({
            where: { idempotencyKey },
            include: {
                lines: {
                    include: { account: true, client: true },
                    orderBy: { lineNumber: 'asc' }
                },
                financialYear: true
            }
        });

        if (existingJournal) {
            return {
                success: true,
                alreadyPosted: true,
                journal: existingJournal
            };
        }

        // 5. Ensure System Accounts Exist
        const bizId = (note.businessId && note.businessId !== 1) ? note.businessId : null;
        await coaService.ensureSystemAccounts(userId, bizId);

        const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE', bizId);
        const roundOffAccount = await coaService.getSystemAccount('ROUND_OFF', bizId);

        // 6. Integer-Cent Monetary Arithmetic
        const grandTotalCents = toCents(note.grandTotal);
        const subtotalCents = toCents(note.subtotal);
        const cgstCents = toCents(note.cgstAmount || 0);
        const sgstCents = toCents(note.sgstAmount || 0);
        const igstCents = toCents(note.igstAmount || 0);
        const roundOffCents = toCents(note.roundOff || 0);

        if (grandTotalCents <= 0n) {
            throw new ValidationError(`Note ${note.noteNumber} has zero or negative grand total and cannot be posted.`);
        }

        const lines = [];

        if (note.noteType === 'CREDIT') {
            const salesReturnsAccount = await coaService.getSystemAccount('SALES_RETURNS', bizId);

            // Line 1: Debit Sales Returns
            lines.push({
                accountId: salesReturnsAccount.id,
                debit: fromCents(subtotalCents),
                credit: '0.00',
                description: `Sales Return - Credit Note ${note.noteNumber} against Invoice ${note.originalInvoiceNumber}`,
                clientId: null
            });

            // Tax Reversal Lines (Debit Output Tax)
            if (cgstCents > 0n || sgstCents > 0n) {
                const cgstAccount = await coaService.getSystemAccount('OUTPUT_CGST', bizId);
                const sgstAccount = await coaService.getSystemAccount('OUTPUT_SGST', bizId);

                if (cgstCents > 0n) {
                    lines.push({
                        accountId: cgstAccount.id,
                        debit: fromCents(cgstCents),
                        credit: '0.00',
                        description: `Output CGST Reversal - Credit Note ${note.noteNumber}`,
                        clientId: null
                    });
                }
                if (sgstCents > 0n) {
                    lines.push({
                        accountId: sgstAccount.id,
                        debit: fromCents(sgstCents),
                        credit: '0.00',
                        description: `Output SGST Reversal - Credit Note ${note.noteNumber}`,
                        clientId: null
                    });
                }
            } else if (igstCents > 0n) {
                const igstAccount = await coaService.getSystemAccount('OUTPUT_IGST', bizId);
                lines.push({
                    accountId: igstAccount.id,
                    debit: fromCents(igstCents),
                    credit: '0.00',
                    description: `Output IGST Reversal - Credit Note ${note.noteNumber}`,
                    clientId: null
                });
            }

            // Round-Off Adjustment for Credit Note:
            // Since Credit AR = GrandTotal (unrounded + roundOff),
            // to balance: if roundOff > 0 (rounded up), Dr RoundOff; if roundOff < 0 (rounded down), Cr RoundOff
            if (roundOffCents !== 0n) {
                if (roundOffCents > 0n) {
                    lines.push({
                        accountId: roundOffAccount.id,
                        debit: fromCents(roundOffCents),
                        credit: '0.00',
                        description: `Round Off - Credit Note ${note.noteNumber}`,
                        clientId: null
                    });
                } else {
                    lines.push({
                        accountId: roundOffAccount.id,
                        debit: '0.00',
                        credit: fromCents(-roundOffCents),
                        description: `Round Off - Credit Note ${note.noteNumber}`,
                        clientId: null
                    });
                }
            }

            // Line: Credit Accounts Receivable (Customer Subledger)
            lines.push({
                accountId: arAccount.id,
                debit: '0.00',
                credit: fromCents(grandTotalCents),
                description: `Credit Note ${note.noteNumber} - ${note.clientName}`,
                clientId: note.clientId || null
            });
        } else {
            // DEBIT NOTE
            const salesAccount = await coaService.getSystemAccount('SALES_REVENUE', bizId);

            // Line 1: Debit Accounts Receivable (Customer Subledger)
            lines.push({
                accountId: arAccount.id,
                debit: fromCents(grandTotalCents),
                credit: '0.00',
                description: `Debit Note ${note.noteNumber} - ${note.clientName}`,
                clientId: note.clientId || null
            });

            // Line 2: Credit Sales Revenue
            lines.push({
                accountId: salesAccount.id,
                debit: '0.00',
                credit: fromCents(subtotalCents),
                description: `Revenue Adjustment - Debit Note ${note.noteNumber} against Invoice ${note.originalInvoiceNumber}`,
                clientId: null
            });

            // Output Tax Lines (Credit Output Tax)
            if (cgstCents > 0n || sgstCents > 0n) {
                const cgstAccount = await coaService.getSystemAccount('OUTPUT_CGST');
                const sgstAccount = await coaService.getSystemAccount('OUTPUT_SGST');

                if (cgstCents > 0n) {
                    lines.push({
                        accountId: cgstAccount.id,
                        debit: '0.00',
                        credit: fromCents(cgstCents),
                        description: `Output CGST - Debit Note ${note.noteNumber}`,
                        clientId: null
                    });
                }
                if (sgstCents > 0n) {
                    lines.push({
                        accountId: sgstAccount.id,
                        debit: '0.00',
                        credit: fromCents(sgstCents),
                        description: `Output SGST - Debit Note ${note.noteNumber}`,
                        clientId: null
                    });
                }
            } else if (igstCents > 0n) {
                const igstAccount = await coaService.getSystemAccount('OUTPUT_IGST');
                lines.push({
                    accountId: igstAccount.id,
                    debit: '0.00',
                    credit: fromCents(igstCents),
                    description: `Output IGST - Debit Note ${note.noteNumber}`,
                    clientId: null
                });
            }

            // Round-Off Adjustment for Debit Note:
            // Since Debit AR = GrandTotal (unrounded + roundOff),
            // to balance: if roundOff > 0 (rounded up), Cr RoundOff; if roundOff < 0 (rounded down), Dr RoundOff
            if (roundOffCents !== 0n) {
                if (roundOffCents > 0n) {
                    lines.push({
                        accountId: roundOffAccount.id,
                        debit: '0.00',
                        credit: fromCents(roundOffCents),
                        description: `Round Off Gain - Debit Note ${note.noteNumber}`,
                        clientId: null
                    });
                } else {
                    lines.push({
                        accountId: roundOffAccount.id,
                        debit: fromCents(-roundOffCents),
                        credit: '0.00',
                        description: `Round Off Expense - Debit Note ${note.noteNumber}`,
                        clientId: null
                    });
                }
            }
        }

        // 7. Verify Double-Entry Balance
        let totalDrCents = 0n;
        let totalCrCents = 0n;
        for (const l of lines) {
            totalDrCents += toCents(l.debit);
            totalCrCents += toCents(l.credit);
        }

        if (totalDrCents !== totalCrCents) {
            throw new ValidationError(
                `Unbalanced double-entry journal for Note ${note.noteNumber}: Debit ₹${fromCents(totalDrCents)} != Credit ₹${fromCents(totalCrCents)}`
            );
        }

        // 8. Create Atomic Journal Entry
        const journal = await journalService.postJournalEntry(
            {
                entryDate: noteDate,
                financialYearId: financialYear.id,
                sourceType: note.noteType === 'DEBIT' ? 'DEBIT_NOTE' : 'CREDIT_NOTE',
                sourceId: note.id,
                narration: `${note.noteType === 'DEBIT' ? 'Debit Note' : 'Credit Note'} ${note.noteNumber} issued for ₹${note.grandTotal} against Invoice ${note.originalInvoiceNumber} (${note.reason})`,
                idempotencyKey,
                lines,
                userId,
                businessId: note.businessId || 1
            },
            tx
        );

        // 9. Activity Log
        if (activityService && typeof activityService.logUserActivity === 'function') {
            activityService.logUserActivity({
                userId,
                action: 'POST_NOTE_ACCOUNTING',
                module: 'JOURNALS',
                targetType: note.noteType === 'DEBIT' ? 'DEBIT_NOTE' : 'CREDIT_NOTE',
                targetId: String(note.id),
                meta: {
                    noteNumber: note.noteNumber,
                    invoiceNumber: note.originalInvoiceNumber,
                    journalNumber: journal.entryNumber,
                    grandTotal: Number(note.grandTotal)
                }
            }, tx).catch(() => {});
        }

        return {
            success: true,
            alreadyPosted: false,
            journal
        };
    };

    if (clientOrTxArg) {
        return await executeInContext(clientOrTxArg);
    }
    try {
        return await prisma.$transaction(executeInContext, { timeout: 15000, maxWait: 10000 });
    } catch (err) {
        if (err.code === 'P2002' || err.message?.includes('idempotencyKey')) {
            const note = await prisma.creditDebitNote.findUnique({ where: { id: numId } });
            if (note) {
                const existing = await getCreditDebitNotePosting(note.noteType, note.id);
                if (existing) {
                    return {
                        success: true,
                        alreadyPosted: true,
                        journal: existing
                    };
                }
            }
        }
        throw err;
    }
}

/**
 * Retrieves the posted journal entry for a Credit or Debit Note.
 */
async function getCreditDebitNotePosting(noteType, noteId) {
    const numId = parseInt(noteId, 10);
    if (isNaN(numId) || numId <= 0) return null;

    const idempotencyKey = getCreditDebitNoteIdempotencyKey(noteType, numId);
    return await prisma.journalEntry.findUnique({
        where: { idempotencyKey },
        include: {
            lines: {
                include: { account: true, client: true },
                orderBy: { lineNumber: 'asc' }
            },
            financialYear: true,
            postedBy: { select: { id: true, name: true, email: true } },
            reversedEntry: { select: { id: true, entryNumber: true } }
        }
    });
}

/**
 * Retrieves accounting posting status summary for a note.
 */
async function getCreditDebitNoteAccountingStatus(noteType, noteId) {
    const journal = await getCreditDebitNotePosting(noteType, noteId);
    if (!journal) {
        return {
            isPosted: false,
            journalId: null,
            entryNumber: null,
            status: 'UNPOSTED',
            reversedEntryId: null,
            postedAt: null
        };
    }
    return {
        isPosted: true,
        journalId: journal.id,
        entryNumber: journal.entryNumber,
        status: journal.status,
        reversedEntryId: journal.reversedEntryId,
        postedAt: journal.postedAt
    };
}

module.exports = {
    ValidationError,
    NotFoundError,
    ConflictError,
    getInvoiceIdempotencyKey,
    postInvoice,
    getInvoicePosting,
    getInvoiceAccountingStatus,
    getPaymentIdempotencyKey,
    resolvePaymentAssetAccount,
    postPayment,
    getPaymentPosting,
    getPaymentAccountingStatus,
    getCreditDebitNoteIdempotencyKey,
    postCreditDebitNote,
    getCreditDebitNotePosting,
    getCreditDebitNoteAccountingStatus,
    toCents,
    fromCents,
    SUPPORTED_PAYMENT_METHODS
};
