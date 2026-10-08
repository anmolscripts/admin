'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — CENTRALIZED TEST RUNNER & CREDENTIAL VALIDATOR
 * ==============================================================================
 *
 * Enforces deterministic test execution:
 * 1. Checks that SEED_ADMIN_PASSWORD is provided explicitly in the environment
 *    BEFORE invoking test suites.
 * 2. If missing, terminates immediately with a clean, actionable error message
 *    without partial test executions or misleading auth failure cascades.
 * 3. Preserves explicitly supplied credentials across child test processes.
 * 4. Loads .env for database connection parameters without overwriting explicit
 *    process credentials.
 * ==============================================================================
 */
// Load .env for database connection variables and dev credentials
require('dotenv').config();

const explicitPassword = process.env.SEED_ADMIN_PASSWORD;

if (!explicitPassword || !explicitPassword.trim()) {
    console.error('');
    console.error('======================================================================');
    console.error('  SPARK ADMIN — TEST CONFIGURATION ERROR');
    console.error('======================================================================');
    console.error('');
    console.error('  Error: SEED_ADMIN_PASSWORD environment variable is required to run tests.');
    console.error('');
    console.error('  Standalone test execution requires the development admin password');
    console.error('  to authenticate integration tests.');
    console.error('');
    console.error('  Please supply SEED_ADMIN_PASSWORD before running npm test:');
    console.error('');
    console.error('    PowerShell:');
    console.error('      $env:SEED_ADMIN_PASSWORD=\'your-password\'; npm test');
    console.error('');
    console.error('    Bash / Linux / macOS:');
    console.error('      SEED_ADMIN_PASSWORD=\'your-password\' npm test');
    console.error('');
    console.error('    Windows CMD:');
    console.error('      set SEED_ADMIN_PASSWORD=your-password && npm test');
    console.error('');
    console.error('  If you recently ran "npm run dev:install", use the password configured');
    console.error('  or displayed during installation.');
    console.error('======================================================================');
    console.error('');
    process.exit(1);
}

// Ensure trimmed password is explicitly assigned to environment
const cleanPassword = explicitPassword.trim();
process.env.SEED_ADMIN_PASSWORD = cleanPassword;

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT_DIR = path.resolve(__dirname, '..');
const testsDir = path.join(ROOT_DIR, 'tests');

const testFiles = fs.readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => path.join('tests', f));

if (testFiles.length === 0) {
    console.error('No test files found in tests directory.');
    process.exit(1);
}

const { applyTestFixtures } = require('./test-fixtures');
const prisma = require('../app/config/prisma');

const args = ['--test', '--test-concurrency=1', ...testFiles];

async function run() {
    try {
        await applyTestFixtures({ adminPassword: cleanPassword });
    } catch (err) {
        console.error('');
        console.error('[TEST RUNNER ERROR]: Failed to apply deterministic test fixtures:', err);
        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }

    const result = spawnSync(process.execPath, args, {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        env: {
            ...process.env,
            SEED_ADMIN_PASSWORD: cleanPassword
        }
    });

    process.exit(result.status !== null ? result.status : 1);
}

run();
