const express = require('express');
const searchController = require('../controllers/search.controller');

const router = express.Router();

// Simple GET search endpoint
router.get('/search', searchController.search);

module.exports = router;
