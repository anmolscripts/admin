'use strict';

const bcrypt = require('bcrypt');
const { seedCommon } = require('../common');

/**
 * Executes production seed.
 *
 * Strictly provisions ONLY:
 * 1. System RBAC (Roles, Permissions, RolePermissions)
 * 2. Predefined Unit Master (13 units)
 * 3. Predefined Item Master (21 items)
 * 4. Explicitly provisioned initial OWNER administrator
 *
 * NEVER seeds business profile, clients, quotations, invoices, payments, revisions, or activity logs.
 * Hard-fails if demo seeding is requested.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {Object} [options={}]
 * @param {string} [options.adminEmail]
 * @param {string} [options.adminPassword]
 * @param {boolean} [options.seedDemoData]
 * @returns {Promise<Object>} Summary of production seed
 */
async function seedProduction(prisma, options = {}) {
    if (options.seedDemoData === true) {
        throw new Error('[FATAL SEED POLICY VIOLATION] Demo data seeding is strictly prohibited in production mode!');
    }

    console.log('================================================================');
    console.log('[SEED POLICY] PRODUCTION SEED INITIATED');
    console.log('[SEED POLICY] Permitted seeds: RBAC roles/permissions, OWNER admin, units, items');
    console.log('[SEED POLICY] Strictly excluded: business profile, clients, invoices, quotations, payments, revisions, logs');
    console.log('================================================================');

    // 1. Seed RBAC and Master Data (units + items)
    await seedCommon(prisma, null);

    const ownerRole = await prisma.role.findUnique({ where: { name: 'OWNER' } });
    if (!ownerRole) {
        throw new Error('OWNER role was not found after RBAC seeding.');
    }

    // 2. Initial OWNER Administrator
    const email = options.adminEmail || process.env.SEED_ADMIN_EMAIL || 'admin@email.com';
    let admin = await prisma.user.findUnique({ where: { email } });

    if (!admin) {
        const password = options.adminPassword || process.env.SEED_ADMIN_PASSWORD;
        if (!password) {
            console.log('[SEED POLICY] SEED_ADMIN_PASSWORD not set. Skipping initial admin user creation in production.');
        } else {
            const passwordHash = await bcrypt.hash(password, 12);
            admin = await prisma.user.create({
                data: {
                    name: 'Administrator',
                    email,
                    password: passwordHash,
                    role: 'ADMIN',
                    roleId: ownerRole.id,
                    status: 'ACTIVE',
                    active: true
                }
            });
            console.log(`[SEED POLICY] Initial production OWNER administrator provisioned: ${email}`);
        }
    } else {
        if (admin.roleId !== ownerRole.id) {
            admin = await prisma.user.update({
                where: { id: admin.id },
                data: { roleId: ownerRole.id, status: 'ACTIVE', active: true }
            });
            console.log(`[SEED POLICY] Updated existing user with OWNER role: ${email}`);
        } else {
            console.log(`[SEED POLICY] Production administrator already exists with OWNER role: ${email}`);
        }
    }

    // Associate admin with unowned units and items if available
    if (admin) {
        await prisma.unit.updateMany({
            where: { createdById: null },
            data: { createdById: admin.id }
        });
        await prisma.item.updateMany({
            where: { createdById: null },
            data: { createdById: admin.id }
        });
    }

    // 3. Strict Invariant Verification: Production DB must have ZERO demo records
    const businessProfileCount = await prisma.businessProfile.count();
    const clientsCount = await prisma.client.count();
    const invoicesCount = await prisma.invoice.count({ where: { documentType: 'INVOICE' } });
    const quotationsCount = await prisma.invoice.count({ where: { documentType: 'QUOTATION' } });
    const paymentsCount = await prisma.payment.count();
    const revisionsCount = await prisma.invoiceRevision.count();
    const activityLogsCount = await prisma.userActivityLog.count();

    const unitsCount = await prisma.unit.count();
    const itemsCount = await prisma.item.count();
    const rolesCount = await prisma.role.count();
    const permissionsCount = await prisma.permission.count();

    console.log('[SEED POLICY] Production seed verification complete.');

    return {
        isProduction: true,
        seedDemoData: false,
        adminEmail: admin ? admin.email : null,
        adminId: admin ? admin.id : null,
        unitsCount,
        itemsCount,
        businessProfileCount,
        clientsCount,
        invoicesCount,
        quotationsCount,
        paymentsCount,
        revisionsCount,
        activityLogsCount,
        rolesCount,
        permissionsCount
    };
}

module.exports = {
    seedProduction
};
