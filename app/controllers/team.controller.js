const prisma = require('../config/prisma');
const teamService = require('../services/team.service');
const invitationService = require('../services/invitation.service');
const rbacService = require('../services/rbac.service');
const activityService = require('../services/activity.service');

/**
 * Resolve application base URL from configuration or request headers
 */
function getBaseUrl(req) {
    if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
    if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.get('host') || `localhost:${process.env.PORT || 3000}`;
    return `${protocol}://${host}`;
}

/**
 * Render Team Management Dashboard & Members List
 */
async function renderTeamPage(req, res, next) {
    try {
        const { search, status, roleId, page } = req.query;
        const [membersResult, roles, analytics, allPermissions] = await Promise.all([
            teamService.listTeamMembers({ search, status, roleId, page, limit: 15 }),
            rbacService.listRoles(),
            activityService.getActivityAnalytics({ range: 'this_month' }),
            rbacService.listPermissions()
        ]);

        res.render('team/index', {
            pageTitle: 'Team Management',
            users: membersResult.users,
            pagination: membersResult.pagination,
            roles,
            allPermissions,
            modules: rbacService.MODULES,
            actions: rbacService.ACTIONS,
            moduleActionMatrix: rbacService.MODULE_ACTION_MATRIX,
            analytics,
            filters: { search: search || '', status: status || 'ALL', roleId: roleId || 'ALL' }
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Render Team Member Profile, Effective Access Preview & Activity
 */
async function renderTeamMemberDetail(req, res, next) {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) {
            return res.status(404).render('errors/404', { pageTitle: 'User Not Found' });
        }

        const data = await teamService.getTeamMemberById(userId);
        if (!data || !data.user) {
            return res.status(404).render('errors/404', { pageTitle: 'User Not Found' });
        }

        const [roles, allPermissions] = await Promise.all([
            rbacService.listRoles(),
            rbacService.listPermissions()
        ]);

        res.render('team/show', {
            pageTitle: `${data.user.name} - Team Member`,
            member: data.user,
            effective: data.effective,
            recentActivity: data.recentActivity,
            roles,
            allPermissions,
            modules: rbacService.MODULES,
            actions: rbacService.ACTIONS,
            moduleActionMatrix: rbacService.MODULE_ACTION_MATRIX
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Render User Activity Log Page
 */
async function renderActivityLogPage(req, res, next) {
    try {
        const { page, search, actorUserId, module: mod, action, fromDate, toDate } = req.query;
        const [activitiesResult, teamResult] = await Promise.all([
            activityService.listActivities({ page, search, actorUserId, module: mod, action, fromDate, toDate, limit: 30 }),
            teamService.listTeamMembers({ limit: 100 })
        ]);

        res.render('team/activity', {
            pageTitle: 'User Activity Log',
            activities: activitiesResult.items,
            pagination: activitiesResult.pagination,
            teamMembers: teamResult.users,
            modules: rbacService.MODULES,
            actions: rbacService.ACTIONS,
            filters: {
                page: page || 1,
                search: search || '',
                actorUserId: actorUserId || '',
                module: mod || '',
                action: action || '',
                fromDate: fromDate || '',
                toDate: toDate || ''
            }
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Render User Activity Analytics Page
 */
async function renderAnalyticsPage(req, res, next) {
    try {
        const { range = 'this_month', from, to } = req.query;
        const analytics = await activityService.getActivityAnalytics({ range, from, to });

        res.render('team/analytics', {
            pageTitle: 'Team & Activity Analytics',
            analytics,
            currentRange: range,
            from: from || '',
            to: to || ''
        });
    } catch (err) {
        next(err);
    }
}

// =========================================================================
// API ENDPOINTS
// =========================================================================

async function apiListTeam(req, res, next) {
    try {
        const result = await teamService.listTeamMembers(req.query);
        res.json({ success: true, data: result.users, pagination: result.pagination });
    } catch (err) {
        next(err);
    }
}

async function apiCreateTeamMember(req, res) {
    try {
        const adminUserId = req.session && req.session.user ? req.session.user.id : null;
        let { name, email, roleId, roleName, permissionIds } = req.body;

        if (!roleId && roleName) {
            const role = await prisma.role.findUnique({ where: { name: roleName.toUpperCase() } });
            if (role) roleId = role.id;
        }

        const meta = { ipAddress: req.ip, userAgent: req.headers ? req.headers['user-agent'] : null };
        const result = await invitationService.createInvitation(adminUserId, {
            name,
            email,
            roleId,
            permissionIds
        }, meta);

        const baseUrl = getBaseUrl(req);
        const inviteUrl = `${baseUrl}/invite/${result.rawToken}`;

        res.status(201).json({
            success: true,
            data: {
                user: result.user,
                invitation: result.invitation,
                inviteUrl
            },
            inviteUrl,
            invitationUrl: inviteUrl,
            message: 'Team member created and invitation generated.'
        });
    } catch (err) {
        const status = err.statusCode || (err.name === 'ForbiddenError' ? 403 : 400);
        res.status(status).json({ success: false, error: err.message });
    }
}

async function apiUpdateTeamMember(req, res) {
    try {
        const adminUserId = req.session.user.id;
        const targetUserId = req.params.id;
        const { name, roleId, status, permissionIds } = req.body;
        const meta = { ipAddress: req.ip, userAgent: req.headers ? req.headers['user-agent'] : null };

        const updated = await teamService.updateTeamMember(adminUserId, targetUserId, {
            name,
            roleId,
            status,
            permissionIds
        }, meta);

        res.json({ success: true, data: updated, message: 'Team member updated successfully.' });
    } catch (err) {
        const status = err.statusCode || (err.name === 'ForbiddenError' ? 403 : 400);
        res.status(status).json({ success: false, error: err.message });
    }
}

async function apiToggleStatus(req, res) {
    try {
        const adminUserId = req.session.user.id;
        const targetUserId = req.params.id;
        const { status } = req.body;
        const meta = { ipAddress: req.ip, userAgent: req.headers ? req.headers['user-agent'] : null };

        const updated = await teamService.toggleUserStatus(adminUserId, targetUserId, status, meta);
        res.json({ success: true, data: updated, message: `User status changed to ${updated.status}.` });
    } catch (err) {
        const statusCode = err.statusCode || (err.name === 'ForbiddenError' ? 403 : 400);
        res.status(statusCode).json({ success: false, error: err.message });
    }
}

async function apiResendInvitation(req, res) {
    try {
        const adminUserId = req.session.user.id;
        const targetUserId = req.params.id;
        const meta = { ipAddress: req.ip, userAgent: req.headers ? req.headers['user-agent'] : null };

        const result = await invitationService.resendInvitation(adminUserId, targetUserId, meta);
        const baseUrl = getBaseUrl(req);
        const inviteUrl = `${baseUrl}/invite/${result.rawToken}`;

        res.json({
            success: true,
            data: {
                user: result.user,
                inviteUrl
            },
            message: 'Invitation resent successfully.'
        });
    } catch (err) {
        const statusCode = err.statusCode || (err.name === 'ForbiddenError' ? 403 : 400);
        res.status(statusCode).json({ success: false, error: err.message });
    }
}

async function apiRevokeInvitation(req, res) {
    try {
        const adminUserId = req.session.user.id;
        const targetUserId = req.params.id;
        const meta = { ipAddress: req.ip, userAgent: req.headers ? req.headers['user-agent'] : null };

        await invitationService.revokeInvitation(adminUserId, targetUserId, meta);
        res.json({ success: true, message: 'Invitation revoked successfully.' });
    } catch (err) {
        const statusCode = err.statusCode || (err.name === 'ForbiddenError' ? 403 : 400);
        res.status(statusCode).json({ success: false, error: err.message });
    }
}

async function apiUpdatePermissions(req, res) {
    try {
        const adminUserId = req.session.user.id;
        const targetUserId = req.params.id;
        const { permissionIds } = req.body;
        const meta = { ipAddress: req.ip, userAgent: req.headers ? req.headers['user-agent'] : null };

        const updated = await teamService.updateTeamMember(adminUserId, targetUserId, {
            permissionIds: Array.isArray(permissionIds) ? permissionIds : []
        }, meta);

        res.json({ success: true, data: updated, message: 'Permissions updated successfully.' });
    } catch (err) {
        const statusCode = err.statusCode || (err.name === 'ForbiddenError' ? 403 : 400);
        res.status(statusCode).json({ success: false, error: err.message });
    }
}

async function apiDeleteTeamMember(req, res) {
    try {
        const adminUserId = req.session.user.id;
        const targetUserId = req.params.id;
        const meta = { ipAddress: req.ip, userAgent: req.headers ? req.headers['user-agent'] : null };

        const result = await teamService.deleteTeamMember(adminUserId, targetUserId, meta);
        res.json({ success: true, data: result, message: result.message || 'Team member deleted successfully.' });
    } catch (err) {
        const statusCode = err.statusCode || (err.name === 'ForbiddenError' ? 403 : 400);
        res.status(statusCode).json({ success: false, error: err.message });
    }
}

async function apiGetRoles(req, res, next) {
    try {
        const roles = await rbacService.listRoles();
        res.json({ success: true, data: roles });
    } catch (err) {
        next(err);
    }
}

async function apiGetPermissions(req, res, next) {
    try {
        const permissions = await rbacService.listPermissions();
        res.json({
            success: true,
            data: {
                permissions,
                modules: rbacService.MODULES,
                actions: rbacService.ACTIONS,
                matrix: rbacService.MODULE_ACTION_MATRIX
            }
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Real-time "Permission Preview / Effective Access" preview API.
 * Given roleId and custom permissionIds, returns full calculated matrix of granted/denied permissions.
 */
async function apiPreviewPermissions(req, res) {
    try {
        const { roleId, permissionIds } = req.body;
        const preview = await rbacService.computeEffectiveAccessMatrix(roleId, permissionIds);
        res.json({ success: true, data: preview });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
}

async function apiGetActivity(req, res, next) {
    try {
        const result = await activityService.listActivities(req.query);
        res.json({ success: true, data: result.items, pagination: result.pagination });
    } catch (err) {
        next(err);
    }
}

async function apiGetAnalytics(req, res, next) {
    try {
        const analytics = await activityService.getActivityAnalytics(req.query);
        res.json({ success: true, data: analytics });
    } catch (err) {
        next(err);
    }
}

async function apiGetTeamMember(req, res, next) {
    try {
        const userId = parseInt(req.params.id, 10);
        if (isNaN(userId)) {
            return res.status(404).json({ success: false, error: 'User not found.' });
        }
        const data = await teamService.getTeamMemberById(userId);
        if (!data || !data.user) {
            return res.status(404).json({ success: false, error: 'User not found.' });
        }
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    renderTeamPage,
    renderTeamMemberDetail,
    renderActivityLogPage,
    renderAnalyticsPage,
    apiListTeam,
    apiGetTeamMember,
    apiCreateTeamMember,
    apiUpdateTeamMember,
    apiToggleStatus,
    apiResendInvitation,
    apiRevokeInvitation,
    apiUpdatePermissions,
    apiDeleteTeamMember,
    apiGetRoles,
    apiGetPermissions,
    apiPreviewPermissions,
    apiGetActivity,
    apiGetAnalytics
};
