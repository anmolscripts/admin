const prisma = require('../config/prisma');

// Sensitive keys to sanitize from audit metadata
const SENSITIVE_KEYS = new Set([
    'password',
    'passwordhash',
    'token',
    'tokenhash',
    'secret',
    'cookie',
    'sessionid',
    '_csrf',
    'authorization'
]);

function sanitizeMetadata(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sanitizeMetadata);

    const clean = {};
    for (const [key, value] of Object.entries(obj)) {
        if (SENSITIVE_KEYS.has(key.toLowerCase())) {
            clean[key] = '[REDACTED]';
        } else if (value && typeof value === 'object') {
            clean[key] = sanitizeMetadata(value);
        } else {
            clean[key] = value;
        }
    }
    return clean;
}

/**
 * Log an operational activity event to the immutable append-only user activity log.
 */
async function log({
    actorUserId = null,
    action,
    module: mod,
    targetType = null,
    targetId = null,
    targetReference = null,
    ipAddress = null,
    userAgent = null,
    metadata = null
}, db = prisma) {
    if (!action || !mod) {
        console.warn('[ACTIVITY] Skipping log with missing action or module:', { action, mod });
        return null;
    }

    try {
        const cleanMetadata = metadata ? sanitizeMetadata(metadata) : null;
        const normalizedTargetId = targetId !== null && targetId !== undefined ? String(targetId) : null;
        const normalizedTargetRef = targetReference !== null && targetReference !== undefined ? String(targetReference) : null;

        const record = await db.userActivityLog.create({
            data: {
                actorUserId: actorUserId ? Number(actorUserId) : null,
                action: String(action).toUpperCase(),
                module: String(mod).toUpperCase(),
                targetType: targetType ? String(targetType).toUpperCase() : null,
                targetId: normalizedTargetId,
                targetReference: normalizedTargetRef,
                ipAddress: ipAddress ? String(ipAddress).slice(0, 45) : null,
                userAgent: userAgent ? String(userAgent).slice(0, 500) : null,
                metadata: cleanMetadata
            }
        });

        // Update actor's lastActivityAt asynchronously if actorUserId is supplied (skipped in test to prevent lock contention / unawaited handles)
        const isTestEnv = process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event === 'test' || process.argv.some(a => a.includes('test'));
        if (actorUserId && !isTestEnv) {
            prisma.user.update({
                where: { id: Number(actorUserId) },
                data: { lastActivityAt: new Date() }
            }).catch(() => {});
        }

        return record;
    } catch (err) {
        if (process.env.NODE_ENV !== 'test') {
            console.error('[ACTIVITY] Failed to record user activity log:', err.message || err);
        }
        return null;
    }
}

/**
 * Format human-readable event description.
 */
function formatEventDescription(logItem) {
    const actor = logItem.actorUser ? logItem.actorUser.name : (logItem.metadata?.actorEmail || 'System');
    const ref = logItem.targetReference || (logItem.targetId ? `#${logItem.targetId}` : '');

    switch (logItem.action) {
        case 'LOGIN': return `${actor} logged in successfully.`;
        case 'LOGOUT': return `${actor} logged out.`;
        case 'LOGIN_FAILED': return `Failed login attempt for ${logItem.targetReference || 'account'}.`;
        case 'PASSWORD_SET': return `${actor} completed password setup.`;
        case 'INVITATION_CREATED': return `${actor} invited new team member (${ref}).`;
        case 'INVITATION_ACCEPTED': return `${actor} accepted invitation and activated account.`;
        case 'INVITATION_REVOKED': return `${actor} revoked invitation for ${ref}.`;
        case 'RESEND_INVITATION': return `${actor} resent invitation to ${ref}.`;
        case 'CREATE_DOCUMENT': return `${actor} created ${logItem.targetType || 'Document'} ${ref}.`;
        case 'EDIT_DOCUMENT': return `${actor} updated ${logItem.targetType || 'Document'} ${ref}.`;
        case 'DELETE_DOCUMENT': return `${actor} soft-deleted ${logItem.targetType || 'Document'} ${ref}.`;
        case 'RESTORE_DOCUMENT': return `${actor} restored ${logItem.targetType || 'Document'} ${ref}.`;
        case 'VOID_DOCUMENT': return `${actor} voided ${logItem.targetType || 'Document'} ${ref}.`;
        case 'CONVERT_DOCUMENT': return `${actor} converted Quotation to Invoice ${ref}.`;
        case 'PRINT_DOCUMENT': return `${actor} printed ${logItem.targetType || 'Document'} ${ref}.`;
        case 'EXPORT_DOCUMENT': return `${actor} exported ${logItem.targetType || 'Document'} ${ref}.`;
        case 'VIEW_DOCUMENT': return `${actor} viewed ${logItem.targetType || 'Document'} ${ref}.`;
        case 'CREATE_CLIENT': return `${actor} created client ${ref}.`;
        case 'EDIT_CLIENT': return `${actor} updated client ${ref}.`;
        case 'DELETE_CLIENT': return `${actor} deleted client ${ref}.`;
        case 'CREATE_ITEM': return `${actor} created item ${ref}.`;
        case 'EDIT_ITEM': return `${actor} updated item ${ref}.`;
        case 'CREATE_UNIT': return `${actor} created unit ${ref}.`;
        case 'EDIT_UNIT': return `${actor} updated unit ${ref}.`;
        case 'ACTIVATE_UNIT': return `${actor} activated unit ${ref}.`;
        case 'DEACTIVATE_UNIT': return `${actor} deactivated unit ${ref}.`;
        case 'CREATE_PAYMENT': return `${actor} recorded payment for ${ref}.`;
        case 'VOID_PAYMENT': return `${actor} voided payment for ${ref}.`;
        case 'CREATE_USER': return `${actor} created team member ${ref}.`;
        case 'EDIT_USER': return `${actor} updated profile for ${ref}.`;
        case 'ACTIVATE_USER': return `${actor} activated user ${ref}.`;
        case 'DEACTIVATE_USER': return `${actor} deactivated user ${ref}.`;
        case 'ASSIGN_ROLE': return `${actor} assigned role to ${ref}.`;
        case 'CHANGE_PERMISSIONS': return `${actor} updated permissions for ${ref}.`;
        case 'PERMISSION_DENIED': return `Access denied: ${actor} attempted unauthorized ${logItem.module}:${logItem.action} on ${ref || 'resource'}.`;
        default: return `${actor} performed ${logItem.action} on ${logItem.module} ${ref}`.trim();
    }
}

