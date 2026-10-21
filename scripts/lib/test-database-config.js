'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseEnvFile } = require('./env-manager');

const PROTECTED_DATABASES = new Set([
    'admin',
    'spark_admin',
    'spark_admin_test',
    'spark_admin_prod',
    'spark_admin_prod_test'
]);

function resolveTestDatabaseConfig(values = {}) {
    let urlConfig = {};
    if (values.DATABASE_URL) {
        let parsed;
        try {
            parsed = new URL(values.DATABASE_URL);
        } catch (_) {
            throw new Error('The test DATABASE_URL is invalid.');
        }
        urlConfig = {
            host: parsed.hostname,
            port: parsed.port || '3306',
            user: decodeURIComponent(parsed.username),
            password: decodeURIComponent(parsed.password),
            database: decodeURIComponent(parsed.pathname.replace(/^\//, ''))
        };
    }

    const config = {
        host: values.DATABASE_HOST || urlConfig.host || 'localhost',
        port: String(values.DATABASE_PORT || urlConfig.port || '3306'),
        user: values.DATABASE_USER || urlConfig.user || '',
        password: values.DATABASE_PASSWORD !== undefined ? values.DATABASE_PASSWORD : (urlConfig.password || ''),
        database: values.DATABASE_NAME || urlConfig.database || ''
    };

    if (values.DATABASE_URL && values.DATABASE_NAME && urlConfig.database !== values.DATABASE_NAME) {
        throw new Error('The test DATABASE_URL database does not match DATABASE_NAME.');
    }
    if (!config.database) {
        throw new Error('DATABASE_NAME or a database path in DATABASE_URL is required in .env.test.');
    }
    if (PROTECTED_DATABASES.has(config.database.toLowerCase())) {
        throw new Error(`Refusing to use protected database "${config.database}" as the test database.`);
    }
    if (!config.host || !config.user) {
        throw new Error('A test database host and user are required in .env.test.');
    }

    const user = encodeURIComponent(config.user);
    const password = encodeURIComponent(config.password);
    config.databaseUrl = `mysql://${user}:${password}@${config.host}:${config.port}/${encodeURIComponent(config.database)}`;
    return config;
}

function readTestDatabaseConfig(rootPath = process.cwd()) {
    const envPath = path.join(rootPath, '.env.test');
    if (!fs.existsSync(envPath)) {
        throw new Error('Test configuration missing: .env.test file not found.');
    }
    return resolveTestDatabaseConfig(parseEnvFile(envPath));
}

function assertDisposableTestDatabase(values = process.env) {
    const config = resolveTestDatabaseConfig(values);
    if (values.NODE_ENV !== 'test' || !/^(?:ui_audit_|spark_disp_)[A-Za-z0-9_]+$/.test(config.database)) {
        throw new Error('Write-enabled regression tests require test mode and an explicitly disposable ui_audit_ or spark_disp_ database.');
    }
    return config;
}

module.exports = {
    PROTECTED_DATABASES,
    readTestDatabaseConfig,
    assertDisposableTestDatabase,
    resolveTestDatabaseConfig
};
