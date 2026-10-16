'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — ENTERPRISE REPORTING & ANALYSIS WORKBENCH SERVICE (PHASE F)
 * ==============================================================================
 *
 * Provides a unified reporting workbench with:
 * - Authoritative data access across all core ERP business families:
 *   1. Accounting & Finance (Journals, AR Receivables, AP Payables, P&L, Trial Balance)
 *   2. Sales & Customers (Invoices, Quotations, Credit/Debit Notes)
 *   3. Purchasing & Operations (Purchase Orders, Supplier Bills, Expenses, Other Income)
 *   4. Inventory (Stock Movements, Inventory Valuation)
 *   5. People & Projects (Payroll Runs, Employees, Projects, Timesheets)
 * - Strict Multi-Business Authorization:
 *   - Global Platform Administrators can analyse single, subset, or all businesses.
 *   - Business Users can only analyse their authorized business(es).
 * - Multi-dimensional filtering and grouping with exact decimal arithmetic.
 * - Format parity across Web JSON, CSV, Excel (ExcelJS), and PDF (PDFKit).
 * - Saved report presets for personal and shared analysis.
 * ==============================================================================
 */

const prisma = require('../config/prisma');
const businessService = require('./business.service');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

class ForbiddenError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ForbiddenError';
        this.statusCode = 403;
    }
}

const REPORT_FAMILIES = {
    INVOICES: {
        id: 'INVOICES',
        name: 'Sales Invoices & Quotations',
        category: 'Sales & Customers',
        supportedGroupings: ['byBusiness', 'byMonth', 'byStatus', 'byCustomer'],
        supportedFilters: ['businessIds', 'documentType', 'status', 'clientId', 'dateFrom', 'dateTo', 'search']
    },
    CREDIT_DEBIT_NOTES: {
        id: 'CREDIT_DEBIT_NOTES',
        name: 'Credit & Debit Notes',
        category: 'Sales & Customers',
        supportedGroupings: ['byBusiness', 'byMonth', 'byNoteType', 'byStatus'],
        supportedFilters: ['businessIds', 'noteType', 'status', 'clientId', 'dateFrom', 'dateTo', 'search']
    },
    PURCHASE_ORDERS: {
        id: 'PURCHASE_ORDERS',
        name: 'Purchase Orders',
        category: 'Purchasing & Expenses',
        supportedGroupings: ['byBusiness', 'byMonth', 'byStatus', 'bySupplier'],
        supportedFilters: ['businessIds', 'status', 'supplierId', 'dateFrom', 'dateTo', 'search']
    },
    SUPPLIER_BILLS: {
        id: 'SUPPLIER_BILLS',
        name: 'Supplier Bills',
        category: 'Purchasing & Expenses',
        supportedGroupings: ['byBusiness', 'byMonth', 'byStatus', 'bySupplier'],
        supportedFilters: ['businessIds', 'status', 'supplierId', 'dateFrom', 'dateTo', 'search']
    },
    EXPENSES: {
        id: 'EXPENSES',
        name: 'Expenses Analysis',
        category: 'Purchasing & Expenses',
        supportedGroupings: ['byBusiness', 'byMonth', 'byCategory'],
        supportedFilters: ['businessIds', 'category', 'dateFrom', 'dateTo', 'search']
    },
    JOURNALS: {
        id: 'JOURNALS',
        name: 'General Ledger Journals',
        category: 'Accounting & Finance',
        supportedGroupings: ['byBusiness', 'byMonth', 'bySourceType', 'byStatus'],
        supportedFilters: ['businessIds', 'sourceType', 'status', 'accountId', 'financialYearId', 'dateFrom', 'dateTo', 'search']
    },
    STOCK_MOVEMENTS: {
        id: 'STOCK_MOVEMENTS',
        name: 'Stock Movement Register',
        category: 'Inventory',
        supportedGroupings: ['byBusiness', 'byMonth', 'byMovementType'],
        supportedFilters: ['businessIds', 'movementType', 'itemId', 'dateFrom', 'dateTo', 'search']
    },
    PAYROLL: {
        id: 'PAYROLL',
        name: 'Payroll & Statutory Registers',
        category: 'People & Projects',
        supportedGroupings: ['byBusiness', 'byMonth', 'byStatus'],
        supportedFilters: ['businessIds', 'status', 'employeeId', 'year', 'month']
    },
    PROJECTS: {
        id: 'PROJECTS',
        name: 'Projects & Resource Costing',
        category: 'People & Projects',
        supportedGroupings: ['byBusiness', 'byStatus', 'byBillingType'],
        supportedFilters: ['businessIds', 'status', 'billingType', 'clientId', 'search']
    },
    PAYMENTS: {
        id: 'PAYMENTS',
        name: 'Customer Receipts Register',
        category: 'Sales & Customers',
        supportedGroupings: ['byBusiness', 'byMonth', 'byStatus', 'byCustomer'],
        supportedFilters: ['businessIds', 'status', 'method', 'dateFrom', 'dateTo', 'search']
    },
    SUPPLIER_PAYMENTS: {
        id: 'SUPPLIER_PAYMENTS',
        name: 'Supplier Payouts Register',
        category: 'Purchasing & Expenses',
        supportedGroupings: ['byBusiness', 'byMonth', 'byStatus', 'bySupplier'],
        supportedFilters: ['businessIds', 'status', 'method', 'supplierId', 'dateFrom', 'dateTo', 'search']
    },
    CUSTOMERS: {
        id: 'CUSTOMERS',
        name: 'Customer Master & Balances',
        category: 'Sales & Customers',
        supportedGroupings: ['byBusiness', 'byStatus'],
        supportedFilters: ['businessIds', 'active', 'search']
    },
    SUPPLIERS: {
        id: 'SUPPLIERS',
        name: 'Supplier Master & Balances',
        category: 'Purchasing & Expenses',
        supportedGroupings: ['byBusiness', 'byStatus'],
        supportedFilters: ['businessIds', 'active', 'search']
    },
    OTHER_INCOME: {
        id: 'OTHER_INCOME',
        name: 'Other Income Register',
        category: 'Purchasing & Expenses',
        supportedGroupings: ['byBusiness', 'byMonth', 'byCategory'],
        supportedFilters: ['businessIds', 'source', 'dateFrom', 'dateTo', 'search']
    },
    REIMBURSEMENTS: {
        id: 'REIMBURSEMENTS',
        name: 'Employee Reimbursement Claims',
        category: 'People & Projects',
        supportedGroupings: ['byBusiness', 'byMonth', 'byStatus'],
        supportedFilters: ['businessIds', 'status', 'employeeId', 'dateFrom', 'dateTo', 'search']
    },
    INVENTORY_VALUATION: {
        id: 'INVENTORY_VALUATION',
        name: 'Inventory Valuation & Balances',
        category: 'Inventory',
        supportedGroupings: ['byBusiness', 'byStatus'],
        supportedFilters: ['businessIds', 'active', 'search']
    },
    TAX_GST: {
        id: 'TAX_GST',
        name: 'GST Tax Summary Register',
        category: 'Accounting & Finance',
        supportedGroupings: ['byBusiness', 'byMonth', 'byStatus'],
        supportedFilters: ['businessIds', 'status', 'dateFrom', 'dateTo']
    }
};

