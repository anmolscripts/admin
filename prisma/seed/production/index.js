'use strict';

const bcrypt = require('bcrypt');
const { seedCommon } = require('../common');

const DEFAULT_SALT_ROUNDS = 12;

function getSaltRounds() {
    const rounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10);
    return Number.isInteger(rounds) && rounds >= 10 ? rounds : DEFAULT_SALT_ROUNDS;
}

/**
 * Executes production seed.
 *
 * Strictly provisions ONLY:
 * 1. System RBAC (Roles, Permissions, RolePermissions)
 * 2. Predefined Unit Master (13 units)
 * 3. Business-scoped chart of accounts (no sample items)
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

    const bootstrapEmail = options.adminEmail || process.env.SEED_ADMIN_EMAIL;
    const bootstrapPassword = options.adminPassword || process.env.SEED_ADMIN_PASSWORD;
    if (!bootstrapEmail || !bootstrapEmail.includes('@') || !bootstrapPassword || bootstrapPassword.length < 8) {
        throw new Error('Fresh production bootstrap requires explicit administrator credentials.');
    }
    // This module must not become an upgrade or account-recovery mechanism.
    for (const model of ['user', 'client', 'invoice', 'payment', 'businessProfile']) {
        if (await prisma[model].count()) throw new Error('Production bootstrap requires a freshly reset database; existing records were preserved.');
    }

    console.log('================================================================');
    console.log('[SEED POLICY] PRODUCTION SEED INITIATED');
    console.log('[SEED POLICY] Permitted seeds: RBAC roles/permissions, OWNER admin, units, accounts; no sample items');
    console.log('[SEED POLICY] Strictly excluded: business profile, clients, invoices, quotations, payments, revisions, logs');
    console.log('================================================================');

    // 1. Seed required system records, without the sample item catalog.
    await seedCommon(prisma, null, { includeItems: false });

    const ownerRole = await prisma.role.findUnique({ where: { name: 'OWNER' } });
    if (!ownerRole) {
        throw new Error('OWNER role was not found after RBAC seeding.');
    }

    // 2. Initial OWNER Administrator
    const email = bootstrapEmail;

    let admin = email ? await prisma.user.findUnique({ where: { email } }) : null;

    if (!admin) {
        const password = bootstrapPassword;

        if (options.requireAdmin === true || (options.adminEmail && !password)) {
            if (!email) {
                throw new Error('[SEED POLICY] Production seed requires explicit admin email (adminEmail or SEED_ADMIN_EMAIL).');
            }
            if (!password) {
                throw new Error('[SEED POLICY] Production seed requires explicit admin password (adminPassword or SEED_ADMIN_PASSWORD).');
            }
        }

        if (password) {
            const passwordHash = await bcrypt.hash(password, getSaltRounds());
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
        } else {
            console.log('[SEED POLICY] No password provided for initial admin; skipping admin creation.');
        }
    } else {
        throw new Error('An administrator account appeared during bootstrap; refusing to overwrite or promote it.');
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
