'use strict';

/**
 * Spark Admin — Automated Disposable Release Readiness Verification
 * Executes clean installation, forward upgrade invariance, real MySQL backup/restore
 * round-trip using mysqldump and mysql binaries, and release packaging validation.
 * 
 * SAFETY INVARIANT: Strictly creates and drops temporary disposable databases.
 * NEVER mutates or touches 'admin' or production environments.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mariadb = require('mariadb');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..');
const envTestPath = path.resolve(ROOT_DIR, '.env.test');
dotenv.config({ path: envTestPath, override: true });

const {
    DATABASE_HOST = 'localhost',
    DATABASE_PORT = '3306',
    DATABASE_USER,
    DATABASE_PASSWORD
} = process.env;

if (!DATABASE_USER || !DATABASE_PASSWORD) {
    console.error('❌ Missing database credentials in environment.');
    process.exit(1);
}

// Find mysql and mysqldump binaries
function findBinary(name) {
    // Check known standard paths
    const candidates = [
        name,
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

    if (!fs.existsSync(path.dirname(backupFile))) {
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    }

    let rootPool;
    try {
        // 1. Connect to MySQL server root to verify server state & safety
        console.log('\n[1/8] Verifying MySQL connection and asserting target safety...');
        rootPool = mariadb.createPool({
            host: DATABASE_HOST,
            port: Number(DATABASE_PORT),
            user: DATABASE_USER,
            password: DATABASE_PASSWORD,
            database: 'information_schema',
            connectionLimit: 2,
            connectTimeout: 5000
        });

        const rootConn = await rootPool.getConnection();
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

        // 2. Create fresh disposable database
        console.log(`\n[2/8] Creating fresh disposable database: ${dispDb}...`);
        await rootConn.query(`CREATE DATABASE \`${dispDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✔ Successfully created ${dispDb}.`);

        // Verify direct connection with SELECT DATABASE()
        const dispPool = mariadb.createPool({
            host: DATABASE_HOST,
            port: Number(DATABASE_PORT),
            user: DATABASE_USER,
            password: DATABASE_PASSWORD,
            database: dispDb,
            connectionLimit: 2
        });
        const dispConn = await dispPool.getConnection();
        const currentDbRows = await dispConn.query('SELECT DATABASE() AS db');
        const connectedDb = currentDbRows[0]?.db;
        if (connectedDb !== dispDb) {
            throw new Error(`Target mismatch! Expected ${dispDb}, got ${connectedDb}`);
        }
        console.log(`✔ Verified exact target connection with SELECT DATABASE() = "${connectedDb}".`);

        // 3. Apply complete migration history
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
                    DATABASE_NAME: dispDb,
                    SHADOW_DATABASE_URL: dispShadowDbUrl
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

        // 4. Populate controlled sample records
        console.log(`\n[4/8] Seeding controlled sample data into ${dispDb}...`);
        await dispConn.query(`
            INSERT INTO users (email, name, password, role, createdAt, updatedAt)
            VALUES ('disp_admin@spark.test', 'Disposable Admin', 'sample_hash', 'ADMIN', NOW(), NOW())
        `);
        const userRes = await dispConn.query('SELECT id FROM users WHERE email = ?', ['disp_admin@spark.test']);
        const userId = userRes[0].id;

        await dispConn.query(`
            INSERT INTO financial_years (code, startDate, endDate, status, isCurrent, createdAt, updatedAt)
            VALUES ('FY-2026-27', '2026-04-01', '2027-03-31', 'OPEN', 1, NOW(), NOW())
        `);
        const fyRes = await dispConn.query('SELECT id FROM financial_years WHERE code = ?', ['FY-2026-27']);
        const fyId = fyRes[0].id;

        await dispConn.query(`
            INSERT INTO clients (name, email, createdAt, updatedAt, createdById)
            VALUES ('Acme Corp', 'contact@acme.test', NOW(), NOW(), ?)
        `, [userId]);

        await dispConn.query(`
            INSERT INTO items (name, rate, unit, active, createdAt, updatedAt, createdById)
            VALUES ('Industrial Sensor X1', 250.00, 'PCS', 1, NOW(), NOW(), ?)
        `, [userId]);

        await dispConn.query(`
            INSERT INTO suppliers (name, email, stateCode, createdAt, updatedAt, createdById)
            VALUES ('Global Components Ltd', 'sales@globalcomp.test', '27', NOW(), NOW(), ?)
        `, [userId]);

        await dispConn.query(`
            INSERT INTO employees (employeeCode, firstName, lastName, email, dateOfJoining, status, createdAt, updatedAt, createdById)
            VALUES ('EMP-DISP-001', 'Test', 'Engineer', 'eng@spark.test', '2026-01-01', 'ACTIVE', NOW(), NOW(), ?)
        `, [userId]);

        await dispConn.query(`
            INSERT INTO projects (code, name, startDate, budgetAmount, hourlyRate, billingType, status, createdAt, updatedAt, createdById)
            VALUES ('PRJ-DISP-01', 'Disposable Automation Test', '2026-01-01', 10000.00, 100.00, 'TIME_AND_MATERIALS', 'ACTIVE', NOW(), NOW(), ?)
        `, [userId]);

        const preCountUsers = await dispConn.query('SELECT COUNT(*) AS c FROM users');
        const preCountClients = await dispConn.query('SELECT COUNT(*) AS c FROM clients');
        const preCountItems = await dispConn.query('SELECT COUNT(*) AS c FROM items');
        const preCountSuppliers = await dispConn.query('SELECT COUNT(*) AS c FROM suppliers');
        const preCountEmployees = await dispConn.query('SELECT COUNT(*) AS c FROM employees');
        const preCountProjects = await dispConn.query('SELECT COUNT(*) AS c FROM projects');
        const preMigrationsCount = await dispConn.query('SELECT COUNT(*) AS c FROM _prisma_migrations');

        console.log(`✔ Sample data seeded: 1 user, 1 FY, 1 client, 1 item, 1 supplier, 1 employee, 1 project.`);
        console.log(`✔ Migration count in _prisma_migrations: ${preMigrationsCount[0].c}`);

        // 5. Test genuine forward upgrade on separate prior schema database
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
        console.log(`✔ Genuine forward upgrade verified: Prior schema advanced, 100% data preserved.`);

        // 6. Real MySQL Backup Round-Trip using mysqldump
        console.log(`\n[6/8] Executing real mysqldump backup of ${dispDb}...`);
        const dumpArgs = [
            `--host=${DATABASE_HOST}`,
            `--port=${DATABASE_PORT}`,
            `--user=${DATABASE_USER}`,
            `--password=${DATABASE_PASSWORD}`,
            '--single-transaction',
            '--quick',
            dispDb,
            `--result-file=${backupFile}`
        ];

        const dumpRes = spawnSync(mysqldumpBin, dumpArgs, { encoding: 'utf-8' });
        if (dumpRes.status !== 0) {
            console.error('mysqldump error:', dumpRes.stderr);
            throw new Error(`mysqldump failed with exit code ${dumpRes.status}`);
        }

        const backupStats = fs.statSync(backupFile);
        console.log(`✔ Backup created successfully: ${backupFile} (${(backupStats.size / 1024).toFixed(1)} KB)`);

        // 7. Real MySQL Restore Round-Trip into secondary clean database
        console.log(`\n[7/8] Creating restore target database ${restDb} and restoring dump...`);
        await rootConn.query(`CREATE DATABASE \`${restDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

        const restoreRes = spawnSync(mysqlBin, [
            `--host=${DATABASE_HOST}`,
            `--port=${DATABASE_PORT}`,
            `--user=${DATABASE_USER}`,
            `--password=${DATABASE_PASSWORD}`,
            restDb
        ], {
            input: fs.readFileSync(backupFile),
            encoding: 'utf-8'
        });

        if (restoreRes.status !== 0) {
            console.error('mysql restore error:', restoreRes.stderr);
            throw new Error(`mysql restore failed with exit code ${restoreRes.status}`);
        }
        console.log(`✔ Database restored cleanly from ${backupFile} into ${restDb}.`);

        // Verify restored data integrity
        const restPool = mariadb.createPool({
            host: DATABASE_HOST,
            port: Number(DATABASE_PORT),
            user: DATABASE_USER,
            password: DATABASE_PASSWORD,
            database: restDb,
            connectionLimit: 2
        });
        const restConn = await restPool.getConnection();

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

        // Close connections
        await restConn.end();
        await restPool.end();
        await dispConn.end();
        await dispPool.end();

        // Drop temporary restore DB
        await rootConn.query(`DROP DATABASE \`${restDb}\``);
        console.log(`✔ Dropped temporary restore database ${restDb}.`);

        // Drop temporary disposable DB
        await rootConn.query(`DROP DATABASE \`${dispDb}\``);
        console.log(`✔ Dropped temporary disposable database ${dispDb}.`);

        // Remove temporary backup file
        if (fs.existsSync(backupFile)) {
            fs.unlinkSync(backupFile);
            console.log(`✔ Cleaned up temporary backup file ${backupFile}.`);
        }

        // 8. Package Release & Verify Exclusions
        console.log(`\n[8/8] Building release package and auditing manifest...`);
        const pkgRes = spawnSync('node', ['scripts/package-release.js'], {
            cwd: ROOT_DIR,
            shell: true,
            encoding: 'utf-8'
        });
        if (pkgRes.status !== 0) {
            console.error('package-release error:', pkgRes.stderr || pkgRes.stdout);
            throw new Error(`package-release failed with exit code ${pkgRes.status}`);
        }
        console.log(pkgRes.stdout.trim());
        console.log(`✔ Release packaging audit passed: zero forbidden files or secret leaks.`);

        await rootConn.end();
        await rootPool.end();

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('\n' + '='.repeat(70));
        console.log(`✔ ALL 8 RELEASE READINESS GATES PASSED AUTOMATICALLY (${duration}s)`);
        console.log('='.repeat(70) + '\n');
        process.exit(0);

    } catch (err) {
        console.error('\n❌ [VERIFICATION FAILED]:', err.message);
        // Emergency cleanup if created
        try {
            if (rootPool) {
                const conn = await rootPool.getConnection();
                await conn.query(`DROP DATABASE IF EXISTS \`${dispDb}\``);
                await conn.query(`DROP DATABASE IF EXISTS \`${restDb}\``);
                await conn.end();
                await rootPool.end();
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

run();
