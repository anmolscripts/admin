'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const searchService = require('../app/services/search.service');

describe('Universal Global Search (Phase 5) Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let adminUser;

    const adminEmail = 'admin@email.com';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;

    function extractCookie(res) {
        const setCookie = res.headers.get('set-cookie');
        if (!setCookie) return null;
        const match = setCookie.match(/spark\.sid=[^;]+/);
        return match ? match[0] : null;
    }

    function extractCsrfToken(html) {
        const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/id="csrf-token"\s+value="([^"]+)"/);
        return match ? match[1] : null;
    }

    before(async () => {
        adminUser = await prisma.user.findUnique({
            where: { email: adminEmail }
        });
        assert.ok(adminUser, 'Admin fixture must exist');

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        const getLoginRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getLoginRes);
        const loginCsrf = extractCsrfToken(await getLoginRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: loginCsrf,
                email: adminEmail,
                password: adminPassword
            }).toString(),
            redirect: 'manual'
        });

        authCookie = extractCookie(loginRes);
        assert.ok(authCookie, 'Authentication session cookie required for search API testing');
    });

    after(async () => {
        if (server) {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });

    describe('1. API Route Authentication & Input Validation', () => {
        it('rejects unauthenticated requests to GET /api/search with 401', async () => {
            const res = await fetch(`${baseUrl}/api/search?q=invoice`);
            assert.strictEqual(res.status, 401);
            const data = await res.json();
            assert.strictEqual(data.success, false);
        });

        it('returns empty result set for empty query string', async () => {
            const res = await fetch(`${baseUrl}/api/search?q=`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.categories.length, 0);
            assert.strictEqual(data.total, 0);
        });

        it('returns empty result set for 1-character query string (< 2 chars)', async () => {
            const res = await fetch(`${baseUrl}/api/search?q=a`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.categories.length, 0);
            assert.strictEqual(data.total, 0);
        });

        it('safely handles special characters and SQL injection probe strings', async () => {
            const evilQuery = "' OR '1'='1' -- ; DROP TABLE users;";
            const res = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(evilQuery)}`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.ok(Array.isArray(data.categories));
        });
    });

    describe('2. Search Service Entity Matching & RBAC Permissions', () => {
        it('finds quick commands for navigation queries', async () => {
            const result = await searchService.search('invoice', adminUser, () => true);
            assert.ok(result.total > 0);
            const cmdCat = result.categories.find(c => c.name === 'Commands & Navigation');
            assert.ok(cmdCat, 'Should match navigation commands');
            assert.ok(cmdCat.items.some(i => i.title.toLowerCase().includes('invoice')));
        });

        it('finds items from Item Master by name', async () => {
            // Find any item in the database
            const item = await prisma.item.findFirst({ where: { active: true } });
            if (item) {
                const subStr = item.name.slice(0, 4);
                const result = await searchService.search(subStr, adminUser, () => true);
                const itemCat = result.categories.find(c => c.name === 'Items');
                assert.ok(itemCat, 'Items category should exist');
                assert.ok(itemCat.items.some(it => it.title.includes(item.name)));
            }
        });

        it('finds units from Unit Master by name or symbol', async () => {
            const unit = await prisma.unit.findFirst({ where: { active: true } });
            if (unit) {
                const result = await searchService.search(unit.symbol, adminUser, () => true);
                const unitCat = result.categories.find(c => c.name === 'Units');
                assert.ok(unitCat, 'Units category should exist');
                assert.ok(unitCat.items.some(u => u.title.includes(unit.symbol)));
            }
        });

        it('finds clients by name or email', async () => {
            const client = await prisma.client.findFirst({ where: { active: true } });
            if (client) {
                const subName = client.name.slice(0, 4);
                const result = await searchService.search(subName, adminUser, () => true);
                const clientCat = result.categories.find(c => c.name === 'Clients');
                assert.ok(clientCat, 'Clients category should exist');
                assert.ok(clientCat.items.some(c => c.title.includes(client.name)));
            }
        });

        it('filters out restricted entities when user lacks permission (RBAC enforcement)', async () => {
            // Permission function that denies TEAM and REPORTS view
            const restrictedPermFn = (module) => module !== 'TEAM' && module !== 'REPORTS';
            const result = await searchService.search('ledger', adminUser, restrictedPermFn);
            const accCat = result.categories.find(c => c.name === 'Chart of Accounts');
            assert.strictEqual(accCat, undefined, 'Restricted categories must not appear when permission is denied');
        });

        it('respects per-category result limits (max 5)', async () => {
            const result = await searchService.search('a', adminUser, () => true);
            result.categories.forEach(cat => {
                assert.ok(cat.items.length <= 5, `Category ${cat.name} must not exceed 5 items`);
            });
        });

        it('finds suppliers and purchase orders when present', async () => {
            const supplier = await prisma.supplier.findFirst({ where: { active: true } });
            if (supplier) {
                const queryStr = supplier.name;
                const result = await searchService.search(queryStr, adminUser, () => true);
                const supCat = result.categories.find(c => c.name === 'Suppliers');
                if (supCat) {
                    assert.ok(supCat.items.some(s => s.title.includes(supplier.name)));
                }
            }
        });

        it('returns zero results for a nonsense query without error', async () => {
            const result = await searchService.search('zzzz9999_xyz_no_match', adminUser, () => true);
            assert.strictEqual(result.total, 0);
            assert.strictEqual(result.categories.length, 0);
        });
    });

    describe('3. HTTP API End-to-End Query Integration', () => {
        it('GET /api/search?q=ledger returns matching accounting commands or accounts', async () => {
            const res = await fetch(`${baseUrl}/api/search?q=ledger`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.ok(data.total >= 1);
            assert.ok(data.categories.some(c => c.items.some(i => i.title.toLowerCase().includes('ledger'))));
        });

        it('GET /api/search?q=settings returns organization settings command', async () => {
            const res = await fetch(`${baseUrl}/api/search?q=settings`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.ok(data.categories.some(c => c.items.some(i => i.title.includes('Settings'))));
        });
    });
});
