'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readMigrations, migrationSource, verifyMigrationSource } = require('../scripts/lib/migration-preflight');

function fixture(callback) {
    const prefix = path.join(os.tmpdir(), 'spark-migration-provenance-');
    const root = fs.mkdtempSync(prefix);
    const directory = path.join(root, 'prisma/migrations');
    fs.mkdirSync(path.join(directory, '20260101_initial'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'migration_lock.toml'), 'provider = "mysql"\n');
    fs.writeFileSync(path.join(directory, '20260101_initial/migration.sql'), 'CREATE TABLE example (id INT);\n');
    const sql = readMigrations(directory)[0];
    const source = { commit: 'a'.repeat(40), allCommitted: true, files: {
        'migration_lock.toml': crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'migration_lock.toml'))).digest('hex'),
        [`${sql.name}/migration.sql`]: sql.checksum
    } };
    try { callback({ root, directory, source }); }
    finally {
        assert.ok(path.resolve(root).startsWith(path.resolve(prefix)));
        fs.rmSync(root, { recursive: true, force: true });
    }
}

it('requires committed release provenance and refuses missing or modified migration files', () => fixture(({ root, directory, source }) => {
    const file = path.join(root, 'migration-source.json');
    assert.throws(() => verifyMigrationSource(root), /provenance is missing/);
    fs.writeFileSync(file, JSON.stringify(source));
    assert.deepEqual(verifyMigrationSource(root), source);
    fs.writeFileSync(file, JSON.stringify({ ...source, allCommitted: false }));
    assert.throws(() => verifyMigrationSource(root), /uncommitted changes/);
    fs.writeFileSync(file, JSON.stringify(source));
    fs.appendFileSync(path.join(directory, '20260101_initial/migration.sql'), '-- changed\n');
    assert.throws(() => verifyMigrationSource(root), /differ from release provenance/);
}));

it('detects staged, untracked and ignored migration SQL instead of treating it as committed', () => fixture(({ root, directory }) => {
    const git = args => {
        const result = spawnSync('git', ['-c', 'core.hooksPath=NUL', ...args], { cwd: root, encoding: 'utf8', shell: false });
        assert.equal(result.status, 0, result.stderr);
    };
    git(['init', '--quiet']);
    git(['add', 'prisma']);
    git(['-c', 'user.name=Release Tests', '-c', 'user.email=release-tests@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
    assert.equal(migrationSource(root).allCommitted, true);
    assert.doesNotThrow(() => verifyMigrationSource(root));
    fs.mkdirSync(path.join(directory, '20260102_added'));
    fs.writeFileSync(path.join(directory, '20260102_added/migration.sql'), 'ALTER TABLE example ADD name TEXT;\n');
    assert.equal(migrationSource(root).allCommitted, false);
    assert.throws(() => verifyMigrationSource(root), /uncommitted changes/);
    fs.writeFileSync(path.join(root, '.gitignore'), 'prisma/migrations/20260102_added/\n');
    assert.equal(migrationSource(root).allCommitted, false);
    git(['add', '-f', 'prisma']);
    assert.equal(migrationSource(root).allCommitted, false);
}));

it('requires nonempty MySQL migration SQL and refuses missing migration content', () => fixture(({ directory }) => {
    fs.writeFileSync(path.join(directory, '20260101_initial/migration.sql'), '');
    assert.throws(() => readMigrations(directory), /Empty migration/);
    fs.writeFileSync(path.join(directory, 'migration_lock.toml'), 'provider = "postgresql"\n');
    assert.throws(() => readMigrations(directory), /MySQL migration lockfile/);
}));
