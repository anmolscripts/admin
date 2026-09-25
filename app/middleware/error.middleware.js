function notFound(req, res) {
    res.status(404).render('errors/404', {
        pageTitle: 'Page Not Found'
    });
}

function errorHandler(err, req, res, next) {
    console.error(err);

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