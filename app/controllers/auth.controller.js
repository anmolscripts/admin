const crypto = require('node:crypto');
const authService = require('../services/auth.service');
const { refreshCsrfToken } = require('../middleware/csrf.middleware');
const { recordFailedLogin, resetLoginAttempts } = require('../middleware/rateLimit.middleware');
const { SESSION_COOKIE_NAME, cookieOptions } = require('../config/session');
const { isValidRedirectUrl } = require('../middleware/auth.middleware');
const prisma = require('../config/prisma');
const activityService = require('../services/activity.service');
const businessService = require('../services/business.service');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateRememberToken(userId) {
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const secret = process.env.SESSION_SECRET || 'spark-admin-dev-secret-key-change-in-prod-32chars';
    const signature = crypto.createHmac('sha256', secret).update(`${userId}:${expiresAt}`).digest('hex');
    return `${userId}.${expiresAt}.${signature}`;
}

/**
 * Render Login Page
 */
function showLoginForm(req, res) {
    let success = null;
    if (req.query && req.query.setup === 'success') {
        success = 'Password successfully configured! Please sign in with your credentials.';
    }
    const rawReturnTo = (req.query && req.query.returnTo) || (req.session && req.session.returnTo) || '';
    const returnTo = isValidRedirectUrl(rawReturnTo) ? rawReturnTo : '';

    res.render('auth/login', {
        pageTitle: 'Login',
        error: null,
        success,
        email: '',
        returnTo
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

        // Determine returnTo and rememberMe prior to session regeneration
        const rawReturnTo = (req.body && req.body.returnTo) || (req.session && req.session.returnTo) || (req.query && req.query.returnTo) || '';
        const returnTo = isValidRedirectUrl(rawReturnTo) ? rawReturnTo : '';
        const rememberMe = req.body && (req.body.rememberMe === 'true' || req.body.rememberMe === 'on' || req.body.rememberMe === '1' || req.body.rememberMe === true);

        // Prevent session fixation by regenerating session
        if (typeof req.session.regenerate === 'function') {
            await new Promise((resolve, reject) => {
                req.session.regenerate((err) => (err ? reject(err) : resolve()));
            });
        }

        // Store minimal, safe user data in session (NEVER store password/hash)
        req.session.user = {
            id: result.user.id,
            name: result.user.name,
            email: result.user.email,
            role: result.user.role
        };

        // If rememberMe was requested, extend session lifetime and issue persistent remember cookie
        if (rememberMe) {
            if (req.session.cookie) {
                req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
            }
            const rememberToken = generateRememberToken(result.user.id);
            res.cookie('spark_remember', rememberToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production' ? 'auto' : false,
                sameSite: 'lax',
                maxAge: 30 * 24 * 60 * 60 * 1000,
                path: '/'
            });
        }

        // Automatic business selection / routing
        let redirectUrl = returnTo || '/';
        try {
            const accessibleBusinesses = await businessService.getUserAccessibleBusinesses(result.user.id, result.user.role);
            if (accessibleBusinesses.length === 1) {
                req.session.activeBusinessId = accessibleBusinesses[0].id;
            } else if (accessibleBusinesses.length > 1) {
                const defaultBiz = accessibleBusinesses.find(b => b.isDefault);
                if (defaultBiz) {
                    req.session.activeBusinessId = defaultBiz.id;
                } else if (result.user.role === 'ADMIN') {
                    req.session.activeBusinessId = accessibleBusinesses.find(b => b.id === 1)?.id || accessibleBusinesses[0].id;
                } else {
                    if (!returnTo) {
                        redirectUrl = '/select-business';
                    } else {
                        req.session.activeBusinessId = accessibleBusinesses[0].id;
                    }
                }
            } else if (result.user.role === 'ADMIN') {
                req.session.activeBusinessId = 1;
            }
        } catch (bizErr) {
            console.warn('[AUTH] Warning resolving accessible businesses:', bizErr.message);
        }

        // Issue new CSRF token for the authenticated session
        refreshCsrfToken(req);

        if (typeof req.session.save === 'function') {
            await new Promise((resolve, reject) => {
                req.session.save((err) => (err ? reject(err) : resolve()));
            });
        }

        res.redirect(redirectUrl);
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
    res.clearCookie('spark_remember', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production' ? 'auto' : false,
        sameSite: 'lax',
        path: '/'
    });

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
