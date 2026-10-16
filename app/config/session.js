'use strict';

const session = require('express-session');
const PrismaSessionStore = require('./sessionStore');

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
    secure: isProduction ? 'auto' : false,
    sameSite: 'lax',
    maxAge: maxAgeMs,
    path: '/'
};

// Resolve session store
let sessionStore = null;
const configuredStoreType = (process.env.SESSION_STORE || '').trim().toLowerCase();

if (isProduction) {
    if (configuredStoreType === 'memory') {
        throw new Error('FATAL: In-memory session store (MemoryStore) is strictly prohibited in production. Configure a persistent store such as SESSION_STORE=database.');
    }
    // Default to persistent database store in production
    sessionStore = new PrismaSessionStore({ defaultMaxAgeMs: maxAgeMs });
} else {
    // Development / Test
    if (configuredStoreType === 'database' || configuredStoreType === 'mysql' || configuredStoreType === 'mariadb') {
        sessionStore = new PrismaSessionStore({ defaultMaxAgeMs: maxAgeMs });
    } else {
        // Memory store allowed in dev/test for lightweight local runner
        sessionStore = new session.MemoryStore();
    }
}

const sessionConfig = {
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret || 'spark-admin-dev-secret-key-change-in-prod-32chars',
    resave: false,
    saveUninitialized: false,
    cookie: cookieOptions,
    store: sessionStore
};

const sessionMiddleware = session(sessionConfig);

module.exports = {
    sessionMiddleware,
    sessionConfig,
    sessionStore,
    SESSION_COOKIE_NAME,
    cookieOptions
};
