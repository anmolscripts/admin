'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deployment(options = {}) {
    const root = path.resolve('/mock-skip-backup');
    const previous = path.join(root, 'dist/builds/previous');
    const release = path.join(root, 'dist/builds/new');
    const data = path.join(root, 'data');
    const files = new Map([
        [path.join(data, 'deploy-config.json'), JSON.stringify({ ngrokPath: '/mock/ngrok', ngrokAuthtoken: 'synthetic-token', mysqldumpPath: '/mock/mysqldump' })],
        [path.join(data, 'deployment-state.json'), JSON.stringify({ release: previous, url: 'https://example.ngrok-free.dev' })],
        [path.join(root, '.env'), 'synthetic config'],
        [path.join(previous, '.env'), 'synthetic config']
    ]);
    const events = [], commands = [], copies = [], directories = [], logs = [], queries = [];
    let migrated = false, launches = 0, builds = 0;
    const fakeFs = {
        existsSync: file => files.has(file) || file === '/mock/ngrok',
        readFileSync: file => { if (!files.has(file)) throw new Error('Missing mock file: ' + file); return files.get(file); },
        writeFileSync: (file, value) => { if (typeof file !== 'number') files.set(file, value); },
        renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
        mkdirSync: directory => directories.push(directory),
        openSync: (file, mode) => { if (mode === 'wx' && files.has(file)) throw new Error('Deployment already running'); if (mode === 'wx') files.set(file, 'lock'); return 1; },
        closeSync() {}, unlinkSync: file => files.delete(file),
        cpSync: (...args) => copies.push(args), symlinkSync() {}, lstatSync: () => ({ isSymbolicLink: () => false })
    };
    const base = { DATABASE_URL: 'mysql://mock:synthetic@mock.invalid/spark_disp_mock', DATABASE_NAME: 'spark_disp_mock', SESSION_SECRET: 'x'.repeat(64) };
    const modules = {
        'node:fs': fakeFs,
        'node:child_process': {
            spawnSync(command, args) {
                commands.push({ command, args: Array.from(args) });
                if (command === '/mock/mysqldump') {
                    if (options.dumpFailure) return { status: 1, stderr: 'mock backup failure' };
                    files.set(args.find(arg => arg.startsWith('--result-file=')).slice(14), '-- Dump completed on synthetic');
                }
                if (String(args[0]).endsWith('db-upgrade.js')) { migrated = true; events.push('migrate'); }
                return { status: 0, stdout: '' };
            },
            spawn(command, args) { launches++; events.push('launch'); return { pid: 1234 + launches, on() {}, unref() {} }; }
        },
        dotenv: { parse: () => ({ ...base }) },
        './db-upgrade': require('../scripts/db-upgrade'),
        './build': { build() { builds++; events.push('build'); return release; } },
        './lib/migration-preflight': {
            verifyMigrationSource() { events.push('provenance'); if (options.uncommitted) throw new Error('Uncommitted migrations'); },
            readMigrations: () => options.unsafeMigration ? [{ name: 'unsafe' }] : [],
            async prepareDatabase() { events.push('preflight'); }, connectionOptions: () => ({})
        },
        mariadb: { async createConnection() { return {
            async query(sql) {
                queries.push(sql);
                if (sql.includes('migration_name')) return [];
                if (sql.startsWith('SHOW FULL TABLES')) return [{ table: 'items' }, { table: '_prisma_migrations' }];
                if (sql.startsWith('SELECT COUNT')) return [{ n: options.rowLoss && migrated && sql.includes('`items`') ? 0 : 2 }];
                throw new Error('Unexpected SQL ' + sql);
            }, escapeId: table => '`' + table + '`', async end() { events.push('close'); }
        }; } }
    };
    if (options.unsafeMigration) files.set(path.join(root, 'prisma/migrations/unsafe/migration.sql'), 'DELETE FROM items;');
    const sandbox = { module: { exports: {} }, __dirname: path.join(root, 'scripts'), URL, AbortSignal,
        process: { argv: ['node','deploy.js'], env: { npm_execpath: '/mock/npm-cli.js' }, execPath: 'node', platform: 'linux', pid: 999,
            versions: process.versions, kill() { throw new Error('Mock process is not running'); } },
        setTimeout: callback => queueMicrotask(callback),
        console: { log: text => logs.push(text), error: text => logs.push(text) },
        fetch: async url => ({ ok: true, json: async () => url.includes('/api/tunnels')
            ? { tunnels: [{ config: { addr: 'localhost:3000' }, public_url: 'https://example.ngrok-free.dev' }] }
            : { status: 'ok', database: 'connected' } }),
        require: id => Object.hasOwn(modules, id) ? modules[id] : require(id)
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/deploy'), 'utf8'), sandbox);
    return { main: sandbox.module.exports.main, files, commands, copies, directories, logs, events, queries,
        get launches() { return launches; }, get builds() { return builds; }, data };
}

