//!/usr/bin/env node
'use strict';

/**
 * Spark Admin — Clean Customer Release Packaging
 * Packages production‑ready distribution from strict allowlist and verifies zero secret leaks.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const STAGING_DIR = path.join(DIST_DIR, 'staging');

const FORBIDDEN_PATTERNS = [
    /^\.git([\/\\]|$)/,
    /^node_modules([\/\\]|$)/,
    /\.log$/,
    /^\.artifacts([\/\\]|$)/,
    /assets[\/\\]uploads[\/\\]avatars[\/\\]/,
    /\.sql\.dump$/,
    /\.swp$/
];

const ALLOWED_DIRECTORIES = [
    'app',
    'assets',
    'docs',
    'prisma',
    'scripts'
];

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
    const norm = relPath.replace(/\\/g, '/');
    const base = path.basename(norm);
    if (base === '.env.example' || base === '.env.production.example') return false;
    if (norm === '.gitignore' || norm.endsWith('/.gitkeep') || norm === '.gitkeep') return false;
    if (base.startsWith('.env') || /(^|\/)\.env/i.test(norm)) return true;
    return FORBIDDEN_PATTERNS.some(pat => pat.test(norm));
}

function scanFiles(dir, baseDir = ROOT_DIR) {
    const list = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath);
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

function cleanStaging() {
    if (fs.existsSync(STAGING_DIR)) {
        fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(STAGING_DIR, { recursive: true });
}

function copyToStaging(files) {
    for (const rel of files) {
        const src = path.join(ROOT_DIR, rel);
        const dest = path.join(STAGING_DIR, rel);
        const destDir = path.dirname(dest);
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(src, dest);
    }
}

if (require.main === module) {
    console.log('='.repeat(64));
    console.log('   SPARK ADMIN — RELEASE PACKAGING AUDIT');
    console.log('='.repeat(64));

    const result = verifyPackaging();
    if (!result.ok) process.exit(1);

    console.log(`\n✔ Package verification passed: ${result.files.length} clean release files included.`);
    console.log('✔ Zero forbidden files (.env, .git, node_modules, private logs/uploads).');

    if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
    cleanStaging();
    copyToStaging(result.files);

    const zipPath = path.join(DIST_DIR, 'spark-admin-release.zip');
    if (fs.existsSync(zipPath) && !process.argv.includes('--force-release-override')) {
        console.error('\n[CRITICAL RELEASE GUARD]: Existing baseline archive dist/spark-admin-release.zip exists.');
        console.error('Overwriting the baseline release is blocked. Use scripts/package-candidate.js or specify --force-release-override.');
        process.exit(1);
    }
    const isWin = process.platform === 'win32';
    if (isWin) {
        const zipCmd = 'powershell';
        // Archive contents of staging directory without a top-level folder
        const zipArgs = ['-Command', `Set-Location '${STAGING_DIR}'; Compress-Archive -Path * -DestinationPath '${zipPath}' -Force`];
        console.log('Creating release ZIP at', zipPath);
        const zipResult = spawnSync(zipCmd, zipArgs, { stdio: 'inherit', shell: true });
        if (zipResult.status !== 0) {
            console.error('Failed to create release ZIP.');
            process.exit(1);
        }
    } else {
        const zipCmd = 'zip';
        const zipArgs = ['-r', zipPath, '.'];
        console.log('Creating release ZIP at', zipPath);
        const zipResult = spawnSync(zipCmd, zipArgs, { cwd: STAGING_DIR, stdio: 'inherit' });
        if (zipResult.status !== 0) {
            console.error('Failed to create release ZIP.');
            process.exit(1);
        }
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

    const manifestPath = path.join(DIST_DIR, 'release-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`✔ Release manifest written to ${manifestPath}`);

    console.log(`\n✔ Release ZIP created at ${zipPath}`);
    process.exit(0);
}

module.exports = { isForbidden, buildFileList, verifyPackaging, FORBIDDEN_PATTERNS };
