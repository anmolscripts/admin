'use strict';

const { spawnSync } = require('node:child_process');

/**
 * Maps database driver errors into human-readable, safe error messages without exposing credentials.
 *
 * @param {Error} err
 * @param {string} host
 * @param {number} port
 * @param {string} user
 * @param {string} database
 * @returns {string} Human-friendly error message
 */
function translateDbError(err, host, port, user, database) {
    const code = err.code || err.sqlState || '';
    const errno = err.errno;
    const msg = err.message || '';

    if (errno === 1045 || code === 'ER_ACCESS_DENIED_ERROR' || msg.includes('Access denied for user')) {
        return `Authentication failed for MySQL user '${user}' at ${host}:${port}. Please verify your username and password.`;
    }

    if (errno === 1044 || code === 'ER_DBACCESS_DENIED_ERROR') {
        return `User '${user}' lacks privileges to create or access database '${database}'. Please grant CREATE and ALL PRIVILEGES, or create the database manually.`;
    }

    if (code === 'ECONNREFUSED' || errno === -4078) {
        return `Cannot connect to MySQL at ${host}:${port}. Please verify that MySQL Server is running.`;
    }

    if (code === 'ENOTFOUND') {
        return `Could not resolve MySQL host '${host}'. Verify hostname configuration.`;
    }

    if (code === 'ETIMEDOUT') {
        return `Connection to MySQL at ${host}:${port} timed out. Verify network connectivity and firewall rules.`;
    }

    // Default sanitized message (strips password if present)
    return `MySQL operation failed: ${msg.replace(/:([^:@/]+)@/g, ':****@')}`;
}

/**
 * Connects to MySQL server and ensures the target database exists.
 * Creates the database with utf8mb4 charset if missing.
 *
 * @param {Object} params
 * @param {string} params.host
 * @param {number} params.port
 * @param {string} params.user
 * @param {string} params.password
 * @param {string} params.database
 * @returns {Promise<{ created: boolean, alreadyExisted: boolean }>}
 */
async function ensureDatabaseExists({ host, port, user, password, database }) {
    let mariadb;
    try {
        mariadb = require('mariadb');
    } catch (_) {
        throw new Error('Database driver mariadb is not installed. Please run dependency installation first.');
    }

    let conn;
    try {
        conn = await mariadb.createConnection({
            host: host === 'localhost' ? '127.0.0.1' : host,
            port: Number(port) || 3306,
            user,
            password,
            allowPublicKeyRetrieval: true,
            connectTimeout: 5000
        });
    } catch (err) {
        throw new Error(translateDbError(err, host, port, user, database));
    }

    try {
        // Check if database exists
        const rows = await conn.query(
            'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
            [database]
        );

        const exists = rows.length > 0;

        if (!exists) {
            // Create database
            await conn.query(
                `CREATE DATABASE \`${database.replace(/`/g, '``')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
            );
            return { created: true, alreadyExisted: false };
        }

        return { created: false, alreadyExisted: true };
    } catch (err) {
        throw new Error(translateDbError(err, host, port, user, database));
    } finally {
        if (conn) {
            try {
                await conn.end();
            } catch (_) {
                // ignore
            }
        }
    }
}

/**
 * Runs a Prisma CLI command via child_process.spawnSync.
 *
 * @param {string[]} args - e.g. ['validate'], ['migrate', 'deploy'], ['generate']
 * @param {Record<string, string>} [envVars={}]
 * @returns {{ ok: boolean, stdout: string, stderr: string, error?: string }}
 */
function runPrismaCommand(args, envVars = {}) {
    const commandStr = `npx prisma ${args.join(' ')}`;

    const mergedEnv = {
        ...process.env,
        ...envVars
    };

    const result = spawnSync(commandStr, {
        encoding: 'utf8',
        env: mergedEnv,
        shell: true
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
        error: result.status !== 0 ? (result.stderr || result.stdout || `Prisma exited with code ${result.status}`) : undefined
    };
}

module.exports = {
    translateDbError,
    ensureDatabaseExists,
    runPrismaCommand
};
