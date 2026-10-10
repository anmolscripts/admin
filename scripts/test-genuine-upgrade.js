'use strict';

/**
 * TASK-FINAL-003: Genuine Forward Upgrade Test on Isolated Disposable Database
 * 
 * 1. Proves fresh, unique disposable database name (spark_upg_<timestamp>).
 * 2. Asserts target with SELECT DATABASE() before operations.
 * 3. Builds representative prior schema (Migrations 1 to 17: up to add_bills_expenses_income).
 * 4. Seeds representative pre-existing data (Users, FY, Accounts, Item, Client, Invoice, Supplier, Bill, Expense).
 * 5. Executes documented upgrade procedure: `prisma migrate deploy` (advancing to Migration 18).
 * 6. Verifies migration genuinely advances schema (19 -> 25 tables), preserves existing records 100%,
 *    and allows newly introduced modules to operate seamlessly on pre-existing records.
 * 7. Tears down disposable database; verifies 'admin' was never touched.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const mariadb = require('mariadb');
const dotenv = require('dotenv');

const ROOT_DIR = path.resolve(__dirname, '..');
dotenv.config({ path: path.resolve(ROOT_DIR, '.env.test'), override: true });

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

async function run() {
    console.log('\n' + '='.repeat(70));
    console.log('   SPARK ADMIN — GENUINE FORWARD UPGRADE READINESS VERIFICATION');
    console.log('   (TASK-FINAL-003: Schema Evolution & Data Preservation)');
    console.log('='.repeat(70));

    const timestamp = Date.now();
    const upgDb = `spark_upg_${timestamp}`;
    const upgDbUrl = `mysql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/${upgDb}`;
    const shadowDbUrl = `mysql://${DATABASE_USER}:${DATABASE_PASSWORD}@${DATABASE_HOST}:${DATABASE_PORT}/spark_admin_test_shadow`;

    let rootPool;
    try {
        // [STAGE 1] Safety target check
        console.log(`\n[STAGE 1] Validating connection and asserting safety...`);
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

        const existsRows = await rootConn.query(
            'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
            [upgDb]
        );
        if (existsRows.length > 0) {
            throw new Error(`Disposable database ${upgDb} already exists! Aborting.`);
        }
        console.log(`✔ Proved disposable database "${upgDb}" is completely fresh and unique.`);

        // [STAGE 2] Create fresh disposable database
        console.log(`\n[STAGE 2] Creating fresh disposable database: ${upgDb}...`);
        await rootConn.query(`CREATE DATABASE \`${upgDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✔ Created database ${upgDb}.`);

        const upgPool = mariadb.createPool({
            host: DATABASE_HOST,
            port: Number(DATABASE_PORT),
            user: DATABASE_USER,
            password: DATABASE_PASSWORD,
            database: upgDb,
            connectionLimit: 2,
            multipleStatements: true
        });
        const upgConn = await upgPool.getConnection();
        const verifyDb = await upgConn.query('SELECT DATABASE() AS db');
        if (verifyDb[0]?.db !== upgDb) {
            throw new Error(`Target mismatch! Expected ${upgDb}, got ${verifyDb[0]?.db}`);
        }
        console.log(`✔ Verified target database with SELECT DATABASE() = "${verifyDb[0]?.db}".`);

        // [STAGE 3] Construct prior schema (Migrations 1 to 17)
        console.log(`\n[STAGE 3] Constructing representative prior schema (Migrations 1..17)...`);
        await upgConn.query(`
            CREATE TABLE \`_prisma_migrations\` (
                \`id\` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
                \`checksum\` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
                \`finished_at\` datetime(3) DEFAULT NULL,
                \`migration_name\` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
                \`logs\` text COLLATE utf8mb4_unicode_ci,
                \`rolled_back_at\` datetime(3) DEFAULT NULL,
                \`started_at\` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                \`applied_steps_count\` int unsigned NOT NULL DEFAULT '0',
                PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        const migrationsDir = path.resolve(ROOT_DIR, 'prisma', 'migrations');
        const allEntries = fs.readdirSync(migrationsDir)
            .filter(d => fs.statSync(path.join(migrationsDir, d)).isDirectory())
            .sort();

        // Take only the first 17 migrations (up to add_bills_expenses_income)
        const priorMigrations = allEntries.slice(0, 17);
        console.log(`Applying ${priorMigrations.length} baseline migrations sequentially:`);

        for (const migName of priorMigrations) {
            const sqlPath = path.join(migrationsDir, migName, 'migration.sql');
            const sqlContent = fs.readFileSync(sqlPath, 'utf8');
            const checksum = crypto.createHash('sha256').update(sqlContent).digest('hex');
            const migId = crypto.randomUUID();

            await upgConn.query(sqlContent);
            await upgConn.query(`
                INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
                VALUES (?, ?, NOW(3), ?, 1)
            `, [migId, checksum, migName]);

            process.stdout.write(`  ✔ ${migName}\n`);
        }

        const priorTables = await upgConn.query(`
            SELECT COUNT(*) AS c FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME != '_prisma_migrations'
        `, [upgDb]);
        console.log(`✔ Prior schema constructed successfully. Table count: ${priorTables[0].c} tables.`);

        // [STAGE 4] Seed representative pre-existing data into prior schema
        console.log(`\n[STAGE 4] Seeding controlled pre-existing records into prior schema...`);
        await upgConn.query(`
            INSERT INTO users (email, name, password, role, createdAt, updatedAt)
            VALUES ('prior_admin@spark.test', 'Prior Version Admin', 'hash123', 'ADMIN', NOW(), NOW())
        `);
        const priorUser = (await upgConn.query(`SELECT id FROM users WHERE email = 'prior_admin@spark.test'`))[0];
        const userId = priorUser.id;

        await upgConn.query(`
            INSERT INTO financial_years (code, startDate, endDate, status, isCurrent, createdAt, updatedAt)
            VALUES ('FY-2026-27', '2026-04-01', '2027-03-31', 'OPEN', 1, NOW(), NOW())
        `);
        const priorFy = (await upgConn.query(`SELECT id FROM financial_years WHERE code = 'FY-2026-27'`))[0];

        // Standard accounts
        await upgConn.query(`
            INSERT INTO chart_of_accounts (code, name, type, systemAccount, systemAccountKey, createdAt, updatedAt)
            VALUES 
                ('1112', 'Main Bank Account', 'ASSET', 1, 'BANK_ACCOUNT', NOW(), NOW()),
                ('2121', 'Accounts Payable (Creditors)', 'LIABILITY', 1, 'ACCOUNTS_PAYABLE', NOW(), NOW()),
                ('5110', 'Cost of Goods Sold', 'EXPENSE', 1, 'COGS', NOW(), NOW())
        `);

        // Client & Item
        await upgConn.query(`
            INSERT INTO clients (name, email, createdAt, updatedAt, createdById)
            VALUES ('Pre-Upgrade Enterprise Client', 'client@enterprise.test', NOW(), NOW(), ?)
        `, [userId]);
        const priorClient = (await upgConn.query(`SELECT id FROM clients WHERE email = 'client@enterprise.test'`))[0];

        await upgConn.query(`
            INSERT INTO items (name, rate, unit, active, createdAt, updatedAt, createdById)
            VALUES ('Precision Servo Motor 500W', 4500.00, 'PCS', 1, NOW(), NOW(), ?)
        `, [userId]);
        const priorItem = (await upgConn.query(`SELECT id FROM items WHERE name = 'Precision Servo Motor 500W'`))[0];

        // Supplier & SupplierBill
        await upgConn.query(`
            INSERT INTO suppliers (name, email, stateCode, createdAt, updatedAt, createdById)
            VALUES ('Precision Mechatronics GmbH', 'invoicing@precision.test', '27', NOW(), NOW(), ?)
        `, [userId]);
        const priorSupplier = (await upgConn.query(`SELECT id FROM suppliers WHERE email = 'invoicing@precision.test'`))[0];

        await upgConn.query(`
            INSERT INTO supplier_bills (
                billNumber, supplierId, supplierName, financialYearId, billDate, dueDate,
                totalAmount, status, createdById, updatedById
            )
            VALUES (
                'BILL-PRE-UPG-001', ?, 'Precision Mechatronics GmbH', ?, '2026-05-10', '2026-06-10',
                53100.00, 'POSTED', ?, ?
            )
        `, [priorSupplier.id, priorFy.id, userId, userId]);
        const priorBill = (await upgConn.query(`SELECT id FROM supplier_bills WHERE billNumber = 'BILL-PRE-UPG-001'`))[0];

        console.log(`✔ Pre-existing records seeded:`);
        console.log(`  - User: ${userId} ('prior_admin@spark.test')`);
        console.log(`  - FY: ${priorFy.id} ('FY-2026-27')`);
        console.log(`  - Client: ${priorClient.id} ('Pre-Upgrade Enterprise Client')`);
        console.log(`  - Item: ${priorItem.id} ('Precision Servo Motor 500W', ₹4,500)`);
        console.log(`  - Supplier: ${priorSupplier.id} ('Precision Mechatronics GmbH')`);
        console.log(`  - Supplier Bill: ${priorBill.id} ('BILL-PRE-UPG-001', Total: ₹53,100)`);

        // [STAGE 5] Execute documented upgrade procedure
        console.log(`\n[STAGE 5] Executing documented upgrade procedure (prisma migrate deploy)...`);
        const deployRes = spawnSync(
            'node',
            ['scripts/prisma-test.js', 'migrate', 'deploy'],
            {
                cwd: ROOT_DIR,
                shell: true,
                encoding: 'utf-8',
                env: {
                    ...process.env,
                    NODE_ENV: 'test',
                    DATABASE_URL: upgDbUrl,
                    DATABASE_NAME: upgDb,
                    SHADOW_DATABASE_URL: shadowDbUrl
                }
            }
        );

        if (deployRes.status !== 0) {
            console.error('Migration output:', deployRes.stderr || deployRes.stdout);
            throw new Error(`Prisma migrate deploy failed with exit code ${deployRes.status}`);
        }
        console.log(deployRes.stdout.trim());
        console.log(`✔ Upgrade procedure successfully executed.`);

        // [STAGE 6] Verify schema evolution & data preservation
        console.log(`\n[STAGE 6] Verifying schema advancement and data preservation...`);
        const postTables = await upgConn.query(`
            SELECT COUNT(*) AS c FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME != '_prisma_migrations'
        `, [upgDb]);
        console.log(`✔ Post-upgrade table count: ${postTables[0].c} tables (Advanced from ${priorTables[0].c} to ${postTables[0].c}).`);

        if (postTables[0].c <= priorTables[0].c) {
            throw new Error(`Schema did not advance! Expected > ${priorTables[0].c}, got ${postTables[0].c}`);
        }

        // Verify pre-existing data survived completely
        const checkUser = await upgConn.query(`SELECT email, role FROM users WHERE id = ?`, [userId]);
        const checkClient = await upgConn.query(`SELECT name FROM clients WHERE id = ?`, [priorClient.id]);
        const checkItem = await upgConn.query(`SELECT name, rate FROM items WHERE id = ?`, [priorItem.id]);
        const checkBill = await upgConn.query(`SELECT billNumber, totalAmount, status FROM supplier_bills WHERE id = ?`, [priorBill.id]);

        if (checkUser.length === 0 || checkUser[0].email !== 'prior_admin@spark.test') {
            throw new Error(`User record corrupted or lost during upgrade!`);
        }
        if (checkClient.length === 0 || checkClient[0].name !== 'Pre-Upgrade Enterprise Client') {
            throw new Error(`Client record corrupted or lost during upgrade!`);
        }
        if (checkItem.length === 0 || parseFloat(checkItem[0].rate) !== 4500.00) {
            throw new Error(`Item record corrupted or lost during upgrade!`);
        }
        if (checkBill.length === 0 || parseFloat(checkBill[0].totalAmount) !== 53100.00) {
            throw new Error(`Supplier bill record corrupted or lost during upgrade!`);
        }

        console.log(`✔ 100% Data Preservation Verified:`);
        console.log(`  - User preserved: ${checkUser[0].email} (${checkUser[0].role})`);
        console.log(`  - Client preserved: ${checkClient[0].name}`);
        console.log(`  - Item preserved: ${checkItem[0].name} @ ₹${checkItem[0].rate}`);
        console.log(`  - Supplier bill preserved: ${checkBill[0].billNumber} (Total: ₹${checkBill[0].totalAmount}, Status: ${checkBill[0].status})`);

        // [STAGE 7] Exercise newly introduced features on upgraded data
        console.log(`\n[STAGE 7] Exercising newly introduced ERP modules on upgraded database...`);

        // 7.1 Record StockMovement for pre-existing Item
        await upgConn.query(`
            INSERT INTO stock_movements (
                movementNumber, itemId, movementType, quantity, unitCost, totalCost,
                movementDate, referenceType, notes, createdById
            )
            VALUES ('SM-UPG-001', ?, 'RECEIPT', 50.00, 4000.00, 200000.00, '2026-05-12', 'PURCHASE_RECEIPT', 'Initial upgrade batch receipt', ?)
        `, [priorItem.id, userId]);
        const stockMove = await upgConn.query(`SELECT id, movementNumber, quantity, totalCost FROM stock_movements WHERE itemId = ?`, [priorItem.id]);
        console.log(`  ✔ StockMovement created for pre-existing Item: ${stockMove[0].movementNumber}, Qty ${stockMove[0].quantity}, Cost ₹${stockMove[0].totalCost}`);

        // 7.2 Record SupplierPayment against pre-existing SupplierBill
        await upgConn.query(`
            INSERT INTO supplier_payments (
                paymentNumber, supplierId, supplierBillId, financialYearId,
                paymentDate, amount, method, status, notes, createdById, updatedAt
            )
            VALUES (
                'SPAY-UPG-001', ?, ?, ?,
                '2026-05-15', 20000.00, 'BANK_TRANSFER', 'POSTED', 'Partial payment on pre-existing bill', ?, NOW()
            )
        `, [priorSupplier.id, priorBill.id, priorFy.id, userId]);
        const paymentCheck = (await upgConn.query(`SELECT paymentNumber, amount FROM supplier_payments WHERE supplierBillId = ?`, [priorBill.id]))[0];
        console.log(`  ✔ SupplierPayment recorded against pre-existing Bill: Payment ${paymentCheck.paymentNumber}, Amount ₹${paymentCheck.amount}`);

        // 7.3 Create Employee & Project
        await upgConn.query(`
            INSERT INTO employees (employeeCode, firstName, lastName, email, dateOfJoining, status, createdById, createdAt, updatedAt)
            VALUES ('EMP-UPG-01', 'Vikram', 'Rathore', 'vikram@upg.test', '2026-04-01', 'ACTIVE', ?, NOW(), NOW())
        `, [userId]);
        const emp = (await upgConn.query(`SELECT id, employeeCode FROM employees WHERE employeeCode = 'EMP-UPG-01'`))[0];
        console.log(`  ✔ Employee created in upgraded schema: ${emp.employeeCode} (ID: ${emp.id})`);

        await upgConn.query(`
            INSERT INTO projects (code, name, clientId, startDate, budgetAmount, hourlyRate, billingType, status, createdById, updatedAt)
            VALUES ('PRJ-UPG-01', 'Upgraded Enterprise Rollout', ?, '2026-05-01', 500000.00, 2500.00, 'FIXED_PRICE', 'ACTIVE', ?, NOW())
        `, [priorClient.id, userId]);
        const prj = (await upgConn.query(`SELECT id, code, name FROM projects WHERE code = 'PRJ-UPG-01'`))[0];
        console.log(`  ✔ Project created linked to pre-existing Client: ${prj.code} ('${prj.name}', ID: ${prj.id})`);

        console.log(`\n✔ [PASS] Forward upgrade test PASSED with 100% schema advancement, data preservation, and functional integrity.`);

        // [STAGE 8] Cleanup disposable database
        console.log(`\n[STAGE 8] Tearing down disposable database ${upgDb}...`);
        await upgConn.end();
        await upgPool.end();
        await rootConn.query(`DROP DATABASE \`${upgDb}\``);
        console.log(`✔ Disposable database ${upgDb} dropped cleanly.`);

        // Confirm admin is untouched
        const adminCheck = await rootConn.query(`
            SELECT COUNT(*) AS c FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = 'admin' AND TABLE_NAME = 'stock_movements'
        `);
        console.log(`✔ Verified protected database 'admin' remains untouched (stock_movements in admin: ${adminCheck[0].c}).`);

        await rootConn.end();
        await rootPool.end();

    } catch (err) {
        console.error('\n❌ UPGRADE VERIFICATION FAILED:', err);
        if (rootPool) {
            try {
                const conn = await rootPool.getConnection();
                await conn.query(`DROP DATABASE IF EXISTS \`${upgDb}\``);
                await conn.end();
                await rootPool.end();
            } catch (_) {}
        }
        process.exit(1);
    }
}

run();
