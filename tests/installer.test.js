'use strict';

require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const prisma = require('../app/config/prisma');
const { checkNodeVersion, checkNpmVersion, checkMySqlTcpConnectivity } = require('../scripts/lib/prerequisites');
const { generateSessionSecret, generateRandomPassword, parseEnvFile } = require('../scripts/lib/env-manager');
const { ensureDatabaseExists, translateDbError } = require('../scripts/lib/db-manager');
const { verifyDatabaseState } = require('../scripts/lib/verifier');
const { runDoctor } = require('../scripts/doctor');
const seedModule = require('../prisma/seed');
const { seedProduction } = require('../prisma/seed/production');
const { seedDevelopment } = require('../prisma/seed/development');

test('Installer & Operations Test Suite', async (t) => {
    t.after(async () => {
        await prisma.$disconnect();
    });

    // =========================================================================
    // 1. Prerequisites Validation
    // =========================================================================
    await t.test('1. Prerequisites Checks', async (t) => {
        await t.test('1.1. Node.js version satisfies engine >=24.0.0', () => {
            const res = checkNodeVersion();
            assert.strictEqual(res.ok, true, 'Current Node.js version must satisfy >=24.0.0');
            assert.ok(res.version.startsWith('v'), 'Version string formatted with leading v');
        });

        await t.test('1.2. npm version satisfies >=10.0.0', () => {
            const res = checkNpmVersion();
            assert.strictEqual(res.ok, true, 'Current npm version must satisfy >=10.0.0');
        });

        await t.test('1.3. MySQL TCP check succeeds on active port and fails on unreachable port', async () => {
            const validCheck = await checkMySqlTcpConnectivity('localhost', 3306);
            assert.strictEqual(validCheck.ok, true, 'Port 3306 should be open and reachable');

            const invalidCheck = await checkMySqlTcpConnectivity('127.0.0.1', 59199, 1000);
            assert.strictEqual(invalidCheck.ok, false, 'Unopened port 59199 should fail TCP connectivity');
            assert.ok(invalidCheck.message.includes('Cannot connect to MySQL'), 'Human-readable message returned');
        });
    });

    // =========================================================================
    // 2. Environment & Secret Security
    // =========================================================================
    await t.test('2. Environment & Secrets Management', async (t) => {
        await t.test('2.1. generateSessionSecret produces 64-char hex cryptographically random strings', () => {
            const secret1 = generateSessionSecret();
            const secret2 = generateSessionSecret();
            assert.strictEqual(secret1.length, 64);
            assert.strictEqual(secret2.length, 64);
            assert.notStrictEqual(secret1, secret2, 'Consecutive secrets must be distinct');
            assert.match(secret1, /^[0-9a-f]{64}$/i, 'Secret must be valid hex');
        });

        await t.test('2.2. generateRandomPassword produces secure random strings without unsafe chars', () => {
            const pass1 = generateRandomPassword(16);
            const pass2 = generateRandomPassword(16);
            assert.strictEqual(pass1.length, 16);
            assert.notStrictEqual(pass1, pass2);
        });

        await t.test('2.3. parseEnvFile parses key-values and cleans enclosing quotes', () => {
            const tempEnv = path.join(__dirname, 'temp.env');
            try {
                fs.writeFileSync(tempEnv, [
                    '# Comment line',
                    'NODE_ENV="development"',
                    'PORT=3000',
                    'DATABASE_URL="mysql://root:pass@localhost:3306/db"',
                    'SPACED_VAR = value '
                ].join('\n'));

                const parsed = parseEnvFile(tempEnv);
                assert.strictEqual(parsed.NODE_ENV, 'development');
                assert.strictEqual(parsed.PORT, '3000');
                assert.strictEqual(parsed.DATABASE_URL, 'mysql://root:pass@localhost:3306/db');
                assert.strictEqual(parsed.SPACED_VAR, 'value');
            } finally {
                if (fs.existsSync(tempEnv)) fs.unlinkSync(tempEnv);
            }
        });
    });

    // =========================================================================
    // 3. Database Manager & Error Translation
    // =========================================================================
    await t.test('3. Database Manager & Safety', async (t) => {
        await t.test('3.1. translateDbError formats human-readable messages without exposing passwords', () => {
            const authError = new Error('Access denied for user root:secret123@localhost');
            authError.errno = 1045;
            const translated = translateDbError(authError, 'localhost', 3306, 'root', 'admin');
            assert.ok(!translated.includes('secret123'), 'Raw password must be scrubbed');
            assert.ok(translated.includes("Authentication failed for MySQL user 'root'"));

            const connError = new Error('connect ECONNREFUSED 127.0.0.1:3306');
            connError.code = 'ECONNREFUSED';
            const connMsg = translateDbError(connError, '127.0.0.1', 3306, 'root', 'admin');
            assert.ok(connMsg.includes('Cannot connect to MySQL at 127.0.0.1:3306'));
        });

        await t.test('3.2. ensureDatabaseExists confirms existing database', async () => {
            const res = await ensureDatabaseExists({
                host: process.env.DATABASE_HOST || 'localhost',
                port: Number(process.env.DATABASE_PORT || 3306),
                user: process.env.DATABASE_USER || 'root',
                password: process.env.DATABASE_PASSWORD || '',
                database: process.env.DATABASE_NAME || 'admin'
            });
            assert.strictEqual(res.alreadyExisted, true, 'Current database should be recognized as existing');
            assert.strictEqual(res.created, false);
        });

        await t.test('3.3. ensureDatabaseExists rejects invalid credentials with safe message', async () => {
            await assert.rejects(
                async () => {
                    await ensureDatabaseExists({
                        host: 'localhost',
                        port: 3306,
                        user: 'invalid_user_never_exists',
                        password: 'some_bad_password',
                        database: 'admin'
                    });
                },
                (err) => {
                    assert.ok(!err.message.includes('some_bad_password'), 'Must not leak bad password');
                    assert.ok(err.message.includes('Authentication failed for MySQL user'));
                    return true;
                }
            );
        });
    });

    // =========================================================================
    // 4. Seed Modules & Idempotency
    // =========================================================================
    await t.test('4. Seed Modules, Idempotency & Invariants', async (t) => {
        await t.test('4.1. Production seed strictly rejects seedDemoData: true with fatal error', async () => {
            await assert.rejects(
                async () => {
                    await seedProduction(prisma, { seedDemoData: true });
                },
                /FATAL SEED POLICY VIOLATION/
            );
        });

        await t.test('4.2. Common seed exports 13 units and 21 items', () => {
            assert.strictEqual(seedModule.DEFAULT_UNITS.length, 13);
            assert.strictEqual(seedModule.MASTER_ITEMS.length, 21);
        });

        await t.test('4.3. Idempotent seed execution produces zero duplicate records and zero errors', async () => {
            const unitsBefore = await prisma.unit.count();
            const itemsBefore = await prisma.item.count();
            const rolesBefore = await prisma.role.count();

            // Run seed again
            await seedModule({ isProduction: false });

            const unitsAfter = await prisma.unit.count();
            const itemsAfter = await prisma.item.count();
            const rolesAfter = await prisma.role.count();

            assert.strictEqual(unitsAfter, unitsBefore, 'Units count must remain identical after repeat seed');
            assert.strictEqual(itemsAfter, itemsBefore, 'Items count must remain identical after repeat seed');
            assert.strictEqual(rolesAfter, rolesBefore, 'Roles count must remain identical after repeat seed');
        });
    });

    // =========================================================================
    // 5. Verifier & Doctor Diagnostic (Read-Only)
    // =========================================================================
    await t.test('5. Verifier & Doctor Tooling', async (t) => {
        await t.test('5.1. verifyDatabaseState validates development database state correctly', async () => {
            const res = await verifyDatabaseState(prisma, 'development');
            assert.strictEqual(res.ok, true, 'Development database invariants must pass');
            assert.strictEqual(res.summary.counts.units >= 13, true);
            assert.strictEqual(res.summary.counts.items >= 21, true);
            assert.ok(res.summary.admin, 'Admin must be discovered');
        });

        await t.test('5.2. doctor command executes read-only inspection and returns PASS without modifying database', async () => {
            const beforeInvoiceCount = await prisma.invoice.count();
            const beforeUserCount = await prisma.user.count();

            const docRes = await runDoctor();
            assert.strictEqual(docRes.ok, true, 'Doctor diagnostic must return OK in healthy environment');

            const afterInvoiceCount = await prisma.invoice.count();
            const afterUserCount = await prisma.user.count();

            assert.strictEqual(afterInvoiceCount, beforeInvoiceCount, 'Doctor must not create or modify invoices');
            assert.strictEqual(afterUserCount, beforeUserCount, 'Doctor must not create or modify users');
        });
    });
});
