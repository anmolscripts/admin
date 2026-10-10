'use strict';

const express = require('express');
const requireAuth = require('../middleware/auth.middleware');
const searchController = require('../controllers/search.controller');

const router = express.Router();

// Authenticated search endpoint
router.get('/search', requireAuth, searchController.search);

module.exports = router;
