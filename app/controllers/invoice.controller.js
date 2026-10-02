const invoiceService = require('../services/invoice.service');
const pdfService = require('../services/pdf.service');
const excelService = require('../services/excel.service');

function handleControllerError(err, res, next) {
    if (err instanceof invoiceService.ValidationError) {
        return res.status(400).json({
            success: false,
            error: err.message
        });
    }

    if (err instanceof invoiceService.NotFoundError) {
        return res.status(404).json({
            success: false,
            error: err.message
        });
    }

    if (err instanceof invoiceService.ConflictError) {
        return res.status(409).json({
            success: false,
            error: err.message
        });
    }

    console.error('[INVOICE CONTROLLER ERROR]:', err);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
    });
}

/**
 * GET /api/invoices
 * List documents with search, documentType, status filtering, and pagination.
 */
async function listInvoices(req, res, next) {
    try {
        const { search, status, paymentStatus, type, documentType, dateFrom, dateTo, page, limit } = req.query;
        const result = await invoiceService.listInvoices({
            documentType: type || documentType,
            search,
            status,
            paymentStatus,
            dateFrom,
            dateTo,
            page,
            limit
        });

        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/invoices/:id
 * Get single document by ID with items, revisions, and relationships.
 */
async function getInvoice(req, res, next) {
    try {
        const invoice = await invoiceService.getInvoiceById(req.params.id);
        return res.status(200).json({
            success: true,
            data: invoice
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * POST /api/invoices
 * Create a new invoice or quotation.
 */
async function createInvoice(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        const invoice = await invoiceService.createDocument(req.body, userId);
        return res.status(201).json({
            success: true,
            data: invoice
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * PUT /api/invoices/:id
 * Update an existing invoice or quotation (requires optimistic concurrency version).
 */
async function updateInvoice(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        const invoice = await invoiceService.updateInvoice(req.params.id, req.body, userId);
        return res.status(200).json({
            success: true,
            data: invoice
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/invoices/:id/history
 * Get revision history for an invoice or quotation.
 */
async function getInvoiceHistory(req, res, next) {
    try {
        const history = await invoiceService.getInvoiceHistory(req.params.id);
        return res.status(200).json({
            success: true,
            data: history
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * PATCH /api/invoices/:id/status
 * Update document status (ACTIVE, INACTIVE, VOID, DELETED).
 */
async function updateInvoiceStatus(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        const { status, deleteReason, version } = req.body || {};
        if (!status) {
            return res.status(400).json({
                success: false,
                error: 'Status is required.'
            });
        }

        const invoice = await invoiceService.updateInvoiceStatus(req.params.id, status, userId, { deleteReason, version });
        return res.status(200).json({
            success: true,
            data: invoice
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * DELETE /api/invoices/:id
 * Soft-delete an invoice or quotation.
 */
async function softDeleteInvoice(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        const { deleteReason, version } = req.body || {};
        const invoice = await invoiceService.softDeleteDocument(req.params.id, deleteReason, userId, { version });
        return res.status(200).json({
            success: true,
            data: invoice
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * POST /api/invoices/:id/restore
 * Restore a soft-deleted document back to its previous meaningful status.
 */
async function restoreInvoice(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        const { version } = req.body || {};
        const invoice = await invoiceService.restoreDocument(req.params.id, userId, { version });
        return res.status(200).json({
            success: true,
            data: invoice
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * POST /api/invoices/:id/convert
 * Convert a QUOTATION into an INVOICE.
 */
async function convertQuotation(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        if (!userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }

        const { version } = req.body || {};
        const newInvoice = await invoiceService.convertQuotationToInvoice(req.params.id, userId, { version });
        return res.status(201).json({
            success: true,
            data: newInvoice
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/invoices/:id/copy
 * Prepare an unsaved copy of a document.
 */
async function copyInvoice(req, res, next) {
    try {
        const copyData = await invoiceService.copyDocument(req.params.id);
        return res.status(200).json({
            success: true,
            data: copyData
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/invoices/:id/pdf
 * Export document as styled PDF
 */
async function exportPdf(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid document ID.'
            });
        }

        const invoice = await invoiceService.getInvoiceById(id);
        const pdfBuffer = await pdfService.generateDocumentPdf(invoice);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoiceNumber}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.send(pdfBuffer);
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/invoices/export/excel
 * Export documents as styled multi-sheet Excel spreadsheet
 */
async function exportExcel(req, res, next) {
    try {
        const { search, status, type, documentType, dateFrom, dateTo, limit } = req.query;
        const excelBuffer = await excelService.generateInvoicesExcel({
            documentType: type || documentType,
            search,
            status,
            dateFrom,
            dateTo,
            limit
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="documents_export_${Date.now()}.xlsx"`);
        res.setHeader('Content-Length', excelBuffer.length);
        return res.send(excelBuffer);
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/invoices/kpis
 * Retrieve dashboard KPI strip metrics
 */
async function getDashboardKPIs(req, res, next) {
    try {
        const kpis = await invoiceService.getDashboardKPIs();
        return res.status(200).json({ success: true, data: kpis, ...kpis });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

module.exports = {
    listInvoices,
    getInvoice,
    createInvoice,
    updateInvoice,
    getInvoiceHistory,
    updateInvoiceStatus,
    softDeleteInvoice,
    restoreInvoice,
    convertQuotation,
    copyInvoice,
    exportPdf,
    exportExcel,
    getDashboardKPIs
};
