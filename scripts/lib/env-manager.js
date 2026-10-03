'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');

/**
 * Generates a cryptographically strong 64-character hexadecimal session secret.
 * @returns {string}
 */
function generateSessionSecret() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Generates a secure random password for development admin provisioning.
 * @param {number} [length=16]
 * @returns {string}
 */
function generateRandomPassword(length = 16) {
    return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

/**
 * Prompts user for input via readline interface.
 * If fallback is given and user hits enter, returns fallback.
 *
 * @param {readline.Interface} rl
 * @param {string} promptText
 * @param {string} [defaultValue='']
 * @param {boolean} [isMasked=false]
 * @returns {Promise<string>}
 */
function askQuestion(rl, promptText, defaultValue = '', isMasked = false) {
    return new Promise((resolve) => {
        const displayPrompt = defaultValue ? `${promptText} [${defaultValue}]: ` : `${promptText}: `;

        if (isMasked && process.stdin.isTTY) {
            // Mask password typing
            process.stdout.write(displayPrompt);
            let input = '';

            const onData = (char) => {
                const str = char.toString('utf8');
                switch (str) {
                    case '\n':
                    case '\r':
                    case '\u0004':
                        process.stdin.removeListener('data', onData);
                        process.stdin.setRawMode(false);
                        console.log();
                        resolve(input || defaultValue);
                        break;
                    case '\u0003': // Ctrl+C
                        process.stdin.setRawMode(false);
                        process.exit(1);
                        break;
                    case '\u0008':
                    case '\x7f': // Backspace
                        if (input.length > 0) {
                            input = input.slice(0, -1);
                            process.stdout.write('\b \b');
                        }
                        break;
                    default:
                        input += str;
                        process.stdout.write('*');
                        break;
                }
            };

            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', onData);
        } else {
            rl.question(displayPrompt, (answer) => {
                const trimmed = answer.trim();
                resolve(trimmed || defaultValue);
            });
        }
    });
}

/**
 * Parses a simple .env file into key-value pairs without third-party libraries.
 * @param {string} filePath
 * @returns {Record<string, string>}
 */
function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const result = {};
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        // Remove enclosing quotes if any
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        result[key] = val;
    }

    return result;
}

/**
 * Collects configuration parameters interactively or from environment/defaults.
 *
 * @param {Object} opts
 * @param {'development'|'production'} opts.mode
 * @param {boolean} [opts.isInteractive=true]
 * @param {boolean} [opts.overwriteEnv=false]
 * @param {Object} [opts.cliArgs={}]
 * @param {string} [opts.rootPath]
 * @returns {Promise<{ config: Record<string, string>, adminCredentials: { email: string, password?: string }, envWritten: boolean }>}
 */
