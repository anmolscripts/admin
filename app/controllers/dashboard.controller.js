'use strict';

const dashboardService = require('../services/dashboard.service');

function resolveTargetBusinessId(req) {
    if (req.businessId) return req.businessId;
    if (req.session && req.session.activeBusinessId) return req.session.activeBusinessId;
    if (req.activeBusiness && req.activeBusiness.id) return req.activeBusiness.id;
    if (req.session && req.session.user && req.session.user.businessId) return req.session.user.businessId;
    return null;
}

/**
 * GET /api/dashboard/metrics
 * Server-side KPI and trend analytics for documents and finances.
 */
async function getMetrics(req, res) {
    try {
        const { range, from, to } = req.query;
        const businessId = resolveTargetBusinessId(req);

        const metrics = await dashboardService.getDashboardMetrics({
            range,
            from,
            to,
            businessId
        });

        return res.status(200).json({
            success: true,
            data: metrics
        });
    } catch (err) {
        console.error('[DASHBOARD CONTROLLER ERROR]:', err);
        return res.status(err.statusCode || 500).json({
            success: false,
            error: err.statusCode===400?err.message:'Failed to retrieve dashboard metrics.'
        });
    }
}

/**
 * GET /dashboard
 * Renders the full Dashboard web screen with server-aggregated initial data.
 */
async function renderDashboard(req, res, next) {
    try {
        const range = req.query.range || 'current_fy';
        const from = req.query.from || null;
        const to = req.query.to || null;
        const businessId = resolveTargetBusinessId(req);

        const metrics = await dashboardService.getDashboardMetrics({ range, from, to, businessId });

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
