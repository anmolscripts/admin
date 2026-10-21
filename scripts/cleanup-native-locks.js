'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const modulesDir = path.join(root, 'node_modules');

function rmSafe(targetPath) {
    try {
        if (!targetPath || !fs.existsSync(targetPath)) return;
        fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5 });
        console.log(`[cleanup] removed ${path.relative(root, targetPath) || targetPath}`);
    } catch (error) {
        console.warn(`[cleanup] skipped ${targetPath}: ${error.message}`);
    }
}

if (fs.existsSync(modulesDir)) {
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
        const full = path.join(modulesDir, entry.name);
        if (entry.isDirectory() && (entry.name.startsWith('.bcrypt-') || entry.name === 'bcrypt')) {
            rmSafe(full);
        }
    }

    const bcryptDir = path.join(modulesDir, 'bcrypt');
    if (fs.existsSync(bcryptDir)) {
        const prebuildsDir = path.join(bcryptDir, 'prebuilds');
        if (fs.existsSync(prebuildsDir)) {
            for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
                const full = path.join(prebuildsDir, entry.name);
                if (entry.isDirectory() && full.includes('win32-x64')) {
                    rmSafe(full);
                }
            }
        }
    }
}

console.log('[cleanup] native module lock cleanup complete');
