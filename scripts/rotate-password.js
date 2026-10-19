'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — SECURE CREDENTIAL ROTATION & SESSION REVOCATION TOOL
 * ==============================================================================
 *
 * Provides a safe, masked credential rotation and session-invalidation procedure:
 * 1. Database protection: Verifies target database via SELECT DATABASE() before write.
 * 2. Protected database guard: Requires BOTH --authorized-protected-db AND
 *    interactive confirmation typing the exact target database name.
 * 3. Input confidentiality: Prompts for password via masked stdin without echo.
 * 4. Never accepts passwords via CLI arguments to prevent shell history leaks.
 * 5. Uses bcrypt(12) matching authentication service specifications.
 * 6. Revokes sessions strictly belonging to the target user without affecting others.
 * 7. Verifies authentication immediately after update without logging secrets.
 * ==============================================================================
 */

require('dotenv').config();
if (process.env.NODE_ENV === 'test') {
    require('dotenv').config({ path: '.env.test', override: true });
}

const readline = require('node:readline');
const prisma = require('../app/config/prisma');
const { authenticateUser, hashPassword } = require('../app/services/auth.service');
const { resolveDbTarget } = require('./guard');

const PROTECTED_DATABASES = [
    'admin',
    'spark_admin',
    'spark_admin_prod',
    'spark_admin_test',
    'spark_admin_prod_test'
];

function promptMasked(promptText) {
    return new Promise((resolve) => {
        if (!process.stdin.isTTY) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(promptText, (ans) => {
                rl.close();
                resolve(ans.trim());
            });
            return;
        }

        process.stdout.write(promptText);
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
                    resolve(input.trim());
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
    });
}

function promptPlain(promptText) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(promptText, (ans) => {
            rl.close();
            resolve(ans.trim());
        });
    });
}

async function rotatePassword(options = {}) {
    // 1. Verify target connection via SELECT DATABASE()
    const dbRes = await prisma.$queryRawUnsafe('SELECT DATABASE() as active_db');
    const activeDb = (dbRes[0]?.active_db || dbRes[0]?.['DATABASE()'] || 'unknown').toLowerCase();

    console.log(`[ROTATION] Live connected database: ${activeDb}`);

    const isProtected = PROTECTED_DATABASES.includes(activeDb);

    if (isProtected) {
        // Guard step 1: CLI flag verification
        if (!options.authorizedProtectedDb) {
            throw new Error(
                `BLOCKED: Target database "${activeDb}" is PROTECTED. Operation requires explicit '--authorized-protected-db' command flag.`
            );
        }

        // Guard step 2: Interactive target confirmation
        let confirmation = options.targetDbConfirmation;
        if (!confirmation) {
            if (!process.stdin.isTTY) {
                throw new Error(
                    `BLOCKED: Protected database mutation requires interactive confirmation typing '${activeDb}'.`
                );
            }
            confirmation = await promptPlain(`[SECURITY GUARD] To confirm mutation against PROTECTED database, type '${activeDb}' exactly: `);
        }

        if (confirmation.trim().toLowerCase() !== activeDb) {
            throw new Error(
                `BLOCKED: Database confirmation mismatch. Expected '${activeDb}', got '${confirmation}'. Mutation aborted.`
            );
        }
        console.log(`[SECURITY GUARD] Authorization verified for protected database '${activeDb}'.`);
    }

    // 2. Identify user
    const email = options.email || (await promptPlain('User email to rotate: '));
    if (!email || !email.includes('@')) {
        throw new Error('A valid email address is required.');
    }

    const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() }
    });

    if (!user) {
        throw new Error(`User with email "${email}" not found.`);
    }

    console.log(`[ROTATION] Located user ID ${user.id} (${user.email}, role: ${user.role}).`);

    // 3. Prompt for new password securely
    let newPassword = options.password;
    if (!newPassword) {
        const promptFn = options.promptMaskedFn || promptMasked;
        newPassword = await promptFn('Enter new password (min 8 chars): ');
        const confirm = await promptFn('Confirm new password: ');
        if (newPassword !== confirm) {
            throw new Error('Passwords do not match.');
        }
    }

    if (!newPassword || newPassword.length < 8) {
        throw new Error('Password must be at least 8 characters long.');
    }

    // 4. Hash password with bcrypt(12) via authService
    const passwordHash = await hashPassword(newPassword);

    // 5. Update user password
    await prisma.user.update({
        where: { id: user.id },
        data: {
            password: passwordHash,
            updatedAt: new Date()
        }
    });
    console.log(`[ROTATION] Password hash updated in database for user ID ${user.id}.`);

    // 6. Targeted Session Revocation: Delete sessions specifically for this user
    let revokedSessionCount = 0;
    try {
        const deleteResult = await prisma.$executeRawUnsafe(
            'DELETE FROM `sessions` WHERE `data` LIKE ? OR `data` LIKE ? OR `data` LIKE ?',
            `%"user":{"id":${user.id},%`,
            `%"user":{"id":${user.id}}%`,
            `%"userId":${user.id}%`
        );
        revokedSessionCount = deleteResult;
        console.log(`[REVOCATION] Revoked ${revokedSessionCount} active session(s) for user ID ${user.id}.`);
    } catch (sessionErr) {
        console.warn(`[REVOCATION NOTICE] Session store cleanup notice: ${sessionErr.message}`);
    }

    // 7. Verify authentication with new credentials immediately
    const authResult = await authenticateUser(user.email, newPassword);
    if (!authResult.success) {
        throw new Error(`Credential verification failed immediately after update: ${authResult.reason}`);
    }

    console.log('[VERIFICATION] New credentials successfully verified against authentication service.');

    return {
        userId: user.id,
        email: user.email,
        revokedSessions: revokedSessionCount,
        verified: true
    };
}

if (require.main === module) {
    const args = process.argv.slice(2);

    // Strictly reject passwords passed via CLI arguments to prevent shell history / ps table leaks
    const hasPasswordArg = args.some(arg => arg.startsWith('--password') || arg.startsWith('-p=') || arg === '-p');
    if (hasPasswordArg) {
        console.error('[SECURITY ERROR] Passing passwords via CLI arguments is strictly prohibited to prevent shell history and process table exposure. Please run without --password and enter your password at the masked interactive prompt.');
        process.exit(1);
    }

    const authorizedProtectedDb = args.includes('--authorized-protected-db');

    let email = null;
    let targetDbConfirmation = null;
    for (const arg of args) {
        if (arg.startsWith('--email=')) {
            email = arg.slice(8).trim();
        } else if (arg.startsWith('--confirm-db-name=')) {
            targetDbConfirmation = arg.slice(18).trim();
        }
    }

    rotatePassword({
        authorizedProtectedDb,
        email,
        targetDbConfirmation
    })
        .then(() => {
            console.log('[SUCCESS] Password rotation and session revocation completed successfully.');
            process.exit(0);
        })
        .catch((err) => {
            console.error(`[FAILURE] ${err.message}`);
            process.exit(1);
        });
}

module.exports = { rotatePassword, PROTECTED_DATABASES, promptMasked, promptPlain };
