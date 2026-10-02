/**
 * Centralized error handling and 404 middleware.
 * Distinguishes between browser page requests and API requests.
 * Protects against leaking internal stack traces or environment paths in production.
 */

function notFound(req, res) {
    if (req.path.startsWith('/api') || req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(404).json({
            success: false,
            error: 'Not Found'
        });
    }

    res.status(404).render('errors/404', {
        pageTitle: 'Page Not Found'
    });
}

function errorHandler(err, req, res, next) {
    console.error(`[SERVER ERROR] ${req.method} ${req.originalUrl || req.url}:`, err.message || err);

    if (req.path.startsWith('/api') || req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(err.status || 500).json({
            success: false,
            error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
        });
    }

    res.status(err.status || 500).render('errors/500', {
        pageTitle: 'Server Error',
        error: process.env.NODE_ENV === 'development'
            ? err
            : null
    });
}

module.exports = {
    notFound,
    errorHandler
};