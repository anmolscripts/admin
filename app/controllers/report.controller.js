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
     * Customer Account Statement: /reports/customer-statement/:clientId
     */
    async renderCustomerStatement(req, res, next) {
        try {
            const clientId = parseInt(req.params.clientId, 10);
            if (isNaN(clientId) || clientId <= 0) {
                return res.status(400).render('errors/500', {
                    pageTitle: 'Bad Request',
                    error: new Error('Invalid client ID.')
                });
            }

            const [report, clients] = await Promise.all([
                reportService.getCustomerStatement(clientId, req.query),
                clientService.searchClients()
            ]);

            res.render('reports/customer-statement', {
                pageTitle: `Customer Statement: ${report.client.name}`,
                pageSubtitle: 'Chronological client subledger statement with invoices, payments, and running balance.',
                report,
                clients,
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
}

module.exports = new ReportController();
