'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { main, PROTECTED_DATABASES, sanitizeOutput } = require('../scripts/db-upgrade');
const { readMigrations } = require('../scripts/lib/migration-preflight');

const migrations = readMigrations(path.join(__dirname, '../prisma/migrations'));
const env = { DATABASE_URL: 'mysql://release_user:p%40ssword@mock.invalid:3307/approved_release', DATABASE_NAME: 'approved_release' };
const flags = ['--confirm-db=approved_release', '--backup-confirmed'];
const applied = count => migrations.slice(0, count).map(m => ({ migration_name: m.name, checksum: m.checksum, finished_at: new Date(), rolled_back_at: null }));

function harness(options = {}) {
    const state = { exists: true, tables: ['_prisma_migrations', 'invoices'], objects: [], rows: applied(2), businessRows: [{ id: 1, total: '126.00' }], ...options };
    const connections = [], queries = [], cli = [], logs = [];
    let closes = 0;
    const deps = {
        verifyMigrationSource() {},
        log: message => logs.push(message),
        async createConnection(config) {
            connections.push(config);
            if (state.connectionError) throw state.connectionError;
            if (config.database && !state.exists) throw { errno: 1049, message: 'unknown database' };
            return {
                async end() { closes += 1; },
                async query(sql) {
                    queries.push(sql);
                    if (sql.startsWith('CREATE DATABASE')) {
                        if (state.createError) throw state.createError;
                        state.exists = true;
                        state.tables = [];
                        state.rows = [];
                        return;
                    }
                    if (sql.startsWith('SELECT DATABASE()')) return [{ database_name: state.actualDatabase || 'approved_release' }];
                    if (state.inspectError) throw new Error('sensitive driver output');
                    if (sql.includes('information_schema.tables')) return state.tables.map(table_name => ({ table_name }));
                    if (sql.includes('information_schema.routines')) return state.objects;
                    if (sql.includes('FROM _prisma_migrations')) return state.rows;
                    throw new Error(`Unexpected SQL: ${sql}`);
                }
            };
        },
        runPrisma(args, actualEnv) {
            assert.equal(actualEnv, env);
            cli.push(args.join(' '));
            if (state.failCli === args.join(' ')) throw new Error('mocked Prisma failure');
            if (args.join(' ') === 'migrate deploy') {
                state.rows = applied(migrations.length);
                state.tables = ['_prisma_migrations', 'invoices'];
            }
            return '';
        }
    };
    return { state, connections, queries, cli, logs, deps, get closes() { return closes; } };
}