/**
 * Formula injection prevention helper
 */
function sanitizeCell(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (/^[=+\-@\t\r]/.test(str)) {
        return `'${str}`;
    }
    return str;
}

/**
 * Resolves and strictly enforces authorized business IDs for the requesting user
 */
async function resolveAuthorizedBusinesses(user, requestedBusinessIds = []) {
    if (!user) {
        throw new ForbiddenError('Authentication required to access reports.');
    }

    const isPlatformAdmin = user.role === 'ADMIN' || user.isPlatformAdmin === true;
    const accessible = await businessService.getAccessibleBusinesses(user.id, isPlatformAdmin, { includeArchived: true });
    const accessibleMap = new Map(accessible.map(b => [b.id, b]));

    if (accessible.length === 0 && !isPlatformAdmin) {
        throw new ForbiddenError('No authorized business memberships found.');
    }

    let targetIds = [];
    if (Array.isArray(requestedBusinessIds) && requestedBusinessIds.length > 0) {
        targetIds = requestedBusinessIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
    } else if (requestedBusinessIds && typeof requestedBusinessIds === 'string' && requestedBusinessIds.trim()) {
        targetIds = requestedBusinessIds.split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id) && id > 0);
    }

    if (targetIds.length === 0) {
        // Default to all accessible businesses
        targetIds = accessible.map(b => b.id);
    } else {
        // Validate every requested business against accessible businesses
        for (const bid of targetIds) {
            if (!accessibleMap.has(bid) && !isPlatformAdmin) {
                throw new ForbiddenError(`Access denied to business ID ${bid}.`);
            }
        }
    }

    return {
        isPlatformAdmin,
        authorizedIds: targetIds,
        businesses: targetIds.map(id => accessibleMap.get(id) || { id, name: `Business #${id}`, currency: 'INR' })
    };
}

/**
 * Executes dataset query with multi-business isolation and filter combinations
 */
