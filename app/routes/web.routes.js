const express = require('express');
const requireAuth = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
    res.render('dashboard/index', {
        pageTitle: 'Dashboard'
    });
});

module.exports = router;