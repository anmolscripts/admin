'use strict';

const path = require('node:path');
const { parseEnvFile } = require('./env-file');
const upgrade = require('../db-upgrade');
const { connectionOptions, verifyMigrationSource, readMigrations, prepareDatabase } = require('./migration-preflight');

// Production setup is deliberately separate from the seed router. A populated
// installation is upgraded in place; initial account provisioning is a separate
// operation and must not be inferred from a requested email or password.
async function installProduction(argv, dependencies = {}) {
    const root = path.resolve(__dirname, '../..');
    const env = { ...(dependencies.readConfig || parseEnvFile)(path.join(root, '.env')) };
    const args = argv.filter(arg => arg !== '--mode=production');
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--confirm-db') { i++; continue; }
        if (args[i].startsWith('--confirm-db=') || ['--backup-confirmed', '--create-database'].includes(args[i])) continue;
        // Do not echo unknown arguments: old callers may supply passwords.
        throw new Error('Unsupported production installation option. Only --confirm-db and --backup-confirmed are accepted; configuration and administrator credentials are preserved.');
    }
    const options = upgrade.parseArguments(args);
    if (options.createDatabase) throw new Error('Initial database provisioning requires a separately reviewed bootstrap; install:prod upgrades initialized installations only.');
    const target = upgrade.parseDatabaseTarget(env.DATABASE_URL, env.DATABASE_NAME);
    if (options.confirmDatabase !== target.database) throw new Error(`Confirm the existing production target with --confirm-db=${target.database}. No configuration was changed.`);
    if (!options.backupConfirmed) throw new Error('A verified backup acknowledgement (--backup-confirmed) is required. No configuration was changed.');
    if (env.NODE_ENV !== 'production') throw new Error('Review NODE_ENV in the existing configuration before production installation. The installer will not overwrite .env.');
    const config = connectionOptions(env, target);
    (dependencies.verifySource || verifyMigrationSource)(root);
    const migrations = (dependencies.readMigrations || readMigrations)(path.join(root, 'prisma/migrations'));
    const connect = dependencies.createConnection || (options => require('mariadb').createConnection(options));
    await (dependencies.prepareDatabase || prepareDatabase)({ target, env, migrations, createDatabase: false, createConnection: connect });

    let connection;
    try {
        connection = await connect(config);
        const [identity] = await connection.query('SELECT DATABASE() AS database_name');
        if (identity?.database_name !== target.database) throw new Error('Database identity changed; refusing production installation.');
        // Use SQL metadata/read-only checks, not an application import with startup
        // side effects. Never create, promote, reactivate or change an existing user.
        const rows = await connection.query("SELECT u.id FROM users u JOIN roles r ON r.id = u.roleId WHERE r.name = 'OWNER' AND u.active = 1 AND u.status = 'ACTIVE' LIMIT 1");
        if (rows.length === 0) throw new Error('No active OWNER exists. Initial administrator provisioning requires a separately approved bootstrap; no users were changed.');
    } catch (error) {
        if (error.code) throw new Error('Cannot verify initialized administrator state; no bootstrap or cleanup was attempted.');
        throw error;
    } finally {
        if (connection) await connection.end().catch(() => {});
    }
    const log = dependencies.log || console.log;
    log('Existing installation verified. Preserving configuration, users, roles and business records; no seed will run.');
    await (dependencies.upgrade || upgrade.main)(args, env);
    log('Production migration procedure completed. Application startup and business workflows require separate verification.');
}

module.exports = { installProduction };
