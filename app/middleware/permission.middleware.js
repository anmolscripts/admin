const rbacService = require('../services/rbac.service');
const activityService = require('../services/activity.service');

function isApiOrJsonRequest(req) {
    if (req.originalUrl && req.originalUrl.startsWith('/api')) return true;
    if (req.xhr) return true;
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) return true;
    return false;
}

/**
 * Global middleware that attaches resolved permissions and helpers to req and res.locals
 */
async function attachUserPermissions(req, res, next) {
    if (req.session && req.session.user && req.session.user.id) {
        try {
            const perms = await rbacService.getUserEffectivePermissions(req.session.user.id);
            req.userPermissions = perms;
            req.hasPermission = (mod, act) => perms.hasPermission(mod, act);
            res.locals.userPermissions = perms;
            res.locals.hasPermission = (mod, act) => perms.hasPermission(mod, act);
        } catch (err) {
            console.error('[RBAC] Error resolving user permissions:', err);
            req.userPermissions = null;
            req.hasPermission = () => false;
            res.locals.userPermissions = null;
            res.locals.hasPermission = () => false;
        }
    } else {
        req.userPermissions = null;
        req.hasPermission = () => false;
        res.locals.userPermissions = null;
        res.locals.hasPermission = () => false;
    }
    next();
}

/**
 * Authorisation middleware enforcing specific module and action permissions.
 * Example: requirePermission('DOCUMENTS', 'VIEW')
 *          requirePermission('TEAM', 'MANAGE')
 */
function requirePermission(moduleName, actionName) {
    return async (req, res, next) => {
        // 1. Authentication check
        if (!req.session || !req.session.user || !req.session.user.id) {
            if (isApiOrJsonRequest(req)) {
                return res.status(401).json({
                    success: false,
                    error: 'Authentication required.'
                });
            }
            return res.redirect('/login');
        }

        const userId = req.session.user.id;

        try {
            // 2. Resolve effective permissions
            const perms = await rbacService.getUserEffectivePermissions(userId);

            // 3. User account status check
            if (!perms.userId || req.session.user.status === 'INACTIVE') {
                await activityService.log({
                    actorUserId: userId,
                    action: 'AUTHENTICATION_FAILURE',
                    module: 'SECURITY',
                    targetReference: req.session.user.email,
                    ipAddress: req.ip,
                    userAgent: req.headers['user-agent'],
                    metadata: { reason: 'INACTIVE_ACCOUNT_BLOCKED' }
                });

                req.session.destroy(() => {});
                if (isApiOrJsonRequest(req)) {
                    return res.status(403).json({
                        success: false,
                        error: 'Your account is currently inactive.'
                    });
                }
                return res.redirect('/login?error=inactive');
            }

            // Attach to request
            req.userPermissions = perms;
            req.hasPermission = (mod, act) => perms.hasPermission(mod, act);
            res.locals.userPermissions = perms;
            res.locals.hasPermission = (mod, act) => perms.hasPermission(mod, act);

            // 4. Permission check
            const hasAccess = perms.hasPermission(moduleName, actionName);

            if (!hasAccess) {
                // Log security audit event
                await activityService.log({
                    actorUserId: userId,
                    action: 'PERMISSION_DENIED',
                    module: String(moduleName).toUpperCase(),
                    targetType: 'ROUTE',
                    targetId: req.path,
                    targetReference: `${moduleName}:${actionName}`,
                    ipAddress: req.ip,
                    userAgent: req.headers['user-agent'],
                    metadata: {
                        method: req.method,
                        url: req.originalUrl,
                        roleName: perms.roleName
                    }
                });

                if (isApiOrJsonRequest(req)) {
                    return res.status(403).json({
                        success: false,
                        error: 'Access denied: Insufficient permissions to perform this operation.'
                    });
                }

                return res.status(403).render('errors/403', {
                    pageTitle: 'Access Denied',
                    requiredModule: moduleName,
                    requiredAction: actionName
                });
            }

            // User is authorized
            next();
        } catch (err) {
            console.error('[RBAC] Error in requirePermission middleware:', err);
            return res.status(500).render('errors/500', {
                pageTitle: 'Authorization Error',
                error: process.env.NODE_ENV === 'development' ? err : null
            });
        }
    };
}

module.exports = {
    attachUserPermissions,
    requirePermission
};
