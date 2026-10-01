const crypto = require('crypto');

/**
 * Generate a new CSRF token and store it in session.
 * @param {object} req
 * @returns {string}
 */
function refreshCsrfToken(req) {
    if (!req.session) return '';
    const token = crypto.randomBytes(32).toString('hex');
    req.session.csrfToken = token;
    return token;
}

/**
 * CSRF Protection Middleware
 * Synchronizer Token Pattern using session-stored tokens.
 */
function csrfProtection(req, res, next) {
    if (!req.session) {
        return next(new Error('Session must be initialized before csrfProtection.'));
    }

    // Ensure session has a CSRF token
    if (!req.session.csrfToken) {
        refreshCsrfToken(req);
    }

    // Expose CSRF token to all templates via res.locals
    res.locals.csrfToken = req.session.csrfToken;

    // Safe HTTP methods do not mutate state
    const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
    if (safeMethods.includes(req.method.toUpperCase())) {
        return next();
    }

    // State-changing methods require validation
    const submittedToken =
        (req.body && req.body._csrf) ||
        req.headers['x-csrf-token'] ||
        req.headers['csrf-token'];

    if (!submittedToken || typeof submittedToken !== 'string') {
        return res.status(403).render('errors/500', {
            pageTitle: 'Forbidden',
            error: process.env.NODE_ENV === 'development'
                ? new Error('CSRF token missing or invalid.')
                : null
        });
    }

    // Constant-time token comparison
    const sessionTokenBuf = Buffer.from(req.session.csrfToken, 'utf-8');
    const submittedTokenBuf = Buffer.from(submittedToken, 'utf-8');

    if (
        sessionTokenBuf.length !== submittedTokenBuf.length ||
        !crypto.timingSafeEqual(sessionTokenBuf, submittedTokenBuf)
    ) {
        return res.status(403).render('errors/500', {
            pageTitle: 'Forbidden',
            error: process.env.NODE_ENV === 'development'
                ? new Error('Invalid CSRF token.')
                : null
        });
    }

    next();
}

module.exports = {
    csrfProtection,
    refreshCsrfToken
};
