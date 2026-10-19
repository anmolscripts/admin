'use strict';

const supplierPaymentService = require('../services/supplierPayment.service');
const stockMovementService = require('../services/stockMovement.service');
const payrollService = require('../services/payroll.service');
const projectService = require('../services/project.service');

// -------------------------------------------------------------
// SUPPLIER PAYMENTS
// -------------------------------------------------------------
async function listSupplierPayments(req, res, next) {
    try {
        const result = await supplierPaymentService.listSupplierPayments(req.query);
        res.json({ success: true, ...result });
    } catch (err) {
        next(err);
    }
}

async function recordSupplierPayment(req, res, next) {
    try {
        const payment = await supplierPaymentService.recordSupplierPayment({
            ...req.body,
            businessId: req.businessId || req.body.businessId
        }, req.user?.id);
        res.status(201).json({ success: true, payment });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        next(err);
    }
}

async function getSupplierPayment(req, res, next) {
    try {
        const payment = await supplierPaymentService.getSupplierPaymentById(req.params.id);
        res.json({ success: true, payment });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function voidSupplierPayment(req, res, next) {
    try {
        const payment = await supplierPaymentService.voidSupplierPayment(req.params.id, req.user?.id, req.body?.reason);
        res.json({ success: true, payment });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        next(err);
    }
}

// -----------------
// INVENTORY & STOCK MOVEMENTS
// -----------------
async function listStockMovements(req, res, next) {
    try {
        const result = await stockMovementService.listStockMovements(req.query);
        res.json({ success: true, ...result });
    } catch (err) {
        next(err);
    }
}

async function recordStockMovement(req, res, next) {
    try {
        const movement = await stockMovementService.recordStockMovement({
            ...req.body,
            businessId: req.businessId || req.body.businessId
        }, req.user?.id);
        res.status(201).json({ success: true, movement });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function getItemStockSummary(req, res, next) {
    try {
        const summary = await stockMovementService.getItemStockSummary(req.params.itemId, req.query?.asOfDate);
        res.json({ success: true, summary });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        next(err);
    }
}

async function getInventoryValuation(req, res, next) {
    try {
        const report = await stockMovementService.getInventoryValuationReport(req.query?.asOfDate);
        res.json({ success: true, ...report });
    } catch (err) {
        next(err);
    }
}

// -------------------------------------------------------------
// PAYROLL & EMPLOYEES
// -------------------------------------------------------------
async function listEmployees(req, res, next) {
    try {
        const result = await payrollService.listEmployees(req.query);
        res.json({ success: true, ...result });
    } catch (err) {
        next(err);
    }
}

async function createEmployee(req, res, next) {
    try {
        const employee = await payrollService.createEmployee(req.body, req.user?.id);
        res.status(201).json({ success: true, employee });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        next(err);
    }
}

async function getEmployee(req, res, next) {
    try {
        const employee = await payrollService.getEmployeeById(req.params.id);
        res.json({ success: true, employee });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function setSalaryStructure(req, res, next) {
    try {
        const structure = await payrollService.setSalaryStructure(req.params.id, req.body, req.user?.id);
        res.status(201).json({ success: true, structure });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function generatePayrollPeriod(req, res, next) {
    try {
        const actorUserId = req.session?.user?.id || req.user?.id;
        const targetBusinessId = req.businessId || req.session?.activeBusinessId || req.body.businessId;
        const period = await payrollService.generatePayrollPeriod({
            ...req.body,
            businessId: targetBusinessId
        }, actorUserId);
        res.status(201).json({ success: true, period });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'ForbiddenError' || err.statusCode === 403) return res.status(403).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError' || err.statusCode === 404) return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ConflictError' || err.statusCode === 409) return res.status(409).json({ success: false, error: err.message });
        if (err.name === 'BusinessError') return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        next(err);
    }
}

async function approvePayrollPeriod(req, res, next) {
    try {
        const actorUserId = req.session?.user?.id || req.user?.id;
        const period = await payrollService.approvePayrollPeriod(req.params.id, actorUserId);
        res.json({ success: true, period });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'ForbiddenError' || err.statusCode === 403) return res.status(403).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError' || err.statusCode === 404) return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ConflictError' || err.statusCode === 409) return res.status(409).json({ success: false, error: err.message });
        if (err.name === 'BusinessError') return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        next(err);
    }
}

async function postPayrollToLedger(req, res, next) {
    try {
        const actorUserId = req.session?.user?.id || req.user?.id;
        const period = await payrollService.postPayrollToLedger(req.params.id, actorUserId);
        res.json({ success: true, period });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'ForbiddenError' || err.statusCode === 403) return res.status(403).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError' || err.statusCode === 404) return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ConflictError' || err.statusCode === 409) return res.status(409).json({ success: false, error: err.message });
        if (err.name === 'BusinessError') return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        next(err);
    }
}

async function getPayslip(req, res, next) {
    try {
        const payslip = await payrollService.getPayslip(req.params.entryId);
        res.json({ success: true, payslip });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function createReimbursement(req, res, next) {
    try {
        const reimbursement = await payrollService.createReimbursement({
            ...req.body,
            businessId: req.businessId || req.body.businessId
        }, req.user?.id);
        res.status(201).json({ success: true, reimbursement });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        next(err);
    }
}

async function approveReimbursement(req, res, next) {
    try {
        const reimbursement = await payrollService.approveReimbursement(req.params.id, req.user?.id);
        res.json({ success: true, reimbursement });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        next(err);
    }
}

// -------------------------------------------------------------
// PROJECTS & LABOUR COSTING
// -------------------------------------------------------------
// PROJECTS & LABOUR COSTING (STRICT TENANT SCOPING)
// -------------------------------------------------------------
async function listProjects(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        const result = await projectService.listProjects({
            ...req.query,
            businessId
        });
        res.json({ success: true, ...result });
    } catch (err) {
        next(err);
    }
}

async function createProject(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        const project = await projectService.createProject(req.body, req.user?.id, businessId);
        res.status(201).json({ success: true, project });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function getProject(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        const project = await projectService.getProjectById(req.params.id, businessId);
        res.json({ success: true, project });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        next(err);
    }
}

async function createProjectTask(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        const task = await projectService.createProjectTask(req.params.id, req.body, req.user?.id, businessId);
        res.status(201).json({ success: true, task });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function listProjectTasks(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        const project = await projectService.getProjectById(req.params.id, businessId);
        res.json({ success: true, tasks: project.tasks });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function logTimesheet(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        const entry = await projectService.logTimesheet(req.body, req.user?.id, businessId);
        res.status(201).json({ success: true, entry });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function approveTimesheet(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        const entry = await projectService.approveTimesheetEntry(req.params.id, req.user?.id, businessId);
        res.json({ success: true, entry });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        next(err);
    }
}

async function getProjectFinancials(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        const summary = await projectService.getProjectFinancialSummary(req.params.id, businessId);
        res.json({ success: true, summary });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

module.exports = {
    // Supplier Payments
    listSupplierPayments,
    recordSupplierPayment,
    getSupplierPayment,
    voidSupplierPayment,
    // Inventory
    listStockMovements,
    recordStockMovement,
    getItemStockSummary,
    getInventoryValuation,
    // Payroll
    listEmployees,
    createEmployee,
    getEmployee,
    setSalaryStructure,
    generatePayrollPeriod,
    approvePayrollPeriod,
    postPayrollToLedger,
    getPayslip,
    createReimbursement,
    approveReimbursement,
    // Projects
    listProjects,
    createProject,
    getProject,
    createProjectTask,
    listProjectTasks,
    logTimesheet,
    approveTimesheet,
    getProjectFinancials
};
