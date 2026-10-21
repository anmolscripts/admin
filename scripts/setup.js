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
const { PROTECTED_DATABASES, readTestDatabaseConfig } = require('./lib/test-database-config');

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
    const skipTests = !cliArgs['run-tests'] || Boolean(cliArgs['skip-tests']);

    // Production uses the fresh installer shared with the release artifact.
    if (isProduction) {
        return require('./lib/production-install').installProduction(process.argv.slice(2));
    }

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

    if (dependenciesInstalled && cliArgs['skip-dependencies']) {
        logger.pass('Dependency installation explicitly skipped.');
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
            rootPath: ROOT_DIR,
            deferWrite: true
        });
    } catch (err) {
        logger.fail(logger.formatError(err));
        process.exit(1);
    }

    const { config: envConfig, adminCredentials, envWritten } = envResult;
    logger.pass('Configuration prepared; it will be saved after reset confirmation.');

    // Set process.env from config for subsequent child processes and drivers
    for (const [key, val] of Object.entries(envConfig)) {
        process.env[key] = val;
    }
    // Explicitly expose SEED_ADMIN_PASSWORD so automatic prisma seed picks it up
    process.env.SEED_ADMIN_PASSWORD = adminCredentials.password;

    let testDatabaseConfig = null;
    if (!isProduction) {
        if (PROTECTED_DATABASES.has(String(envConfig.DATABASE_NAME).toLowerCase())) {
            logger.warn(`Protected database '${envConfig.DATABASE_NAME}' is already configured. Keeping the existing configuration and stopping before reset.`);
            logger.info('Use a disposable test database for write-enabled validation.');
            process.exit(0);
        }

        // Guard the development installer from deleting the live admin database if the user chooses to overwrite an existing env file.
        const configuredDb = String(envConfig.DATABASE_NAME || '').toLowerCase();
        if (!isProduction && PROTECTED_DATABASES.has(configuredDb)) {
            logger.fail(`Refusing to reset protected development database '${envConfig.DATABASE_NAME}'.`);
            process.exit(1);
        }
        const target = require('./db-upgrade').parseDatabaseTarget(envConfig.DATABASE_URL, envConfig.DATABASE_NAME);
        require('./lib/migration-preflight').connectionOptions(envConfig, target);
        if (cliArgs['confirm-db'] && cliArgs['confirm-db'] !== target.database) throw new Error('Reset confirmation does not match configured database.');
        const confirmed = isInteractive
            ? await require('./lib/production-install').confirmReset(target)
            : cliArgs['confirm-db'] === target.database && cliArgs['reset-confirmed'] === true;
        if (!confirmed) throw new Error('Development reset cancelled. Use --confirm-db=<exact-name> --reset-confirmed for non-interactive installation.');
        envResult.persist();
        if (cliArgs['with-test-database']) try {
            testDatabaseConfig = readTestDatabaseConfig(ROOT_DIR);
        } catch (err) {
            logger.fail(logger.formatError(err));
            process.exit(1);
        }
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

    if (testDatabaseConfig) {
        logger.step(`Ensuring configured test database '${testDatabaseConfig.database}' exists on ${testDatabaseConfig.host}:${testDatabaseConfig.port}...`);
        try {
            const testDbResult = await ensureDatabaseExists({
                host: testDatabaseConfig.host,
                port: Number(testDatabaseConfig.port),
                user: testDatabaseConfig.user,
                password: testDatabaseConfig.password,
                database: testDatabaseConfig.database
            });

            if (testDbResult.created) {
                logger.pass(`Test database '${testDatabaseConfig.database}' was created successfully.`);
            } else {
                logger.pass(`Test database '${testDatabaseConfig.database}' already exists.`);
            }
        } catch (err) {
            logger.fail(logger.formatError(err));
            process.exit(1);
        }
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

    if (!isProduction) {
        logger.step('Executing prisma migrate reset for a clean development database...');
        const migrateEnv = {
            ...process.env,
            DATABASE_URL: envConfig.DATABASE_URL,
            SEED_ADMIN_PASSWORD: adminCredentials.password
        };
        const migrateRes = runPrismaCommand(['migrate', 'reset', '--force'], migrateEnv);
        if (!migrateRes.ok) {
            logger.fail(`Development database reset failed:\n${logger.formatError(migrateRes.error || migrateRes.stderr)}`);
            process.exit(1);
        }
        logger.pass('Database reset and migrations applied successfully.');

        if (testDatabaseConfig) {
        logger.step(`Applying migrations to configured test database ${testDatabaseConfig.database}...`);
        const testMigrateRes = runPrismaCommand(['migrate', 'deploy'], {
            ...process.env,
            DATABASE_URL: testDatabaseConfig.databaseUrl,
            DATABASE_NAME: testDatabaseConfig.database,
            DATABASE_HOST: testDatabaseConfig.host,
            DATABASE_PORT: testDatabaseConfig.port,
            DATABASE_USER: testDatabaseConfig.user,
            DATABASE_PASSWORD: testDatabaseConfig.password,
            NODE_ENV: 'test'
        });
        if (!testMigrateRes.ok) {
            logger.fail(`Test database migration failed:\n${logger.formatError(testMigrateRes.error || testMigrateRes.stderr)}`);
            process.exit(1);
        }
        logger.pass('Test database migrations applied successfully.');
        }
    } else {
        logger.step('Executing prisma migrate deploy...');
        const migrateRes = runPrismaCommand(['migrate', 'deploy'], { DATABASE_URL: envConfig.DATABASE_URL });
        if (!migrateRes.ok) {
            logger.fail(`Migration deployment failed:\n${logger.formatError(migrateRes.error || migrateRes.stderr)}`);
            process.exit(1);
        }
        logger.pass('All database migrations applied successfully.');
    }

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
    // [7/9] Validating production database cleanliness
    // -------------------------------------------------------------------------
    if (isProduction) {
        logger.step('Ensuring production database contains no demo data');
        // Ensure fresh Prisma client after generation
        delete require.cache[require.resolve('@prisma/client')];
        delete require.cache[require.resolve('../app/config/prisma')];
        const prisma = require('../app/config/prisma');
        const [itemCount, clientCount, invoiceCount, quotationCount, paymentCount, revisionCount, activityLogCount, businessProfileCount] = await Promise.all([
            prisma.item.count(),
            prisma.client.count(),
            prisma.invoice.count(),
            prisma.invoice.count({ where: { documentType: 'QUOTATION' } }),
            prisma.payment.count(),
            prisma.invoiceRevision.count(),
            prisma.userActivityLog.count(),
            prisma.businessProfile.count()
        ]);
        const violations = [];
        if (itemCount > 21) violations.push(`items(${itemCount})`);
        if (clientCount > 0) violations.push(`clients(${clientCount})`);
        if (invoiceCount > 0) violations.push(`invoices(${invoiceCount})`);
        if (quotationCount > 0) violations.push(`quotations(${quotationCount})`);
        if (paymentCount > 0) violations.push(`payments(${paymentCount})`);
        if (revisionCount > 0) violations.push(`revisions(${revisionCount})`);
        if (activityLogCount > 0) violations.push(`activity_logs(${activityLogCount})`);
        if (businessProfileCount > 0) violations.push(`business_profiles(${businessProfileCount})`);
        if (violations.length > 0) {
            logger.fail(`Production database is not clean. Non-empty tables: ${violations.join(', ')}`);
            process.exit(1);
        }
        logger.pass('Production database clean: no demo data present.');
    }

    // -------------------------------------------------------------------------
    // [8/9] Seeding data
    // -------------------------------------------------------------------------
    logger.section(8, 9, 'Seeding data');

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
    // [9/9] Verifying installation
    // -------------------------------------------------------------------------
    logger.section(9, 9, 'Verifying installation');

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
            const testEnv = {
                ...process.env,
                SEED_ADMIN_PASSWORD: adminCredentials.password
            };
            const testRun = spawnSync(`${npmCmd} test`, {
                cwd: ROOT_DIR,
                stdio: 'inherit',
                shell: true,
                env: testEnv
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
        'Admin Password:   [not displayed]',
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
