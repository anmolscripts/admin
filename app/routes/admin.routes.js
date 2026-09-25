const express = require('express');
const requireAuth = require('../middleware/auth.middleware');

const router = express.Router();

router.get('/tables/basic', requireAuth, (req, res) => {
    res.render('tables/basic', {
        pageTitle: 'Basic Tables'
    });
});

router.get('/ui/buttons', requireAuth, (req, res) => {
    res.render('ui/buttons', {
        pageTitle: 'Buttons'
    });
});

router.get('/ui/forms', requireAuth, (req, res) => {
    res.render('ui/forms', {
        pageTitle: 'Forms'
    });
});

module.exports = router;