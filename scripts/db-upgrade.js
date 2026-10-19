'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { prepareDatabase, readMigrations, verifyMigrationSource, connectionOptions } = require('./lib/migration-preflight');

const ROOT_DIR = path.resolve(__dirname, '..');
const PROTECTED_DATABASES = new Set([
    'admin',
    'spark_admin',
    'spark_admin_test',
    'spark_admin_prod',
    'spark_admin_prod_test',
    'mysql', 'information_schema', 'performance_schema', 'sys'
]);

function parseDatabaseTarget(databaseUrl, databaseName) {
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required; no database fallback is permitted.');
    }

    let parsed;
    try {
        parsed = new URL(databaseUrl);
    } catch (_) {
        throw new Error('DATABASE_URL is invalid.');
    }

    let database;
    try {
        database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    } catch (_) {
        throw new Error('DATABASE_URL contains an invalid database name.');
    }
    if (parsed.protocol !== 'mysql:' || !parsed.hostname || !database) {
        throw new Error('DATABASE_URL must specify a MySQL host and database.');
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(database) || parsed.pathname.startsWith('//') || !parsed.username || parsed.hash || parsed.port === '0') {
        throw new Error('DATABASE_URL requires a user, a nonzero port and a single simple database identifier of at most 64 characters, without a fragment.');
    }
    if (databaseName && databaseName !== database) {
        throw new Error('DATABASE_NAME does not match the database in DATABASE_URL.');
    }
    if (PROTECTED_DATABASES.has(database.toLowerCase())) {
        throw new Error(`Refusing to migrate protected database "${database}".`);
    }

    return {
        protocol: parsed.protocol.slice(0, -1),
        host: parsed.hostname,
        port: parsed.port || '3306',
        database
    };
}

function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--backup-confirmed') {
            options.backupConfirmed = true;
        } else if (arg === '--create-database') {
            options.createDatabase = true;
        } else if (arg === '--confirm-db') {
            options.confirmDatabase = argv[index + 1];
            index += 1;
        } else if (arg.startsWith('--confirm-db=')) {
            options.confirmDatabase = arg.slice('--confirm-db='.length);
        } else {
            throw new Error(`Unknown option "${arg}".`);
        }
    }
    return options;
}

function sanitizeOutput(text, databaseUrl) {
    let output = String(text || '');
    if (databaseUrl) {
        output = output.split(databaseUrl).join('mysql://[redacted]');
        try {
            const parsed = new URL(databaseUrl);
            for (const secret of [parsed.username, parsed.password, decodeURIComponent(parsed.username), decodeURIComponent(parsed.password)]) {
                if (secret) output = output.split(secret).join('[redacted]');
            }
        } catch (_) { /* Invalid URLs are rejected before any operation. */ }
    }
    return output.replace(/(mysql:\/\/)[^/\s@]+:[^/\s@]*@/gi, '$1[redacted]@');
}

function runPrisma(args, env = process.env, cwd = ROOT_DIR) {
    const cliPath = path.join(cwd, 'node_modules', 'prisma', 'build', 'index.js');
    if (!fs.existsSync(cliPath)) {
        throw new Error('Prisma CLI is not installed. Run npm ci before applying migrations.');
    }

    const result = spawnSync(process.execPath, [
        cliPath,
        '--config',
        path.join(cwd, 'prisma7.config.ts'),
        ...args
    ], {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        shell: false
    });

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        const detail = sanitizeOutput(result.stderr || result.stdout, env.DATABASE_URL);
        throw new Error(detail.trim() || `Prisma exited with status ${result.status}.`);
    }
    return sanitizeOutput(result.stdout, env.DATABASE_URL).trim();
}

async function main(argv = process.argv.slice(2), env, dependencies = {}) {
    if (!env) {
        dotenv.config({ path: path.join(ROOT_DIR, '.env'), override: false, quiet: true });
        env = process.env;
    }
    const options = parseArguments(argv);
    const target = parseDatabaseTarget(env.DATABASE_URL, env.DATABASE_NAME);

    if (options.confirmDatabase !== target.database) {
        throw new Error(`Target confirmation is required: pass --confirm-db=${target.database}.`);
    }
    if (!options.backupConfirmed) {
        throw new Error('Confirm a verified pre-upgrade backup with --backup-confirmed before continuing.');
    }
    const cli = dependencies.runPrisma || runPrisma;
    const log = dependencies.log || console.log;
    connectionOptions(env, target);
    (dependencies.verifyMigrationSource || verifyMigrationSource)(ROOT_DIR);
    const migrations = readMigrations(dependencies.migrationsDirectory || path.join(ROOT_DIR, 'prisma', 'migrations'));

    log(`Target: ${target.database} on ${target.host}:${target.port} (${target.protocol})`);
    log('Policy: shipped forward migrations only; creation requires --create-database; no reset, seed, grants, or db push.');

    cli(['validate'], env);
    log('Prisma schema validation passed.');
    const result = await prepareDatabase({ target, env, migrations, createDatabase: options.createDatabase, createConnection: dependencies.createConnection });
    log(result.created ? 'Configured database created; empty schema verified.' : 'Existing database target and migration history verified.');

    const deployOutput = cli(['migrate', 'deploy'], env);
    if (deployOutput) log(deployOutput);
    log('Forward migrations deployed.');

    const statusOutput = cli(['migrate', 'status'], env);
    if (statusOutput) log(statusOutput);
    log('Migration status is up to date.');

    cli(['generate'], env);
    log('Prisma Client generated.');
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[MIGRATION ABORTED] ${sanitizeOutput(error.message, process.env.DATABASE_URL)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    PROTECTED_DATABASES,
    main,
    parseArguments,
    parseDatabaseTarget,
    runPrisma,
    sanitizeOutput
};