async function collectConfiguration(opts) {
    const rootPath = opts.rootPath || process.cwd();
    const envPath = path.join(rootPath, '.env');
    const existingEnv = fs.existsSync(envPath) ? parseEnvFile(envPath) : {};
    const isProduction = opts.mode === 'production';
    const isInteractive = opts.isInteractive && process.stdin.isTTY;

    const cliArgs = opts.cliArgs || {};
    let shouldWriteEnv = true;

    let rl = null;
    if (isInteractive) {
        rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
    }

    try {
        // If .env exists, ask confirmation to overwrite
        if (fs.existsSync(envPath) && !opts.overwriteEnv) {
            if (isInteractive) {
                const answer = await askQuestion(rl, 'Existing .env file detected. Keep existing configuration? (Y/n)', 'Y');
                if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
                    shouldWriteEnv = false;
                }
            } else {
                // Non-interactive: keep existing .env by default
                shouldWriteEnv = false;
            }
        }

        // Determine DB Host
        const dbHost = cliArgs['db-host']
            || process.env.DATABASE_HOST
            || existingEnv.DATABASE_HOST
            || (isInteractive ? await askQuestion(rl, 'Database Host', 'localhost') : 'localhost');

        // Determine DB Port
        const dbPort = cliArgs['db-port']
            || process.env.DATABASE_PORT
            || existingEnv.DATABASE_PORT
            || (isInteractive ? await askQuestion(rl, 'Database Port', '3306') : '3306');

        // Determine DB User
        const defaultUser = isProduction ? 'spark_app_user' : 'root';
        const dbUser = cliArgs['db-user']
            || process.env.DATABASE_USER
            || existingEnv.DATABASE_USER
            || (isInteractive ? await askQuestion(rl, 'Database User', defaultUser) : defaultUser);

        // Determine DB Password
        let dbPassword = cliArgs['db-password']
            || (process.env.DATABASE_PASSWORD !== undefined ? process.env.DATABASE_PASSWORD : undefined)
            || (existingEnv.DATABASE_PASSWORD !== undefined ? existingEnv.DATABASE_PASSWORD : undefined);

        if (dbPassword === undefined) {
            if (isInteractive) {
                dbPassword = await askQuestion(rl, 'Database Password', '', true);
            } else {
                dbPassword = '';
            }
        }

        // Determine DB Name
        const defaultDbName = isProduction ? 'spark_admin_prod' : 'admin';
        const dbName = cliArgs['db-name']
            || process.env.DATABASE_NAME
            || existingEnv.DATABASE_NAME
            || (isInteractive ? await askQuestion(rl, 'Database Name', defaultDbName) : defaultDbName);

        // Construct DATABASE_URL
        const encodedUser = encodeURIComponent(dbUser);
        const encodedPass = encodeURIComponent(dbPassword);
        const databaseUrl = `mysql://${encodedUser}:${encodedPass}@${dbHost}:${dbPort}/${dbName}`;

        // Port & Host
        const appPort = cliArgs.port
            || process.env.PORT
            || existingEnv.PORT
            || (isInteractive ? await askQuestion(rl, 'Application Port', '3000') : '3000');

        const appHost = isProduction ? '127.0.0.1' : '0.0.0.0';
        const trustProxy = isProduction ? 'true' : 'false';

        // Session Secret
        let sessionSecret = existingEnv.SESSION_SECRET || process.env.SESSION_SECRET;
        if (!sessionSecret || sessionSecret.length < 32) {
            sessionSecret = generateSessionSecret();
        }

        // Admin Credentials
        let adminEmail = cliArgs['admin-email']
            || process.env.SEED_ADMIN_EMAIL
            || existingEnv.SEED_ADMIN_EMAIL
            || 'admin@email.com';

        let adminPassword = cliArgs['admin-password']
            || process.env.SEED_ADMIN_PASSWORD
            || existingEnv.SEED_ADMIN_PASSWORD;

        if (isProduction) {
            if (isInteractive && !adminPassword) {
                adminEmail = await askQuestion(rl, 'Initial Production Admin Email', adminEmail);
                adminPassword = await askQuestion(rl, 'Initial Production Admin Password (min 8 chars)', '', true);
                const confirmPassword = await askQuestion(rl, 'Confirm Production Admin Password', '', true);

                if (!adminPassword || adminPassword.length < 8) {
                    throw new Error('Production admin password must be at least 8 characters long.');
                }
                if (adminPassword !== confirmPassword) {
                    throw new Error('Passwords do not match.');
                }
            } else if (!adminPassword) {
                throw new Error('Production installation requires explicit admin password via --admin-password or SEED_ADMIN_PASSWORD env variable.');
            }
        } else {
            // Development mode
            if (!adminPassword) {
                if (isInteractive) {
                    const supplied = await askQuestion(rl, 'Development Admin Password (leave blank to auto-generate)', '', true);
                    adminPassword = supplied || generateRandomPassword(16);
                } else {
                    adminPassword = generateRandomPassword(16);
                }
            }
        }

        const config = {
            NODE_ENV: opts.mode,
            PORT: appPort,
            HOST: appHost,
            TRUST_PROXY: trustProxy,
            REQUEST_BODY_LIMIT: '2mb',
            SESSION_SECRET: sessionSecret,
            SESSION_COOKIE_NAME: 'spark.sid',
            SESSION_MAX_AGE_HOURS: '8',
            BCRYPT_SALT_ROUNDS: '12',
            DATABASE_HOST: dbHost,
            DATABASE_PORT: dbPort,
            DATABASE_USER: dbUser,
            DATABASE_PASSWORD: dbPassword,
            DATABASE_NAME: dbName,
            DATABASE_URL: `"${databaseUrl}"`,
            SEED_ADMIN_EMAIL: adminEmail
        };

        // Write .env if required
        if (shouldWriteEnv) {
            writeEnvFile(envPath, config);
        }

        return {
            config: {
                ...config,
                DATABASE_URL: databaseUrl
            },
            adminCredentials: {
                email: adminEmail,
                password: adminPassword
            },
            envWritten: shouldWriteEnv
        };
    } finally {
        if (rl) {
            rl.close();
        }
    }
}

