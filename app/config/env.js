/**
 * Production Environment Configuration & Validation
 *
 * Ensures all required environment variables are present and secure
 * before the application starts up. Fails fast with descriptive error messages
 * without ever printing secret values to console or logs.
 */

const REQUIRED_PROD_VARS = [
    'SESSION_SECRET'
];

const INSECURE_SESSION_SECRETS = [
    'replace-with-a-long-random-secret',
    'spark-admin-secret',
    'spark-admin-dev-secret-key-change-in-prod-32chars',
    'secret',
    'changeme',
    'password',
    '12345678',
    'admin'
];

/**
 * Validates the runtime environment variables.
 * @param {Object} [env=process.env] - Environment variables object
 * @throws {Error} If required production variables are missing or insecure
 * @returns {Object} Validated summary config
 */
function validateEnv(env = process.env) {
    const isProduction = env.NODE_ENV === 'production';
    const errors = [];

    // 1. Validate PORT
    if (env.PORT !== undefined && env.PORT !== '') {
        const port = Number(env.PORT);
        if (isNaN(port) || !Number.isInteger(port) || port <= 0 || port > 65535) {
            errors.push('PORT must be a valid integer between 1 and 65535.');
        }
    }

    // 2. Validate BCRYPT_SALT_ROUNDS if provided
    if (env.BCRYPT_SALT_ROUNDS !== undefined && env.BCRYPT_SALT_ROUNDS !== '') {
        const rounds = Number(env.BCRYPT_SALT_ROUNDS);
        if (isNaN(rounds) || !Number.isInteger(rounds) || rounds < 8 || rounds > 16) {
            errors.push('BCRYPT_SALT_ROUNDS must be a valid integer between 8 and 16.');
        }
    }

    // 3. Strict Production Requirements
    if (isProduction) {
        // Required environment variables check
        for (const varName of REQUIRED_PROD_VARS) {
            if (!env[varName] || env[varName].trim() === '') {
                errors.push(`Missing required environment variable: ${varName}.`);
            }
        }

        // Session secret security check
        const sessionSecret = env.SESSION_SECRET ? env.SESSION_SECRET.trim() : '';
        if (sessionSecret) {
            if (sessionSecret.length < 32) {
                errors.push('SESSION_SECRET must be at least 32 characters long for production security.');
            }
            if (INSECURE_SESSION_SECRETS.includes(sessionSecret)) {
                errors.push('SESSION_SECRET must not use insecure default placeholder values.');
            }
        }

        // Database configuration check
        const hasDbUrl = Boolean(env.DATABASE_URL && env.DATABASE_URL.trim() !== '');
        const hasGranularDb = Boolean(
            env.DATABASE_USER && env.DATABASE_USER.trim() !== '' &&
            env.DATABASE_PASSWORD !== undefined &&
            env.DATABASE_NAME && env.DATABASE_NAME.trim() !== ''
        );

        if (!hasDbUrl && !hasGranularDb) {
            errors.push('Database configuration missing: Provide DATABASE_URL or (DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME).');
        }

        if (hasDbUrl) {
            if (env.DATABASE_URL.includes('your_database_user') || env.DATABASE_URL.includes('your_database_password')) {
                errors.push('DATABASE_URL must not contain example placeholder credentials.');
            }
        }
    }

    if (errors.length > 0) {
        const formattedErrors = errors.map(e => `  - ${e}`).join('\n');
        const errorMessage = `[FATAL] Environment configuration validation failed:\n${formattedErrors}\nRefer to .env.production.example for required configuration.`;
        throw new Error(errorMessage);
    }

    return {
        isProduction,
        port: Number(env.PORT) || 3000,
        nodeEnv: env.NODE_ENV || 'development'
    };
}

module.exports = {
    validateEnv,
    REQUIRED_PROD_VARS,
    INSECURE_SESSION_SECRETS
};
