'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const {
    packageCandidate,
    assertNotProtectedOutput,
    PROTECTED_PATHS
} = require('../scripts/package-candidate');
const {
    assertSafeDisposableName,
    PROTECTED_DBS
} = require('../scripts/disposable-release-verification');

describe('Gate 8 Packaging Protection & Database Cleanup Safety Suite', () => {
    const origReleaseZip = path.join(ROOT_DIR, 'dist', 'spark-admin-release.zip');
    const origReleaseManifest = path.join(ROOT_DIR, 'dist', 'release-manifest.json');
    const rc1Zip = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate.zip');
    const rc1Manifest = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate-manifest.json');
    const rc2Zip = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate-rc2.zip');
    const rc2Manifest = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate-rc2-manifest.json');
    const rc3Zip = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate-rc3.zip');
    const rc3Manifest = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate-rc3-manifest.json');

    describe('1. Protected Artifact Guardrails in package-candidate.js', () => {
        it('includes all critical release, RC1, RC2 and RC3 files in PROTECTED_PATHS', () => {
            const expectedProtected = [
                path.resolve(origReleaseZip).toLowerCase(),
                path.resolve(origReleaseManifest).toLowerCase(),
                path.resolve(rc1Zip).toLowerCase(),
                path.resolve(rc1Manifest).toLowerCase(),
                path.resolve(rc2Zip).toLowerCase(),
                path.resolve(rc2Manifest).toLowerCase(),
                path.resolve(rc3Zip).toLowerCase(),
                path.resolve(rc3Manifest).toLowerCase()
            ];

            const actualProtected = PROTECTED_PATHS.map(p => path.resolve(p).toLowerCase());
            for (const ep of expectedProtected) {
                assert.ok(actualProtected.includes(ep), `Missing protected path: ${ep}`);
            }
        });

        it('assertNotProtectedOutput throws if targeting original release zip', () => {
            assert.throws(() => {
                assertNotProtectedOutput(origReleaseZip);
            }, /CRITICAL PACKAGING GUARD/);
        });

        it('assertNotProtectedOutput throws if targeting original release manifest', () => {
            assert.throws(() => {
                assertNotProtectedOutput(origReleaseManifest);
            }, /CRITICAL PACKAGING GUARD/);
        });

        it('assertNotProtectedOutput throws if targeting RC1 release candidate zip', () => {
            assert.throws(() => {
                assertNotProtectedOutput(rc1Zip);
            }, /CRITICAL PACKAGING GUARD/);
        });

        it('assertNotProtectedOutput throws if targeting RC1 release candidate manifest', () => {
            assert.throws(() => {
                assertNotProtectedOutput(rc1Manifest);
            }, /CRITICAL PACKAGING GUARD/);
        });

        it('packageCandidate throws when attempting to output to protected paths', () => {
            assert.throws(() => {
                packageCandidate({
                    outDir: path.join(ROOT_DIR, 'dist'),
                    archiveName: 'spark-admin-release.zip'
                });
            }, /CRITICAL PACKAGING GUARD/);

            assert.throws(() => {
                packageCandidate({
                    outDir: path.join(ROOT_DIR, 'dist', 'candidates'),
                    archiveName: 'spark-admin-release-candidate.zip'
                });
            }, /CRITICAL PACKAGING GUARD/);
        });

        it('packageCandidate refuses to overwrite existing archive without allowOverwrite', () => {
            const tempDir = path.join(ROOT_DIR, 'dist', 'candidates', `test_tmp_${Date.now()}`);
            fs.mkdirSync(tempDir, { recursive: true });
            const dummyFile = path.join(tempDir, 'dummy.zip');
            fs.writeFileSync(dummyFile, 'dummy content');

            try {
                assert.throws(() => {
                    packageCandidate({
                        outDir: tempDir,
                        archiveName: 'dummy.zip',
                        manifestName: 'dummy-manifest.json',
                        allowOverwrite: false
                    });
                }, /already exists/);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('2. package-release.js Overwrite Guard', () => {
        it('refuses to overwrite existing dist/spark-admin-release.zip without override flag', () => {
            const res = spawnSync('node', ['scripts/package-release.js'], {
                cwd: ROOT_DIR,
                encoding: 'utf-8',
                env: process.env
            });

            // If dist/spark-admin-release.zip exists, it must exit with 1 and print CRITICAL RELEASE GUARD
            if (fs.existsSync(origReleaseZip)) {
                assert.strictEqual(res.status, 1, 'Must exit with code 1 to protect existing release');
                const out = res.stdout + res.stderr;
                assert.ok(out.includes('CRITICAL RELEASE GUARD'), 'Must state release guard prevented overwrite');
            }
        });
    });

    describe('3. Gate 8 Packaging Isolation & Hash Invariance', () => {
        it('ephemeral packaging audit does not mutate original release, RC1, RC2 or RC3 checksums', () => {
            const origShaBefore = fs.existsSync(origReleaseZip)
                ? crypto.createHash('sha256').update(fs.readFileSync(origReleaseZip)).digest('hex')
                : null;
            const rc1ShaBefore = fs.existsSync(rc1Zip)
                ? crypto.createHash('sha256').update(fs.readFileSync(rc1Zip)).digest('hex')
                : null;
            const rc2ShaBefore = fs.existsSync(rc2Zip)
                ? crypto.createHash('sha256').update(fs.readFileSync(rc2Zip)).digest('hex')
                : null;
            const rc3ShaBefore = fs.existsSync(rc3Zip)
                ? crypto.createHash('sha256').update(fs.readFileSync(rc3Zip)).digest('hex')
                : null;

            const tempAuditDir = path.join(ROOT_DIR, 'dist', 'candidates', `gate8_test_audit_${Date.now()}`);
            try {
                const res = packageCandidate({
                    outDir: tempAuditDir,
                    archiveName: 'test-audit.zip',
                    manifestName: 'test-audit-manifest.json',
                    candidateVersion: 'test-rc',
                    allowOverwrite: true
                });

                assert.ok(fs.existsSync(res.zipPath), 'Ephemeral zip must exist');
                assert.ok(fs.existsSync(res.manifestPath), 'Ephemeral manifest must exist');
                assert.ok(res.manifest.fileCount > 200, 'Packaged file count must be valid');

                // Verify baseline release hash unchanged
                if (origShaBefore) {
                    const origShaAfter = crypto.createHash('sha256').update(fs.readFileSync(origReleaseZip)).digest('hex');
                    assert.strictEqual(origShaAfter, origShaBefore, 'Baseline release zip MUST remain identical byte-for-byte');
                }

                // Verify RC1 hash unchanged
                if (rc1ShaBefore) {
                    const rc1ShaAfter = crypto.createHash('sha256').update(fs.readFileSync(rc1Zip)).digest('hex');
                    assert.strictEqual(rc1ShaAfter, rc1ShaBefore, 'RC1 candidate zip MUST remain identical byte-for-byte');
                }

                // Verify RC2 hash unchanged
                if (rc2ShaBefore) {
                    const rc2ShaAfter = crypto.createHash('sha256').update(fs.readFileSync(rc2Zip)).digest('hex');
                    assert.strictEqual(rc2ShaAfter, rc2ShaBefore, 'RC2 candidate zip MUST remain identical byte-for-byte');
                }

                // Verify RC3 hash unchanged
                if (rc3ShaBefore) {
                    const rc3ShaAfter = crypto.createHash('sha256').update(fs.readFileSync(rc3Zip)).digest('hex');
                    assert.strictEqual(rc3ShaAfter, rc3ShaBefore, 'RC3 candidate zip MUST remain identical byte-for-byte');
                }
            } finally {
                if (fs.existsSync(tempAuditDir)) {
                    fs.rmSync(tempAuditDir, { recursive: true, force: true });
                }
            }
        });
    });

    describe('4. Database Safety and Disposable Name Validation', () => {
        it('rejects all protected database names', () => {
            for (const db of PROTECTED_DBS) {
                assert.throws(() => {
                    assertSafeDisposableName(db);
                }, /PROTECTED DATABASE VIOLATION/);

                assert.throws(() => {
                    assertSafeDisposableName(db.toUpperCase());
                }, /PROTECTED DATABASE VIOLATION/);
            }
        });

        it('rejects arbitrary database names not matching disposable prefix', () => {
            assert.throws(() => {
                assertSafeDisposableName('production_db');
            }, /INVALID DISPOSABLE DATABASE NAME/);

            assert.throws(() => {
                assertSafeDisposableName('spark_test');
            }, /INVALID DISPOSABLE DATABASE NAME/);

            assert.throws(() => {
                assertSafeDisposableName('random_12345');
            }, /INVALID DISPOSABLE DATABASE NAME/);
        });

        it('accepts valid disposable database names', () => {
            assert.doesNotThrow(() => {
                assertSafeDisposableName('spark_disp_1792309999999');
            });
            assert.doesNotThrow(() => {
                assertSafeDisposableName('spark_rest_1792309999999');
            });
        });
    });

    describe('5. Direct Connection Lifecycle & Safe Cleanup Invariants', () => {
        const mariadb = require('mariadb');
        const dbHost = process.env.DATABASE_HOST || '127.0.0.1';
        const dbPort = Number(process.env.DATABASE_PORT || 3306);
        const dbUser = process.env.DATABASE_USER || 'root';
        const dbPass = process.env.DATABASE_PASSWORD || '';

        it('repeated sequential direct connections connect and close without exhaustion', async () => {
            for (let i = 0; i < 5; i++) {
                let conn = null;
                try {
                    conn = await mariadb.createConnection({
                        host: dbHost,
                        port: dbPort,
                        user: dbUser,
                        password: dbPass,
                        connectTimeout: 5000
                    });
                    const rows = await conn.query('SELECT 1 as alive');
                    assert.strictEqual(Number(rows[0].alive), 1);
                } finally {
                    if (conn) await conn.end();
                }
            }
        });

        it('unique disposable names are generated per run and conform to pattern', () => {
            const names = new Set();
            for (let i = 0; i < 10; i++) {
                const ts = Date.now() + i;
                const dispDb = `spark_disp_${ts}`;
                assert.ok(!names.has(dispDb), 'Each disposable database name must be unique');
                names.add(dispDb);
                assert.doesNotThrow(() => assertSafeDisposableName(dispDb));
            }
        });

        it('safe cleanup routine removes only tracked disposable databases and ignores protected', async () => {
            let conn = null;
            const simTs = Date.now();
            const simDispDb = `spark_disp_${simTs}`;
            const created = new Set([simDispDb, 'admin', 'spark_admin']);

            try {
                conn = await mariadb.createConnection({
                    host: dbHost,
                    port: dbPort,
                    user: dbUser,
                    password: dbPass,
                    connectTimeout: 5000
                });

                // Create disposable test database
                await conn.query(`CREATE DATABASE \`${simDispDb}\``);

                // Run safe cleanup logic matching disposable-release-verification.js
                for (const db of created) {
                    if (!PROTECTED_DBS.includes(db.toLowerCase()) && (db.startsWith('spark_disp_') || db.startsWith('spark_rest_'))) {
                        await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
                        created.delete(db);
                    }
                }

                // Verify simDispDb was dropped
                const checkRows = await conn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [simDispDb]);
                assert.strictEqual(checkRows.length, 0, 'Disposable database should have been dropped');

                // Verify protected databases remained in created set (never touched)
                assert.ok(created.has('admin'));
                assert.ok(created.has('spark_admin'));
            } finally {
                if (conn) {
                    await conn.query(`DROP DATABASE IF EXISTS \`${simDispDb}\``).catch(() => {});
                    await conn.end();
                }
            }
        });
    });
});

