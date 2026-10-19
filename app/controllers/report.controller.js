'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — REPORT & ACCOUNTING RECONCILIATION CONTROLLER (MILESTONE 7)
 * ==============================================================================
 */

const reportService = require('../services/accounting/report.service');
const journalService = require('../services/journal.service');
const financialYearService = require('../services/financialYear.service');
const coaService = require('../services/chartOfAccounts.service');
const clientService = require('../services/client.service');

class ReportController {
    /**
     * Reports Overview Hub: /reports
     */
    async renderReportsOverview(req, res, next) {
        try {
            const financialYears = await financialYearService.listFinancialYears();
            res.render('reports/index', {
                pageTitle: 'Financial Reports & Accounting',
                pageSubtitle: 'Authoritative double-entry reporting, ledgers, statements, and reconciliation.',
                financialYears,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Journal Register: /reports/journals
     */
    async renderJournalRegister(req, res, next) {
        try {
            const [report, financialYears, accounts] = await Promise.all([
                reportService.getJournalRegister(req.query),
                financialYearService.listFinancialYears(),
                coaService.listAccounts()
            ]);

            res.render('reports/journal-register', {
                pageTitle: 'Journal Register',
                pageSubtitle: 'General journal transaction registry with full line-item audit trail.',
                report,
                financialYears,
                accounts,
                filters: req.query,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Journal Detail View: /reports/journals/:id
     */
    async renderJournalDetail(req, res, next) {
        try {
            const journalId = parseInt(req.params.id, 10);
            if (isNaN(journalId) || journalId <= 0) {
                return res.status(400).render('errors/500', {
                    pageTitle: 'Bad Request',
                    error: new Error('Invalid journal entry ID.')
                });
            }

            const journal = await journalService.getJournalEntryById(journalId);
            res.render('reports/journal-view', {
                pageTitle: `Journal Entry ${journal.entryNumber}`,
                pageSubtitle: `Double-entry posting details, source document reference, and audit metadata.`,
                journal,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            if (err instanceof journalService.NotFoundError) {
                return res.status(404).render('errors/404', {
                    pageTitle: 'Journal Not Found'
                });
            }
            next(err);
        }
    }

    /**
     * General Ledger: /reports/general-ledger
     */
    async renderGeneralLedger(req, res, next) {
        try {
            const [report, financialYears, accounts] = await Promise.all([
                reportService.getGeneralLedgerReport(req.query),
                financialYearService.listFinancialYears(),
                coaService.listAccounts()
            ]);

            res.render('reports/general-ledger', {
                pageTitle: 'General Ledger',
                pageSubtitle: req.query.accountId && report.account
                    ? `Account Statement: ${report.account.code} - ${report.account.name}`
                    : 'Account-level transaction ledger and balance movements.',
                report,
                financialYears,
                accounts,
                selectedAccountId: req.query.accountId || '',
                filters: req.query,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Trial Balance: /reports/trial-balance
     */
    async renderTrialBalance(req, res, next) {
        try {
            const [report, financialYears] = await Promise.all([
                reportService.getTrialBalance(req.query),
                financialYearService.listFinancialYears()
            ]);

            res.render('reports/trial-balance', {
                pageTitle: 'Trial Balance',
                pageSubtitle: 'As-of date ledger equilibrium verifying total debits equal total credits.',
                report,
                financialYears,
                filters: req.query,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Profit & Loss Statement: /reports/profit-and-loss
     */
    async renderProfitAndLoss(req, res, next) {
        try {
            const [report, financialYears] = await Promise.all([
                reportService.getProfitAndLoss(req.query),
                financialYearService.listFinancialYears()
            ]);

            res.render('reports/profit-and-loss', {
                pageTitle: 'Profit & Loss Statement',
                pageSubtitle: 'Revenue, Cost of Goods Sold, Gross Profit, Expenses, and Net Earnings.',
                report,
                financialYears,
                filters: req.query,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Balance Sheet: /reports/balance-sheet
     */
    async renderBalanceSheet(req, res, next) {
        try {
            const [report, financialYears] = await Promise.all([
                reportService.getBalanceSheet(req.query),
                financialYearService.listFinancialYears()
            ]);

            res.render('reports/balance-sheet', {
                pageTitle: 'Balance Sheet',
                pageSubtitle: 'Statement of Financial Position: Assets, Liabilities, and Equity.',
                report,
                financialYears,
                filters: req.query,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Customer Receivables & Subledger Reconciliation: /reports/customer-receivables
     */
    async renderCustomerReceivables(req, res, next) {
        try {
            const [report, clients] = await Promise.all([
                reportService.getCustomerReceivablesReport(req.query),
                clientService.searchClients()
            ]);

            res.render('reports/customer-receivables', {
                pageTitle: 'Customer Receivables & Ageing',
                pageSubtitle: 'Accounts Receivable ageing analysis and subledger-to-GL 1121 reconciliation.',
                report,
                clients,
                filters: req.query,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            next(err);
        }
    }

    /**
     * Customer Account Statement & Subledger Hub: /reports/customer-statement, /reports/sub-ledger, or /reports/customer-statement/:clientId
     */
    async renderCustomerStatement(req, res, next) {
        try {
            const businessId = req.businessId || (req.session && req.session.activeBusinessId) || null;
            const clients = await clientService.searchClients('', businessId);

            let clientId = null;
            if (req.params.clientId) {
                clientId = parseInt(req.params.clientId, 10);
            } else if (req.query.clientId) {
                clientId = parseInt(req.query.clientId, 10);
            } else if (clients && clients.length > 0) {
                clientId = clients[0].id;
            }

            if (!clientId || isNaN(clientId)) {
                return res.render('reports/customer-statement', {
                    pageTitle: 'Customer Sub-Ledger Statement',
                    pageSubtitle: 'Chronological client subledger statement with invoices, payments, and running balance.',
                    report: null,
                    clients: clients || [],
                    selectedClientId: null,
                    filters: req.query,
                    isReports: true,
                    csrfToken: req.session ? req.session.csrfToken : '',
                    user: req.session ? req.session.user : null
                });
            }

            const report = await reportService.getCustomerStatement(clientId, req.query);

            res.render('reports/customer-statement', {
                pageTitle: `Customer Statement: ${report.client.name}`,
                pageSubtitle: 'Chronological client subledger statement with invoices, payments, and running balance.',
                report,
                clients: clients || [],
                selectedClientId: clientId,
                filters: req.query,
                isReports: true,
                csrfToken: req.session ? req.session.csrfToken : '',
                user: req.session ? req.session.user : null
            });
        } catch (err) {
            if (err instanceof reportService.NotFoundError) {
                return res.status(404).render('errors/404', {
                    pageTitle: 'Client Not Found'
                });
            }
            next(err);
        }
    }

    /**
     * Export Customer Sub-Ledger Statement as CSV: /reports/customer-statement/export
     */
    async exportCustomerStatement(req, res, next) {
        try {
            const rawId = req.params.clientId || req.query.clientId;
            const clientId = parseInt(rawId, 10);
            if (isNaN(clientId) || clientId <= 0) {
                return res.status(400).send('Invalid or missing client ID.');
            }

            const report = await reportService.getCustomerStatement(clientId, req.query);

            const escapeCsv = (str) => {
                if (str === null || str === undefined) return '""';
                const s = String(str).replace(/"/g, '""');
                return `"${s}"`;
            };

            const lines = [];
            lines.push(`"CUSTOMER SUB-LEDGER STATEMENT: ${report.client.name.replace(/"/g, '""')}"`);
            lines.push(`"Period: ${req.query.fromDate || 'Beginning'} to ${req.query.toDate || 'Current'}"`);
            lines.push(`"Opening Balance: ₹${parseFloat(report.statement.openingBalance).toFixed(2)}"`);
            lines.push(`"Total Debits: ₹${parseFloat(report.statement.totalDebit).toFixed(2)}"`);
            lines.push(`"Total Credits: ₹${parseFloat(report.statement.totalCredit).toFixed(2)}"`);
            lines.push(`"Closing Balance: ₹${parseFloat(report.statement.closingBalance).toFixed(2)}"`);
            lines.push('');
            lines.push(['Date', 'Journal #', 'Source Type', 'Source Ref', 'Narration', 'Debit (INR)', 'Credit (INR)', 'Running Balance (INR)'].map(escapeCsv).join(','));

            lines.push(['—', '—', 'OPENING', '—', 'Opening Balance', '—', '—', parseFloat(report.statement.openingBalance).toFixed(2)].map(escapeCsv).join(','));

            for (const t of report.transactions) {
                lines.push([
                    new Date(t.entryDate).toLocaleDateString('en-IN'),
                    t.entryNumber,
                    t.sourceType,
                    t.sourceId ? '#' + t.sourceId : '—',
                    t.narration || '',
                    parseFloat(t.debit) > 0 ? parseFloat(t.debit).toFixed(2) : '0.00',
                    parseFloat(t.credit) > 0 ? parseFloat(t.credit).toFixed(2) : '0.00',
                    parseFloat(t.runningBalance).toFixed(2)
                ].map(escapeCsv).join(','));
            }

            lines.push(['TOTALS', '', '', '', 'Period Total & Closing Balance', parseFloat(report.statement.totalDebit).toFixed(2), parseFloat(report.statement.totalCredit).toFixed(2), parseFloat(report.statement.closingBalance).toFixed(2)].map(escapeCsv).join(','));

            const csvContent = '\uFEFF' + lines.join('\r\n');
            const sanitizedName = report.client.name.replace(/[^a-zA-Z0-9_-]/g, '_');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="SubLedger_${sanitizedName}_${Date.now()}.csv"`);
            return res.send(csvContent);
        } catch (err) {
            next(err);
        }
    }
}

module.exports = new ReportController();
