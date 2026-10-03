const crypto = require('crypto');
const bcrypt = require('bcrypt');
const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const rbacService = require('./rbac.service');

const DEFAULT_SALT_ROUNDS = 12;
const INVITATION_EXPIRY_DAYS = 7;

class ForbiddenError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ForbiddenError';
        this.statusCode = 403;
    }
}

function getSaltRounds() {
    const rounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10);
    return Number.isInteger(rounds) && rounds >= 10 ? rounds : DEFAULT_SALT_ROUNDS;
}

function hashToken(rawToken) {
    return crypto.createHash('sha256').update(String(rawToken).trim()).digest('hex');
}

function generateSecureToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate password complexity:
 * Min 8 chars, at least 1 uppercase, 1 lowercase, 1 number.
 */
function validatePasswordComplexity(password) {
    if (!password || typeof password !== 'string') {
        return { valid: false, message: 'Password is required.' };
    }
    if (password.length < 8) {
        return { valid: false, message: 'Password must be at least 8 characters long.' };
    }
    if (!/[A-Z]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one uppercase letter.' };
    }
    if (!/[a-z]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one lowercase letter.' };
    }
    if (!/[0-9]/.test(password)) {
        return { valid: false, message: 'Password must contain at least one number.' };
    }
    return { valid: true };
}

/**
 * Create a team member and send/generate a secure invitation token.
 * Enforces hierarchy, delegation authority, and records CREATE_USER + INVITATION_CREATED atomically.
 */
async function createInvitation(adminUserId, { name, email, roleId, permissionIds = [] }, meta = {}) {
    if (!name || !name.trim()) {
        throw new Error('Team member name is required.');
    }
    if (!email || !email.trim()) {
        throw new Error('Team member email is required.');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
        throw new Error('Invalid email address format.');
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
        where: { email: normalizedEmail }
    });
    if (existingUser) {
        throw new Error(`A user with email "${normalizedEmail}" already exists.`);
    }

    // Check role exists
    const parsedRoleId = parseInt(roleId, 10);
    if (isNaN(parsedRoleId) || parsedRoleId <= 0) {
        throw new Error('A valid role is required.');
    }
    const role = await prisma.role.findUnique({
        where: { id: parsedRoleId },
        include: {
            rolePermissions: { include: { permission: true } }
        }
    });
    if (!role) {
        throw new Error(`Role with ID ${parsedRoleId} not found.`);
    }

    // -------------------------------------------------------------------------
    // HIERARCHY & DELEGATION VALIDATION
    // -------------------------------------------------------------------------
    if (adminUserId) {
        const actorPerms = await rbacService.getUserEffectivePermissions(adminUserId);
        if (!actorPerms.isOwner) {
            // Only OWNER can assign OWNER role
            if (role.name === 'OWNER') {
                throw new ForbiddenError('Forbidden: Only an OWNER can create a user with the OWNER role.');
            }

            // Only OWNER or ADMIN can assign ADMIN role
            if (role.name === 'ADMIN' && actorPerms.roleName !== 'ADMIN') {
                throw new ForbiddenError('Forbidden: Only an OWNER or ADMIN can create a user with the ADMIN role.');
            }

            // Role permissions delegation check
            for (const rp of (role.rolePermissions || [])) {
                if (rp.permission && !actorPerms.hasPermission(rp.permission.module, rp.permission.action)) {
                    throw new ForbiddenError(
                        `Forbidden: Cannot create a user with permissions you do not possess (${rp.permission.module}:${rp.permission.action}).`
                    );
                }
            }

            // Custom permissions delegation check
            if (Array.isArray(permissionIds) && permissionIds.length > 0) {
                const requestedPermIds = permissionIds.map(p => parseInt(p, 10)).filter(p => !isNaN(p));
                const requestedPerms = await prisma.permission.findMany({
                    where: { id: { in: requestedPermIds } }
                });
                for (const p of requestedPerms) {
                    if (!actorPerms.hasPermission(p.module, p.action)) {
                        throw new ForbiddenError(
                            `Forbidden: Cannot grant permission ${p.module}:${p.action} that you do not possess.`
                        );
                    }
                }
            }
        }
    }

    // Generate high-entropy secure token
    const rawToken = generateSecureToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Dummy password hash for placeholder authentication rejection until password setup
    const dummyPasswordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), getSaltRounds());

    // Execute in transaction
    const result = await prisma.$transaction(async (tx) => {
        // 1. Create User in INVITED status
        const newUser = await tx.user.create({
            data: {
                name: name.trim(),
                email: normalizedEmail,
                password: dummyPasswordHash,
                role: role.name,
                roleId: role.id,
                status: 'INVITED',
                active: false // Inactive until password is set
            }
        });

        // 2. Attach custom user permissions if provided
        if (Array.isArray(permissionIds) && permissionIds.length > 0) {
            const userPerms = permissionIds.map(pId => ({
                userId: newUser.id,
                permissionId: parseInt(pId, 10)
            }));
            await tx.userPermission.createMany({
                data: userPerms,
                skipDuplicates: true
            });
        }

        // 3. Create Invitation record with token hash
        const invitation = await tx.invitation.create({
            data: {
                userId: newUser.id,
                tokenHash,
                status: 'PENDING',
                expiresAt,
                invitedById: adminUserId ? Number(adminUserId) : null
            }
        });

        // 4. Atomic Semantic Audit Events
        await activityService.log({
            actorUserId: adminUserId,
            action: 'CREATE_USER',
            module: 'TEAM',
            targetType: 'USER',
            targetId: newUser.id,
            targetReference: newUser.email,
            ipAddress: meta.ipAddress || null,
            userAgent: meta.userAgent || null,
            metadata: { assignedRole: role.name, roleId: role.id }
        }, tx);

        await activityService.log({
            actorUserId: adminUserId,
            action: 'INVITATION_CREATED',
            module: 'TEAM',
            targetType: 'USER',
            targetId: newUser.id,
            targetReference: newUser.email,
            ipAddress: meta.ipAddress || null,
            userAgent: meta.userAgent || null,
            metadata: { roleName: role.name, expiresAt }
        }, tx);

        return { user: newUser, invitation };
    });

    rbacService.invalidateUser(result.user.id);

    return {
        user: result.user,
        invitation: result.invitation,
        rawToken // Returned only once for immediate presentation/copying
    };
}

