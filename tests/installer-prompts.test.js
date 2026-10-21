'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const vm = require('node:vm');
const { askQuestion } = require('../scripts/lib/env-manager');

test('installer reports closed input instead of leaving its question unresolved', async () => {
    const rl = new EventEmitter();
    rl.question = () => queueMicrotask(() => rl.emit('close'));
    await assert.rejects(askQuestion(rl, 'Database'), /input closed/i);
    assert.equal(rl.listenerCount('close'), 0);
});

test('installer rejects cancelled questions and releases prompt listeners', async () => {
    const rl = new EventEmitter();
    rl.question = () => queueMicrotask(() => rl.emit('SIGINT'));
    await assert.rejects(askQuestion(rl, 'Database'), /cancelled/i);
    assert.equal(rl.listenerCount('SIGINT'), 0);
    assert.equal(rl.listenerCount('close'), 0);
});

test('installer does not ask an already closed interface', async () => {
    const rl = new EventEmitter();
    rl.closed = true;
    rl.question = () => assert.fail('closed input must not be queried');
    await assert.rejects(askQuestion(rl, 'Database'), /input closed/i);
});

test('Windows dependency retry preserves npm arguments and leaves terminal input for prompts', () => {
    const calls = [];
    const sandbox = {
        module: { exports: {} }, __dirname: '/mock/scripts/lib', console,
        process: { platform: 'win32', env: {}, execPath: 'node' },
        require: id => id === 'node:fs'
            ? { existsSync: file => file.endsWith('package-lock.json') } : require(id)
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/lib/install-dependencies'), 'utf8'), sandbox);
    sandbox.module.exports.installDependencies({ root: '/mock', run: (command, args, options) => {
        calls.push({ command, args: Array.from(args), stdin: options.stdio[0] });
        return { status: calls.length === 1 ? 1 : 0 };
    } });
    assert.deepEqual(calls, [
        { command: 'npm.cmd', args: ['ci', '--omit=dev', '--no-audit', '--no-fund'], stdin: 'ignore' },
        { command: 'npm.cmd', args: ['install', '--omit=dev', '--no-audit', '--no-fund'], stdin: 'ignore' }
    ]);
});

async function configure(answer) {
    const input = new PassThrough();
    input.isTTY = true;
    const output = new PassThrough();
    const prompts = [];
    const existing = {
        DATABASE_HOST: 'localhost', DATABASE_PORT: '3306', DATABASE_USER: 'root',
        DATABASE_PASSWORD: '', DATABASE_NAME: 'disposable_prompts', PORT: '3000',
        SESSION_SECRET: 'x'.repeat(64), SEED_ADMIN_PASSWORD: 'synthetic-only-password'
    };
    output.on('data', data => {
        const prompt = data.toString();
        prompts.push(prompt);
        queueMicrotask(() => input.write(
            prompt.includes('Keep existing') ? `${answer}\n`
                : prompt.includes('Database Name') ? 'disposable_changed\n' : '\n'
        ));
    });
    const sandbox = {
        module: { exports: {} }, URL,
        process: { env: {}, stdin: input, stdout: output },
        require: id => {
            if (id === 'node:fs') return { existsSync: () => true };
            if (id === './env-file') return { parseEnvFile: () => ({ ...existing }) };
            return require(id);
        }
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/lib/env-manager'), 'utf8'), sandbox);
    try {
        const result = await sandbox.module.exports.collectConfiguration({
            mode: 'development', isInteractive: true, rootPath: '/mock', deferWrite: true
        });
        return { result, prompts };
    } finally { input.destroy(); output.destroy(); }
}

test('keeping existing configuration advances without asking for stored values', async () => {
    const { result, prompts } = await configure('Y');
    assert.equal(prompts.length, 1);
    assert.equal(result.config.DATABASE_NAME, 'disposable_prompts');
    assert.equal(result.config.DATABASE_PASSWORD, '');
    assert.equal(result.config.SEED_ADMIN_PASSWORD, 'synthetic-only-password');
});

test('declining existing configuration allows editing with current values as defaults', async () => {
    const { result, prompts } = await configure('n');
    assert.ok(prompts.some(prompt => prompt.includes('Database Host [localhost]')));
    assert.ok(prompts.some(prompt => prompt.includes('Database Name [disposable_prompts]')));
    assert.equal(result.config.DATABASE_NAME, 'disposable_changed');
    assert.equal(result.config.DATABASE_PASSWORD, '');
    assert.ok(!prompts.some(prompt => prompt.includes('synthetic-only-password')));
});
