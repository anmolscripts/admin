const express = require('express');
const requireAuth = require('../middleware/auth.middleware');
const invoiceService = require('../services/invoice.service');

const router = express.Router();

// Main authenticated application screen: Quotations & Invoices Listing
router.get('/', requireAuth, (req, res) => {
    res.render('documents/index', {
        pageTitle: 'Quotations & Invoices'
    });
});

router.get('/documents', requireAuth, (req, res) => {
    res.render('documents/index', {
        pageTitle: 'Quotations & Invoices'
    });
});

// Reusable Document Editor: Create New Quotation or Invoice (or Copy existing)
router.get('/documents/new', requireAuth, async (req, res, next) => {
    try {
        let copyData = null;
        let copyOfNumber = null;
        let documentType = 'INVOICE';

        if (req.query.copyFrom) {
            const copyFromId = parseInt(req.query.copyFrom, 10);
            if (isNaN(copyFromId) || copyFromId <= 0) {
                return res.status(400).render('errors/500', {
                    pageTitle: 'Bad Request',
                    error: new Error('Invalid document ID for copy.')
                });
            }
            copyData = await invoiceService.copyDocument(copyFromId);
            const sourceDoc = await invoiceService.getInvoiceById(copyFromId);
            copyOfNumber = sourceDoc.invoiceNumber;
            documentType = copyData.documentType;
        } else {
            const rawType = (req.query.type || 'INVOICE').toString().trim().toUpperCase();
            documentType = rawType === 'QUOTATION' ? 'QUOTATION' : 'INVOICE';
        }

        const isQuotation = documentType === 'QUOTATION';

        res.render('documents/editor', {
            pageTitle: copyOfNumber
                ? `New ${isQuotation ? 'Quotation' : 'Invoice'} (Copy of ${copyOfNumber})`
                : (isQuotation ? 'New Quotation' : 'New Invoice'),
            pageSubtitle: copyOfNumber
                ? `Creating an unsaved ${isQuotation ? 'quotation' : 'invoice'} copied from ${copyOfNumber}. Number assigned upon saving.`
                : (isQuotation
                    ? 'Create and issue a new client quotation with precision.'
                    : 'Create and issue a new client invoice with precision.'),
            mode: 'create',
            documentType,
            document: copyData ? { ...copyData, copyOfNumber } : null,
            copyOfNumber,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        if (err instanceof invoiceService.NotFoundError) {
            return res.status(404).render('errors/404', {
                pageTitle: 'Document Not Found'
            });
        }
        return next(err);
    }
});

// Reusable Document Editor: Edit Existing Quotation or Invoice
router.get('/documents/:id/edit', requireAuth, async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).render('errors/500', {
                pageTitle: 'Bad Request',
                error: new Error('Invalid document ID.')
            });
        }

        const doc = await invoiceService.getInvoiceById(id);

        if (doc.status === 'VOID') {
            return res.status(400).render('errors/500', {
                pageTitle: 'Document Locked',
                error: new Error(`Cannot edit document ${doc.invoiceNumber} in VOID status. Voided documents are permanently locked.`)
            });
        }

        if (doc.status === 'DELETED') {
            return res.status(400).render('errors/500', {
                pageTitle: 'Document Deleted',
                error: new Error(`Cannot edit document ${doc.invoiceNumber} in DELETED status. Restore the document before editing.`)
            });
        }

        const isQuotation = doc.documentType === 'QUOTATION';

        res.render('documents/editor', {
            pageTitle: `Edit ${doc.invoiceNumber}`,
            pageSubtitle: `Edit details for ${isQuotation ? 'quotation' : 'invoice'} ${doc.invoiceNumber}.`,
            mode: 'edit',
            documentType: doc.documentType,
            document: doc,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        if (err instanceof invoiceService.NotFoundError) {
            return res.status(404).render('errors/404', {
                pageTitle: 'Document Not Found'
            });
        }
        return next(err);
    }
});

// Document View / Detail Screen: Comprehensive Document Inspection & Lifecycle Hub
router.get('/documents/:id', requireAuth, async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).render('errors/500', {
                pageTitle: 'Bad Request',
                error: new Error('Invalid document ID.')
            });
        }

        const doc = await invoiceService.getInvoiceById(id);
        const isQuotation = doc.documentType === 'QUOTATION';

        res.render('documents/view', {
            pageTitle: `${isQuotation ? 'Quotation' : 'Invoice'} ${doc.invoiceNumber}`,
            pageSubtitle: `${isQuotation ? 'Client Quotation' : 'Tax Invoice'} • ${doc.clientName}`,
            document: doc,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        if (err instanceof invoiceService.NotFoundError) {
            return res.status(404).render('errors/404', {
                pageTitle: 'Document Not Found'
            });
        }
        return next(err);
    }
});

router.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard/index', {
        pageTitle: 'Dashboard'
    });
});

module.exports = router;