'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — BUSINESS & MULTI-TENANCY CONTROLLER
 * ==============================================================================
 */

const businessService = require('../services/business.service');
const numberingService = require('../services/numbering.service');
const prisma = require('../config/prisma');

/**
 * Render business selection view for users with multiple businesses
 */
async function renderSelectBusiness(req, res, next) {
    try {
        const user = req.session.user;
        const accessibleBusinesses = await businessService.getUserAccessibleBusinesses(user.id, user.role);

        res.render('auth/select-business', {
            pageTitle: 'Select Organization',
            businesses: accessibleBusinesses,
            activeBusinessId: req.session.activeBusinessId || null,
            user
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Validates redirect target is a safe relative URL (rejects open redirects).
 */
function getSafeRedirectUrl(target) {
    if (!target || typeof target !== 'string') return '/';
    const trimmed = target.trim();
    // Must start with single slash; reject protocol-relative (//), backslash (\), and schemes (:)
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\') && !trimmed.includes('\\') && !trimmed.includes(':')) {
        return trimmed;
    }
    return '/';
}

/**
 * Switch active business context (CSRF-protected POST only)
 */
async function switchBusiness(req, res, next) {
    try {
        if (req.method === 'GET') {
            return res.status(405).json({
                success: false,
                error: 'State-changing GET business-switch is disabled. Please use CSRF-protected POST /switch-business.'
            });
        }

        const user = req.session ? req.session.user : null;
        if (!user || !user.id) {
            return res.status(401).json({ success: false, error: 'Unauthorized.' });
        }

        const rawTarget = req.body ? req.body.businessId : null;

        // Platform Admin can switch to explicit global mode
        if (rawTarget === 'global' || rawTarget === 0 || rawTarget === '0') {
            if (user.role !== 'ADMIN') {
                return res.status(403).json({ success: false, error: 'Only platform administrators can enter global mode.' });
            }
            req.session.activeBusinessId = null;
            req.session.isGlobalAdminMode = true;
            req.businessId = null;

            if (typeof req.session.save === 'function') {
                await new Promise((resolve, reject) => {
                    req.session.save((err) => (err ? reject(err) : resolve()));
                });
            }

            if (req.xhr || (req.headers && req.headers['content-type'] === 'application/json') || (req.path && req.path.startsWith('/api'))) {
                return res.json({ success: true, activeBusinessId: 'global', isGlobalAdminMode: true });
            }
            const redirectUrl = getSafeRedirectUrl((req.body && req.body.redirect) || req.query.redirect);
            return res.redirect(redirectUrl);
        }

        const targetId = parseInt(rawTarget, 10);
        if (isNaN(targetId) || targetId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid business ID.' });
        }

        // Revalidate target business exists and its status
        const business = await prisma.business.findUnique({
            where: { id: targetId }
        });
        if (!business) {
            return res.status(404).json({ success: false, error: 'Business not found.' });
        }

        // Non-platform-administrators can only access ACTIVE businesses with ACTIVE membership
        if (user.role !== 'ADMIN') {
            if (business.status !== 'ACTIVE') {
                return res.status(403).json({ success: false, error: 'Business is not active.' });
            }
            const membership = await prisma.businessMembership.findUnique({
                where: {
                    userId_businessId: {
                        userId: user.id,
                        businessId: targetId
                    }
                }
            });
            if (!membership || membership.status !== 'ACTIVE') {
                return res.status(403).json({ success: false, error: 'Access to this business is not authorized.' });
            }
        }

        req.session.activeBusinessId = targetId;
        req.session.isGlobalAdminMode = false;
        req.businessId = targetId; // Refresh active business context

        if (typeof req.session.save === 'function') {
            await new Promise((resolve, reject) => {
                req.session.save((err) => (err ? reject(err) : resolve()));
            });
        }

        // If requested via JSON API
        if (req.xhr || (req.headers && req.headers['content-type'] === 'application/json') || (req.path && req.path.startsWith('/api'))) {
            return res.json({ success: true, activeBusinessId: targetId });
        }

        // HTML redirect with open-redirect protection
        const redirectUrl = getSafeRedirectUrl((req.body && req.body.redirect) || req.query.redirect);
        return res.redirect(redirectUrl);
    } catch (err) {
        next(err);
    }
}

/**
 * Admin: Render Businesses Management Screen
 */
async function renderBusinessList(req, res, next) {
    try {
        const businesses = await businessService.listBusinesses({
            status: req.query.status || undefined,
            search: req.query.q || undefined
        });

        res.render('admin/businesses', {
            pageTitle: 'Organizations & Businesses',
            businesses,
            statusFilter: req.query.status || '',
            searchQuery: req.query.q || ''
        });
    } catch (err) {
        next(err);
    }
}

/**
 * API: List businesses for current user or platform admin
 */
async function listBusinesses(req, res, next) {
    try {
        const user = req.session.user;
        if (user && user.role === 'ADMIN') {
            const businesses = await businessService.listBusinesses({
                status: req.query.status || undefined,
                search: req.query.q || undefined
            });
            return res.json({ success: true, businesses });
        }
        const accessible = await businessService.getUserAccessibleBusinesses(user.id, user ? user.role : 'USER');
        return res.json({ success: true, businesses: accessible });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
}

/**
 * Admin: Create a new business
 */
async function createBusiness(req, res, next) {
    try {
        const newBiz = await businessService.createBusiness(req.body, req.session.user.id);
        if (req.xhr || req.path.startsWith('/api')) {
            return res.status(201).json({ success: true, business: newBiz });
        }
        res.redirect('/admin/businesses');
    } catch (err) {
        if (req.xhr || req.path.startsWith('/api')) {
            return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        }
        next(err);
    }
}

/**
 * Admin: Update business details or status
 */
async function updateBusiness(req, res, next) {
    try {
        const businessId = req.params.id;
        const updated = await businessService.updateBusiness(businessId, req.body, req.session.user.id);
        if (req.xhr || req.path.startsWith('/api')) {
            return res.json({ success: true, business: updated });
        }
        res.redirect('/admin/businesses');
    } catch (err) {
        if (req.xhr || req.path.startsWith('/api')) {
            return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        }
        next(err);
    }
}

/**
 * Admin: Archive business
 */
async function archiveBusiness(req, res, next) {
    try {
        const businessId = req.params.id;
        const updated = await businessService.archiveBusiness(businessId, req.session.user ? req.session.user.id : null);
        if (req.xhr || req.path.startsWith('/api')) {
            return res.json({ success: true, business: updated });
        }
        res.redirect('/admin/businesses');
    } catch (err) {
        if (req.xhr || req.path.startsWith('/api')) {
            return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        }
        next(err);
    }
}

/**
 * Admin: Suspend business
 */
async function suspendBusiness(req, res, next) {
    try {
        const businessId = req.params.id;
        const updated = await businessService.suspendBusiness(businessId, req.session.user ? req.session.user.id : null);
        if (req.xhr || req.path.startsWith('/api')) {
            return res.json({ success: true, business: updated });
        }
        res.redirect('/admin/businesses');
    } catch (err) {
        if (req.xhr || req.path.startsWith('/api')) {
            return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        }
        next(err);
    }
}

/**
 * Admin: Delete business (refused if retained financial/audit records exist)
 */
async function deleteBusiness(req, res, next) {
    try {
        const businessId = req.params.id;
        const result = await businessService.deleteBusiness(businessId, req.session.user ? req.session.user.id : null);
        if (req.xhr || req.path.startsWith('/api')) {
            return res.json(result);
        }
        res.redirect('/admin/businesses');
    } catch (err) {
        if (req.xhr || req.path.startsWith('/api')) {
            return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        }
        next(err);
    }
}

/**
 * Admin / Settings: Render Numbering Configuration Screen
 */
async function renderNumberingConfig(req, res, next) {
    try {
        const user = req.session.user;
        let targetBusinessId = req.query.businessId ? parseInt(req.query.businessId, 10) : req.businessId;

        if (!targetBusinessId || isNaN(targetBusinessId)) {
            const accessible = await businessService.getUserAccessibleBusinesses(user.id, user.role);
            targetBusinessId = accessible.length > 0 ? accessible[0].id : 1;
        }

        const isPlatformAdmin = user && user.role === 'ADMIN';

        // Authorization check: platform admin or active manager/owner in business
        if (!isPlatformAdmin) {
            const membership = await prisma.businessMembership.findUnique({
                where: {
                    userId_businessId: {
                        userId: user.id,
                        businessId: targetBusinessId
                    }
                }
            });
            if (!membership || membership.status !== 'ACTIVE' || !['OWNER', 'ADMIN', 'MANAGER'].includes(membership.role)) {
                return res.status(403).render('errors/403', {
                    pageTitle: 'Access Forbidden',
                    message: 'You do not have permission to view or manage numbering sequences for this organization.'
                });
            }
        }

        const business = await businessService.getBusinessById(targetBusinessId);
        if (!business) {
            return res.status(404).render('errors/404', { pageTitle: 'Business Not Found' });
        }

        // Fetch custom prefix configs
        const customPrefixes = await prisma.businessPrefixConfig.findMany({
            where: { businessId: targetBusinessId }
        });
        const prefixMap = {};
        for (const cp of customPrefixes) {
            prefixMap[cp.entityType] = cp.prefix;
        }

        // Fetch active sequences for current year/month
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const monthStr = String(currentMonth).padStart(2, '0');

        const seqRows = await prisma.numberingSequence.findMany({
            where: { businessId: targetBusinessId },
            orderBy: [{ year: 'desc' }, { month: 'desc' }, { entityType: 'asc' }]
        });

        const activeSequences = (seqRows || []).map(s => ({
            entityType: s.entityType,
            year: s.year,
            month: s.month,
            currentIncrement: s.currentNumber ? s.currentNumber.toString() : '0'
        }));

        const canonicalList = numberingService.CANONICAL_ENTITIES || Object.keys(numberingService.DEFAULT_PREFIXES);
        const prefixes = canonicalList.map((entityType) => {
            const defaultPrefix = numberingService.DEFAULT_PREFIXES[entityType] || entityType;
            const currentPrefix = prefixMap[entityType] || defaultPrefix;
            const description = numberingService.ENTITY_DESCRIPTIONS[entityType] || `${entityType} document series`;
            const sample = `${currentPrefix}/${currentYear}/${monthStr}/1`;

            return {
                entityType,
                description,
                prefix: currentPrefix,
                sample
            };
        });

        const csrfToken = req.csrfToken ? req.csrfToken() : (res.locals.csrfToken || '');

        res.render('admin/numbering', {
            pageTitle: 'Document Numbering & Sequences',
            business,
            businessId: targetBusinessId,
            prefixes,
            activeSequences,
            csrfToken,
            currentYear,
            currentMonth,
            success: req.query.success || null
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Admin / Settings: Update entity prefix configuration
 */
async function updatePrefixConfig(req, res, next) {
    try {
        const user = req.session.user;
        const targetBusinessId = req.params.id
            ? parseInt(req.params.id, 10)
            : (req.body.businessId ? parseInt(req.body.businessId, 10) : req.businessId);

        if (!targetBusinessId || isNaN(targetBusinessId)) {
            return res.status(400).json({ success: false, error: 'Valid business ID is required.' });
        }

        // Authorization check: platform admin or business OWNER/ADMIN/MANAGER
        const isPlatformAdmin = user && user.role === 'ADMIN';
        if (!isPlatformAdmin) {
            const membership = await prisma.businessMembership.findUnique({
                where: {
                    userId_businessId: {
                        userId: user.id,
                        businessId: targetBusinessId
                    }
                }
            });
            if (!membership || membership.status !== 'ACTIVE' || !['OWNER', 'ADMIN', 'MANAGER'].includes(membership.role)) {
                if (req.xhr || req.headers['accept']?.includes('application/json')) {
                    return res.status(403).json({
                        success: false,
                        error: 'Unauthorized: Only business administrators and owners can update numbering prefixes.'
                    });
                }
                return res.status(403).render('errors/403', {
                    pageTitle: 'Access Forbidden',
                    message: 'You do not have permission to modify numbering prefixes for this organization.'
                });
            }
        }

        const { entityType, prefix } = req.body;
        if (!entityType || !prefix) {
            if (req.xhr || req.headers['accept']?.includes('application/json')) {
                return res.status(400).json({ success: false, error: 'entityType and prefix are required.' });
            }
            return res.redirect(`/admin/numbering?businessId=${targetBusinessId}`);
        }

        const updated = await numberingService.setPrefixForEntity(targetBusinessId, entityType, prefix);

        if (req.xhr || req.headers['accept']?.includes('application/json')) {
            return res.json({ success: true, config: updated });
        }
        res.redirect(`/admin/numbering?businessId=${targetBusinessId}&success=Prefix+updated+successfully`);
    } catch (err) {
        if (req.xhr || req.headers['accept']?.includes('application/json')) {
            return res.status(err.statusCode || 400).json({ success: false, error: err.message });
        }
        next(err);
    }
}

/**
 * Admin: List business members
 */
async function listBusinessMembers(req, res, next) {
    try {
        const businessId = req.params.id;
        const members = await businessService.listBusinessMembers(businessId);
        res.json({ success: true, members });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
}

/**
 * Admin: Set member role
 */
async function setMemberRole(req, res, next) {
    try {
        const businessId = req.params.id;
        const { userId, role } = req.body;
        const membership = await businessService.setBusinessMembership(businessId, userId, role, req.session.user.id);
        res.json({ success: true, membership });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
}

/**
 * Admin: Revoke member access
 */
async function revokeMemberAccess(req, res, next) {
    try {
        const businessId = req.params.id;
        const userId = req.params.userId || req.body.userId;
        await businessService.revokeBusinessMembership(businessId, userId, req.session.user.id);
        res.json({ success: true, message: 'Membership access revoked.' });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
}

module.exports = {
    renderSelectBusiness,
    switchBusiness,
    renderBusinessList,
    listBusinesses,
    createBusiness,
    updateBusiness,
    renderNumberingConfig,
    updatePrefixConfig,
    listBusinessMembers,
    setMemberRole,
    revokeMemberAccess,
    archiveBusiness,
    suspendBusiness,
    deleteBusiness,
    getSafeRedirectUrl
};