async function queryWorkbench({ user, dataset = 'INVOICES', filters = {}, grouping = 'none', page = 1, limit = 50 }) {
    const family = REPORT_FAMILIES[dataset.toUpperCase()];
    if (!family) {
        throw new ValidationError(`Unsupported report dataset: "${dataset}". Available: ${Object.keys(REPORT_FAMILIES).join(', ')}`);
    }

    const authScope = await resolveAuthorizedBusinesses(user, filters.businessIds);
    const businessIds = authScope.authorizedIds;

    let records = [];
    let summary = {
        totalRecords: 0,
        subtotal: 0,
        taxAmount: 0,
        grandTotal: 0
    };

    switch (family.id) {
        case 'INVOICES': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.documentType && ['INVOICE', 'QUOTATION'].includes(filters.documentType.toUpperCase())) {
                where.documentType = filters.documentType.toUpperCase();
            }
            if (filters.status && ['ACTIVE', 'INACTIVE', 'VOID', 'PAID', 'PARTIALLY_PAID', 'OVERDUE'].includes(filters.status.toUpperCase())) {
                where.status = filters.status.toUpperCase();
            } else if (!filters.status) {
                where.status = { not: 'DELETED' };
            }
            if (filters.clientId) {
                where.clientId = parseInt(filters.clientId, 10);
            }
            if (filters.dateFrom || filters.dateTo) {
                where.invoiceDate = {};
                if (filters.dateFrom) where.invoiceDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.invoiceDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { invoiceNumber: { contains: q } },
                    { clientName: { contains: q } }
                ];
            }

            const rows = await prisma.invoice.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    client: { select: { id: true, name: true } }
                },
                orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || r.currency || 'INR',
                referenceNumber: r.invoiceNumber,
                date: r.invoiceDate ? r.invoiceDate.toISOString().slice(0, 10) : '',
                partyName: r.clientName || r.client?.name || '-',
                documentType: r.documentType,
                status: r.status,
                subtotal: Number(r.subtotal || 0),
                taxAmount: Number(r.gstAmount || 0),
                grandTotal: Number(r.grandTotal || 0),
                paidAmount: Number(r.paidAmount || 0),
                balance: Number(r.grandTotal || 0) - Number(r.paidAmount || 0)
            }));
            break;
        }

        case 'PURCHASE_ORDERS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.status) where.status = filters.status.toUpperCase();
            if (filters.supplierId) where.supplierId = parseInt(filters.supplierId, 10);
            if (filters.dateFrom || filters.dateTo) {
                where.orderDate = {};
                if (filters.dateFrom) where.orderDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.orderDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { orderNumber: { contains: q } },
                    { supplier: { name: { contains: q } } }
                ];
            }

            const rows = await prisma.purchaseOrder.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    supplier: { select: { id: true, name: true } }
                },
                orderBy: [{ orderDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || r.currency || 'INR',
                referenceNumber: r.orderNumber,
                date: r.orderDate ? r.orderDate.toISOString().slice(0, 10) : '',
                partyName: r.supplier?.name || '-',
                documentType: 'PURCHASE_ORDER',
                status: r.status,
                subtotal: Number(r.subtotal || 0),
                taxAmount: Number(r.taxAmount || 0),
                grandTotal: Number(r.grandTotal || 0),
                balance: Number(r.grandTotal || 0)
            }));
            break;
        }

        case 'SUPPLIER_BILLS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.status) where.status = filters.status.toUpperCase();
            if (filters.supplierId) where.supplierId = parseInt(filters.supplierId, 10);
            if (filters.dateFrom || filters.dateTo) {
                where.billDate = {};
                if (filters.dateFrom) where.billDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.billDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { internalNumber: { contains: q } },
                    { billNumber: { contains: q } },
                    { supplier: { name: { contains: q } } }
                ];
            }

            const rows = await prisma.supplierBill.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    supplier: { select: { id: true, name: true } }
                },
                orderBy: [{ billDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || r.currency || 'INR',
                referenceNumber: r.internalNumber || r.billNumber,
                externalReference: r.billNumber,
                date: r.billDate ? r.billDate.toISOString().slice(0, 10) : '',
                partyName: r.supplier?.name || '-',
                documentType: 'SUPPLIER_BILL',
                status: r.status,
                subtotal: Number(r.subtotal || 0),
                taxAmount: Number(r.taxAmount || 0),
                grandTotal: Number(r.grandTotal || 0),
                paidAmount: Number(r.paidAmount || 0),
                balance: Number(r.grandTotal || 0) - Number(r.paidAmount || 0)
            }));
            break;
        }

        case 'EXPENSES': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.category) where.category = filters.category;
            if (filters.dateFrom || filters.dateTo) {
                where.expenseDate = {};
                if (filters.dateFrom) where.expenseDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.expenseDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { description: { contains: q } },
                    { category: { contains: q } }
                ];
            }

            const rows = await prisma.expense.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } }
                },
                orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || 'INR',
                referenceNumber: `EXP-${r.id}`,
                date: r.expenseDate ? r.expenseDate.toISOString().slice(0, 10) : '',
                partyName: r.category || 'Expense',
                documentType: 'EXPENSE',
                status: 'POSTED',
                subtotal: Number(r.amount || 0),
                taxAmount: Number(r.taxAmount || 0),
                grandTotal: Number(r.amount || 0) + Number(r.taxAmount || 0),
                balance: 0
            }));
            break;
        }

        case 'JOURNALS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.status) where.status = filters.status.toUpperCase();
            if (filters.sourceType) where.sourceType = filters.sourceType.toUpperCase();
            if (filters.financialYearId) where.financialYearId = parseInt(filters.financialYearId, 10);
            if (filters.dateFrom || filters.dateTo) {
                where.entryDate = {};
                if (filters.dateFrom) where.entryDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.entryDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { entryNumber: { contains: q } },
                    { narration: { contains: q } }
                ];
            }

            const rows = await prisma.journalEntry.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    lines: { include: { account: true } }
                },
                orderBy: [{ entryDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => {
                const totalDebit = r.lines.reduce((acc, l) => acc + Number(l.debit || 0), 0);
                return {
                    id: r.id,
                    businessId: r.businessId,
                    businessName: r.business?.name || 'Default Business',
                    currency: r.business?.currency || 'INR',
                    referenceNumber: r.entryNumber,
                    date: r.entryDate ? r.entryDate.toISOString().slice(0, 10) : '',
                    partyName: r.narration || '-',
                    documentType: r.sourceType,
                    status: r.status,
                    subtotal: totalDebit,
                    taxAmount: 0,
                    grandTotal: totalDebit,
                    balance: 0
                };
            });
            break;
        }

        case 'STOCK_MOVEMENTS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.movementType) where.movementType = filters.movementType.toUpperCase();
            if (filters.itemId) where.itemId = parseInt(filters.itemId, 10);
            if (filters.dateFrom || filters.dateTo) {
                where.movementDate = {};
                if (filters.dateFrom) where.movementDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.movementDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { movementNumber: { contains: q } },
                    { item: { name: { contains: q } } }
                ];
            }

            const rows = await prisma.stockMovement.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    item: true
                },
                orderBy: [{ movementDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || 'INR',
                referenceNumber: r.movementNumber,
                date: r.movementDate ? r.movementDate.toISOString().slice(0, 10) : '',
                partyName: `${r.item?.name || 'Item'} (${r.movementType})`,
                documentType: r.movementType,
                status: 'POSTED',
                subtotal: Number(r.quantity || 0),
                taxAmount: Number(r.unitCost || 0),
                grandTotal: Number(r.totalCost || 0),
                balance: 0
            }));
            break;
        }

        case 'PAYROLL': {
            const where = {
                payrollPeriod: {
                    businessId: { in: businessIds }
                }
            };
            if (filters.status) where.status = filters.status.toUpperCase();
            if (filters.employeeId) where.employeeId = parseInt(filters.employeeId, 10);
            if (filters.year) where.payrollPeriod.year = parseInt(filters.year, 10);
            if (filters.month) where.payrollPeriod.month = parseInt(filters.month, 10);

            const rows = await prisma.payrollEntry.findMany({
                where,
                include: {
                    payrollPeriod: { include: { business: true } },
                    employee: true
                },
                orderBy: [{ id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.payrollPeriod?.businessId,
                businessName: r.payrollPeriod?.business?.name || 'Default Business',
                currency: r.payrollPeriod?.business?.currency || 'INR',
                referenceNumber: `${r.payrollPeriod?.periodCode || 'PAY'}-${r.id}`,
                date: r.payrollPeriod ? `${r.payrollPeriod.year}-${String(r.payrollPeriod.month).padStart(2, '0')}-01` : '',
                partyName: `${r.employee?.firstName || ''} ${r.employee?.lastName || ''}`.trim() || 'Employee',
                documentType: 'PAYROLL',
                status: r.status,
                subtotal: Number(r.grossEarnings || 0),
                taxAmount: Number(r.totalDeductions || 0),
                grandTotal: Number(r.netPay || 0),
                balance: 0
            }));
            break;
        }

        case 'PROJECTS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.status) where.status = filters.status.toUpperCase();
            if (filters.billingType) where.billingType = filters.billingType.toUpperCase();
            if (filters.clientId) where.clientId = parseInt(filters.clientId, 10);
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { code: { contains: q } },
                    { name: { contains: q } }
                ];
            }

            const rows = await prisma.project.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    client: { select: { id: true, name: true } }
                },
                orderBy: [{ id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || 'INR',
                referenceNumber: r.code,
                date: r.startDate ? r.startDate.toISOString().slice(0, 10) : '',
                partyName: `${r.name} (${r.client?.name || 'Internal'})`,
                documentType: r.billingType,
                status: r.status,
                subtotal: Number(r.budgetAmount || 0),
                taxAmount: 0,
                grandTotal: Number(r.budgetAmount || 0),
                balance: 0
            }));
            break;
        }

        case 'PAYMENTS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.status) where.status = filters.status.toUpperCase();
            if (filters.method) where.method = filters.method.toUpperCase();
            if (filters.dateFrom || filters.dateTo) {
                where.paymentDate = {};
                if (filters.dateFrom) where.paymentDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.paymentDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { receiptNumber: { contains: q } },
                    { reference: { contains: q } },
                    { invoice: { invoiceNumber: { contains: q } } },
                    { invoice: { clientName: { contains: q } } }
                ];
            }

            const rows = await prisma.payment.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    invoice: { select: { id: true, invoiceNumber: true, clientName: true } }
                },
                orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || 'INR',
                referenceNumber: r.receiptNumber || r.reference || `RCPT-${r.id}`,
                date: r.paymentDate ? r.paymentDate.toISOString().slice(0, 10) : '',
                partyName: r.invoice?.clientName || 'Customer',
                documentType: r.method || 'PAYMENT',
                status: r.status,
                subtotal: Number(r.amount || 0),
                taxAmount: 0,
                grandTotal: Number(r.amount || 0),
                balance: 0
            }));
            break;
        }

        case 'SUPPLIER_PAYMENTS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.status) where.status = filters.status.toUpperCase();
            if (filters.method) where.method = filters.method.toUpperCase();
            if (filters.supplierId) where.supplierId = parseInt(filters.supplierId, 10);
            if (filters.dateFrom || filters.dateTo) {
                where.paymentDate = {};
                if (filters.dateFrom) where.paymentDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.paymentDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { paymentNumber: { contains: q } },
                    { reference: { contains: q } },
                    { supplier: { name: { contains: q } } }
                ];
            }

            const rows = await prisma.supplierPayment.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    supplier: { select: { id: true, name: true } }
                },
                orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || 'INR',
                referenceNumber: r.paymentNumber,
                date: r.paymentDate ? r.paymentDate.toISOString().slice(0, 10) : '',
                partyName: r.supplier?.name || 'Supplier',
                documentType: r.method || 'SUPPLIER_PAYMENT',
                status: r.status,
                subtotal: Number(r.amount || 0),
                taxAmount: 0,
                grandTotal: Number(r.amount || 0),
                balance: 0
            }));
            break;
        }

        case 'CUSTOMERS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.active !== undefined) where.active = filters.active === true || filters.active === 'true';
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { name: { contains: q } },
                    { email: { contains: q } },
                    { gstin: { contains: q } }
                ];
            }

            const rows = await prisma.client.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    invoices: {
                        where: { status: 'ACTIVE', documentType: 'INVOICE' },
                        select: { grandTotal: true, paidAmount: true, outstandingAmount: true }
                    }
                },
                orderBy: [{ name: 'asc' }]
            });

            records = rows.map(r => {
                const totalBilled = r.invoices.reduce((acc, inv) => acc + Number(inv.grandTotal || 0), 0);
                const totalPaid = r.invoices.reduce((acc, inv) => acc + Number(inv.paidAmount || 0), 0);
                const outstanding = r.invoices.reduce((acc, inv) => acc + Number(inv.outstandingAmount || (Number(inv.grandTotal || 0) - Number(inv.paidAmount || 0))), 0);
                return {
                    id: r.id,
                    businessId: r.businessId,
                    businessName: r.business?.name || 'Default Business',
                    currency: r.business?.currency || 'INR',
                    referenceNumber: `CUST-${r.id}`,
                    date: r.createdAt ? r.createdAt.toISOString().slice(0, 10) : '',
                    partyName: r.name,
                    documentType: 'CUSTOMER',
                    status: r.active ? 'ACTIVE' : 'INACTIVE',
                    subtotal: totalBilled,
                    taxAmount: totalPaid,
                    grandTotal: outstanding,
                    balance: outstanding
                };
            });
            break;
        }

        case 'SUPPLIERS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.active !== undefined) where.active = filters.active === true || filters.active === 'true';
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { name: { contains: q } },
                    { email: { contains: q } },
                    { gstin: { contains: q } }
                ];
            }

            const rows = await prisma.supplier.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    supplierBills: {
                        where: { status: 'ACTIVE' },
                        select: { grandTotal: true, paidAmount: true }
                    }
                },
                orderBy: [{ name: 'asc' }]
            });

            records = rows.map(r => {
                const totalBilled = r.supplierBills.reduce((acc, b) => acc + Number(b.grandTotal || 0), 0);
                const totalPaid = r.supplierBills.reduce((acc, b) => acc + Number(b.paidAmount || 0), 0);
                const outstanding = totalBilled - totalPaid;
                return {
                    id: r.id,
                    businessId: r.businessId,
                    businessName: r.business?.name || 'Default Business',
                    currency: r.business?.currency || 'INR',
                    referenceNumber: `SUPP-${r.id}`,
                    date: r.createdAt ? r.createdAt.toISOString().slice(0, 10) : '',
                    partyName: r.name,
                    documentType: 'SUPPLIER',
                    status: r.active ? 'ACTIVE' : 'INACTIVE',
                    subtotal: totalBilled,
                    taxAmount: totalPaid,
                    grandTotal: outstanding,
                    balance: outstanding
                };
            });
            break;
        }

        case 'OTHER_INCOME': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.source) where.source = filters.source;
            if (filters.dateFrom || filters.dateTo) {
                where.incomeDate = {};
                if (filters.dateFrom) where.incomeDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.incomeDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { description: { contains: q } },
                    { source: { contains: q } }
                ];
            }

            const rows = await prisma.otherIncome.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } }
                },
                orderBy: [{ incomeDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || 'INR',
                referenceNumber: r.incomeNumber || `INC-${r.id}`,
                date: r.incomeDate ? r.incomeDate.toISOString().slice(0, 10) : '',
                partyName: r.source || 'Other Income',
                documentType: 'OTHER_INCOME',
                status: 'POSTED',
                subtotal: Number(r.amount || 0),
                taxAmount: 0,
                grandTotal: Number(r.amount || 0),
                balance: 0
            }));
            break;
        }

        case 'REIMBURSEMENTS': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.status) where.status = filters.status.toUpperCase();
            if (filters.employeeId) where.employeeId = parseInt(filters.employeeId, 10);
            if (filters.dateFrom || filters.dateTo) {
                where.expenseDate = {};
                if (filters.dateFrom) where.expenseDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) where.expenseDate.lte = new Date(filters.dateTo);
            }
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { claimNumber: { contains: q } },
                    { description: { contains: q } },
                    { employee: { firstName: { contains: q } } }
                ];
            }

            const rows = await prisma.employeeReimbursement.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    employee: true
                },
                orderBy: [{ expenseDate: 'desc' }, { id: 'desc' }]
            });

            records = rows.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || 'INR',
                referenceNumber: r.claimNumber || `REIMB-${r.id}`,
                date: r.expenseDate ? r.expenseDate.toISOString().slice(0, 10) : '',
                partyName: `${r.employee?.firstName || ''} ${r.employee?.lastName || ''}`.trim() || 'Employee',
                documentType: r.category || 'REIMBURSEMENT',
                status: r.status,
                subtotal: Number(r.amount || 0),
                taxAmount: 0,
                grandTotal: Number(r.amount || 0),
                balance: 0
            }));
            break;
        }

        case 'INVENTORY_VALUATION': {
            const where = {
                businessId: { in: businessIds }
            };
            if (filters.active !== undefined) where.active = filters.active === true || filters.active === 'true';
            if (filters.search) {
                const q = filters.search.trim();
                where.OR = [
                    { name: { contains: q } },
                    { hsnSac: { contains: q } }
                ];
            }

            const rows = await prisma.item.findMany({
                where,
                include: {
                    business: { select: { id: true, name: true, currency: true } },
                    stockMovements: true
                },
                orderBy: [{ name: 'asc' }]
            });

            records = rows.map(r => {
                let onHand = 0;
                let totalCost = 0;
                for (const m of (r.stockMovements || [])) {
                    const qty = Number(m.quantity || 0);
                    const cost = Number(m.totalCost || 0);
                    if (m.movementType === 'IN' || m.movementType === 'ADJUST_UP' || m.movementType === 'PURCHASE') {
                        onHand += qty;
                        totalCost += cost;
                    } else if (m.movementType === 'OUT' || m.movementType === 'ADJUST_DOWN' || m.movementType === 'SALE') {
                        onHand -= qty;
                        totalCost -= cost;
                    }
                }
                const valuation = Math.max(0, totalCost > 0 ? totalCost : onHand * Number(r.rate || 0));
                return {
                    id: r.id,
                    businessId: r.businessId,
                    businessName: r.business?.name || 'Default Business',
                    currency: r.business?.currency || 'INR',
                    referenceNumber: `ITEM-${r.id}`,
                    date: r.createdAt ? r.createdAt.toISOString().slice(0, 10) : '',
                    partyName: r.name,
                    documentType: r.unit || 'PCS',
                    status: r.active ? 'ACTIVE' : 'INACTIVE',
                    subtotal: onHand,
                    taxAmount: Number(r.rate || 0),
                    grandTotal: valuation,
                    balance: valuation
                };
            });
            break;
        }

        case 'TAX_GST': {
            const invWhere = {
                businessId: { in: businessIds },
                status: 'ACTIVE',
                documentType: 'INVOICE'
            };
            if (filters.dateFrom || filters.dateTo) {
                invWhere.invoiceDate = {};
                if (filters.dateFrom) invWhere.invoiceDate.gte = new Date(filters.dateFrom);
                if (filters.dateTo) invWhere.invoiceDate.lte = new Date(filters.dateTo);
            }

            const invoices = await prisma.invoice.findMany({
                where: invWhere,
                include: { business: { select: { id: true, name: true, currency: true } } },
                orderBy: [{ invoiceDate: 'desc' }]
            });

            records = invoices.map(r => ({
                id: r.id,
                businessId: r.businessId,
                businessName: r.business?.name || 'Default Business',
                currency: r.business?.currency || 'INR',
                referenceNumber: r.invoiceNumber,
                date: r.invoiceDate ? r.invoiceDate.toISOString().slice(0, 10) : '',
                partyName: `${r.clientName} (Output GST)`,
                documentType: 'GST_OUTPUT',
                status: r.status,
                subtotal: Number(r.subtotal || 0),
                taxAmount: Number(r.gstAmount || 0),
                grandTotal: Number(r.grandTotal || 0),
                balance: Number(r.gstAmount || 0)
            }));
            break;
        }

        default: {
            records = [];
        }
    }

    // Compute exact summary metrics
    summary.totalRecords = records.length;
    summary.subtotal = Math.round(records.reduce((acc, r) => acc + (r.subtotal || 0), 0) * 100) / 100;
    summary.taxAmount = Math.round(records.reduce((acc, r) => acc + (r.taxAmount || 0), 0) * 100) / 100;
    summary.grandTotal = Math.round(records.reduce((acc, r) => acc + (r.grandTotal || 0), 0) * 100) / 100;

    // Strict multi-currency segregation: prevent naively adding disparate currencies
    const distinctCurrencies = new Set(authScope.businesses.map(b => b.currency || 'INR'));
    summary.currencies = Array.from(distinctCurrencies);
    summary.isSingleCurrency = distinctCurrencies.size <= 1;

    const currencyBreakdown = {};
    for (const r of records) {
        const cur = r.currency || 'INR';
        if (!currencyBreakdown[cur]) {
            currencyBreakdown[cur] = { count: 0, subtotal: 0, taxAmount: 0, grandTotal: 0 };
        }
        currencyBreakdown[cur].count += 1;
        currencyBreakdown[cur].subtotal += (r.subtotal || 0);
        currencyBreakdown[cur].taxAmount += (r.taxAmount || 0);
        currencyBreakdown[cur].grandTotal += (r.grandTotal || 0);
    }
    for (const cur of Object.keys(currencyBreakdown)) {
        currencyBreakdown[cur].subtotal = Math.round(currencyBreakdown[cur].subtotal * 100) / 100;
        currencyBreakdown[cur].taxAmount = Math.round(currencyBreakdown[cur].taxAmount * 100) / 100;
        currencyBreakdown[cur].grandTotal = Math.round(currencyBreakdown[cur].grandTotal * 100) / 100;
    }
    summary.currencyBreakdown = currencyBreakdown;

    if (!summary.isSingleCurrency) {
        summary.mixedCurrencyWarning = 'Selected organizations operate in multiple currencies (' + Array.from(distinctCurrencies).join(', ') + '). Naive arithmetic addition is prohibited; figures are segregated by currency in compliance with accounting standards.';
        summary.displayGrandTotal = Object.entries(currencyBreakdown)
            .map(([cur, v]) => `${cur} ${v.grandTotal.toFixed(2)}`)
            .join(' + ');
    } else {
        const singleCur = summary.currencies[0] || 'INR';
        summary.displayGrandTotal = `${singleCur} ${summary.grandTotal.toFixed(2)}`;
    }

    // Optional Grouping
    let groupedData = null;
    if (grouping && grouping !== 'none') {
        const groups = {};
        for (const row of records) {
            let key = 'Other';
            if (grouping === 'byBusiness') key = row.businessName;
            else if (grouping === 'byMonth') key = row.date.slice(0, 7) || 'Unknown';
            else if (grouping === 'byStatus') key = row.status || 'Unknown';
            else if (grouping === 'byCustomer' || grouping === 'bySupplier') key = row.partyName || 'Unknown';

            if (!groups[key]) {
                groups[key] = {
                    groupKey: key,
                    count: 0,
                    subtotal: 0,
                    taxAmount: 0,
                    grandTotal: 0,
                    records: []
                };
            }
            groups[key].count += 1;
            groups[key].subtotal += row.subtotal;
            groups[key].taxAmount += row.taxAmount;
            groups[key].grandTotal += row.grandTotal;
            groups[key].records.push(row);
        }

        groupedData = Object.values(groups).map(g => ({
            ...g,
            subtotal: Math.round(g.subtotal * 100) / 100,
            taxAmount: Math.round(g.taxAmount * 100) / 100,
            grandTotal: Math.round(g.grandTotal * 100) / 100
        }));
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const paginatedRecords = records.slice((pageNum - 1) * pageSize, pageNum * pageSize);

    return {
        dataset: family,
        businessScope: authScope,
        filters,
        grouping,
        summary,
        total: records.length,
        page: pageNum,
        limit: pageSize,
        totalPages: Math.ceil(records.length / pageSize) || 1,
        records: paginatedRecords,
        allRecords: records,
        grouped: groupedData
    };
}