test('build -- --skip-backup runs the complete deployment without a dump or release copy', async () => {
    const h = deployment();
    await h.main(['--skip-backup']);
    assert.equal(h.copies.length, 0);
    assert.ok(!h.commands.some(command => command.command.includes('mysqldump')));
    assert.ok(!h.directories.some(directory => directory.includes(path.sep + 'backups')));
    assert.equal(h.builds, 1);
    assert.equal(h.launches, 1);
    const migration = h.commands.find(command => command.args[0].endsWith('db-upgrade.js'));
    assert.deepEqual(migration.args.slice(1), ['--confirm-db=spark_disp_mock','--skip-backup']);
    assert.ok(h.commands.some(command => command.args.includes('ci')));
    const state = JSON.parse(h.files.get(path.join(h.data, 'deployment-state.json')));
    assert.equal(state.backup, null);
    assert.equal(state.url, 'https://example.ngrok-free.dev');
    for (const name of ['row-counts-before.json','row-counts-after.json']) assert.ok([...h.files.keys()].some(file => file.includes(path.sep + 'deployments' + path.sep) && file.endsWith(name)));
    assert.ok(h.queries.every(sql => sql.startsWith('SELECT ') || sql.startsWith('SHOW ')));
    assert.ok(!h.files.has(path.join(h.data, 'deployment.lock')));
});

test('default build still verifies a SQL backup and copies the previous release', async () => {
    const h = deployment(); await h.main([]);
    assert.equal(h.copies.length, 1);
    assert.equal(h.commands.filter(command => command.command.includes('mysqldump')).length, 1);
    assert.ok(h.commands.some(command => command.args.includes('--backup-confirmed')));
    assert.ok(JSON.parse(h.files.get(path.join(h.data, 'deployment-state.json'))).backup.includes(path.sep + 'backups' + path.sep));
});

test('skip backup preserves migration guards, row-loss detection, rollback and lock cleanup', async () => {
    for (const scenario of [{ uncommitted: true }, { unsafeMigration: true }, { rowLoss: true }]) {
        const h = deployment(scenario);
        await assert.rejects(h.main(['--skip-backup']), /Uncommitted|not strictly additive|Row count changed/);
        assert.ok(!h.files.has(path.join(h.data, 'deployment.lock')));
        assert.ok(h.events.includes('close') || scenario.uncommitted);
        if (scenario.rowLoss) assert.equal(h.launches, 1, 'previous app restarts after migration failure');
        else assert.equal(h.builds, 0);
    }
    const h = deployment({ dumpFailure: true });
    await assert.rejects(h.main([]), /backup could not be verified/);
    assert.equal(h.builds, 0);
});

test('unknown options and conflicting status mode stop before any deployment work', async () => {
    for (const args of [['--skip-bu'], ['--skip-backup=false'], ['--status','--skip-backup'], ['unexpected']]) {
        const h = deployment(); await assert.rejects(h.main(args));
        assert.equal(h.directories.length, 0);
        assert.equal(h.commands.length, 0);
    }
    const h = deployment(); await h.main(['--status']);
    assert.equal(h.builds, 0); assert.equal(h.commands.length, 0);
});

test('migration wrapper retains interactive answers, cancellation and explicit non-interactive skip mode', async () => {
    async function run(answers, args = []) {
        const questions = [], upgrades = [];
        let closed = false, installed = false;
        const modules = {
            'node:readline': { createInterface: () => ({ close() { closed = true; } }) },
            './lib/env-file': { parseEnvFile: () => ({ DATABASE_URL: 'mysql://mock:synthetic@mock.invalid/approved_release', DATABASE_NAME: 'approved_release' }) },
            './lib/env-manager': { async askQuestion(rl, prompt) { questions.push(prompt); const answer = answers.shift(); if (answer instanceof Error) throw answer; return answer; } },
            './db-upgrade': { parseDatabaseTarget: require('../scripts/db-upgrade').parseDatabaseTarget, async main(argv) { upgrades.push(Array.from(argv)); } }
        };
        const sandbox = { module: { exports: {} }, __dirname: path.resolve(__dirname, '../scripts'),
            process: { stdin: { isTTY: true }, stdout: {}, env: {} },
            require: id => Object.hasOwn(modules, id) ? modules[id] : require(id) };
        vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/install-migrate'), 'utf8'), sandbox);
        let error;
        try { await sandbox.module.exports.main(args, { installDependencies: () => { installed = true; } }); } catch (failure) { error = failure; }
        return { questions, upgrades, closed, installed, error };
    }
    const accepted = await run(['approved_release','yes']);
    assert.equal(accepted.error, undefined);
    assert.deepEqual(accepted.upgrades, [['--confirm-db=approved_release','--backup-confirmed']]);
    assert.equal(accepted.closed, true);
    for (const answers of [['approved_release','no'], ['wrong','yes'], [new Error('Upgrade cancelled')]]) {
        const cancelled = await run(answers);
        assert.match(cancelled.error.message, /cancelled/);
        assert.equal(cancelled.upgrades.length, 0);
        assert.equal(cancelled.closed, true);
    }
    const skipped = await run([], ['--confirm-db=approved_release','--skip-backup']);
    assert.equal(skipped.installed, true);
    assert.equal(skipped.questions.length, 0);
    assert.deepEqual(skipped.upgrades, [['--confirm-db=approved_release','--skip-backup']]);
});
