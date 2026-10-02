const clientService = require('../services/client.service');

function handleControllerError(err, res) {
    if (err instanceof clientService.ValidationError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof clientService.NotFoundError) {
        return res.status(404).json({ success: false, error: err.message });
    }
    console.error('[CLIENT CONTROLLER ERROR]:', err);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
    });
}

/**
 * GET /api/clients
 */
async function listClients(req, res) {
    try {
        const result = await clientService.listClients(req.query);
        return res.status(200).json({ success: true, ...result });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * GET /api/clients/search
 */
async function searchClients(req, res) {
    try {
        const query = req.query.q || req.query.search || '';
        const clients = await clientService.searchClients(query);
        return res.status(200).json({ success: true, data: clients });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * GET /api/clients/:id
 */
async function getClient(req, res) {
    try {
        const client = await clientService.getClientById(req.params.id);
        return res.status(200).json({ success: true, data: client });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * POST /api/clients
 */
async function createClient(req, res) {
    try {
        const userId = req.session && req.session.user ? req.session.user.id : null;
        const client = await clientService.createClient(req.body, userId);
        return res.status(201).json({ success: true, data: client });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * PUT /api/clients/:id
 */
async function updateClient(req, res) {
    try {
        const client = await clientService.updateClient(req.params.id, req.body);
        return res.status(200).json({ success: true, data: client });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * PATCH /api/clients/:id/status
 */
async function toggleStatus(req, res) {
    try {
        const client = await clientService.toggleClientStatus(req.params.id);
        return res.status(200).json({ success: true, data: client });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

module.exports = {
    listClients,
    searchClients,
    getClient,
    createClient,
    updateClient,
    toggleStatus
};
