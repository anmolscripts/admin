const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bcrypt = require('bcrypt');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const rbacService = require('../app/services/rbac.service');
const invitationService = require('../app/services/invitation.service');
const teamService = require('../app/services/team.service');

describe('Team Management, RBAC & User Activity Test Suite', () => {
    let server;
    let baseUrl;
    let ownerCookie;
    let ownerCsrfToken;
    let testOwner;
    let adminRole;
    let staffRole;
    let viewerRole;
    let ownerRole;

    // Helper: Login and obtain session cookie + CSRF token
    async function loginUser(email, password) {
        const getLoginRes = await fetch(`${baseUrl}/login`);
        const html = await getLoginRes.text();
        const rawCookie = getLoginRes.headers.get('set-cookie');
        const sidMatch = rawCookie ? rawCookie.match(/spark\.sid=[^;]+/) : null;
        const initialCookie = sidMatch ? sidMatch[0] : '';
        const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
        const csrfToken = csrfMatch ? csrfMatch[1] : '';

        const postLoginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                email,
                password,
                _csrf: csrfToken
            }),
            redirect: 'manual'
        });

        const authSetCookie = postLoginRes.headers.get('set-cookie') || initialCookie;
        const authSidMatch = authSetCookie.match(/spark\.sid=[^;]+/);
        const authCookie = authSidMatch ? authSidMatch[0] : initialCookie;

        // Fetch home or team to get session CSRF token
        const homeRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        const homeHtml = await homeRes.text();
        const homeCsrfMatch = homeHtml.match(/name="_csrf"\s+value="([^"]+)"/);
        const sessionCsrfToken = homeCsrfMatch ? homeCsrfMatch[1] : csrfToken;

        return { cookie: authCookie, csrfToken: sessionCsrfToken };
    }

    before(async () => {
        // Start ephemeral HTTP server
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Ensure roles & permissions are seeded
        await rbacService.seedPermissionsAndRoles();

        ownerRole = await prisma.role.findUnique({ where: { name: 'OWNER' } });
        adminRole = await prisma.role.findUnique({ where: { name: 'ADMIN' } });
        staffRole = await prisma.role.findUnique({ where: { name: 'STAFF' } });
        viewerRole = await prisma.role.findUnique({ where: { name: 'VIEWER' } });

        // Create or find an authoritative OWNER user
        const ownerEmail = 'rbac_owner@test.com';
        const passwordHash = await bcrypt.hash('OwnerSecure123!', 10);
        testOwner = await prisma.user.upsert({
            where: { email: ownerEmail },
            update: {
                roleId: ownerRole.id,
                active: true,
                status: 'ACTIVE'
            },
            create: {
                name: 'Test Owner',
                email: ownerEmail,
                password: passwordHash,
                role: 'ADMIN',
                roleId: ownerRole.id,
                active: true,
                status: 'ACTIVE'
            }
        });

        const auth = await loginUser(ownerEmail, 'OwnerSecure123!');
        ownerCookie = auth.cookie;
        ownerCsrfToken = auth.csrfToken;
    });

    after(async () => {
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });

    // =========================================================================
    // 1. TEAM NAVIGATION & VISIBILITY (Permission TEAM.VIEW)
    // =========================================================================
    describe('1. TEAM.VIEW Enforcement & Navigation Visibility', () => {
        let viewOnlyUser;
        let viewOnlyAuth;
        let noTeamUser;
        let noTeamAuth;

        before(async () => {
            const pwdHash = await bcrypt.hash('UserSecure123!', 10);

            // User with VIEWER role + custom TEAM:VIEW permission
            viewOnlyUser = await prisma.user.create({
                data: {
                    name: 'Team Viewer User',
                    email: `team_viewer_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: viewerRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            const teamViewPerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'TEAM', action: 'VIEW' } }
            });
            await prisma.userPermission.create({
                data: {
                    userId: viewOnlyUser.id,
                    permissionId: teamViewPerm.id
                }
            });

            // User with VIEWER role ONLY (no TEAM:VIEW)
            noTeamUser = await prisma.user.create({
                data: {
                    name: 'No Team Access User',
                    email: `no_team_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: viewerRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            viewOnlyAuth = await loginUser(viewOnlyUser.email, 'UserSecure123!');
            noTeamAuth = await loginUser(noTeamUser.email, 'UserSecure123!');
        });

        after(async () => {
            if (viewOnlyUser) {
                await prisma.userPermission.deleteMany({ where: { userId: viewOnlyUser.id } });
                await prisma.user.delete({ where: { id: viewOnlyUser.id } }).catch(() => {});
            }
            if (noTeamUser) {
                await prisma.user.delete({ where: { id: noTeamUser.id } }).catch(() => {});
            }
        });

        it('User with TEAM.VIEW: GET /team returns 200 and renders Team page', async () => {
            const res = await fetch(`${baseUrl}/team`, {
                headers: { Cookie: viewOnlyAuth.cookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Team Management'), 'Team page title should be rendered');
            assert.ok(html.includes('id="menu-team"'), 'Team sidebar navigation must be present');
        });

        it('User with TEAM.VIEW: GET /api/team returns 200 with team members JSON', async () => {
            const res = await fetch(`${baseUrl}/api/team`, {
                headers: { Cookie: viewOnlyAuth.cookie }
            });
            assert.strictEqual(res.status, 200);
            const json = await res.json();
            assert.strictEqual(json.success, true);
            assert.ok(Array.isArray(json.data));
        });

        it('User without TEAM.VIEW: Sidebar completely hides Team menu item', async () => {
            const res = await fetch(`${baseUrl}/`, {
                headers: { Cookie: noTeamAuth.cookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.strictEqual(html.includes('id="menu-team"'), false, 'Team sidebar link must be hidden');
            assert.strictEqual(html.includes('id="topnav-team"'), false, 'Team topnav link must be hidden');
        });

        it('User without TEAM.VIEW: Direct navigation to /team returns 403 Forbidden', async () => {
            const res = await fetch(`${baseUrl}/team`, {
                headers: { Cookie: noTeamAuth.cookie }
            });
            assert.strictEqual(res.status, 403);
            const html = await res.text();
            assert.ok(html.includes('Access Denied') || html.includes('403'), 'Must render 403 Access Denied');
        });

        it('User without TEAM.VIEW: Direct call to /api/team returns 403 JSON', async () => {
            const res = await fetch(`${baseUrl}/api/team`, {
                headers: {
                    Cookie: noTeamAuth.cookie,
                    Accept: 'application/json'
                }
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('Access denied'));
        });
    });

    // =========================================================================
    // 2. PAGE ACCESS VS ACTION ACCESS (TEAM.MANAGE)
    // =========================================================================
    describe('2. Page Access vs Action Access (TEAM.VIEW vs TEAM.MANAGE)', () => {
        let viewOnlyUser;
        let viewOnlyAuth;

        before(async () => {
            const pwdHash = await bcrypt.hash('UserSecure123!', 10);
            viewOnlyUser = await prisma.user.create({
                data: {
                    name: 'View Only Team User',
                    email: `view_only_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: viewerRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            const teamViewPerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'TEAM', action: 'VIEW' } }
            });
            await prisma.userPermission.create({
                data: {
                    userId: viewOnlyUser.id,
                    permissionId: teamViewPerm.id
                }
            });

            viewOnlyAuth = await loginUser(viewOnlyUser.email, 'UserSecure123!');
        });

        after(async () => {
            if (viewOnlyUser) {
                await prisma.userPermission.deleteMany({ where: { userId: viewOnlyUser.id } });
                await prisma.user.delete({ where: { id: viewOnlyUser.id } }).catch(() => {});
            }
        });

        it('User with only TEAM.VIEW sees read-only Team page without Add Member button', async () => {
            const res = await fetch(`${baseUrl}/team`, {
                headers: { Cookie: viewOnlyAuth.cookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.strictEqual(html.includes('data-bs-target="#inviteModal"'), false, 'Add Member button must be hidden for view-only users');
        });

        it('User without TEAM.MANAGE: POST /api/team (create member) returns 403 JSON', async () => {
            const res = await fetch(`${baseUrl}/api/team`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': viewOnlyAuth.csrfToken,
                    Cookie: viewOnlyAuth.cookie
                },
                body: JSON.stringify({
                    name: 'Unauthorized Member',
                    email: 'unauth@test.com',
                    roleId: staffRole.id
                })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
        });

        it('User without TEAM.MANAGE: PUT /api/team/:id (edit member) returns 403 JSON', async () => {
            const res = await fetch(`${baseUrl}/api/team/${testOwner.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': viewOnlyAuth.csrfToken,
                    Cookie: viewOnlyAuth.cookie
                },
                body: JSON.stringify({
                    name: 'Hacked Name'
                })
            });
            assert.strictEqual(res.status, 403);
        });

        it('User with TEAM.MANAGE (Owner): POST /api/team successfully creates member and invitation', async () => {
            const newMemberEmail = `invited_staff_${Date.now()}@test.com`;
            const res = await fetch(`${baseUrl}/api/team`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ownerCsrfToken,
                    Cookie: ownerCookie
                },
                body: JSON.stringify({
                    name: 'Rahul Sharma',
                    email: newMemberEmail,
                    roleId: staffRole.id
                })
            });
            assert.strictEqual(res.status, 201);
            const json = await res.json();
            assert.strictEqual(json.success, true);
            assert.ok(json.data.inviteUrl, 'Must return secure invitation URL');
            assert.ok(json.data.user.id);
            assert.strictEqual(json.data.user.status, 'INVITED');

            // Cleanup
            await prisma.invitation.deleteMany({ where: { userId: json.data.user.id } });
            await prisma.user.delete({ where: { id: json.data.user.id } });
        });
    });

    // =========================================================================
    // 3. ACTIVITY LOGGING & VISIBILITY (TEAM.ACTIVITY_VIEW)
    // =========================================================================
    describe('3. TEAM.ACTIVITY_VIEW Enforcement', () => {
        let activityViewerUser;
        let activityViewerAuth;
        let noActivityUser;
        let noActivityAuth;

        before(async () => {
            const pwdHash = await bcrypt.hash('UserSecure123!', 10);

            // User with TEAM:VIEW + TEAM:ACTIVITY_VIEW
            activityViewerUser = await prisma.user.create({
                data: {
                    name: 'Activity Auditor',
                    email: `activity_auditor_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: viewerRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            const teamViewPerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'TEAM', action: 'VIEW' } }
            });
            const teamActPerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'TEAM', action: 'ACTIVITY_VIEW' } }
            });

            await prisma.userPermission.createMany({
                data: [
                    { userId: activityViewerUser.id, permissionId: teamViewPerm.id },
                    { userId: activityViewerUser.id, permissionId: teamActPerm.id }
                ]
            });

            // User with only TEAM:VIEW (no ACTIVITY_VIEW)
            noActivityUser = await prisma.user.create({
                data: {
                    name: 'No Activity Perm User',
                    email: `no_activity_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: viewerRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });
            await prisma.userPermission.create({
                data: { userId: noActivityUser.id, permissionId: teamViewPerm.id }
            });

            activityViewerAuth = await loginUser(activityViewerUser.email, 'UserSecure123!');
            noActivityAuth = await loginUser(noActivityUser.email, 'UserSecure123!');
        });

        after(async () => {
            if (activityViewerUser) {
                await prisma.userPermission.deleteMany({ where: { userId: activityViewerUser.id } });
                await prisma.user.delete({ where: { id: activityViewerUser.id } }).catch(() => {});
            }
            if (noActivityUser) {
                await prisma.userPermission.deleteMany({ where: { userId: noActivityUser.id } });
                await prisma.user.delete({ where: { id: noActivityUser.id } }).catch(() => {});
            }
        });

        it('User with TEAM.ACTIVITY_VIEW: GET /team/activity returns 200', async () => {
            const res = await fetch(`${baseUrl}/team/activity`, {
                headers: { Cookie: activityViewerAuth.cookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('User Activity Log'));
        });

        it('User without TEAM.ACTIVITY_VIEW: GET /team/activity returns 403 Forbidden', async () => {
            const res = await fetch(`${baseUrl}/team/activity`, {
                headers: { Cookie: noActivityAuth.cookie }
            });
            assert.strictEqual(res.status, 403);
        });

        it('User without TEAM.ACTIVITY_VIEW: GET /api/team-activity returns 403 JSON', async () => {
            const res = await fetch(`${baseUrl}/api/team-activity`, {
                headers: {
                    Cookie: noActivityAuth.cookie,
                    Accept: 'application/json'
                }
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
        });
    });

    // =========================================================================
    // 4. DOCUMENT & PAYMENT ACTION PERMISSIONS
    // =========================================================================
    describe('4. Document & Payment Fine-Grained Permissions', () => {
        let viewOnlyDocUser;
        let viewOnlyDocAuth;

        before(async () => {
            const pwdHash = await bcrypt.hash('DocSecure123!', 10);
            viewOnlyDocUser = await prisma.user.create({
                data: {
                    name: 'Document Viewer Only',
                    email: `doc_viewer_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: null, // Custom user without any role: ONLY explicitly assigned permissions
                    active: true,
                    status: 'ACTIVE'
                }
            });

            // Grant only DOCUMENTS:VIEW
            const docViewPerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'DOCUMENTS', action: 'VIEW' } }
            });
            await prisma.userPermission.create({
                data: { userId: viewOnlyDocUser.id, permissionId: docViewPerm.id }
            });

            viewOnlyDocAuth = await loginUser(viewOnlyDocUser.email, 'DocSecure123!');
        });

        after(async () => {
            if (viewOnlyDocUser) {
                await prisma.userPermission.deleteMany({ where: { userId: viewOnlyDocUser.id } });
                await prisma.user.delete({ where: { id: viewOnlyDocUser.id } }).catch(() => {});
            }
        });

        it('DOCUMENTS.VIEW only allows viewing documents listing', async () => {
            const res = await fetch(`${baseUrl}/documents`, {
                headers: { Cookie: viewOnlyDocAuth.cookie }
            });
            assert.strictEqual(res.status, 200);
        });

        it('DOCUMENTS.EDIT absent: GET /documents/:id/edit returns 403 Forbidden', async () => {
            const inv = await prisma.invoice.findFirst();
            if (inv) {
                const res = await fetch(`${baseUrl}/documents/${inv.id}/edit`, {
                    headers: { Cookie: viewOnlyDocAuth.cookie }
                });
                assert.strictEqual(res.status, 403);
            }
        });

        it('DOCUMENTS.PRINT absent: GET /documents/:id/print returns 403 Forbidden', async () => {
            const inv = await prisma.invoice.findFirst();
            if (inv) {
                const res = await fetch(`${baseUrl}/documents/${inv.id}/print`, {
                    headers: { Cookie: viewOnlyDocAuth.cookie }
                });
                assert.strictEqual(res.status, 403);
            }
        });

        it('DOCUMENTS.EXPORT absent: GET /documents/export/excel returns 403 Forbidden', async () => {
            const res = await fetch(`${baseUrl}/documents/export/excel`, {
                headers: { Cookie: viewOnlyDocAuth.cookie }
            });
            assert.strictEqual(res.status, 403);
        });

        it('PAYMENTS.CREATE absent: POST /api/invoices/:id/payments returns 403 JSON', async () => {
            const inv = await prisma.invoice.findFirst();
            if (inv) {
                const res = await fetch(`${baseUrl}/api/invoices/${inv.id}/payments`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-csrf-token': viewOnlyDocAuth.csrfToken,
                        Cookie: viewOnlyDocAuth.cookie
                    },
                    body: JSON.stringify({
                        amount: 500,
                        method: 'BANK_TRANSFER'
                    })
                });
                assert.strictEqual(res.status, 403);
            }
        });
    });

    // =========================================================================
    // 5. INVITATION LIFECYCLE & PASSWORD SETUP
    // =========================================================================
    describe('5. Cryptographic Invitation & Password Setup Lifecycle', () => {
        let invitedUser;
        let initialToken;
        let activeToken;

        it('Step 1: Admin creates team member -> creates single-use invitation', async () => {
            const email = `lifecycle_test_${Date.now()}@test.com`;
            const result = await invitationService.createInvitation(testOwner.id, {
                name: 'Ananya Verma',
                email,
                roleId: staffRole.id
            });

            assert.ok(result.rawToken, 'Must generate raw 32-byte token');
            assert.ok(result.invitation.tokenHash, 'Database must store SHA-256 hash');
            assert.strictEqual(result.invitation.tokenHash.length, 64);
            assert.strictEqual(result.user.status, 'INVITED');

            invitedUser = result.user;
            initialToken = result.rawToken;
            activeToken = result.rawToken;
        });

        it('Step 2: GET /invite/:token with valid token returns password setup form', async () => {
            const res = await fetch(`${baseUrl}/invite/${initialToken}`);
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Set Password') || html.includes('Set a secure password'));
            assert.ok(html.includes('Ananya Verma'));
        });

        it('Step 3: GET /invite/:token with invalid token returns 400 with error', async () => {
            const res = await fetch(`${baseUrl}/invite/invalid-bogus-token-12345`);
            assert.strictEqual(res.status, 400);
            const html = await res.text();
            assert.ok(html.includes('Invalid') || html.includes('expired') || html.includes('invalid'));
        });

        it('Step 3b: Resend invitation generates fresh token and invalidates old token', async () => {
            const resendResult = await invitationService.resendInvitation(testOwner.id, invitedUser.id);
            assert.ok(resendResult.rawToken);
            assert.notStrictEqual(resendResult.rawToken, initialToken);

            activeToken = resendResult.rawToken;

            // Old token now fails
            const oldCheck = await invitationService.getInvitationByToken(initialToken);
            assert.strictEqual(oldCheck.valid, false);

            // New token is valid
            const newCheck = await invitationService.getInvitationByToken(activeToken);
            assert.strictEqual(newCheck.valid, true);
        });

        it('Step 4: POST /invite/:token sets password, activates account, and marks token ACCEPTED', async () => {
            // First GET the page to capture session cookie & CSRF token
            const getRes = await fetch(`${baseUrl}/invite/${activeToken}`);
            assert.strictEqual(getRes.status, 200);
            const html = await getRes.text();
            const setCookie = getRes.headers.get('set-cookie');
            const sidMatch = setCookie ? setCookie.match(/spark\.sid=[^;]+/) : null;
            const cookie = sidMatch ? sidMatch[0] : '';
            const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
            const csrfToken = csrfMatch ? csrfMatch[1] : '';

            const res = await fetch(`${baseUrl}/invite/${activeToken}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: cookie
                },
                body: new URLSearchParams({
                    password: 'ComplexPassword123!',
                    confirmPassword: 'ComplexPassword123!',
                    _csrf: csrfToken
                }),
                redirect: 'manual'
            });

            // Redirects to /login?setup=success
            assert.strictEqual(res.status, 302);
            assert.ok(res.headers.get('location').includes('/login'));

            // Verify DB state
            const updatedUser = await prisma.user.findUnique({ where: { id: invitedUser.id } });
            assert.strictEqual(updatedUser.status, 'ACTIVE');
            assert.strictEqual(updatedUser.active, true);
            assert.ok(updatedUser.password);

            const matches = await bcrypt.compare('ComplexPassword123!', updatedUser.password);
            assert.strictEqual(matches, true);
        });

        it('Step 5: New user can log in with newly set password', async () => {
            const auth = await loginUser(invitedUser.email, 'ComplexPassword123!');
            assert.ok(auth.cookie, 'Successfully logged in with new password');

            const dashRes = await fetch(`${baseUrl}/`, {
                headers: { Cookie: auth.cookie }
            });
            assert.strictEqual(dashRes.status, 200);
        });

        it('Step 6: Reusing accepted token returns 400 error', async () => {
            const res = await fetch(`${baseUrl}/invite/${activeToken}`);
            assert.strictEqual(res.status, 400);
        });

        it('Step 7: Resend invitation for already active user is rejected', async () => {
            await assert.rejects(async () => {
                await invitationService.resendInvitation(testOwner.id, invitedUser.id);
            }, /already accepted/);
        });

        after(async () => {
            if (invitedUser) {
                await prisma.invitation.deleteMany({ where: { userId: invitedUser.id } });
                await prisma.user.delete({ where: { id: invitedUser.id } }).catch(() => {});
            }
        });
    });

    // =========================================================================
    // 6. SECURITY & LAST OWNER PROTECTION
    // =========================================================================
    describe('6. Security Protections & Last Owner Safeguard', () => {
        it('Prevents deactivating the last active OWNER', async () => {
            // Find all active owners
            const activeOwners = await prisma.user.findMany({
                where: {
                    assignedRole: { name: 'OWNER' },
                    active: true,
                    status: 'ACTIVE'
                }
            });

            if (activeOwners.length === 1) {
                const owner = activeOwners[0];
                await assert.rejects(async () => {
                    await teamService.toggleUserStatus(owner.id, owner.id, 'INACTIVE');
                }, /Cannot deactivate or demote the last active Organization Owner/);
            }
        });

        it('Prevents deleting the last active OWNER', async () => {
            const activeOwners = await prisma.user.findMany({
                where: {
                    assignedRole: { name: 'OWNER' },
                    active: true,
                    status: 'ACTIVE'
                }
            });

            if (activeOwners.length === 1) {
                const owner = activeOwners[0];
                await assert.rejects(async () => {
                    await teamService.deleteTeamMember(owner.id, owner.id);
                }, /Cannot delete the last active Organization Owner/);
            }
        });

        it('Security audit log captures PERMISSION_DENIED on unauthorized attempts', async () => {
            const recentDenied = await prisma.userActivityLog.findFirst({
                where: { action: 'PERMISSION_DENIED' },
                orderBy: { createdAt: 'desc' }
            });
            assert.ok(recentDenied, 'PERMISSION_DENIED audit log must exist from prior test assertions');
            assert.strictEqual(recentDenied.action, 'PERMISSION_DENIED');
        });
    });

    // =========================================================================
    // 7. SELF PRIVILEGE ESCALATION PROTECTIONS (Item 10 Matrix)
    // =========================================================================
    describe('7. Self Privilege Escalation Protections', () => {
        let managerUser;
        let managerAuth;
        let docDeletePerm;

        before(async () => {
            const pwdHash = await bcrypt.hash('ManagerPass123!', 10);
            managerUser = await prisma.user.create({
                data: {
                    name: 'Custom Team Manager',
                    email: `custom_mgr_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: staffRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            const teamViewPerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'TEAM', action: 'VIEW' } }
            });
            const teamManagePerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'TEAM', action: 'MANAGE' } }
            });
            docDeletePerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'DOCUMENTS', action: 'DELETE' } }
            });

            await prisma.userPermission.createMany({
                data: [
                    { userId: managerUser.id, permissionId: teamViewPerm.id },
                    { userId: managerUser.id, permissionId: teamManagePerm.id }
                ]
            });

            managerAuth = await loginUser(managerUser.email, 'ManagerPass123!');
        });

        after(async () => {
            if (managerUser) {
                await prisma.invitation.deleteMany({ where: { userId: managerUser.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: managerUser.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: managerUser.id } }).catch(() => {});
            }
        });

        it('USER with TEAM.MANAGE: attempting self-OWNER returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${managerUser.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': managerAuth.csrfToken,
                    Cookie: managerAuth.cookie
                },
                body: JSON.stringify({ roleId: ownerRole.id })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('cannot modify their own role'));
        });

        it('USER with TEAM.MANAGE: attempting self-ADMIN returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${managerUser.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': managerAuth.csrfToken,
                    Cookie: managerAuth.cookie
                },
                body: JSON.stringify({ roleId: adminRole.id })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('cannot modify their own role'));
        });

        it('USER with TEAM.MANAGE: attempting self permission escalation returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${managerUser.id}/permissions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': managerAuth.csrfToken,
                    Cookie: managerAuth.cookie
                },
                body: JSON.stringify({ permissionIds: [docDeletePerm.id] })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('cannot modify their own permissions'));
        });

        it('USER with TEAM.MANAGE: attempting self deactivation returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${managerUser.id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': managerAuth.csrfToken,
                    Cookie: managerAuth.cookie
                },
                body: JSON.stringify({ status: 'INACTIVE' })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('cannot change their own account status') || json.error.includes('cannot deactivate your own account'));
        });

        it('Service level: USER cannot modify own role directly', async () => {
            await assert.rejects(async () => {
                await teamService.updateTeamMember(managerUser.id, managerUser.id, { roleId: ownerRole.id });
            }, /cannot modify their own role/);
        });

        it('Service level: USER cannot modify own permissions directly', async () => {
            await assert.rejects(async () => {
                await teamService.updateTeamMember(managerUser.id, managerUser.id, { permissionIds: [docDeletePerm.id] });
            }, /cannot modify their own permissions/);
        });
    });

    // =========================================================================
    // 8. ADMIN ESCALATION & DELEGATION BOUNDARY PROTECTIONS
    // =========================================================================
    describe('8. Admin Escalation & Delegation Boundary Protections', () => {
        let adminUser;
        let adminAuth;
        let subordinateUser;
        let teamDeletePerm;

        before(async () => {
            await rbacService.seedPermissionsAndRoles();
            const pwdHash = await bcrypt.hash('AdminSecure123!', 10);
            adminUser = await prisma.user.create({
                data: {
                    name: 'Test Administrator',
                    email: `admin_sub_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'ADMIN',
                    roleId: adminRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            subordinateUser = await prisma.user.create({
                data: {
                    name: 'Subordinate Staff',
                    email: `subordinate_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: staffRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            teamDeletePerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'TEAM', action: 'DELETE' } }
            });

            adminAuth = await loginUser(adminUser.email, 'AdminSecure123!');
        });

        after(async () => {
            if (adminUser) {
                await prisma.invitation.deleteMany({ where: { userId: adminUser.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: adminUser.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: adminUser.id } }).catch(() => {});
            }
            if (subordinateUser) {
                await prisma.invitation.deleteMany({ where: { userId: subordinateUser.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: subordinateUser.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: subordinateUser.id } }).catch(() => {});
            }
        });

        it('ADMIN attempting to assign OWNER role to another user returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${subordinateUser.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': adminAuth.csrfToken,
                    Cookie: adminAuth.cookie
                },
                body: JSON.stringify({ roleId: ownerRole.id })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('Only an OWNER can assign the OWNER role'));
        });

        it('ADMIN attempting to modify an OWNER user returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${testOwner.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': adminAuth.csrfToken,
                    Cookie: adminAuth.cookie
                },
                body: JSON.stringify({ name: 'Tampered Owner Name' })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('Only an OWNER can modify or manage another OWNER'));
        });

        it('ADMIN attempting to grant permission they do not possess returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${subordinateUser.id}/permissions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': adminAuth.csrfToken,
                    Cookie: adminAuth.cookie
                },
                body: JSON.stringify({ permissionIds: [teamDeletePerm.id] })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('Cannot grant permission') || json.error.includes('do not possess'));
        });

        it('ADMIN attempting to invite user with OWNER role returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': adminAuth.csrfToken,
                    Cookie: adminAuth.cookie
                },
                body: JSON.stringify({
                    name: 'Fake Owner',
                    email: `fake_owner_${Date.now()}@test.com`,
                    roleId: ownerRole.id
                })
            });
            assert.strictEqual(res.status, 403);
            const json = await res.json();
            assert.strictEqual(json.success, false);
            assert.ok(json.error.includes('Only an OWNER can create a user with the OWNER role') || json.error.includes('OWNER'));
        });

        it('Service level: ADMIN attempting to invite user with unpossessed permission is rejected', async () => {
            await assert.rejects(async () => {
                await invitationService.createInvitation(adminUser.id, {
                    name: 'Elevated User',
                    email: `elevated_${Date.now()}@test.com`,
                    roleId: staffRole.id,
                    permissionIds: [teamDeletePerm.id]
                });
            }, /Cannot grant permission.*do not possess/);
        });
    });

    // =========================================================================
    // 9. OWNER AUTHORITY VALIDATION
    // =========================================================================
    describe('9. Owner Authority Validation', () => {
        let createdAdminUser;
        let createdStaffUser;

        after(async () => {
            if (createdAdminUser) {
                await prisma.invitation.deleteMany({ where: { userId: createdAdminUser.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: createdAdminUser.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: createdAdminUser.id } }).catch(() => {});
            }
            if (createdStaffUser) {
                await prisma.invitation.deleteMany({ where: { userId: createdStaffUser.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: createdStaffUser.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: createdStaffUser.id } }).catch(() => {});
            }
        });

        it('OWNER can create and invite ADMIN user (allowed 201)', async () => {
            const res = await fetch(`${baseUrl}/api/team`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ownerCsrfToken,
                    Cookie: ownerCookie
                },
                body: JSON.stringify({
                    name: 'New Admin Member',
                    email: `new_admin_${Date.now()}@test.com`,
                    roleId: adminRole.id
                })
            });
            assert.strictEqual(res.status, 201);
            const json = await res.json();
            assert.strictEqual(json.success, true);
            assert.ok(json.data.inviteUrl);
            createdAdminUser = json.data.user;
        });

        it('OWNER can create and invite STAFF user (allowed 201)', async () => {
            const res = await fetch(`${baseUrl}/api/team`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ownerCsrfToken,
                    Cookie: ownerCookie
                },
                body: JSON.stringify({
                    name: 'New Staff Member',
                    email: `new_staff_${Date.now()}@test.com`,
                    roleId: staffRole.id
                })
            });
            assert.strictEqual(res.status, 201);
            const json = await res.json();
            assert.strictEqual(json.success, true);
            assert.ok(json.data.inviteUrl);
            createdStaffUser = json.data.user;
        });

        it('OWNER can manage permissions of other users (allowed 200)', async () => {
            const docVoidPerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'DOCUMENTS', action: 'VOID' } }
            });
            const res = await fetch(`${baseUrl}/api/team/${createdStaffUser.id}/permissions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ownerCsrfToken,
                    Cookie: ownerCookie
                },
                body: JSON.stringify({ permissionIds: [docVoidPerm.id] })
            });
            assert.strictEqual(res.status, 200);
            const json = await res.json();
            assert.strictEqual(json.success, true);
        });
    });

    // =========================================================================
    // 10. LAST PRIVILEGE & ADMINISTRATOR PROTECTIONS
    // =========================================================================
    describe('10. Last Privilege & Administrator Protections', () => {
        let tempAdmin1;
        let tempAdmin2;

        before(async () => {
            const pwdHash = await bcrypt.hash('TempAdmin123!', 10);
            tempAdmin1 = await prisma.user.create({
                data: {
                    name: 'Temp Admin One',
                    email: `temp_admin_1_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'ADMIN',
                    roleId: adminRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });
            tempAdmin2 = await prisma.user.create({
                data: {
                    name: 'Temp Admin Two',
                    email: `temp_admin_2_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'ADMIN',
                    roleId: adminRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });
        });

        after(async () => {
            if (tempAdmin1) {
                await prisma.invitation.deleteMany({ where: { userId: tempAdmin1.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: tempAdmin1.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: tempAdmin1.id } }).catch(() => {});
            }
            if (tempAdmin2) {
                await prisma.invitation.deleteMany({ where: { userId: tempAdmin2.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: tempAdmin2.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: tempAdmin2.id } }).catch(() => {});
            }
        });

        it('Cannot remove or demote the last active administrator when only one remains', async () => {
            // Deactivate all other active admins and owners except tempAdmin1
            const allOtherAdmins = await prisma.user.findMany({
                where: { status: 'ACTIVE', active: true, id: { not: tempAdmin1.id } }
            });
            const adminIdsToDeactivate = [];
            for (const u of allOtherAdmins) {
                const p = await rbacService.getUserEffectivePermissions(u.id);
                if (p.hasPermission('TEAM', 'MANAGE') || p.isOwner) {
                    adminIdsToDeactivate.push(u.id);
                }
            }

            if (adminIdsToDeactivate.length > 0) {
                await prisma.user.updateMany({
                    where: { id: { in: adminIdsToDeactivate } },
                    data: { status: 'INACTIVE', active: false }
                });
                rbacService.invalidateAll();
            }

            try {
                // tempAdmin1 is now the sole active administrator in the system
                const isLast = await teamService.isLastActiveAdministrator(tempAdmin1.id);
                assert.strictEqual(isLast, true);

                // Attempting to deactivate tempAdmin1 when sole active administrator must be blocked
                await assert.rejects(async () => {
                    await teamService.toggleUserStatus(null, tempAdmin1.id, 'INACTIVE');
                }, /Cannot deactivate the final active administrator with TEAM\.MANAGE privileges/);
            } finally {
                // Restore deactivated admins
                if (adminIdsToDeactivate.length > 0) {
                    await prisma.user.updateMany({
                        where: { id: { in: adminIdsToDeactivate } },
                        data: { status: 'ACTIVE', active: true }
                    });
                    rbacService.invalidateAll();
                }
            }
        });

        it('Safely replacing an administrator before removal is allowed', async () => {
            // Reactivate tempAdmin1 and tempAdmin2 so active administrators exist
            await prisma.user.update({ where: { id: tempAdmin1.id }, data: { status: 'ACTIVE', active: true } });
            await prisma.user.update({ where: { id: tempAdmin2.id }, data: { status: 'ACTIVE', active: true } });
            rbacService.invalidateAll();

            // Now deactivating tempAdmin2 succeeds because tempAdmin1 and testOwner are active
            const res = await teamService.toggleUserStatus(testOwner.id, tempAdmin2.id, 'INACTIVE');
            assert.strictEqual(res.status, 'INACTIVE');
        });
    });

    // =========================================================================
    // 11. DIRECT API SECURITY, IDOR & REVOCATION TESTING
    // =========================================================================
    describe('11. Direct API Security, IDOR & Revocation Testing', () => {
        let unprivilegedUser;
        let unprivilegedAuth;
        let targetStaff;

        before(async () => {
            const pwdHash = await bcrypt.hash('NoPermsPass123!', 10);
            unprivilegedUser = await prisma.user.create({
                data: {
                    name: 'Unprivileged User',
                    email: `unpriv_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: viewerRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            targetStaff = await prisma.user.create({
                data: {
                    name: 'Target Staff Member',
                    email: `target_staff_${Date.now()}@test.com`,
                    password: pwdHash,
                    role: 'USER',
                    roleId: staffRole.id,
                    active: true,
                    status: 'ACTIVE'
                }
            });

            unprivilegedAuth = await loginUser(unprivilegedUser.email, 'NoPermsPass123!');
        });

        after(async () => {
            if (unprivilegedUser) {
                await prisma.invitation.deleteMany({ where: { userId: unprivilegedUser.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: unprivilegedUser.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: unprivilegedUser.id } }).catch(() => {});
            }
            if (targetStaff) {
                await prisma.invitation.deleteMany({ where: { userId: targetStaff.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: targetStaff.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: targetStaff.id } }).catch(() => {});
            }
        });

        it('Direct POST /api/team without TEAM.MANAGE returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': unprivilegedAuth.csrfToken,
                    Cookie: unprivilegedAuth.cookie
                },
                body: JSON.stringify({ name: 'Hacker', email: 'h@h.com', roleId: viewerRole.id })
            });
            assert.strictEqual(res.status, 403);
        });

        it('Direct PUT /api/team/:id without TEAM.MANAGE returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${targetStaff.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': unprivilegedAuth.csrfToken,
                    Cookie: unprivilegedAuth.cookie
                },
                body: JSON.stringify({ name: 'Hacked' })
            });
            assert.strictEqual(res.status, 403);
        });

        it('Direct PATCH /api/team/:id/status without TEAM.MANAGE returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${targetStaff.id}/status`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': unprivilegedAuth.csrfToken,
                    Cookie: unprivilegedAuth.cookie
                },
                body: JSON.stringify({ status: 'INACTIVE' })
            });
            assert.strictEqual(res.status, 403);
        });

        it('Direct POST /api/team/:id/permissions without TEAM.MANAGE returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${targetStaff.id}/permissions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': unprivilegedAuth.csrfToken,
                    Cookie: unprivilegedAuth.cookie
                },
                body: JSON.stringify({ permissionIds: [] })
            });
            assert.strictEqual(res.status, 403);
        });

        it('Direct POST /api/team/:id/invite/resend without TEAM.MANAGE returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${targetStaff.id}/invite/resend`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': unprivilegedAuth.csrfToken,
                    Cookie: unprivilegedAuth.cookie
                }
            });
            assert.strictEqual(res.status, 403);
        });

        it('Direct POST /api/team/:id/invite/revoke without TEAM.MANAGE returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${targetStaff.id}/invite/revoke`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': unprivilegedAuth.csrfToken,
                    Cookie: unprivilegedAuth.cookie
                }
            });
            assert.strictEqual(res.status, 403);
        });

        it('Direct DELETE /api/team/:id without TEAM.MANAGE returns 403', async () => {
            const res = await fetch(`${baseUrl}/api/team/${targetStaff.id}`, {
                method: 'DELETE',
                headers: {
                    'x-csrf-token': unprivilegedAuth.csrfToken,
                    Cookie: unprivilegedAuth.cookie
                }
            });
            assert.strictEqual(res.status, 403);
        });

        it('Revoking an invitation marks it REVOKED and disables setup', async () => {
            const inviteRes = await invitationService.createInvitation(testOwner.id, {
                name: 'Revoke Target',
                email: `revoke_test_${Date.now()}@test.com`,
                roleId: staffRole.id
            });

            // Revoke via API
            const res = await fetch(`${baseUrl}/api/team/${inviteRes.user.id}/invite/revoke`, {
                method: 'POST',
                headers: {
                    'x-csrf-token': ownerCsrfToken,
                    Cookie: ownerCookie
                }
            });
            assert.strictEqual(res.status, 200);

            // Verify DB state
            const dbInv = await prisma.invitation.findFirst({ where: { userId: inviteRes.user.id } });
            assert.strictEqual(dbInv.status, 'REVOKED');

            // Setup attempt returns 400
            const setupRes = await fetch(`${baseUrl}/invite/${inviteRes.rawToken}`);
            assert.strictEqual(setupRes.status, 400);

            // Cleanup
            await prisma.invitation.deleteMany({ where: { userId: inviteRes.user.id } });
            await prisma.user.delete({ where: { id: inviteRes.user.id } }).catch(() => {});
        });
    });

    // =========================================================================
    // 12. SEMANTIC AUDIT EVENT VERIFICATION & PRIVACY CHECK
    // =========================================================================
    describe('12. Semantic Audit Events & Privacy Sanitization Verification', () => {
        let auditTargetUser;

        after(async () => {
            if (auditTargetUser) {
                await prisma.invitation.deleteMany({ where: { userId: auditTargetUser.id } }).catch(() => {});
                await prisma.userPermission.deleteMany({ where: { userId: auditTargetUser.id } }).catch(() => {});
                await prisma.user.delete({ where: { id: auditTargetUser.id } }).catch(() => {});
            }
        });

        it('CREATE_USER and INVITATION_CREATED audit logs recorded with correct metadata', async () => {
            const email = `audit_member_${Date.now()}@test.com`;
            const res = await fetch(`${baseUrl}/api/team`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': ownerCsrfToken,
                    Cookie: ownerCookie
                },
                body: JSON.stringify({
                    name: 'Audit Member',
                    email,
                    roleId: staffRole.id
                })
            });
            assert.strictEqual(res.status, 201);
            const json = await res.json();
            auditTargetUser = json.data.user;

            const createUserLog = await prisma.userActivityLog.findFirst({
                where: {
                    action: 'CREATE_USER',
                    targetId: String(auditTargetUser.id)
                }
            });
            assert.ok(createUserLog, 'CREATE_USER activity log must exist');
            assert.strictEqual(createUserLog.module, 'TEAM');
            assert.strictEqual(createUserLog.actorUserId, testOwner.id);

            const inviteLog = await prisma.userActivityLog.findFirst({
                where: {
                    action: 'INVITATION_CREATED',
                    targetId: String(auditTargetUser.id)
                }
            });
            assert.ok(inviteLog, 'INVITATION_CREATED activity log must exist');
        });

        it('ASSIGN_ROLE audit log recorded with oldRole and newRole metadata', async () => {
            await teamService.updateTeamMember(testOwner.id, auditTargetUser.id, {
                roleId: viewerRole.id
            });

            const roleLog = await prisma.userActivityLog.findFirst({
                where: {
                    action: 'ASSIGN_ROLE',
                    targetId: String(auditTargetUser.id)
                },
                orderBy: { createdAt: 'desc' }
            });
            assert.ok(roleLog, 'ASSIGN_ROLE activity log must exist');
            const meta = roleLog.metadata;
            assert.strictEqual(meta.oldRole, 'STAFF');
            assert.strictEqual(meta.newRole, 'VIEWER');
        });

        it('CHANGE_PERMISSIONS audit log recorded with effective permissions', async () => {
            const teamViewPerm = await prisma.permission.findUnique({
                where: { module_action: { module: 'TEAM', action: 'VIEW' } }
            });

            await teamService.updateTeamMember(testOwner.id, auditTargetUser.id, {
                permissionIds: [teamViewPerm.id]
            });

            const permLog = await prisma.userActivityLog.findFirst({
                where: {
                    action: 'CHANGE_PERMISSIONS',
                    targetId: String(auditTargetUser.id)
                },
                orderBy: { createdAt: 'desc' }
            });
            assert.ok(permLog, 'CHANGE_PERMISSIONS activity log must exist');
            const meta = permLog.metadata;
            assert.ok(Array.isArray(meta.changedPermissions));
            assert.ok(meta.changedPermissions.includes('TEAM:VIEW'));
        });

        it('Privacy check: Activity records NEVER leak passwords, hashes, tokens, or session IDs', async () => {
            const recentLogs = await prisma.userActivityLog.findMany({
                take: 50,
                orderBy: { createdAt: 'desc' }
            });
            assert.ok(recentLogs.length > 0);

            for (const log of recentLogs) {
                const serialized = JSON.stringify(log);
                assert.strictEqual(serialized.includes('$2b$'), false, 'Log must not contain bcrypt hashes');
                assert.strictEqual(serialized.toLowerCase().includes('password123'), false, 'Log must not contain test password literals');
                assert.strictEqual(serialized.includes('spark.sid'), false, 'Log must not contain session IDs');
            }
        });
    });
});