/**
 * Validate and inspect an invitation token.
 */
async function getInvitationByToken(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
        return { valid: false, reason: 'TOKEN_MISSING' };
    }

    const tokenHash = hashToken(rawToken);

    const invitation = await prisma.invitation.findUnique({
        where: { tokenHash },
        include: {
            user: {
                select: { id: true, name: true, email: true, status: true, active: true }
            },
            invitedBy: {
                select: { id: true, name: true, email: true }
            }
        }
    });

    if (!invitation) {
        return { valid: false, reason: 'INVALID_TOKEN' };
    }

    if (invitation.status === 'ACCEPTED') {
        return { valid: false, reason: 'ALREADY_ACCEPTED', invitation, user: invitation.user };
    }

    if (invitation.status === 'REVOKED') {
        return { valid: false, reason: 'REVOKED', invitation, user: invitation.user };
    }

    if (invitation.status === 'EXPIRED' || (invitation.expiresAt && invitation.expiresAt < new Date())) {
        // Auto-expire
        if (invitation.status !== 'EXPIRED') {
            await prisma.invitation.update({
                where: { id: invitation.id },
                data: { status: 'EXPIRED' }
            });
        }
        return { valid: false, reason: 'EXPIRED', invitation, user: invitation.user };
    }

    return { valid: true, invitation, user: invitation.user };
}

/**
 * Complete invitation: validate token, set user password, activate account, mark token ACCEPTED.
 */
async function acceptInvitation(rawToken, password, ipAddress = null, userAgent = null) {
    const check = await getInvitationByToken(rawToken);
    if (!check.valid) {
        const errorMessages = {
            TOKEN_MISSING: 'Invitation token is missing.',
            INVALID_TOKEN: 'This invitation link is invalid or does not exist.',
            ALREADY_ACCEPTED: 'This invitation has already been accepted. Please log in.',
            REVOKED: 'This invitation has been revoked by an administrator.',
            EXPIRED: 'This invitation has expired. Please request a new invitation.'
        };
        throw new Error(errorMessages[check.reason] || 'Invalid invitation.');
    }

    if (!password) {
        throw new Error('Password is required.');
    }

    const complexity = validatePasswordComplexity(password);
    if (!complexity.valid) {
        throw new Error(complexity.message);
    }

    const tokenHash = hashToken(rawToken);
    const userId = check.invitation.userId;
    const passwordHash = await bcrypt.hash(password, getSaltRounds());

    await prisma.$transaction(async (tx) => {
        // 1. Activate user and set password
        await tx.user.update({
            where: { id: userId },
            data: {
                password: passwordHash,
                status: 'ACTIVE',
                active: true,
                updatedAt: new Date()
            }
        });

        // 2. Mark invitation accepted
        await tx.invitation.update({
            where: { tokenHash },
            data: {
                status: 'ACCEPTED',
                acceptedAt: new Date()
            }
        });

        // Operational audit logging inside transaction
        await activityService.log({
            actorUserId: userId,
            action: 'INVITATION_ACCEPTED',
            module: 'AUTHENTICATION',
            targetType: 'USER',
            targetId: userId,
            targetReference: check.user.email,
            ipAddress,
            userAgent
        }, tx);

        await activityService.log({
            actorUserId: userId,
            action: 'PASSWORD_SET',
            module: 'AUTHENTICATION',
            targetType: 'USER',
            targetId: userId,
            targetReference: check.user.email,
            ipAddress,
            userAgent
        }, tx);
    });

    rbacService.invalidateUser(userId);

    return { success: true, email: check.user.email };
}

