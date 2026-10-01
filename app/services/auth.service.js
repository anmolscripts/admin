const bcrypt = require('bcrypt');
const prisma = require('../config/prisma');

const DEFAULT_SALT_ROUNDS = 12;

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
        // Constant-time mitigation against timing attacks could be considered,
        // but for now return generic credential failure
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
    findUserById
};
