const express = require('express');
const authController = require('../controllers/auth.controller');
const { redirectIfAuthenticated } = require('../middleware/auth.middleware');
const { loginRateLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

// ==========================================
// Login Routes
// ==========================================
router.get('/login', redirectIfAuthenticated, authController.showLoginForm);
router.post('/login', redirectIfAuthenticated, loginRateLimiter, authController.login);

// ==========================================
// Logout Route (Only POST allowed)
// ==========================================
router.post('/logout', authController.logout);

// ==========================================
// User Invitation & Password Setup Routes
// ==========================================
const invitationController = require('../controllers/invitation.controller');
router.get('/invite/:token', redirectIfAuthenticated, invitationController.showSetupPasswordPage);
router.post('/invite/:token', redirectIfAuthenticated, invitationController.handleSetupPassword);

module.exports = router;