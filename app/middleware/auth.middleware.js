const crypto = require('node:crypto');
const prisma = require('../config/prisma');
const businessService = require('../services/business.service');

/**
 * Validate that a redirect URL is safe (internal, relative, and not auth loop)
 */
function isValidRedirectUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
        return false;
    }
    if (
        trimmed.startsWith('/login') ||
        trimmed.startsWith('/logout') ||
        trimmed.startsWith('/invite') ||
        trimmed.startsWith('/health') ||
        trimmed.startsWith('/css') ||
        trimmed.startsWith('/js') ||
        trimmed.startsWith('/images') ||
        trimmed.startsWith('/libs')
    ) {
        return false;
    }
    return true;
}

/**
 * Helper to parse cookies from raw Cookie header
 */
function parseCookies(rawHeader) {
    const list = {};
    if (!rawHeader) return list;
    rawHeader.split(';').forEach(cookie => {
        const parts = cookie.split('=');
        if (parts.length >= 2) {
            list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
        }
    });
    return list;
}

/**
 * Attempt auto-login using the persistent signed `spark_remember` cookie
 */
async function tryAutoLogin(req) {
    if (req.session && req.session.user && req.session.user.id) {
        return true;
    }
    const rawHeader = req.headers && req.headers.cookie;
    if (!rawHeader) return false;

    const cookies = parseCookies(rawHeader);
    const rememberToken = cookies['spark_remember'];
    if (!rememberToken) return false;

    const parts = rememberToken.split('.');
    if (parts.length !== 3) return false;

    const [userIdStr, expiresAtStr, signature] = parts;
    const userId = parseInt(userIdStr, 10);
    const expiresAt = parseInt(expiresAtStr, 10);

    if (isNaN(userId) || isNaN(expiresAt) || expiresAt < Date.now()) {
        return false;
    }

    const secret = process.env.SESSION_SECRET || 'spark-admin-dev-secret-key-change-in-prod-32chars';
    const expectedSignature = crypto.createHmac('sha256', secret).update(`${userId}:${expiresAt}`).digest('hex');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return false;
    }

    try {
        const user = await prisma.user.findUnique({
            where: { id: userId }
        });

        if (!user || !user.active) {
            return false;
        }

        if (!req.session) {
            req.session = {};
        }

        req.session.user = {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role
        };

        if (req.session.cookie) {
            req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
        }

        const accessibleBusinesses = await businessService.getUserAccessibleBusinesses(user.id, user.role);
        if (accessibleBusinesses.length === 1) {
            req.session.activeBusinessId = accessibleBusinesses[0].id;
        } else if (accessibleBusinesses.length > 1) {
            const defaultBiz = accessibleBusinesses.find(b => b.isDefault);
            req.session.activeBusinessId = defaultBiz ? defaultBiz.id : accessibleBusinesses[0].id;
        } else if (user.role === 'ADMIN') {
            req.session.activeBusinessId = 1;
        }

        return true;
    } catch (err) {
        console.warn('[AUTH] Error during auto-login from remember cookie:', err.message);
        return false;
    }
}

/**
 * Handle unauthenticated requests with API check and returnTo logic
 */
function handleUnauthenticated(req, res) {
    if ((req.originalUrl && req.originalUrl.startsWith('/api')) || req.xhr || (req.headers && req.headers['accept'] && req.headers['accept'].includes('application/json'))) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required.'
        });
    }
    const requestedUrl = req.originalUrl;
    if (req.method === 'GET' && requestedUrl && requestedUrl !== '/' && isValidRedirectUrl(requestedUrl)) {
        if (req.session) {
            req.session.returnTo = requestedUrl;
        }
    }
    return res.redirect('/login');
}

/**
 * Authentication Middleware
 * Protects web routes by requiring an authenticated user session.
 */
function requireAuth(req, res, next) {
    if (req.session && req.session.user && req.session.user.id) {
        return next();
    }

    const hasRememberCookie = Boolean(req.headers && req.headers.cookie && req.headers.cookie.includes('spark_remember'));
    if (!hasRememberCookie) {
        return handleUnauthenticated(req, res);
    }

    tryAutoLogin(req).then((loggedIn) => {
        if (loggedIn && req.session && req.session.user && req.session.user.id) {
            return next();
        }
        return handleUnauthenticated(req, res);
    }).catch(() => {
        return handleUnauthenticated(req, res);
    });
}

/**
 * Guest Middleware
 * Redirects already-authenticated users away from auth pages (e.g., /login) to destination or dashboard.
 */
function redirectIfAuthenticated(req, res, next) {
    if (req.session && req.session.user && req.session.user.id) {
        const rawReturnTo = (req.query && req.query.returnTo) || (req.session && req.session.returnTo) || '';
        const returnTo = (rawReturnTo && rawReturnTo !== '/' && isValidRedirectUrl(rawReturnTo)) ? rawReturnTo : '/';
        if (req.session && req.session.returnTo) {
            delete req.session.returnTo;
        }
        return res.redirect(returnTo);
    }

    const hasRememberCookie = Boolean(req.headers && req.headers.cookie && req.headers.cookie.includes('spark_remember'));
    if (!hasRememberCookie) {
        return next();
    }

    tryAutoLogin(req).then(() => {
        if (req.session && req.session.user && req.session.user.id) {
            const rawReturnTo = (req.query && req.query.returnTo) || (req.session && req.session.returnTo) || '';
            const returnTo = (rawReturnTo && rawReturnTo !== '/' && isValidRedirectUrl(rawReturnTo)) ? rawReturnTo : '/';
            if (req.session && req.session.returnTo) {
                delete req.session.returnTo;
            }
            return res.redirect(returnTo);
        }
        next();
    }).catch(() => {
        next();
    });
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
module.exports.isValidRedirectUrl = isValidRedirectUrl;
module.exports.parseCookies = parseCookies;