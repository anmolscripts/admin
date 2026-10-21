const bcrypt = require('bcrypt');
const prisma = require('../config/prisma');
const crypto = require('node:crypto');

function getCredentialVersion(user) {
    const secret = process.env.SESSION_SECRET || 'spark-admin-dev-secret-key-change-in-prod-32chars';
    return crypto.createHmac('sha256', secret).update(`credential:${user.id}:${user.password}`).digest('hex');
}

function rememberSignature(userId, expiresAt, selector, credentialVersion) {
    const secret = process.env.SESSION_SECRET || 'spark-admin-dev-secret-key-change-in-prod-32chars';
    return crypto.createHmac('sha256', secret).update(`${userId}:${expiresAt}:${selector}:${credentialVersion}`).digest('hex');
}

async function createRememberToken(userId, credentialVersion) {
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const selector = crypto.randomBytes(32).toString('hex');
    const store = require('../config/session').sessionStore;
    await new Promise((resolve, reject) => store.set(selector, { userId, credentialVersion, cookie: { expires: new Date(expiresAt) } }, error => error ? reject(error) : resolve()));
    return `${userId}.${expiresAt}.${selector}.${rememberSignature(userId, expiresAt, selector, credentialVersion)}`;
}

async function verifyRememberToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [id, expires, selector, signature] = parts;
    const userId = Number(id), expiresAt = Number(expires);
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(userId) || userId <= 0 ||
        !/^\d+$/.test(expires) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() ||
        !/^[a-f0-9]{64}$/.test(selector) || !/^[a-f0-9]{64}$/.test(signature)) return null;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || user.status === 'INACTIVE') return null;
    const credentialVersion = getCredentialVersion(user);
    const expected = rememberSignature(userId, expiresAt, selector, credentialVersion);
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return null;
    const store = require('../config/session').sessionStore;
    const record = await new Promise((resolve, reject) => store.get(selector, (error, value) => error ? reject(error) : resolve(value)));
    if (!record || record.userId !== userId || record.credentialVersion !== credentialVersion) return null;
    return { user: { id: user.id, name: user.name, email: user.email, role: user.role }, credentialVersion, selector };
}

async function revokeRememberToken(token) {
    const verified = await verifyRememberToken(token);
    if (verified) {
        const store = require('../config/session').sessionStore;
        await new Promise((resolve, reject) => store.destroy(verified.selector, error => error ? reject(error) : resolve()));
    }
}

const DEFAULT_SALT_ROUNDS = 12;
// Pre-computed dummy bcrypt hash to ensure constant-time response for nonexistent users
const DUMMY_HASH = '$2b$12$e8xL47r7Jz5hO6M2gI3eouW70e4708sH3u2iJ8jM7y7O/W1W9H8iq';

function getSaltRounds() {
    const rounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10);
    return Number.isInteger(rounds) && rounds >= 10 ? rounds : DEFAULT_SALT_ROUNDS;
}

/**
 * Normalise email string by trimming whitespace and converting to lowercase.
 * @param {string} email
 * @returns {string}
 */
function normalizeEmail(email) {
    if (typeof email !== 'string') return '';
    return email.trim().toLowerCase();
}

/**
 * Hash a plaintext password securely using bcrypt.
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashPassword(password) {
    if (!password || typeof password !== 'string') {
        throw new Error('Password must be a non-empty string.');
    }
    return bcrypt.hash(password, getSaltRounds());
}

/**
 * Authenticate a user with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ success: boolean, reason?: string, user?: object }>}
 */
async function authenticateUser(email, password) {
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
        return {
            success: false,
            reason: 'MISSING_CREDENTIALS'
        };
    }

    const normalizedEmail = normalizeEmail(email);

    // Find user in database
    const user = await prisma.user.findUnique({
        where: { email: normalizedEmail }
    });

    if (!user) {
        // Equalize execution time with dummy bcrypt compare to prevent timing side-channel attacks
        await bcrypt.compare(password, DUMMY_HASH);
        return {
            success: false,
            reason: 'USER_NOT_FOUND'
        };
    }

    // Inactive account check
    if (!user.active) {
        return {
            success: false,
            reason: 'USER_INACTIVE'
        };
    }

    // Compare passwords using bcrypt
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
        return {
            success: false,
            reason: 'INVALID_PASSWORD'
        };
    }

    // Return safe user object excluding password/hash
    return {
        success: true,
        credentialVersion: getCredentialVersion(user),
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role
        }
    };
}

/**
 * Find user by ID returning only safe public/session fields.
 * @param {number} id
 * @returns {Promise<object|null>}
 */
async function findUserById(id) {
    if (!id || typeof id !== 'number') return null;

    return prisma.user.findUnique({
        where: { id },
        select: {
            id: true,
            name: true,
            email: true,
            role: true,
            active: true
        }
    });
}

module.exports = {
    normalizeEmail,
    hashPassword,
    authenticateUser,
    findUserById,
    getCredentialVersion,
    createRememberToken,
    verifyRememberToken,
    revokeRememberToken
};
