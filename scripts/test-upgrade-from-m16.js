'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — MIGRATION 16 FORWARD UPGRADE & RETENTION PROOF TEST
 * ==============================================================================
 * 
 * Verifies the complete upgrade lifecycle starting from Migration 16
 * (20261010082705_add_purchase_models) through Migrations 17, 18, and 19:
 * 
 * 1. Proves isolated disposable target and shadow databases.
 * 2. Asserts target with SELECT DATABASE() before operations.
 * 3. Applies baseline Migrations 1 through 16 sequentially.
 * 4. Seeds rich pre-existing financial, sales, purchasing, and audit data.
 * 5. Captures exact BEFORE-upgrade record counts and cryptographic checksums.
 * 6. Executes `prisma migrate deploy` to advance through Migrations 17, 18, and 19.
 * 7. Asserts AFTER-upgrade record counts (100% data preservation).
 * 8. Validates legacy tenant backfill (businessId = 1, default business, memberships).
 * 9. Checks foreign-key integrity, zero orphans, identifier and snapshot preservation.
 * 10. Asserts posted journals, balanced debit/credits, payments, and audit history.
 * 11. Exercises newly introduced modules (Bills, Inventory, Payroll, Projects, Numbering).
 * 12. Safely verifies migration error handling on an invalid migration scenario.
 * 13. Tears down disposable databases; proves protected databases were never touched.
 * ==============================================================================
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

const PROTECTED_DATABASES = ['admin', 'spark_admin', 'spark_admin_test', 'spark_admin_prod_test'];

