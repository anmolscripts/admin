const express = require('express');
const requireAuth = require('../middleware/auth.middleware');
const invoiceController = require('../controllers/invoice.controller');

const router = express.Router();

// Enforce authentication on all document/invoice API routes
router.use(requireAuth);

// Document CRUD and history routes
router.get('/invoices', invoiceController.listInvoices);
router.get('/invoices/:id', invoiceController.getInvoice);
router.post('/invoices', invoiceController.createInvoice);
router.put('/invoices/:id', invoiceController.updateInvoice);
router.delete('/invoices/:id', invoiceController.softDeleteInvoice);
router.get('/invoices/:id/history', invoiceController.getInvoiceHistory);
router.patch('/invoices/:id/status', invoiceController.updateInvoiceStatus);
router.post('/invoices/:id/restore', invoiceController.restoreInvoice);
router.post('/invoices/:id/convert', invoiceController.convertQuotation);
router.get('/invoices/:id/copy', invoiceController.copyInvoice);

module.exports = router;
