'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function installDependencies({ root = path.resolve(__dirname, '../..'), production = true, run = spawnSync } = {}) {
    if (!fs.existsSync(path.join(root, 'package-lock.json'))) throw new Error('package-lock.json is required for a reproducible installation.');
    const args = ['ci', ...(production ? ['--omit=dev'] : []), '--no-audit', '--no-fund'];
    const npmCli = process.env.npm_execpath;
    const result = npmCli && fs.existsSync(npmCli)
        ? run(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit', shell: false })
        : run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error || result.status !== 0) throw new Error('Dependency installation failed; no database operation was started.');
}
module.exports = { installDependencies };
