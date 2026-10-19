'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { installProduction } = require('../scripts/lib/production-install');
const { main: upgrade } = require('../scripts/db-upgrade');
const { readMigrations } = require('../scripts/lib/migration-preflight');

require('node:net').Socket.prototype.connect = function () { throw new Error('Real network forbidden in installer tests'); };
const flags = ['--mode=production', '--confirm-db=approved_disposable', '--backup-confirmed'];

function harness(options = {}) {
    const config = {
        NODE_ENV: 'production', DATABASE_NAME: 'approved_disposable',
        DATABASE_URL: 'mysql://mock:synthetic@mock.invalid:3306/approved_disposable',
        CUSTOM_SETTING: 'preserve-me', SESSION_SECRET: 'synthetic-session-value'
    };
    const migrations = readMigrations(path.join(__dirname, '../prisma/migrations'));
    const records = { clients: 3, invoices: 9, payments: 2, revisions: 18, activityLogs: 51, profiles: 2, users: [{ id: 7, role: 'OWNER' }] };
    const before = JSON.stringify(records);
    const calls = [], logs = [];
    let opened = 0, closed = 0;
    const connect = async () => {
        opened++;
        return {
            end: async () => { closed++; },
            query: async sql => {
                assert.match(sql, /^SELECT /, 'preflight must be read-only');
                calls.push(sql);
                if (sql.includes('DATABASE() AS database_name')) return [{ database_name: options.wrongTarget ? 'wrong' : config.DATABASE_NAME }];
                if (sql.includes('information_schema.tables')) return ['_prisma_migrations', 'users', 'roles', 'invoices'].map(table_name => ({ table_name }));
                if (sql.includes('information_schema.routines')) return [];
                if (sql.includes('FROM _prisma_migrations')) return options.legacy ? [] : migrations.map(m => ({ migration_name: m.name, checksum: m.checksum, finished_at: new Date(0), rolled_back_at: null }));
                if (sql.includes('FROM users')) return options.noOwner ? [] : [{ id: 7 }];
                throw new Error('Unexpected mock query');
            }
        };
    };
    const cli = [];
    const deps = {
        readConfig: () => config,
        verifySource: () => { if (options.uncommitted) throw new Error('Uncommitted migration source'); },
        createConnection: connect,
        log: message => logs.push(message),
        upgrade: (args, env) => {
            assert.equal(env.CUSTOM_SETTING, 'preserve-me');
            return upgrade(args, env, {
                verifyMigrationSource() {}, createConnection: connect,
                log: message => logs.push(message),
                runPrisma: args => {
                    cli.push(args.join(' '));
                    if (options.failDeploy && args.join(' ') === 'migrate deploy') throw new Error('Mock deploy failed');
                    return '';
                }
            });
        }
    };
    return { deps, config, records, before, cli, calls, logs, connections: () => ({ opened, closed }) };
}

test('populated production installation upgrades without clean-table checks or seed; retry preserves records/config', async () => {
    const h = harness();
    const originalConfig = JSON.stringify(h.config);
    await installProduction(flags, h.deps);
    await installProduction(flags, h.deps);
    assert.deepEqual(h.cli, ['validate', 'migrate deploy', 'migrate status', 'generate', 'validate', 'migrate deploy', 'migrate status', 'generate']);
    assert.equal(JSON.stringify(h.records), h.before);
    assert.equal(JSON.stringify(h.config), originalConfig);
    assert.equal(h.connections().opened, h.connections().closed);
    assert.ok(!h.logs.join('\n').includes('synthetic'));
});

for (const [name, options, pattern] of [
    ['wrong connected target', { wrongTarget: true }, /target/],
    ['legacy database without ledger', { legacy: true }, /legacy|history|baseline/i],
    ['missing active owner', { noOwner: true }, /OWNER/],
    ['uncommitted migrations', { uncommitted: true }, /Uncommitted/]
]) test(`refuses ${name} without migration or bootstrap`, async () => {
    const h = harness(options);
    await assert.rejects(installProduction(flags, h.deps), pattern);
    assert.deepEqual(h.cli, []);
    assert.equal(JSON.stringify(h.records), h.before);
    assert.equal(h.connections().opened, h.connections().closed);
});

for (const args of [
    ['--mode=production'],
    ['--mode=production', '--confirm-db=approved_disposable'],
    [...flags, '--overwrite-env'], [...flags, '--force'],
    [...flags, '--admin-email=someone@example.invalid'],
    [...flags, '--create-database']
]) test(`refuses unsafe or incomplete invocation ${args.at(-1)}`, async () => {
    const h = harness();
    await assert.rejects(installProduction(args, h.deps));
    assert.equal(h.connections().opened, 0);
    assert.deepEqual(h.cli, []);
});

test('protected target is refused before connections', async () => {
    const h = harness();
    h.config.DATABASE_NAME = 'spark_admin_prod';
    h.config.DATABASE_URL = 'mysql://mock:synthetic@mock.invalid:3306/spark_admin_prod';
    await assert.rejects(installProduction(['--confirm-db=spark_admin_prod', '--backup-confirmed'], h.deps), /protected/);
    assert.equal(h.connections().opened, 0);
});

test('migration failure stops generation and completion announcement', async () => {
    const h = harness({ failDeploy: true });
    await assert.rejects(installProduction(flags, h.deps), /deploy failed/);
    assert.deepEqual(h.cli, ['validate', 'migrate deploy']);
    assert.ok(!h.logs.some(line => line.includes('procedure completed')));
});

test('masked prompt suppresses readline echo and restores output', async () => {
    const { askQuestion } = require('../scripts/lib/env-manager');
    const { EventEmitter } = require('node:events');
    const rl = new EventEmitter();
    let displayed = '';
    const original = text => { displayed += text; };
    rl._writeToOutput = original;
    rl.question = (prompt, callback) => {
        rl._writeToOutput('synthetic-password');
        callback('synthetic-password');
    };
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const write = process.stdout.write;
    try {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        process.stdout.write = () => true;
        assert.equal(await askQuestion(rl, 'Password', '', true), 'synthetic-password');
        assert.equal(displayed, '');
        assert.equal(rl._writeToOutput, original);
    } finally {
        process.stdout.write = write;
        if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
        else delete process.stdin.isTTY;
    }
});

test('old password CLI option is refused without echoing its value', async () => {
    const h = harness();
    await assert.rejects(installProduction([...flags, '--admin-password=synthetic-private-value'], h.deps), error => {
        assert.ok(!error.message.includes('synthetic-private-value'));
        return true;
    });
    assert.equal(h.connections().opened, 0);
});

test('setup production entrypoint bypasses environment writer, reset and seed flow', async () => {
    const module = require('../scripts/lib/production-install');
    const original = module.installProduction;
    const argv = process.argv;
    let called = false;
    try {
        module.installProduction = async args => { called = true; assert.deepEqual(args, flags); };
        process.argv = [process.execPath, 'scripts/setup.js', ...flags];
        await require('../scripts/setup').main();
        assert.equal(called, true);
    } finally {
        module.installProduction = original;
        process.argv = argv;
    }
});
