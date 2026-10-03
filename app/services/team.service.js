const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const rbacService = require('./rbac.service');

class ForbiddenError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ForbiddenError';
        this.statusCode = 403;
    }
}

/**
 * List team members with search, status, role filtering and pagination.
 */
async function listTeamMembers({
    page = 1,
    limit = 20,
    search = '',
    status = null,
    roleId = null
} = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where = {};

    if (status && status !== 'ALL') {
        where.status = status;
    }

    if (roleId && roleId !== 'ALL') {
        const rId = parseInt(roleId, 10);
        if (!isNaN(rId)) where.roleId = rId;
    }

    if (search && search.trim()) {
        const s = search.trim();
        where.OR = [
            { name: { contains: s } },
            { email: { contains: s } }
        ];
    }

    const [total, users] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
            where,
            include: {
                assignedRole: {
                    select: { id: true, name: true, isSystem: true }
                },
                invitation: {
                    select: { id: true, status: true, expiresAt: true, acceptedAt: true, createdAt: true }
                },
                _count: {
                    select: { userPermissions: true }
                }
            },
            orderBy: [{ createdAt: 'desc' }],
            skip,
            take: limitNum
        })
    ]);

    return {
        users,
        pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            pages: Math.ceil(total / limitNum) || 1
        }
    };
}

/**
 * Get detailed team member profile by ID with effective permissions and activity history.
 */
async function getTeamMemberById(id) {
    const userId = parseInt(id, 10);
    if (isNaN(userId) || userId <= 0) return null;

    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            assignedRole: {
                include: {
                    rolePermissions: {
                        include: { permission: true }
                    }
                }
            },
            userPermissions: {
                include: { permission: true }
            },
            invitation: {
                include: {
                    invitedBy: {
                        select: { id: true, name: true, email: true }
                    }
                }
            }
        }
    });

    if (!user) return null;

    const effective = await rbacService.getUserEffectivePermissions(userId);
    const recentActivity = await activityService.getUserRecentActivity(userId, 15);

    return {
        user,
        effective,
        recentActivity
    };
}

/**
 * Check if a user is the last active OWNER in the system.
 */
async function isLastActiveOwner(userId) {
    const targetUserId = parseInt(userId, 10);
    const ownerRole = await prisma.role.findUnique({ where: { name: 'OWNER' } });
    if (!ownerRole) return false;

    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!targetUser || targetUser.roleId !== ownerRole.id || targetUser.status !== 'ACTIVE') return false;

    const otherActiveOwnersCount = await prisma.user.count({
        where: {
            roleId: ownerRole.id,
            status: 'ACTIVE',
            id: { not: targetUserId }
        }
    });

    return otherActiveOwnersCount === 0;
}

/**
 * Check if a user is the last active administrator with TEAM.MANAGE permissions.
 */
async function isLastActiveAdministrator(userId) {
    const targetUserId = parseInt(userId, 10);
    const activeUsers = await prisma.user.findMany({
        where: { status: 'ACTIVE', active: true },
        select: { id: true }
    });

    let adminCount = 0;
    let targetIsAdmin = false;

    for (const u of activeUsers) {
        const perms = await rbacService.getUserEffectivePermissions(u.id);
        if (perms.hasPermission('TEAM', 'MANAGE') || perms.isOwner) {
            adminCount++;
            if (u.id === targetUserId) {
                targetIsAdmin = true;
            }
        }
    }

    return targetIsAdmin && adminCount <= 1;
}

/**
 * Update team member profile, role, status, and custom permissions.
 * Enforces:
 * 1. Self-modification protections (cannot change own role/permissions/status).
 * 2. Actor/Target hierarchy (Owner > Admin > Staff/Viewer).
 * 3. Delegated permissions boundary (cannot grant permissions actor lacks).
 * 4. Last Owner & Last Administrator protections.
 * 5. Semantic, atomic audit logging (ASSIGN_ROLE, CHANGE_PERMISSIONS, etc.).
 */
