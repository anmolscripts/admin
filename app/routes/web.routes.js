const express = require('express');
const requireAuth = require('../middleware/auth.middleware');

const router = express.Router();

// Main authenticated application screen: Quotations & Invoices Listing
router.get('/', requireAuth, (req, res) => {
    res.render('documents/index', {
        pageTitle: 'Quotations & Invoices'
    });
});

router.get('/documents', requireAuth, (req, res) => {
    res.render('documents/index', {
        pageTitle: 'Quotations & Invoices'
    });
});

router.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard/index', {
        pageTitle: 'Dashboard'
    });
});

module.exports = router;