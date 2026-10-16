'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — DYNAMIC SCHEMA READINESS & MIGRATION VALIDATOR
 * ==============================================================================
 *
 * Dynamically validates that the connected database schema is ready and fully matches
 * the required application migrations and runtime constraints:
 * 1. Inspects expected migrations directly from `prisma/migrations` directory (future-proof).
 * 2. Queries `_prisma_migrations` to detect pending, incomplete, or rolled-back migrations.
 * 3. Verifies critical enterprise multi-business, numbering, audit, master-record,
 *    and persistent session tables and columns.
 * 4. Yields a single sanitized diagnostic without leaking database credentials or URLs.
 * ==============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const prisma = require('./prisma');

/**
 * Dynamically resolves all expected migrations from the filesystem.
 * Compatible with future additive migrations without hardcoding counts.
 */
function getExpectedMigrations() {
    const migrationsDir = path.resolve(__dirname, '../../prisma/migrations');
    if (!fs.existsSync(migrationsDir)) return [];
    return fs.readdirSync(migrationsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(migrationsDir, d.name, 'migration.sql')))
        .map(d => d.name)
        .sort();
}

/**
 * Critical schema elements required by the runtime implementation.
 */
const CRITICAL_TABLES = [
    'businesses',
    'business_memberships',
    'business_prefix_configs',
    'numbering_sequences',
    'user_activity_logs',
    'sessions',
    'clients',
    'suppliers',
    'items',
    'units'
];

const CRITICAL_COLUMNS = [
    { table: 'business_profiles', column: 'businessId' },
    { table: 'user_activity_logs', column: 'businessId' },
    { table: 'clients', column: 'clientCode' },
    { table: 'suppliers', column: 'supplierCode' },
    { table: 'items', column: 'itemCode' },
    { table: 'units', column: 'unitCode' }
];

/**
 * Asserts that the connected database schema is ready for application startup.
 */
async function assertSchemaReadiness() {
    try {
        // 1. Connectivity check
        const [dbResult] = await prisma.$queryRaw`SELECT DATABASE() as db`;
        const dbName = dbResult?.db || 'unknown';

        const expectedMigrations = getExpectedMigrations();
        const totalExpected = expectedMigrations.length;

        // 2. Inspect applied migrations from _prisma_migrations
        let appliedRows = [];
        try {
            appliedRows = await prisma.$queryRaw`
                SELECT migration_name, finished_at, rolled_back_at 
                FROM _prisma_migrations
            `;
        } catch (_) {
            appliedRows = [];
        }

        const appliedMap = new Map();
        for (const row of appliedRows) {
            appliedMap.set(row.migration_name, row);
        }

        const pendingMigrations = [];
        const incompleteMigrations = [];
        const rolledBackMigrations = [];

        for (const migName of expectedMigrations) {
            const record = appliedMap.get(migName);
            if (!record) {
                pendingMigrations.push(migName);
            } else {
                if (record.rolled_back_at) {
                    rolledBackMigrations.push(migName);
                } else if (!record.finished_at) {
                    incompleteMigrations.push(migName);
                }
            }
        }

        const successfullyAppliedCount = expectedMigrations.filter(m => {
            const r = appliedMap.get(m);
            return r && r.finished_at && !r.rolled_back_at;
        }).length;

        // 3. Inspect critical tables
        const tableCheckRows = await prisma.$queryRaw`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = DATABASE()
        `;
        const existingTables = new Set((tableCheckRows || []).map(r => r.table_name || r.TABLE_NAME));
        const missingTables = CRITICAL_TABLES.filter(t => !existingTables.has(t));

        // 4. Inspect critical columns
        const columnCheckRows = await prisma.$queryRaw`
            SELECT table_name, column_name 
            FROM information_schema.columns 
            WHERE table_schema = DATABASE()
        `;
        const existingColumns = new Set(
            (columnCheckRows || []).map(r => `${r.table_name || r.TABLE_NAME}.${r.column_name || r.COLUMN_NAME}`)
        );
        const missingColumns = CRITICAL_COLUMNS.filter(c => !existingColumns.has(`${c.table}.${c.column}`));

        const hasSchemaErrors =
            pendingMigrations.length > 0 ||
            incompleteMigrations.length > 0 ||
            rolledBackMigrations.length > 0 ||
            missingTables.length > 0 ||
            missingColumns.length > 0;

        if (hasSchemaErrors) {
            const diagnosticLines = [
                '',
                '══════════════════════════════════════════════════════════════════════════════════',
                '   [DATABASE SCHEMA READINESS ERROR]',
                '══════════════════════════════════════════════════════════════════════════════════',
                `   Target Database:        ${dbName}`,
                `   Applied Migrations:     ${successfullyAppliedCount} of ${totalExpected}`,
                `   Pending Migrations:     ${pendingMigrations.length > 0 ? pendingMigrations.join(', ') : 'None'}`,
                `   Incomplete Migrations:  ${incompleteMigrations.length > 0 ? incompleteMigrations.join(', ') : 'None'}`,
                `   Rolled Back Migrations: ${rolledBackMigrations.length > 0 ? rolledBackMigrations.join(', ') : 'None'}`,
                `   Missing Critical Tables: ${missingTables.length > 0 ? missingTables.join(', ') : 'None'}`,
                `   Missing Critical Cols:  ${missingColumns.length > 0 ? missingColumns.map(c => `${c.table}.${c.column}`).join(', ') : 'None'}`,
                '',
                '   DIAGNOSIS:',
                '   The configured database schema is behind or inconsistent with application requirements.',
                '   The application requires the latest enterprise schema (including multi-business tenancy,',
                '   master-record identifiers, and persistent session storage).',
                '',
                '   ACTION REQUIRED TO REMEDIATE:',
                '   Apply pending migrations safely:',
                '     npx prisma migrate deploy',
                '   Or run full local development setup:',
                '     npm run dev:install',
                '══════════════════════════════════════════════════════════════════════════════════',
                ''
            ];

            console.error(diagnosticLines.join('\n'));
            throw new Error(
                `Database schema readiness check failed: database '${dbName}' is missing migrations (${successfullyAppliedCount}/${totalExpected}). Run 'npx prisma migrate deploy'.`
            );
        }

        return {
            database: dbName,
            appliedMigrations: successfullyAppliedCount,
            totalExpected,
            ready: true
        };
    } catch (err) {
        if (err.message && err.message.includes('Database schema readiness check failed')) {
            throw err;
        }
        const sanitizedMsg = err.message ? err.message.replace(/:[^:@]+@/, ':***@') : 'Database connection error';
        console.error(`[DATABASE CONNECTION ERROR] Unable to connect to target database: ${sanitizedMsg}`);
        throw new Error(`Database connectivity failure: ${sanitizedMsg}`);
    }
}

module.exports = {
    getExpectedMigrations,
    CRITICAL_TABLES,
    CRITICAL_COLUMNS,
    assertSchemaReadiness
};
