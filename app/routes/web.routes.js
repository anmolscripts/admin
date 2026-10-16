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
const teamController = require('../controllers/team.controller');
const { requirePermission } = require('../middleware/permission.middleware');
const activityService = require('../services/activity.service');
const postingService = require('../services/accounting/posting.service');
const creditDebitNoteService = require('../services/creditDebitNote.service');
const reportController = require('../controllers/report.controller');
const financialYearController = require('../controllers/financialYear.controller');
const profileController = require('../controllers/profile.controller');
const { uploadAvatar } = require('../middleware/upload.middleware');
const purchaseController = require('../controllers/purchase.controller');
const erpController = require('../controllers/erp.controller');
const businessController = require('../controllers/business.controller');
const reportingWorkbenchController = require('../controllers/reportingWorkbench.controller');

const router = express.Router();

// -------------------------------------------------------------
// MULTI-BUSINESS WORKSPACE & CONTEXT
// -------------------------------------------------------------
router.get('/select-business', requireAuth, businessController.renderSelectBusiness);
router.post('/switch-business', requireAuth, businessController.switchBusiness);
router.post('/api/switch-business', requireAuth, businessController.switchBusiness);

// Platform Administration
router.get('/admin/businesses', requireAuth, businessController.renderBusinessList);
router.get('/admin/numbering', requireAuth, businessController.renderNumberingConfig);
router.post('/admin/numbering', requireAuth, businessController.updatePrefixConfig);
router.post('/admin/numbering/prefixes/:id', requireAuth, businessController.updatePrefixConfig);
router.get('/api/businesses', requireAuth, businessController.listBusinesses);
router.post('/api/businesses/create', requireAuth, businessController.createBusiness);
router.post('/api/businesses/:id', requireAuth, businessController.updateBusiness);
router.post('/api/businesses/:id/archive', requireAuth, businessController.archiveBusiness);
router.post('/api/businesses/:id/suspend', requireAuth, businessController.suspendBusiness);
router.post('/api/businesses/:id/delete', requireAuth, businessController.deleteBusiness);
router.delete('/api/businesses/:id', requireAuth, businessController.deleteBusiness);
router.get('/api/businesses/:id/members', requireAuth, businessController.listBusinessMembers);
router.post('/api/businesses/:id/members/role', requireAuth, businessController.setMemberRole);
router.post('/api/businesses/:id/members/revoke', requireAuth, businessController.revokeMemberAccess);
router.post('/api/businesses/:id/prefix-config', requireAuth, businessController.updatePrefixConfig);

// -------------------------------------------------------------
// ENTERPRISE REPORTING WORKBENCH (PHASE F)
// -------------------------------------------------------------
router.get('/reports/workbench', requireAuth, requirePermission('REPORTS', 'VIEW'), reportingWorkbenchController.renderWorkbench);
router.get('/reports/workbench/export', requireAuth, requirePermission('REPORTS', 'VIEW'), reportingWorkbenchController.exportApi);
router.get('/api/reports/workbench/query', requireAuth, requirePermission('REPORTS', 'VIEW'), reportingWorkbenchController.queryApi);
router.get('/api/reports/workbench/export', requireAuth, requirePermission('REPORTS', 'VIEW'), reportingWorkbenchController.exportApi);

// Business Analytics Dashboard
router.get('/dashboard', requireAuth, requirePermission('DASHBOARD', 'VIEW'), dashboardController.renderDashboard);

// Main authenticated application screen: Quotations & Invoices Listing
router.get('/', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), (req, res) => {
    res.render('documents/index', {
        pageTitle: 'Quotations & Invoices'
    });
});

router.get('/documents', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), (req, res) => {
    res.render('documents/index', {
        pageTitle: 'Quotations & Invoices'
    });
});

