const express = require('express');
const requireAuth = require('../middleware/auth.middleware');
const invoiceService = require('../services/invoice.service');
const invoiceController = require('../controllers/invoice.controller');
const clientService = require('../services/client.service');
const itemService = require('../services/item.service');
const unitService = require('../services/unit.service');
const unitController = require('../controllers/unit.controller');
const businessProfileService = require('../services/businessProfile.service');
const documentViewService = require('../services/documentView.service');
const dashboardController = require('../controllers/dashboard.controller');

const router = express.Router();

// Business Analytics Dashboard
router.get('/dashboard', requireAuth, dashboardController.renderDashboard);

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

        const clientList = await clientService.searchClients();
        const unitList = await unitService.getActiveUnits();
        const profile = await businessProfileService.getProfile();
        let clientData = null;
        if (req.query.clientId) {
            const cid = parseInt(req.query.clientId, 10);
            if (!isNaN(cid) && cid > 0) {
                try {
                    const c = await clientService.getClientById(cid);
                    clientData = {
                        clientId: c.id,
                        clientName: c.name,
                        clientEmail: c.email,
                        clientPhone: c.phone,
                        clientGSTIN: c.gstin,
                        placeOfSupplyStateCode: c.stateCode,
                        billingAddress: c.billingAddress,
                        shippingAddress: c.shippingAddress
                    };
                } catch (_) {}
            }
        }

        const isQuotation = documentType === 'QUOTATION';

        let initialDoc = null;
        if (copyData) {
            initialDoc = { ...copyData, copyOfNumber };
        } else if (clientData) {
            initialDoc = {
                ...clientData,
                termsAndConditions: profile.defaultTerms,
                remarks: profile.defaultRemarks
            };
        } else {
            initialDoc = {
                termsAndConditions: profile.defaultTerms,
                remarks: profile.defaultRemarks
            };
        }

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
            document: initialDoc,
            clientList,
            unitList,
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
        const clientList = await clientService.searchClients();
        const unitList = await unitService.getActiveUnits();

        res.render('documents/editor', {
            pageTitle: `Edit ${doc.invoiceNumber}`,
            pageSubtitle: `Edit details for ${isQuotation ? 'quotation' : 'invoice'} ${doc.invoiceNumber}.`,
            mode: 'edit',
            documentType: doc.documentType,
            document: doc,
            clientList,
            unitList,
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

// Export Excel Route (must precede /documents/:id)
router.get('/documents/export/excel', requireAuth, invoiceController.exportExcel);

// Dedicated Document Print View (must precede /documents/:id)
router.get('/documents/:id/print', requireAuth, async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).render('errors/500', {
                pageTitle: 'Bad Request',
                error: new Error('Invalid document ID.')
            });
        }

        const doc = await invoiceService.getInvoiceById(id);
        const profile = await businessProfileService.getProfile();
        const model = documentViewService.buildDocumentViewModel(doc, profile);
        res.render('documents/print', {
            document: doc,
            model
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

// Document PDF Download Route (must precede /documents/:id)
router.get('/documents/:id/pdf', requireAuth, invoiceController.exportPdf);

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

// -------------------------------------------------------------
// -------------------------------------------------------------
// CLIENTS WEB ROUTES
// -------------------------------------------------------------
router.get('/clients', requireAuth, async (req, res, next) => {
    try {
        const { search, active } = req.query;
        const result = await clientService.listClients({ search, active, limit: 100 });
        res.render('clients/index', {
            pageTitle: 'Clients Directory',
            pageSubtitle: 'Manage customer accounts, tax registrations, and contact information.',
            clients: result.data,
            search,
            active,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        next(err);
    }
});

router.get('/clients/new', requireAuth, (req, res) => {
    res.render('clients/form', {
        pageTitle: 'New Client',
        pageSubtitle: 'Add a new client profile with GSTIN and billing/shipping addresses.',
        mode: 'create',
        client: {},
        csrfToken: req.session ? req.session.csrfToken : '',
        user: req.session ? req.session.user : null
    });
});

router.post('/clients', requireAuth, async (req, res) => {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        await clientService.createClient(req.body, userId);
        res.redirect('/clients');
    } catch (err) {
        res.status(400).render('clients/form', {
            pageTitle: 'New Client',
            pageSubtitle: 'Add a new client profile with GSTIN and billing/shipping addresses.',
            mode: 'create',
            client: req.body,
            error: err.message,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    }
});

router.get('/clients/:id/edit', requireAuth, async (req, res, next) => {
    try {
        const client = await clientService.getClientById(req.params.id);
        res.render('clients/form', {
            pageTitle: 'Edit Client',
            pageSubtitle: 'Update client contact and tax registration information.',
            mode: 'edit',
            client,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        if (err instanceof clientService.NotFoundError) {
            return res.status(404).render('errors/404', { pageTitle: 'Client Not Found' });
        }
        next(err);
    }
});

router.post('/clients/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        await clientService.updateClient(req.params.id, req.body, userId);
        res.redirect('/clients');
    } catch (err) {
        res.status(400).render('clients/form', {
            pageTitle: 'Edit Client',
            pageSubtitle: 'Update client contact and tax registration information.',
            mode: 'edit',
            client: { ...req.body, id: req.params.id },
            error: err.message,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    }
});

// -------------------------------------------------------------
// SETTINGS WEB ROUTES
// -------------------------------------------------------------
router.get('/settings', requireAuth, async (req, res, next) => {
    try {
        const profile = await businessProfileService.getProfile();
        res.render('settings/index', {
            pageTitle: 'Organization Profile & Defaults',
            pageSubtitle: 'Manage business identity, GST registration, bank details, and default terms.',
            profile,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        next(err);
    }
});

router.post('/settings', requireAuth, async (req, res) => {
    try {
        const profile = await businessProfileService.updateProfile(req.body);
        res.render('settings/index', {
            pageTitle: 'Organization Profile & Defaults',
            pageSubtitle: 'Manage business identity, GST registration, bank details, and default terms.',
            profile,
            success: true,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        res.status(400).render('settings/index', {
            pageTitle: 'Organization Profile & Defaults',
            pageSubtitle: 'Manage business identity, GST registration, bank details, and default terms.',
            profile: req.body,
            error: err.message,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    }
});

// -------------------------------------------------------------
// ITEM MASTER WEB ROUTES
// -------------------------------------------------------------
router.get('/items', requireAuth, async (req, res, next) => {
    try {
        const { search, active } = req.query;
        const [result, unitList] = await Promise.all([
            itemService.listItems({ search, active, limit: 100 }),
            unitService.getActiveUnits()
        ]);
        res.render('items/index', {
            pageTitle: 'Item Master',
            pageSubtitle: 'Manage standard product catalog, services, default units, and baseline rates.',
            items: result.data,
            unitList: unitList || [],
            search,
            active,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        next(err);
    }
});

// -------------------------------------------------------------
// UNIT MASTER WEB ROUTES
// -------------------------------------------------------------
router.get('/units', requireAuth, unitController.renderUnitsPage);

module.exports = router;