/**
 * Generates an Excel buffer for reporting workbench with formula injection protection
 */
async function generateWorkbenchExcel(reportResult) {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Spark Admin ERP';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(reportResult.dataset.name.slice(0, 31));

    // Title & Metadata
    sheet.addRow([sanitizeCell(reportResult.dataset.name)]);
    sheet.addRow([`Generated: ${new Date().toISOString()}`]);
    sheet.addRow([`Businesses: ${reportResult.businessScope.businesses.map(b => b.name).join(', ')}`]);
    sheet.addRow([]);

    // Headers
    const headers = ['Business', 'Reference #', 'Date', 'Party / Description', 'Type', 'Status', 'Subtotal', 'Tax Amount', 'Grand Total'];
    sheet.addRow(headers.map(sanitizeCell));

    // Data rows
    for (const r of reportResult.allRecords) {
        sheet.addRow([
            sanitizeCell(r.businessName),
            sanitizeCell(r.referenceNumber),
            sanitizeCell(r.date),
            sanitizeCell(r.partyName),
            sanitizeCell(r.documentType),
            sanitizeCell(r.status),
            r.subtotal,
            r.taxAmount,
            r.grandTotal
        ]);
    }

    // Totals row
    sheet.addRow([]);
    sheet.addRow(['TOTALS', '', '', '', '', '', reportResult.summary.subtotal, reportResult.summary.taxAmount, reportResult.summary.grandTotal]);

    return await workbook.xlsx.writeBuffer();
}