/**
 * List paginated activity logs with search, user, module, action, and date filters.
 */
async function listActivities({
    page = 1,
    limit = 25,
    search = '',
    actorUserId = null,
    module: mod = null,
    action = null,
    fromDate = null,
    toDate = null,
    sortBy = null,
    sortDirection = 'desc'
} = {}) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;

    const where = {};

    if (actorUserId) {
        const uId = parseInt(actorUserId, 10);
        if (!isNaN(uId)) where.actorUserId = uId;
    }

    if (mod) {
        where.module = String(mod).toUpperCase();
    }

    if (action) {
        where.action = String(action).toUpperCase();
    }

    if (search && search.trim()) {
        const s = search.trim();
        where.OR = [
            { targetReference: { contains: s } },
            { targetId: { contains: s } },
            { action: { contains: s } },
            { module: { contains: s } },
            { actorUser: { name: { contains: s } } },
            { actorUser: { email: { contains: s } } }
        ];
    }

    if (fromDate || toDate) {
        where.createdAt = {};
        if (fromDate) {
            const d = new Date(fromDate);
            if (!isNaN(d.getTime())) where.createdAt.gte = d;
        }
        if (toDate) {
            const d = new Date(toDate);
            if (!isNaN(d.getTime())) where.createdAt.lte = d;
        }
    }

    const SORT_ALLOWLIST = {
        timestamp: 'createdAt',
        createdAt: 'createdAt',
        action: 'action',
        module: 'module',
        id: 'id'
    };

    let orderBy = { createdAt: 'desc' };
    if (sortBy && SORT_ALLOWLIST[sortBy]) {
        const field = SORT_ALLOWLIST[sortBy];
        const dir = String(sortDirection).toLowerCase() === 'asc' ? 'asc' : 'desc';
        orderBy = { [field]: dir };
    }

    const [total, items] = await Promise.all([
        prisma.userActivityLog.count({ where }),
        prisma.userActivityLog.findMany({
            where,
            include: {
                actorUser: {
                    select: { id: true, name: true, email: true, role: true }
                }
            },
            orderBy,
            skip,
            take: limitNum
        })
    ]);

    const formattedItems = items.map(item => ({
        ...item,
        description: formatEventDescription(item)
    }));

    return {
        items: formattedItems,
        pagination: {
            total,
            page: pageNum,
            limit: limitNum,
            pages: Math.ceil(total / limitNum) || 1
        }
    };
}

/**
 * Get recent activity for a specific user.
 */
async function getUserRecentActivity(userId, limit = 10) {
    const id = parseInt(userId, 10);
    if (isNaN(id)) return [];

    const items = await prisma.userActivityLog.findMany({
        where: { actorUserId: id },
        include: {
            actorUser: {
                select: { id: true, name: true, email: true }
            }
        },
        orderBy: { createdAt: 'desc' },
        take: limit
    });

    return items.map(item => ({
        ...item,
        description: formatEventDescription(item)
    }));
}

/**
 * Calculate date range boundaries based on presets: today, this_week, this_month, this_quarter, this_year, custom.
 */
