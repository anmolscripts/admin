exports.search = async (req, res, next) => {
    try {
        const query = req.query.q || '';
        // TODO: integrate actual search logic using services
        res.json({ query, results: [] });
    } catch (err) {
        next(err);
    }
};