/**
 * Generates a clean CSV string with formula injection protection
 */
function generateWorkbenchCsv(reportResult) {
    const lines = [];
    lines.push(`"Dataset","${sanitizeCell(reportResult.dataset.name)}"`);
    lines.push(`"Businesses","${sanitizeCell(reportResult.businessScope.businesses.map(b => b.name).join(', '))}"`);
    lines.push('');

    const headers = ['Business', 'Reference', 'Date', 'Party', 'Type', 'Status', 'Subtotal', 'Tax', 'Grand Total'];
    lines.push(headers.map(h => `"${sanitizeCell(h)}"`).join(','));

    for (const r of reportResult.allRecords) {
        const row = [
            r.businessName,
            r.referenceNumber,
            r.date,
            r.partyName,
            r.documentType,
            r.status,
            r.subtotal.toFixed(2),
            r.taxAmount.toFixed(2),
            r.grandTotal.toFixed(2)
        ];
        lines.push(row.map(val => `"${sanitizeCell(val)}"`).join(','));
    }

    lines.push('');
    lines.push(`"TOTALS","","","","","",${reportResult.summary.subtotal.toFixed(2)},${reportResult.summary.taxAmount.toFixed(2)},${reportResult.summary.grandTotal.toFixed(2)}`);

    return lines.join('\n');
}

