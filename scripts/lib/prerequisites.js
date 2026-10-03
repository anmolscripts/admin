'use strict';

const net = require('node:net');
const { spawnSync } = require('node:child_process');

const REQUIRED_NODE_MAJOR = 24;
const REQUIRED_NPM_MAJOR = 10;

/**
 * Validates the current Node.js runtime version.
 * @returns {{ ok: boolean, version: string, message: string }}
 */
function checkNodeVersion() {
    const versionStr = process.version; // e.g. 'v24.12.0'
    const major = parseInt(versionStr.replace(/^v/, '').split('.')[0], 10);

    if (isNaN(major) || major < REQUIRED_NODE_MAJOR) {
        return {
            ok: false,
            version: versionStr,
            message: `Node.js version ${REQUIRED_NODE_MAJOR}.x or higher is required. Detected: ${versionStr}.`
        };
    }

    return {
        ok: true,
        version: versionStr,
        message: `Node.js ${versionStr} (satisfies >=${REQUIRED_NODE_MAJOR}.0.0)`
    };
}

/**
 * Validates npm availability and version.
 * @returns {{ ok: boolean, version: string, message: string }}
 */
function checkNpmVersion() {
    const isWin = process.platform === 'win32';
    const npmCmd = isWin ? 'npm.cmd' : 'npm';

    const result = spawnSync(`${npmCmd} --version`, {
        encoding: 'utf8',
        shell: true
    });

    if (result.error || result.status !== 0) {
        return {
            ok: false,
            version: 'N/A',
            message: `npm is not installed or not available in the system PATH.`
        };
    }

    const versionStr = (result.stdout || '').trim();
    const major = parseInt(versionStr.split('.')[0], 10);

    if (isNaN(major) || major < REQUIRED_NPM_MAJOR) {
        return {
            ok: false,
            version: versionStr,
            message: `npm version ${REQUIRED_NPM_MAJOR}.x or higher is required. Detected: ${versionStr}.`
        };
    }

    return {
        ok: true,
        version: versionStr,
        message: `npm ${versionStr} (satisfies >=${REQUIRED_NPM_MAJOR}.0.0)`
    };
}

/**
 * Checks TCP network connectivity to MySQL server on host:port.
 * Uses Node.js built-in 'net' module (zero external dependencies).
 *
 * @param {string} [host='localhost']
 * @param {number} [port=3306]
 * @param {number} [timeoutMs=4000]
 * @returns {Promise<{ ok: boolean, message: string, code?: string }>}
 */
function checkMySqlTcpConnectivity(host = 'localhost', port = 3306, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const targetHost = (host === 'localhost') ? '127.0.0.1' : host;
        const targetPort = Number(port) || 3306;

        const socket = new net.Socket();
        let settled = false;

        socket.setTimeout(timeoutMs);

        socket.on('connect', () => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve({
                    ok: true,
                    message: `MySQL port open and reachable at ${host}:${targetPort}.`
                });
            }
        });

        socket.on('timeout', () => {
            if (!settled) {
                settled = true;
                socket.destroy();
                resolve({
                    ok: false,
                    code: 'ETIMEDOUT',
                    message: `Connection to MySQL at ${host}:${targetPort} timed out after ${timeoutMs}ms. Verify host and firewall settings.`
                });
            }
        });

        socket.on('error', (err) => {
            if (!settled) {
                settled = true;
                socket.destroy();
                const code = err.code || 'UNKNOWN';
                let message = `Cannot connect to MySQL at ${host}:${targetPort}. Please verify that MySQL Server is running.`;
                if (code === 'ECONNREFUSED') {
                    message = `Cannot connect to MySQL at ${host}:${targetPort} (connection refused). Verify that MySQL service is started.`;
                } else if (code === 'ENOTFOUND') {
                    message = `Cannot resolve MySQL host '${host}'. Verify your network configuration.`;
                }
                resolve({
                    ok: false,
                    code,
                    message
                });
            }
        });

        socket.connect(targetPort, targetHost);
    });
}

module.exports = {
    REQUIRED_NODE_MAJOR,
    REQUIRED_NPM_MAJOR,
    checkNodeVersion,
    checkNpmVersion,
    checkMySqlTcpConnectivity
};
