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
    res.statusCode=err.statusCode||err.status||500;
    require('./requestLog.middleware').logFailure(req,res,res.statusCode<500?err.message:'Internal server error',err);
    console.error(`[SERVER ERROR] ${req.method} ${req.originalUrl || req.url}:`, err.message || err);

    if (err.name === 'MulterError' || err.code === 'INVALID_FILE_TYPE') {
        const status = err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : (err.code === 'INVALID_FILE_TYPE' ? 415 : 400));
        return res.status(status).json({
            success: false,
            error: err.message
        });
    }

    if (req.path.startsWith('/api') || req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(err.statusCode || err.status || 500).json({
            success: false,
            error: (err.statusCode >= 400 && err.statusCode < 500) || process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.'
        });
    }

    res.status(err.statusCode || err.status || 500).render('errors/500', {
        statusCode:err.statusCode || err.status || 500,
        errorMessage:(err.statusCode || err.status)<500?err.message:null,
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
