'use strict';

const financialYearService = require('../services/financialYear.service');
const closingService = require('../services/financialYearClosing.service');
const coaService = require('../services/chartOfAccounts.service');
const prisma = require('../config/prisma');

/**
 * Render Financial Years management list
 */
async function renderFinancialYearsList(req, res, next) {
    try {
        const financialYears = await financialYearService.listFinancialYears();

        res.render('financial-years/index', {
            pageTitle: 'Financial Years',
            pageSubtitle: 'Manage accounting financial years, year-end closing, and period locking',
            financialYears,
            isSettings: true,
            isFinancialYears: true,
            user: req.session ? req.session.user : null,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Render detailed Financial Year view with audit activity & closing details
 */
async function renderFinancialYearDetail(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).render('errors/500', {
                pageTitle: 'Bad Request',
                error: new Error('Invalid Financial Year ID.')
            });
        }

        const fy = await financialYearService.getFinancialYearById(id);
        if (!fy) {
            return res.status(404).render('errors/404', {
                pageTitle: 'Financial Year Not Found'
            });
        }

        // Fetch closing journal if closed
        let closingJournal = null;
        if (fy.status === 'CLOSED') {
            closingJournal = await prisma.journalEntry.findFirst({
                where: {
                    financialYearId: fy.id,
                    sourceType: 'YEAR_END_CLOSE',
                    status: 'POSTED'
                },
                include: {
                    lines: {
                        include: { account: true },
                        orderBy: { lineNumber: 'asc' }
                    },
                    postedBy: { select: { id: true, name: true, email: true } }
                }
            });
        }

        // Fetch user activities related to this FY
        const activities = await prisma.userActivityLog.findMany({
            where: {
                module: 'FINANCIAL_YEARS',
                targetId: String(fy.id)
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
            include: {
                actorUser: { select: { id: true, name: true, email: true } }
            }
        });

        res.render('financial-years/detail', {
            pageTitle: `Financial Year ${fy.code}`,
            fy,
            closingJournal,
            activities,
            isSettings: true,
            isFinancialYears: true,
            user: req.session ? req.session.user : null,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Render Financial Year Close Preview screen
 */
async function renderClosePreview(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).render('errors/500', {
                pageTitle: 'Bad Request',
                error: new Error('Invalid Financial Year ID.')
            });
        }

        const preview = await closingService.previewCloseFinancialYear(id);

        res.render('financial-years/close-preview', {
            pageTitle: `Close Preview — FY ${preview.financialYear.code}`,
            preview,
            isSettings: true,
            isFinancialYears: true,
            user: req.session ? req.session.user : null,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        if (err instanceof closingService.NotFoundError) {
            return res.status(404).render('errors/404', { pageTitle: 'Financial Year Not Found' });
        }
        next(err);
    }
}

/**
 * Execute Financial Year Close (POST)
 */
async function executeClose(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const meta = {
            ip: req.ip,
            userAgent: req.get('user-agent')
        };

        const result = await closingService.closeFinancialYear(id, userId, meta);

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({
                success: true,
                message: `Financial Year ${result.financialYear.code} closed successfully.`,
                result
            });
        }

        req.flash?.('success', `Financial Year ${result.financialYear.code} closed successfully.`);
        res.redirect(`/financial-years/${id}`);
    } catch (err) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            const status = err.statusCode || (err instanceof closingService.ValidationError ? 400 : 500);
            return res.status(status).json({
                success: false,
                error: err.message
            });
        }
        next(err);
    }
}

/**
 * Execute Financial Year Reopen (POST)
 */
async function executeReopen(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const reason = req.body.reason || '';
        const meta = {
            ip: req.ip,
            userAgent: req.get('user-agent')
        };

        const result = await closingService.reopenFinancialYear(id, userId, reason, meta);

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({
                success: true,
                message: `Financial Year ${result.financialYear.code} reopened successfully.`,
                result
            });
        }

        req.flash?.('success', `Financial Year ${result.financialYear.code} reopened successfully.`);
        res.redirect(`/financial-years/${id}`);
    } catch (err) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            const status = err.statusCode || (err instanceof closingService.ValidationError ? 400 : 500);
            return res.status(status).json({
                success: false,
                error: err.message
            });
        }
        next(err);
    }
}

/**
 * Render Initial Opening Balances Entry/Review screen
 */
async function renderOpeningBalances(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id) || id <= 0) {
            return res.status(400).render('errors/500', {
                pageTitle: 'Bad Request',
                error: new Error('Invalid Financial Year ID.')
            });
        }

        const fy = await financialYearService.getFinancialYearById(id);
        if (!fy) {
            return res.status(404).render('errors/404', { pageTitle: 'Financial Year Not Found' });
        }

        // Fetch permanent accounts (ASSET, LIABILITY, EQUITY)
        const accounts = await prisma.chartOfAccount.findMany({
            where: {
                type: { in: ['ASSET', 'LIABILITY', 'EQUITY'] },
                allowPosting: true,
                active: true
            },
            orderBy: [{ type: 'asc' }, { code: 'asc' }]
        });

        // Check if opening journal already exists
        const existingJournal = await prisma.journalEntry.findFirst({
            where: {
                financialYearId: fy.id,
                sourceType: 'OPENING_BALANCE',
                status: 'POSTED'
            },
            include: {
                lines: {
                    include: { account: true },
                    orderBy: { lineNumber: 'asc' }
                },
                postedBy: { select: { id: true, name: true, email: true } }
            }
        });

        res.render('financial-years/opening-balances', {
            pageTitle: `Opening Balances — FY ${fy.code}`,
            fy,
            accounts,
            existingJournal,
            isSettings: true,
            isFinancialYears: true,
            user: req.session ? req.session.user : null,
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Execute Initial Opening Balances Posting (POST)
 */
async function executeOpeningBalances(req, res, next) {
    try {
        const id = parseInt(req.params.id, 10);
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const { lines = [], narration = '' } = req.body;
        const meta = {
            ip: req.ip,
            userAgent: req.get('user-agent')
        };

        const result = await closingService.postOpeningBalances(id, userId, lines, narration, meta);

        if (req.xhr || req.headers.accept?.includes('application/json')) {
            return res.json({
                success: true,
                message: 'Opening balances posted successfully.',
                result
            });
        }

        req.flash?.('success', 'Opening balances posted successfully.');
        res.redirect(`/financial-years/${id}/opening-balances`);
    } catch (err) {
        if (req.xhr || req.headers.accept?.includes('application/json')) {
            const status = err.statusCode || (err instanceof closingService.ValidationError ? 400 : 500);
            return res.status(status).json({
                success: false,
                error: err.message
            });
        }
        next(err);
    }
}

module.exports = {
    renderFinancialYearsList,
    renderFinancialYearDetail,
    renderClosePreview,
    executeClose,
    executeReopen,
    renderOpeningBalances,
    executeOpeningBalances
};
