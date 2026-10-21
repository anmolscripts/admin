'use strict';
const desk = require('../services/recordDesk.service');
const requireAuth = require('./auth.middleware');
const types = { clients:'client',items:'item',units:'unit' };
module.exports = (req,res,next) => {
    const match = req.path.match(/^\/(?:api\/)?(clients|items|units)\/(\d+)(?:\/|$)/);
    if (!match) return next();
    return requireAuth(req,res,async () => {
        try { await desk.authorized(types[match[1]],match[2],req.businessId); next(); }
        catch(error) { next(error); }
    });
};
