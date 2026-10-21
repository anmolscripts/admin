'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const prisma = require('../app/config/prisma');
const { rotatePassword, PROTECTED_DATABASES } = require('../scripts/rotate-password');
const { authenticateUser } = require('../app/services/auth.service');

describe('Password Rotation Guard & Security Suite', () => {

    it('1. should reject rotation if target database is protected and authorizedProtectedDb flag is missing', async () => {
        // Mock query raw to simulate connecting to protected admin DB
        const originalQueryRaw = prisma.$queryRawUnsafe;
        prisma.$queryRawUnsafe = async (sql) => {
            if (sql.includes('SELECT DATABASE()')) {
                return [{ active_db: 'admin' }];
            }
            return originalQueryRaw.apply(prisma, [sql]);
        };

        try {
            await assert.rejects(
                rotatePassword({
                    authorizedProtectedDb: false,
                    email: 'admin@email.com',
                    password: 'NewStrongPassword123!'
                }),
                /BLOCKED: Target database "admin" is PROTECTED/
            );
        } finally {
            prisma.$queryRawUnsafe = originalQueryRaw;
        }
    });

    it('2. should reject rotation if protected database confirmation string does not match active DB', async () => {
        const originalQueryRaw = prisma.$queryRawUnsafe;
        prisma.$queryRawUnsafe = async (sql) => {
            if (sql.includes('SELECT DATABASE()')) {
                return [{ active_db: 'spark_admin' }];
            }
            return originalQueryRaw.apply(prisma, [sql]);
        };

        try {
            await assert.rejects(
                rotatePassword({
                    authorizedProtectedDb: true,
                    targetDbConfirmation: 'wrong_db_name',
                    email: 'admin@email.com',
                    password: 'NewStrongPassword123!'
                }),
                /BLOCKED: Database confirmation mismatch/
            );
        } finally {
            prisma.$queryRawUnsafe = originalQueryRaw;
        }
    });

    it('3. should reject rotation for nonexistent user account', async () => {
        await assert.rejects(
            rotatePassword({
                email: 'nonexistent_user_999999@test.com',
                password: 'ValidPassword123!'
            }),
            /User with email "nonexistent_user_999999@test.com" not found/
        );
    });

    it('4. should reject password shorter than 8 characters', async () => {
        // Query an existing user from the disposable test database
        const testUser = await prisma.user.findFirst();
        assert.ok(testUser, 'Test user must exist in disposable database');

        await assert.rejects(
            rotatePassword({
                email: testUser.email,
                password: 'short'
            }),
            /Password must be at least 8 characters/
        );
    });

    it('5. should execute safe rotation and targeted session revocation against disposable test database', async () => {
        // 1. Create a dedicated test user in disposable test DB
        const testEmail = `rotate_test_${Date.now()}@disposable.test`;
        const initialPassword = 'InitialDisposablePassword123!';
        const newPassword = 'RotatedDisposablePassword456!';

        const user = await prisma.user.create({
            data: {
                name: 'Disposable Rotation User',
                email: testEmail,
                password: initialPassword,
                role: 'ADMIN'
            }
        });

        // Create another unrelated test user
        const unrelatedUser = await prisma.user.create({
            data: {
                name: 'Unrelated User',
                email: `unrelated_${Date.now()}@disposable.test`,
                password: 'OtherPassword123!',
                role: 'STAFF'
            }
        });

        // 2. Insert sessions for both users in sessions table
        const userSid = `sid_target_${Date.now()}`;
        const unrelatedSid = `sid_unrelated_${Date.now()}`;

        await prisma.session.createMany({
            data: [
                {
                    sid: userSid,
                    data: JSON.stringify({ user: { id: user.id, email: user.email, role: user.role } }),
                    expiresAt: new Date(Date.now() + 3600000)
                },
                {
                    sid: unrelatedSid,
                    data: JSON.stringify({ user: { id: unrelatedUser.id, email: unrelatedUser.email, role: unrelatedUser.role } }),
                    expiresAt: new Date(Date.now() + 3600000)
                }
            ]
        });

        // 3. Execute password rotation on disposable database
        const result = await rotatePassword({
            email: testEmail,
            password: newPassword
        });

        assert.equal(result.verified, true);
        assert.equal(result.userId, user.id);

        // 4. Verify target user session was revoked
        const targetSession = await prisma.session.findUnique({ where: { sid: userSid } });
        assert.strictEqual(targetSession, null, 'Target user session must be revoked');

        // 5. Verify unrelated user session remains intact
        const unrelatedSession = await prisma.session.findUnique({ where: { sid: unrelatedSid } });
        assert.ok(unrelatedSession, 'Unrelated user session must NOT be deleted');

        // 6. Verify authentication with new credentials succeeds
        const auth = await authenticateUser(testEmail, newPassword);
        assert.strictEqual(auth.success, true, 'Authentication with new password must succeed');

        // Clean up test records
        await prisma.session.deleteMany({ where: { sid: { in: [userSid, unrelatedSid] } } });
        await prisma.user.deleteMany({ where: { id: { in: [user.id, unrelatedUser.id] } } });
    });

    it('6. should rotate password without password argument using prompted input function', async () => {
        const testEmail = `prompt_test_${Date.now()}@disposable.test`;
        const initialPassword = 'InitialDisposablePassword123!';
        const rotatedPassword = 'PromptedNewPassword789!';

        const user = await prisma.user.create({
            data: {
                name: 'Prompt Test User',
                email: testEmail,
                password: initialPassword,
                role: 'ADMIN'
            }
        });

        let promptCallCount = 0;
        const mockPromptMasked = async (promptText) => {
            promptCallCount++;
            return rotatedPassword;
        };

        const result = await rotatePassword({
            email: testEmail,
            promptMaskedFn: mockPromptMasked
        });

        assert.equal(result.verified, true);
        assert.equal(promptCallCount, 2, 'Must prompt twice: initial entry and confirmation');

        // Confirm new credentials authenticate
        const auth = await authenticateUser(testEmail, rotatedPassword);
        assert.strictEqual(auth.success, true);

        await prisma.user.delete({ where: { id: user.id } });
    });

    it('7. should reject rotation when confirmation password does not match prompted password', async () => {
        const testEmail = `mismatch_test_${Date.now()}@disposable.test`;
        const initialPassword = 'InitialDisposablePassword123!';

        const user = await prisma.user.create({
            data: {
                name: 'Mismatch Test User',
                email: testEmail,
                password: initialPassword,
                role: 'ADMIN'
            }
        });

        let callCount = 0;
        const mockPromptMismatch = async () => {
            callCount++;
            return callCount === 1 ? 'FirstPassword123!' : 'SecondDifferentPassword456!';
        };

        await assert.rejects(
            rotatePassword({
                email: testEmail,
                promptMaskedFn: mockPromptMismatch
            }),
            /Passwords do not match/
        );

        await prisma.user.delete({ where: { id: user.id } });
    });

    it('8. CLI should strictly reject --password argument with exit code 1 to protect shell history', async () => {
        const { spawnSync } = require('node:child_process');
        const path = require('node:path');

        const scriptPath = path.resolve(__dirname, '../scripts/rotate-password.js');
        const res = spawnSync(process.execPath, [scriptPath, '--email=admin@test.com', '--password=UnsafeCLISecret!'], {
            encoding: 'utf-8'
        });

        assert.strictEqual(res.status, 1, 'Process must exit with status 1');
        assert.ok(
            res.stderr.includes('[SECURITY ERROR]') && res.stderr.includes('strictly prohibited'),
            `stderr should contain security rejection notice: ${res.stderr}`
        );
    });

    after(async () => {
        await prisma.$disconnect();
    });
});
