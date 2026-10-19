const prisma = require('../config/prisma');
const purchaseOrderService = require('../services/purchaseOrder.service');
const supplierBillService = require('../services/supplierBill.service');
const supplierService = require('../services/supplier.service');
const goodsReceiptService = require('../services/goodsReceipt.service');
const expenseService = require('../services/expense.service');
const otherIncomeService = require('../services/otherIncome.service');
const unitService = require('../services/unit.service');
const businessProfileService = require('../services/businessProfile.service');

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
        error: (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') ? err.message : 'Internal server error.'
    });
}

// ----------------- Purchase Orders -----------------

async function renderPurchaseOrders(req, res, next) {
    try {
        const { search, status, page, limit } = req.query;
        const result = await purchaseOrderService.listPurchaseOrders({
            businessId: req.businessId || req.session?.activeBusinessId,
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
        const businessId = req.businessId || req.session?.activeBusinessId;
        const [suppliers, units, projects, profile] = await Promise.all([
            supplierService.searchSuppliers('', 100, businessId, { activeOnly: true }),
            unitService.getActiveUnits(),
            businessId ? prisma.project.findMany({
                where: { businessId, status: 'ACTIVE' },
                select: { id: true, code: true, name: true, clientId: true },
                orderBy: { name: 'asc' }
            }) : [],
            businessProfileService.getProfile(businessId)
        ]);

        const requestedProjectId = req.query.projectId ? parseInt(req.query.projectId, 10) : null;
        const preselectedProjectId = requestedProjectId && projects.some(project => project.id === requestedProjectId) ? requestedProjectId : null;

        res.render('purchases/po-editor', {
            pageTitle: 'New Purchase Order',
            pageSubtitle: 'Draft and issue a procurement order to a supplier.',
            suppliers,
            units,
            projects,
            businessStateCode: profile?.stateCode || profile?.gstin?.slice(0, 2) || '',
            preselectedProjectId,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function createPurchaseOrder(req, res, next) {
    try {
        const userId = req.user?.id || req.session?.user?.id || req.session?.userId || 1;
        const businessId = req.businessId || req.session?.activeBusinessId;
        const po = await purchaseOrderService.createPurchaseOrder({
            ...req.body,
            businessId
        }, userId);
        return res.status(201).json({ success: true, purchaseOrder: po });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function getPurchaseOrder(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const po = await purchaseOrderService.getPurchaseOrderById(req.params.id, businessId);
        return res.status(200).json({ success: true, purchaseOrder: po });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function updatePurchaseOrder(req, res, next) {
    try {
        const userId = req.user?.id || req.session?.user?.id || req.session?.userId || 1;
        const businessId = req.businessId || req.session?.activeBusinessId;
        const po = await purchaseOrderService.updatePurchaseOrder(req.params.id, req.body, userId, businessId);
        return res.status(200).json({ success: true, purchaseOrder: po });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function renderPurchaseOrderDetail(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const [po, suppliers, units, projects, profile] = await Promise.all([
            purchaseOrderService.getPurchaseOrderById(req.params.id, businessId),
            // Existing documents retain their supplier snapshot even when the master is inactive.
            supplierService.searchSuppliers('', 100, businessId),
            unitService.getActiveUnits(),
            businessId ? prisma.project.findMany({
                where: { businessId, status: 'ACTIVE' },
                select: { id: true, code: true, name: true, clientId: true },
                orderBy: { name: 'asc' }
            }) : [],
            businessProfileService.getProfile(businessId)
        ]);

        res.render('purchases/po-editor', {
            pageTitle: `Purchase Order ${po.orderNumber}`,
            pageSubtitle: `Review and manage procurement order #${po.orderNumber}`,
            order: po,
            suppliers,
            units,
            projects,
            businessStateCode: profile?.stateCode || profile?.gstin?.slice(0, 2) || '',
            preselectedProjectId: po.projectId,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function voidPurchaseOrder(req, res, next) {
    try {
        const userId = req.user?.id || req.session?.user?.id || req.session?.userId || 1;
        const businessId = req.businessId || req.session?.activeBusinessId;
        const po = await purchaseOrderService.voidPurchaseOrder(req.params.id, userId, req.body.reason, businessId);
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
        const businessId = req.businessId || req.session?.activeBusinessId;
        const suppliers = await supplierService.searchSuppliers('', 100, businessId, { activeOnly: true });
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
        const userId = req.session ? (req.session.userId || req.session.user?.id) : null;
        const bill = await supplierBillService.createSupplierBill({
            ...req.body,
            businessId: req.body.businessId || req.businessId || req.session?.activeBusinessId
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
        const businessId = req.businessId || req.session?.activeBusinessId;
        const { search, category, projectId, page, limit } = req.query;
        const [result, projects] = await Promise.all([
            expenseService.listExpenses({
                businessId,
                projectId: projectId ? parseInt(projectId, 10) : undefined,
                search,
                category,
                page,
                limit: limit || 20
            }),
            businessId ? prisma.project.findMany({
                where: { businessId, status: 'ACTIVE' },
                select: { id: true, code: true, name: true },
                orderBy: { name: 'asc' }
            }) : []
        ]);

        res.render('financials/expenses', {
            pageTitle: 'Operating Expenses',
            pageSubtitle: 'Track day-to-day administrative and operating expenses.',
            records: result.records,
            projects,
            selectedProjectId: projectId || '',
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
        const userId = req.session?.user?.id || req.session?.userId || req.user?.id || null;
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
        const userId = req.session?.user?.id || req.session?.userId || req.user?.id || null;
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

// ----------------- Goods Receipts (GRN) -----------------

async function renderReceivePurchaseOrder(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const po = await purchaseOrderService.getPurchaseOrderById(req.params.id, businessId);

        res.render('purchases/grn-editor', {
            pageTitle: `Receive Goods — PO ${po.orderNumber}`,
            pageSubtitle: `Record incoming store delivery against Purchase Order #${po.orderNumber}`,
            order: po,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function createGoodsReceipt(req, res, next) {
    try {
        const userId = req.user?.id || req.session?.user?.id || req.session?.userId || 1;
        const businessId = req.businessId || req.session?.activeBusinessId || req.body.businessId;
        const poId = req.params.id ? parseInt(req.params.id, 10) : (req.body.purchaseOrderId ? parseInt(req.body.purchaseOrderId, 10) : null);

        let items = req.body.items;
        if (typeof items === 'string') {
            try { items = JSON.parse(items); } catch (_) {}
        }

        const grn = await goodsReceiptService.createGoodsReceipt({
            ...req.body,
            purchaseOrderId: poId,
            items,
            businessId
        }, userId, businessId);

        // Check if browser form post vs AJAX JSON
        if (req.headers.accept && req.headers.accept.includes('text/html') && !req.xhr && !req.headers['x-requested-with']) {
            return res.redirect(`/purchases/orders/${poId || grn.purchaseOrderId || ''}`);
        }

        return res.status(201).json({ success: true, goodsReceipt: grn });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function renderGoodsReceipts(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const { search, status, page, limit } = req.query;
        const result = await goodsReceiptService.listGoodsReceipts({
            businessId,
            search,
            status,
            page,
            limit: limit || 20
        });

        res.render('purchases/receipts', {
            pageTitle: 'Goods Receipts (GRN)',
            pageSubtitle: 'Manage store deliveries, inspection status, and warehouse receiving.',
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

async function renderGoodsReceiptDetail(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const grn = await goodsReceiptService.getGoodsReceiptById(req.params.id, businessId);

        res.render('purchases/grn-detail', {
            pageTitle: `Goods Receipt ${grn.receiptNumber}`,
            pageSubtitle: `Delivery details, stock movements, and inspection audit.`,
            grn,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

async function getGoodsReceipt(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const grn = await goodsReceiptService.getGoodsReceiptById(req.params.id, businessId);
        return res.status(200).json({ success: true, goodsReceipt: grn });
    } catch (err) {
        return handleError(err, res, next);
    }
}

async function listGoodsReceiptsApi(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const result = await goodsReceiptService.listGoodsReceipts({
            ...req.query,
            businessId
        });
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return handleError(err, res, next);
    }
}

module.exports = {
    renderPurchaseOrders,
    renderNewPurchaseOrder,
    renderPurchaseOrderDetail,
    createPurchaseOrder,
    getPurchaseOrder,
    updatePurchaseOrder,
    voidPurchaseOrder,
    renderReceivePurchaseOrder,
    createGoodsReceipt,
    renderGoodsReceipts,
    renderGoodsReceiptDetail,
    getGoodsReceipt,
    listGoodsReceiptsApi,
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
