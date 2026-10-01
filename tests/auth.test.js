const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bcrypt = require('bcrypt');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const authService = require('../app/services/auth.service');
const authController = require('../app/controllers/auth.controller');

describe('Authentication Module Test Suite', () => {
    let server;
    let baseUrl;
    const testAdminEmail = 'admin@email.com';
    const testAdminPassword = process.env.SEED_ADMIN_PASSWORD || 'choose-a-local-development-password';
    const inactiveUserEmail = 'inactive-test-user@email.com';

    // Helper to extract cookie from Response headers
    function extractCookie(res) {
        const setCookie = res.headers.get('set-cookie');
        if (!setCookie) return null;
        // set-cookie can contain multiple cookies separated by comma or just one
        const match = setCookie.match(/spark\.sid=[^;]+/);
        return match ? match[0] : null;
    }

    // Helper to extract CSRF token from HTML
    function extractCsrfToken(html) {
        const match = html.match(/name="_csrf"\s+value="([^"]+)"/);
        return match ? match[1] : null;
    }

    before(async () => {
        // Start app on ephemeral port
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Ensure active admin user exists
        const existingAdmin = await prisma.user.findUnique({
            where: { email: testAdminEmail }
        });
        if (!existingAdmin) {
            const passwordHash = await bcrypt.hash(testAdminPassword, 12);
            await prisma.user.create({
                data: {
                    name: 'Administrator',
                    email: testAdminEmail,
                    password: passwordHash,
                    role: 'ADMIN',
                    active: true
                }
            });
        }

        // Ensure inactive test user exists for scenario 12
        const existingInactive = await prisma.user.findUnique({
            where: { email: inactiveUserEmail }
        });
        if (!existingInactive) {
            const inactiveHash = await bcrypt.hash('InactivePass123!', 12);
            await prisma.user.create({
                data: {
                    name: 'Inactive User',
                    email: inactiveUserEmail,
                    password: inactiveHash,
                    role: 'USER',
                    active: false
                }
            });
        }
    });

    after(async () => {
        // Clean up inactive test user
        try {
            await prisma.user.deleteMany({
                where: { email: inactiveUserEmail }
            });
        } catch (e) {
            // Ignore cleanup failure
        }

        // Close server and disconnect prisma
        await new Promise((resolve) => server.close(resolve));
        await prisma.$disconnect();
    });

    // 1. Open /login while logged out
    it('Scenario 1: Open /login while logged out', async () => {
        const res = await fetch(`${baseUrl}/login`);
        assert.strictEqual(res.status, 200);
        const text = await res.text();
        assert.ok(text.includes('Sign in to access your dashboard') || text.includes('Sign In to Dashboard'));
        assert.ok(text.includes('name="_csrf"'));
        // Verify hardcoded credentials are NOT in the form
        assert.ok(!text.includes('value="admin123"'));
    });

    // 2. Submit empty credentials
    it('Scenario 2: Submit empty credentials', async () => {
        // Get CSRF token and session cookie
        const getRes = await fetch(`${baseUrl}/login`);
        const cookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const body = new URLSearchParams({
            _csrf: csrfToken,
            email: '',
            password: ''
        });

        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookie
            },
            body: body.toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 400);
        const text = await res.text();
        assert.ok(text.includes('Email and password are required.'));
    });

    // 3. Submit an invalid email
    it('Scenario 3: Submit an invalid email format', async () => {
        const getRes = await fetch(`${baseUrl}/login`);
        const cookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const body = new URLSearchParams({
            _csrf: csrfToken,
            email: 'not-an-email',
            password: 'SomePassword123'
        });

        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookie
            },
            body: body.toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 400);
        const text = await res.text();
        assert.ok(text.includes('Please enter a valid email address.'));
        // Verify submitted email is preserved
        assert.ok(text.includes('value="not-an-email"'));
    });

    // 4. Submit an incorrect password
    it('Scenario 4: Submit an incorrect password', async () => {
        const getRes = await fetch(`${baseUrl}/login`);
        const cookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const body = new URLSearchParams({
            _csrf: csrfToken,
            email: testAdminEmail,
            password: 'wrong-password-xyz'
        });

        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookie
            },
            body: body.toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 401);
        const text = await res.text();
        // Verify generic error message
        assert.ok(text.includes('Invalid email or password.'));
        // Verify submitted email is preserved
        assert.ok(text.includes(`value="${testAdminEmail}"`));
        // Verify password is NOT in response
        assert.ok(!text.includes('wrong-password-xyz'));
    });

    // 5. Submit valid credentials
    it('Scenario 5: Submit valid credentials and redirect to /', async () => {
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const body = new URLSearchParams({
            _csrf: csrfToken,
            email: `  ${testAdminEmail.toUpperCase()}  `, // Test email trim & normalisation
            password: testAdminPassword
        });

        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: body.toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/');

        const newCookie = extractCookie(res);
        assert.ok(newCookie, 'A session cookie should be returned after login');
    });

    // 6. Verify successful session creation
    it('Scenario 6: Verify successful session creation and basic info in session', async () => {
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const body = new URLSearchParams({
            _csrf: csrfToken,
            email: testAdminEmail,
            password: testAdminPassword
        });

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: body.toString(),
            redirect: 'manual'
        });

        const authCookie = extractCookie(loginRes);

        // Fetch dashboard with the authenticated cookie
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });

        assert.strictEqual(dashRes.status, 200);
        const text = await dashRes.text();
        // Dashboard should contain the authenticated user's name
        assert.ok(text.includes('Administrator'));
        assert.ok(text.includes(testAdminEmail));
    });

    // 7. Access / while logged out
    it('Scenario 7: Access / while logged out redirects to /login', async () => {
        const res = await fetch(`${baseUrl}/`, {
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/login');
    });

    // 8. Access / while logged in
    it('Scenario 8: Access / while logged in succeeds', async () => {
        // Authenticate
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });

        const authCookie = extractCookie(loginRes);

        const res = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie },
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 200);
        const text = await res.text();
        assert.ok(text.includes('Dashboard'));
    });

    // 9. Attempt to open /login while logged in
    it('Scenario 9: Attempt to open /login while logged in redirects to /', async () => {
        // Authenticate
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });

        const authCookie = extractCookie(loginRes);

        const res = await fetch(`${baseUrl}/login`, {
            headers: { Cookie: authCookie },
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 302);
        assert.strictEqual(res.headers.get('location'), '/');
    });

    // 10. Logout successfully
    it('Scenario 10: Logout successfully via POST /logout', async () => {
        // Authenticate
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });

        const authCookie = extractCookie(loginRes);

        // Fetch dashboard to get fresh CSRF token
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        const dashCsrf = extractCsrfToken(await dashRes.text());

        // Perform POST /logout
        const logoutRes = await fetch(`${baseUrl}/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: authCookie
            },
            body: new URLSearchParams({
                _csrf: dashCsrf
            }).toString(),
            redirect: 'manual'
        });

        assert.strictEqual(logoutRes.status, 302);
        assert.strictEqual(logoutRes.headers.get('location'), '/login');

        // Check that session cookie was cleared
        const setCookie = logoutRes.headers.get('set-cookie');
        assert.ok(setCookie, 'Should have set-cookie header clearing cookie');
        assert.ok(setCookie.includes('spark.sid=;') || setCookie.includes('Max-Age=0') || setCookie.includes('Expires=Thu, 01 Jan 1970'));
    });

    // 11. Access protected routes after logout
    it('Scenario 11: Access protected routes after logout redirects to /login', async () => {
        // Authenticate
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });

        const authCookie = extractCookie(loginRes);

        // Get CSRF and logout
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        const dashCsrf = extractCsrfToken(await dashRes.text());

        await fetch(`${baseUrl}/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: authCookie
            },
            body: new URLSearchParams({ _csrf: dashCsrf }).toString(),
            redirect: 'manual'
        });

        // Try to access protected routes with previous cookie
        const protectedRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie },
            redirect: 'manual'
        });

        assert.strictEqual(protectedRes.status, 302);
        assert.strictEqual(protectedRes.headers.get('location'), '/login');

        // Test admin route as well
        const adminRes = await fetch(`${baseUrl}/tables/basic`, {
            headers: { Cookie: authCookie },
            redirect: 'manual'
        });
        assert.strictEqual(adminRes.status, 302);
        assert.strictEqual(adminRes.headers.get('location'), '/login');
    });

    // 12. Attempt login with an inactive account
    it('Scenario 12: Attempt login with an inactive account is rejected with generic error', async () => {
        const getRes = await fetch(`${baseUrl}/login`);
        const cookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const body = new URLSearchParams({
            _csrf: csrfToken,
            email: inactiveUserEmail,
            password: 'InactivePass123!'
        });

        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookie
            },
            body: body.toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 401);
        const text = await res.text();
        // Crucial: Must be generic error to prevent user enumeration
        assert.ok(text.includes('Invalid email or password.'));
        assert.ok(!text.includes('inactive account') && !text.includes('user is inactive') && !text.includes('Account is inactive'));
        // Verify submitted email is preserved
        assert.ok(text.includes(`value="${inactiveUserEmail}"`));
    });

    // 13. Simulate database unavailability
    it('Scenario 13: Simulate database unavailability safely handles error without leaking details', async () => {
        // We test the controller directly with a mocked error to verify 500 response and safety
        let statusSet = null;
        let renderedView = null;
        let renderedData = null;

        const mockReq = {
            body: {
                email: 'test@example.com',
                password: 'password123'
            }
        };

        const mockRes = {
            status(code) {
                statusSet = code;
                return this;
            },
            render(view, data) {
                renderedView = view;
                renderedData = data;
            }
        };

        // Temporarily patch authService.authenticateUser to throw a database error
        const originalAuth = authService.authenticateUser;
        authService.authenticateUser = async () => {
            throw new Error('Database connection failed: ECONNREFUSED 127.0.0.1:3306');
        };

        try {
            await authController.login(mockReq, mockRes, () => {});
            assert.strictEqual(statusSet, 500);
            assert.strictEqual(renderedView, 'errors/500');
            assert.strictEqual(renderedData.pageTitle, 'Server Error');
        } finally {
            authService.authenticateUser = originalAuth;
        }
    });

    // 14. Verify session regeneration on successful login
    it('Scenario 14: Verify session regeneration on successful login (session fixation prevention)', async () => {
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        assert.ok(initialCookie, 'Pre-auth session cookie should be established');

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });

        const postLoginCookie = extractCookie(loginRes);
        assert.ok(postLoginCookie, 'Post-auth session cookie should exist');

        // Extract session ID portion (e.g., s%3A... or value)
        const initialSid = initialCookie.split('=')[1].split(';')[0];
        const postLoginSid = postLoginCookie.split('=')[1].split(';')[0];

        assert.notStrictEqual(
            initialSid,
            postLoginSid,
            'Session ID must be regenerated upon successful login to prevent session fixation'
        );
    });

    // 15. Verify that passwords and hashes never appear in session data or responses
    it('Scenario 15: Verify that passwords and hashes never appear in session data or responses', async () => {
        // Authenticate
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });

        const authCookie = extractCookie(loginRes);

        // Fetch dashboard
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        const dashText = await dashRes.text();

        // Check database user password hash
        const dbUser = await prisma.user.findUnique({
            where: { email: testAdminEmail }
        });

        assert.ok(dbUser.password.startsWith('$2b$'), 'DB must contain bcrypt hash');

        // Verify neither plain password nor password hash is in dashboard response HTML
        assert.ok(
            !dashText.includes(testAdminPassword),
            'Plaintext password must never appear in response HTML'
        );
        assert.ok(
            !dashText.includes(dbUser.password),
            'Password hash must never appear in response HTML'
        );

        // Also verify authService returns safe user object without password or hash
        const authResult = await authService.authenticateUser(testAdminEmail, testAdminPassword);
        assert.strictEqual(authResult.success, true);
        assert.strictEqual(authResult.user.password, undefined);
        assert.strictEqual(authResult.user.passwordHash, undefined);
        assert.deepStrictEqual(Object.keys(authResult.user).sort(), ['email', 'id', 'name', 'role'].sort());
    });

    // ==========================================
    // Additional Explicit Security & CSRF Tests
    // ==========================================

    it('POST /login without CSRF token is rejected with 403 Forbidden', async () => {
        const getRes = await fetch(`${baseUrl}/login`);
        const cookie = extractCookie(getRes);

        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookie
            },
            body: new URLSearchParams({
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 403);
    });

    it('POST /login with invalid CSRF token is rejected with 403 Forbidden', async () => {
        const getRes = await fetch(`${baseUrl}/login`);
        const cookie = extractCookie(getRes);

        const res = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookie
            },
            body: new URLSearchParams({
                _csrf: 'completely-invalid-csrf-token-value',
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 403);
    });

    it('POST /logout without CSRF token is rejected with 403 Forbidden', async () => {
        // Authenticate first
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });
        const authCookie = extractCookie(loginRes);

        // Attempt POST /logout without CSRF token
        const res = await fetch(`${baseUrl}/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: authCookie
            },
            body: new URLSearchParams({}).toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 403);
    });

    it('POST /logout with invalid CSRF token is rejected with 403 Forbidden', async () => {
        // Authenticate first
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });
        const authCookie = extractCookie(loginRes);

        // Attempt POST /logout with invalid CSRF token
        const res = await fetch(`${baseUrl}/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: authCookie
            },
            body: new URLSearchParams({
                _csrf: 'attacker-forged-csrf-token'
            }).toString(),
            redirect: 'manual'
        });

        assert.strictEqual(res.status, 403);
    });

    it('GET /logout is not a valid logout mechanism and leaves session active', async () => {
        // Authenticate first
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });
        const authCookie = extractCookie(loginRes);

        // Send GET /logout
        const getLogoutRes = await fetch(`${baseUrl}/logout`, {
            headers: { Cookie: authCookie },
            redirect: 'manual'
        });

        // Should return 404 because GET /logout route does not exist
        assert.strictEqual(getLogoutRes.status, 404);

        // Verify session remains active: accessing protected dashboard succeeds
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie },
            redirect: 'manual'
        });
        assert.strictEqual(dashRes.status, 200);
    });

    it('Successful logout invalidates the previous session', async () => {
        // Authenticate first
        const getRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getRes);
        const csrfToken = extractCsrfToken(await getRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });
        const authCookie = extractCookie(loginRes);

        // Fetch fresh CSRF token from dashboard
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        const dashCsrf = extractCsrfToken(await dashRes.text());

        // Perform valid POST /logout
        const logoutRes = await fetch(`${baseUrl}/logout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: authCookie
            },
            body: new URLSearchParams({ _csrf: dashCsrf }).toString(),
            redirect: 'manual'
        });
        assert.strictEqual(logoutRes.status, 302);
        assert.strictEqual(logoutRes.headers.get('location'), '/login');

        // Verify the old session cookie is now invalidated: accessing / redirects to /login
        const verifyRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie },
            redirect: 'manual'
        });
        assert.strictEqual(verifyRes.status, 302);
        assert.strictEqual(verifyRes.headers.get('location'), '/login');
    });

    it('Password hash is never returned to the browser across any response', async () => {
        const dbUser = await prisma.user.findUnique({
            where: { email: testAdminEmail }
        });
        const passwordHash = dbUser.password;

        // 1. GET /login
        const getLoginRes = await fetch(`${baseUrl}/login`);
        const loginHtml = await getLoginRes.text();
        assert.ok(!loginHtml.includes(passwordHash), 'Hash must not appear in GET /login');

        // 2. Failed POST /login
        const cookie = extractCookie(getLoginRes);
        const csrfToken = extractCsrfToken(loginHtml);
        const failedPostRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: 'wrongpassword'
            }).toString(),
            redirect: 'manual'
        });
        const failedHtml = await failedPostRes.text();
        assert.ok(!failedHtml.includes(passwordHash), 'Hash must not appear in failed POST /login response');

        // 3. Authenticated dashboard GET /
        const validLoginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookie
            },
            body: new URLSearchParams({
                _csrf: csrfToken,
                email: testAdminEmail,
                password: testAdminPassword
            }).toString(),
            redirect: 'manual'
        });
        const authCookie = extractCookie(validLoginRes);
        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        const dashHtml = await dashRes.text();
        assert.ok(!dashHtml.includes(passwordHash), 'Hash must not appear in GET /');
    });

    it('Password hash is never stored in session data', async () => {
        let capturedSession = null;
        const mockReq = {
            ip: '127.0.0.1',
            socket: { remoteAddress: '127.0.0.1' },
            body: {
                email: testAdminEmail,
                password: testAdminPassword
            },
            session: {
                regenerate(cb) { cb(); },
                save(cb) { cb(); }
            }
        };
        const mockRes = {
            status() { return this; },
            render() { return this; },
            redirect() {
                capturedSession = mockReq.session;
            }
        };

        await authController.login(mockReq, mockRes, () => {});

        assert.ok(capturedSession, 'Session should have been set');
        assert.ok(capturedSession.user, 'Session.user should exist');
        assert.strictEqual(capturedSession.user.password, undefined);
        assert.strictEqual(capturedSession.user.passwordHash, undefined);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(capturedSession.user, 'password'), false);
        assert.strictEqual(Object.prototype.hasOwnProperty.call(capturedSession.user, 'passwordHash'), false);
        assert.deepStrictEqual(Object.keys(capturedSession.user).sort(), ['email', 'id', 'name', 'role'].sort());
    });
});
