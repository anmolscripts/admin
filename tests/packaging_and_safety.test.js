'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isForbidden, verifyPackaging } = require('../scripts/package-release');

const ROOT_DIR = path.resolve(__dirname, '..');

describe('Packaging Safety & Database Guardrails Test Suite', () => {
    describe('1. Release Archive Exclusions & Packaging Invariants', () => {
        it('identifies .env as strictly forbidden', () => {
            assert.strictEqual(isForbidden('.env'), true);
            assert.strictEqual(isForbidden('.env.local'), true);
        });

        it('identifies .git/ and node_modules/ as strictly forbidden', () => {
            assert.strictEqual(isForbidden('.git/config'), true);
            assert.strictEqual(isForbidden('node_modules/express/index.js'), true);
        });

        it('identifies local logs and .artifacts as strictly forbidden', () => {
            assert.strictEqual(isForbidden('app.log'), true);
            assert.strictEqual(isForbidden('.artifacts/product-readiness/test.log'), true);
        });

        it('identifies uploaded avatar files as forbidden while preserving .gitkeep', () => {
            assert.strictEqual(isForbidden('assets/uploads/avatars/user-123.png'), true);
            assert.strictEqual(isForbidden('assets/uploads/avatars/.gitkeep'), false);
        });

        it('permits essential distribution files (.env.example, package.json, prisma, etc.)', () => {
            assert.strictEqual(isForbidden('.env.example'), false);
            assert.strictEqual(isForbidden('.env.production.example'), false);
            assert.strictEqual(isForbidden('package.json'), false);
            assert.strictEqual(isForbidden('app/server.js'), false);
        });

        it('full release packaging verification passes with zero forbidden files', () => {
            const result = verifyPackaging();
            assert.strictEqual(result.ok, true, 'Package manifest must pass verification');
            assert.strictEqual(result.violations.length, 0);
            assert.ok(result.files.length > 50, 'Package should include project source files');
        });
    });

    describe('2. Database Reset Guardrails & Safeguard Rejections', () => {
        it('refuses to reset when NODE_ENV=production', () => {
            const res = spawnSync('node', ['scripts/db-reset.js', '--confirm-db=admin', '--force-reset'], {
                cwd: ROOT_DIR,
                encoding: 'utf-8',
                env: { ...process.env, NODE_ENV: 'production' }
            });

            assert.strictEqual(res.status, 1, 'Must exit with non-zero error code in production');
            const output = res.stderr + res.stdout;
            assert.ok(output.includes('NODE_ENV=production'), 'Error must specify production violation');
        });

        it('refuses to reset when target database confirmation is missing', () => {
            const res = spawnSync('node', ['scripts/db-reset.js'], {
                cwd: ROOT_DIR,
                encoding: 'utf-8',
                env: { ...process.env, NODE_ENV: 'development' }
            });

            assert.strictEqual(res.status, 1);
            const output = res.stderr + res.stdout;
            assert.ok(output.includes('--confirm-db'), 'Error must demand exact database confirmation');
        });

        it('refuses to reset when confirmed database name does not match target database', () => {
            const res = spawnSync('node', ['scripts/db-reset.js', '--confirm-db=wrong_nonexistent_db', '--force-reset'], {
                cwd: ROOT_DIR,
                encoding: 'utf-8',
                env: { ...process.env, NODE_ENV: 'development' }
            });

            assert.strictEqual(res.status, 1);
            const output = res.stderr + res.stdout;
            assert.ok(output.includes('confirm'), 'Error must reject mismatched database name');
        });

        it('refuses to reset when --force-reset flag is omitted', () => {
            const res = spawnSync('node', ['scripts/db-reset.js', '--confirm-db=admin'], {
                cwd: ROOT_DIR,
                encoding: 'utf-8',
                env: { ...process.env, NODE_ENV: 'development' }
            });

            assert.strictEqual(res.status, 1);
            const output = res.stderr + res.stdout;
            assert.ok(output.includes('--force-reset'), 'Error must demand --force-reset flag');
        });
    });
});
