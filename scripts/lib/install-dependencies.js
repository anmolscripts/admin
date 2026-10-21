'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function cleanupNativeLocks(root = path.resolve(__dirname, '../..')) {
    const marker = path.join(root, 'scripts', 'cleanup-native-locks.js');
    if (!fs.existsSync(marker)) return;
    try {
        const result = spawnSync(process.execPath, [marker], {
            cwd: root,
            stdio: 'inherit',
            shell: false
        });
        if (result.error) {
            console.warn('[install] native lock cleanup helper could not run:', result.error.message);
        }
    } catch (error) {
        console.warn('[install] native lock cleanup helper failed:', error.message);
    }
}

function installDependencies({ root = path.resolve(__dirname, '../..'), production = true, run = spawnSync } = {}) {
    if (!fs.existsSync(path.join(root, 'package-lock.json'))) throw new Error('package-lock.json is required for a reproducible installation.');

    cleanupNativeLocks(root);

    const args = ['ci', ...(production ? ['--omit=dev'] : []), '--no-audit', '--no-fund'];
    const npmCli = process.env.npm_execpath;
    const result = npmCli && fs.existsSync(npmCli)
        ? run(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', shell: false })
        : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

    if (result.error || result.status !== 0) {
        cleanupNativeLocks(root);
        const retry = npmCli && fs.existsSync(npmCli)
            ? run(process.execPath, [npmCli, 'install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: false })
            : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', 'install --no-audit --no-fund', { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
        if (retry.error || retry.status !== 0) throw new Error('Dependency installation failed; no database operation was started.');
    }
}
module.exports = { installDependencies };
