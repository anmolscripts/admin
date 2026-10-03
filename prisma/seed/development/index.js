'use strict';

const bcrypt = require('bcrypt');
const { seedCommon } = require('../common');

/**
 * Standard business terms used for local development setup.
 */
const STANDARD_TERMS = [
    '1. All work is done adhering to government standards and ISI approved.',
    '2. Work is done to the customer\'s utmost satisfaction.',
    '3. 18% GST is excluded.',
    '4. 50% advance is required before work is conducted.'
].join('\n');

/**
 * Executes development seed.
 *
 * Seeds:
 * 1. System RBAC (Roles, Permissions, RolePermissions)
 * 2. Predefined Unit Master (13 units)
 * 3. Predefined Item Master (21 items)
 * 4. Development Administrator (with OWNER role)
 * 5. Optional demo data (invoices, quotations, clients, business profile)
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {Object} [options={}]
 * @param {string} [options.adminEmail]
 * @param {string} [options.adminPassword]
 * @param {boolean} [options.seedDemoData=true]
 * @returns {Promise<Object>} Summary of development seed
 */
async function seedDevelopment(prisma, options = {}) {
    console.log('[SEED] Running development seed...');

    const email = options.adminEmail || process.env.SEED_ADMIN_EMAIL || 'admin@email.com';
    const password = options.adminPassword || process.env.SEED_ADMIN_PASSWORD;

    if (!password) {
        throw new Error('SEED_ADMIN_PASSWORD is required for development seed.');
    }

    // 1. Seed RBAC and Master Data
    await seedCommon(prisma, null);

    const ownerRole = await prisma.role.findUnique({ where: { name: 'OWNER' } });
    if (!ownerRole) {
        throw new Error('OWNER role was not found after RBAC seeding.');
    }

    // 2. Initial / Development Administrator
    let admin = await prisma.user.findUnique({ where: { email } });
    if (!admin) {
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
        console.log(`[SEED] Development admin created: ${admin.email}`);
    } else {
        if (admin.roleId !== ownerRole.id) {
            admin = await prisma.user.update({
                where: { id: admin.id },
                data: { roleId: ownerRole.id, status: 'ACTIVE', active: true }
            });
            console.log(`[SEED] Updated existing admin with OWNER role: ${email}`);
        } else {
            console.log(`[SEED] Admin already exists with OWNER role: ${email}`);
        }
    }

    // Associate admin with unowned units and items
    await prisma.unit.updateMany({
        where: { createdById: null },
        data: { createdById: admin.id }
    });
    await prisma.item.updateMany({
        where: { createdById: null },
        data: { createdById: admin.id }
    });

    // 3. Demo Data (Invoices, Quotations, Profile, Clients)
    const seedDemoData = options.seedDemoData !== undefined
        ? options.seedDemoData
        : (process.env.SEED_DEMO_DATA !== 'false');

    if (seedDemoData) {
        console.log('[SEED] Seeding development demo data...');

        // 3a. Development Invoices
        const existingInvoicesCount = await prisma.invoice.count({
            where: { documentType: 'INVOICE' }
        });

        if (existingInvoicesCount === 0) {
            console.log('[SEED] Seeding development invoice data...');

            // 1. ACTIVE Invoice
            const invoice1 = await prisma.invoice.create({
                data: {
                    documentType: 'INVOICE',
                    invoiceNumber: 'INV-2026-0001',
                    clientName: 'Acme Corporation',
                    invoiceDate: new Date('2026-02-15'),
                    gstEnabled: true,
                    gstRate: '18.00',
                    subtotal: '120000.00',
                    gstAmount: '21600.00',
                    roundOff: '0.00',
                    grandTotal: '141600.00',
                    status: 'ACTIVE',
                    version: 2,
                    createdById: admin.id,
                    updatedById: admin.id,
                    items: {
                        create: [
                            { lineNumber: 1, name: 'Web Application Development', quantity: '1.00', unit: 'Project', rate: '75000.00', amount: '75000.00' },
                            { lineNumber: 2, name: 'Cloud Infrastructure & Hosting', quantity: '12.00', unit: 'Months', rate: '2500.00', amount: '30000.00' },
                            { lineNumber: 3, name: 'UI/UX Design System', quantity: '1.00', unit: 'Package', rate: '15000.00', amount: '15000.00' }
                        ]
                    }
                },
                include: { items: true }
            });

            await prisma.invoiceRevision.createMany({
                data: [
                    {
                        invoiceId: invoice1.id,
                        revisionNo: 1,
                        action: 'CREATED',
                        changedById: admin.id,
                        changes: { action: 'CREATED', summary: 'Invoice INV-2026-0001 created with 3 items.' },
                        snapshot: invoice1
                    },
                    {
                        invoiceId: invoice1.id,
                        revisionNo: 2,
                        action: 'UPDATED',
                        changedById: admin.id,
                        changes: { action: 'UPDATED', summary: 'Updated cloud hosting terms.' },
                        snapshot: invoice1
                    }
                ]
            });

            // 2. INACTIVE Invoice
            const invoice2 = await prisma.invoice.create({
                data: {
                    documentType: 'INVOICE',
                    invoiceNumber: 'INV-2026-0002',
                    clientName: 'Globex Logistics Ltd',
                    invoiceDate: new Date('2026-02-20'),
                    gstEnabled: false,
                    gstRate: '0.00',
                    subtotal: '57500.00',
                    gstAmount: '0.00',
                    roundOff: '0.00',
                    grandTotal: '57500.00',
                    status: 'INACTIVE',
                    version: 2,
                    createdById: admin.id,
                    updatedById: admin.id,
                    items: {
                        create: [
                            { lineNumber: 1, name: 'Fleet Management Software License', quantity: '1.00', unit: 'License', rate: '45000.00', amount: '45000.00' },
                            { lineNumber: 2, name: 'Annual Technical Support Plan', quantity: '1.00', unit: 'Year', rate: '12500.00', amount: '12500.00' }
                        ]
                    }
                },
                include: { items: true }
            });

            await prisma.invoiceRevision.createMany({
                data: [
                    {
                        invoiceId: invoice2.id,
                        revisionNo: 1,
                        action: 'CREATED',
                        changedById: admin.id,
                        changes: { action: 'CREATED', summary: 'Invoice INV-2026-0002 created with 2 items.' },
                        snapshot: invoice2
                    },
                    {
                        invoiceId: invoice2.id,
                        revisionNo: 2,
                        action: 'DEACTIVATED',
                        changedById: admin.id,
                        changes: { action: 'DEACTIVATED', reason: 'Awaiting client contract renewal.' },
                        snapshot: invoice2
                    }
                ]
            });

            // 3. VOID Invoice
            const invoice3 = await prisma.invoice.create({
                data: {
                    documentType: 'INVOICE',
                    invoiceNumber: 'INV-2026-0003',
                    clientName: 'Stark Industries',
                    invoiceDate: new Date('2026-02-25'),
                    gstEnabled: true,
                    gstRate: '12.00',
                    subtotal: '40002.50',
                    gstAmount: '4800.30',
                    roundOff: '0.20',
                    grandTotal: '44803.00',
                    status: 'VOID',
                    version: 2,
                    createdById: admin.id,
                    updatedById: admin.id,
                    items: {
                        create: [
                            { lineNumber: 1, name: 'Prototype Hardware Sensors', quantity: '10.00', unit: 'Units', rate: '3250.25', amount: '32502.50' },
                            { lineNumber: 2, name: 'Calibration & Testing Services', quantity: '5.00', unit: 'Hours', rate: '1500.00', amount: '7500.00' }
                        ]
                    }
                },
                include: { items: true }
            });

            await prisma.invoiceRevision.createMany({
                data: [
                    {
                        invoiceId: invoice3.id,
                        revisionNo: 1,
                        action: 'CREATED',
                        changedById: admin.id,
                        changes: { action: 'CREATED', summary: 'Invoice INV-2026-0003 created with 2 items.' },
                        snapshot: invoice3
                    },
                    {
                        invoiceId: invoice3.id,
                        revisionNo: 2,
                        action: 'VOIDED',
                        changedById: admin.id,
                        changes: { action: 'VOIDED', reason: 'Order canceled by client.' },
                        snapshot: invoice3
                    }
                ]
            });

            console.log('[SEED] Seeded 3 development invoices (ACTIVE, INACTIVE, VOID).');
        }

        // 3b. Development Quotations
        const existingQuotationsCount = await prisma.invoice.count({
            where: { documentType: 'QUOTATION' }
        });

        if (existingQuotationsCount === 0) {
            console.log('[SEED] Seeding development quotation data...');

            // 1. ACTIVE Quotation
            const qtn1 = await prisma.invoice.create({
                data: {
                    documentType: 'QUOTATION',
                    invoiceNumber: 'QTN-2026-0001',
                    clientName: 'Nexus Cybernetics',
                    invoiceDate: new Date('2026-03-01'),
                    gstEnabled: true,
                    gstRate: '18.00',
                    subtotal: '85000.00',
                    gstAmount: '15300.00',
                    roundOff: '0.00',
                    grandTotal: '100300.00',
                    status: 'ACTIVE',
                    version: 1,
                    createdById: admin.id,
                    updatedById: admin.id,
                    items: {
                        create: [
                            { lineNumber: 1, name: 'AI Pipeline Architecture Design', quantity: '1.00', unit: 'Project', rate: '55000.00', amount: '55000.00' },
                            { lineNumber: 2, name: 'Data Pipeline Engineering', quantity: '20.00', unit: 'Hours', rate: '1500.00', amount: '30000.00' }
                        ]
                    }
                },
                include: { items: true }
            });

            await prisma.invoiceRevision.create({
                data: {
                    invoiceId: qtn1.id,
                    revisionNo: 1,
                    action: 'CREATED',
                    changedById: admin.id,
                    changes: { action: 'CREATED', summary: 'Quotation QTN-2026-0001 created.' },
                    snapshot: qtn1
                }
            });

            // 2. INACTIVE Quotation
            const qtn2 = await prisma.invoice.create({
                data: {
                    documentType: 'QUOTATION',
                    invoiceNumber: 'QTN-2026-0002',
                    clientName: 'Solaris Energy Ltd',
                    invoiceDate: new Date('2026-03-05'),
                    gstEnabled: true,
                    gstRate: '12.00',
                    subtotal: '45000.00',
                    gstAmount: '5400.00',
                    roundOff: '0.00',
                    grandTotal: '50400.00',
                    status: 'INACTIVE',
                    version: 2,
                    createdById: admin.id,
                    updatedById: admin.id,
                    items: {
                        create: [
                            { lineNumber: 1, name: 'Solar Array Telemetry Software', quantity: '1.00', unit: 'System', rate: '45000.00', amount: '45000.00' }
                        ]
                    }
                },
                include: { items: true }
            });

            await prisma.invoiceRevision.createMany({
                data: [
                    {
                        invoiceId: qtn2.id,
                        revisionNo: 1,
                        action: 'CREATED',
                        changedById: admin.id,
                        changes: { action: 'CREATED', summary: 'Quotation QTN-2026-0002 created.' },
                        snapshot: qtn2
                    },
                    {
                        invoiceId: qtn2.id,
                        revisionNo: 2,
                        action: 'DEACTIVATED',
                        changedById: admin.id,
                        changes: { action: 'DEACTIVATED', reason: 'Client requested postponement to next quarter.' },
                        snapshot: qtn2
                    }
                ]
            });

            console.log('[SEED] Seeded 2 development quotations (ACTIVE, INACTIVE).');
        }

        // 3c. Synchronize Development Number Sequences
        const currentYear = 2026;
        const invSeq = await prisma.invoiceNumberSequence.findUnique({
            where: { documentType_year: { documentType: 'INVOICE', year: currentYear } }
        });
        if (!invSeq) {
            await prisma.invoiceNumberSequence.create({
                data: { documentType: 'INVOICE', year: currentYear, currentNumber: 3 }
            });
        }

        const qtnSeq = await prisma.invoiceNumberSequence.findUnique({
            where: { documentType_year: { documentType: 'QUOTATION', year: currentYear } }
        });
        if (!qtnSeq) {
            await prisma.invoiceNumberSequence.create({
                data: { documentType: 'QUOTATION', year: currentYear, currentNumber: 2 }
            });
        }

        // 3d. Seed or Update Development Business Profile
        let profile = await prisma.businessProfile.findFirst();
        if (!profile) {
            await prisma.businessProfile.create({
                data: {
                    legalName: 'Spark Admin Technologies Pvt Ltd',
                    displayName: 'Spark Admin',
                    gstin: '27AABCS1429B1ZB',
                    stateCode: '27',
                    email: 'billing@sparkadmin.io',
                    phone: '+91 98765 43210',
                    address: 'Level 5, Spark Tower, BKC, Bandra East, Mumbai 400051',
                    defaultTerms: STANDARD_TERMS,
                    defaultRemarks: 'Thank you for your business!'
                }
            });
            console.log('[SEED] Default business profile seeded with standard terms.');
        } else {
            await prisma.businessProfile.update({
                where: { id: profile.id },
                data: { defaultTerms: STANDARD_TERMS }
            });
            console.log('[SEED] Business profile default terms updated with standard notes.');
        }

        // 3e. Sample Development Clients
        const clientsCount = await prisma.client.count();
        if (clientsCount === 0) {
            await prisma.client.createMany({
                data: [
                    {
                        name: 'Tata Consultancy Services',
                        email: 'billing@tcs.example.com',
                        phone: '+91 22 6778 9999',
                        gstin: '27AAACT2727Q1ZW',
                        stateCode: '27',
                        billingAddress: 'TCS House, Raveline Street, Fort, Mumbai 400001',
                        shippingAddress: 'TCS Olympus, Thane West, Mumbai 400607',
                        active: true,
                        createdById: admin.id
                    },
                    {
                        name: 'Infosys Limited',
                        email: 'accounts@infosys.example.com',
                        phone: '+91 80 2852 0261',
                        gstin: '29AAACI4818H1ZP',
                        stateCode: '29',
                        billingAddress: 'Electronics City, Hosur Road, Bengaluru 560100',
                        shippingAddress: 'Electronics City, Hosur Road, Bengaluru 560100',
                        active: true,
                        createdById: admin.id
                    }
                ]
            });
            console.log('[SEED] Sample development clients seeded.');
        }
    }

    console.log('[SEED] Development seed complete.');

    return {
        isProduction: false,
        seedDemoData,
        adminEmail: admin ? admin.email : null,
        adminId: admin ? admin.id : null,
        unitsCount: await prisma.unit.count(),
        itemsCount: await prisma.item.count(),
        businessProfileCount: await prisma.businessProfile.count(),
        clientsCount: await prisma.client.count(),
        invoicesCount: await prisma.invoice.count({ where: { documentType: 'INVOICE' } }),
        quotationsCount: await prisma.invoice.count({ where: { documentType: 'QUOTATION' } }),
        paymentsCount: await prisma.payment.count(),
        revisionsCount: await prisma.invoiceRevision.count(),
        activityLogsCount: await prisma.userActivityLog.count(),
        rolesCount: await prisma.role.count(),
        permissionsCount: await prisma.permission.count()
    };
}

module.exports = {
    seedDevelopment,
    STANDARD_TERMS
};
