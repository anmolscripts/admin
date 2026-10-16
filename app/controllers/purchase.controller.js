'use strict';

const purchaseOrderService = require('../services/purchaseOrder.service');
const supplierBillService = require('../services/supplierBill.service');
const supplierService = require('../services/supplier.service');
const expenseService = require('../services/expense.service');
const otherIncomeService = require('../services/otherIncome.service');
const unitService = require('../services/unit.service');

function handleError(err, res, next) {
    if (err.statusCode === 400 || err.name === 'ValidationError') {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err.statusCode === 404 || err.name === 'NotFoundError') {
        return res.status(404).json({ success: false, error: err.message });
    }
    if (err.statusCode === 409 || err.name === 'ConflictError') {
        return res.status(409).json({ success: false, error: err.message });
    }
    console.error('[PURCHASE CONTROLLER ERROR]:', err);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
    });
}

// ----------------- Purchase Orders -----------------

async function renderPurchaseOrders(req, res, next) {
    try {
        const { search, status, page, limit } = req.query;
        const result = await purchaseOrderService.listPurchaseOrders({
            search,
            status,
            page,
            limit: limit || 20
        });

        res.render('purchases/orders', {
            pageTitle: 'Purchase Orders',
            pageSubtitle: 'Manage supplier purchase commitments and procurement workflows.',
            records: result.records,
            pagination: {
                total: result.total,
                page: result.page,
                limit: result.limit
            },
            search: search || '',
            status: status || '',
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function renderNewPurchaseOrder(req, res, next) {
    try {
        const suppliers = await supplierService.searchSuppliers('', 100);
        const units = await unitService.getActiveUnits();

        res.render('purchases/po-editor', {
            pageTitle: 'New Purchase Order',
            pageSubtitle: 'Draft and issue a procurement order to a supplier.',
            suppliers,
            units,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function createPurchaseOrder(req, res, next) {
    try {
        const userId = req.session ? req.session.userId : null;
        const po = await purchaseOrderService.createPurchaseOrder({
            ...req.body,
            businessId: req.body.businessId || req.businessId
        }, userId);
        return res.status(201).json({ success: true, purchaseOrder: po });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function getPurchaseOrder(req, res, next) {
    try {
        const po = await purchaseOrderService.getPurchaseOrderById(req.params.id);
        return res.status(200).json({ success: true, purchaseOrder: po });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function voidPurchaseOrder(req, res, next) {
    try {
        const userId = req.session ? req.session.userId : null;
        const po = await purchaseOrderService.voidPurchaseOrder(req.params.id, userId, req.body.reason);
        return res.status(200).json({ success: true, purchaseOrder: po });
    } catch (err) {
        return handleError(err, res, next);
    }
}

// ----------------- Supplier Bills -----------------

async function renderSupplierBills(req, res, next) {
    try {
        const { search, status, page, limit } = req.query;
        const result = await supplierBillService.listSupplierBills({
            search,
            status,
            page,
            limit: limit || 20
        });

        res.render('purchases/bills', {
            pageTitle: 'Supplier Bills',
            pageSubtitle: 'Manage incoming vendor bills, payables, and input tax credits.',
            records: result.records,
            pagination: {
                total: result.total,
                page: result.page,
                limit: result.limit
            },
            search: search || '',
            status: status || '',
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function renderNewSupplierBill(req, res, next) {
    try {
        const suppliers = await supplierService.searchSuppliers('', 100);
        const units = await unitService.getActiveUnits();

        res.render('purchases/bill-editor', {
            pageTitle: 'Record Supplier Bill',
            pageSubtitle: 'Enter incoming vendor invoice with GST and accounting ledger integration.',
            suppliers,
            units,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function createSupplierBill(req, res, next) {
    try {
        const userId = req.session ? req.session.userId : null;
        const bill = await supplierBillService.createSupplierBill({
            ...req.body,
            businessId: req.body.businessId || req.businessId
        }, userId);
        return res.status(201).json({ success: true, supplierBill: bill });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function getSupplierBill(req, res, next) {
    try {
        const bill = await supplierBillService.getSupplierBillById(req.params.id);
        return res.status(200).json({ success: true, supplierBill: bill });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function voidSupplierBill(req, res, next) {
    try {
        const userId = req.session ? req.session.userId : null;
        const bill = await supplierBillService.voidSupplierBill(req.params.id, userId, req.body.reason);
        return res.status(200).json({ success: true, supplierBill: bill });
    } catch (err) {
        return handleError(err, res, next);
    }
}

// ----------------- Expenses -----------------

async function renderExpenses(req, res, next) {
    try {
        const { search, category, page, limit } = req.query;
        const result = await expenseService.listExpenses({
            search,
            category,
            page,
            limit: limit || 20
        });

        res.render('financials/expenses', {
            pageTitle: 'Operating Expenses',
            pageSubtitle: 'Track day-to-day administrative and operating expenses.',
            records: result.records,
            pagination: {
                total: result.total,
                page: result.page,
                limit: result.limit
            },
            search: search || '',
            category: category || '',
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function createExpense(req, res, next) {
    try {
        const userId = req.session ? req.session.userId : null;
        const expense = await expenseService.createExpense({
            ...req.body,
            businessId: req.body.businessId || req.businessId
        }, userId);
        return res.status(201).json({ success: true, expense });
    } catch (err) {
        return handleError(err, res, next);
    }
}

// ----------------- Other Income -----------------

async function renderOtherIncome(req, res, next) {
    try {
        const { search, source, page, limit } = req.query;
        const result = await otherIncomeService.listOtherIncomes({
            search,
            source,
            page,
            limit: limit || 20
        });

        res.render('financials/other-income', {
            pageTitle: 'Other Income',
            pageSubtitle: 'Record non-invoice income, interest, and miscellaneous revenue.',
            records: result.records,
            pagination: {
                total: result.total,
                page: result.page,
                limit: result.limit
            },
            search: search || '',
            source: source || '',
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function createOtherIncome(req, res, next) {
    try {
        const userId = req.session ? req.session.userId : null;
        const income = await otherIncomeService.createOtherIncome({
            ...req.body,
            businessId: req.body.businessId || req.businessId
        }, userId);
        return res.status(201).json({ success: true, income });
    } catch (err) {
        return handleError(err, res, next);
    }
}

// ----------------- Suppliers Master -----------------

async function searchSuppliers(req, res, next) {
    try {
        const list = await supplierService.searchSuppliers(req.query.q || '', 50, req.businessId);
        return res.status(200).json({ success: true, suppliers: list });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function createSupplier(req, res, next) {
    try {
        const userId = req.session ? req.session.userId : null;
        const payload = {
            ...req.body,
            businessId: req.body.businessId || req.businessId
        };
        const s = await supplierService.createSupplier(payload, userId);
        return res.status(201).json({ success: true, supplier: s });
    } catch (err) {
        return handleError(err, res, next);
    }
}

module.exports = {
    renderPurchaseOrders,
    renderNewPurchaseOrder,
    createPurchaseOrder,
    getPurchaseOrder,
    voidPurchaseOrder,
    renderSupplierBills,
    renderNewSupplierBill,
    createSupplierBill,
    getSupplierBill,
    voidSupplierBill,
    renderExpenses,
    createExpense,
    renderOtherIncome,
    createOtherIncome,
    searchSuppliers,
    createSupplier
};
