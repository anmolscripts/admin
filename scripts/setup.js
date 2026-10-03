'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — ZERO-FRICTION INSTALLER (DEVELOPMENT & PRODUCTION)
 * ==============================================================================
 *
 * Cross-platform installer compatible with Windows, Linux, and macOS.
 * Uses only Node.js built-in APIs prior to dependency installation.
 *
 * Usage:
 *   node scripts/setup.js --mode=development
 *   node scripts/setup.js --mode=production
 *   node scripts/setup.js [options]
 *
 * ==============================================================================
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const logger = require('./lib/logger');
const { checkNodeVersion, checkNpmVersion, checkMySqlTcpConnectivity } = require('./lib/prerequisites');
const { collectConfiguration, parseEnvFile } = require('./lib/env-manager');
const { ensureDatabaseExists, runPrismaCommand } = require('./lib/db-manager');
const { verifyDatabaseState } = require('./lib/verifier');

// Root repository path
const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Parses command-line arguments into a structured options object.
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const eqIdx = arg.indexOf('=');
            if (eqIdx !== -1) {
                const key = arg.slice(2, eqIdx);
                const val = arg.slice(eqIdx + 1);
                args[key] = val;
            } else {
                const key = arg.slice(2);
                args[key] = true;
            }
        }
    }
    return args;
}

/**
 * Main installer orchestration function.
 */
