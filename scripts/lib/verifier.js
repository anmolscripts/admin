'use strict';

/**
 * Deterministic database and seed invariants verifier for Spark Admin.
 */

/**
 * Runs deterministic verification of the database state.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {'development'|'production'} mode
 * @returns {Promise<{ ok: boolean, checks: Array<{ name: string, pass: boolean, detail: string }>, summary: Object }>}
 */
async function verifyDatabaseState(prisma, mode) {
    const isProduction = mode === 'production';
    const checks = [];

    // 1. Prisma Client & Connectivity Check
    let dbConnected = false;
    try {
        await prisma.$queryRaw`SELECT 1`;
        dbConnected = true;
        checks.push({ name: 'Database Connectivity', pass: true, detail: 'Successfully queried database' });
    } catch (err) {
        checks.push({ name: 'Database Connectivity', pass: false, detail: err.message });
        return { ok: false, checks, summary: {} };
    }

    // 2. RBAC System Roles & Permissions
    const roles = await prisma.role.findMany();
    const roleNames = new Set(roles.map(r => r.name));
    const REQUIRED_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER'];
    for (const reqRole of REQUIRED_ROLES) {
        const hasRole = roleNames.has(reqRole);
        checks.push({
            name: `RBAC Role: ${reqRole}`,
            pass: hasRole,
            detail: hasRole ? `System role '${reqRole}' is present` : `System role '${reqRole}' is missing`
        });
    }

    const permissionsCount = await prisma.permission.count();
    checks.push({
        name: 'RBAC Permissions',
        pass: permissionsCount >= 56,
        detail: `Found ${permissionsCount} permissions seeded (required: >= 56)`
    });

    const rolePermissionsCount = await prisma.rolePermission.count();
    checks.push({
        name: 'Role Permission Mappings',
        pass: rolePermissionsCount > 0,
        detail: `Found ${rolePermissionsCount} role permission mappings`
    });

    // 3. Units Master (13 predefined units)
    const unitsCount = await prisma.unit.count();
    checks.push({
        name: 'Unit Master Data',
        pass: isProduction ? (unitsCount === 13) : (unitsCount >= 13),
        detail: `Found ${unitsCount} units (required: ${isProduction ? 'exact 13' : '>= 13'})`
    });

    // 4. Items Master (21 predefined items)
    const itemsCount = await prisma.item.count();
    checks.push({
        name: 'Item Master Data',
        pass: isProduction ? (itemsCount === 21) : (itemsCount >= 21),
        detail: `Found ${itemsCount} items (required: ${isProduction ? 'exact 21' : '>= 21'})`
    });

    // 5. Initial Administrator (OWNER role)
    const ownerRole = roles.find(r => r.name === 'OWNER');
    const adminUser = await prisma.user.findFirst({
        where: {
            OR: [
                { roleId: ownerRole ? ownerRole.id : undefined },
                { role: 'ADMIN' }
            ],
            active: true
        }
    });
    checks.push({
        name: 'Administrator Account',
        pass: Boolean(adminUser),
        detail: adminUser ? `Active admin found: ${adminUser.email} (ID: ${adminUser.id})` : 'No active administrator found'
    });

    // Production Invariant Checks
    let prodInvariantsPass = true;
    const clientsCount = await prisma.client.count();
    const invoicesCount = await prisma.invoice.count({ where: { documentType: 'INVOICE' } });
    const quotationsCount = await prisma.invoice.count({ where: { documentType: 'QUOTATION' } });
    const paymentsCount = await prisma.payment.count();
    const revisionsCount = await prisma.invoiceRevision.count();
    const activityLogsCount = await prisma.userActivityLog.count();
    const businessProfileCount = await prisma.businessProfile.count();

    if (isProduction) {
        checks.push({
            name: 'Zero Demo Clients Invariant',
            pass: clientsCount === 0,
            detail: `Found ${clientsCount} clients (must be 0 in production)`
        });

        checks.push({
            name: 'Zero Invoices Invariant',
            pass: invoicesCount === 0,
            detail: `Found ${invoicesCount} invoices (must be 0 in production)`
        });

        checks.push({
            name: 'Zero Quotations Invariant',
            pass: quotationsCount === 0,
            detail: `Found ${quotationsCount} quotations (must be 0 in production)`
        });

        checks.push({
            name: 'Zero Payments Invariant',
            pass: paymentsCount === 0,
            detail: `Found ${paymentsCount} payments (must be 0 in production)`
        });

        checks.push({
            name: 'Zero Revisions Invariant',
            pass: revisionsCount === 0,
            detail: `Found ${revisionsCount} revisions (must be 0 in production)`
        });

        checks.push({
            name: 'Zero Activity Logs Invariant',
            pass: activityLogsCount === 0,
            detail: `Found ${activityLogsCount} activity logs (must be 0 in production)`
        });

        checks.push({
            name: 'Zero Business Profile Invariant',
            pass: businessProfileCount === 0,
            detail: `Found ${businessProfileCount} business profiles (must be 0 in production until set by owner)`
        });

        prodInvariantsPass = (
            clientsCount === 0 &&
            invoicesCount === 0 &&
            quotationsCount === 0 &&
            paymentsCount === 0 &&
            revisionsCount === 0 &&
            activityLogsCount === 0 &&
            businessProfileCount === 0
        );
    }

    const allPass = checks.every(c => c.pass);

    return {
        ok: allPass,
        checks,
        summary: {
            mode,
            admin: adminUser ? { id: adminUser.id, email: adminUser.email } : null,
            counts: {
                roles: roles.length,
                permissions: permissionsCount,
                units: unitsCount,
                items: itemsCount,
                clients: clientsCount,
                invoices: invoicesCount,
                quotations: quotationsCount,
                payments: paymentsCount,
                revisions: revisionsCount,
                activityLogs: activityLogsCount,
                businessProfiles: businessProfileCount
            }
        }
    };
}

module.exports = {
    verifyDatabaseState
};