/**
 * Serializes and writes configuration to a .env file securely.
 * Note: SEED_ADMIN_PASSWORD is NEVER written to .env in production!
 *
 * @param {string} filePath
 * @param {Record<string, string>} config
 */
function writeEnvFile(filePath, config) {
    const isProduction = config.NODE_ENV === 'production';
    const lines = [
        '# ==============================================================================',
        `# SPARK ADMIN - AUTOMATICALLY GENERATED ${config.NODE_ENV.toUpperCase()} CONFIGURATION`,
        `# Generated: ${new Date().toISOString()}`,
        '# ==============================================================================',
        '',
        '# Server Configuration',
        `NODE_ENV=${config.NODE_ENV}`,
        `PORT=${config.PORT}`,
        `HOST=${config.HOST}`,
        `TRUST_PROXY=${config.TRUST_PROXY}`,
        `REQUEST_BODY_LIMIT=${config.REQUEST_BODY_LIMIT || '2mb'}`,
        '',
        '# Session Configuration',
        `SESSION_SECRET=${config.SESSION_SECRET}`,
        `SESSION_COOKIE_NAME=${config.SESSION_COOKIE_NAME || 'spark.sid'}`,
        `SESSION_MAX_AGE_HOURS=${config.SESSION_MAX_AGE_HOURS || '8'}`,
        '',
        '# Security',
        `BCRYPT_SALT_ROUNDS=${config.BCRYPT_SALT_ROUNDS || '12'}`,
        '',
        '# Database Connection (MySQL 8 / MariaDB)',
        `DATABASE_HOST=${config.DATABASE_HOST}`,
        `DATABASE_PORT=${config.DATABASE_PORT}`,
        `DATABASE_USER=${config.DATABASE_USER}`,
        `DATABASE_PASSWORD=${config.DATABASE_PASSWORD}`,
        `DATABASE_NAME=${config.DATABASE_NAME}`,
        `DATABASE_URL=${config.DATABASE_URL.startsWith('"') ? config.DATABASE_URL : `"${config.DATABASE_URL}"`}`,
        '',
        '# Initial Seed Credentials',
        `SEED_ADMIN_EMAIL=${config.SEED_ADMIN_EMAIL || 'admin@email.com'}`
    ];

    if (!isProduction && config.SEED_ADMIN_PASSWORD) {
        lines.push(`SEED_ADMIN_PASSWORD=${config.SEED_ADMIN_PASSWORD}`);
    }

    lines.push('');

    fs.writeFileSync(filePath, lines.join('\n'), { mode: 0o600 });
}

module.exports = {
    generateSessionSecret,
    generateRandomPassword,
    parseEnvFile,
    collectConfiguration,
    writeEnvFile
};
