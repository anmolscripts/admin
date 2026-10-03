const authService = require('../services/auth.service');
const { refreshCsrfToken } = require('../middleware/csrf.middleware');
const { recordFailedLogin, resetLoginAttempts } = require('../middleware/rateLimit.middleware');
const { SESSION_COOKIE_NAME, cookieOptions } = require('../config/session');
const prisma = require('../config/prisma');
const activityService = require('../services/activity.service');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Render Login Page
 */
function showLoginForm(req, res) {
    res.render('auth/login', {
        pageTitle: 'Login',
        error: null,
        email: ''
    });
}

/**
 * Handle Login Form Submission
 */
async function login(req, res, next) {
    try {
        const rawEmail = req.body && req.body.email;
        const rawPassword = req.body && req.body.password;

        const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
        const password = typeof rawPassword === 'string' ? rawPassword : '';

        // Validate presence of credentials
        if (!email || !password) {
            return res.status(400).render('auth/login', {
                pageTitle: 'Login',
                error: 'Email and password are required.',
                email
            });
        }

        // Validate email format
        if (!EMAIL_REGEX.test(email)) {
            return res.status(400).render('auth/login', {
                pageTitle: 'Login',
                error: 'Please enter a valid email address.',
                email
            });
        }

        // Authenticate with service
        const result = await authService.authenticateUser(email, password);

        if (!result.success) {
            recordFailedLogin(req);
            console.warn(`[AUTH] Failed login attempt for user: ${email} (reason: ${result.reason})`);

            // Audit failed login attempt
            await activityService.log({
                action: 'LOGIN_FAILED',
                module: 'AUTHENTICATION',
                targetReference: email,
                ipAddress: req.ip,
                userAgent: req.headers ? req.headers['user-agent'] : null,
                metadata: { reason: result.reason }
            });

            // Generic error message to prevent user enumeration
            return res.status(401).render('auth/login', {
                pageTitle: 'Login',
                error: 'Invalid email or password.',
                email
            });
        }

        // Authentication succeeded; clear failed attempt counter
        resetLoginAttempts(req);

        // Update lastLoginAt
        try {
            await prisma.user.update({
                where: { id: result.user.id },
                data: { lastLoginAt: new Date() }
            });
        } catch (_) {}

        // Audit successful login
        await activityService.log({
            actorUserId: result.user.id,
            action: 'LOGIN',
            module: 'AUTHENTICATION',
            targetReference: result.user.email,
            ipAddress: req.ip,
            userAgent: req.headers ? req.headers['user-agent'] : null
        });

        // Prevent session fixation by regenerating session
        req.session.regenerate((err) => {
            if (err) {
                console.error('[AUTH] Session regeneration failure:', err);
                return next(err);
            }

            // Store minimal, safe user data in session (NEVER store password/hash)
            req.session.user = {
                id: result.user.id,
                name: result.user.name,
                email: result.user.email,
                role: result.user.role
            };

            // Issue new CSRF token for the authenticated session
            refreshCsrfToken(req);

            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('[AUTH] Session save failure:', saveErr);
                    return next(saveErr);
                }
                res.redirect('/');
            });
        });
    } catch (error) {
        console.error('[AUTH] Unexpected authentication error:', error);
        return res.status(500).render('errors/500', {
            pageTitle: 'Server Error',
            error: process.env.NODE_ENV === 'development' ? error : null
        });
    }
}

/**
 * Handle Logout
 */
async function logout(req, res, next) {
    if (!req.session) {
        res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
        return res.redirect('/login');
    }

    const userId = req.session.user ? req.session.user.id : null;
    const userEmail = req.session.user ? req.session.user.email : null;

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'LOGOUT',
            module: 'AUTHENTICATION',
            targetReference: userEmail,
            ipAddress: req.ip,
            userAgent: req.headers ? req.headers['user-agent'] : null
        });
    }

    req.session.destroy((err) => {
        if (err) {
            console.error('[AUTH] Error destroying session on logout:', err);
            return next(err);
        }

        res.clearCookie(SESSION_COOKIE_NAME, cookieOptions);
        res.redirect('/login');
    });
}

module.exports = {
    showLoginForm,
    login,
    logout
};
