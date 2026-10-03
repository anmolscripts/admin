'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — ENVIRONMENT & SYSTEM HEALTH DIAGNOSTIC (DOCTOR)
 * ==============================================================================
 *
 * Read-only diagnostic command for inspecting environment, runtime, database,
 * schema, migrations, RBAC configuration, and production security invariants.
 *
 * GUARANTEE: NEVER MODIFIES DATABASE STATE OR SYSTEM CONFIGURATION.
 *
 * Usage:
 *   npm run doctor
 *   node scripts/doctor.js
 *
 * ==============================================================================
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const logger = require('./lib/logger');
const { checkNodeVersion, checkNpmVersion, checkMySqlTcpConnectivity } = require('./lib/prerequisites');
const { parseEnvFile } = require('./lib/env-manager');
const { runPrismaCommand } = require('./lib/db-manager');

const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Executes read-only doctor diagnostics.
 * @returns {Promise<{ ok: boolean, checks: Array<{ category: string, name: string, status: 'PASS'|'FAIL'|'WARN', detail: string }> }>}
 */
async function runDoctor() {
    console.log('\n' + '═'.repeat(70));
    console.log('   SPARK ADMIN — ENVIRONMENT & SYSTEM HEALTH DOCTOR');
    console.log('   (Read-Only Diagnostic — Zero Database Mutations)');
    console.log('═'.repeat(70) + '\n');

    const checks = [];

    function addCheck(category, name, status, detail) {
        checks.push({ category, name, status, detail });
    }

    // 1. Runtime & CLI Prerequisites
    const nodeRes = checkNodeVersion();
    addCheck('Runtime', 'Node.js Version', nodeRes.ok ? 'PASS' : 'FAIL', nodeRes.message);

    const npmRes = checkNpmVersion();
    addCheck('Runtime', 'npm Availability', npmRes.ok ? 'PASS' : 'FAIL', npmRes.message);

    // 2. Configuration & Environment (.env)
    const envPath = path.join(ROOT_DIR, '.env');
    const envExists = fs.existsSync(envPath);
    addCheck('Config', '.env File', envExists ? 'PASS' : 'FAIL', envExists ? 'File exists and is readable' : '.env file is missing');

    const envVars = envExists ? parseEnvFile(envPath) : {};
    const nodeEnv = envVars.NODE_ENV || process.env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    addCheck('Config', 'Environment Mode', 'PASS', `Running in ${nodeEnv} mode`);

    const hasSessionSecret = Boolean(envVars.SESSION_SECRET || process.env.SESSION_SECRET);
    const sessionSecret = (envVars.SESSION_SECRET || process.env.SESSION_SECRET || '').trim();
    if (!hasSessionSecret) {
        addCheck('Config', 'SESSION_SECRET', 'FAIL', 'SESSION_SECRET is missing');
    } else if (sessionSecret.length < 32) {
        addCheck('Config', 'SESSION_SECRET', isProduction ? 'FAIL' : 'WARN', `Length is ${sessionSecret.length} chars (min 32 recommended)`);
    } else {
        addCheck('Config', 'SESSION_SECRET', 'PASS', `Configured (${sessionSecret.length} characters)`);
    }

    // 3. MySQL Connectivity & Database Resolution
    const dbHost = envVars.DATABASE_HOST || process.env.DATABASE_HOST || 'localhost';
    const dbPort = Number(envVars.DATABASE_PORT || process.env.DATABASE_PORT || 3306);
    const dbUser = envVars.DATABASE_USER || process.env.DATABASE_USER || 'root';
    const dbName = envVars.DATABASE_NAME || process.env.DATABASE_NAME || 'admin';

    const tcpRes = await checkMySqlTcpConnectivity(dbHost, dbPort);
    addCheck('Database', 'MySQL TCP Network Port', tcpRes.ok ? 'PASS' : 'FAIL', tcpRes.message);

    let prisma = null;
    let dbConnected = false;

    // Load Prisma Client safely
    try {
        require('dotenv').config({ path: envPath });
        const { createPrismaClient } = require('../app/config/prisma');
        prisma = require('../app/config/prisma');
        // Read-only ping query
        await prisma.$queryRaw`SELECT 1 as ping`;
        dbConnected = true;
        addCheck('Database', 'Database Authentication & Connect', 'PASS', `Connected to MySQL database '${dbName}' as '${dbUser}'`);
    } catch (err) {
        addCheck('Database', 'Database Authentication & Connect', 'FAIL', logger.formatError(err));
    }

    // 4. Prisma Schema Validation
    const schemaRes = runPrismaCommand(['validate']);
    addCheck('Prisma', 'Schema Validation', schemaRes.ok ? 'PASS' : 'FAIL', schemaRes.ok ? 'Prisma schema is valid' : logger.formatError(schemaRes.error));

    // 5. Database Schema & Migrations
    if (dbConnected && prisma) {
        try {
            const migrateStatus = runPrismaCommand(['migrate', 'status']);
            const isUpToDate = migrateStatus.ok && (migrateStatus.stdout.includes('Database schema is up to date') || migrateStatus.stdout.includes('up to date'));
            addCheck('Prisma', 'Migration Status', isUpToDate ? 'PASS' : 'WARN', isUpToDate ? 'All migrations applied' : (migrateStatus.stdout.trim() || 'Check prisma migrate status'));
        } catch (err) {
            addCheck('Prisma', 'Migration Status', 'FAIL', logger.formatError(err));
        }

        // 6. Required Tables Inspection
        try {
            const tables = await prisma.$queryRaw`SHOW TABLES`;
            const tableList = new Set();
            for (const row of tables) {
                const tableName = Object.values(row)[0];
                if (tableName) tableList.add(tableName.toLowerCase());
            }

            const requiredTables = [
                'users',
                'roles',
                'permissions',
                'role_permissions',
                'units',
                'items',
                'invoices',
                'clients',
                'business_profiles'
            ];
            const missingTables = requiredTables.filter(t => !tableList.has(t.toLowerCase()));

            if (missingTables.length === 0) {
                addCheck('Schema', 'Required Tables', 'PASS', `All ${requiredTables.length} core application tables present`);
            } else {
                addCheck('Schema', 'Required Tables', 'FAIL', `Missing tables: ${missingTables.join(', ')}`);
            }
        } catch (err) {
            addCheck('Schema', 'Required Tables', 'FAIL', logger.formatError(err));
        }

        // 7. RBAC Roles & Permissions
        try {
            const roles = await prisma.role.findMany();
            const roleNames = new Set(roles.map(r => r.name));
            const hasRoles = roleNames.has('OWNER') && roleNames.has('ADMIN') && roleNames.has('STAFF');
            const permCount = await prisma.permission.count();

            addCheck('RBAC', 'System Roles (OWNER/ADMIN/STAFF)', hasRoles ? 'PASS' : 'FAIL', `Found ${roles.length} roles (${Array.from(roleNames).join(', ')})`);
            addCheck('RBAC', 'Permissions Catalog', permCount >= 20 ? 'PASS' : 'FAIL', `Found ${permCount} permissions cataloged`);
        } catch (err) {
            addCheck('RBAC', 'System RBAC Data', 'FAIL', logger.formatError(err));
        }

        // 8. Master Data: Units & Items
        try {
            const unitsCount = await prisma.unit.count();
            addCheck('Master Data', 'Predefined Unit Master', unitsCount >= 13 ? 'PASS' : 'FAIL', `Found ${unitsCount} units (standard requirement: 13)`);

            const itemsCount = await prisma.item.count();
            addCheck('Master Data', 'Predefined Item Master', itemsCount >= 21 ? 'PASS' : 'FAIL', `Found ${itemsCount} items (standard requirement: 21)`);
        } catch (err) {
            addCheck('Master Data', 'Master Data Seeding', 'FAIL', logger.formatError(err));
        }

        // 9. Administrator Availability
        try {
            const adminUser = await prisma.user.findFirst({
                where: {
                    OR: [
                        { role: 'ADMIN' },
                        { assignedRole: { name: 'OWNER' } }
                    ],
                    active: true
                }
            });
            if (adminUser) {
                addCheck('Security', 'Active Administrator', 'PASS', `Found active administrator: ${adminUser.email}`);
            } else {
                addCheck('Security', 'Active Administrator', 'FAIL', 'No active administrator account exists');
            }
        } catch (err) {
            addCheck('Security', 'Active Administrator', 'FAIL', logger.formatError(err));
        }

        // 10. Production Security Invariants
        if (isProduction) {
            if (dbUser === 'root') {
                addCheck('Prod Security', 'Database User Isolation', 'WARN', 'Using MySQL root user in production is not recommended');
            } else {
                addCheck('Prod Security', 'Database User Isolation', 'PASS', `Dedicated DB user: '${dbUser}'`);
            }

            try {
                const clients = await prisma.client.count();
                const invoices = await prisma.invoice.count();
                const businessProfiles = await prisma.businessProfile.count();

                const isClean = clients === 0 && invoices === 0 && businessProfiles === 0;
                addCheck(
                    'Prod Security',
                    'Zero Demo Data Invariant',
                    isClean ? 'PASS' : 'FAIL',
                    isClean ? 'Strict zero-demo invariant satisfied' : `Detected demo data (clients: ${clients}, invoices: ${invoices}, businessProfile: ${businessProfiles})`
                );
            } catch (err) {
                addCheck('Prod Security', 'Zero Demo Data Invariant', 'FAIL', logger.formatError(err));
            }
        }
    }

    // -------------------------------------------------------------------------
    // RENDER DIAGNOSTIC REPORT TABLE
    // -------------------------------------------------------------------------
    const colCat = 14;
    const colName = 34;
    const colStatus = 8;
    const colDetail = 40;

    console.log('┌' + '─'.repeat(colCat) + '┬' + '─'.repeat(colName) + '┬' + '─'.repeat(colStatus) + '┬' + '─'.repeat(colDetail) + '┐');
    console.log(
        '│ ' + 'CATEGORY'.padEnd(colCat - 2) +
        ' │ ' + 'CHECK'.padEnd(colName - 2) +
        ' │ ' + 'STATUS'.padEnd(colStatus - 2) +
        ' │ ' + 'DETAIL'.padEnd(colDetail - 2) + ' │'
    );
    console.log('├' + '─'.repeat(colCat) + '┼' + '─'.repeat(colName) + '┼' + '─'.repeat(colStatus) + '┼' + '─'.repeat(colDetail) + '┤');

    let passCount = 0;
    let failCount = 0;
    let warnCount = 0;

    for (const c of checks) {
        if (c.status === 'PASS') passCount++;
        else if (c.status === 'FAIL') failCount++;
        else warnCount++;

        const catStr = c.category.slice(0, colCat - 2).padEnd(colCat - 2);
        const nameStr = c.name.slice(0, colName - 2).padEnd(colName - 2);
        const statusStr = c.status.padEnd(colStatus - 2);
        const detailStr = c.detail.slice(0, colDetail - 2).padEnd(colDetail - 2);

        console.log(`│ ${catStr} │ ${nameStr} │ ${statusStr} │ ${detailStr} │`);
    }

    console.log('└' + '─'.repeat(colCat) + '┴' + '─'.repeat(colName) + '┴' + '─'.repeat(colStatus) + '┴' + '─'.repeat(colDetail) + '┘\n');

    const total = checks.length;
    console.log(`Diagnostic Summary: ${passCount}/${total} PASS, ${warnCount} WARN, ${failCount} FAIL`);

    if (require.main === module && prisma) {
        try {
            await prisma.$disconnect();
        } catch (_) {}
    }

    return {
        ok: failCount === 0,
        checks
    };
}

if (require.main === module) {
    runDoctor()
        .then((res) => {
            if (!res.ok) {
                console.log('\n❌ System health check detected failures. Please resolve the reported issues above.\n');
                process.exit(1);
            } else {
                console.log('\n✅ System health check PASSED. Application environment is healthy and operational.\n');
                process.exit(0);
            }
        })
        .catch((err) => {
            console.error('\nDoctor failed unexpectedly:', err);
            process.exit(1);
        });
}

module.exports = {
    runDoctor
};