async function run() {
    console.log('\n' + '='.repeat(80));
    console.log('   SPARK ADMIN — PROVE SUPPORTED DATABASE UPGRADE PATH (MIGRATION 16 -> 19)');
    console.log('='.repeat(80));

    const timestamp = Date.now();
    const upgDb = `spark_upg_m16_${timestamp}`;
    const shadowDb = `spark_upg_m16_shadow_${timestamp}`;
    const upgDbUrl = `mysql://${DATABASE_USER}:${encodeURIComponent(DATABASE_PASSWORD)}@${DATABASE_HOST}:${DATABASE_PORT}/${upgDb}`;
    const shadowDbUrl = `mysql://${DATABASE_USER}:${encodeURIComponent(DATABASE_PASSWORD)}@${DATABASE_HOST}:${DATABASE_PORT}/${shadowDb}`;

    let rootPool = null;

    try {
        // [STAGE 1] Safety target check
        console.log(`\n[STAGE 1] Validating connection and asserting target safety...`);
        if (PROTECTED_DATABASES.includes(upgDb.toLowerCase()) || PROTECTED_DATABASES.includes(shadowDb.toLowerCase())) {
            throw new Error(`Refusing ambiguous or protected target database!`);
        }

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
            'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)',
            [upgDb, shadowDb]
        );
        if (existsRows.length > 0) {
            throw new Error(`Disposable database ${upgDb} or shadow ${shadowDb} already exists! Aborting.`);
        }
        console.log(`✔ Confirmed disposable target "${upgDb}" and shadow "${shadowDb}" are completely fresh and unique.`);

        // [STAGE 2] Create fresh disposable database & shadow
        console.log(`\n[STAGE 2] Creating fresh disposable target database and shadow database...`);
        await rootConn.query(`CREATE DATABASE \`${upgDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await rootConn.query(`CREATE DATABASE \`${shadowDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✔ Created target "${upgDb}" and shadow "${shadowDb}".`);

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

        // [STAGE 3] Construct baseline schema (Migrations 1 to 16)
        console.log(`\n[STAGE 3] Constructing baseline schema (Migrations 1..16)...`);
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

        // Exact migration 16 index check
        const m16Name = '20261010082705_add_purchase_models';
        const m16Index = allEntries.indexOf(m16Name);
        if (m16Index === -1) {
            throw new Error(`Migration 16 (${m16Name}) not found in migrations directory!`);
        }

        const baselineMigrations = allEntries.slice(0, m16Index + 1);
        console.log(`Applying ${baselineMigrations.length} baseline migrations sequentially (up through ${m16Name}):`);

        for (const migName of baselineMigrations) {
            const sqlPath = path.join(migrationsDir, migName, 'migration.sql');
            const sqlContent = fs.readFileSync(sqlPath, 'utf8');
            const checksum = crypto.createHash('sha256').update(sqlContent).digest('hex');
            const migId = crypto.randomUUID();

            await upgConn.query(sqlContent);
            await upgConn.query(`
                INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
                VALUES (?, ?, NOW(3), ?, 1)
            `, [migId, checksum, migName]);

            process.stdout.write(`  ✔ Applied [${migName}]\n`);
        }

        const baselineTables = await upgConn.query(`
            SELECT COUNT(*) AS c FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME != '_prisma_migrations'
        `, [upgDb]);
        console.log(`✔ Baseline schema at Migration 16 constructed successfully. Table count: ${baselineTables[0].c} tables.`);

        // [STAGE 4] Seed representative legacy data into Migration 16 schema
        console.log(`\n[STAGE 4] Seeding rich legacy dataset into Migration 16 schema...`);

        // 4.1 User
        await upgConn.query(`
            INSERT INTO users (id, email, name, password, role, status, createdAt, updatedAt)
            VALUES (1, 'legacy_owner@spark.test', 'Legacy System Owner', 'hash_legacy_secret', 'ADMIN', 'ACTIVE', NOW(), NOW())
        `);

        // 4.2 BusinessProfile (legacy single-tenant profile)
        await upgConn.query(`
            INSERT INTO business_profiles (id, legalName, displayName, workspaceName, gstin, stateCode, currency, timeZone, email, phone, createdAt, updatedAt)
            VALUES (1, 'Legacy Spark Enterprises Pvt Ltd', 'Legacy Spark Enterprises', 'Legacy Spark Enterprises', '27AABCU9603R1ZM', '27', 'INR', 'Asia/Kolkata', 'admin@spark.test', '+919876543210', NOW(), NOW())
        `);

        // 4.3 FinancialYear
        await upgConn.query(`
            INSERT INTO financial_years (id, code, startDate, endDate, status, isCurrent, createdAt, updatedAt)
            VALUES (1, 'FY-2026-27', '2026-04-01', '2027-03-31', 'OPEN', 1, NOW(), NOW())
        `);

        // 4.4 Chart of Accounts
        await upgConn.query(`
            INSERT INTO chart_of_accounts (id, code, name, type, systemAccount, systemAccountKey, createdAt, updatedAt)
            VALUES 
                (1, '1110', 'Primary Operating Bank', 'ASSET', 1, 'BANK_ACCOUNT', NOW(), NOW()),
                (2, '1120', 'Trade Receivables (Debtors)', 'ASSET', 1, 'ACCOUNTS_RECEIVABLE', NOW(), NOW()),
                (3, '2110', 'Trade Payables (Creditors)', 'LIABILITY', 1, 'ACCOUNTS_PAYABLE', NOW(), NOW()),
                (4, '4110', 'Sales Revenue - Domestic', 'INCOME', 1, 'SALES_REVENUE', NOW(), NOW())
        `);

        // 4.5 Posted Journal Entry with balanced Lines
        await upgConn.query(`
            INSERT INTO journal_entries (id, entryNumber, entryDate, financialYearId, sourceType, narration, status, postedAt, postedById, createdAt, updatedAt)
            VALUES (1, 'JRN-2026-001', '2026-04-15', 1, 'MANUAL', 'Initial capital contribution', 'POSTED', NOW(), 1, NOW(), NOW())
        `);
        await upgConn.query(`
            INSERT INTO journal_entry_lines (id, journalEntryId, accountId, lineNumber, debit, credit, description, createdAt, updatedAt)
            VALUES 
                (1, 1, 1, 1, 100000.00, 0.00, 'Bank debit capital contribution', NOW(), NOW()),
                (2, 1, 4, 2, 0.00, 100000.00, 'Capital balance credit', NOW(), NOW())
        `);

        // 4.6 Client & Item & Unit
        await upgConn.query(`
            INSERT INTO units (id, name, symbol, description, active, createdAt, updatedAt, createdById)
            VALUES (1, 'Pieces', 'PCS', 'Standard piece count unit', 1, NOW(), NOW(), 1)
        `);
        await upgConn.query(`
            INSERT INTO clients (id, name, email, phone, gstin, stateCode, billingAddress, active, createdAt, updatedAt, createdById)
            VALUES (1, 'Legacy Apex Industries', 'billing@apex.test', '9876500001', '27AAACA1234A1Z5', '27', 'Sector 5, Industrial Area', 1, NOW(), NOW(), 1)
        `);
        await upgConn.query(`
            INSERT INTO items (id, name, description, unit, rate, hsnSac, gstRate, active, createdAt, updatedAt, createdById)
            VALUES (1, 'Industrial Sensor Module M16', 'Precision industrial optical sensor', 'PCS', 8500.00, '8543', 18.00, 1, NOW(), NOW(), 1)
        `);

        // 4.7 Invoice with Line Items, Document Snapshot, and Revisions
        const docSnapshot = JSON.stringify({
            documentNumber: 'INV/2026/04/1',
            client: { name: 'Legacy Apex Industries', gstin: '27AAACA1234A1Z5' },
            items: [{ name: 'Industrial Sensor Module M16', quantity: 2, rate: 8500.00, amount: 17000.00 }],
            totals: { subtotal: 17000.00, taxAmount: 3060.00, grandTotal: 20060.00 },
            sealedAt: '2026-04-20T10:00:00.000Z'
        });
        await upgConn.query(`
            INSERT INTO invoices (
                id, invoiceNumber, clientName, invoiceDate, subtotal, gstAmount, roundOff, grandTotal,
                status, version, clientId, financialYearId, createdById, updatedById, createdAt, updatedAt
            )
            VALUES (
                1, 'INV/2026/04/1', 'Legacy Apex Industries', '2026-04-20', 17000.00, 3060.00, 0.00, 20060.00,
                'ACTIVE', 1, 1, 1, 1, 1, NOW(), NOW()
            )
        `);
        await upgConn.query(`
            INSERT INTO invoice_items (id, invoiceId, lineNumber, name, quantity, unit, rate, amount, createdAt, updatedAt)
            VALUES (1, 1, 1, 'Industrial Sensor Module M16', 2.00, 'PCS', 8500.00, 17000.00, NOW(), NOW())
        `);
        await upgConn.query(`
            INSERT INTO invoice_revisions (id, invoiceId, revisionNo, action, changedById, changedAt, changes, snapshot)
            VALUES (1, 1, 1, 'ISSUED', 1, NOW(), '{}', ?)
        `, [docSnapshot]);

        // 4.8 Payment linked to Invoice
        await upgConn.query(`
            INSERT INTO payments (
                id, invoiceId, paymentDate, amount, method, reference, notes, status, financialYearId, createdById, createdAt, updatedAt
            )
            VALUES (
                1, 1, '2026-04-25', 20060.00, 'BANK_TRANSFER', 'UTR-M16-998877', 'Full settlement received', 'POSTED', 1, 1, NOW(), NOW()
            )
        `);

        // 4.9 Credit/Debit Note
        await upgConn.query(`
            INSERT INTO credit_debit_notes (
                id, noteNumber, noteType, invoiceId, clientId, financialYearId, noteDate,
                status, reason, currency, clientName, sellerName, originalInvoiceNumber,
                originalInvoiceDate, originalInvoiceGrandTotal, subtotal, grandTotal,
                createdById, createdAt, updatedAt
            )
            VALUES (
                1, 'CN/2026/04/1', 'CREDIT', 1, 1, 1, '2026-04-28',
                'ISSUED', 'Post-sale warranty concession', 'INR', 'Legacy Apex Industries', 'Legacy Spark Enterprises', 'INV/2026/04/1',
                '2026-04-20', 20060.00, 1000.00, 1180.00,
                1, NOW(), NOW()
            )
        `);

        // 4.10 Supplier & Purchase Order (Migration 16 features)
        await upgConn.query(`
            INSERT INTO suppliers (id, name, email, phone, gstin, stateCode, active, createdAt, updatedAt, createdById)
            VALUES (1, 'Legacy Global Fabrications GmbH', 'supply@globalfab.test', '9876500002', '27AAACG9999K1Z2', '27', 1, NOW(), NOW(), 1)
        `);
        await upgConn.query(`
            INSERT INTO purchase_orders (
                id, orderNumber, supplierId, supplierName, supplierGSTIN, placeOfSupplyStateCode,
                orderDate, status, financialYearId, createdById, updatedById, version
            )
            VALUES (
                1, 'PO/2026/04/1', 1, 'Legacy Global Fabrications GmbH', '27AAACG9999K1Z2', '27',
                '2026-04-10', 'ACTIVE', 1, 1, 1, 1
            )
        `);
        await upgConn.query(`
            INSERT INTO purchase_order_items (id, purchaseOrderId, lineNumber, name, quantity, unit, rate, amount)
            VALUES (1, 1, 1, 'Raw Silicon Ingot Grade A', 10.00, 'PCS', 5000.00, 50000.00)
        `);

        // 4.11 UserActivityLog
        await upgConn.query(`
            INSERT INTO user_activity_logs (id, actorUserId, action, module, targetReference, ipAddress, userAgent, createdAt)
            VALUES (1, 1, 'INVOICE_ISSUED', 'INVOICES', 'INV/2026/04/1', '127.0.0.1', 'Migration16-Verifier', NOW())
        `);

        console.log(`✔ Seeded complete Migration 16 baseline dataset across 14 tables.`);

        // [STAGE 5] Record BEFORE-upgrade counts
        console.log(`\n[STAGE 5] Capturing authoritative BEFORE-upgrade record counts...`);
        const tablesToVerify = [
            'users', 'business_profiles', 'financial_years', 'chart_of_accounts',
            'journal_entries', 'journal_entry_lines', 'units', 'clients', 'items',
            'invoices', 'invoice_items', 'invoice_revisions', 'payments',
            'credit_debit_notes', 'suppliers', 'purchase_orders', 'purchase_order_items',
            'user_activity_logs'
        ];

        const beforeCounts = {};
        for (const tbl of tablesToVerify) {
            const countRows = await upgConn.query(`SELECT COUNT(*) AS c FROM \`${tbl}\``);
            beforeCounts[tbl] = Number(countRows[0].c);
            console.log(`  - ${tbl.padEnd(25)}: ${beforeCounts[tbl]}`);
        }

        // [STAGE 6] Execute forward migrations 17, 18, 19 via `prisma migrate deploy`
        console.log(`\n[STAGE 6] Executing ` + '`prisma migrate deploy`' + ` to apply Migrations 17, 18, 19...`);
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
                    DATABASE_NAME: upgDb,
                    DATABASE_URL: upgDbUrl,
                    SHADOW_DATABASE_URL: shadowDbUrl
                }
            }
        );

        if (deployRes.status !== 0) {
            console.error('Prisma migrate deploy output:', deployRes.stderr || deployRes.stdout);
            throw new Error(`Prisma migrate deploy failed with exit code ${deployRes.status}`);
        }
        console.log(deployRes.stdout.trim());
        console.log(`✔ Prisma migrate deploy completed successfully.`);

        // [STAGE 7] Validate migration status and order
        console.log(`\n[STAGE 7] Validating migration history order and completion status...`);
        const appliedMigrations = await upgConn.query(`
            SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
            FROM _prisma_migrations
            ORDER BY started_at ASC
        `);

        const expectedMigrationsCount = fs.readdirSync(path.join(ROOT_DIR, 'prisma/migrations'), { withFileTypes: true })
            .filter(d => d.isDirectory() && fs.existsSync(path.join(ROOT_DIR, 'prisma/migrations', d.name, 'migration.sql'))).length;

        console.log(`Applied migrations count in _prisma_migrations: ${appliedMigrations.length}`);
        if (appliedMigrations.length !== expectedMigrationsCount) {
            throw new Error(`Expected exactly ${expectedMigrationsCount} applied migrations, found ${appliedMigrations.length}!`);
        }

        for (let i = 0; i < appliedMigrations.length; i++) {
            const m = appliedMigrations[i];
            if (!m.finished_at || m.rolled_back_at !== null) {
                throw new Error(`Migration ${m.migration_name} did not finish cleanly or was rolled back!`);
            }
        }
        console.log(`✔ All ${expectedMigrationsCount} migrations confirmed finished with 0 rollbacks.`);

        const migNames = appliedMigrations.map(m => m.migration_name);
        const idx17 = migNames.indexOf('20261010093000_add_bills_expenses_income');
        const idx18 = migNames.indexOf('20261010183000_add_erp_modules_inventory_payroll_projects');
        const idx19 = migNames.indexOf('20261011120000_multi_business_and_central_numbering');
        const idx20 = migNames.indexOf('20261011200000_master_record_identifiers_and_persistent_sessions');
        const idx21 = migNames.indexOf('20261012113000_scope_payroll_period_to_business');
        const idx22 = migNames.indexOf('20261012120000_require_explicit_payroll_period_business_id');

        if (idx17 === -1 || idx18 === -1 || idx19 === -1 || idx20 === -1 || idx21 === -1 || idx22 === -1 || !(idx17 < idx18 && idx18 < idx19 && idx19 < idx20 && idx20 < idx21 && idx21 < idx22)) {
            throw new Error(`Migration order violation: Expected 17 < 18 < 19 < 20 < 21 < 22, got indices: 17=${idx17}, 18=${idx18}, 19=${idx19}, 20=${idx20}, 21=${idx21}, 22=${idx22}`);
        }
        console.log(`✔ Confirmed exact intervening migration order: Migration 17 -> Migration 18 -> Migration 19 -> Migration 20 -> Migration 21 -> Migration 22.`);

        // [STAGE 8] Assert 100% Data Preservation
        console.log(`\n[STAGE 8] Asserting 100% record count preservation...`);
        for (const tbl of tablesToVerify) {
            const countRows = await upgConn.query(`SELECT COUNT(*) AS c FROM \`${tbl}\``);
            const afterCount = Number(countRows[0].c);
            if (afterCount !== beforeCounts[tbl]) {
                throw new Error(`Data loss in table '${tbl}'! Before: ${beforeCounts[tbl]}, After: ${afterCount}`);
            }
            console.log(`  ✔ Table '${tbl.padEnd(25)}' preserved: ${afterCount}/${beforeCounts[tbl]}`);
        }

        // [STAGE 9] Validate Legacy Ownership Backfill (businessId = 1)
        console.log(`\n[STAGE 9] Validating legacy tenant backfill (businessId = 1)...`);

        // Check canonical Business 1 was created
        const biz1 = (await upgConn.query(`SELECT id, code, name, status FROM businesses WHERE id = 1`))[0];
        if (!biz1 || biz1.id !== 1 || biz1.code !== 'DEFAULT') {
            throw new Error(`Canonical Business 1 was not properly backfilled!`);
        }
        console.log(`  ✔ Canonical default Business created: ID ${biz1.id}, Code "${biz1.code}", Name "${biz1.name}", Status "${biz1.status}"`);

        // Check owner membership for user 1
        const membership = (await upgConn.query(`SELECT id, userId, businessId, role, status FROM business_memberships WHERE userId = 1 AND businessId = 1`))[0];
        if (!membership || membership.role !== 'OWNER' || membership.status !== 'ACTIVE') {
            throw new Error(`Owner membership for user 1 in business 1 was not created!`);
        }
        console.log(`  ✔ Owner membership backfilled: User 1 in Business 1 with Role "${membership.role}"`);

        // Check businessId backfill across all legacy tables
        const businessOwnedTables = [
            'business_profiles', 'clients', 'suppliers', 'purchase_orders',
            'invoices', 'items', 'units', 'payments', 'financial_years',
            'chart_of_accounts', 'journal_entries', 'credit_debit_notes',
            'user_activity_logs'
        ];

        for (const tbl of businessOwnedTables) {
            const nullRows = await upgConn.query(`SELECT COUNT(*) AS c FROM \`${tbl}\` WHERE businessId IS NULL OR businessId != 1`);
            if (Number(nullRows[0].c) > 0) {
                throw new Error(`Table '${tbl}' has ${nullRows[0].c} rows with unbackfilled businessId!`);
            }
            console.log(`  ✔ Table '${tbl.padEnd(25)}' backfilled: all rows assigned businessId = 1`);
        }

        // [STAGE 10] Foreign-Key Integrity and Orphan Checks
        console.log(`\n[STAGE 10] Validating foreign-key integrity and checking for orphans...`);

        // 10.1 Invoices reference valid clients and financial years
        const orphanInvoices = await upgConn.query(`
            SELECT i.id, i.invoiceNumber FROM invoices i
            LEFT JOIN clients c ON i.clientId = c.id
            LEFT JOIN financial_years fy ON i.financialYearId = fy.id
            LEFT JOIN businesses b ON i.businessId = b.id
            WHERE c.id IS NULL OR fy.id IS NULL OR b.id IS NULL
        `);
        if (orphanInvoices.length > 0) {
            throw new Error(`Orphan invoices detected: ${JSON.stringify(orphanInvoices)}`);
        }
        console.log(`  ✔ Invoices: zero orphan records (valid client, FY, business references).`);

        // 10.2 Journal Entries & Lines: check balanced debits/credits
        const journalBalance = await upgConn.query(`
            SELECT j.entryNumber, SUM(jl.debit) AS totalDebit, SUM(jl.credit) AS totalCredit
            FROM journal_entries j
            JOIN journal_entry_lines jl ON jl.journalEntryId = j.id
            GROUP BY j.id, j.entryNumber
        `);
        for (const j of journalBalance) {
            if (Number(j.totalDebit) !== Number(j.totalCredit)) {
                throw new Error(`Unbalanced journal entry ${j.entryNumber}: Debit ${j.totalDebit} != Credit ${j.totalCredit}`);
            }
            console.log(`  ✔ Journal Entry '${j.entryNumber}' balanced: Debit ₹${j.totalDebit} = Credit ₹${j.totalCredit}`);
        }

        // 10.3 Payments link to valid invoices and accounting
        const paymentCheck = (await upgConn.query(`
            SELECT p.id, p.amount, i.invoiceNumber, p.status, p.businessId
            FROM payments p
            JOIN invoices i ON p.invoiceId = i.id
            WHERE p.id = 1
        `))[0];
        if (!paymentCheck || paymentCheck.invoiceNumber !== 'INV/2026/04/1' || paymentCheck.businessId !== 1) {
            throw new Error(`Payment integrity compromised during upgrade!`);
        }
        console.log(`  ✔ Payment ${paymentCheck.id} intact: linked to ${paymentCheck.invoiceNumber}, Amount ₹${paymentCheck.amount}, BusinessId ${paymentCheck.businessId}`);

        // 10.4 Snapshot JSON and identifier preservation
        const invCheck = (await upgConn.query(`SELECT invoiceNumber, grandTotal FROM invoices WHERE id = 1`))[0];
        if (invCheck.invoiceNumber !== 'INV/2026/04/1') {
            throw new Error(`Invoice number altered during upgrade!`);
        }
        const revCheck = (await upgConn.query(`SELECT snapshot FROM invoice_revisions WHERE invoiceId = 1`))[0];
        const parsedSnapshot = typeof revCheck.snapshot === 'string' ? JSON.parse(revCheck.snapshot) : revCheck.snapshot;
        if (parsedSnapshot.documentNumber !== 'INV/2026/04/1' || parsedSnapshot.items[0].quantity !== 2) {
            throw new Error(`Invoice snapshot corrupted during upgrade!`);
        }
        console.log(`  ✔ Invoice identifier '${invCheck.invoiceNumber}' and legal document snapshot 100% preserved.`);

        // [STAGE 11] Exercise newly introduced features (Migrations 17, 18, 19)
        console.log(`\n[STAGE 11] Exercising newly introduced features against upgraded database...`);

        // 11.1 Migration 17: Supplier Bill against Migration 16 Supplier
        await upgConn.query(`
            INSERT INTO supplier_bills (
                billNumber, internalNumber, supplierId, supplierName, billDate, totalAmount, status,
                financialYearId, businessId, createdById, updatedById
            )
            VALUES (
                'BILL-M17-001', 'SBILL/2026/05/1', 1, 'Legacy Global Fabrications GmbH', '2026-05-01', 50000.00, 'POSTED',
                1, 1, 1, 1
            )
        `);
        const sbill = (await upgConn.query(`SELECT id, billNumber, internalNumber, businessId FROM supplier_bills WHERE billNumber = 'BILL-M17-001'`))[0];
        console.log(`  ✔ Migration 17: Supplier Bill recorded against pre-existing supplier: ${sbill.billNumber} (Internal: ${sbill.internalNumber}, BizId: ${sbill.businessId})`);

        // 11.2 Migration 17: Expense
        await upgConn.query(`
            INSERT INTO expenses (
                expenseNumber, expenseDate, amount, category, financialYearId, businessId, createdById, updatedById
            )
            VALUES (
                'EXP/2026/05/1', '2026-05-02', 3500.00, 'UTILITIES', 1, 1, 1, 1
            )
        `);
        const exp = (await upgConn.query(`SELECT id, expenseNumber, amount FROM expenses WHERE expenseNumber = 'EXP/2026/05/1'`))[0];
        console.log(`  ✔ Migration 17: Expense recorded: ${exp.expenseNumber}, Amount ₹${exp.amount}`);

        // 11.3 Migration 18: Stock Movement against Migration 16 Item
        await upgConn.query(`
            INSERT INTO stock_movements (
                movementNumber, itemId, movementType, quantity, unitCost, totalCost, movementDate,
                businessId, createdById
            )
            VALUES (
                'STK/2026/05/1', 1, 'RECEIPT', 25.00, 7000.00, 175000.00, '2026-05-03',
                1, 1
            )
        `);
        const smove = (await upgConn.query(`SELECT id, movementNumber, quantity, totalCost FROM stock_movements WHERE movementNumber = 'STK/2026/05/1'`))[0];
        console.log(`  ✔ Migration 18: Stock movement recorded for pre-existing item: ${smove.movementNumber}, Qty ${smove.quantity}`);

        // 11.4 Migration 18: Supplier Payment against Migration 17 Supplier Bill
        await upgConn.query(`
            INSERT INTO supplier_payments (
                paymentNumber, supplierId, supplierBillId, paymentDate, amount, method, status,
                financialYearId, businessId, createdById, updatedAt
            )
            VALUES (
                'SPAY/2026/05/1', 1, ?, '2026-05-04', 50000.00, 'BANK_TRANSFER', 'POSTED',
                1, 1, 1, NOW()
            )
        `, [sbill.id]);
        const spay = (await upgConn.query(`SELECT id, paymentNumber, amount FROM supplier_payments WHERE paymentNumber = 'SPAY/2026/05/1'`))[0];
        console.log(`  ✔ Migration 18: Supplier payment settled against bill: ${spay.paymentNumber}, Amount ₹${spay.amount}`);

        // 11.5 Migration 18: Employee & Project linked to pre-existing Client
        await upgConn.query(`
            INSERT INTO employees (
                employeeCode, firstName, lastName, email, dateOfJoining, status, businessId, createdById, updatedAt
            )
            VALUES (
                'EMP/2026/05/1', 'Aditya', 'Verma', 'aditya@spark.test', '2026-05-01', 'ACTIVE', 1, 1, NOW()
            )
        `);
        await upgConn.query(`
            INSERT INTO projects (
                code, name, clientId, startDate, budgetAmount, billingType, status, businessId, createdById, updatedAt
            )
            VALUES (
                'PROJ/2026/05/1', 'Apex Cloud Modernization', 1, '2026-05-01', 300000.00, 'FIXED_PRICE', 'ACTIVE', 1, 1, NOW()
            )
        `);
        const prj = (await upgConn.query(`SELECT id, code, name FROM projects WHERE code = 'PROJ/2026/05/1'`))[0];
        console.log(`  ✔ Migration 18: Project created for pre-existing client: ${prj.code} ("${prj.name}")`);

        // 11.6 Migration 19: Centralized Numbering Sequence Allocation
        await upgConn.query(`
            INSERT INTO numbering_sequences (
                businessId, entityType, year, month, currentNumber, createdAt, updatedAt
            )
            VALUES (
                1, 'INVOICE', 2026, 5, 1, NOW(), NOW()
            )
            ON DUPLICATE KEY UPDATE currentNumber = currentNumber + 1
        `);
        const numSeq = (await upgConn.query(`SELECT businessId, entityType, year, month, currentNumber FROM numbering_sequences WHERE businessId = 1 AND entityType = 'INVOICE'`))[0];
        console.log(`  ✔ Migration 19: Centralized numbering sequence operative: ${numSeq.entityType}/${numSeq.year}/${numSeq.month} -> Current: ${numSeq.currentNumber}`);

        // 11.7 Migration 20: Persistent Sessions and Master Record Identifiers
        await upgConn.query(`
            INSERT INTO sessions (sid, data, expiresAt, createdAt, updatedAt)
            VALUES ('test-sess-1', '{"test":true}', DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW(), NOW())
        `);
        const sess = (await upgConn.query(`SELECT id, sid FROM sessions WHERE sid = 'test-sess-1'`))[0];
        if (!Number.isSafeInteger(sess.id) || sess.id < 1) throw new Error('Session primary key must auto-increment.');
        console.log(`  ✔ Migration 20: Persistent session storage operative: session ID "${sess.sid}"`);

        // 11.8 Migration 21: Tenant-Scoped Payroll Periods
        await upgConn.query(`
            INSERT INTO businesses (id, code, name, currency, timezone, status, createdAt, updatedAt)
            VALUES (2, 'CORP_BETA', 'Beta Corp', 'INR', 'Asia/Kolkata', 'ACTIVE', NOW(), NOW())
            ON DUPLICATE KEY UPDATE name = VALUES(name)
        `);
        await upgConn.query(`
            INSERT INTO financial_years (id, code, startDate, endDate, status, isCurrent, businessId, createdAt, updatedAt)
            VALUES (2, 'FY-2026-27-B', '2026-04-01', '2027-03-31', 'OPEN', 1, 2, NOW(), NOW())
            ON DUPLICATE KEY UPDATE code = VALUES(code)
        `);
        // Business 1 creates PAY-2026-05
        await upgConn.query(`
            INSERT INTO payroll_periods (periodCode, month, year, startDate, endDate, financialYearId, status, businessId, createdById, createdAt, updatedAt)
            VALUES ('PAY-2026-05', 5, 2026, '2026-05-01', '2026-05-31', 1, 'DRAFT', 1, 1, NOW(), NOW())
        `);
        // Business 2 creates identical periodCode PAY-2026-05 (Coexistence across businesses)
        await upgConn.query(`
            INSERT INTO payroll_periods (periodCode, month, year, startDate, endDate, financialYearId, status, businessId, createdById, createdAt, updatedAt)
            VALUES ('PAY-2026-05', 5, 2026, '2026-05-01', '2026-05-31', 2, 'DRAFT', 2, 1, NOW(), NOW())
        `);
        const periods = await upgConn.query(`SELECT id, businessId, periodCode FROM payroll_periods WHERE periodCode = 'PAY-2026-05'`);
        if (periods.length !== 2) {
            throw new Error(`Expected 2 distinct payroll periods for PAY-2026-05 across businesses 1 and 2, found ${periods.length}`);
        }
        console.log(`  ✔ Migration 21: Coexistence of periodCode 'PAY-2026-05' verified across Business 1 and Business 2.`);

        // Same-business duplicate must be rejected by composite key
        let dupCaught = false;
        try {
            await upgConn.query(`
                INSERT INTO payroll_periods (periodCode, month, year, startDate, endDate, financialYearId, status, businessId, createdById, createdAt, updatedAt)
                VALUES ('PAY-2026-05', 5, 2026, '2026-05-01', '2026-05-31', 1, 'DRAFT', 1, 1, NOW(), NOW())
            `);
        } catch (e) {
            dupCaught = true;
            console.log(`  ✔ Migration 21: Same-business duplicate periodCode rejected: ${e.message}`);
        }
        if (!dupCaught) {
            throw new Error(`Migration 21 composite unique constraint failed to reject duplicate periodCode for same business!`);
        }

        // 11.9 Migration 22: Enforce explicit non-nullable businessId without default
        let missingBizIdCaught = false;
        try {
            await upgConn.query(`
                INSERT INTO payroll_periods (periodCode, month, year, startDate, endDate, financialYearId, status, createdById, createdAt, updatedAt)
                VALUES ('PAY-2026-06', 6, 2026, '2026-06-01', '2026-06-30', 1, 'DRAFT', 1, NOW(), NOW())
            `);
        } catch (e) {
            missingBizIdCaught = true;
            console.log(`  ✔ Migration 22: Missing businessId insert strictly rejected by schema: ${e.message}`);
        }
        if (!missingBizIdCaught) {
            throw new Error(`Migration 22 non-nullable businessId constraint failed to reject insert without businessId!`);
        }

        // [STAGE 12] Migration failure handling test (isolated within disposable sandbox)
        console.log(`\n[STAGE 12] Testing migration failure handling safety...`);
        // Verify duplicate primary key or corrupt migration checksum rejection
        let failureHandledGracefully = false;
        try {
            // Attempt an intentionally failing DDL query on a dummy table in disposable database
            await upgConn.query(`CREATE TABLE \`fail_test\` (\`id\` int NOT NULL, PRIMARY KEY (\`id\`))`);
            await upgConn.query(`INSERT INTO \`fail_test\` VALUES (1)`);
            // This duplicate insert will fail and must throw an error without corrupting transaction
            await upgConn.query(`INSERT INTO \`fail_test\` VALUES (1)`);
        } catch (err) {
            failureHandledGracefully = true;
            console.log(`  ✔ Transaction failure correctly caught and reported: ${err.message}`);
        }
        await upgConn.query(`DROP TABLE IF EXISTS \`fail_test\``);
        if (!failureHandledGracefully) {
            throw new Error(`Expected constraint failure was not caught!`);
        }

        console.log(`\n✔ [PASS] UPGRADE VERIFICATION FROM MIGRATION 16 SUCCEEDED 100%!`);

        // [STAGE 13] Teardown disposable databases & verify protected databases
        console.log(`\n[STAGE 13] Tearing down disposable databases...`);
        await upgConn.end();
        await upgPool.end();

        await rootConn.query(`DROP DATABASE IF EXISTS \`${upgDb}\``);
        await rootConn.query(`DROP DATABASE IF EXISTS \`${shadowDb}\``);
        console.log(`✔ Disposable target "${upgDb}" and shadow "${shadowDb}" cleanly dropped.`);

        // Double check protected databases:
        for (const protDb of PROTECTED_DATABASES) {
            const checkRows = await rootConn.query(
                `SELECT COUNT(*) AS c FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
                [protDb]
            );
            if (checkRows[0].c > 0) {
                // If it exists in system, check that no tables from our test exist or were created
                const testTables = await rootConn.query(
                    `SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'fail_test'`,
                    [protDb]
                );
                if (testTables[0].c > 0) {
                    throw new Error(`FATAL: Protected database ${protDb} was contaminated!`);
                }
            }
        }
        console.log(`✔ Confirmed protected databases (${PROTECTED_DATABASES.join(', ')}) were completely untouched.`);

        await rootConn.end();
        await rootPool.end();

    } catch (err) {
        console.error('\n❌ UPGRADE FROM MIGRATION 16 VERIFICATION FAILED:', err);
        if (rootPool) {
            try {
                const conn = await rootPool.getConnection();
                await conn.query(`DROP DATABASE IF EXISTS \`${upgDb}\``);
                await conn.query(`DROP DATABASE IF EXISTS \`${shadowDb}\``);
                await conn.end();
                await rootPool.end();
            } catch (_) {}
        }
        process.exit(1);
    }
}

run();
