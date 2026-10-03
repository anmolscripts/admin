const prisma = require('../config/prisma');

/**
 * RBAC Module Taxonomies
 */
const MODULES = [
    'DASHBOARD',
    'DOCUMENTS',
    'CLIENTS',
    'ITEMS',
    'UNITS',
    'PAYMENTS',
    'BUSINESS_PROFILE',
    'TEAM',
    'AUDIT_LOGS',
    'SETTINGS'
];

/**
 * RBAC Action Taxonomies
 */
const ACTIONS = [
    'VIEW',
    'CREATE',
    'EDIT',
    'DELETE',
    'RESTORE',
    'VOID',
    'CONVERT',
    'EXPORT',
    'PRINT',
    'MANAGE',
    'ACTIVITY_VIEW',
    'FULL_ACCESS'
];

/**
 * Allowed actions per module (matrix definition)
 */
const MODULE_ACTION_MATRIX = {
    DASHBOARD: ['VIEW', 'FULL_ACCESS'],
    DOCUMENTS: ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'RESTORE', 'VOID', 'CONVERT', 'EXPORT', 'PRINT', 'MANAGE', 'FULL_ACCESS'],
    CLIENTS: ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'MANAGE', 'FULL_ACCESS'],
    ITEMS: ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'MANAGE', 'FULL_ACCESS'],
    UNITS: ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'MANAGE', 'FULL_ACCESS'],
    PAYMENTS: ['VIEW', 'CREATE', 'EDIT', 'VOID', 'MANAGE', 'FULL_ACCESS'],
    BUSINESS_PROFILE: ['VIEW', 'EDIT', 'MANAGE', 'FULL_ACCESS'],
    TEAM: ['VIEW', 'CREATE', 'EDIT', 'DELETE', 'MANAGE', 'ACTIVITY_VIEW', 'FULL_ACCESS'],
    AUDIT_LOGS: ['VIEW', 'EXPORT', 'MANAGE', 'FULL_ACCESS'],
    SETTINGS: ['VIEW', 'EDIT', 'MANAGE', 'FULL_ACCESS']
};

/**
 * In-memory permissions cache with short TTL
 */
const permissionsCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

function invalidateUser(userId) {
    if (userId) {
        permissionsCache.delete(Number(userId));
    }
}

function invalidateAll() {
    permissionsCache.clear();
}

/**
 * Seed all standard permissions and default roles idempotently.
 */
