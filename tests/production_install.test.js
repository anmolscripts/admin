'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { installProduction, parseOptions } = require('../scripts/lib/production-install');
require('node:net').Socket.prototype.connect = function () { throw new Error('Real network forbidden'); };

function harness(options = {}) {
    const events = [];
    const env = { NODE_ENV: 'production', DATABASE_NAME: 'disposable_fresh',
        DATABASE_URL: 'mysql://mock:synthetic@mock.invalid:3306/disposable_fresh' };
    const state = { records: [1, 2, 3], admins: [], exists: !options.missing };
    const deps = {
        log: () => {}, isInteractive: true,
        installDependencies: () => events.push('dependencies'),
        collectConfiguration: async opts => {
            assert.equal(opts.deferWrite, true);
            return { config: env, adminCredentials: { email: 'owner@example.invalid', password: 'synthetic-only-password' },
                persist: () => events.push('persist') };
        },
        confirmReset: async () => { events.push('confirm'); return !options.cancel; },
        runPrisma: args => {
            const step = args.join(' ');
            events.push(step);
            if (step === options.fail) return { ok: false, error: 'simulated failure' };
            if (step === 'migrate reset --force') { state.records = []; state.admins = []; }
            return { ok: true };
        },
        ensureDatabase: async () => { events.push('ensure'); state.exists = true; },
        createConnection: async () => ({
            query: async sql => { assert.equal(sql, 'SELECT DATABASE() AS database_name'); return [{ database_name: options.wrong ? 'other_db' : env.DATABASE_NAME }]; },
            end: async () => events.push('close')
        }),
        seed: async opts => {
            events.push('seed');
            assert.equal(opts.seedDemoData, false);
            state.admins.push(opts.email);
        }
    };
    return { deps, env, state, events };
}

for (const missing of [false, true]) test('production clears existing records or creates missing target: ' + missing, async () => {
    const h = harness({ missing });
    await installProduction([], h.deps);
    assert.deepEqual(h.state.records, []);
    assert.equal(h.state.exists, true);
    assert.equal(h.state.admins.length, 1);
    assert.deepEqual(h.events, ['dependencies', 'confirm', 'validate', 'generate', 'ensure', 'close', 'persist', 'migrate reset --force', 'seed']);
    h.state.records.push(99);
    await installProduction([], h.deps);
    assert.equal(h.state.admins.length, 1);
    assert.deepEqual(h.state.records, []);
});

for (const issue of [{ cancel: true }, { wrong: true }, { fail: 'validate' }, { fail: 'generate' }, { fail: 'migrate reset --force' }]) {
    test('fresh failure stops bootstrap: ' + JSON.stringify(issue), async () => {
        const h = harness(issue);
        await assert.rejects(installProduction([], h.deps));
        assert.ok(!h.events.includes('seed'));
        if (issue.cancel || issue.fail === 'validate' || issue.fail === 'generate') {
            assert.ok(!h.events.includes('ensure'));
            assert.ok(!h.events.includes('persist'));
        }
    });
}

test('noninteractive reset requires exact target and explicit reset acknowledgement', async () => {
    const h = harness();
    h.deps.isInteractive = false;
    await assert.rejects(installProduction([], h.deps), /reset-confirmed/);
    await assert.rejects(installProduction(['--confirm-db=other', '--reset-confirmed'], h.deps), /does not match/);
    await installProduction(['--confirm-db=disposable_fresh', '--reset-confirmed'], h.deps);
    assert.equal(h.state.admins.length, 1);
});

test('protected database refusal precedes any reset or creation', async () => {
    const h = harness();
    h.env.DATABASE_NAME = 'spark_admin_prod';
    h.env.DATABASE_URL = 'mysql://mock:synthetic@mock.invalid:3306/spark_admin_prod';
    await assert.rejects(installProduction([], h.deps), /protected/);
    assert.ok(!h.events.includes('ensure'));
});

test('invalid boolean flags cannot authorize a reset', () => {
    assert.throws(() => parseOptions(['--reset-confirmed=false']));
    assert.throws(() => parseOptions(['--unknown=synthetic-password']), error => !error.message.includes('synthetic-password'));
});

