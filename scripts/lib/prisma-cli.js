'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Runs the repository's Prisma CLI with its non-default Prisma 7 config file.
 *
 * @param {string[]} args
 * @param {Record<string, string>} [envVars={}]
 * @returns {{ ok: boolean, stdout: string, stderr: string, error?: string }}
 */
function runPrismaCommand(args, envVars = {}) {
    const rootPath = process.cwd();
    const prismaCli = path.join(rootPath, 'node_modules', 'prisma', 'build', 'index.js');
    const prismaConfig = path.join(rootPath, 'prisma7.config.ts');

    if (!fs.existsSync(prismaCli)) {
        return {
            ok: false,
            stdout: '',
            stderr: '',
            error: 'Prisma CLI is not installed. Run npm ci before continuing.'
        };
    }

    const result = spawnSync(process.execPath, [
        prismaCli,
        '--config',
        prismaConfig,
        ...args
    ], {
        cwd: rootPath,
        encoding: 'utf8',
        env: { ...process.env, ...envVars },
        shell: false
    });

    if (result.error) {
        return {
            ok: false,
            stdout: result.stdout || '',
            stderr: result.stderr || '',
            error: result.error.message
        };
    }

    return {
        ok: result.status === 0,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.status !== 0
            ? (result.stderr || result.stdout || `Prisma exited with code ${result.status}`)
            : undefined
    };
}

module.exports = { runPrismaCommand };
