'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function migrationSource(root) {
    const directory = path.join(root, 'prisma/migrations');
    const files = { 'migration_lock.toml': crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'migration_lock.toml'))).digest('hex') };
    for (const migration of readMigrations(directory)) files[`${migration.name}/migration.sql`] = migration.checksum;
    const git = args => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
        if (result.error || result.status !== 0) throw new Error('Cannot verify committed migration source. Build from a Git checkout.');
        return result.stdout.trim();
    };
    const commit = git(['rev-parse', 'HEAD']);
    const changes = git(['status', '--porcelain', '--untracked-files=all', '--', 'prisma/migrations']);
    const tracked = git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'prisma/migrations']).split('\n')
        .filter(file => file.endsWith('/migration.sql') || file.endsWith('/migration_lock.toml'))
        .map(file => file.replace(/^prisma\/migrations\//, '')).sort();
    return { commit, allCommitted: changes.length === 0 && JSON.stringify(tracked) === JSON.stringify(Object.keys(files).sort()), files };
}

function verifyMigrationSource(root) {
    let source;
    if (fs.existsSync(path.join(root, '.git'))) {
        source = migrationSource(root);
    } else {
        const file = path.join(root, 'migration-source.json');
        if (!fs.existsSync(file)) throw new Error('Release migration provenance is missing; use a reviewed build from committed migrations.');
        source = JSON.parse(fs.readFileSync(file, 'utf8'));
        const directory = path.join(root, 'prisma/migrations');
        const actualFiles = ['migration_lock.toml', ...readMigrations(directory).map(m => `${m.name}/migration.sql`)];
        if (actualFiles.length !== Object.keys(source.files || {}).length || actualFiles.some(file =>
            crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex') !== source.files[file])) {
            throw new Error('Shipped migrations differ from release provenance; refusing migration.');
        }
    }
    if (source.allCommitted !== true || !/^[a-f0-9]{40,64}$/.test(source.commit || '')) {
        throw new Error('Migration files include uncommitted changes. Commit reviewed migrations and rebuild before database installation.');
    }
    return source;
}

function readMigrations(directory) {
    if (!/^provider\s*=\s*"mysql"\s*$/m.test(fs.readFileSync(path.join(directory, 'migration_lock.toml'), 'utf8'))) {
        throw new Error('A MySQL migration lockfile is required.');
    }
    const migrations = fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory()).map(entry => {
            const sql = fs.readFileSync(path.join(directory, entry.name, 'migration.sql'));
            if (!sql.length) throw new Error('Empty migration SQL is not permitted.');
            return { name: entry.name, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
        }).sort((a, b) => a.name.localeCompare(b.name));
    if (!migrations.length) throw new Error('No shipped migrations found.');
    return migrations;
}

function connectionOptions(env, target) {
    const url = new URL(env.DATABASE_URL);
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    // Never silently ignore transport settings that the Prisma engine would honor.
    const allowed = new Set(['connection_limit', 'pool_timeout', 'connect_timeout', 'socket_timeout']);
    for (const key of url.searchParams.keys()) {
        if (!allowed.has(key)) throw new Error('Unsupported DATABASE_URL option for migration preflight; TLS/socket options require an explicitly reviewed transport configuration.');
    }
    for (const [key, expected] of Object.entries({
        DATABASE_HOST: target.host, DATABASE_PORT: target.port, DATABASE_USER: user,
        DATABASE_PASSWORD: password, DATABASE_NAME: target.database
    })) {
        if (env[key] !== undefined && String(env[key]) !== String(expected)) {
            throw new Error(`${key} does not match DATABASE_URL; refusing an ambiguous target.`);
        }
    }
    const timeout = Number(url.searchParams.get('connect_timeout') || 5);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid connection timeout.');
    return { host: target.host, port: Number(target.port), user, password,
        database: target.database, connectTimeout: timeout * 1000, multipleStatements: false };
}

function isMissingDatabase(error) {
    return error.errno === 1049 || error.code === 'ER_BAD_DB_ERROR';
}

async function connect(createConnection, options, allowMissing = false) {
    try { return await createConnection(options); }
    catch (error) {
        if (allowMissing && isMissingDatabase(error)) throw error;
        throw new Error('Database connection refused. Verify configured credentials, target access and transport; no provisioning attempted.');
    }
}

async function close(connection) {
    if (connection) await connection.end().catch(() => {});
}

function verifyHistory(tables, objects, rows, migrations) {
    const applicationTables = tables.filter(row => row.table_name !== '_prisma_migrations');
    if (!rows.length) {
        if (applicationTables.length || objects.length) {
            throw new Error('Populated legacy database has no trustworthy migration baseline. Stop for a separately reviewed baseline; no migration was applied.');
        }
        return;
    }
    if (rows.some(row => !row.finished_at || row.rolled_back_at)) {
        throw new Error('Incomplete or rolled-back migration history requires manual review.');
    }
    const ordered = [...rows].sort((a, b) => a.migration_name.localeCompare(b.migration_name));
    for (let index = 0; index < ordered.length; index += 1) {
        const record = ordered[index];
        const expected = migrations[index];
        if (!expected || record.migration_name !== expected.name || record.checksum !== expected.checksum) {
            throw new Error('Migration history is not a checksum-matching prefix of shipped migrations. Stop for manual baseline/history review.');
        }
    }
    if (!applicationTables.length) throw new Error('Migration history exists but application tables are absent; manual review required.');
}

async function prepareDatabase({ target, env, migrations, createDatabase, createConnection }) {
    const options = connectionOptions(env, target);
    createConnection ||= require('mariadb').createConnection;
    let connection;
    let created = false;
    try {
        try { connection = await connect(createConnection, options, true); }
        catch (error) {
            if (!isMissingDatabase(error)) throw error;
            if (!createDatabase) throw new Error('Configured database does not exist. Provision it manually or explicitly pass --create-database with database-scoped CREATE permission.');
            // Only an explicit unknown-database response permits server-level connection.
            const { database, ...serverOptions } = options;
            let server;
            try {
                server = await connect(createConnection, serverOptions);
                try {
                    // No IF NOT EXISTS: concurrent creation is checked again below, never replaced.
                    await server.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
                    created = true;
                } catch (error) {
                    if (error.errno !== 1007 && error.code !== 'ER_DB_CREATE_EXISTS') {
                        throw new Error('Database creation refused. Ask an operator to provision this exact database or grant database-scoped CREATE; no privileges were changed.');
                    }
                }
            } finally { await close(server); }
            connection = await connect(createConnection, options);
        }
        let tables, objects, rows;
        try {
            const [actual] = await connection.query('SELECT DATABASE() AS database_name');
            if (actual?.database_name !== target.database) throw new Error('wrong target');
        } catch (_) { throw new Error('Connected database does not match the confirmed target; refusing migration.'); }
        try {
            tables = await connection.query('SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()');
            objects = await connection.query('SELECT ROUTINE_NAME AS object_name FROM information_schema.routines WHERE ROUTINE_SCHEMA = DATABASE() UNION ALL SELECT EVENT_NAME AS object_name FROM information_schema.events WHERE EVENT_SCHEMA = DATABASE()');
            rows = tables.some(row => row.table_name === '_prisma_migrations')
                ? await connection.query('SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations') : [];
        } catch (_) { throw new Error('Cannot inspect database objects and migration history; refusing migration.'); }
        verifyHistory(tables, objects, rows, migrations);
        return { created };
    } finally { await close(connection); }
}

module.exports = { readMigrations, connectionOptions, prepareDatabase, verifyHistory, migrationSource, verifyMigrationSource };