test('migration entrypoint installs packages before migration only', async () => {
    const steps = [], records = [1, 2, 3];
    await require('../scripts/install-migrate').main(['--confirm-db=disposable_fresh', '--backup-confirmed'], {
        installDependencies: () => steps.push('dependencies'),
        upgrade: async args => { steps.push('upgrade'); assert.ok(args.includes('--backup-confirmed')); }
    });
    assert.deepEqual(steps, ['dependencies', 'upgrade']);
    assert.deepEqual(records, [1, 2, 3]);
    await assert.rejects(require('../scripts/install-migrate').main([], {
        installDependencies: () => { throw new Error('npm failed'); },
        upgrade: () => assert.fail('must not migrate')
    }), /npm failed/);
});

function loadProductionSeed(common) {
    const sandbox = { module: { exports: {} }, exports: {}, process: { env: {} }, console: { log() {} },
        require: id => {
            if (id === 'bcrypt') return { hash: async () => 'mock-hash' };
            if (id === '../common') return { seedCommon: common };
            throw new Error('Unexpected seed import');
        } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../prisma/seed/production'), 'utf8'), sandbox);
    return sandbox.module.exports.seedProduction;
}
test('production seed refuses existing accounts before modifying roles', async () => {
    const seed = loadProductionSeed(() => assert.fail('must not reseed'));
    await assert.rejects(seed({ user: { count: async () => 1 } }, {
        adminEmail: 'owner@example.invalid', adminPassword: 'synthetic-only-password'
    }), /freshly reset/);
});
test('production bootstrap requests no sample items and creates one administrator', async () => {
    let admins = 0, commonCalls = 0;
    const seed = loadProductionSeed(async (prisma, user, options) => {
        assert.equal(options.includeItems, false); commonCalls++;
    });
    const count = async () => 0;
    const prisma = Object.fromEntries(['client', 'invoice', 'payment', 'businessProfile', 'invoiceRevision', 'userActivityLog', 'permission'].map(name => [name, { count }]));
    prisma.user = { count, findUnique: async () => null, create: async ({ data }) => { admins++; return { id: 7, ...data }; } };
    prisma.role = { findUnique: async () => ({ id: 1 }), count };
    prisma.unit = { count: async () => 13, updateMany: async () => {} };
    prisma.item = { count, updateMany: async () => {} };
    await seed(prisma, { adminEmail: 'owner@example.invalid', adminPassword: 'synthetic-only-password', seedDemoData: false });
    assert.equal(admins, 1); assert.equal(commonCalls, 1);
});

test('masked prompt has one input consumer and never echoes the secret', async () => {
    const { askQuestion } = require('../scripts/lib/env-manager');
    const rl = new (require('node:events').EventEmitter)();
    let output = '';
    const original = text => { output += text; };
    rl._writeToOutput = original;
    rl.question = (_, callback) => { rl._writeToOutput('synthetic-password'); callback('synthetic-password'); };
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const write = process.stdout.write;
    try {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        process.stdout.write = () => true;
        assert.equal(await askQuestion(rl, 'Password', '', true), 'synthetic-password');
        assert.equal(output, '');
        assert.equal(rl._writeToOutput, original);
    } finally {
        process.stdout.write = write;
        if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
        else delete process.stdin.isTTY;
    }
});

test('development orchestration resets only selected database and requests sample data', async () => {
    const events = [];
    const config = { NODE_ENV: 'development', DATABASE_NAME: 'disposable_fresh', DATABASE_HOST: 'mock.invalid',
        DATABASE_PORT: '3306', DATABASE_USER: 'mock', DATABASE_PASSWORD: 'synthetic',
        DATABASE_URL: 'mysql://mock:synthetic@mock.invalid:3306/disposable_fresh', HOST: 'localhost', PORT: '3000' };
    const fakeProcess = { argv: ['node', 'setup.js', '--mode=development', '--non-interactive', '--confirm-db=disposable_fresh', '--reset-confirmed'],
        env: {}, stdin: { isTTY: false }, platform: process.platform,
        exit: code => { throw Object.assign(new Error('mock exit'), { exitCode: code }); } };
    const logger = new Proxy({}, { get: (_, key) => key === 'formatError' ? error => error.message : () => {} });
    const modules = {
        'node:path': require('node:path'),
        'node:child_process': { spawnSync: () => { events.push('dependencies'); return { status: 0 }; } },
        'node:fs': { existsSync: () => true },
        './lib/logger': logger,
        './lib/prerequisites': { checkNodeVersion: () => ({ ok: true }), checkNpmVersion: () => ({ ok: true }), checkMySqlTcpConnectivity: async () => ({ ok: true }) },
        './lib/env-manager': { collectConfiguration: async () => ({ config, adminCredentials: { email: 'owner@example.invalid', password: 'synthetic-only-password' }, persist: () => events.push('persist') }) },
        './lib/db-manager': { ensureDatabaseExists: async () => ({ alreadyExisted: true }), runPrismaCommand: args => { events.push(args.join(' ')); return { ok: true }; } },
        './lib/verifier': { verifyDatabaseState: async () => ({ ok: true, checks: [], summary: { admin: { id: 1 } } }) },
        './lib/test-database-config': { PROTECTED_DATABASES: new Set(), readTestDatabaseConfig: () => assert.fail('test database must not be touched by default') },
        './db-upgrade': require('../scripts/db-upgrade'),
        './lib/migration-preflight': require('../scripts/lib/migration-preflight'),
        '../prisma/seed': async options => { assert.equal(options.seedDemoData, true); assert.equal(options.isProduction, false); events.push('demo'); },
        '../app/config/prisma': { $disconnect: async () => {} }
    };
    const sandbox = { module: { exports: {} }, __dirname: require('node:path').resolve(__dirname, '../scripts'), process: fakeProcess,
        console: { log() {} }, require: id => { if (!(id in modules)) throw new Error('Unapproved test import ' + id); return modules[id]; } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/setup'), 'utf8'), sandbox);
    await assert.rejects(sandbox.module.exports.main(), error => error.exitCode === 0);
    assert.deepEqual(events, ['dependencies', 'persist', 'validate', 'migrate reset --force', 'generate', 'demo']);
    assert.equal(fakeProcess.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION, undefined);
});

test('production environment handles URL-only configuration, deferred writes and custom variables', async () => {
    const writes = [];
    const existing = { DATABASE_URL: 'mysql://mock:synthetic@mock.invalid:3307/disposable_fresh', CUSTOM_FLAG: 'retain',
        SESSION_SECRET: 'x'.repeat(64), SEED_ADMIN_PASSWORD: 'old-development-password' };
    const sandbox = { module: { exports: {} }, process: { env: {}, stdin: { isTTY: false } }, URL,
        require: id => {
            if (id === 'node:fs') return { existsSync: () => true, writeFileSync: (file, text) => writes.push(text) };
            if (id === './env-file') return { parseEnvFile: () => ({ ...existing }) };
            return require(id);
        } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/lib/env-manager'), 'utf8'), sandbox);
    const result = await sandbox.module.exports.collectConfiguration({ mode: 'production', isInteractive: false, deferWrite: true,
        rootPath: '/mock', cliArgs: { 'admin-email': 'owner@example.invalid', 'admin-password': 'synthetic-only-password' } });
    assert.equal(writes.length, 0);
    assert.equal(result.config.DATABASE_NAME, 'disposable_fresh');
    assert.equal(result.config.DATABASE_PORT, '3307');
    result.persist();
    assert.equal(writes.length, 1);
    assert.ok(writes[0].includes("CUSTOM_FLAG='retain'"));
    assert.ok(!writes[0].includes('SEED_ADMIN_PASSWORD'));
    assert.ok(!writes[0].includes('synthetic-only-password'));
    existing.DATABASE_NAME = 'wrong_target';
    await assert.rejects(sandbox.module.exports.collectConfiguration({ mode: 'production', isInteractive: false, deferWrite: true,
        rootPath: '/mock', cliArgs: { 'admin-email': 'owner@example.invalid', 'admin-password': 'synthetic-only-password' } }), /DATABASE_URL/);
});

test('common production seed excludes priced items and scopes accounts to initial business', async () => {
    let calls = 0;
    const sandbox = { module: { exports: {} }, require: id => {
        if (id.endsWith('rbac.service')) return { seedPermissionsAndRoles: async () => {} };
        if (id.endsWith('chartOfAccounts.service')) return { ensureSystemAccounts: async (user, businessId) => { assert.equal(businessId, 1); calls++; return 44; } };
        throw new Error('Unexpected import');
    } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../prisma/seed/common'), 'utf8'), sandbox);
    await sandbox.module.exports.seedCommon({ unit: { findFirst: async () => ({ id: 1 }) }, item: { findFirst: () => assert.fail('sample items must not be seeded') } }, null, { includeItems: false });
    assert.equal(calls, 1);
});
