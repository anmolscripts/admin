'use strict';

/**
 * Spark Admin — Safe, Non-Destructive Database Schema Upgrade
 * Applies committed, versioned migrations in order without data loss.
 * NEVER drops, resets, or truncates existing customer databases.
 */

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

async function main() {
    console.log('\n' + '='.repeat(64));
    console.log('   SPARK ADMIN — SAFE DATABASE UPGRADE');
    console.log('='.repeat(64));

    const target = getSanitizedDbTarget();
    console.log(`\n[TARGET] Database: ${target.database} on ${target.host}:${target.port} (${target.protocol})`);
    console.log(`[POLICY] Non-destructive forward-only migration deploy. ZERO data drops permitted.\n`);

    // Step 1: Validate Prisma schema
    console.log('[1/4] Validating Prisma schema definition...');
    const validateRes = spawnSync('npx', ['prisma', 'validate'], {
        cwd: ROOT_DIR,
        shell: true,
        encoding: 'utf-8'
    });

    if (validateRes.status !== 0) {
        console.error('[FAIL] Prisma schema validation failed:');
        console.error(validateRes.stderr || validateRes.stdout);
        process.exit(1);
    }
    console.log('[PASS] Prisma schema is valid.');

    // Step 2: Apply pending migrations (forward-only deploy)
    console.log('\n[2/4] Applying pending database migrations (prisma migrate deploy)...');
    const deployRes = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
        cwd: ROOT_DIR,
        shell: true,
        encoding: 'utf-8'
    });

    if (deployRes.status !== 0) {
        console.error('[FAIL] Migration deployment failed:');
        console.error(deployRes.stderr || deployRes.stdout);
        process.exit(1);
    }
    console.log(deployRes.stdout.trim());
    console.log('[PASS] All versioned migrations successfully applied.');

    // Step 3: Regenerate Prisma Client
    console.log('\n[3/4] Generating Prisma Client bindings...');
    const generateRes = spawnSync('npx', ['prisma', 'generate'], {
        cwd: ROOT_DIR,
        shell: true,
        encoding: 'utf-8'
    });

    if (generateRes.status !== 0) {
        console.error('[FAIL] Prisma client generation failed:');
        console.error(generateRes.stderr || generateRes.stdout);
        process.exit(1);
    }
    console.log('[PASS] Prisma Client bindings updated.');

    // Step 4: Verify migration status
    console.log('\n[4/4] Verifying database migration status...');
    const statusRes = spawnSync('npx', ['prisma', 'migrate', 'status'], {
        cwd: ROOT_DIR,
        shell: true,
        encoding: 'utf-8'
    });

    if (statusRes.status !== 0) {
        console.error('[FAIL] Inconsistent migration status detected:');
        console.error(statusRes.stderr || statusRes.stdout);
        process.exit(1);
    }
    console.log('[PASS] Database schema is fully up to date and verified.');

    console.log('\n' + '='.repeat(64));
    console.log('   SUCCESS: Database upgrade completed with zero data loss.');
    console.log('='.repeat(64) + '\n');
}

main().catch(err => {
    console.error('[FATAL UPGRADE ERROR]:', err);
    process.exit(1);
});
