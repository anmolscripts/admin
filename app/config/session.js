const session = require('express-session');

const isProduction = process.env.NODE_ENV === 'production';
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'spark.sid';

// Validate session secret
const sessionSecret = process.env.SESSION_SECRET;
if (isProduction && (!sessionSecret || sessionSecret === 'replace-with-a-long-random-secret' || sessionSecret === 'spark-admin-secret')) {
    throw new Error('FATAL: A secure SESSION_SECRET must be defined in production environment.');
}

const maxAgeMs = (Number(process.env.SESSION_MAX_AGE_HOURS) || 8) * 60 * 60 * 1000;

const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/'
};

/**
 * NOTE ON SESSION STORAGE ARCHITECTURE:
 * The default session store used here (MemoryStore) is strictly for local development
 * and single-process use.
 * 
 * IMPORTANT FOR PRODUCTION:
 * Express MemoryStore MUST be replaced before production deployment or horizontal scaling.
 * MemoryStore does not scale across multiple server processes/containers and leaks memory
 * under high load. For production environments, configure a persistent session store
 * such as Redis (`connect-redis`) or MySQL/MariaDB (`express-mysql-session`).
 */
if (isProduction && !process.env.SESSION_STORE) {
    console.warn('[SECURITY WARNING] express-session MemoryStore is active in production. It must be replaced with a persistent session store (e.g., Redis or MySQL) before production deployment or horizontal scaling.');
}

const sessionConfig = {
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret || 'spark-admin-dev-secret-key-change-in-prod-32chars',
    resave: false,
    saveUninitialized: false,
    cookie: cookieOptions
};

const sessionMiddleware = session(sessionConfig);

module.exports = {
    sessionMiddleware,
    sessionConfig,
    SESSION_COOKIE_NAME,
    cookieOptions
};
