const express = require('express');
const requireAuth = require('../middleware/auth.middleware');
const invoiceService = require('../services/invoice.service');
const invoiceController = require('../controllers/invoice.controller');
const clientService = require('../services/client.service');
const itemService = require('../services/item.service');
const unitService = require('../services/unit.service');
const unitController = require('../controllers/unit.controller');
const businessProfileService = require('../services/businessProfile.service');
const templateService = require('../services/template.service');
const documentViewService = require('../services/documentView.service');
const dashboardController = require('../controllers/dashboard.controller');
const teamController = require('../controllers/team.controller');
const { requirePermission } = require('../middleware/permission.middleware');
const activityService = require('../services/activity.service');
const postingService = require('../services/accounting/posting.service');
const creditDebitNoteService = require('../services/creditDebitNote.service');
const reportController = require('../controllers/report.controller');
const financialYearController = require('../controllers/financialYear.controller');
const journalService = require('../services/journal.service');
const profileController = require('../controllers/profile.controller');
const { parseProfileUpload, parseLogoUpload, uploadAttachmentFile, handleAttachmentUpload } = require('../middleware/upload.middleware');
const {csrfProtection}=require('../middleware/csrf.middleware');
const purchaseController = require('../controllers/purchase.controller');
const supplierController = require('../controllers/supplier.controller');
const erpController = require('../controllers/erp.controller');
const projectController = require('../controllers/project.controller');
const businessController = require('../controllers/business.controller');
const reportingWorkbenchController = require('../controllers/reportingWorkbench.controller');
const prisma = require('../config/prisma');