function resolveDateRange(range = 'this_month', from = null, to = null) {
    const now = new Date();
    let startDate = new Date();
    let endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    switch (range) {
        case 'today':
            startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
            break;
        case 'this_week': {
            const day = now.getDay();
            const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
            startDate = new Date(now.getFullYear(), now.getMonth(), diff, 0, 0, 0, 0);
            break;
        }
        case 'this_month':
            startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
            break;
        case 'this_quarter': {
            const currentQuarter = Math.floor(now.getMonth() / 3);
            const quarterStartMonth = currentQuarter * 3;
            startDate = new Date(now.getFullYear(), quarterStartMonth, 1, 0, 0, 0, 0);
            break;
        }
        case 'this_year':
            startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
            break;
        case 'custom':
            if (from) startDate = new Date(from);
            if (to) {
                const end = new Date(to);
                endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59, 999);
            }
            break;
        default:
            startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    }

    return { startDate, endDate };
}

/**
 * User & Team Activity Analytics Server-Side Aggregation.
 */
async function getActivityAnalytics({ range = 'this_month', from = null, to = null } = {}) {
    const { startDate, endDate } = resolveDateRange(range, from, to);

    // 1. High-level team counts
    const [totalUsers, activeUsers, inactiveUsers, pendingInvitations, neverLoggedIn] = await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { status: 'ACTIVE' } }),
        prisma.user.count({ where: { status: 'INACTIVE' } }),
        prisma.invitation.count({ where: { status: 'PENDING' } }),
        prisma.user.count({ where: { lastLoginAt: null } })
    ]);

    // 2. Activity counts within the period
    const periodWhere = {
        createdAt: {
            gte: startDate,
            lte: endDate
        }
    };

    const [
        totalEvents,
        documentsCreated,
        documentsEdited,
        documentsPrinted,
        documentsExported,
        paymentsRecorded,
        permissionDenied,
        loginFailures
    ] = await Promise.all([
        prisma.userActivityLog.count({ where: periodWhere }),
        prisma.userActivityLog.count({ where: { ...periodWhere, action: 'CREATE_DOCUMENT' } }),
        prisma.userActivityLog.count({ where: { ...periodWhere, action: 'EDIT_DOCUMENT' } }),
        prisma.userActivityLog.count({ where: { ...periodWhere, action: 'PRINT_DOCUMENT' } }),
        prisma.userActivityLog.count({ where: { ...periodWhere, action: 'EXPORT_DOCUMENT' } }),
        prisma.userActivityLog.count({ where: { ...periodWhere, action: 'CREATE_PAYMENT' } }),
        prisma.userActivityLog.count({ where: { ...periodWhere, action: 'PERMISSION_DENIED' } }),
        prisma.userActivityLog.count({ where: { ...periodWhere, action: 'LOGIN_FAILED' } })
    ]);

    // 3. Most active users in period (group by actorUserId)
    const activeUserCounts = await prisma.userActivityLog.groupBy({
        by: ['actorUserId'],
        where: {
            ...periodWhere,
            actorUserId: { not: null }
        },
        _count: { id: true },
        orderBy: {
            _count: { id: 'desc' }
        },
        take: 5
    });

    const actorUserIds = activeUserCounts.map(u => u.actorUserId).filter(Boolean);
    const usersInfo = await prisma.user.findMany({
        where: { id: { in: actorUserIds } },
        select: { id: true, name: true, email: true, role: true, assignedRole: { select: { name: true } } }
    });
    const userInfoMap = new Map();
    for (const u of usersInfo) userInfoMap.set(u.id, u);

    const topActiveUsers = activeUserCounts.map(item => {
        const u = userInfoMap.get(item.actorUserId);
        return {
            userId: item.actorUserId,
            name: u ? u.name : 'Unknown',
            email: u ? u.email : '',
            roleName: u ? (u.assignedRole?.name || u.role) : '',
            activityCount: item._count.id
        };
    });

    // 4. Breakdown by Module
    const moduleCounts = await prisma.userActivityLog.groupBy({
        by: ['module'],
        where: periodWhere,
        _count: { id: true },
        orderBy: {
            _count: { id: 'desc' }
        }
    });

    return {
        range,
        period: {
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString()
        },
        team: {
            totalUsers,
            activeUsers,
            inactiveUsers,
            pendingInvitations,
            neverLoggedIn
        },
        metrics: {
            totalEvents,
            documentsCreated,
            documentsEdited,
            documentsPrinted,
            documentsExported,
            paymentsRecorded,
            permissionDenied,
            loginFailures
        },
        topActiveUsers,
        moduleBreakdown: moduleCounts.map(m => ({ module: m.module, count: m._count.id }))
    };
}

module.exports = {
    log,
    listActivities,
    getUserRecentActivity,
    getActivityAnalytics,
    resolveDateRange
};
