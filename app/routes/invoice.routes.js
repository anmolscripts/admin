const express = require('express');
const requireAuth = require('../middleware/auth.middleware');
const invoiceController = require('../controllers/invoice.controller');
const clientController = require('../controllers/client.controller');
const itemController = require('../controllers/item.controller');
const unitController = require('../controllers/unit.controller');
const paymentController = require('../controllers/payment.controller');
const businessProfileController = require('../controllers/businessProfile.controller');
const dashboardController = require('../controllers/dashboard.controller');

const router = express.Router();

// Enforce authentication on all document/invoice API routes
router.use(requireAuth);

// Dashboard metrics API route
router.get('/dashboard/metrics', dashboardController.getMetrics);

// Item Master API routes (must precede parameterized routes)
router.get('/items/search', itemController.searchItems);
router.get('/items', itemController.listItems);
router.get('/items/:id', itemController.getItem);
router.post('/items', itemController.createItem);
router.put('/items/:id', itemController.updateItem);

// Unit Master API routes (must precede parameterized routes)
router.get('/units/active', unitController.getActiveUnits);
router.get('/units', unitController.listUnits);
router.get('/units/:id', unitController.getUnit);
router.post('/units', unitController.createUnit);
router.put('/units/:id', unitController.updateUnit);
router.patch('/units/:id/status', unitController.toggleUnitStatus);
router.delete('/units/:id', unitController.deleteUnit);

// Dashboard KPIs (must precede /invoices/:id)
router.get('/invoices/kpis', invoiceController.getDashboardKPIs);

// Document CRUD, export, and history routes
router.get('/invoices', invoiceController.listInvoices);
router.get('/invoices/export/excel', invoiceController.exportExcel);
router.get('/invoices/:id/pdf', invoiceController.exportPdf);
router.get('/invoices/:id/payments', paymentController.getInvoicePayments);
router.post('/invoices/:id/payments', paymentController.recordPayment);
router.get('/invoices/:id', invoiceController.getInvoice);
router.post('/invoices', invoiceController.createInvoice);
router.put('/invoices/:id', invoiceController.updateInvoice);
router.delete('/invoices/:id', invoiceController.softDeleteInvoice);
router.get('/invoices/:id/history', invoiceController.getInvoiceHistory);
router.patch('/invoices/:id/status', invoiceController.updateInvoiceStatus);
router.post('/invoices/:id/restore', invoiceController.restoreInvoice);
router.post('/invoices/:id/convert', invoiceController.convertQuotation);
router.get('/invoices/:id/copy', invoiceController.copyInvoice);

// Payment lifecycle routes
router.post('/payments/:id/void', paymentController.voidPayment);

// Client API routes
router.get('/clients', clientController.listClients);
router.get('/clients/search', clientController.searchClients);
router.get('/clients/:id', clientController.getClient);
router.post('/clients', clientController.createClient);
router.put('/clients/:id', clientController.updateClient);
router.patch('/clients/:id/status', clientController.toggleStatus);

// Business Profile & Settings API routes
router.get('/settings', businessProfileController.getProfile);
router.put('/settings', businessProfileController.updateProfile);

module.exports = router;
