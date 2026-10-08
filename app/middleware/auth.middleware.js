/**
 * Authentication Middleware
 * Protects web routes by requiring an authenticated user session.
 */
function requireAuth(req, res, next) {
    if (!req.session || !req.session.user || !req.session.user.id) {
        if ((req.originalUrl && req.originalUrl.startsWith('/api')) || req.xhr || (req.headers['accept'] && req.headers['accept'].includes('application/json'))) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required.'
            });
        }
        return res.redirect('/login');
    }
    next();
}

/**
 * Guest Middleware
 * Redirects already-authenticated users away from auth pages (e.g., /login) to dashboard.
 */
function redirectIfAuthenticated(req, res, next) {
    if (req.session && req.session.user && req.session.user.id) {
        return res.redirect('/');
    }
    next();
}

/**
 * Role-based Authorization Middleware
 * Verifies that the authenticated user possesses one of the allowed roles.
 * @param  {...string} roles
 */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.session || !req.session.user || !req.session.user.id) {
            return res.redirect('/login');
        }

        const userRole = req.session.user.role;
        if (!roles.includes(userRole)) {
            return res.status(403).render('errors/500', {
                pageTitle: 'Forbidden',
                error: process.env.NODE_ENV === 'development' ? new Error('Access Denied: Insufficient permissions.') : null
            });
        }

        next();
    };
}

// Backward-compatible exports
module.exports = requireAuth;
module.exports.requireAuth = requireAuth;
module.exports.redirectIfAuthenticated = redirectIfAuthenticated;
module.exports.requireRole = requireRole;