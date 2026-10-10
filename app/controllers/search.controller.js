'use strict';

const searchService = require('../services/search.service');

/**
 * GET /api/search?q=...
 */
exports.search = async (req, res, next) => {
    try {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }

        const query = (req.query.q || '').trim();
        if (!query || query.length < 2) {
            return res.json({
                success: true,
                query,
                categories: [],
                total: 0
            });
        }

        const user = req.session.user;
        const hasPermissionFn = req.hasPermission;

        const { categories, total } = await searchService.search(query, user, hasPermissionFn);

        return res.json({
            success: true,
            query,
            categories,
            total
        });
    } catch (err) {
        console.error('[SEARCH CONTROLLER ERROR]:', err);
        return res.status(500).json({
            success: false,
            error: process.env.NODE_ENV === 'development' ? err.message : 'Internal search error'
        });
    }
};
