'use strict';

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

class ConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConflictError';
        this.statusCode = 409;
    }
}

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

const STANDARD_ACCOUNTS = [
    // 1000 ASSETS
    { code: '1000', name: 'Assets', type: 'ASSET', subtype: 'ASSET', level: 1, isGroup: true, allowPosting: false, description: 'Master Assets Group' },
    { code: '1100', name: 'Current Assets', type: 'ASSET', subtype: 'CURRENT_ASSET', parentCode: '1000', level: 2, isGroup: true, allowPosting: false },
    { code: '1110', name: 'Cash & Bank Balances', type: 'ASSET', subtype: 'CASH_BANK', parentCode: '1100', level: 3, isGroup: true, allowPosting: false },
    { code: '1111', name: 'Cash in Hand', type: 'ASSET', subtype: 'CASH', parentCode: '1110', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'CASH_ON_HAND', openingBalanceType: 'DEBIT' },
    { code: '1112', name: 'Bank Account - Operating', type: 'ASSET', subtype: 'BANK', parentCode: '1110', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'BANK_ACCOUNT', openingBalanceType: 'DEBIT' },
    { code: '1120', name: 'Trade Receivables (Debtors)', type: 'ASSET', subtype: 'RECEIVABLE', parentCode: '1100', level: 3, isGroup: true, allowPosting: false },
    { code: '1121', name: 'Accounts Receivable (Customers)', type: 'ASSET', subtype: 'ACCOUNTS_RECEIVABLE', parentCode: '1120', level: 4, isGroup: false, isControlAccount: true, allowPosting: true, systemAccount: true, systemAccountKey: 'ACCOUNTS_RECEIVABLE', openingBalanceType: 'DEBIT' },
    { code: '1130', name: 'Duties & Taxes (Input Credit)', type: 'ASSET', subtype: 'INPUT_GST', parentCode: '1100', level: 3, isGroup: true, allowPosting: false },
    { code: '1131', name: 'Input CGST', type: 'ASSET', subtype: 'INPUT_CGST', parentCode: '1130', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'INPUT_CGST', openingBalanceType: 'DEBIT' },
    { code: '1132', name: 'Input SGST', type: 'ASSET', subtype: 'INPUT_SGST', parentCode: '1130', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'INPUT_SGST', openingBalanceType: 'DEBIT' },
    { code: '1133', name: 'Input IGST', type: 'ASSET', subtype: 'INPUT_IGST', parentCode: '1130', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'INPUT_IGST', openingBalanceType: 'DEBIT' },
    { code: '1140', name: 'Inventories & Stock Assets', type: 'ASSET', subtype: 'INVENTORY', parentCode: '1100', level: 3, isGroup: true, allowPosting: false, description: 'Inventory Assets Group' },
    { code: '1141', name: 'Stock in Hand / Inventory Asset', type: 'ASSET', subtype: 'INVENTORY', parentCode: '1140', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'INVENTORY_ASSET', openingBalanceType: 'DEBIT' },


    // 2000 LIABILITIES
    { code: '2000', name: 'Liabilities', type: 'LIABILITY', subtype: 'LIABILITY', level: 1, isGroup: true, allowPosting: false, description: 'Master Liabilities Group' },
    { code: '2100', name: 'Current Liabilities', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', parentCode: '2000', level: 2, isGroup: true, allowPosting: false },
    { code: '2110', name: 'Duties & Taxes (Payable)', type: 'LIABILITY', subtype: 'OUTPUT_GST', parentCode: '2100', level: 3, isGroup: true, allowPosting: false },
    { code: '2111', name: 'Output CGST', type: 'LIABILITY', subtype: 'OUTPUT_CGST', parentCode: '2110', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'OUTPUT_CGST', openingBalanceType: 'CREDIT' },
    { code: '2112', name: 'Output SGST', type: 'LIABILITY', subtype: 'OUTPUT_SGST', parentCode: '2110', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'OUTPUT_SGST', openingBalanceType: 'CREDIT' },
    { code: '2113', name: 'Output IGST', type: 'LIABILITY', subtype: 'OUTPUT_IGST', parentCode: '2110', level: 4, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'OUTPUT_IGST', openingBalanceType: 'CREDIT' },
    { code: '2120', name: 'Trade Payables (Creditors)', type: 'LIABILITY', subtype: 'PAYABLE', parentCode: '2100', level: 3, isGroup: true, allowPosting: false },
    { code: '2121', name: 'Accounts Payable (Vendors)', type: 'LIABILITY', subtype: 'ACCOUNTS_PAYABLE', parentCode: '2120', level: 4, isGroup: false, isControlAccount: true, allowPosting: true, systemAccount: true, systemAccountKey: 'ACCOUNTS_PAYABLE', openingBalanceType: 'CREDIT' },
    { code: '2130', name: 'Salaries & Wages Payable', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', parentCode: '2100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'SALARIES_PAYABLE', openingBalanceType: 'CREDIT' },
    { code: '2131', name: 'EPF Contributions Payable', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', parentCode: '2100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'EPF_PAYABLE', openingBalanceType: 'CREDIT' },
    { code: '2132', name: 'ESI Contributions Payable', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', parentCode: '2100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'ESI_PAYABLE', openingBalanceType: 'CREDIT' },
    { code: '2133', name: 'Professional Tax Payable', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', parentCode: '2100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'PT_PAYABLE', openingBalanceType: 'CREDIT' },
    { code: '2134', name: 'TDS on Salaries Payable', type: 'LIABILITY', subtype: 'CURRENT_LIABILITY', parentCode: '2100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'TDS_PAYABLE', openingBalanceType: 'CREDIT' },

    // 3000 EQUITY
    { code: '3000', name: 'Equity & Capital', type: 'EQUITY', subtype: 'EQUITY', level: 1, isGroup: true, allowPosting: false, description: 'Master Equity Group' },
    { code: '3100', name: 'Capital Account', type: 'EQUITY', subtype: 'CAPITAL', parentCode: '3000', level: 2, isGroup: true, allowPosting: false },
    { code: '3110', name: 'Owner / Share Capital', type: 'EQUITY', subtype: 'SHARE_CAPITAL', parentCode: '3100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'CAPITAL', openingBalanceType: 'CREDIT' },
    { code: '3120', name: 'Retained Earnings', type: 'EQUITY', subtype: 'RETAINED_EARNINGS', parentCode: '3100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'RETAINED_EARNINGS', openingBalanceType: 'CREDIT' },

    // 4000 REVENUE
    { code: '4000', name: 'Revenue / Income', type: 'INCOME', subtype: 'INCOME', level: 1, isGroup: true, allowPosting: false, description: 'Master Revenue Group' },
    { code: '4100', name: 'Operating Revenue', type: 'INCOME', subtype: 'OPERATING_REVENUE', parentCode: '4000', level: 2, isGroup: true, allowPosting: false },
    { code: '4110', name: 'Sales Revenue', type: 'INCOME', subtype: 'SALES', parentCode: '4100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'SALES_REVENUE', openingBalanceType: 'CREDIT' },
    { code: '4120', name: 'Service Income', type: 'INCOME', subtype: 'SERVICES', parentCode: '4100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'SERVICE_INCOME', openingBalanceType: 'CREDIT' },
    { code: '4130', name: 'Sales Returns & Rebates', type: 'INCOME', subtype: 'SALES_RETURNS', parentCode: '4100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'SALES_RETURNS', openingBalanceType: 'DEBIT' },

    // 5000 EXPENSES
    { code: '5000', name: 'Expenses', type: 'EXPENSE', subtype: 'EXPENSE', level: 1, isGroup: true, allowPosting: false, description: 'Master Expenses Group' },
    { code: '5100', name: 'Cost of Sales', type: 'EXPENSE', subtype: 'COGS', parentCode: '5000', level: 2, isGroup: true, allowPosting: false },
    { code: '5110', name: 'Direct Material & Job Work Costs', type: 'EXPENSE', subtype: 'DIRECT_EXPENSE', parentCode: '5100', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'COGS', openingBalanceType: 'DEBIT' },
    { code: '5200', name: 'Operating & Administrative Expenses', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE', parentCode: '5000', level: 2, isGroup: true, allowPosting: false },
    { code: '5210', name: 'Office & Administrative Expenses', type: 'EXPENSE', subtype: 'ADMIN_EXPENSE', parentCode: '5200', level: 3, isGroup: false, allowPosting: true, systemAccount: false, openingBalanceType: 'DEBIT' },
    { code: '5220', name: 'Bank Charges & Fees', type: 'EXPENSE', subtype: 'FINANCE_EXPENSE', parentCode: '5200', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'BANK_CHARGES', openingBalanceType: 'DEBIT' },
    { code: '5230', name: 'Round Off Discrepancy', type: 'EXPENSE', subtype: 'ROUND_OFF', parentCode: '5200', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'ROUND_OFF', openingBalanceType: 'DEBIT' },
    { code: '5240', name: 'Salaries & Employee Compensation', type: 'EXPENSE', subtype: 'ADMIN_EXPENSE', parentCode: '5200', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'SALARIES_EXPENSE', openingBalanceType: 'DEBIT' },
    { code: '5241', name: 'Employer Statutory Contributions', type: 'EXPENSE', subtype: 'ADMIN_EXPENSE', parentCode: '5200', level: 3, isGroup: false, allowPosting: true, systemAccount: true, systemAccountKey: 'EMPLOYER_CONTRIBUTIONS', openingBalanceType: 'DEBIT' }
];

/**
 * Idempotently seeds standard chart of accounts hierarchy.
 * @param {number|null} [adminUserId=null]
 * @returns {Promise<number>} Number of accounts ensured/created
 */
async function ensureSystemAccounts(adminUserId = null) {
    let createdCount = 0;
    for (const item of STANDARD_ACCOUNTS) {
        let parentId = null;
        if (item.parentCode) {
            const parent = await prisma.chartOfAccount.findUnique({
                where: { code: item.parentCode },
                select: { id: true }
            });
            if (parent) parentId = parent.id;
        }

        const existing = await prisma.chartOfAccount.findUnique({
            where: { code: item.code }
        });

        if (!existing) {
            await prisma.chartOfAccount.create({
                data: {
                    code: item.code,
                    name: item.name,
                    type: item.type,
                    subtype: item.subtype,
                    parentId,
                    level: item.level,
                    isGroup: item.isGroup,
                    isControlAccount: item.isControlAccount || false,
                    allowPosting: item.allowPosting,
                    openingBalance: '0.00',
                    openingBalanceType: item.openingBalanceType || 'DEBIT',
                    currentBalance: '0.00',
                    active: true,
                    systemAccount: item.systemAccount || false,
                    systemAccountKey: item.systemAccountKey || null,
                    description: item.description || null,
                    createdById: adminUserId
                }
            });
            createdCount++;
        } else {
            // Update parent relationship if was missing earlier
            if (parentId && existing.parentId !== parentId) {
                await prisma.chartOfAccount.update({
                    where: { id: existing.id },
                    data: { parentId }
                });
            }
        }
    }
    return createdCount;
}

/**
 * Get account by unique system key (e.g. 'ACCOUNTS_RECEIVABLE', 'SALES_REVENUE')
 */
async function getSystemAccount(systemAccountKey) {
    if (!systemAccountKey) throw new ValidationError('systemAccountKey is required.');
    const account = await prisma.chartOfAccount.findUnique({
        where: { systemAccountKey }
    });
    if (!account) {
        throw new NotFoundError(`System account '${systemAccountKey}' not found.`);
    }
    return account;
}

/**
 * Get account by numeric ID
 */
async function getAccountById(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) {
        throw new ValidationError('Invalid account ID.');
    }
    const account = await prisma.chartOfAccount.findUnique({
        where: { id: numId },
        include: {
            parent: { select: { id: true, code: true, name: true, type: true } },
            children: { select: { id: true, code: true, name: true, isGroup: true, allowPosting: true, currentBalance: true } }
        }
    });
    if (!account) {
        throw new NotFoundError(`Account with ID ${numId} was not found.`);
    }
    return account;
}

/**
 * Get account by unique code (e.g. '1121')
 */
async function getAccountByCode(code) {
    if (!code) throw new ValidationError('Account code is required.');
    const account = await prisma.chartOfAccount.findUnique({
        where: { code: String(code).trim() }
    });
    return account;
}

/**
 * List accounts with flexible filters and hierarchical ordering
 */
async function listAccounts(filters = {}) {
    const where = {};
    if (filters.type) {
        if (!ACCOUNT_TYPES.includes(filters.type.toUpperCase())) {
            throw new ValidationError(`Invalid account type: ${filters.type}`);
        }
        where.type = filters.type.toUpperCase();
    }
    if (filters.isGroup !== undefined) {
        where.isGroup = filters.isGroup === true || filters.isGroup === 'true';
    }
    if (filters.allowPosting !== undefined) {
        where.allowPosting = filters.allowPosting === true || filters.allowPosting === 'true';
    }
    if (filters.active !== undefined) {
        where.active = filters.active === true || filters.active === 'true';
    }
    if (filters.parentId !== undefined) {
        where.parentId = filters.parentId ? parseInt(filters.parentId, 10) : null;
    }
    if (filters.search) {
        const query = String(filters.search).trim();
        where.OR = [
            { code: { contains: query } },
            { name: { contains: query } }
        ];
    }

    return await prisma.chartOfAccount.findMany({
        where,
        orderBy: [{ code: 'asc' }],
        include: {
            parent: { select: { id: true, code: true, name: true } },
            _count: { select: { children: true, journalLines: true } }
        }
    });
}

/**
 * Return nested tree structure of accounts
 */
async function getAccountTree(typeFilter = null) {
    const all = await listAccounts(typeFilter ? { type: typeFilter } : {});
    const map = new Map();
    all.forEach(acc => map.set(acc.id, { ...acc, children: [] }));
    const root = [];
    all.forEach(acc => {
        const node = map.get(acc.id);
        if (acc.parentId && map.has(acc.parentId)) {
            map.get(acc.parentId).children.push(node);
        } else {
            root.push(node);
        }
    });
    return root;
}

/**
 * Create a new account
 */
async function createAccount(data, userId = null) {
    if (!data.name || !String(data.name).trim()) {
        throw new ValidationError('Account name is required.');
    }
    if (!data.code || !String(data.code).trim()) {
        throw new ValidationError('Account code is required.');
    }
    const code = String(data.code).trim();
    const name = String(data.name).trim();

    const existing = await prisma.chartOfAccount.findUnique({ where: { code } });
    if (existing) {
        throw new ConflictError(`Account code '${code}' is already in use.`);
    }

    let parent = null;
    let level = 1;
    let type = data.type ? String(data.type).toUpperCase() : null;

    if (data.parentId) {
        const parentId = parseInt(data.parentId, 10);
        parent = await prisma.chartOfAccount.findUnique({ where: { id: parentId } });
        if (!parent) {
            throw new NotFoundError(`Parent account with ID ${parentId} not found.`);
        }
        if (!parent.isGroup) {
            throw new ValidationError('Parent account must be an account group.');
        }
        level = parent.level + 1;
        if (!type) {
            type = parent.type;
        } else if (type !== parent.type) {
            throw new ValidationError(`Account type (${type}) must match parent account type (${parent.type}).`);
        }
    }

    if (!type || !ACCOUNT_TYPES.includes(type)) {
        throw new ValidationError(`Valid account type is required: ${ACCOUNT_TYPES.join(', ')}`);
    }

    const isGroup = Boolean(data.isGroup);
    const allowPosting = isGroup ? false : (data.allowPosting !== undefined ? Boolean(data.allowPosting) : true);
    const isControlAccount = Boolean(data.isControlAccount);
    const openingBalance = data.openingBalance !== undefined ? String(Number(data.openingBalance).toFixed(2)) : '0.00';
    const openingBalanceType = data.openingBalanceType && ['CREDIT', 'DEBIT'].includes(String(data.openingBalanceType).toUpperCase())
        ? String(data.openingBalanceType).toUpperCase()
        : 'DEBIT';

    return await prisma.chartOfAccount.create({
        data: {
            code,
            name,
            type,
            subtype: data.subtype ? String(data.subtype).trim() : null,
            parentId: parent ? parent.id : null,
            level,
            isGroup,
            isControlAccount,
            allowPosting,
            openingBalance,
            openingBalanceType,
            currentBalance: openingBalance,
            active: data.active !== undefined ? Boolean(data.active) : true,
            systemAccount: false,
            description: data.description ? String(data.description).trim() : null,
            createdById: userId
        }
    });
}

/**
 * Update an existing account
 */
async function updateAccount(id, data, userId = null) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid account ID.');

    const existing = await prisma.chartOfAccount.findUnique({
        where: { id: numId },
        include: { _count: { select: { children: true, journalLines: true } } }
    });
    if (!existing) throw new NotFoundError(`Account with ID ${numId} was not found.`);

    if (existing.systemAccount && data.code && data.code !== existing.code) {
        throw new ValidationError('System account code cannot be modified.');
    }

    if (data.code && data.code !== existing.code) {
        const codeConflict = await prisma.chartOfAccount.findUnique({ where: { code: data.code } });
        if (codeConflict) throw new ConflictError(`Account code '${data.code}' is already in use.`);
    }

    if (existing._count.children > 0 && data.isGroup === false) {
        throw new ValidationError('Cannot convert group account to posting account while it has child accounts.');
    }

    if (existing._count.journalLines > 0 && data.isGroup === true) {
        throw new ValidationError('Cannot convert account with existing transactions into a group account.');
    }

    let parentId = existing.parentId;
    if (data.parentId !== undefined) {
        if (data.parentId === null || data.parentId === '') {
            parentId = null;
        } else {
            const targetParentId = parseInt(data.parentId, 10);
            if (isNaN(targetParentId) || targetParentId <= 0) {
                throw new ValidationError('Invalid parent account ID.');
            }
            if (targetParentId === numId) {
                throw new ValidationError('An account cannot be its own parent.');
            }
            const parentAcc = await prisma.chartOfAccount.findUnique({ where: { id: targetParentId } });
            if (!parentAcc) throw new NotFoundError(`Parent account with ID ${targetParentId} not found.`);
            if (!parentAcc.isGroup) throw new ValidationError('Parent account must be an account group.');
            await checkCircularHierarchy(numId, targetParentId);
            parentId = targetParentId;
        }
    }

    const updateData = {};
    if (data.name) updateData.name = String(data.name).trim();
    if (data.code && !existing.systemAccount) updateData.code = String(data.code).trim();
    if (data.description !== undefined) updateData.description = data.description ? String(data.description).trim() : null;
    if (data.active !== undefined) updateData.active = Boolean(data.active);
    if (data.isControlAccount !== undefined) updateData.isControlAccount = Boolean(data.isControlAccount);
    if (data.parentId !== undefined) updateData.parentId = parentId;

    return await prisma.chartOfAccount.update({
        where: { id: numId },
        data: updateData
    });
}

/**
 * Checks for circular references in account parent hierarchy.
 */
async function checkCircularHierarchy(accountId, targetParentId) {
    if (!targetParentId) return;
    if (accountId === targetParentId) {
        throw new ValidationError('An account cannot be its own parent.');
    }
    let currentParentId = targetParentId;
    const visited = new Set([accountId]);
    while (currentParentId) {
        if (visited.has(currentParentId)) {
            throw new ValidationError('Circular account hierarchy detected.');
        }
        visited.add(currentParentId);
        const parent = await prisma.chartOfAccount.findUnique({
            where: { id: currentParentId },
            select: { parentId: true }
        });
        currentParentId = parent ? parent.parentId : null;
    }
}

/**
 * Normal balance type based on account classification:
 * Asset & Expense: DEBIT
 * Liability, Equity & Income: CREDIT
 */
function getNormalBalanceType(type) {
    const t = String(type).toUpperCase();
    if (t === 'ASSET' || t === 'EXPENSE') return 'DEBIT';
    if (t === 'LIABILITY' || t === 'EQUITY' || t === 'INCOME') return 'CREDIT';
    throw new ValidationError(`Unknown account type: ${type}`);
}

/**
 * Delete account (strictly forbidden if has transactions, children, or is system account)
 */
async function deleteAccount(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid account ID.');

    const existing = await prisma.chartOfAccount.findUnique({
        where: { id: numId },
        include: { _count: { select: { children: true, journalLines: true } } }
    });
    if (!existing) throw new NotFoundError(`Account with ID ${numId} was not found.`);

    if (existing.systemAccount) {
        throw new ValidationError('System accounts cannot be deleted.');
    }
    if (existing._count.children > 0) {
        throw new ValidationError('Cannot delete account with existing child accounts.');
    }
    if (existing._count.journalLines > 0) {
        throw new ValidationError('Cannot delete account with existing journal entry records. You can deactivate it instead.');
    }

    return await prisma.chartOfAccount.delete({
        where: { id: numId }
    });
}

module.exports = {
    ACCOUNT_TYPES,
    STANDARD_ACCOUNTS,
    ensureSystemAccounts,
    getSystemAccount,
    getAccountById,
    getAccountByCode,
    listAccounts,
    getAccountTree,
    createAccount,
    updateAccount,
    deleteAccount,
    checkCircularHierarchy,
    getNormalBalanceType,
    ValidationError,
    NotFoundError,
    ConflictError
};
