const express = require('express');
const requireAuth = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/permission.middleware');
const invoiceController = require('../controllers/invoice.controller');
const clientController = require('../controllers/client.controller');
const itemController = require('../controllers/item.controller');
const unitController = require('../controllers/unit.controller');
const paymentController = require('../controllers/payment.controller');
const creditDebitNoteController = require('../controllers/creditDebitNote.controller');
const businessProfileController = require('../controllers/businessProfile.controller');
const dashboardController = require('../controllers/dashboard.controller');

const router = express.Router();

// Enforce authentication on all document/invoice API routes
router.use(requireAuth);

// Dashboard metrics API route
router.get('/dashboard/metrics', requirePermission('DASHBOARD', 'VIEW'), dashboardController.getMetrics);

// Item Master API routes (must precede parameterized routes)
router.get('/items/search', requirePermission('ITEMS', 'VIEW'), itemController.searchItems);
router.post('/items/import/preview', requirePermission('ITEMS', 'CREATE'), itemController.previewImport);
router.post('/items/import/commit', requirePermission('ITEMS', 'CREATE'), itemController.commitImport);
router.get('/items', requirePermission('ITEMS', 'VIEW'), itemController.listItems);
router.get('/items/:id', requirePermission('ITEMS', 'VIEW'), itemController.getItem);
router.post('/items', requirePermission('ITEMS', 'CREATE'), itemController.createItem);
router.put('/items/:id', requirePermission('ITEMS', 'EDIT'), itemController.updateItem);


// Unit Master API routes (must precede parameterized routes)
router.get('/units/active', requirePermission('UNITS', 'VIEW'), unitController.getActiveUnits);
router.get('/units', requirePermission('UNITS', 'VIEW'), unitController.listUnits);
router.get('/units/:id', requirePermission('UNITS', 'VIEW'), unitController.getUnit);
router.post('/units', requirePermission('UNITS', 'CREATE'), unitController.createUnit);
router.put('/units/:id', requirePermission('UNITS', 'EDIT'), unitController.updateUnit);
router.patch('/units/:id/status', requirePermission('UNITS', 'EDIT'), unitController.toggleUnitStatus);
router.delete('/units/:id', requirePermission('UNITS', 'DELETE'), unitController.deleteUnit);

// Dashboard KPIs (must precede /invoices/:id)
router.get('/invoices/kpis', requirePermission('DASHBOARD', 'VIEW'), invoiceController.getDashboardKPIs);

// Document CRUD, export, and history routes
router.get('/invoices', requirePermission('DOCUMENTS', 'VIEW'), invoiceController.listInvoices);
router.get('/invoices/export/excel', requirePermission('DOCUMENTS', 'EXPORT'), invoiceController.exportExcel);
router.get('/invoices/:id/pdf', requirePermission('DOCUMENTS', 'EXPORT'), invoiceController.exportPdf);
router.get('/invoices/:id/payments', requirePermission('PAYMENTS', 'VIEW'), paymentController.getInvoicePayments);
router.post('/invoices/:id/payments', requirePermission('PAYMENTS', 'CREATE'), paymentController.recordPayment);
router.get('/invoices/:id', requirePermission('DOCUMENTS', 'VIEW'), invoiceController.getInvoice);
router.post('/invoices', requirePermission('DOCUMENTS', 'CREATE'), invoiceController.createInvoice);
router.put('/invoices/:id', requirePermission('DOCUMENTS', 'EDIT'), invoiceController.updateInvoice);
router.delete('/invoices/:id', requirePermission('DOCUMENTS', 'DELETE'), invoiceController.softDeleteInvoice);
router.get('/invoices/:id/history', requirePermission('DOCUMENTS', 'VIEW'), invoiceController.getInvoiceHistory);
router.patch('/invoices/:id/status', (req, res, next) => {
    const status = typeof req.body?.status === 'string' ? req.body.status.trim().toUpperCase() : '';
    const action = status === 'DELETED' ? 'DELETE' : status === 'VOID' ? 'VOID' : 'EDIT';
    return requirePermission('DOCUMENTS', action)(req, res, next);
}, invoiceController.updateInvoiceStatus);
router.post('/invoices/:id/restore', requirePermission('DOCUMENTS', 'RESTORE'), invoiceController.restoreInvoice);
router.post('/invoices/:id/convert', requirePermission('DOCUMENTS', 'CONVERT'), invoiceController.convertQuotation);
router.post('/invoices/:id/accept', requirePermission('DOCUMENTS', 'EDIT'), invoiceController.acceptQuotation);
router.get('/invoices/:id/copy', requirePermission('DOCUMENTS', 'CREATE'), invoiceController.copyInvoice);
router.post('/invoices/:id/post', requirePermission('JOURNALS', 'CREATE'), invoiceController.postInvoiceAccounting);
router.get('/invoices/:id/accounting', requirePermission('JOURNALS', 'VIEW'), invoiceController.getInvoiceAccounting);

// Payment lifecycle and accounting routes
router.post('/payments/:id/clear', requirePermission('PAYMENTS', 'EDIT'), paymentController.clearPayment);
router.post('/payments/:id/void', requirePermission('PAYMENTS', 'VOID'), paymentController.voidPayment);
router.post('/payments/:id/post', requirePermission('JOURNALS', 'CREATE'), paymentController.postPaymentAccounting);
router.get('/payments/:id/accounting', requirePermission('JOURNALS', 'VIEW'), paymentController.getPaymentAccounting);

// Credit & Debit Note API routes
router.get('/invoices/:id/notes', requirePermission('CREDIT_NOTES', 'VIEW'), creditDebitNoteController.getInvoiceNotes);
router.post('/invoices/:id/notes', requirePermission('CREDIT_NOTES', 'CREATE'), creditDebitNoteController.createNote);
router.get('/credit-debit-notes', requirePermission('CREDIT_NOTES', 'VIEW'), creditDebitNoteController.listNotes);
router.post('/credit-debit-notes', requirePermission('CREDIT_NOTES', 'CREATE'), creditDebitNoteController.createNote);
router.get('/credit-debit-notes/:id', requirePermission('CREDIT_NOTES', 'VIEW'), creditDebitNoteController.getNote);
router.post('/credit-debit-notes/:id/void', requirePermission('CREDIT_NOTES', 'VOID'), creditDebitNoteController.voidNote);
router.get('/credit-debit-notes/:id/accounting', requirePermission('JOURNALS', 'VIEW'), creditDebitNoteController.getNoteAccounting);
router.post('/credit-debit-notes/:id/post', requirePermission('JOURNALS', 'CREATE'), creditDebitNoteController.postNoteAccounting);

// Client API routes
router.get('/clients', requirePermission('CLIENTS', 'VIEW'), clientController.listClients);
router.get('/clients/search', requirePermission('CLIENTS', 'VIEW'), clientController.searchClients);
router.get('/clients/:id', requirePermission('CLIENTS', 'VIEW'), clientController.getClient);
router.post('/clients', requirePermission('CLIENTS', 'CREATE'), clientController.createClient);
router.put('/clients/:id', requirePermission('CLIENTS', 'EDIT'), clientController.updateClient);
router.patch('/clients/:id/status', requirePermission('CLIENTS', 'EDIT'), clientController.toggleStatus);

// Business Profile & Settings API routes
router.get('/settings', requirePermission('SETTINGS', 'VIEW'), businessProfileController.getProfile);
router.put('/settings', requirePermission('SETTINGS', 'EDIT'), businessProfileController.updateProfile);

module.exports = router;
