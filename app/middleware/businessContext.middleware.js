'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — BUSINESS CONTEXT RESOLVER & TENANT ENFORCEMENT MIDDLEWARE
 * ==============================================================================
 *
 * Guarantees strict multi-business data isolation and seamless context handling:
 * 1. Automatically resolves active business for single-business users.
 * 2. Enforces business selection for multi-business users.
 * 3. Prevents cross-business access by verifying active membership per request.
 * 4. Exposes safe active business context and list of accessible businesses to views.
 * ==============================================================================
 */

const prisma = require('../config/prisma');
const businessService = require('../services/business.service');
const businessProfileService = require('../services/businessProfile.service');

const BYPASS_PREFIXES = [
    '/login',
    '/logout',
    '/health',
    '/favicon.ico',
    '/assets',
    '/css',
    '/js',
    '/images'
];

async function businessContextMiddleware(req, res, next) {
    const path = req.path;
    for (const prefix of BYPASS_PREFIXES) {
        if (path === prefix || path.startsWith(prefix + '/')) {
            return next();
        }
    }

    if (!req.session || !req.session.user || !req.session.user.id) {
        return next();
    }

    try {
        const user = req.session.user;
        const accessibleBusinesses = await businessService.getUserAccessibleBusinesses(user.id, user.role);

        // Case 1: User has NO active business memberships
        if (accessibleBusinesses.length === 0 && user.role !== 'ADMIN') {
            if (req.xhr || req.path.startsWith('/api') || (req.headers['accept'] && req.headers['accept'].includes('application/json'))) {
                return res.status(403).json({
                    success: false,
                    error: 'You do not have active membership in any organization. Please contact your system administrator.'
                });
            }
            return res.status(403).render('auth/no-business', {
                pageTitle: 'No Business Access',
                user
            });
        }

        // Case 2: Resolve target active business ID
        let targetBusinessId = null;

        // Header or query override (e.g. for API or platform admin switching)
        const headerId = req.headers['x-business-id'] ? parseInt(req.headers['x-business-id'], 10) : null;
        const queryId = req.query && req.query.businessId ? parseInt(req.query.businessId, 10) : null;

        if (headerId && accessibleBusinesses.some(b => b.id === headerId)) {
            targetBusinessId = headerId;
        } else if (queryId && accessibleBusinesses.some(b => b.id === queryId)) {
            targetBusinessId = queryId;
        } else if (req.session.activeBusinessId) {
            const sessId = parseInt(req.session.activeBusinessId, 10);
            if (accessibleBusinesses.some(b => b.id === sessId)) {
                targetBusinessId = sessId;
            } else {
                // Active business in session is no longer accessible (revoked membership)
                req.session.activeBusinessId = null;
            }
        }

        // Case 3: If no valid business selected yet
        if (!targetBusinessId) {
            if (accessibleBusinesses.length === 1) {
                // Exactly 1 business -> Auto-select seamlessly
                targetBusinessId = accessibleBusinesses[0].id;
                req.session.activeBusinessId = targetBusinessId;
            } else if (accessibleBusinesses.length > 1) {
                // Check if user has a default business marked
                const defaultBiz = accessibleBusinesses.find(b => b.isDefault);
                if (defaultBiz) {
                    targetBusinessId = defaultBiz.id;
                    req.session.activeBusinessId = targetBusinessId;
                } else if (req.path === '/select-business' || req.path.startsWith('/switch-business')) {
                    // Allow access to selection routes
                    res.locals.accessibleBusinesses = accessibleBusinesses;
                    return next();
                } else if (user.role === 'ADMIN') {
                    // Explicit global platform administrator scope - distinct from any tenant
                    req.businessId = null;
                    req.business = null;
                    req.isGlobalAdminMode = true;
                    res.locals.isGlobalAdminMode = true;
                    res.locals.activeBusiness = {
                        id: 'global',
                        name: 'Global Platform Administration',
                        legalName: 'Global Platform Administration',
                        isGlobal: true,
                        currency: 'INR'
                    };
                    res.locals.activeBusinessId = 'global';
                    res.locals.accessibleBusinesses = accessibleBusinesses;
                    res.locals.branding = {
                        workspaceName: 'Global Platform Administration',
                        displayName: 'Global Platform Administration',
                        legalName: 'Global Platform Administration',
                        companyName: 'Platform Administration',
                        currency: 'INR'
                    };
                    return next();
                } else {
                    // Multiple businesses and no default -> require explicit selection
                    if (req.xhr || req.path.startsWith('/api') || (req.headers['accept'] && req.headers['accept'].includes('application/json'))) {
                        return res.status(400).json({
                            success: false,
                            code: 'BUSINESS_CONTEXT_REQUIRED',
                            error: 'Multiple businesses available and no active business selected. Please select a business or provide an authorized X-Business-Id header.'
                        });
                    } else {
                        return res.redirect('/select-business');
                    }
                }
            } else if (user.role === 'ADMIN') {
                // Platform admin with zero businesses -> explicit global platform mode
                req.businessId = null;
                req.business = null;
                req.isGlobalAdminMode = true;
                res.locals.isGlobalAdminMode = true;
                res.locals.activeBusiness = {
                    id: 'global',
                    name: 'Global Platform Administration',
                    legalName: 'Global Platform Administration',
                    isGlobal: true,
                    currency: 'INR'
                };
                res.locals.activeBusinessId = 'global';
                res.locals.accessibleBusinesses = accessibleBusinesses;
                return next();
            }
        }

        // Load active business record
        let activeBusiness = accessibleBusinesses.find(b => b.id === targetBusinessId);
        if (!activeBusiness && targetBusinessId) {
            activeBusiness = await prisma.business.findUnique({ where: { id: targetBusinessId } });
        }

        if (!activeBusiness) {
            if (user.role === 'ADMIN') {
                req.businessId = null;
                req.business = null;
                req.isGlobalAdminMode = true;
                res.locals.isGlobalAdminMode = true;
                return next();
            }
            if (req.xhr || req.path.startsWith('/api') || (req.headers['accept'] && req.headers['accept'].includes('application/json'))) {
                return res.status(400).json({
                    success: false,
                    code: 'BUSINESS_CONTEXT_REQUIRED',
                    error: 'Authorized business context is required.'
                });
            }
            return res.redirect('/select-business');
        }

        // Attach to request and response locals
        req.businessId = activeBusiness.id;
        req.business = activeBusiness;
        res.locals.activeBusiness = activeBusiness;
        res.locals.accessibleBusinesses = accessibleBusinesses;

        // Refresh branding in locals to match active business
        try {
            res.locals.branding = {
                workspaceName: activeBusiness.name,
                displayName: activeBusiness.name,
                legalName: activeBusiness.legalName || activeBusiness.name,
                companyName: activeBusiness.name,
                currency: activeBusiness.currency || 'INR',
                logoUrl: activeBusiness.logoUrl || null,
                gstin: activeBusiness.gstin || null,
                phone: activeBusiness.phone || null,
                email: activeBusiness.email || null,
                address: activeBusiness.address || null
            };
        } catch (_) {}

        next();
    } catch (err) {
        console.error('[BUSINESS_CONTEXT] Context resolution error:', err);
        next(err);
    }
}

module.exports = businessContextMiddleware;