/**
 * Resend an invitation for an existing team member (generates a new token and invalidates the previous one).
 */
async function resendInvitation(adminUserId, targetUserId, meta = {}) {
    const userId = parseInt(targetUserId, 10);
    if (isNaN(userId)) throw new Error('Invalid user ID.');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { invitation: true, assignedRole: true }
    });

    if (!user) throw new Error('User not found.');
    if (user.status === 'ACTIVE' && user.invitation?.status === 'ACCEPTED') {
        throw new Error('This user has already accepted their invitation and is active.');
    }

    // Hierarchy check
    if (adminUserId) {
        const actorPerms = await rbacService.getUserEffectivePermissions(adminUserId);
        const targetRoleName = user.assignedRole ? user.assignedRole.name : user.role;
        if (!actorPerms.isOwner) {
            if (targetRoleName === 'OWNER') {
                throw new ForbiddenError('Forbidden: Only an OWNER can manage another OWNER.');
            }
            if (targetRoleName === 'ADMIN' && actorPerms.roleName !== 'ADMIN') {
                throw new ForbiddenError('Forbidden: Cannot modify an administrator.');
            }
        }
    }

    const rawToken = generateSecureToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await prisma.invitation.upsert({
        where: { userId },
        update: {
            tokenHash,
            status: 'PENDING',
            expiresAt,
            acceptedAt: null,
            revokedAt: null,
            invitedById: adminUserId ? Number(adminUserId) : null
        },
        create: {
            userId,
            tokenHash,
            status: 'PENDING',
            expiresAt,
            invitedById: adminUserId ? Number(adminUserId) : null
        }
    });

    // Ensure user is in INVITED status
    await prisma.user.update({
        where: { id: userId },
        data: { status: 'INVITED', active: false }
    });

    rbacService.invalidateUser(userId);

    await activityService.log({
        actorUserId: adminUserId,
        action: 'RESEND_INVITATION',
        module: 'TEAM',
        targetType: 'USER',
        targetId: userId,
        targetReference: user.email,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent
    });

    return {
        user,
        invitation,
        rawToken
    };
}

/**
 * Revoke an invitation.
 */
async function revokeInvitation(adminUserId, targetUserId, meta = {}) {
    const userId = parseInt(targetUserId, 10);
    if (isNaN(userId)) throw new Error('Invalid user ID.');

    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { invitation: true, assignedRole: true }
    });

    if (!user) throw new Error('User not found.');

    // Hierarchy check
    if (adminUserId) {
        const actorPerms = await rbacService.getUserEffectivePermissions(adminUserId);
        const targetRoleName = user.assignedRole ? user.assignedRole.name : user.role;
        if (!actorPerms.isOwner) {
            if (targetRoleName === 'OWNER') {
                throw new ForbiddenError('Forbidden: Only an OWNER can manage another OWNER.');
            }
            if (targetRoleName === 'ADMIN' && actorPerms.roleName !== 'ADMIN') {
                throw new ForbiddenError('Forbidden: Cannot modify an administrator.');
            }
        }
    }

    if (user.invitation) {
        await prisma.invitation.update({
            where: { userId },
            data: {
                status: 'REVOKED',
                revokedAt: new Date()
            }
        });
    }

    await prisma.user.update({
        where: { id: userId },
        data: { status: 'INACTIVE', active: false }
    });

    rbacService.invalidateUser(userId);

    await activityService.log({
        actorUserId: adminUserId,
        action: 'INVITATION_REVOKED',
        module: 'TEAM',
        targetType: 'USER',
        targetId: userId,
        targetReference: user.email,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent
    });

    return { success: true };
}

module.exports = {
    ForbiddenError,
    createInvitation,
    getInvitationByToken,
    acceptInvitation,
    resendInvitation,
    revokeInvitation,
    validatePasswordComplexity,
    hashToken
};
