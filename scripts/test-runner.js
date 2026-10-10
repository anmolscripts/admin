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
// Load test-specific environment first if running in test mode
 // Load test environment first to ensure safe DB config
require('dotenv').config();
// Then load default env (development) for any other vars
require('dotenv').config({ path: '.env.test', override: true });
// Ensure NODE_ENV is set to 'test' for downstream logic
process.env.NODE_ENV = 'test';
const { validateTestEnv } = require('./guard');
const { resolveDbTarget } = require('./db-target');
const explicitPassword = process.env.SEED_ADMIN_PASSWORD;
let prisma; // will be required after environment validation

// Validate test environment before any Prisma client is instantiated
validateTestEnv();
// Load Prisma client only after static validation succeeded
prisma = require('../app/config/prisma');
const { applyTestFixtures } = require('./test-fixtures');
// Perform live connection validation
(async () => {
  try {
    await validateTestEnv(prisma);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();

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

const cliArgs = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
let selectedFiles = testFiles;
if (cliArgs.length > 0) {
    selectedFiles = testFiles.filter((file) => {
        const normalized = file.replace(/\\/g, '/');
        return cliArgs.some((arg) => {
            const normalizedArg = arg.replace(/\\/g, '/');
            return normalized.includes(normalizedArg) || normalizedArg.includes(normalized);
        });
    });
    if (selectedFiles.length === 0) {
        console.error(`No test files matched: ${cliArgs.join(', ')}`);
        process.exit(1);
    }
}

// Safety check: ensure test runner is not pointing at the production 'admin' database
if (process.env.DATABASE_NAME && process.env.DATABASE_NAME.toLowerCase() === 'admin') {
  console.error('\n[TEST RUNNER ERROR]: Detected DATABASE_NAME=admin. Abort to protect production data.');
  process.exit(1);
}
// Additional validation: resolve effective DB target and verify it's not 'admin' and reachable
const { database } = resolveDbTarget();
if (database.toLowerCase() === 'admin') {
  console.error('\n[TEST RUNNER ERROR]: Resolved database name is admin. Abort to protect production data.');
  process.exit(1);
}
(async () => {
  try { await prisma.$connect();
    const result = await prisma.$queryRaw`SELECT DATABASE()`;
    // Handle different result shapes (string, array of objects, or plain object)
    let currentDb;
    if (typeof result === 'string') {
      currentDb = result;
    } else if (Array.isArray(result) && result.length > 0) {
      const row = result[0];
      currentDb = row['DATABASE()'] ?? row.DATABASE ?? row.database;
    } else {
      currentDb = result['DATABASE()'] ?? result.DATABASE ?? result.database;
    }
    if (currentDb !== database) {
      console.error('\n[TEST RUNNER ERROR]: Connected to unexpected database:', currentDb);
      process.exit(1);
    }
  } catch (err) {
    console.error('\n[TEST RUNNER ERROR]: Failed to query database for validation:', err);
    process.exit(1);
  }
})();


const args = ['--test', '--test-concurrency=1', ...selectedFiles];

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
