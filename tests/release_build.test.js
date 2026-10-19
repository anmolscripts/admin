'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../package.json');
const packageLock = require('../package-lock.json');
const {
    parseArguments,
    parseDatabaseTarget,
    sanitizeOutput
} = require('../scripts/db-upgrade');
const {
    sanitizePackageManifest,
    validatePackageLock
} = require('../scripts/build');
const {
    buildFileList,
    isForbidden,
    verifyPackaging
} = require('../scripts/package-release');

describe('release build and migration safeguards', () => {
    it('requires a concrete MySQL target and rejects a protected database', () => {
        assert.throws(() => parseDatabaseTarget('', ''), /DATABASE_URL is required/);
        assert.throws(() => parseDatabaseTarget('mysql://user:pass@localhost/admin', 'admin'), /protected database/);
        assert.throws(
            () => parseDatabaseTarget('mysql://user:pass@localhost/approved_db', 'different_db'),
            /does not match/
        );
    });

    it('parses and validates an exact non-protected migration target', () => {
        const target = parseDatabaseTarget(
            'mysql://db-user:super-secret@db.example:3307/approved%5Fstage',
            'approved_stage'
        );
        assert.deepEqual(target, {
            protocol: 'mysql',
            host: 'db.example',
            port: '3307',
            database: 'approved_stage'
        });
        assert.equal(JSON.stringify(target).includes('super-secret'), false);
    });

    it('requires both exact target and backup confirmation flags', () => {
        assert.deepEqual(parseArguments(['--confirm-db=staging', '--backup-confirmed']), {
            confirmDatabase: 'staging',
            backupConfirmed: true
        });
        assert.throws(() => parseArguments(['--drop']), /Unknown option/);
    });

    it('stops before invoking Prisma when the target confirmation is absent', async () => {
        await assert.rejects(
            () => require('../scripts/db-upgrade').main([], {
                DATABASE_URL: 'mysql://user:password@localhost/release_stage',
                DATABASE_NAME: 'release_stage'
            }),
            /Target confirmation is required/
        );
    });

    it('redacts URL credentials from command output', () => {
        assert.equal(
            sanitizeOutput('failed mysql://alice:secret@db.example/app', ''),
            'failed mysql://[redacted]@db.example/app'
        );
    });

    it('validates package and lockfile dependency metadata', () => {
        assert.doesNotThrow(() => validatePackageLock(packageJson, packageLock));
        const changed = JSON.parse(JSON.stringify(packageLock));
        changed.packages[''].dependencies.express = '^0.0.0';
        assert.throws(() => validatePackageLock(packageJson, changed), /do not match/);
    });

    it('publishes only safe runtime commands in the release manifest', () => {
        const release = sanitizePackageManifest(packageJson);
        assert.deepEqual(Object.keys(release.scripts), ['start', 'doctor', 'install:migrate']);
        assert.equal(release.scripts['db:reset'], undefined);
        assert.deepEqual(release.dependencies, packageJson.dependencies);
    });

    it('excludes secrets, local artifacts, database dumps, and destructive tooling', () => {
        for (const candidate of [
            '.env',
            '.env.test',
            'app/.env.example',
            'assets/uploads/avatars/user.png',
            'evidence/export.json',
            'data/backup.sql',
            'scripts/db-reset.js',
            'scripts/test-upgrade-from-m16.js',
            'docs/DATABASE_OPERATIONS.md'
        ]) {
            assert.equal(isForbidden(candidate), true, `${candidate} should be excluded`);
        }
        assert.equal(isForbidden('.env.example'), false);
        assert.equal(isForbidden('prisma/migrations/20261019_add_field/migration.sql'), false);
        assert.ok(buildFileList().includes('prisma/schema.prisma'));
        for (const required of [
            'scripts/db-upgrade.js', 'scripts/lib/migration-preflight.js',
            'scripts/lib/env-file.js', 'scripts/lib/logger.js',
            'scripts/lib/prerequisites.js', 'scripts/lib/prisma-cli.js'
        ]) assert.ok(buildFileList().includes(required), `${required} must be shipped`);
        assert.equal(isForbidden('scripts/lib/db-manager.js'), true);
        assert.equal(verifyPackaging().ok, true);
    });
});
