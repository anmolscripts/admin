'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function diagnose(migrationsCurrent = true) {
    const env = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64), DATABASE_HOST: 'mock.invalid',
        DATABASE_USER: 'app_user', DATABASE_NAME: 'mock_production' };
    const tables = ['users', 'roles', 'permissions', 'role_permissions', 'units', 'items', 'invoices', 'clients', 'business_profiles'];
    const prisma = {
        $queryRaw: async strings => strings.join('').includes('SHOW TABLES') ? tables.map(name => ({ name })) : [{ ping: 1 }],
        role: { findMany: async () => ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'].map(name => ({ name })) },
        permission: { count: async () => 103 }, rolePermission: { count: async () => 300 },
        unit: { count: async () => 15 }, item: { count: async () => 0 },
        user: { findFirst: async () => ({ email: 'owner@example.invalid' }) }
    };
    for (const model of ['client', 'invoice', 'payment', 'invoiceRevision', 'userActivityLog', 'businessProfile']) {
        prisma[model] = { count: async () => 5 };
    }
    const fakeProcess = { env: {} };
    const modules = {
        dotenv: { config: () => { Object.assign(fakeProcess.env, env); } },
        './lib/logger': { formatError: error => String(error) },
        './lib/prerequisites': { checkNodeVersion: () => ({ ok: true, message: 'ok' }),
            checkNpmVersion: () => ({ ok: true, message: 'ok' }), checkMySqlTcpConnectivity: async () => ({ ok: true, message: 'ok' }) },
        './lib/env-file': { parseEnvFile: () => env },
        './lib/prisma-cli': { runPrismaCommand: args => ({ ok: args[0] === 'validate' || migrationsCurrent }) },
        '../app/config/prisma': prisma
    };
    const sandbox = { module: { exports: {} }, __dirname: path.resolve(__dirname, '../scripts'), process: fakeProcess,
        console: { log() {} }, require: id => id === 'node:fs' ? { existsSync: () => true } : (modules[id] || require(id)) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/doctor'), 'utf8'), sandbox);
    return sandbox.module.exports.runDoctor();
}

test('doctor reads production mode from .env and accepts empty catalogs, custom units and real business activity', async () => {
    const result = await diagnose();
    assert.equal(result.ok, true);
    assert.equal(result.checks.find(check => check.name === 'Environment Mode').detail, 'Running in production mode');
    assert.equal(result.checks.find(check => check.name === 'Predefined Item Master').status, 'PASS');
    assert.equal(result.checks.find(check => check.name === 'Predefined Unit Master').status, 'PASS');
    assert.equal(result.checks.find(check => check.name === 'Invoices').status, 'PASS');
});

test('doctor fails when the application has pending migrations', async () => {
    const result = await diagnose(false);
    assert.equal(result.ok, false);
    assert.equal(result.checks.find(check => check.name === 'Migration Status').status, 'FAIL');
});
