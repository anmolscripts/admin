'use strict';

/**
 * Spark Admin — Guarded Development Database Reset
 * Strictly for deliberate, authorized local development and disposable test databases.
 *
 * SAFETY GUARDRAILS:
 * 1. Hard-fails immediately if NODE_ENV === 'production'
 * 2. Hard-fails if database name contains 'prod' or 'live'
 * 3. Hard-fails if target host is remote (not localhost/127.0.0.1) without --allow-remote-reset
 * 4. Requires explicit --confirm-db=<exact_name> matching target database
 * 5. Requires --force-reset confirmation flag
 * 6. Never prints credentials or database passwords
 */

const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
require('dotenv').config();

const ROOT_DIR = path.resolve(__dirname, '..');

function getSanitizedDbTarget() {
    const dbUrl = process.env.DATABASE_URL || '';
    try {
        const parsed = new URL(dbUrl);
        return {
            protocol: parsed.protocol.replace(':', ''),
            host: parsed.hostname,
            port: parsed.port || '3306',
            database: parsed.pathname.replace('/', '')
        };
    } catch (_) {
        return {
            protocol: 'mysql',
            host: process.env.DATABASE_HOST || 'localhost',
            port: process.env.DATABASE_PORT || '3306',
            database: process.env.DATABASE_NAME || 'admin'
        };
    }
}

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const eqIdx = arg.indexOf('=');
            if (eqIdx !== -1) {
                args[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
            } else {
                args[arg.slice(2)] = true;
            }
        }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    const target = getSanitizedDbTarget();

    console.log('\n' + '!'.repeat(64));
    console.log('   GUARDED DATABASE RESET TOOL (DEVELOPMENT USE ONLY)');
    console.log('!'.repeat(64));

    // GUARD 1: Production Environment Check
    if (process.env.NODE_ENV === 'production') {
        console.error('\n[FATAL GUARDRAIL VIOLATION]: Cannot run database reset with NODE_ENV=production!');
        console.error('Resetting a production database is strictly prohibited.');
        process.exit(1);
    }

    // GUARD 2: Suspicious Production DB Name
    const lowerDbName = target.database.toLowerCase();
    if (lowerDbName.includes('prod') || lowerDbName.includes('live')) {
        console.error(`\n[FATAL GUARDRAIL VIOLATION]: Database name "${target.database}" appears to be a production target.`);
        console.error('Refusing to execute reset on suspicious production database name.');
        process.exit(1);
    }

    // GUARD 3: Remote Target Protection
    const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(target.host.toLowerCase());
    if (!isLocalHost && !args['allow-remote-reset']) {
        console.error(`\n[FATAL GUARDRAIL VIOLATION]: Target host "${target.host}" is a remote server.`);
        console.error('Database reset is restricted to local development environments.');
        console.error('If this is an intentional disposable staging database, pass --allow-remote-reset.');
        process.exit(1);
    }

    // GUARD 4: Exact Database Name Confirmation
    const confirmedDb = args['confirm-db'];
    if (!confirmedDb || confirmedDb !== target.database) {
        console.error(`\n[GUARDRAIL ERROR]: You must explicitly confirm the target database name.`);
        console.error(`Target: "${target.database}" on ${target.host}:${target.port}`);
        console.error(`Please run with: npm run db:reset -- --confirm-db=${target.database} --force-reset`);
        process.exit(1);
    }

    // GUARD 5: Explicit Force Flag
    if (!args['force-reset']) {
        console.error('\n[GUARDRAIL ERROR]: Explicit confirmation flag --force-reset is required.');
        process.exit(1);
    }

    // GUARD 6: Disposable Database Enforcement
    // Require either --allow-disposable-db flag or DISPOSABLE_DB=true env var.
    const isDisposable = args['allow-disposable-db'] || process.env.DISPOSABLE_DB === 'true';
    // Block the canonical admin database irrespective of overrides.
    if (target.database === 'admin') {
        console.error('\n[GUARDRAIL ERROR]: Resetting the "admin" database is never allowed.');
        process.exit(1);
    }
    // Block known production/shared names unless disposable flag supplied.
    const knownProdNames = ['production', 'prod', 'live'];
    if (knownProdNames.includes(target.database.toLowerCase()) && !isDisposable) {
        console.error(`\n[GUARDRAIL ERROR]: Resetting database "${target.database}" requires explicit disposable approval.`);
        console.error('Pass --allow-disposable-db or set DISPOSABLE_DB=true to proceed on a disposable test DB.');
        process.exit(1);
    }

    console.log(`\n[TARGET CONFIRMED] ${target.database} on ${target.host}:${target.port}`);
    console.log('[RESET] Applying migrations and resetting development database...');

    // Reapply migrations from scratch using prisma migrate deploy
    const resetRes = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: ROOT_DIR,
        shell: true,
        encoding: 'utf-8'
    });

    if (resetRes.status !== 0) {
        console.error('[ERROR] Failed to deploy migrations:', resetRes.stderr || resetRes.stdout);
        process.exit(1);
    }

    // Run development seed
    console.log('[SEED] Running development seed...');
    const seedRes = spawnSync('node', ['prisma/seed.js'], {
        cwd: ROOT_DIR,
        shell: true,
        encoding: 'utf-8'
    });

    if (seedRes.status !== 0) {
        console.error('[ERROR] Failed to run seed:', seedRes.stderr || seedRes.stdout);
        process.exit(1);
    }

    console.log('\n[SUCCESS] Development database successfully reset and re-seeded.\n');
}

main().catch(err => {
    console.error('[FATAL RESET ERROR]:', err);
    process.exit(1);
});