describe('guarded migration orchestration with mocked driver and Prisma only', () => {
    it('explicitly skips backup acknowledgement while preserving target checks and forward-only commands', async () => {
        const h = harness();
        const before = structuredClone(h.state.businessRows);
        await main(['--confirm-db=approved_release', '--skip-backup'], env, h.deps);
        assert.deepEqual(h.cli, ['validate', 'migrate deploy', 'migrate status', 'generate']);
        assert.deepEqual(h.state.businessRows, before);
        assert.ok(h.logs.some(line => line.includes('Backup skipped')));
        assert.ok(h.queries.every(sql => sql.startsWith('SELECT ')));
        for (const args of [['--skip-backup'], ['--confirm-db=wrong','--skip-backup'], [...flags,'--skip-backup']]) {
            const denied = harness();
            await assert.rejects(main(args, env, denied.deps), /confirmation|not both/);
            assert.deepEqual(denied.cli, []);
            assert.deepEqual(denied.connections, []);
        }
    });
    it('upgrades an existing populated database without CREATE, reset, seed or row changes', async () => {
        const h = harness();
        const before = structuredClone(h.state.businessRows);
        await main(flags, env, h.deps);
        assert.deepEqual(h.cli, ['validate', 'migrate deploy', 'migrate status', 'generate']);
        assert.deepEqual(h.state.businessRows, before);
        assert.equal(h.connections.length, 1);
        assert.equal(h.closes, 1);
        assert.ok(h.queries.every(sql => sql.startsWith('SELECT ')));
    });

    it('does not create a missing database without explicit creation consent', async () => {
        const h = harness({ exists: false });
        await assert.rejects(main(flags, env, h.deps), /--create-database/);
        assert.deepEqual(h.cli, ['validate']);
        assert.equal(h.connections.length, 1);
        assert.deepEqual(h.queries, []);
    });

    it('creates only the confirmed missing database, with the same configured account and no grants', async () => {
        const h = harness({ exists: false });
        await main([...flags, '--create-database'], env, h.deps);
        assert.equal(h.connections.length, 3);
        assert.equal(h.connections[1].database, undefined);
        for (const config of h.connections) {
            assert.equal(config.host, 'mock.invalid');
            assert.equal(config.port, 3307);
            assert.equal(config.user, 'release_user');
            assert.equal(config.password, 'p@ssword');
            assert.equal(config.multipleStatements, false);
        }
        assert.deepEqual(h.queries.filter(sql => !sql.startsWith('SELECT ')), [
            'CREATE DATABASE `approved_release` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
        ]);
        assert.equal(h.closes, 2);
        assert.ok(h.logs.every(line => !line.includes('p@ssword')));
    });

    it('repeats fresh install and existing upgrades without creating again or altering business rows', async () => {
        for (const exists of [false, true]) {
            const h = harness({ exists });
            const before = structuredClone(h.state.businessRows);
            await main([...flags, '--create-database'], env, h.deps);
            await main([...flags, '--create-database'], env, h.deps);
            assert.equal(h.queries.filter(sql => sql.startsWith('CREATE ')).length, exists ? 0 : 1);
            assert.equal(h.cli.filter(command => command === 'migrate deploy').length, 2);
            assert.deepEqual(h.state.businessRows, before);
        }
    });

    it('never attempts provisioning after denied authentication/access, connectivity or TLS failure', async () => {
        for (const code of ['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ECONNREFUSED', 'CERT_HAS_EXPIRED']) {
            const h = harness({ connectionError: { code, message: 'p@ssword' } });
            await assert.rejects(main([...flags, '--create-database'], env, h.deps), /connection refused/);
            assert.equal(h.connections.length, 1);
            assert.deepEqual(h.queries, []);
            assert.deepEqual(h.cli, ['validate']);
        }
    });

    it('fails creation permission denial without escalation or deploy, closing the server connection', async () => {
        const h = harness({ exists: false, createError: { errno: 1044, message: 'p@ssword' } });
        await assert.rejects(main([...flags, '--create-database'], env, h.deps), /creation refused/);
        assert.equal(h.closes, 1);
        assert.deepEqual(h.cli, ['validate']);
    });

    it('rechecks history after concurrent database creation and refuses a populated legacy schema', async () => {
        const h = harness({ exists: false, rows: [], tables: ['invoices'], createError: { errno: 1007 } });
        const original = h.deps.createConnection;
        h.deps.createConnection = async config => {
            if (h.connections.length === 2) h.state.exists = true;
            return original(config);
        };
        await assert.rejects(main([...flags, '--create-database'], env, h.deps), /legacy database/);
        assert.deepEqual(h.cli, ['validate']);
        assert.equal(h.closes, 2);
    });

    it('requires exact target and backup acknowledgement before any CLI or driver call', async () => {
        for (const args of [[], ['--confirm-db=wrong', '--backup-confirmed'], ['--confirm-db=approved_release']]) {
            const h = harness();
            await assert.rejects(main(args, env, h.deps), /confirmation|backup/);
            assert.deepEqual(h.cli, []);
            assert.deepEqual(h.connections, []);
        }
        const h = harness();
        h.deps.verifyMigrationSource = () => { throw new Error('Uncommitted migration provenance'); };
        await assert.rejects(main(flags, env, h.deps), /Uncommitted migration provenance/);
        assert.deepEqual(h.cli, []);
        assert.deepEqual(h.connections, []);
    });

    it('rejects all protected names including URL-encoded and case variants before any operation', async () => {
        for (const database of PROTECTED_DATABASES) {
            for (const encoded of [database.toUpperCase(), encodeURIComponent(database).replace(/a/gi, '%61')]) {
                const h = harness();
                await assert.rejects(main([`--confirm-db=${database}`, '--backup-confirmed', '--create-database'], {
                    DATABASE_URL: `mysql://user:pass@mock.invalid/${encoded}`
                }, h.deps), /protected database/);
                assert.deepEqual(h.cli, []);
                assert.deepEqual(h.connections, []);
            }
        }
    });

    it('refuses malformed identifiers and mismatching runtime target configuration before connecting', async () => {
        for (const database of ['%60%3BDROP', 'approved%2Frelease', 'approved_release%20', '/approved_release', 'x'.repeat(65)]) {
            await assert.rejects(main(flags, { DATABASE_URL: `mysql://user:pass@mock.invalid/${database}` }, harness().deps), /identifier/);
        }
        await assert.rejects(main(flags, { DATABASE_URL: 'mysql://user:pass@mock.invalid:0/approved_release' }, harness().deps), /nonzero port/);
        for (const [key, value] of Object.entries({ DATABASE_HOST: 'other.invalid', DATABASE_PORT: '3306', DATABASE_USER: 'other', DATABASE_PASSWORD: 'wrong', DATABASE_NAME: 'wrong' })) {
            const h = harness();
            await assert.rejects(main(flags, { ...env, [key]: value }, { ...h.deps, runPrisma() {} }), /does not match/);
            assert.deepEqual(h.connections, []);
        }
        const h = harness();
        await assert.rejects(main(flags, { ...env, DATABASE_URL: env.DATABASE_URL + '?sslaccept=strict' }, { ...h.deps, runPrisma() {} }), /transport configuration/);
        assert.deepEqual(h.connections, []);
    });

    it('refuses a driver connected to a different database', async () => {
        const h = harness({ actualDatabase: 'wrong_database' });
        await assert.rejects(main(flags, env, h.deps), /confirmed target/);
        assert.deepEqual(h.cli, ['validate']);
        assert.equal(h.closes, 1);
    });

    it('fails safely on legacy tables/views/routines/events with absent or empty migration ledger', async () => {
        for (const tables of [['invoices'], ['_prisma_migrations', 'invoices'], ['legacy_view']]) {
            const h = harness({ tables, rows: [] });
            await assert.rejects(main(flags, env, h.deps), /no trustworthy migration baseline/);
            assert.deepEqual(h.cli, ['validate']);
            assert.ok(h.queries.every(sql => sql.startsWith('SELECT ')));
        }
        const h = harness({ tables: [], objects: [{ object_name: 'legacy_routine' }], rows: [] });
        await assert.rejects(main(flags, env, h.deps), /no trustworthy migration baseline/);
    });

    it('accepts an existing empty schema without creating a database', async () => {
        for (const tables of [[], ['_prisma_migrations']]) {
            const h = harness({ tables, rows: [] });
            await main(flags, env, h.deps);
            assert.ok(h.cli.includes('migrate deploy'));
            assert.ok(h.queries.every(sql => sql.startsWith('SELECT ')));
        }
    });

    it('rejects changed, unknown, out-of-order, duplicate, incomplete or rolled-back migration history', async () => {
        const first = applied(1)[0];
        for (const rows of [
            [{ ...first, checksum: 'wrong' }], [{ ...first, migration_name: 'unknown' }],
            [applied(2)[1]], [first, first], [{ ...first, finished_at: null }],
            [{ ...first, rolled_back_at: new Date() }]
        ]) {
            const h = harness({ rows });
            await assert.rejects(main(flags, env, h.deps), /history|manual review/);
            assert.deepEqual(h.cli, ['validate']);
            assert.equal(h.closes, 1);
        }
    });

    it('fails closed on unreadable metadata and stops at each failed Prisma step', async () => {
        const h = harness({ inspectError: true });
        await assert.rejects(main(flags, env, h.deps), /Cannot inspect/);
        assert.deepEqual(h.cli, ['validate']);
        assert.equal(h.closes, 1);
        const commands = ['validate', 'migrate deploy', 'migrate status', 'generate'];
        for (let index = 0; index < commands.length; index += 1) {
            const failure = harness({ failCli: commands[index] });
            await assert.rejects(main(flags, env, failure.deps), /mocked Prisma failure/);
            assert.deepEqual(failure.cli, commands.slice(0, index + 1));
        }
    });

    it('redacts standalone encoded and decoded credentials as well as complete URLs', () => {
        const text = sanitizeOutput(`release_user p%40ssword p@ssword ${env.DATABASE_URL}`, env.DATABASE_URL);
        for (const secret of ['release_user', 'p%40ssword', 'p@ssword']) assert.equal(text.includes(secret), false);
    });
});
