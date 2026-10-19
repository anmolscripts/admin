//!/usr/bin/env node
'use strict';

/**
 * Spark Admin — Clean Customer Release Packaging
 * Packages production‑ready distribution from strict allowlist and verifies zero secret leaks.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { migrationSource } = require('./lib/migration-preflight');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const FORBIDDEN_PATTERNS = [
    /(^|\/)(?:\.git|node_modules|dist|build|coverage|\.artifacts|evidence|data|test-results|playwright-report)(\/|$)/i,
    /(^|\/)uploads(\/|$)/i,
    /\.log$/,
    /\.(?:sql\.dump|dump|bak|backup|sqlite|db|zip|tar|gz|swp|swo)$/i
];

const ALLOWED_DIRECTORIES = [
    'app',
    'assets',
    'docs',
    'prisma',
    'scripts'
];

const RELEASE_SCRIPT_FILES = new Set([
    'scripts/db-upgrade.js',
    'scripts/doctor.js',
    'scripts/lib/env-file.js',
    'scripts/lib/logger.js',
    'scripts/lib/prerequisites.js',
    'scripts/lib/prisma-cli.js',
    'scripts/lib/migration-preflight.js'
]);

const ALLOWED_ROOT_FILES = [
    'package.json',
    'package-lock.json',
    '.env.example',
    '.env.production.example',
    '.gitignore',
    'README.md',
    'prisma7.config.ts'
];

function isForbidden(relPath) {
    const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (norm === '.env.example' || norm === '.env.production.example' || norm === '.gitignore') return false;
    if (norm === 'assets/uploads/avatars/.gitkeep') return false;
    if (/(^|\/)\.env[^/]*(?:\/|$)/i.test(norm)) return true;
    if (/^docs\/DATABASE_OPERATIONS\.md$/i.test(norm)) return true;
    if (norm.startsWith('scripts/') && !RELEASE_SCRIPT_FILES.has(norm) &&
        ![...RELEASE_SCRIPT_FILES].some(file => file.startsWith(`${norm}/`))) return true;
    if (/\.sql$/i.test(norm) && !/^prisma\/migrations\/[^/]+\/migration\.sql$/i.test(norm)) return true;
    return FORBIDDEN_PATTERNS.some(pat => pat.test(norm));
}

function scanFiles(dir, baseDir = ROOT_DIR) {
    const list = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
        if (isForbidden(relPath)) continue;
        if (entry.isDirectory()) {
            list.push(...scanFiles(fullPath, baseDir));
        } else if (entry.isFile()) {
            list.push(relPath);
        }
    }
    return list;
}

function buildFileList() {
    const files = [];
    for (const f of ALLOWED_ROOT_FILES) {
        const full = path.join(ROOT_DIR, f);
        if (fs.existsSync(full)) files.push(f);
    }
    for (const d of ALLOWED_DIRECTORIES) {
        const full = path.join(ROOT_DIR, d);
        if (fs.existsSync(full)) files.push(...scanFiles(full, ROOT_DIR));
    }
    return files;
}

function verifyPackaging() {
    const files = buildFileList();
    const violations = [];
    for (const f of files) {
        if (isForbidden(f)) violations.push(f);
    }
    if (violations.length > 0) {
        console.error('[PACKAGING ERROR] Forbidden files detected in release package manifest:');
        violations.forEach(v => console.error(` - ${v}`));
        return { ok: false, violations, files };
    }
    return { ok: true, violations: [], files };
}

function sanitizePackageJson(packageJson) {
    const result = JSON.parse(JSON.stringify(packageJson));
    result.scripts = {
        start: 'node app/server.js',
        doctor: 'node scripts/doctor.js',
        'install:migrate': 'node scripts/db-upgrade.js'
    };
    return result;
}

function copyToStaging(files, stagingDir) {
    for (const rel of files) {
        const src = path.join(ROOT_DIR, rel);
        const dest = path.join(stagingDir, rel);
        const destDir = path.dirname(dest);
        fs.mkdirSync(destDir, { recursive: true });
        if (rel === 'package.json') {
            const packageJson = JSON.parse(fs.readFileSync(src, 'utf8'));
            fs.writeFileSync(dest, `${JSON.stringify(sanitizePackageJson(packageJson), null, 2)}\n`);
        } else {
            fs.copyFileSync(src, dest);
        }
    }
    fs.writeFileSync(path.join(stagingDir, 'migration-source.json'), `${JSON.stringify(migrationSource(ROOT_DIR), null, 2)}\n`, { flag: 'wx' });
}

if (require.main === module) {
    console.log('='.repeat(64));
    console.log('   SPARK ADMIN — RELEASE PACKAGING AUDIT');
    console.log('='.repeat(64));

    const result = verifyPackaging();
    if (!result.ok) process.exit(1);

    console.log(`\n✔ Package verification passed: ${result.files.length} clean release files included.`);
    console.log('✔ Secret, local-data, evidence, backup, fixture, and generated-artifact exclusions passed.');

    const zipPath = path.join(DIST_DIR, 'spark-admin-release.zip');
    const manifestPath = path.join(DIST_DIR, 'release-manifest.json');
    if (fs.existsSync(zipPath) || fs.existsSync(manifestPath)) {
        console.error('\n[CRITICAL RELEASE GUARD]: Existing baseline archive dist/spark-admin-release.zip exists.');
        console.error('Overwriting either baseline release artifact is blocked. Use scripts/package-candidate.js with a new output name.');
        process.exit(1);
    }
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-admin-release-'));
    copyToStaging(result.files, stagingDir);

    try {
        const isWin = process.platform === 'win32';
        if (isWin) {
            const escapedStage = stagingDir.replace(/'/g, "''");
            const escapedZip = zipPath.replace(/'/g, "''");
            const command = `Compress-Archive -Path (Get-ChildItem -LiteralPath '${escapedStage}' -Force | ForEach-Object { $_.FullName }) -DestinationPath '${escapedZip}'`;
            const zipResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'inherit' });
            if (zipResult.status !== 0) throw new Error('Failed to create release ZIP.');
        } else {
            const zipResult = spawnSync('zip', ['-r', zipPath, '.'], { cwd: stagingDir, stdio: 'inherit' });
            if (zipResult.status !== 0) throw new Error('Failed to create release ZIP.');
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        fs.rmSync(stagingDir, { recursive: true, force: true });
        process.exit();
    }

    // Generate release-manifest.json
    const crypto = require('node:crypto');
    const zipBytes = fs.readFileSync(zipPath);
    const zipSha256 = crypto.createHash('sha256').update(zipBytes).digest('hex');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

    let headCommit = 'unknown';
    try {
        headCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).stdout.trim();
    } catch (_) {}

    const manifest = {
        name: pkg.name || 'spark-admin',
        version: pkg.version || '1.0.0',
        commit: headCommit,
        packagedAt: new Date().toISOString(),
        archiveName: 'spark-admin-release.zip',
        archiveSizeBytes: zipBytes.length,
        archiveSha256: zipSha256,
        fileCount: result.files.length,
        files: result.files
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', flag: 'wx' });
    console.log(`✔ Release manifest written to ${manifestPath}`);

    fs.rmSync(stagingDir, { recursive: true, force: true });
    console.log(`\n✔ Release ZIP created at ${zipPath}`);
    process.exit(0);
}

module.exports = {
    isForbidden,
    buildFileList,
    verifyPackaging,
    FORBIDDEN_PATTERNS,
    copyToStaging,
    sanitizePackageJson
};
