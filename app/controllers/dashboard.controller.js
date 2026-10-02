const dashboardService = require('../services/dashboard.service');

/**
 * GET /api/dashboard/metrics
 * Server-side KPI and trend analytics for documents and finances.
 */
async function getMetrics(req, res) {
    try {
        const { range, from, to } = req.query;
        const metrics = await dashboardService.getDashboardMetrics({
            range,
            from,
            to
        });

        return res.status(200).json({
            success: true,
            data: metrics
        });
    } catch (err) {
        console.error('[DASHBOARD CONTROLLER ERROR]:', err);
        return res.status(500).json({
            success: false,
            error: 'Failed to retrieve dashboard metrics.'
        });
    }
}

/**
 * GET /dashboard
 * Renders the full Dashboard web screen with server-aggregated initial data.
 */
async function renderDashboard(req, res, next) {
    try {
        const range = req.query.range || 'this_month';
        const from = req.query.from || null;
        const to = req.query.to || null;

        const metrics = await dashboardService.getDashboardMetrics({ range, from, to });

        res.render('dashboard/index', {
            pageTitle: 'Business Dashboard',
            pageSubtitle: 'Key operational KPIs, revenue tracking, and quotation conversion analytics.',
            metrics,
            csrfToken: req.session ? req.session.csrfToken : '',
            user: req.session ? req.session.user : null
        });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getMetrics,
    renderDashboard
};
