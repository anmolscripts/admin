const express = require('express');
const requireAuth = require('../middleware/auth.middleware');
const { requirePermission } = require('../middleware/permission.middleware');
const teamController = require('../controllers/team.controller');

const router = express.Router();

router.use(requireAuth);

// Team Member Management Endpoints
router.get('/team', requirePermission('TEAM', 'VIEW'), teamController.apiListTeam);
router.get('/team/:id', requirePermission('TEAM', 'VIEW'), teamController.apiGetTeamMember);
router.post('/team', requirePermission('TEAM', 'MANAGE'), teamController.apiCreateTeamMember);
router.put('/team/:id', requirePermission('TEAM', 'MANAGE'), teamController.apiUpdateTeamMember);
router.patch('/team/:id/status', requirePermission('TEAM', 'MANAGE'), teamController.apiToggleStatus);
router.post('/team/:id/invite', requirePermission('TEAM', 'MANAGE'), teamController.apiResendInvitation);
router.post('/team/:id/invite/resend', requirePermission('TEAM', 'MANAGE'), teamController.apiResendInvitation);
router.post('/team/:id/invite/revoke', requirePermission('TEAM', 'MANAGE'), teamController.apiRevokeInvitation);
router.post('/team/:id/permissions', requirePermission('TEAM', 'MANAGE'), teamController.apiUpdatePermissions);
router.put('/team/:id/permissions', requirePermission('TEAM', 'MANAGE'), teamController.apiUpdatePermissions);
router.delete('/team/:id', requirePermission('TEAM', 'MANAGE'), teamController.apiDeleteTeamMember);

// Role & Permission Metadata
router.get('/team-roles', requirePermission('TEAM', 'VIEW'), teamController.apiGetRoles);
router.get('/team-permissions', requirePermission('TEAM', 'VIEW'), teamController.apiGetPermissions);
router.post('/team-preview-permissions', requirePermission('TEAM', 'VIEW'), teamController.apiPreviewPermissions);

// Activity & Analytics API
router.get('/team-activity', requirePermission('TEAM', 'ACTIVITY_VIEW'), teamController.apiGetActivity);
router.get('/team-analytics', requirePermission('TEAM', 'ACTIVITY_VIEW'), teamController.apiGetAnalytics);

module.exports = router;