async function seedPermissionsAndRoles() {
    // 1. Seed all valid (module, action) permissions
    const permissionUpserts = [];
    for (const [mod, actions] of Object.entries(MODULE_ACTION_MATRIX)) {
        for (const act of actions) {
            permissionUpserts.push(
                prisma.permission.upsert({
                    where: {
                        module_action: { module: mod, action: act }
                    },
                    update: {},
                    create: {
                        module: mod,
                        action: act,
                        description: `${act} permission for ${mod} module`
                    }
                })
            );
        }
    }
    await Promise.all(permissionUpserts);

    // 2. Fetch all created permissions
    const allPermissions = await prisma.permission.findMany();
    const permMap = new Map();
    for (const p of allPermissions) {
        permMap.set(`${p.module}:${p.action}`, p.id);
    }

    // 3. Define Default System Roles
    const defaultRolesConfig = [
        {
            name: 'OWNER',
            description: 'Full system authority and organization ownership',
            isSystem: true,
            permissions: allPermissions.map(p => p.id) // All permissions
        },
        {
            name: 'ADMIN',
            description: 'Administrative access to operations, team, and settings',
            isSystem: true,
            permissions: allPermissions
                .filter(p => !(p.module === 'TEAM' && ['DELETE', 'FULL_ACCESS'].includes(p.action)) && !(p.module === 'SETTINGS' && ['DELETE', 'FULL_ACCESS'].includes(p.action)))
                .map(p => p.id)
        },
        {
            name: 'MANAGER',
            description: 'Operational supervisor: documents, clients, catalog, and payments',
            isSystem: true,
            permissionKeys: [
                'DASHBOARD:VIEW',
                'DOCUMENTS:VIEW', 'DOCUMENTS:CREATE', 'DOCUMENTS:EDIT', 'DOCUMENTS:PRINT', 'DOCUMENTS:CONVERT', 'DOCUMENTS:EXPORT',
                'CLIENTS:VIEW', 'CLIENTS:CREATE', 'CLIENTS:EDIT', 'CLIENTS:MANAGE',
                'ITEMS:VIEW', 'ITEMS:CREATE', 'ITEMS:EDIT', 'ITEMS:MANAGE',
                'UNITS:VIEW', 'UNITS:CREATE', 'UNITS:EDIT', 'UNITS:MANAGE',
                'PAYMENTS:VIEW', 'PAYMENTS:CREATE', 'PAYMENTS:EDIT',
                'AUDIT_LOGS:VIEW',
                'TEAM:VIEW'
            ]
        },
        {
            name: 'MEMBER',
            description: 'Standard operational user: document and client operations',
            isSystem: true,
            permissionKeys: [
                'DASHBOARD:VIEW',
                'DOCUMENTS:VIEW', 'DOCUMENTS:CREATE', 'DOCUMENTS:EDIT', 'DOCUMENTS:PRINT', 'DOCUMENTS:CONVERT',
                'CLIENTS:VIEW', 'CLIENTS:CREATE', 'CLIENTS:EDIT',
                'ITEMS:VIEW',
                'UNITS:VIEW',
                'PAYMENTS:VIEW', 'PAYMENTS:CREATE'
            ]
        },
        {
            name: 'VIEWER',
            description: 'Read-only access across business documents and catalogs',
            isSystem: true,
            permissionKeys: [
                'DASHBOARD:VIEW',
                'DOCUMENTS:VIEW', 'DOCUMENTS:PRINT',
                'CLIENTS:VIEW',
                'ITEMS:VIEW',
                'UNITS:VIEW'
            ]
        },
        {
            name: 'STAFF',
            description: 'Commercial operations: documents, clients, and payments',
            isSystem: false,
            permissionKeys: [
                'DASHBOARD:VIEW',
                'DOCUMENTS:VIEW', 'DOCUMENTS:CREATE', 'DOCUMENTS:EDIT', 'DOCUMENTS:PRINT', 'DOCUMENTS:CONVERT',
                'CLIENTS:VIEW', 'CLIENTS:CREATE', 'CLIENTS:EDIT',
                'ITEMS:VIEW',
                'UNITS:VIEW',
                'PAYMENTS:VIEW', 'PAYMENTS:CREATE'
            ]
        }
    ];

    for (const rConfig of defaultRolesConfig) {
        const role = await prisma.role.upsert({
            where: { name: rConfig.name },
            update: {
                description: rConfig.description,
                isSystem: rConfig.isSystem
            },
            create: {
                name: rConfig.name,
                description: rConfig.description,
                isSystem: rConfig.isSystem
            }
        });

        let targetPermIds = [];
        if (rConfig.permissions) {
            targetPermIds = rConfig.permissions;
        } else if (rConfig.permissionKeys) {
            targetPermIds = rConfig.permissionKeys
                .map(key => permMap.get(key))
                .filter(Boolean);
        }

        // Link permissions to role
        if (targetPermIds.length > 0) {
            for (const permId of targetPermIds) {
                await prisma.rolePermission.upsert({
                    where: {
                        roleId_permissionId: {
                            roleId: role.id,
                            permissionId: permId
                        }
                    },
                    update: {},
                    create: {
                        roleId: role.id,
                        permissionId: permId
                    }
                });
            }

            // Prune any permissions that are no longer part of this default role
            await prisma.rolePermission.deleteMany({
                where: {
                    roleId: role.id,
                    permissionId: { notIn: targetPermIds }
                }
            });
        }
    }

    // 4. Link any existing users without a role to the OWNER role
    const ownerRole = await prisma.role.findUnique({ where: { name: 'OWNER' } });
    if (ownerRole) {
        await prisma.user.updateMany({
            where: { roleId: null },
            data: { roleId: ownerRole.id }
        });
    }

    invalidateAll();
}

/**
 * List all available permissions grouped by module.
 */
async function listPermissions() {
    return prisma.permission.findMany({
        orderBy: [{ module: 'asc' }, { action: 'asc' }]
    });
}

/**
 * List all roles with attached permissions.
 */
async function listRoles() {
    return prisma.role.findMany({
        include: {
            rolePermissions: {
                include: { permission: true }
            },
            _count: {
                select: { users: true }
            }
        },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }]
    });
}

/**
 * Get role by ID with permissions.
 */
async function getRoleById(roleId) {
    const id = parseInt(roleId, 10);
    if (isNaN(id) || id <= 0) return null;

    return prisma.role.findUnique({
        where: { id },
        include: {
            rolePermissions: {
                include: { permission: true }
            }
        }
    });
}

/**
 * Resolve effective permissions for a user.
 * Returns an object with Set of permission keys, grouped by module, and helper functions.
 */