const router = express.Router();
const productGuide=require('../controllers/productGuide.controller');
router.get('/product-guide',requireAuth,productGuide.render);
router.get('/product-guide/screens/:id',requireAuth,productGuide.screenshot);
router.get('/product-guide/demo/:id',requireAuth,productGuide.demo);

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

        const [clientList, unitList, profile, projectList] = await Promise.all([
            clientService.searchClients('', req.businessId),
            unitService.getActiveUnits(req.businessId),
            businessProfileService.getProfile(req.businessId),
            prisma.project.findMany({
                where: { businessId: req.businessId, status: 'ACTIVE' },
                select: { id: true, code: true, name: true, clientId: true },
                orderBy: { name: 'asc' }
            })
        ]);

        let clientData = null;
        let selectedProjectId = null;

        if (req.query.projectId) {
            const pid = parseInt(req.query.projectId, 10);
            if (!isNaN(pid) && pid > 0) {
                const project = await prisma.project.findFirst({
                    where: { id: pid, businessId: req.businessId }
                });
                if (project) {
                    selectedProjectId = project.id;
                    if (!req.query.clientId && project.clientId) {
                        try {
                            const c = await clientService.getClientById(project.clientId);
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
            }
        }

        if (req.query.clientId && !clientData) {
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
                projectId: selectedProjectId,
                termsAndConditions: profile.defaultTerms,
                remarks: profile.defaultRemarks
            };
        } else {
            initialDoc = {
                projectId: selectedProjectId,
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
            sellerStateCode: profile.stateCode,
            clientList,
            projectList,
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
        const [clientList, unitList, projectList, editorProfile] = await Promise.all([
            clientService.searchClients('', doc.businessId || req.businessId),
            unitService.getActiveUnits(req.businessId),
            prisma.project.findMany({
                where: { businessId: doc.businessId || req.businessId },
                select: { id: true, code: true, name: true, clientId: true },
                orderBy: { name: 'asc' }
            }),
            businessProfileService.getProfile(doc.businessId || req.businessId)
        ]);

        res.render('documents/editor', {
            pageTitle: `Edit ${doc.invoiceNumber}`,
            pageSubtitle: `Edit details for ${isQuotation ? 'quotation' : 'invoice'} ${doc.invoiceNumber}.`,
            mode: 'edit',
            documentType: doc.documentType,
            document: doc,
            sellerStateCode: doc.sellerStateCode || editorProfile.stateCode,
            clientList,
            projectList,
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
        const docBizId = doc.businessId || req.businessId;
        const profile = await businessProfileService.getProfile(docBizId);
        const activeTemplates = templateService.getActiveTemplates(docBizId);
        const requestedTemplateId = req.query.template || (doc.documentType === 'QUOTATION' ? activeTemplates.quotationTemplate : activeTemplates.invoiceTemplate);
        const templateConfig = templateService.getTemplate(requestedTemplateId, docBizId);
        const model = documentViewService.buildDocumentViewModel(doc, profile);
        model.templateConfig = templateConfig;

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
            model,
            templateConfig
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
        const result = await clientService.listClients({ search, active, limit: 100, businessId:req.businessId });
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
        const profile = await businessProfileService.getProfile(req.businessId);
        const templates = templateService.listTemplates(req.businessId);
        const activeTemplates = templateService.getActiveTemplates(req.businessId);

        res.render('settings/index', {
            pageTitle: 'Organization Profile & Defaults',
            pageSubtitle: 'Manage business identity, GST registration, bank details, and invoice templates.',
            profile,
            templates,
            activeTemplates,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        next(err);
    }
});

router.post('/settings', requireAuth, requirePermission('SETTINGS', 'EDIT'), parseLogoUpload, csrfProtection, async (req, res) => {
    try {
        if(req.logoUploadError)throw req.logoUploadError;
        const profile = await businessProfileService.updateProfile(req.body, req.businessId, req.file);
        const templates = templateService.listTemplates(req.businessId);
        const activeTemplates = templateService.getActiveTemplates(req.businessId);

        res.render('settings/index', {
            pageTitle: 'Organization Profile & Defaults',
            pageSubtitle: 'Manage business identity, GST registration, bank details, and invoice templates.',
            profile,
            templates,
            activeTemplates,
            success: true,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        const templates = templateService.listTemplates(req.businessId);
        const activeTemplates = templateService.getActiveTemplates(req.businessId);
        const savedProfile=await businessProfileService.getProfile(req.businessId);
        res.status(err.statusCode||400).render('settings/index', {
            pageTitle: 'Organization Profile & Defaults',
            pageSubtitle: 'Manage business identity, GST registration, bank details, and invoice templates.',
            profile: {...savedProfile,...req.body,logoUrl:savedProfile.logoUrl},
            templates,
            activeTemplates,
            error: err.message,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    }
});

// -------------------------------------------------------------
// DOCUMENT TEMPLATE SYSTEM ROUTES
// -------------------------------------------------------------
router.get('/settings/templates/preview/:templateId', requireAuth, async (req, res, next) => {
    try {
        const { templateId } = req.params;
        const docType = (req.query.type || 'INVOICE').toUpperCase();
        const profile = await businessProfileService.getProfile(req.businessId);
        const templateConfig = templateService.getTemplate(templateId, req.businessId);
        const sampleModel = templateService.buildSampleViewModel(templateId, docType, profile);
        sampleModel.templateConfig = templateConfig;

        res.render('documents/print', {
            model: sampleModel,
            document: sampleModel,
            templateConfig
        });
    } catch (err) {
        next(err);
    }
});

router.post('/api/settings/templates/active', requireAuth, requirePermission('SETTINGS', 'EDIT'), async (req, res) => {
    try {
        const { invoiceTemplate, quotationTemplate } = req.body;
        const updated = templateService.setActiveTemplates(req.businessId, { invoiceTemplate, quotationTemplate });
        return res.json({ success: true, activeTemplates: updated });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

router.post('/api/settings/templates/save', requireAuth, requirePermission('SETTINGS', 'EDIT'), async (req, res) => {
    try {
        const saved = templateService.saveCustomTemplate(req.businessId, req.body);
        return res.json({ success: true, template: saved });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

router.delete('/api/settings/templates/:id', requireAuth, requirePermission('SETTINGS', 'EDIT'), async (req, res) => {
    try {
        templateService.deleteCustomTemplate(req.businessId, req.params.id);
        return res.json({ success: true, message: 'Template deleted successfully.' });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
});

// -------------------------------------------------------------
// USER PROFILE WEB ROUTES
// -------------------------------------------------------------
router.get('/profile', requireAuth, profileController.renderProfile);
router.post('/profile', requireAuth, parseProfileUpload, csrfProtection, profileController.updateProfile);
router.post('/profile/password', requireAuth, profileController.changePassword);

// -------------------------------------------------------------
// ITEM MASTER WEB ROUTES
// -------------------------------------------------------------
router.get('/items', requireAuth, requirePermission('ITEMS', 'VIEW'), async (req, res, next) => {
    try {
        const { search, active } = req.query;
        const [result, unitList] = await Promise.all([
            itemService.listItems({ search, active, limit: 100, businessId:req.businessId }),
            unitService.getActiveUnits(req.businessId)
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
        const clientList = await clientService.searchClients('', (invoice && invoice.businessId) || req.businessId);
        const profile = await businessProfileService.getProfile((invoice && invoice.businessId) || req.businessId);

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
router.get('/api/journals/:id', requireAuth, requirePermission('JOURNALS', 'VIEW'), async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const journal = await journalService.getJournalEntryById(id);
        res.json({ success: true, data: journal });
    } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, error: err.message });
    }
});
router.get('/reports/general-ledger', requireAuth, requirePermission('ACCOUNTS', 'VIEW'), reportController.renderGeneralLedger);
router.get('/reports/trial-balance', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderTrialBalance);
router.get('/reports/profit-and-loss', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderProfitAndLoss);
router.get('/reports/balance-sheet', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderBalanceSheet);
router.get('/reports/customer-receivables', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderCustomerReceivables);
router.get('/reports/customer-statement', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderCustomerStatement);
router.get('/reports/sub-ledger', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderCustomerStatement);
router.get('/reports/customer-statement/export', requireAuth, requirePermission('REPORTS', 'EXPORT'), reportController.exportCustomerStatement);
router.get('/reports/customer-statement/:clientId', requireAuth, requirePermission('REPORTS', 'VIEW'), reportController.renderCustomerStatement);
router.get('/reports/customer-statement/:clientId/export', requireAuth, requirePermission('REPORTS', 'EXPORT'), reportController.exportCustomerStatement);

// -------------------------------------------------------------
// FINANCIAL YEAR CLOSING, OPENING BALANCES & PERIOD LOCKING (MILESTONE 8)
// -------------------------------------------------------------
router.use('/financial-years/:id',requireAuth,async(req,res,next)=>{
    try{
        const id=Number(req.params.id);
        if(!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Invalid financial year.'),{statusCode:400});
        const year=await prisma.financialYear.findFirst({where:{id,businessId:req.businessId}});
        if(!year)throw Object.assign(new Error('Financial year not found in this business.'),{statusCode:404});
        next();
    }catch(error){next(error);}
});
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
router.get('/purchases/orders/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.renderPurchaseOrderDetail);
router.get('/purchases/orders/:id/receive', requireAuth, requirePermission('DOCUMENTS', 'EDIT'), purchaseController.renderReceivePurchaseOrder);
router.post('/api/purchase-orders', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), purchaseController.createPurchaseOrder);
router.get('/api/purchase-orders/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.getPurchaseOrder);
router.post('/api/purchase-orders/:id', requireAuth, requirePermission('DOCUMENTS', 'EDIT'), purchaseController.updatePurchaseOrder);
router.put('/api/purchase-orders/:id', requireAuth, requirePermission('DOCUMENTS', 'EDIT'), purchaseController.updatePurchaseOrder);
router.post('/api/purchase-orders/:id/void', requireAuth, requirePermission('DOCUMENTS', 'VOID'), purchaseController.voidPurchaseOrder);
router.post('/api/purchase-orders/:id/receipts', requireAuth, requirePermission('DOCUMENTS', 'EDIT'), purchaseController.createGoodsReceipt);
router.post('/purchases/orders/:id/receive', requireAuth, requirePermission('DOCUMENTS', 'EDIT'), purchaseController.createGoodsReceipt);

// Goods Receipts (GRN)
router.get('/purchases/receipts', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.renderGoodsReceipts);
router.get('/purchases/receipts/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.renderGoodsReceiptDetail);
router.get('/api/goods-receipts', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.listGoodsReceiptsApi);
router.post('/api/goods-receipts', requireAuth, requirePermission('DOCUMENTS', 'CREATE'), purchaseController.createGoodsReceipt);
router.get('/api/goods-receipts/:id', requireAuth, requirePermission('DOCUMENTS', 'VIEW'), purchaseController.getGoodsReceipt);

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
router.get('/suppliers', requireAuth, requirePermission('CLIENTS', 'VIEW'), supplierController.renderSuppliersList);
router.get('/suppliers/new', requireAuth, requirePermission('CLIENTS', 'CREATE'), supplierController.renderNewSupplier);
router.post('/suppliers', requireAuth, requirePermission('CLIENTS', 'CREATE'), supplierController.createSupplier);
router.get('/suppliers/:id/edit', requireAuth, requirePermission('CLIENTS', 'EDIT'), supplierController.renderEditSupplier);
router.post('/suppliers/:id', requireAuth, requirePermission('CLIENTS', 'EDIT'), supplierController.updateSupplier);
router.post('/suppliers/:id/active', requireAuth, requirePermission('CLIENTS', 'EDIT'), supplierController.setSupplierActive);

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
// PROJECTS WORKSPACE, LABOUR & PROFITABILITY (ENTERPRISE ERP)
// -------------------------------------------------------------
// Web Views
router.get('/projects', requireAuth, requirePermission('PROJECTS', 'VIEW'), projectController.renderProjectsList);
router.get('/projects/new', requireAuth, requirePermission('PROJECTS', 'CREATE'), projectController.renderNewProject);
router.get('/projects/:id/edit', requireAuth, requirePermission('PROJECTS', 'EDIT'), projectController.renderEditProject);
router.get('/projects/:id', requireAuth, requirePermission('PROJECTS', 'VIEW'), projectController.renderProjectDetails);

// Project JSON APIs
router.get('/api/projects', requireAuth, requirePermission('PROJECTS', 'VIEW'), projectController.apiListProjects);
router.post('/api/projects', requireAuth, requirePermission('PROJECTS', 'CREATE'), projectController.apiCreateProject);
router.post('/api/projects/from-quotation/:quotationId', requireAuth, requirePermission('PROJECTS', 'CREATE'), projectController.apiCreateProjectFromQuotation);
router.get('/api/projects/:id', requireAuth, requirePermission('PROJECTS', 'VIEW'), projectController.apiGetProject);
router.post('/api/projects/:id', requireAuth, requirePermission('PROJECTS', 'EDIT'), projectController.apiUpdateProject);
router.get('/api/projects/:id/financials', requireAuth, requirePermission('PROJECTS', 'FINANCIALS_VIEW'), projectController.apiGetProjectFinancials);
router.get('/api/projects/:id/closure-preview', requireAuth, requirePermission('PROJECTS', 'VIEW'), projectController.apiGetProjectClosurePreview);
router.post('/api/projects/:id/close', requireAuth, requirePermission('PROJECTS', 'CLOSE'), projectController.apiCloseProject);

// Project Tasks
router.post('/api/projects/:id/tasks', requireAuth, requirePermission('PROJECTS', 'CREATE'), projectController.apiCreateTask);
router.get('/api/projects/:id/tasks', requireAuth, requirePermission('PROJECTS', 'VIEW'), erpController.listProjectTasks);

// Timesheets & Internal Labour
router.post('/api/timesheets', requireAuth, requirePermission('PROJECTS', 'COST_CREATE'), projectController.apiLogTimesheet);
router.post('/api/timesheets/:id/approve', requireAuth, requirePermission('PROJECTS', 'APPROVE'), projectController.apiApproveTimesheet);

// Casual & Daily Labour
router.post('/api/daily-workers', requireAuth, requirePermission('PROJECTS', 'CREATE'), projectController.apiCreateDailyWorker);
router.post('/api/projects/:id/daily-labour', requireAuth, requirePermission('PROJECTS', 'COST_CREATE'), projectController.apiRecordDailyLabour);

// Subcontractor Work Orders
router.post('/api/projects/:id/contractor-orders', requireAuth, requirePermission('PROJECTS', 'CREATE'), projectController.apiCreateContractorOrder);

// Project Material Allocation, Issue and Return
router.post('/api/projects/:id/issue-material', requireAuth, requirePermission('PROJECTS', 'COST_CREATE'), projectController.apiIssueMaterial);
router.post('/api/projects/:id/return-material', requireAuth, requirePermission('PROJECTS', 'COST_CREATE'), projectController.apiReturnMaterial);

// Secure File Attachments & Document Metadata
router.post('/api/projects/:id/attachments', requireAuth, requirePermission('PROJECTS', 'ATTACHMENT_UPLOAD'), handleAttachmentUpload('file'), projectController.apiUploadAttachment);
router.post('/api/attachments/upload', requireAuth, requirePermission('PROJECTS', 'ATTACHMENT_UPLOAD'), handleAttachmentUpload('file'), projectController.apiUploadAttachment);
router.get('/api/attachments/:id/download', requireAuth, requirePermission('PROJECTS', 'ATTACHMENT_VIEW'), projectController.apiDownloadAttachment);
router.put('/api/attachments/:id', requireAuth, requirePermission('PROJECTS', 'EDIT'), projectController.apiUpdateAttachment);
router.post('/api/attachments/:id/metadata', requireAuth, requirePermission('PROJECTS', 'EDIT'), projectController.apiUpdateAttachment);
router.delete('/api/attachments/:id', requireAuth, requirePermission('PROJECTS', 'DELETE'), projectController.apiDeleteAttachment);

module.exports = router;