async function updateTeamMember(adminUserId, targetUserId, {
    name,
    roleId,
    status,
    permissionIds = null
}, meta = {}) {
    const id = parseInt(targetUserId, 10);
    if (isNaN(id) || id <= 0) throw new Error('Invalid user ID.');

    const existingUser = await prisma.user.findUnique({
        where: { id },
        include: {
            assignedRole: {
                include: {
                    rolePermissions: { include: { permission: true } }
                }
            },
            userPermissions: { include: { permission: true } }
        }
    });
    if (!existingUser) throw new Error('Team member not found.');

    const targetRoleName = existingUser.assignedRole ? existingUser.assignedRole.name : existingUser.role;
    const isTargetOwner = targetRoleName === 'OWNER';
    const isTargetAdmin = targetRoleName === 'ADMIN';

    let actorId = null;
    let actorPerms = null;
    let isSelf = false;

    if (adminUserId) {
        actorId = parseInt(adminUserId, 10);
        isSelf = actorId === id;
        actorPerms = await rbacService.getUserEffectivePermissions(actorId);
    }

    const newRoleId = roleId ? parseInt(roleId, 10) : existingUser.roleId;
    const roleChanging = newRoleId !== existingUser.roleId;
    const permissionsChanging = permissionIds !== null;
    const statusChanging = status && status !== existingUser.status;

    // -------------------------------------------------------------------------
    // 1. SELF-MODIFICATION PROTECTIONS
    // -------------------------------------------------------------------------
    if (isSelf) {
        if (roleChanging) {
            throw new ForbiddenError('Users cannot modify their own role.');
        }
        if (permissionsChanging) {
            throw new ForbiddenError('Users cannot modify their own permissions.');
        }
        if (status && status === 'INACTIVE') {
            throw new ForbiddenError('You cannot deactivate your own account.');
        }
    }

    // -------------------------------------------------------------------------
    // 2. ACTOR VS TARGET HIERARCHY CHECKS
    // -------------------------------------------------------------------------
    if (actorPerms && !actorPerms.isOwner) {
        // Non-owner cannot manage or modify an OWNER
        if (isTargetOwner) {
            throw new ForbiddenError('Forbidden: Only an OWNER can modify or manage another OWNER.');
        }

        // Non-owner and non-admin cannot manage an ADMIN
        if (isTargetAdmin && actorPerms.roleName !== 'ADMIN') {
            throw new ForbiddenError('Forbidden: Cannot modify an administrator.');
        }

        // Check target role assignment authority
        if (roleChanging) {
            const targetRole = await prisma.role.findUnique({
                where: { id: newRoleId },
                include: {
                    rolePermissions: { include: { permission: true } }
                }
            });
            if (!targetRole) throw new Error('Selected role does not exist.');

            // Only OWNER can assign OWNER role
            if (targetRole.name === 'OWNER') {
                throw new ForbiddenError('Forbidden: Only an OWNER can assign the OWNER role.');
            }

            // Only OWNER or ADMIN can assign ADMIN role
            if (targetRole.name === 'ADMIN' && actorPerms.roleName !== 'ADMIN') {
                throw new ForbiddenError('Forbidden: Only an OWNER or ADMIN can assign the ADMIN role.');
            }

            // Delegation check on role permissions: actor must possess all permissions of the role being assigned
            for (const rp of (targetRole.rolePermissions || [])) {
                if (rp.permission && !actorPerms.hasPermission(rp.permission.module, rp.permission.action)) {
                    throw new ForbiddenError(
                        `Forbidden: Cannot assign role containing permissions you do not possess (${rp.permission.module}:${rp.permission.action}).`
                    );
                }
            }
        }

        // Delegation check on custom permissions: actor must possess all permissions being granted
        if (permissionsChanging && Array.isArray(permissionIds) && permissionIds.length > 0) {
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

    // -------------------------------------------------------------------------
    // 3. LAST OWNER & LAST ADMINISTRATOR PROTECTIONS
    // -------------------------------------------------------------------------
    if (isTargetOwner) {
        if (roleChanging && (await isLastActiveOwner(id))) {
            throw new ForbiddenError('Cannot change role of the final active OWNER. Assign another active OWNER first.');
        }
        if (status === 'INACTIVE' && (await isLastActiveOwner(id))) {
            throw new ForbiddenError('Cannot deactivate the final active OWNER in the system.');
        }
    }

    // Check if target is last active administrator with TEAM.MANAGE
    if (status === 'INACTIVE' && (await isLastActiveAdministrator(id))) {
        throw new ForbiddenError('Cannot deactivate the final active administrator with TEAM.MANAGE privileges.');
    }

    if ((roleChanging || permissionsChanging) && (await isLastActiveAdministrator(id))) {
        // Simulate resulting permissions to ensure TEAM.MANAGE is not lost
        const previewPermIds = permissionsChanging
            ? permissionIds.map(Number)
            : existingUser.userPermissions.map(up => up.permissionId);
        const sim = await rbacService.computeEffectiveAccessMatrix(newRoleId, previewPermIds);
        if (!sim.matrix.TEAM?.MANAGE && !sim.isOwner) {
            throw new ForbiddenError('Cannot remove TEAM.MANAGE privileges from the final active administrator.');
        }
    }

    // Capture old effective permissions for audit logging
    const oldEffective = await rbacService.getUserEffectivePermissions(id);

    // -------------------------------------------------------------------------
    // 4. ATOMIC EXECUTION & SEMANTIC AUDIT LOGGING
    // -------------------------------------------------------------------------
    let roleRecord = null;
    if (roleChanging) {
        roleRecord = await prisma.role.findUnique({ where: { id: newRoleId } });
        if (!roleRecord) throw new Error('Selected role does not exist.');
    }

    const updated = await prisma.$transaction(async (tx) => {
        const updateData = {};
        if (name && name.trim()) updateData.name = name.trim();
        if (roleChanging && roleRecord) {
            updateData.roleId = roleRecord.id;
            updateData.role = roleRecord.name;
        }
        if (status) {
            updateData.status = status;
            updateData.active = status === 'ACTIVE';
        }

        const user = await tx.user.update({
            where: { id },
            data: updateData
        });

        // Update custom permissions if provided
        if (permissionsChanging && Array.isArray(permissionIds)) {
            await tx.userPermission.deleteMany({ where: { userId: id } });

            const uniquePermIds = Array.from(new Set(permissionIds.map(p => parseInt(p, 10)).filter(p => !isNaN(p))));
            if (uniquePermIds.length > 0) {
                await tx.userPermission.createMany({
                    data: uniquePermIds.map(pId => ({
                        userId: id,
                        permissionId: pId
                    }))
                });
            }
        }

        // Operational Semantic Audit Logging inside transaction
        if (roleChanging && roleRecord) {
            await activityService.log({
                actorUserId: adminUserId,
                action: 'ASSIGN_ROLE',
                module: 'TEAM',
                targetType: 'USER',
                targetId: id,
                targetReference: user.email,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent,
                metadata: {
                    oldRole: targetRoleName,
                    newRole: roleRecord.name,
                    oldRoleId: existingUser.roleId,
                    newRoleId: roleRecord.id
                }
            }, tx);
        }

        if (permissionsChanging) {
            const newPerms = await tx.userPermission.findMany({
                where: { userId: id },
                include: { permission: true }
            });
            const changedKeys = newPerms.map(p => `${p.permission.module}:${p.permission.action}`);
            await activityService.log({
                actorUserId: adminUserId,
                action: 'CHANGE_PERMISSIONS',
                module: 'TEAM',
                targetType: 'USER',
                targetId: id,
                targetReference: user.email,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent,
                metadata: {
                    changedPermissions: changedKeys,
                    previousEffectivePermissions: oldEffective.permissionKeys
                }
            }, tx);
        }

        if (statusChanging) {
            await activityService.log({
                actorUserId: adminUserId,
                action: status === 'ACTIVE' ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
                module: 'TEAM',
                targetType: 'USER',
                targetId: id,
                targetReference: user.email,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent
            }, tx);
        }

        if (!roleChanging && !permissionsChanging && !statusChanging && name && name.trim() !== existingUser.name) {
            await activityService.log({
                actorUserId: adminUserId,
                action: 'EDIT_USER',
                module: 'TEAM',
                targetType: 'USER',
                targetId: id,
                targetReference: user.email,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent,
                metadata: { updatedFields: { name } }
            }, tx);
        }

        return user;
    });

    rbacService.invalidateUser(id);
    return updated;
}

/**
 * Toggle user active/inactive status with Last-Owner and Last-Administrator protection.
 */
async function toggleUserStatus(adminUserId, targetUserId, newStatus, meta = {}) {
    const id = parseInt(targetUserId, 10);
    if (isNaN(id) || id <= 0) throw new Error('Invalid user ID.');

    const user = await prisma.user.findUnique({
        where: { id },
        include: { assignedRole: true }
    });
    if (!user) throw new Error('User not found.');

    const targetStatus = newStatus === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
    const targetRoleName = user.assignedRole ? user.assignedRole.name : user.role;

    // Self deactivation check
    if (adminUserId && Number(adminUserId) === id && targetStatus === 'INACTIVE') {
        throw new ForbiddenError('You cannot deactivate your own account.');
    }

    // Hierarchy check
    if (adminUserId) {
        const actorPerms = await rbacService.getUserEffectivePermissions(adminUserId);
        if (!actorPerms.isOwner) {
            if (targetRoleName === 'OWNER') {
                throw new ForbiddenError('Forbidden: Only an OWNER can modify another OWNER.');
            }
            if (targetRoleName === 'ADMIN' && actorPerms.roleName !== 'ADMIN') {
                throw new ForbiddenError('Forbidden: Cannot modify an administrator.');
            }
        }
    }

    if (targetStatus === 'INACTIVE') {
        if (await isLastActiveOwner(id)) {
            throw new ForbiddenError('Cannot deactivate the last active OWNER in the organization.');
        }
        if (await isLastActiveAdministrator(id)) {
            throw new ForbiddenError('Cannot deactivate the final active administrator with TEAM.MANAGE privileges.');
        }
    }

    const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
            where: { id },
            data: {
                status: targetStatus,
                active: targetStatus === 'ACTIVE'
            }
        });

        await activityService.log({
            actorUserId: adminUserId,
            action: targetStatus === 'ACTIVE' ? 'ACTIVATE_USER' : 'DEACTIVATE_USER',
            module: 'TEAM',
            targetType: 'USER',
            targetId: id,
            targetReference: u.email,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent
        }, tx);

        return u;
    });

    rbacService.invalidateUser(id);
    return updated;
}