async function getUserEffectivePermissions(userId) {
    const id = parseInt(userId, 10);
    if (isNaN(id) || id <= 0) {
        return createEmptyEffectivePermissions();
    }

    const now = Date.now();
    const cached = permissionsCache.get(id);
    if (cached && cached.expiresAt > now) {
        return cached.data;
    }

    const user = await prisma.user.findUnique({
        where: { id },
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
            }
        }
    });

    if (!user || !user.active || user.status === 'INACTIVE') {
        const emptyResult = createEmptyEffectivePermissions(user);
        permissionsCache.set(id, { expiresAt: now + CACHE_TTL_MS, data: emptyResult });
        return emptyResult;
    }

    const isOwner = user.assignedRole && user.assignedRole.name === 'OWNER';
    const permissionKeys = new Set();

    if (isOwner) {
        // Owner has absolute authority: grant all modules & actions
        for (const [mod, acts] of Object.entries(MODULE_ACTION_MATRIX)) {
            for (const act of acts) {
                permissionKeys.add(`${mod}:${act}`);
            }
        }
    } else {
        // Role permissions
        if (user.assignedRole && user.assignedRole.rolePermissions) {
            for (const rp of user.assignedRole.rolePermissions) {
                if (rp.permission) {
                    permissionKeys.add(`${rp.permission.module}:${rp.permission.action}`);
                }
            }
        }

        // Custom User-level permissions
        if (user.userPermissions) {
            for (const up of user.userPermissions) {
                if (up.permission) {
                    permissionKeys.add(`${up.permission.module}:${up.permission.action}`);
                }
            }
        }
    }

    // Expand FULL_ACCESS: if user has MODULE:FULL_ACCESS, grant all actions for MODULE
    for (const [mod, acts] of Object.entries(MODULE_ACTION_MATRIX)) {
        if (permissionKeys.has(`${mod}:FULL_ACCESS`)) {
            for (const act of acts) {
                permissionKeys.add(`${mod}:${act}`);
            }
        }
    }

    // Build structured byModule map
    const byModule = {};
    for (const mod of MODULES) {
        byModule[mod] = {};
        const allowedActions = MODULE_ACTION_MATRIX[mod] || [];
        for (const act of allowedActions) {
            byModule[mod][act] = permissionKeys.has(`${mod}:${act}`);
        }
    }

    const result = {
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        roleName: user.assignedRole ? user.assignedRole.name : user.role || 'STAFF',
        isOwner,
        permissionKeys: Array.from(permissionKeys),
        hasPermission: (mod, act) => {
            if (isOwner) return true;
            return permissionKeys.has(`${mod}:${act}`) || permissionKeys.has(`${mod}:FULL_ACCESS`);
        },
        byModule
    };

    permissionsCache.set(id, { expiresAt: now + CACHE_TTL_MS, data: result });
    return result;
}

function createEmptyEffectivePermissions(user = null) {
    return {
        userId: user ? user.id : null,
        userName: user ? user.name : 'Unknown',
        userEmail: user ? user.email : '',
        roleName: 'NONE',
        isOwner: false,
        permissionKeys: [],
        hasPermission: () => false,
        byModule: {}
    };
}

/**
 * Direct boolean check whether a user has a specific permission.
 */
async function userHasPermission(userId, moduleName, actionName) {
    const perms = await getUserEffectivePermissions(userId);
    return perms.hasPermission(moduleName, actionName);
}

/**
 * Compute real-time Effective Access Matrix preview given a roleId and optional custom permission IDs.
 * Used by the UI when editing or creating a team member.
 */
async function computeEffectiveAccessMatrix(roleId, customPermissionIds = []) {
    const id = parseInt(roleId, 10);
    const role = !isNaN(id) && id > 0 ? await getRoleById(id) : null;
    const isOwner = role && role.name === 'OWNER';

    const allPermissions = await prisma.permission.findMany();
    const permMap = new Map();
    for (const p of allPermissions) {
        permMap.set(p.id, p);
    }

    const activeKeys = new Set();

    if (isOwner) {
        for (const [mod, acts] of Object.entries(MODULE_ACTION_MATRIX)) {
            for (const act of acts) {
                activeKeys.add(`${mod}:${act}`);
            }
        }
    } else {
        if (role && role.rolePermissions) {
            for (const rp of role.rolePermissions) {
                if (rp.permission) {
                    activeKeys.add(`${rp.permission.module}:${rp.permission.action}`);
                }
            }
        }

        if (Array.isArray(customPermissionIds)) {
            for (const cId of customPermissionIds) {
                const p = permMap.get(parseInt(cId, 10));
                if (p) {
                    activeKeys.add(`${p.module}:${p.action}`);
                }
            }
        }

        // Expand FULL_ACCESS
        for (const [mod, acts] of Object.entries(MODULE_ACTION_MATRIX)) {
            if (activeKeys.has(`${mod}:FULL_ACCESS`)) {
                for (const act of acts) {
                    activeKeys.add(`${mod}:${act}`);
                }
            }
        }
    }

    const matrix = {};
    for (const mod of MODULES) {
        matrix[mod] = {};
        const actions = MODULE_ACTION_MATRIX[mod] || [];
        for (const act of actions) {
            matrix[mod][act] = isOwner || activeKeys.has(`${mod}:${act}`);
        }
    }

    return {
        roleName: role ? role.name : 'CUSTOM',
        isOwner,
        matrix
    };
}

module.exports = {
    MODULES,
    ACTIONS,
    MODULE_ACTION_MATRIX,
    seedPermissionsAndRoles,
    listPermissions,
    listRoles,
    getRoleById,
    getUserEffectivePermissions,
    userHasPermission,
    computeEffectiveAccessMatrix,
    invalidateUser,
    invalidateAll
};
