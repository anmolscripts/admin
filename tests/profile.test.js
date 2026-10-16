'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const profileService = require('../app/services/profile.service');

describe('User Personal Profile & Security (Phase 3) Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let csrfToken;
    let testUser;
    let secondUser;

    const testUserEmail = 'profile_test_user@example.com';
    const testUserPassword = 'TestPassword123!';
    const secondUserEmail = 'profile_test_other@example.com';

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
        // Create test user fixtures
        const passwordHash = await bcrypt.hash(testUserPassword, 10);
        await prisma.user.deleteMany({
            where: { email: { in: [testUserEmail, secondUserEmail] } }
        });

        testUser = await prisma.user.create({
            data: {
                name: 'Profile Tester',
                email: testUserEmail,
                password: passwordHash,
                role: 'STAFF',
                status: 'ACTIVE',
                active: true
            }
        });

        secondUser = await prisma.user.create({
            data: {
                name: 'Other User',
                email: secondUserEmail,
                password: passwordHash,
                role: 'STAFF',
                status: 'ACTIVE',
                active: true
            }
        });

        const defaultBiz = await prisma.business.findFirst();
        if (defaultBiz) {
            await prisma.businessMembership.createMany({
                data: [
                    { userId: testUser.id, businessId: defaultBiz.id, role: 'MEMBER', status: 'ACTIVE' },
                    { userId: secondUser.id, businessId: defaultBiz.id, role: 'MEMBER', status: 'ACTIVE' }
                ],
                skipDuplicates: true
            });
        }

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Login as testUser
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
                email: testUserEmail,
                password: testUserPassword
            }).toString(),
            redirect: 'manual'
        });

        authCookie = extractCookie(loginRes);
        assert.ok(authCookie, 'Must obtain authentication cookie');

        const profileGet = await fetch(`${baseUrl}/profile`, {
            headers: { Cookie: authCookie }
        });
        csrfToken = extractCsrfToken(await profileGet.text());
    });

    after(async () => {
        // Cleanup fixtures
        try {
            await prisma.businessMembership.deleteMany({
                where: { user: { email: { in: [testUserEmail, secondUserEmail] } } }
            });
            await prisma.user.deleteMany({
                where: { email: { in: [testUserEmail, secondUserEmail] } }
            });
        } catch (_) {}

        if (server) {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });

    describe('1. Profile Authentication & Access Control', () => {
        it('redirects unauthenticated GET /profile to /login', async () => {
            const res = await fetch(`${baseUrl}/profile`, { redirect: 'manual' });
            assert.strictEqual(res.status, 302);
            assert.ok(res.headers.get('location').includes('/login'));
        });

        it('renders profile page for authenticated user with 200 OK', async () => {
            const res = await fetch(`${baseUrl}/profile`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('My Profile'));
            assert.ok(html.includes('Profile Tester'));
            assert.ok(html.includes(testUserEmail));
        });
    });

    describe('2. Personal Details Update & Security Boundaries', () => {
        it('updates user full name and phone number successfully', async () => {
            const res = await fetch(`${baseUrl}/profile`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    _csrf: csrfToken,
                    name: 'Updated Tester Name',
                    email: testUserEmail,
                    phone: '+91 91234 56789'
                }).toString(),
                redirect: 'manual'
            });

            assert.strictEqual(res.status, 302);
            const updated = await prisma.user.findUnique({ where: { id: testUser.id } });
            assert.strictEqual(updated.name, 'Updated Tester Name');
            assert.strictEqual(updated.phone, '+91 91234 56789');
        });

        it('strictly forbids self-role escalation via profile submission', async () => {
            const res = await fetch(`${baseUrl}/profile`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    _csrf: csrfToken,
                    name: 'Updated Tester Name',
                    email: testUserEmail,
                    role: 'OWNER',
                    roleId: '1'
                }).toString(),
                redirect: 'manual'
            });

            const freshUser = await prisma.user.findUnique({ where: { id: testUser.id } });
            assert.strictEqual(freshUser.role, 'STAFF', 'Role must remain STAFF; role changes through profile are prohibited');
        });

        it('rejects duplicate email if already registered to another user', async () => {
            const res = await fetch(`${baseUrl}/profile`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    _csrf: csrfToken,
                    name: 'Updated Tester Name',
                    email: secondUserEmail // already owned by secondUser
                }).toString()
            });

            assert.strictEqual(res.status, 409);
            const data = await res.json();
            assert.strictEqual(data.success, false);
            assert.ok(data.error.includes('already in use'));
        });

        it('two different users retain independent profile states', async () => {
            const u1 = await profileService.getUserProfile(testUser.id);
            const u2 = await profileService.getUserProfile(secondUser.id);
            assert.notStrictEqual(u1.id, u2.id);
            assert.notStrictEqual(u1.email, u2.email);
            assert.strictEqual(u2.name, 'Other User');
        });
    });

    describe('3. Password Change Verification', () => {
        it('rejects password change with incorrect current password', async () => {
            const res = await fetch(`${baseUrl}/profile/password`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    _csrf: csrfToken,
                    currentPassword: 'WrongPassword999!',
                    newPassword: 'BrandNewPassword123!',
                    confirmPassword: 'BrandNewPassword123!'
                }).toString()
            });

            assert.strictEqual(res.status, 401);
            const data = await res.json();
            assert.ok(data.error.includes('Current password is incorrect'));
        });

        it('rejects password change if new password is too short (< 8 chars)', async () => {
            const res = await fetch(`${baseUrl}/profile/password`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    _csrf: csrfToken,
                    currentPassword: testUserPassword,
                    newPassword: 'short',
                    confirmPassword: 'short'
                }).toString()
            });

            assert.strictEqual(res.status, 400);
            const data = await res.json();
            assert.ok(data.error.includes('at least 8 characters'));
        });

        it('successfully changes password with valid current password and confirmation', async () => {
            const newPassword = 'BrandNewPassword999!';
            const res = await fetch(`${baseUrl}/profile/password`, {
                method: 'POST',
                headers: {
                    Cookie: authCookie,
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    _csrf: csrfToken,
                    currentPassword: testUserPassword,
                    newPassword,
                    confirmPassword: newPassword
                }).toString()
            });

            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);

            // Verify the new password matches database hash
            const refreshed = await prisma.user.findUnique({ where: { id: testUser.id } });
            const canVerify = await bcrypt.compare(newPassword, refreshed.password);
            assert.strictEqual(canVerify, true);
        });
    });

    describe('4. Secure Raster Avatar Upload Validation', () => {
        it('validates authentic raster PNG magic bytes correctly', () => {
            // Create a valid 1x1 PNG in memory
            const validPngBuffer = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
            const tmpFile = path.join(__dirname, 'temp_valid.png');
            fs.writeFileSync(tmpFile, validPngBuffer);

            try {
                const isValid = profileService.validateRasterMagicBytes(tmpFile);
                assert.strictEqual(isValid, true, 'Valid PNG must pass magic bytes check');
            } finally {
                if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
            }
        });

        it('rejects fake PNG (text or script file renamed to .png) via magic bytes inspection', () => {
            const fakePngBuffer = Buffer.from('<?php echo "evil"; ?>');
            const tmpFile = path.join(__dirname, 'temp_fake.png');
            fs.writeFileSync(tmpFile, fakePngBuffer);

            try {
                const isValid = profileService.validateRasterMagicBytes(tmpFile);
                assert.strictEqual(isValid, false, 'Non-raster files disguised as PNG must be rejected');
            } finally {
                if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
            }
        });
    });
});
