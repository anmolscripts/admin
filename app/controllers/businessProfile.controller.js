const businessProfileService = require('../services/businessProfile.service');

function handleControllerError(err, res) {
    if (err instanceof businessProfileService.ValidationError) {
        return res.status(400).json({ success: false, error: err.message });
    }
    if (err instanceof businessProfileService.NotFoundError) {
        return res.status(404).json({ success: false, error: err.message });
    }
    console.error('[BUSINESS PROFILE ERROR]:', err);
    return res.status(500).json({
        success: false,
        error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
    });
}

/**
 * GET /api/settings
 */
async function getProfile(req, res) {
    try {
        const profile = await businessProfileService.getProfile();
        return res.status(200).json({ success: true, data: profile });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

/**
 * PUT /api/settings
 */
async function updateProfile(req, res) {
    try {
        const updated = await businessProfileService.updateProfile(req.body);
        return res.status(200).json({ success: true, data: updated });
    } catch (err) {
        return handleControllerError(err, res);
    }
}

module.exports = {
    getProfile,
    updateProfile
};