async function main() {
    const cliArgs = parseArgs(process.argv);
    const mode = cliArgs.mode || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
    const isProduction = mode === 'production';
    const isInteractive = !cliArgs['non-interactive'] && process.stdin.isTTY;
    const skipTests = Boolean(cliArgs['skip-tests']);

    console.log('\n' + '═'.repeat(64));
    console.log(`   SPARK ADMIN — ${mode.toUpperCase()} INSTALLATION`);
    console.log('═'.repeat(64));

    // -------------------------------------------------------------------------
    // [1/8] Checking prerequisites
    // -------------------------------------------------------------------------
    logger.section(1, 8, 'Checking prerequisites');

    const nodeCheck = checkNodeVersion();
    if (!nodeCheck.ok) {
        logger.fail(nodeCheck.message);
        process.exit(1);
    }
    logger.pass(nodeCheck.message);

    const npmCheck = checkNpmVersion();
    if (!npmCheck.ok) {
        logger.fail(npmCheck.message);
        process.exit(1);
    }
    logger.pass(npmCheck.message);

    // Initial probe of MySQL TCP connectivity
    const initialHost = cliArgs['db-host'] || process.env.DATABASE_HOST || 'localhost';
    const initialPort = Number(cliArgs['db-port'] || process.env.DATABASE_PORT || 3306);
    const tcpCheck = await checkMySqlTcpConnectivity(initialHost, initialPort);
    if (!tcpCheck.ok) {
        logger.fail(tcpCheck.message);
        logger.info('Please verify that your MySQL server is running before continuing.');
        process.exit(1);
    }
    logger.pass(tcpCheck.message);

    // -------------------------------------------------------------------------
    // [2/8] Installing dependencies
    // -------------------------------------------------------------------------
    logger.section(2, 8, 'Installing dependencies');

    const isWin = process.platform === 'win32';
    const npmCmd = isWin ? 'npm.cmd' : 'npm';
    const fs = require('node:fs');
    const lockfilePath = path.join(ROOT_DIR, 'package-lock.json');
    const hasLockfile = fs.existsSync(lockfilePath);
    const nodeModulesPath = path.join(ROOT_DIR, 'node_modules');
    const dependenciesInstalled = fs.existsSync(nodeModulesPath) && fs.existsSync(path.join(nodeModulesPath, '@prisma', 'client'));

    if (dependenciesInstalled && !cliArgs.reinstall) {
        logger.pass('Project dependencies already installed. (Pass --reinstall to force re-install).');
    } else {
        const installCmd = hasLockfile ? 'ci' : 'install';
        logger.step(`Running ${npmCmd} ${installCmd} ...`);

        const npmInstall = spawnSync(`${npmCmd} ${installCmd}`, {
            cwd: ROOT_DIR,
            stdio: 'inherit',
            shell: true
        });

        if (npmInstall.status !== 0) {
            // Fallback to npm install if npm ci encountered a lockfile version mismatch
            if (installCmd === 'ci') {
                logger.warn('npm ci failed, falling back to npm install...');
                const fallback = spawnSync(`${npmCmd} install`, {
                    cwd: ROOT_DIR,
                    stdio: 'inherit',
                    shell: true
                });
                if (fallback.status !== 0) {
                    logger.fail('Dependency installation failed.');
                    process.exit(1);
                }
            } else {
                logger.fail('Dependency installation failed.');
                process.exit(1);
            }
        }
        logger.pass('Project dependencies installed successfully.');
    }

    // -------------------------------------------------------------------------
    // [3/8] Configuring environment
    // -------------------------------------------------------------------------
    logger.section(3, 8, 'Configuring environment');

    let envResult;
    try {
        envResult = await collectConfiguration({
            mode,
            isInteractive,
            overwriteEnv: Boolean(cliArgs.force || cliArgs['overwrite-env']),
            cliArgs,
            rootPath: ROOT_DIR
        });
    } catch (err) {
        logger.fail(logger.formatError(err));
        process.exit(1);
    }

    const { config: envConfig, adminCredentials, envWritten } = envResult;
    if (envWritten) {
        logger.pass('.env file created and configured.');
    } else {
        logger.pass('Using existing .env configuration.');
    }

    // Set process.env from config for subsequent child processes and drivers
    for (const [key, val] of Object.entries(envConfig)) {
        process.env[key] = val;
    }

    // -------------------------------------------------------------------------
    // [4/8] Preparing database
    // -------------------------------------------------------------------------
    logger.section(4, 8, 'Preparing database');

    logger.step(`Ensuring database '${envConfig.DATABASE_NAME}' exists on ${envConfig.DATABASE_HOST}:${envConfig.DATABASE_PORT}...`);
    try {
        const dbResult = await ensureDatabaseExists({
            host: envConfig.DATABASE_HOST,
            port: Number(envConfig.DATABASE_PORT),
            user: envConfig.DATABASE_USER,
            password: envConfig.DATABASE_PASSWORD,
            database: envConfig.DATABASE_NAME
        });

        if (dbResult.created) {
            logger.pass(`Database '${envConfig.DATABASE_NAME}' was created successfully.`);
        } else {
            logger.pass(`Database '${envConfig.DATABASE_NAME}' already exists.`);
        }
    } catch (err) {
        logger.fail(logger.formatError(err));
        process.exit(1);
    }

    // -------------------------------------------------------------------------
    // [5/8] Applying migrations
    // -------------------------------------------------------------------------
    logger.section(5, 8, 'Applying migrations');

    logger.step('Validating Prisma schema...');
    const validateRes = runPrismaCommand(['validate'], { DATABASE_URL: envConfig.DATABASE_URL });
    if (!validateRes.ok) {
        logger.fail(`Prisma validation failed: ${logger.formatError(validateRes.error)}`);
        process.exit(1);
    }
    logger.pass('Prisma schema is valid.');

    logger.step('Executing prisma migrate deploy...');
    const migrateRes = runPrismaCommand(['migrate', 'deploy'], { DATABASE_URL: envConfig.DATABASE_URL });
    if (!migrateRes.ok) {
        logger.fail(`Migration deployment failed:\n${logger.formatError(migrateRes.error || migrateRes.stderr)}`);
        process.exit(1);
    }
    logger.pass('All database migrations applied successfully.');

    // -------------------------------------------------------------------------
    // [6/8] Generating Prisma Client
    // -------------------------------------------------------------------------
    logger.section(6, 8, 'Generating Prisma Client');

    logger.step('Executing prisma generate...');
    const genRes = runPrismaCommand(['generate'], { DATABASE_URL: envConfig.DATABASE_URL });
    if (!genRes.ok) {
        logger.fail(`Prisma client generation failed: ${logger.formatError(genRes.error || genRes.stderr)}`);
        process.exit(1);
    }
    logger.pass('Prisma Client generated successfully.');

    // -------------------------------------------------------------------------
    // [7/8] Seeding data
    // -------------------------------------------------------------------------
    logger.section(7, 8, 'Seeding data');

    // Dynamically load prisma and seed router now that dependencies exist
    const seedModule = require('../prisma/seed');
    let seedResult;
    try {
        seedResult = await seedModule({
            isProduction,
            seedDemoData: !isProduction,
            adminEmail: adminCredentials.email,
            adminPassword: adminCredentials.password
        });
        logger.pass(`${isProduction ? 'Production' : 'Development'} seed completed successfully.`);
    } catch (err) {
        logger.fail(`Seeding failed: ${logger.formatError(err)}`);
        process.exit(1);
    }

    // -------------------------------------------------------------------------
    // [8/8] Verifying installation
    // -------------------------------------------------------------------------
    logger.section(8, 8, 'Verifying installation');

    const prismaInstance = require('../app/config/prisma');
    let verifyResult;
    try {
        verifyResult = await verifyDatabaseState(prismaInstance, mode);
    } catch (err) {
        logger.fail(`Verification failed to execute: ${logger.formatError(err)}`);
        process.exit(1);
    }

    for (const check of verifyResult.checks) {
        if (check.pass) {
            logger.pass(`${check.name}: ${check.detail}`);
        } else {
            logger.fail(`${check.name}: ${check.detail}`);
        }
    }

    if (!verifyResult.ok) {
        logger.fail('One or more installation invariants failed verification.');
        process.exit(1);
    }

    // Additional mode-specific verification steps:
    if (!isProduction) {
        // Development mode: run test suite
        if (!skipTests) {
            logger.step('Running regression test suite (npm test)...');
            const testRun = spawnSync(`${npmCmd} test`, {
                cwd: ROOT_DIR,
                stdio: 'inherit',
                shell: true
            });
            if (testRun.status !== 0) {
                logger.fail('One or more tests failed during development setup verification.');
                process.exit(1);
            }
            logger.pass('Full regression test suite passed (npm test).');
        } else {
            logger.info('Skipping test suite (--skip-tests flag passed).');
        }
    } else {
        // Production mode: read-only smoke verification
        logger.step('Running read-only production smoke verification...');
        try {
            const { validateEnv } = require('../app/config/env');
            validateEnv(process.env);
            logger.pass('Production environment security validation passed.');
        } catch (err) {
            logger.fail(`Production configuration smoke verification failed: ${logger.formatError(err)}`);
            process.exit(1);
        }
    }

    // -------------------------------------------------------------------------
    // FINAL SUMMARY
    // -------------------------------------------------------------------------
    const appUrl = `http://${envConfig.HOST === '0.0.0.0' ? 'localhost' : envConfig.HOST}:${envConfig.PORT}`;
    const nextCommand = isProduction ? 'npm start' : 'npm run dev';

    logger.box(`SPARK ADMIN — ${mode.toUpperCase()} SETUP COMPLETE`, [
        `Environment:      ${mode}`,
        `Database:         ${envConfig.DATABASE_NAME} (${envConfig.DATABASE_HOST}:${envConfig.DATABASE_PORT})`,
        `Administrator ID: ${verifyResult.summary.admin ? verifyResult.summary.admin.id : 'N/A'}`,
        `Admin Email:      ${adminCredentials.email}`,
        `Admin Password:   ${adminCredentials.password ? adminCredentials.password : '[Hidden / Unchanged]'}`,
        `Application URL:  ${appUrl}`,
        `Next Step:        ${nextCommand}`
    ]);

    // Gracefully disconnect Prisma before exiting
    try {
        await prismaInstance.$disconnect();
    } catch (_) {}

    process.exit(0);
}

if (require.main === module) {
    main().catch((err) => {
        logger.fail(`Unexpected installer error: ${logger.formatError(err)}`);
        process.exit(1);
    });
}

module.exports = {
    main,
    parseArgs
};
