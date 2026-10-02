const itemService = require('../services/item.service');

function handleControllerError(err, res, next) {
    if (err instanceof itemService.ValidationError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof itemService.NotFoundError) {
        return res.status(404).json({ success: false, error: err.message });
    }
    if (err instanceof itemService.ConflictError) {
        return res.status(409).json({ success: false, error: err.message });
    }
    console.error('[ITEM CONTROLLER ERROR]:', err);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
    });
}

/**
 * GET /api/items/search
 * Debounced autocomplete endpoint for document editor
 */
async function searchItems(req, res, next) {
    try {
        const { q, limit, active } = req.query;
        const activeOnly = active !== 'false' && active !== false;
        const items = await itemService.searchItems({
            query: q || '',
            activeOnly,
            limit: limit ? parseInt(limit, 10) : 10
        });

        return res.status(200).json({
            success: true,
            data: items
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * GET /api/items
 * List items with pagination and search
 */
async function listItems(req, res, next) {
    try {
        const { search, active, page, limit } = req.query;
        const result = await itemService.listItems({
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
 * GET /api/items/:id
 * Retrieve a single item
 */
async function getItem(req, res, next) {
    try {
        const item = await itemService.getItemById(req.params.id);
        return res.status(200).json({
            success: true,
            data: item
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * POST /api/items
 * Create a new item
 */
async function createItem(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const item = await itemService.createItem(req.body, userId);
        return res.status(201).json({
            success: true,
            data: item
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

/**
 * PUT /api/items/:id
 * Update an item
 */
async function updateItem(req, res, next) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const item = await itemService.updateItem(req.params.id, req.body, userId);
        return res.status(200).json({
            success: true,
            data: item
        });
    } catch (err) {
        return handleControllerError(err, res, next);
    }
}

module.exports = {
    searchItems,
    listItems,
    getItem,
    createItem,
    updateItem
};