/**
 * Delete a team member or soft-deactivate if financial documents exist.
 */
async function deleteTeamMember(adminUserId, targetUserId, meta = {}) {
    const id = parseInt(targetUserId, 10);
    if (isNaN(id) || id <= 0) throw new Error('Invalid user ID.');

    const user = await prisma.user.findUnique({
        where: { id },
        include: { assignedRole: true }
    });
    if (!user) throw new Error('User not found.');

    const targetRoleName = user.assignedRole ? user.assignedRole.name : user.role;

    if (adminUserId && Number(adminUserId) === id) {
        throw new ForbiddenError('You cannot delete your own account.');
    }

    // Hierarchy check
    if (adminUserId) {
        const actorPerms = await rbacService.getUserEffectivePermissions(adminUserId);
        if (!actorPerms.isOwner) {
            if (targetRoleName === 'OWNER') {
                throw new ForbiddenError('Forbidden: Only an OWNER can delete another OWNER.');
            }
            if (targetRoleName === 'ADMIN' && actorPerms.roleName !== 'ADMIN') {
                throw new ForbiddenError('Forbidden: Cannot delete an administrator.');
            }
        }
    }

    if (await isLastActiveOwner(id)) {
        throw new ForbiddenError('Cannot delete the last active OWNER in the organization.');
    }

    if (await isLastActiveAdministrator(id)) {
        throw new ForbiddenError('Cannot delete the final active administrator with TEAM.MANAGE privileges.');
    }

    // Check financial audit trail links
    const [invoicesCount, revisionsCount, paymentsCount] = await Promise.all([
        prisma.invoice.count({ where: { createdById: id } }),
        prisma.invoiceRevision.count({ where: { changedById: id } }),
        prisma.payment.count({ where: { createdById: id } })
    ]);

    if (invoicesCount > 0 || revisionsCount > 0 || paymentsCount > 0) {
        await prisma.$transaction(async (tx) => {
            await tx.user.update({
                where: { id },
                data: { status: 'INACTIVE', active: false }
            });

            await activityService.log({
                actorUserId: adminUserId,
                action: 'DEACTIVATE_USER',
                module: 'TEAM',
                targetType: 'USER',
                targetId: id,
                targetReference: user.email,
                ipAddress: meta.ipAddress,
                userAgent: meta.userAgent,
                metadata: { note: 'Deactivated instead of deleted due to historical documents' }
            }, tx);
        });

        rbacService.invalidateUser(id);
        return { softDeactivated: true, message: 'User has historical financial records. Account was deactivated instead of deleted to protect audit history.' };
    }

    await prisma.$transaction(async (tx) => {
        await tx.invitation.deleteMany({ where: { userId: id } });
        await tx.userPermission.deleteMany({ where: { userId: id } });
        await tx.user.delete({ where: { id } });

        await activityService.log({
            actorUserId: adminUserId,
            action: 'DELETE_USER',
            module: 'TEAM',
            targetType: 'USER',
            targetId: id,
            targetReference: user.email,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent
        }, tx);
    });

    rbacService.invalidateUser(id);
    return { deleted: true };
}

module.exports = {
    ForbiddenError,
    listTeamMembers,
    getTeamMemberById,
    updateTeamMember,
    toggleUserStatus,
    deleteTeamMember,
    isLastActiveOwner,
    isLastActiveAdministrator
};
