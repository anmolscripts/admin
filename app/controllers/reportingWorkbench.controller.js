'use strict';

const reportingWorkbenchService = require('../services/reportingWorkbench.service');
const businessService = require('../services/business.service');

class ReportingWorkbenchController {
    /**
     * Render the Enterprise Reporting Workbench view
     */
    async renderWorkbench(req, res, next) {
        try {
            const user = req.session ? req.session.user : null;
            const isPlatformAdmin = user && (user.role === 'ADMIN' || user.isPlatformAdmin === true);
            const accessibleBusinesses = await businessService.getAccessibleBusinesses(user ? user.id : null, isPlatformAdmin);

            const dataset = req.query.dataset || 'INVOICES';
            const grouping = req.query.grouping || 'none';

            let reportData = null;
            try {
                reportData = await reportingWorkbenchService.queryWorkbench({
                    user,
                    dataset,
                    filters: req.query,
                    grouping,
                    page: req.query.page || 1,
                    limit: req.query.limit || 50
                });
            } catch (err) {
                // If filter query fails, keep empty data but render UI with error notice
                reportData = {
                    dataset: reportingWorkbenchService.REPORT_FAMILIES[dataset] || { name: dataset, id: dataset },
                    businessScope: { businesses: accessibleBusinesses },
                    filters: req.query,
                    grouping,
                    summary: { totalRecords: 0, subtotal: 0, taxAmount: 0, grandTotal: 0 },
                    total: 0,
                    page: 1,
                    limit: 50,
                    totalPages: 1,
                    records: [],
                    allRecords: [],
                    grouped: null,
                    error: err.message
                };
            }

            res.render('reports/workbench', {
                pageTitle: 'Reporting & Analytics Workbench',
                pageSubtitle: 'Consolidated cross-business reporting, multi-dimensional filtering, and exports.',
                reportFamilies: reportingWorkbenchService.REPORT_FAMILIES,
                accessibleBusinesses,
                selectedDataset: dataset,
                reportData,
                filters: req.query,
                isPlatformAdmin,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Query Workbench via REST API
     */
    async queryApi(req, res, next) {
        try {
            const user = req.session ? req.session.user : null;
            const dataset = req.query.dataset || 'INVOICES';
            const grouping = req.query.grouping || 'none';

            const result = await reportingWorkbenchService.queryWorkbench({
                user,
                dataset,
                filters: req.query,
                grouping,
                page: req.query.page || 1,
                limit: req.query.limit || 50
            });

            res.json({
                success: true,
                data: result
            });
        } catch (err) {
            const status = err.statusCode || (err.name === 'ForbiddenError' ? 403 : 400);
            res.status(status).json({
                success: false,
                error: err.message
            });
        }
    }

    /**
     * Export workbench data to Excel, CSV, or PDF
     */
    async exportApi(req, res, next) {
        try {
            const user = req.session ? req.session.user : null;
            const dataset = req.query.dataset || 'INVOICES';
            const format = (req.query.format || 'excel').toLowerCase();
            const grouping = req.query.grouping || 'none';

            const result = await reportingWorkbenchService.queryWorkbench({
                user,
                dataset,
                filters: req.query,
                grouping,
                page: 1,
                limit: 5000 // Export up to 5000 rows
            });

            const timestamp = new Date().toISOString().slice(0, 10);
            const filenameBase = `${dataset.toLowerCase()}_report_${timestamp}`;

            if (format === 'csv') {
                const csvData = reportingWorkbenchService.generateWorkbenchCsv(result);
                res.setHeader('Content-Type', 'text/csv');
                res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
                return res.send(csvData);
            } else if (format === 'pdf') {
                const pdfBuffer = await reportingWorkbenchService.generateWorkbenchPdf(result);
                res.setHeader('Content-Type', 'application/pdf');
                res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.pdf"`);
                return res.send(pdfBuffer);
            } else if (format === 'print' || format === 'html') {
                const htmlPrint = reportingWorkbenchService.generateWorkbenchHtmlPrint(result);
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.send(htmlPrint);
            } else {
                // Default Excel
                const excelBuffer = await reportingWorkbenchService.generateWorkbenchExcel(result);
                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);
                return res.send(excelBuffer);
            }
        } catch (err) {
            next(err);
        }
    }
}

module.exports = new ReportingWorkbenchController();