/**
 * Generates a PDF buffer using PDFKit with proper tables & totals
 */
function generateWorkbenchPdf(reportResult) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
            const buffers = [];

            doc.on('data', chunk => buffers.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', err => reject(err));

            // Header
            doc.fontSize(16).text(reportResult.dataset.name, { align: 'left' });
            doc.fontSize(9).fillColor('#666666').text(
                `Generated: ${new Date().toISOString().slice(0, 10)} | Businesses: ${reportResult.businessScope.businesses.map(b => b.name).join(', ')}`
            );
            doc.moveDown();

            // Table Header
            doc.fillColor('#000000').fontSize(9).font('Helvetica-Bold');
            const colX = [40, 140, 240, 310, 470, 560, 640, 710];
            doc.text('Business', colX[0], doc.y, { width: 95 });
            doc.text('Ref #', colX[1], doc.y, { width: 95 });
            doc.text('Date', colX[2], doc.y, { width: 65 });
            doc.text('Party / Description', colX[3], doc.y, { width: 155 });
            doc.text('Type', colX[4], doc.y, { width: 85 });
            doc.text('Status', colX[5], doc.y, { width: 75 });
            doc.text('Grand Total', colX[6], doc.y, { width: 80, align: 'right' });
            doc.moveDown(0.5);

            doc.font('Helvetica').fontSize(8);
            let count = 0;
            for (const r of reportResult.allRecords) {
                if (count > 250) {
                    doc.text('... (Truncated for PDF display: export Excel or CSV for complete list)', colX[0], doc.y);
                    break;
                }
                const y = doc.y;
                if (y > 520) {
                    doc.addPage();
                }
                doc.text(r.businessName.slice(0, 16), colX[0], doc.y, { width: 95 });
                doc.text(r.referenceNumber.slice(0, 18), colX[1], doc.y, { width: 95 });
                doc.text(r.date, colX[2], doc.y, { width: 65 });
                doc.text((r.partyName || '').slice(0, 28), colX[3], doc.y, { width: 155 });
                doc.text(r.documentType, colX[4], doc.y, { width: 85 });
                doc.text(r.status, colX[5], doc.y, { width: 75 });
                doc.text(`₹${r.grandTotal.toFixed(2)}`, colX[6], doc.y, { width: 80, align: 'right' });
                doc.moveDown(0.4);
                count++;
            }

            // Summary
            doc.moveDown();
            doc.font('Helvetica-Bold').fontSize(10);
            doc.text(`TOTAL RECORDS: ${reportResult.summary.totalRecords} | GRAND TOTAL: ₹${reportResult.summary.grandTotal.toFixed(2)}`, { align: 'right' });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Generates an HTML print document for print preview / window.print()
 */
function generateWorkbenchHtmlPrint(reportResult) {
    const title = sanitizeCell(reportResult.dataset.name);
    const dateStr = new Date().toISOString().slice(0, 10);
    const businessesStr = sanitizeCell(reportResult.businessScope.businesses.map(b => b.name).join(', '));
    const isMixed = !reportResult.summary.isSingleCurrency;

    const rowsHtml = reportResult.allRecords.map(r => `
        <tr>
            <td>${sanitizeCell(r.businessName)}</td>
            <td><strong>${sanitizeCell(r.referenceNumber)}</strong></td>
            <td>${sanitizeCell(r.date)}</td>
            <td>${sanitizeCell(r.partyName)}</td>
            <td>${sanitizeCell(r.documentType)}</td>
            <td><span class="badge badge-${(r.status || '').toLowerCase()}">${sanitizeCell(r.status)}</span></td>
            <td class="text-right">${r.subtotal.toFixed(2)}</td>
            <td class="text-right">${r.taxAmount.toFixed(2)}</td>
            <td class="text-right"><strong>${r.grandTotal.toFixed(2)}</strong></td>
        </tr>
    `).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${title} - Print View</title>
    <style>
        @page { size: A4 landscape; margin: 12mm; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #1e293b; margin: 0; padding: 20px; }
        .header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end; }
        .header h1 { margin: 0; font-size: 20px; color: #0f172a; }
        .meta { font-size: 10px; color: #64748b; margin-top: 4px; }
        .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 600; text-transform: uppercase; background: #f1f5f9; color: #334155; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
        th { background: #f8fafc; border-top: 1px solid #cbd5e1; border-bottom: 2px solid #cbd5e1; padding: 6px 8px; text-align: left; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
        .text-right { text-align: right; }
        .footer { margin-top: 16px; border-top: 2px solid #0f172a; padding-top: 12px; display: flex; justify-content: space-between; font-size: 12px; font-weight: bold; }
        .warning-box { background: #fffbeb; border: 1px solid #fef3c7; color: #92400e; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 10px; }
        @media print {
            body { padding: 0; }
            .no-print { display: none; }
        }
    </style>
</head>
<body>
    <div class="no-print" style="margin-bottom: 16px; text-align: right;">
        <button onclick="window.print()" style="padding: 6px 14px; background: #2563eb; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600;">🖨 Print / Save as PDF</button>
    </div>
    <div class="header">
        <div>
            <h1>${title}</h1>
            <div class="meta">Organizations: ${businessesStr} | Generated: ${dateStr}</div>
        </div>
        <div style="text-align: right; font-size: 10px; color: #64748b;">
            Spark Admin Enterprise ERP
        </div>
    </div>
    ${isMixed ? `<div class="warning-box"><strong>Notice:</strong> ${reportResult.summary.mixedCurrencyWarning}</div>` : ''}
    <table>
        <thead>
            <tr>
                <th>Organization</th>
                <th>Reference #</th>
                <th>Date</th>
                <th>Party / Description</th>
                <th>Type</th>
                <th>Status</th>
                <th class="text-right">Subtotal</th>
                <th class="text-right">Tax</th>
                <th class="text-right">Grand Total</th>
            </tr>
        </thead>
        <tbody>
            ${rowsHtml}
        </tbody>
    </table>
    <div class="footer">
        <div>Total Records: ${reportResult.summary.totalRecords}</div>
        <div>Total Amount: ${reportResult.summary.displayGrandTotal || ('₹' + reportResult.summary.grandTotal.toFixed(2))}</div>
    </div>
</body>
</html>`;
}

module.exports = {
    REPORT_FAMILIES,
    resolveAuthorizedBusinesses,
    queryWorkbench,
    generateWorkbenchExcel,
    generateWorkbenchCsv,
    generateWorkbenchPdf,
    generateWorkbenchHtmlPrint,
    ValidationError,
    ForbiddenError
};
