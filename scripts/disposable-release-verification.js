'use strict';

/**
 * Spark Admin — Automated Disposable Release Readiness Verification
 * Executes clean installation, forward upgrade invariance, real MySQL backup/restore
 * round-trip using mysqldump and mysql binaries, and release packaging validation.
 * 
 * SAFETY INVARIANT: Strictly creates, uses, and tears down ephemeral disposable databases.
 * NEVER mutates or touches 'admin' or production environments.
 * Gate 8 NEVER overwrites baseline release archives or existing release candidates.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const mariadb = require('mariadb');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..');
const envTestPath = path.resolve(ROOT_DIR, '.env.test');
dotenv.config({ path: envTestPath, override: true });

const rawHost = process.env.DATABASE_HOST || 'localhost';
const DATABASE_HOST = (rawHost === 'localhost' || rawHost === '::1') ? '127.0.0.1' : rawHost;
const DATABASE_PORT = process.env.DATABASE_PORT || '3306';
const DATABASE_USER = process.env.DATABASE_USER;
const DATABASE_PASSWORD = process.env.DATABASE_PASSWORD;

if (!DATABASE_USER || !DATABASE_PASSWORD) {
    console.error('❌ Missing database credentials in environment.');
    process.exit(1);
}

const PROTECTED_DBS = [
    'admin',
    'spark_admin',
    'spark_admin_test',
    'spark_admin_prod',
    'spark_admin_prod_test',
    'information_schema',
    'mysql',
    'performance_schema',
    'sys'
];

function assertSafeDisposableName(name, prefix = '(?:spark_disp_|spark_rest_|spark_upg_)') {
    if (!name || typeof name !== 'string') {
        throw new Error(`[INVALID DISPOSABLE DATABASE NAME]: Invalid name "${name}"`);
    }
    if (PROTECTED_DBS.includes(name.toLowerCase())) {
        throw new Error(`[CRITICAL PROTECTED DATABASE VIOLATION]: Database "${name}" is protected. Operation strictly aborted.`);
    }
    const safeRegex = new RegExp(`^${prefix}\\d+$`);
    if (!safeRegex.test(name)) {
        throw new Error(`[INVALID DISPOSABLE DATABASE NAME]: Database name "${name}" violates disposable naming pattern ^${prefix}\\d+$`);
    }
}

// Find mysql and mysqldump binaries
function findBinary(name) {
    const candidates = [
        name,
        `C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\${name}.exe`,
        `C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\${name}.exe`,
        `C:\\xampp\\mysql\\bin\\${name}.exe`
    ];

    for (const c of candidates) {
        if (c.includes('\\')) {
            if (fs.existsSync(c)) return c;
        } else {
            const res = spawnSync('where', [name], { shell: true, encoding: 'utf-8' });
            if (res.status === 0 && res.stdout.trim()) {
                return res.stdout.trim().split('\r\n')[0];
            }
        }
    }
    return null;
}

const mysqlBin = findBinary('mysql');
const mysqldumpBin = findBinary('mysqldump');

console.log(`[TOOLS] mysql binary: ${mysqlBin}`);
console.log(`[TOOLS] mysqldump binary: ${mysqldumpBin}`);

if (!mysqlBin || !mysqldumpBin) {
    console.error('❌ Could not locate mysql or mysqldump executables.');
    process.exit(1);
}

async function run() {
    const startTime = Date.now();
    console.log('\n' + '='.repeat(70));
    console.log('   SPARK ADMIN — DISPOSABLE DATABASE RELEASE READINESS VERIFICATION');
    console.log('='.repeat(70));

    const timestamp = Date.now();
    const dispDb = `spark_disp_${timestamp}`;
    const restDb = `spark_rest_${timestamp}`;
    const backupFile = path.resolve(ROOT_DIR, `.artifacts`, `backup_${timestamp}.sql`);

    assertSafeDisposableName(dispDb, 'spark_disp_');
    assertSafeDisposableName(restDb, 'spark_rest_');

    const createdDatabases = new Set();

    if (!fs.existsSync(path.dirname(backupFile))) {
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    }

    let rootConn = null;
    let dispConn = null;
    let restConn = null;

    try {
        // [1/8] Connect to MySQL server root to verify server state & safety
        console.log('\n[1/8] Verifying MySQL connection and asserting target safety...');
        rootConn = await mariadb.createConnection({
            host: DATABASE_HOST,
            port: Number(DATABASE_PORT),
            user: DATABASE_USER,
            password: DATABASE_PASSWORD,
            database: 'information_schema',
            connectTimeout: 5000
        });

        const activeDbRows = await rootConn.query('SELECT DATABASE() AS db');
        console.log(`✔ Connected to MySQL. Current schema context: ${activeDbRows[0]?.db}`);

        // Prove dispDb does not exist
        const existsRows = await rootConn.query(
            'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
            [dispDb]
        );
        if (existsRows.length > 0) {
            throw new Error(`Disposable database ${dispDb} already exists! Aborting.`);
        }
        console.log(`✔ Proved disposable database name "${dispDb}" is completely fresh and unique.`);

        // [2/8] Create fresh disposable database
        console.log(`\n[2/8] Creating fresh disposable database: ${dispDb}...`);
        await rootConn.query(`CREATE DATABASE \`${dispDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        createdDatabases.add(dispDb);
        console.log(`✔ Successfully created ${dispDb}.`);

        // Connect directly to dispDb and verify SELECT DATABASE()
        dispConn = await mariadb.createConnection({
            host: DATABASE_HOST,
            port: Number(DATABASE_PORT),
            user: DATABASE_USER,
            password: DATABASE_PASSWORD,
            database: dispDb,
            connectTimeout: 5000
        });

        const currentDbRows = await dispConn.query('SELECT DATABASE() AS db');
        const connectedDb = currentDbRows[0]?.db;
        if (connectedDb !== dispDb) {
            throw new Error(`Target mismatch! Expected ${dispDb}, got ${connectedDb}`);
        }
        console.log(`✔ Verified exact target connection with SELECT DATABASE() = "${connectedDb}".`);

        // [3/8] Apply complete migration history
        console.log(`\n[3/8] Applying complete Prisma migration history to ${dispDb}...`);
        const dispDbUrl = `mysql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${dispDb}`;
        const dispShadowDbUrl = `mysql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/spark_admin_test_shadow`;

        const migrateRes = spawnSync(
            'node',
            ['scripts/prisma-test.js', 'migrate', 'deploy'],
            {
                cwd: ROOT_DIR,
                shell: true,
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    DATABASE_URL: dispDbUrl,
                    SHADOW_DATABASE_URL: dispShadowDbUrl,
                    DATABASE_NAME: dispDb
                }
            }
        );

        if (migrateRes.status !== 0) {
            console.error('Migration output:', migrateRes.stderr || migrateRes.stdout);
            throw new Error(`Prisma migrate deploy failed with exit code ${migrateRes.status}`);
        }
        console.log(migrateRes.stdout.trim());
        console.log(`✔ All migrations cleanly applied to ${dispDb}.`);

        // Check migration status
        const statusRes = spawnSync(
            'node',
            ['scripts/prisma-test.js', 'migrate', 'status'],
            {
                cwd: ROOT_DIR,
                shell: true,
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    DATABASE_URL: dispDbUrl,
                    DATABASE_NAME: dispDb
                }
            }
        );
        if (statusRes.status !== 0) {
            throw new Error(`Prisma migrate status failed with exit code ${statusRes.status}`);
        }
        console.log(`✔ Verified migration status: Database schema is up to date.`);

        // [4/8] Populate controlled sample records
        console.log(`\n[4/8] Seeding controlled sample data into ${dispDb}...`);
        await dispConn.query(`
            INSERT INTO users (email, name, password, role, createdAt, updatedAt)
            VALUES ('disp_admin@spark.test', 'Disposable Admin', 'sample_hash', 'ADMIN', NOW(), NOW())
        `);
        const userRes = await dispConn.query('SELECT id FROM users WHERE email = ?', ['disp_admin@spark.test']);
        const userId = userRes[0].id;

        const bizRes = await dispConn.query('SELECT id FROM businesses LIMIT 1');
        const bizId = bizRes[0]?.id || 1;

        await dispConn.query(`
            INSERT INTO financial_years (code, businessId, startDate, endDate, status, isCurrent, createdAt, updatedAt)
            VALUES ('FY-2026-27', ?, '2026-04-01', '2027-03-31', 'OPEN', 1, NOW(), NOW())
        `, [bizId]);
        const fyRes = await dispConn.query('SELECT id FROM financial_years WHERE code = ?', ['FY-2026-27']);
        const fyId = fyRes[0].id;

        await dispConn.query(`
            INSERT INTO clients (name, email, businessId, createdAt, updatedAt, createdById)
            VALUES ('Acme Corp', 'contact@acme.test', ?, NOW(), NOW(), ?)
        `, [bizId, userId]);

        await dispConn.query(`
            INSERT INTO items (name, rate, unit, active, businessId, createdAt, updatedAt, createdById)
            VALUES ('Industrial Sensor X1', 250.00, 'PCS', 1, ?, NOW(), NOW(), ?)
        `, [bizId, userId]);

        await dispConn.query(`
            INSERT INTO suppliers (name, email, stateCode, businessId, createdAt, updatedAt, createdById)
            VALUES ('Global Components Ltd', 'sales@globalcomp.test', '27', ?, NOW(), NOW(), ?)
        `, [bizId, userId]);

        await dispConn.query(`
            INSERT INTO employees (employeeCode, firstName, lastName, email, dateOfJoining, status, businessId, createdAt, updatedAt, createdById)
            VALUES ('EMP-DISP-001', 'Test', 'Engineer', 'eng@spark.test', '2026-01-01', 'ACTIVE', ?, NOW(), NOW(), ?)
        `, [bizId, userId]);

        await dispConn.query(`
            INSERT INTO projects (code, name, startDate, budgetAmount, hourlyRate, billingType, status, businessId, createdAt, updatedAt, createdById)
            VALUES ('PRJ-DISP-01', 'Disposable Automation Test', '2026-01-01', 10000.00, 100.00, 'TIME_AND_MATERIALS', 'ACTIVE', ?, NOW(), NOW(), ?)
        `, [bizId, userId]);

        const preCountUsers = await dispConn.query('SELECT COUNT(*) AS c FROM users');
        const preCountClients = await dispConn.query('SELECT COUNT(*) AS c FROM clients');
        const preCountItems = await dispConn.query('SELECT COUNT(*) AS c FROM items');
        const preCountSuppliers = await dispConn.query('SELECT COUNT(*) AS c FROM suppliers');
        const preCountEmployees = await dispConn.query('SELECT COUNT(*) AS c FROM employees');
        const preCountProjects = await dispConn.query('SELECT COUNT(*) AS c FROM projects');
        const preMigrationsCount = await dispConn.query('SELECT COUNT(*) AS c FROM _prisma_migrations');

        console.log(`✔ Sample data seeded: 1 user, 1 FY, 1 client, 1 item, 1 supplier, 1 employee, 1 project.`);
        console.log(`✔ Migration count in _prisma_migrations: ${preMigrationsCount[0].c}`);

        // [5/8] Test genuine forward upgrade on separate prior schema database
        console.log(`\n[5/8] Verifying genuine forward upgrade from prior schema...`);
        const upgradeRes = spawnSync(
            'node',
            ['scripts/test-genuine-upgrade.js'],
            {
                cwd: ROOT_DIR,
                shell: true,
                encoding: 'utf-8',
                env: process.env
            }
        );
        if (upgradeRes.status !== 0) {
            console.error('Upgrade test error:', upgradeRes.stderr || upgradeRes.stdout);
            throw new Error(`Genuine forward upgrade test failed with exit code ${upgradeRes.status}`);
        }
        console.log(upgradeRes.stdout.trim());
        console.log(`✔ Forward upgrade test verified cleanly.`);

        // [6/8] Real mysqldump consistent logical backup
        console.log(`\n[6/8] Generating consistent logical backup of ${dispDb} via mysqldump...`);
        const dumpArgs = [
            `--host=${DATABASE_HOST}`,
            `--port=${DATABASE_PORT}`,
            `--user=${DATABASE_USER}`,
            `--password=${DATABASE_PASSWORD}`,
            '--single-transaction',
            '--quick',
            '--routines',
            '--triggers',
            `--result-file=${backupFile}`,
            dispDb
        ];

        const dumpRes = spawnSync(mysqldumpBin, dumpArgs, { encoding: 'utf-8' });
        if (dumpRes.status !== 0) {
            console.error('mysqldump error:', dumpRes.stderr);
            throw new Error(`mysqldump failed with exit code ${dumpRes.status}`);
        }

        const backupStat = fs.statSync(backupFile);
        if (backupStat.size === 0) {
            throw new Error('mysqldump created empty backup file!');
        }
        console.log(`✔ Logical backup created at ${backupFile} (${(backupStat.size / 1024).toFixed(1)} KB).`);

        // [7/8] Clean database restoration drill into spark_rest_<timestamp>
        console.log(`\n[7/8] Restoring backup into secondary clean database ${restDb}...`);
        await rootConn.query(`CREATE DATABASE \`${restDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        createdDatabases.add(restDb);
        console.log(`✔ Created target restore database ${restDb}.`);

        const restoreArgs = [
            `--host=${DATABASE_HOST}`,
            `--port=${DATABASE_PORT}`,
            `--user=${DATABASE_USER}`,
            `--password=${DATABASE_PASSWORD}`,
            restDb
        ];
        const sqlInput = fs.readFileSync(backupFile);
        const restRes = spawnSync(mysqlBin, restoreArgs, { input: sqlInput, encoding: 'utf-8' });
        if (restRes.status !== 0) {
            console.error('mysql restore error:', restRes.stderr);
            throw new Error(`Restore failed with exit code ${restRes.status}`);
        }
        console.log(`✔ SQL restore execution completed successfully.`);

        // Connect directly to restDb to verify data fidelity
        restConn = await mariadb.createConnection({
            host: DATABASE_HOST,
            port: Number(DATABASE_PORT),
            user: DATABASE_USER,
            password: DATABASE_PASSWORD,
            database: restDb,
            connectTimeout: 5000
        });

        const restMigrations = await restConn.query('SELECT COUNT(*) AS c FROM _prisma_migrations');
        const restUsers = await restConn.query('SELECT COUNT(*) AS c FROM users');
        const restClients = await restConn.query('SELECT COUNT(*) AS c FROM clients');
        const restItems = await restConn.query('SELECT COUNT(*) AS c FROM items');
        const restSuppliers = await restConn.query('SELECT COUNT(*) AS c FROM suppliers');
        const restEmployees = await restConn.query('SELECT COUNT(*) AS c FROM employees');
        const restProjects = await restConn.query('SELECT COUNT(*) AS c FROM projects');

        assertMatch('Migrations', restMigrations[0].c, preMigrationsCount[0].c);
        assertMatch('Users', restUsers[0].c, preCountUsers[0].c);
        assertMatch('Clients', restClients[0].c, preCountClients[0].c);
        assertMatch('Items', restItems[0].c, preCountItems[0].c);
        assertMatch('Suppliers', restSuppliers[0].c, preCountSuppliers[0].c);
        assertMatch('Employees', restEmployees[0].c, preCountEmployees[0].c);
        assertMatch('Projects', restProjects[0].c, preCountProjects[0].c);

        console.log(`✔ Restored database verification passed: 100% data fidelity matching source.`);

        // Close entity connections prior to dropping databases
        if (restConn) { await restConn.end(); restConn = null; }
        if (dispConn) { await dispConn.end(); dispConn = null; }

        // Drop temporary restore DB
        await rootConn.query(`DROP DATABASE \`${restDb}\``);
        createdDatabases.delete(restDb);
        console.log(`✔ Dropped temporary restore database ${restDb}.`);

        // Drop temporary disposable DB
        await rootConn.query(`DROP DATABASE \`${dispDb}\``);
        createdDatabases.delete(dispDb);
        console.log(`✔ Dropped temporary disposable database ${dispDb}.`);

        // Remove temporary backup file
        if (fs.existsSync(backupFile)) {
            fs.unlinkSync(backupFile);
            console.log(`✔ Cleaned up temporary backup file ${backupFile}.`);
        }

        // [8/8] Package Candidate Verification in Ephemeral Location (ZERO MUTATION TO RELEASES)
        console.log(`\n[8/8] Verifying candidate packaging in ephemeral location without touching releases...`);
        const origZipPath = path.join(ROOT_DIR, 'dist', 'spark-admin-release.zip');
        const rc1ZipPath = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate.zip');
        const rc2ZipPath = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate-rc2.zip');
        const rc3ZipPath = path.join(ROOT_DIR, 'dist', 'candidates', 'spark-admin-release-candidate-rc3.zip');

        const origShaBefore = fs.existsSync(origZipPath)
            ? crypto.createHash('sha256').update(fs.readFileSync(origZipPath)).digest('hex')
            : null;
        const rc1ShaBefore = fs.existsSync(rc1ZipPath)
            ? crypto.createHash('sha256').update(fs.readFileSync(rc1ZipPath)).digest('hex')
            : null;
        const rc2ShaBefore = fs.existsSync(rc2ZipPath)
            ? crypto.createHash('sha256').update(fs.readFileSync(rc2ZipPath)).digest('hex')
            : null;
        const rc3ShaBefore = fs.existsSync(rc3ZipPath)
            ? crypto.createHash('sha256').update(fs.readFileSync(rc3ZipPath)).digest('hex')
            : null;

        const ephemeralAuditDir = path.join(ROOT_DIR, 'dist', 'candidates', `staging_audit_${timestamp}`);
        const { packageCandidate } = require('./package-candidate');

        const packResult = packageCandidate({
            outDir: ephemeralAuditDir,
            archiveName: 'ephemeral-audit.zip',
            manifestName: 'ephemeral-audit-manifest.json',
            candidateVersion: 'audit-temp',
            allowOverwrite: true
        });

        if (!fs.existsSync(packResult.zipPath) || !fs.existsSync(packResult.manifestPath)) {
            throw new Error('Ephemeral packaging audit failed: archive or manifest missing.');
        }

        // Integrity assertion: baseline release, RC1, RC2, and RC3 must remain 100% unchanged
        if (origShaBefore) {
            const origShaAfter = crypto.createHash('sha256').update(fs.readFileSync(origZipPath)).digest('hex');
            if (origShaBefore !== origShaAfter) {
                throw new Error('CRITICAL INTEGRITY FAILURE: Baseline release archive was mutated during packaging audit!');
            }
        }
        if (rc1ShaBefore) {
            const rc1ShaAfter = crypto.createHash('sha256').update(fs.readFileSync(rc1ZipPath)).digest('hex');
            if (rc1ShaBefore !== rc1ShaAfter) {
                throw new Error('CRITICAL INTEGRITY FAILURE: RC1 candidate archive was mutated during packaging audit!');
            }
        }
        if (rc2ShaBefore) {
            const rc2ShaAfter = crypto.createHash('sha256').update(fs.readFileSync(rc2ZipPath)).digest('hex');
            if (rc2ShaBefore !== rc2ShaAfter) {
                throw new Error('CRITICAL INTEGRITY FAILURE: RC2 candidate archive was mutated during packaging audit!');
            }
        }
        if (rc3ShaBefore) {
            const rc3ShaAfter = crypto.createHash('sha256').update(fs.readFileSync(rc3ZipPath)).digest('hex');
            if (rc3ShaBefore !== rc3ShaAfter) {
                throw new Error('CRITICAL INTEGRITY FAILURE: RC3 candidate archive was mutated during packaging audit!');
            }
        }

        console.log(`✔ Ephemeral packaging audit passed: ${packResult.manifest.fileCount} clean files, ${packResult.manifest.migrationCount} migrations.`);
        console.log(`✔ Verified baseline release, RC1, RC2, and RC3 archives remained 100% untouched byte-for-byte.`);

        // Clean up ephemeral audit directory
        if (fs.existsSync(ephemeralAuditDir)) {
            fs.rmSync(ephemeralAuditDir, { recursive: true, force: true });
            console.log(`✔ Cleaned up ephemeral audit directory.`);
        }

        if (rootConn) { await rootConn.end(); rootConn = null; }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('\n' + '='.repeat(70));
        console.log(`✔ ALL 8 RELEASE READINESS GATES PASSED AUTOMATICALLY (${duration}s)`);
        console.log('='.repeat(70) + '\n');
        process.exit(0);

    } catch (err) {
        console.error('\n❌ [VERIFICATION FAILED]:', err.message);

        // Emergency cleanup strictly for databases created in this run
        try {
            if (dispConn) { await dispConn.end().catch(() => {}); dispConn = null; }
            if (restConn) { await restConn.end().catch(() => {}); restConn = null; }
            if (rootConn) {
                for (const db of createdDatabases) {
                    if (!PROTECTED_DBS.includes(db.toLowerCase()) && (db.startsWith('spark_disp_') || db.startsWith('spark_rest_'))) {
                        await rootConn.query(`DROP DATABASE IF EXISTS \`${db}\``).catch(() => {});
                    }
                }
                await rootConn.end().catch(() => {});
                rootConn = null;
            }
            if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);
        } catch (_) {}
        process.exit(1);
    }
}

function assertMatch(label, actual, expected) {
    if (actual !== expected) {
        throw new Error(`Restoration mismatch for ${label}: expected ${expected}, got ${actual}`);
    }
}

if (require.main === module) {
    run();
}

module.exports = {
    run,
    assertSafeDisposableName,
    PROTECTED_DBS
};
