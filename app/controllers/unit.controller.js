const unitService = require('../services/unit.service');

function handleControllerError(err, res, next) {
    if (err instanceof unitService.ValidationError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof unitService.NotFoundError) {
        return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof unitService.ConflictError) {
        return res.status(409).json({ success: false, error: err.message });
    }
    console.error('[UNIT CONTROLLER ERROR]:', err);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
    });
}

/**
 * GET /units
 * Render Unit Master directory page
 */
async function renderUnitsPage(req, res, next) {
    try {
        const { search, active, page, limit } = req.query;
        const result = await unitService.listUnits({
            search,
            active,
            page,
            limit: limit || 50
        });

        res.render('units/index', {
            pageTitle: 'Unit Master',
            pageSubtitle: 'Manage measurement units, symbols, and activation status.',
            units: result.units,
            pagination: {
                total: result.total,
                page: result.page,
                limit: result.limit,
                totalPages: result.totalPages
            },
            search: search || '',
            active: active !== undefined ? active : '',
            csrfToken: req.session ? req.session.csrfToken : ''
        });
    } catch (err) {
        return next(err);
    }
}

/**
 * GET /api/units/active
 * Active units for document editor dropdowns
 */
async function getActiveUnits(req, res, next) {
    try {
        const units = await unitService.getActiveUnits();
        return res.status(200).json({
            success: true,
            data: units
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/units
 * List units with pagination, filtering and search
 */
async function listUnits(req, res, next) {
    try {
        const { search, active, page, limit } = req.query;
        const result = await unitService.listUnits({
            search,
            active,
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
 * GET /api/units/:id
 */
async function getUnit(req, res, next) {
    try {
        const unit = await unitService.getUnitById(req.params.id);
        return res.status(200).json({
            success: true,
            data: unit
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * POST /api/units
 */
async function createUnit(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const unit = await unitService.createUnit(req.body, userId);
        return res.status(201).json({
            success: true,
            data: unit
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * PUT /api/units/:id
 */
async function updateUnit(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const unit = await unitService.updateUnit(req.params.id, req.body, userId);
        return res.status(200).json({
            success: true,
            data: unit
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * PATCH /api/units/:id/status
 */
async function toggleUnitStatus(req, res, next) {
    try {
        const unit = await unitService.toggleUnitStatus(req.params.id);
        return res.status(200).json({
            success: true,
            data: unit
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * DELETE /api/units/:id
 */
async function deleteUnit(req, res, next) {
    try {
        const result = await unitService.deleteUnit(req.params.id);
        return res.status(200).json(result);
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

module.exports = {
    renderUnitsPage,
    getActiveUnits,
    listUnits,
    getUnit,
    createUnit,
    updateUnit,
    toggleUnitStatus,
    deleteUnit
};