// Reusable Document Editor: Create New Quotation or Invoice (or Copy existing)
router.get('/documents/new', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), async (req, res, next) => {
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
router.get('/documents/:id/edit', requireAuth, requirePermission('DOCUMENTS', 'EDIT'), async (req, res, next) => {
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
router.get('/documents/export/excel', requireAuth, requirePermission('DOCUMENTS', 'EXPORT'), invoiceController.exportExcel);

// Dedicated Document Print View (must precede /documents/:id)
router.get('/documents/:id/print', requireAuth, requirePermission('DOCUMENTS', 'PRINT'), async (req, res, next) => {
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

        // Audit print event
        if (req.session && req.session.user) {
            await activityService.log({
                actorUserId: req.session.user.id,
                action: 'PRINT_DOCUMENT',
                module: 'DOCUMENTS',
                targetType: doc.documentType,
                targetId: doc.id,
                targetReference: doc.invoiceNumber,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent']
            }).catch(() => {});
        }

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
router.get('/documents/:id/pdf', requireAuth, requirePermission('DOCUMENTS', 'EXPORT'), invoiceController.exportPdf);

// Document View / Detail Screen: Comprehensive Document Inspection & Lifecycle Hub
router.get('/documents/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), async (req, res, next) => {
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
        let accounting = null;
        if (!isQuotation) {
            accounting = await postingService.getInvoiceAccountingStatus(id);
            if (doc.payments && doc.payments.length > 0) {
                const paymentPostings = await Promise.all(
                    doc.payments.map(p => postingService.getPaymentAccountingStatus(p.id))
                );
                doc.payments = doc.payments.map((p, idx) => ({
                    ...p,
                    accounting: paymentPostings[idx]
                }));
            }
            const notesResult = await creditDebitNoteService.listCreditDebitNotes({ invoiceId: id });
            doc.creditDebitNotes = notesResult.notes;
        }

        // Audit view event
        if (req.session && req.session.user) {
            await activityService.log({
                actorUserId: req.session.user.id,
                action: 'VIEW_DOCUMENT',
                module: 'DOCUMENTS',
                targetType: doc.documentType,
                targetId: doc.id,
                targetReference: doc.invoiceNumber,
                ipAddress: req.ip,
                userAgent: req.headers['user-agent']
            }).catch(() => {});
        }

        res.render('documents/view', {
            pageTitle: `${isQuotation ? 'Quotation' : 'Invoice'} ${doc.invoiceNumber}`,
            pageSubtitle: `${isQuotation ? 'Client Quotation' : 'Tax Invoice'} • ${doc.clientName}`,
            document: doc,
            accounting,
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
router.get('/clients', requireAuth, requirePermission('CLIENTS', 'VIEW'), async (req, res, next) => {
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

router.get('/clients/new', requireAuth, requirePermission('CLIENTS', 'CREATE'), (req, res) => {
    res.render('clients/form', {
        pageTitle: 'New Client',
        pageSubtitle: 'Add a new client profile with GSTIN and billing/shipping addresses.',
        mode: 'create',
        client: {},
        csrfToken: req.session ? req.session.csrfToken : '',
        user: req.session ? req.session.user : null
    });
});

router.post('/clients', requireAuth, requirePermission('CLIENTS', 'CREATE'), async (req, res) => {
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

router.get('/clients/:id/edit', requireAuth, requirePermission('CLIENTS', 'EDIT'), async (req, res, next) => {
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

router.post('/clients/:id', requireAuth, requirePermission('CLIENTS', 'EDIT'), async (req, res) => {
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
router.get('/settings', requireAuth, requirePermission('SETTINGS', 'VIEW'), async (req, res, next) => {
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

router.post('/settings', requireAuth, requirePermission('SETTINGS', 'EDIT'), async (req, res) => {
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
// USER PROFILE WEB ROUTES
// -------------------------------------------------------------
router.get('/profile', requireAuth, profileController.renderProfile);
router.post('/profile', requireAuth, uploadAvatar.single('avatar'), profileController.updateProfile);
router.post('/profile/password', requireAuth, profileController.changePassword);

// -------------------------------------------------------------
// ITEM MASTER WEB ROUTES
// -------------------------------------------------------------
router.get('/items', requireAuth, requirePermission('ITEMS', 'VIEW'), async (req, res, next) => {
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
router.get('/units', requireAuth, requirePermission('UNITS', 'VIEW'), unitController.renderUnitsPage);

// -------------------------------------------------------------
// TEAM & USER ACTIVITY WEB ROUTES
// -------------------------------------------------------------
router.get('/team', requireAuth, requirePermission('TEAM', 'VIEW'), teamController.renderTeamPage);
router.get('/team/activity', requireAuth, requirePermission('TEAM', 'ACTIVITY_VIEW'), teamController.renderActivityLogPage);
router.get('/team/analytics', requireAuth, requirePermission('TEAM', 'ACTIVITY_VIEW'), teamController.renderAnalyticsPage);
router.get('/team/:id', requireAuth, requirePermission('TEAM', 'VIEW'), teamController.renderTeamMemberDetail);

// -------------------------------------------------------------
// CREDIT & DEBIT NOTES WEB ROUTES
// -------------------------------------------------------------
router.get('/credit-debit-notes', requireAuth, requirePermission('CREDIT_NOTES', 'VIEW'), async (req, res, next) => {
    try {
        const result = await creditDebitNoteService.listCreditDebitNotes(req.query);
        res.render('notes/index', {
            pageTitle: 'Credit & Debit Notes',
            pageSubtitle: 'Manage seller-issued credit and debit adjustments against sales invoices.',
            notes: result.notes,
            pagination: result.pagination,
            filters: req.query,
            isNotes: true,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        next(err);
    }
});

router.get('/credit-debit-notes/new', requireAuth, requirePermission('CREDIT_NOTES', 'CREATE'), async (req, res, next) => {
    try {
        let invoice = null;
        if (req.query.invoiceId) {
            const invId = parseInt(req.query.invoiceId, 10);
            if (!isNaN(invId) && invId > 0) {
                invoice = await invoiceService.getInvoiceById(invId);
            }
        }

        const noteType = (req.query.type || 'CREDIT').toString().trim().toUpperCase() === 'DEBIT' ? 'DEBIT' : 'CREDIT';
        const clientList = await clientService.searchClients();
        const profile = await businessProfileService.getProfile();

        res.render('notes/editor', {
            pageTitle: `New ${noteType === 'DEBIT' ? 'Debit' : 'Credit'} Note`,
            noteType,
            invoice,
            clientList,
            profile,
            isNotes: true,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        next(err);
    }
});

router.get('/credit-debit-notes/:id', requireAuth, requirePermission('CREDIT_NOTES', 'VIEW'), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).render('errors/500', {
                pageTitle: 'Bad Request',
                error: new Error('Invalid note ID.')
            });
        }

        const note = await creditDebitNoteService.getCreditDebitNoteById(id);
        const accounting = await postingService.getCreditDebitNoteAccountingStatus(note.noteType, note.id);
        const journal = await postingService.getCreditDebitNotePosting(note.noteType, note.id);

        res.render('notes/view', {
            pageTitle: `${note.noteType === 'DEBIT' ? 'Debit Note' : 'Credit Note'} ${note.noteNumber}`,
            note,
            accounting: {
                ...accounting,
                journal
            },
            isNotes: true,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        if (err instanceof creditDebitNoteService.NotFoundError) {
            return res.status(404).render('errors/404', {
                pageTitle: 'Note Not Found'
            });
        }
        next(err);
    }
});

router.get('/credit-debit-notes/:id/print', requireAuth, requirePermission('CREDIT_NOTES', 'PRINT'), async (req, res, next) => {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).render('errors/500', {
                pageTitle: 'Bad Request',
                error: new Error('Invalid note ID.')
            });
        }

        const note = await creditDebitNoteService.getCreditDebitNoteById(id);
        const profile = await businessProfileService.getProfile();
        const model = documentViewService.buildNoteViewModel(note, profile);

        res.render('notes/print', {
            note,
            model
        });
    } catch (err) {
        if (err instanceof creditDebitNoteService.NotFoundError) {
            return res.status(404).render('errors/404', {
                pageTitle: 'Note Not Found'
            });
        }
        next(err);
    }
});

// -------------------------------------------------------------
// FINANCIAL REPORTS & RECONCILIATION WEB ROUTES (MILESTONE 7)
// -------------------------------------------------------------
router.get('/reports', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderReportsOverview);
router.get('/reports/journals', requireAuth, requirePermission('JOURNALS', 'VIEW'), reportController.renderJournalRegister);
router.get('/reports/journals/:id', requireAuth, requirePermission('JOURNALS', 'VIEW'), reportController.renderJournalDetail);
router.get('/reports/general-ledger', requireAuth, requirePermission('ACCOUNTS', 'VIEW'), reportController.renderGeneralLedger);
router.get('/reports/trial-balance', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderTrialBalance);
router.get('/reports/profit-and-loss', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderProfitAndLoss);
router.get('/reports/balance-sheet', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderBalanceSheet);
router.get('/reports/customer-receivables', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderCustomerReceivables);
router.get('/reports/customer-statement/:clientId', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderCustomerStatement);

// -------------------------------------------------------------
// FINANCIAL YEAR CLOSING, OPENING BALANCES & PERIOD LOCKING (MILESTONE 8)
// -------------------------------------------------------------
router.get('/financial-years', requireAuth, requirePermission('FINANCIAL_YEARS', 'VIEW'), financialYearController.renderFinancialYearsList);
router.get('/financial-years/:id', requireAuth, requirePermission('FINANCIAL_YEARS', 'VIEW'), financialYearController.renderFinancialYearDetail);
router.get('/financial-years/:id/close-preview', requireAuth, requirePermission('FINANCIAL_YEARS', 'VIEW'), financialYearController.renderClosePreview);
router.post('/financial-years/:id/close', requireAuth, requirePermission('FINANCIAL_YEARS', 'CLOSE'), financialYearController.executeClose);
router.post('/financial-years/:id/reopen', requireAuth, requirePermission('FINANCIAL_YEARS', 'REOPEN'), financialYearController.executeReopen);
router.get('/financial-years/:id/opening-balances', requireAuth, requirePermission('FINANCIAL_YEARS', 'VIEW'), financialYearController.renderOpeningBalances);
router.post('/financial-years/:id/opening-balances', requireAuth, requirePermission('FINANCIAL_YEARS', 'MANAGE'), financialYearController.executeOpeningBalances);

// -------------------------------------------------------------
// PURCHASES, BILLS, EXPENSES & OTHER INCOME (PHASE 4)
// -------------------------------------------------------------
router.get('/purchases/orders', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.renderPurchaseOrders);
router.get('/purchases/orders/new', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), purchaseController.renderNewPurchaseOrder);
router.post('/api/purchase-orders', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), purchaseController.createPurchaseOrder);
router.get('/api/purchase-orders/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.getPurchaseOrder);
router.post('/api/purchase-orders/:id/void', requireAuth, requirePermission('DOCUMENTS', 'VOID'), purchaseController.voidPurchaseOrder);

router.get('/purchases/bills', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.renderSupplierBills);
router.get('/purchases/bills/new', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), purchaseController.renderNewSupplierBill);
router.post('/api/supplier-bills', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), purchaseController.createSupplierBill);
router.get('/api/supplier-bills/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.getSupplierBill);
router.post('/api/supplier-bills/:id/void', requireAuth, requirePermission('DOCUMENTS', 'VOID'), purchaseController.voidSupplierBill);

router.get('/financials/expenses', requireAuth, requirePermission('ACCOUNTS', 'VIEW'), purchaseController.renderExpenses);
router.post('/api/expenses', requireAuth, requirePermission('ACCOUNTS', 'CREATE'), purchaseController.createExpense);

router.get('/financials/other-income', requireAuth, requirePermission('ACCOUNTS', 'VIEW'), purchaseController.renderOtherIncome);
router.post('/api/other-incomes', requireAuth, requirePermission('ACCOUNTS', 'CREATE'), purchaseController.createOtherIncome);

router.get('/api/suppliers', requireAuth, requirePermission('CLIENTS', 'VIEW'), purchaseController.searchSuppliers);
router.post('/api/suppliers', requireAuth, requirePermission('CLIENTS', 'CREATE'), purchaseController.createSupplier);

// -------------------------------------------------------------
// SUPPLIER PAYMENTS & ALLOCATIONS (PHASE 4 / TASK-204)
// -------------------------------------------------------------
router.get('/api/supplier-payments', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), erpController.listSupplierPayments);
router.post('/api/supplier-payments', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), erpController.recordSupplierPayment);
router.get('/api/supplier-payments/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), erpController.getSupplierPayment);
router.post('/api/supplier-payments/:id/void', requireAuth, requirePermission('DOCUMENTS', 'VOID'), erpController.voidSupplierPayment);

// -------------------------------------------------------------
// INVENTORY MOVEMENTS & VALUATION (PHASE 5 / TASK-301-307)
// -------------------------------------------------------------
router.get('/api/inventory/movements', requireAuth, requirePermission('ITEMS', 'VIEW'), erpController.listStockMovements);
router.post('/api/inventory/movements', requireAuth, requirePermission('ITEMS', 'CREATE'), erpController.recordStockMovement);
router.get('/api/inventory/summary/:itemId', requireAuth, requirePermission('ITEMS', 'VIEW'), erpController.getItemStockSummary);
router.get('/api/inventory/valuation', requireAuth, requirePermission('ITEMS', 'VIEW'), erpController.getInventoryValuation);

// -------------------------------------------------------------
// STATUTORY PAYROLL & EMPLOYEES (PHASE 6 / TASK-401-406)
// -------------------------------------------------------------
router.get('/api/payroll/employees', requireAuth, requirePermission('TEAM', 'VIEW'), erpController.listEmployees);
router.post('/api/payroll/employees', requireAuth, requirePermission('TEAM', 'CREATE'), erpController.createEmployee);
router.get('/api/payroll/employees/:id', requireAuth, requirePermission('TEAM', 'VIEW'), erpController.getEmployee);
router.post('/api/payroll/employees/:id/salary-structure', requireAuth, requirePermission('TEAM', 'MANAGE'), erpController.setSalaryStructure);
router.post('/api/payroll/periods/generate', requireAuth, requirePermission('ACCOUNTS', 'CREATE'), erpController.generatePayrollPeriod);
router.post('/api/payroll/periods/:id/approve', requireAuth, requirePermission('ACCOUNTS', 'MANAGE'), erpController.approvePayrollPeriod);
router.post('/api/payroll/periods/:id/post', requireAuth, requirePermission('ACCOUNTS', 'CLOSE'), erpController.postPayrollToLedger);
router.get('/api/payroll/entries/:entryId/payslip', requireAuth, requirePermission('TEAM', 'VIEW'), erpController.getPayslip);
router.post('/api/payroll/reimbursements', requireAuth, requirePermission('TEAM', 'CREATE'), erpController.createReimbursement);
router.post('/api/payroll/reimbursements/:id/approve', requireAuth, requirePermission('TEAM', 'MANAGE'), erpController.approveReimbursement);

// -------------------------------------------------------------
// PROJECTS, TASKS & LABOUR COSTING (PHASE 7 / TASK-501-505)
// -------------------------------------------------------------
router.get('/api/projects', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), erpController.listProjects);
router.post('/api/projects', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), erpController.createProject);
router.get('/api/projects/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), erpController.getProject);
router.post('/api/projects/:id/tasks', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), erpController.createProjectTask);
router.get('/api/projects/:id/tasks', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), erpController.listProjectTasks);
router.post('/api/timesheets', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), erpController.logTimesheet);
router.post('/api/timesheets/:id/approve', requireAuth, requirePermission('DOCUMENTS', 'MANAGE'), erpController.approveTimesheet);
router.get('/api/projects/:id/financials', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), erpController.getProjectFinancials);

module.exports = router;
