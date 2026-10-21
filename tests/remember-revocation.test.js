'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const prisma = require('../app/config/prisma');
const app = require('../app/app');
after(() => prisma.$disconnect());

test('real remembered login and other sessions are revoked by password changes and logout', async () => {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const password = 'Remember-regression-2026!';
    const user = await prisma.user.create({ data: { name: 'Remember regression', email: `remember-${Date.now()}@test.invalid`, password: await bcrypt.hash(password, 10), role: 'STAFF', active: true } });
    await require('../app/services/business.service').setBusinessMembership(1, user.id);
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function login(pass) {
        const page = await fetch(base + '/login');
        const cookie = page.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
        const token = (await page.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
        const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: token, email: user.email, password: pass, rememberMe: 'true' }) });
        assert.equal(res.status, 302);
        const cookies = res.headers.get('set-cookie');
        return { session: cookies.match(/spark\.sid=[^;]+/)[0], remember: cookies.match(/spark_remember=[^;]+/)[0] };
    }
    const profile = async cookie => {
        const response = await fetch(base + '/profile', { redirect: 'manual', headers: { Cookie: cookie, Accept: 'application/json' } });
        await response.clone().text();
        return response;
    };
    try {
        const first = await login(password), second = await login(password);
        assert.equal((await profile(first.remember)).status, 200);
        assert.equal((await profile(first.session)).status, 200);
        const token = decodeURIComponent(first.remember.split('=')[1]);
        const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
        assert.equal((await profile('spark_remember=' + tampered)).status, 401);
        const parts = token.split('.');
        parts[1] = String(Date.now() - 1000);
        const version = require('../app/services/auth.service').getCredentialVersion?.(user);
        const secret = process.env.SESSION_SECRET || 'spark-admin-dev-secret-key-change-in-prod-32chars';
        const signed = parts.length === 4 ? `${parts[0]}:${parts[1]}:${parts[2]}:${version}` : `${parts[0]}:${parts[1]}`;
        parts[parts.length - 1] = crypto.createHmac('sha256', secret).update(signed).digest('hex');
        assert.equal((await profile('spark_remember=' + parts.join('.'))).status, 401);
        const page = await profile(first.session);
        const csrf = (await page.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
        const changed = await fetch(base + '/profile/password', { method: 'POST', headers: { Cookie: first.session, Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ currentPassword: password, newPassword: password + 'new', confirmPassword: password + 'new' }) });
        assert.equal(changed.status, 200, await changed.text());
        assert.equal((await profile(first.session)).status, 200, 'The initiating session remains authenticated');
        assert.equal((await profile(first.remember)).status, 401, 'Pre-change remembered cookie is revoked');
        assert.equal((await profile(second.session)).status, 401, 'Other active sessions are revoked');
        assert.equal((await profile(second.remember)).status, 401);
        const fresh = await login(password + 'new');
        assert.equal((await profile(fresh.remember)).status, 200);
        const logoutPage = await profile(fresh.session);
        const logoutCsrf = (await logoutPage.text()).match(/name="csrf-token" content="([^"]+)"/)[1];
        const loggedOut = await fetch(base + '/logout', { method: 'POST', redirect: 'manual', headers: { Cookie: fresh.session + '; ' + fresh.remember, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: logoutCsrf }) });
        assert.equal(loggedOut.status, 302);
        assert.match(loggedOut.headers.get('set-cookie'), /spark_remember=;/);
        assert.equal((await profile(fresh.session)).status, 401);
        assert.equal((await profile(fresh.remember)).status, 401, 'Logout revokes a copied remembered cookie too');
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
