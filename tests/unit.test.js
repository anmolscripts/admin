const { describe, it } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcrypt');
const authService = require('../app/services/auth.service');
const { requireRole, redirectIfAuthenticated } = require('../app/middleware/auth.middleware');
const { csrfProtection } = require('../app/middleware/csrf.middleware');
const { loginRateLimiter, recordFailedLogin, resetLoginAttempts } = require('../app/middleware/rateLimit.middleware');

describe('Authentication Unit & Middleware Tests', () => {

    describe('auth.service', () => {
        it('should correctly normalise email with spaces and mixed case', () => {
            const raw = '   Admin.User@Example.COM   ';
            const normalized = authService.normalizeEmail(raw);
            assert.strictEqual(normalized, 'admin.user@example.com');
        });

        it('should handle non-string email inputs safely', () => {
            assert.strictEqual(authService.normalizeEmail(null), '');
            assert.strictEqual(authService.normalizeEmail(undefined), '');
            assert.strictEqual(authService.normalizeEmail(123), '');
        });

        it('should hash password with bcrypt', async () => {
            const password = 'TestSecretPassword123!';
            const hash = await authService.hashPassword(password);
            assert.ok(hash.startsWith('$2b$12$') || hash.startsWith('$2b$10$'));
            const matches = await bcrypt.compare(password, hash);
            assert.strictEqual(matches, true);
        });

        it('should reject hashing empty or invalid passwords', async () => {
            await assert.rejects(async () => {
                await authService.hashPassword('');
            }, /Password must be a non-empty string/);
        });

        it('should reject authentication if email or password are missing', async () => {
            const result1 = await authService.authenticateUser('', 'pass');
            assert.strictEqual(result1.success, false);
            assert.strictEqual(result1.reason, 'MISSING_CREDENTIALS');

            const result2 = await authService.authenticateUser('user@example.com', '');
            assert.strictEqual(result2.success, false);
            assert.strictEqual(result2.reason, 'MISSING_CREDENTIALS');
        });
    });

    describe('auth.middleware', () => {
        it('redirectIfAuthenticated redirects logged-in user to /', () => {
            let redirectedTo = null;
            const req = { session: { user: { id: 1 } } };
            const res = { redirect: (url) => { redirectedTo = url; } };
            redirectIfAuthenticated(req, res, () => {
                assert.fail('next() should not be called');
            });
            assert.strictEqual(redirectedTo, '/');
        });

        it('redirectIfAuthenticated calls next() for guests', () => {
            let nextCalled = false;
            const req = { session: {} };
            const res = {};
            redirectIfAuthenticated(req, res, () => {
                nextCalled = true;
            });
            assert.strictEqual(nextCalled, true);
        });

        it('requireRole allows users with matching role', () => {
            let nextCalled = false;
            const req = { session: { user: { id: 1, role: 'ADMIN' } } };
            const res = {};
            const middleware = requireRole('ADMIN', 'SUPERADMIN');
            middleware(req, res, () => {
                nextCalled = true;
            });
            assert.strictEqual(nextCalled, true);
        });

        it('requireRole returns 403 for users without matching role', () => {
            let statusSet = null;
            const req = { session: { user: { id: 1, role: 'USER' } } };
            const res = {
                status(code) {
                    statusSet = code;
                    return this;
                },
                render() {}
            };
            const middleware = requireRole('ADMIN');
            middleware(req, res, () => {
                assert.fail('next() should not be called');
            });
            assert.strictEqual(statusSet, 403);
        });
    });

    describe('csrf.middleware', () => {
        it('blocks state-changing requests missing CSRF token with 403', () => {
            let statusSet = null;
            const req = {
                method: 'POST',
                session: { csrfToken: 'valid-secret-token' },
                body: {},
                headers: {}
            };
            const res = {
                locals: {},
                status(code) {
                    statusSet = code;
                    return this;
                },
                render() {}
            };

            csrfProtection(req, res, () => {
                assert.fail('next() should not be called when token missing');
            });
            assert.strictEqual(statusSet, 403);
        });

        it('allows state-changing requests with matching CSRF token', () => {
            let nextCalled = false;
            const req = {
                method: 'POST',
                session: { csrfToken: 'valid-secret-token' },
                body: { _csrf: 'valid-secret-token' },
                headers: {}
            };
            const res = { locals: {} };

            csrfProtection(req, res, () => {
                nextCalled = true;
            });
            assert.strictEqual(nextCalled, true);
        });
    });

    describe('rateLimit.middleware', () => {
        it('blocks requests after exceeding 10 failed login attempts with 429', () => {
            const req = {
                ip: '192.168.1.100',
                body: { email: 'brute@example.com' },
                socket: {}
            };

            resetLoginAttempts(req);

            // Record 10 failed attempts
            for (let i = 0; i < 10; i++) {
                recordFailedLogin(req);
            }

            let statusSet = null;
            let retryHeader = null;
            const res = {
                setHeader(name, val) {
                    if (name === 'Retry-After') retryHeader = val;
                },
                status(code) {
                    statusSet = code;
                    return this;
                },
                render() {}
            };

            loginRateLimiter(req, res, () => {
                assert.fail('next() should not be called when rate limit is exceeded');
            });

            assert.strictEqual(statusSet, 429);
            assert.ok(retryHeader > 0);

            // Reset and check it allows again
            resetLoginAttempts(req);
            let nextAllowed = false;
            loginRateLimiter(req, res, () => {
                nextAllowed = true;
            });
            assert.strictEqual(nextAllowed, true);
        });
    });
});
