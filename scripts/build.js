'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
    verifyPackaging,
    isForbidden,
    copyToStaging,
    sanitizePackageJson
} = require('./package-release');

const ROOT_DIR = path.resolve(__dirname, '..');

function collectFiles(directory, base = directory) {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(base, absolute).replace(/\\/g, '/');
        if (isForbidden(relative)) continue;
        if (entry.isDirectory()) {
            result.push(...collectFiles(absolute, base));
        } else if (entry.isFile()) {
            result.push(relative);
        }
    }
    return result;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd || ROOT_DIR,
        env: options.env || process.env,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        shell: options.shell || false,
        stdio: options.inherit ? 'inherit' : 'pipe'
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
        const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
        throw new Error(`${options.label || command} failed${detail ? `:\n${detail}` : '.'}`);
    }
    return result.stdout || '';
}

function runNpm(args, options = {}) {
    const npmCli = process.env.npm_execpath;
    if (npmCli && fs.existsSync(npmCli)) {
        return run(process.execPath, [npmCli, ...args], options);
    }
    if (process.platform !== 'win32') {
        return run('npm', args, options);
    }
    throw new Error('Cannot locate npm-cli.js. Run this build through npm on Windows.');
}

function validatePackageLock(packageJson, packageLock) {
    const lockedRoot = packageLock.packages && packageLock.packages[''];
    if (!lockedRoot || lockedRoot.name !== packageJson.name || lockedRoot.version !== packageJson.version) {
        throw new Error('package-lock.json root metadata does not match package.json.');
    }
    for (const section of ['dependencies', 'devDependencies']) {
        if (JSON.stringify(packageJson[section] || {}) !== JSON.stringify(lockedRoot[section] || {})) {
            throw new Error(`package-lock.json ${section} do not match package.json.`);
        }
    }
}

function createBuildEnvironment() {
    const allowedKeys = [
        'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
        'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'npm_config_cache'
    ];
    const env = {};
    for (const key of allowedKeys) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return {
        ...env,
        NODE_ENV: 'production',
        SESSION_STORE: 'database',
        HOST: '127.0.0.1',
        PORT: '3000',
        SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
        DATABASE_URL: 'mysql://build:build@127.0.0.1:3306/build_validation',
        DATABASE_HOST: '127.0.0.1',
        DATABASE_PORT: '3306',
        DATABASE_USER: 'build',
        DATABASE_PASSWORD: 'build',
        DATABASE_NAME: 'build_validation'
    };
}

function build() {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package-lock.json'), 'utf8'));
    validatePackageLock(packageJson, packageLock);

    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (nodeMajor < 24) throw new Error(`Node.js >=24 is required (found ${process.version}).`);
    const npmVersion = runNpm(['--version']).trim();
    if (Number(npmVersion.split('.')[0]) < 10) throw new Error(`npm >=10 is required (found ${npmVersion}).`);

    const packaging = verifyPackaging();
    if (!packaging.ok) throw new Error(`Release file exclusions failed: ${packaging.violations.join(', ')}`);
    for (const relativePath of packaging.files.filter((file) => file.endsWith('.js'))) {
        run(process.execPath, ['--check', path.join(ROOT_DIR, relativePath)], { label: `JavaScript syntax check (${relativePath})` });
    }

    const stageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-admin-build-'));
    const buildEnv = createBuildEnvironment();

    try {
        copyToStaging(packaging.files, stageDirectory);
        runNpm([
            'ci', '--omit=dev', '--no-audit', '--no-fund'
        ], { cwd: stageDirectory, env: buildEnv, label: 'Clean production dependency install' });

        const prismaCli = path.join(stageDirectory, 'node_modules', 'prisma', 'build', 'index.js');
        const prismaConfig = path.join(stageDirectory, 'prisma7.config.ts');
        run(process.execPath, [prismaCli, '--config', prismaConfig, 'validate'], {
            cwd: stageDirectory, env: buildEnv, label: 'Prisma schema validation'
        });
        run(process.execPath, [prismaCli, '--config', prismaConfig, 'generate'], {
            cwd: stageDirectory, env: buildEnv, label: 'Prisma Client generation'
        });

        const ejs = require(path.join(stageDirectory, 'node_modules', 'ejs'));
        let templateCount = 0;
        for (const relativePath of collectFiles(path.join(stageDirectory, 'app', 'views'))) {
            if (!relativePath.endsWith('.ejs')) continue;
            const templatePath = path.join(stageDirectory, 'app', 'views', relativePath);
            ejs.compile(fs.readFileSync(templatePath, 'utf8'), { filename: templatePath });
            templateCount += 1;
        }

        run(process.execPath, [path.join(ROOT_DIR, 'scripts', 'build-runtime-smoke.js')], {
            cwd: stageDirectory,
            env: buildEnv,
            label: 'Staged production server smoke test (mocked database)'
        });

        const releaseRoot = path.join(ROOT_DIR, 'dist', 'builds');
        fs.mkdirSync(releaseRoot, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const candidatePath = path.join(releaseRoot, `spark-admin-${packageJson.version}-${timestamp}`);
        fs.mkdirSync(candidatePath, { recursive: false });

        const candidateFiles = collectFiles(stageDirectory).sort();
        const absentFiles = packaging.files.filter((file) => !candidateFiles.includes(file));
        if (absentFiles.length > 0) {
            throw new Error(`Release candidate is missing files: ${absentFiles.join(', ')}`);
        }
        for (const relativePath of candidateFiles) {
            const sourcePath = path.join(stageDirectory, relativePath);
            const targetPath = path.join(candidatePath, relativePath);
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(sourcePath, targetPath);
        }

        const manifest = {
            name: packageJson.name,
            version: packageJson.version,
            builtAt: new Date().toISOString(),
            databaseAccessed: false,
            verification: {
                productionInstall: 'npm ci --omit=dev --no-audit --no-fund',
                prisma: ['validate', 'generate'],
                ejsTemplatesCompiled: templateCount,
                startup: 'production server with mocked Prisma; outbound connections blocked',
                publicAssets: 'HTTP response compared to staged CSS file'
            },
            fileCount: candidateFiles.length,
            files: candidateFiles
        };
        fs.writeFileSync(path.join(candidatePath, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
        console.log(`Build passed. Clean release candidate: ${candidatePath}`);
        console.log('Staged production install, Prisma validation/generation, EJS compilation, and production server startup with mocked database passed.');
        const migrationSource = JSON.parse(fs.readFileSync(path.join(candidatePath, 'migration-source.json'), 'utf8'));
        if (!migrationSource.allCommitted) console.log('Review candidate only: uncommitted migrations block install:migrate. Commit reviewed migrations and rebuild before installation.');
        return candidatePath;
    } finally {
        fs.rmSync(stageDirectory, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        build();
    } catch (error) {
        console.error(`[BUILD FAILED] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    build,
    collectFiles,
    createBuildEnvironment,
    sanitizePackageManifest: sanitizePackageJson,
    runNpm,
    validatePackageLock
};
