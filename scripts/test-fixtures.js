'use strict';

/**
 * ==============================================================================
 * SPARK ADMIN — DETERMINISTIC TEST FIXTURE MANAGER
 * ==============================================================================
 *
 * Dedicated test fixture architecture:
 * 1. Guarantees deterministic business fixtures required by integration test suites
 *    (e.g. documents.test.js, invoice.test.js, auth.test.js).
 * 2. Does NOT depend on test execution order.
 * 3. Keeps production seed strictly isolated and clean (zero demo data in production).
 * 4. Ensures test admin credentials match SEED_ADMIN_PASSWORD explicitly.
 * 5. Synchronizes invoice and quotation sequence numbers to prevent collision.
 * ==============================================================================
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const prisma = require('../app/config/prisma');
const { seedCommon } = require('../prisma/seed/common');
const { STANDARD_TERMS } = require('../prisma/seed/development');
const { ensureFinancialYear } = require('../app/services/financialYear.service');

const DEFAULT_SALT_ROUNDS = 12;

function getSaltRounds() {
    const rounds = parseInt(process.env.BCRYPT_SALT_ROUNDS, 10);
    return Number.isInteger(rounds) && rounds >= 10 ? rounds : DEFAULT_SALT_ROUNDS;
}

async function applyTestFixtures(options = {}) {
    const adminEmail = options.adminEmail || process.env.SEED_ADMIN_EMAIL || 'admin@email.com';
    const adminPassword = options.adminPassword || process.env.SEED_ADMIN_PASSWORD;

    if (!adminPassword || !adminPassword.trim()) {
        throw new Error('SEED_ADMIN_PASSWORD is required to apply test fixtures.');
    }

    // 1. Ensure RBAC and Master Data (units + items)
    await seedCommon(prisma, null);

    const ownerRole = await prisma.role.findUnique({ where: { name: 'OWNER' } });
    if (!ownerRole) {
        throw new Error('OWNER role was not found after RBAC seeding.');
    }

    // 2. Ensure Test Administrator with explicit password and OWNER role
    const passwordHash = await bcrypt.hash(adminPassword.trim(), getSaltRounds());
    let admin = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (!admin) {
        admin = await prisma.user.create({
            data: {
                name: 'Administrator',
                email: adminEmail,
                password: passwordHash,
                role: 'ADMIN',
                roleId: ownerRole.id,
                status: 'ACTIVE',
                active: true
            }
        });
    } else {
        admin = await prisma.user.update({
            where: { id: admin.id },
            data: {
                password: passwordHash,
                roleId: ownerRole.id,
                status: 'ACTIVE',
                active: true
            }
        });
    }

    // Associate unowned units, items, and accounts with test admin
    await prisma.unit.updateMany({
        where: { createdById: null },
        data: { createdById: admin.id }
    });
    await prisma.item.updateMany({
        where: { createdById: null },
        data: { createdById: admin.id }
    });
    await prisma.chartOfAccount.updateMany({
        where: { createdById: null },
        data: { createdById: admin.id }
    });

    // 3. Ensure Business Profile
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
    } else {
        await prisma.businessProfile.update({
            where: { id: profile.id },
            data: { defaultTerms: STANDARD_TERMS }
        });
    }

    // 4. Ensure Sample Clients
    const tcs = await prisma.client.findFirst({ where: { email: 'billing@tcs.example.com' } });
    if (!tcs) {
        await prisma.client.create({
            data: {
                name: 'Tata Consultancy Services',
                email: 'billing@tcs.example.com',
                phone: '+91 22 6778 9999',
                gstin: '27AAACT2727Q1ZW',
                stateCode: '27',
                billingAddress: 'TCS House, Raveline Street, Fort, Mumbai 400001',
                shippingAddress: 'TCS Olympus, Thane West, Mumbai 400607',
                active: true,
                createdById: admin.id
            }
        });
    }

    const infosys = await prisma.client.findFirst({ where: { email: 'accounts@infosys.example.com' } });
    if (!infosys) {
        await prisma.client.create({
            data: {
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
        });
    }

    // 5. Deterministic Document Fixtures
    const fy2025_26 = await ensureFinancialYear(new Date('2026-02-15'));

    // 5a. INV-2026-0001 (ACTIVE, Acme Corporation, Feb 15 2026)
    const inv1 = await prisma.invoice.findUnique({
        where: { invoiceNumber: 'INV-2026-0001' },
        include: { items: true, revisions: true }
    });

    const inv1Data = {
        documentType: 'INVOICE',
        invoiceNumber: 'INV-2026-0001',
        clientName: 'Acme Corporation',
        invoiceDate: new Date('2026-02-15'),
        financialYearId: fy2025_26.id,
        gstEnabled: true,
        gstRate: '18.00',
        subtotal: '120000.00',
        gstAmount: '21600.00',
        roundOff: '0.00',
        grandTotal: '141600.00',
        status: 'ACTIVE',
        version: 2,
        deletedAt: null,
        createdById: admin.id,
        updatedById: admin.id
    };

    const inv1Items = [
        { lineNumber: 1, name: 'Web Application Development', quantity: '1.00', unit: 'Project', rate: '75000.00', amount: '75000.00' },
        { lineNumber: 2, name: 'Cloud Infrastructure & Hosting', quantity: '12.00', unit: 'Months', rate: '2500.00', amount: '30000.00' },
        { lineNumber: 3, name: 'UI/UX Design System', quantity: '1.00', unit: 'Package', rate: '15000.00', amount: '15000.00' }
    ];

    if (!inv1) {
        const created1 = await prisma.invoice.create({
            data: {
                ...inv1Data,
                items: { create: inv1Items }
            }
        });
        await prisma.invoiceRevision.createMany({
            data: [
                {
                    invoiceId: created1.id,
                    revisionNo: 1,
                    action: 'CREATED',
                    changedById: admin.id,
                    changes: { action: 'CREATED', summary: 'Invoice INV-2026-0001 created with 3 items.' },
                    snapshot: created1
                },
                {
                    invoiceId: created1.id,
                    revisionNo: 2,
                    action: 'UPDATED',
                    changedById: admin.id,
                    changes: { action: 'UPDATED', summary: 'Updated cloud hosting terms.' },
                    snapshot: created1
                }
            ]
        });
    } else {
        await prisma.invoice.update({
            where: { id: inv1.id },
            data: inv1Data
        });
        if (inv1.items.length === 0) {
            await prisma.invoiceItem.createMany({
                data: inv1Items.map(item => ({ ...item, invoiceId: inv1.id }))
            });
        }
        if (inv1.revisions.length === 0) {
            await prisma.invoiceRevision.create({
                data: {
                    invoiceId: inv1.id,
                    revisionNo: 1,
                    action: 'CREATED',
                    changedById: admin.id,
                    changes: { action: 'CREATED', summary: 'Invoice INV-2026-0001 created.' },
                    snapshot: inv1
                }
            });
        }
    }

    // 5b. INV-2026-0002 (INACTIVE, Globex Logistics Ltd, Feb 20 2026)
    const inv2 = await prisma.invoice.findUnique({
        where: { invoiceNumber: 'INV-2026-0002' },
        include: { items: true, revisions: true }
    });

    const inv2Data = {
        documentType: 'INVOICE',
        invoiceNumber: 'INV-2026-0002',
        clientName: 'Globex Logistics Ltd',
        invoiceDate: new Date('2026-02-20'),
        financialYearId: fy2025_26.id,
        gstEnabled: false,
        gstRate: '0.00',
        subtotal: '57500.00',
        gstAmount: '0.00',
        roundOff: '0.00',
        grandTotal: '57500.00',
        status: 'INACTIVE',
        version: 2,
        deletedAt: null,
        createdById: admin.id,
        updatedById: admin.id
    };

    const inv2Items = [
        { lineNumber: 1, name: 'Fleet Management Software License', quantity: '1.00', unit: 'License', rate: '45000.00', amount: '45000.00' },
        { lineNumber: 2, name: 'Annual Technical Support Plan', quantity: '1.00', unit: 'Year', rate: '12500.00', amount: '12500.00' }
    ];

    if (!inv2) {
        const created2 = await prisma.invoice.create({
            data: {
                ...inv2Data,
                items: { create: inv2Items }
            }
        });
        await prisma.invoiceRevision.createMany({
            data: [
                {
                    invoiceId: created2.id,
                    revisionNo: 1,
                    action: 'CREATED',
                    changedById: admin.id,
                    changes: { action: 'CREATED', summary: 'Invoice INV-2026-0002 created with 2 items.' },
                    snapshot: created2
                },
                {
                    invoiceId: created2.id,
                    revisionNo: 2,
                    action: 'DEACTIVATED',
                    changedById: admin.id,
                    changes: { action: 'DEACTIVATED', reason: 'Awaiting client contract renewal.' },
                    snapshot: created2
                }
            ]
        });
    } else {
        await prisma.invoice.update({
            where: { id: inv2.id },
            data: inv2Data
        });
        if (inv2.items.length === 0) {
            await prisma.invoiceItem.createMany({
                data: inv2Items.map(item => ({ ...item, invoiceId: inv2.id }))
            });
        }
    }

    // 5c. INV-2026-0003 (VOID, Stark Industries, Feb 25 2026)
    const inv3 = await prisma.invoice.findUnique({
        where: { invoiceNumber: 'INV-2026-0003' },
        include: { items: true, revisions: true }
    });

    const inv3Data = {
        documentType: 'INVOICE',
        invoiceNumber: 'INV-2026-0003',
        clientName: 'Stark Industries',
        invoiceDate: new Date('2026-02-25'),
        financialYearId: fy2025_26.id,
        gstEnabled: true,
        gstRate: '12.00',
        subtotal: '40002.50',
        gstAmount: '4800.30',
        roundOff: '0.20',
        grandTotal: '44803.00',
        status: 'VOID',
        version: 2,
        deletedAt: null,
        createdById: admin.id,
        updatedById: admin.id
    };

    const inv3Items = [
        { lineNumber: 1, name: 'Prototype Hardware Sensors', quantity: '10.00', unit: 'Units', rate: '3250.25', amount: '32502.50' },
        { lineNumber: 2, name: 'Calibration & Testing Services', quantity: '5.00', unit: 'Hours', rate: '1500.00', amount: '7500.00' }
    ];

    if (!inv3) {
        const created3 = await prisma.invoice.create({
            data: {
                ...inv3Data,
                items: { create: inv3Items }
            }
        });
        await prisma.invoiceRevision.createMany({
            data: [
                {
                    invoiceId: created3.id,
                    revisionNo: 1,
                    action: 'CREATED',
                    changedById: admin.id,
                    changes: { action: 'CREATED', summary: 'Invoice INV-2026-0003 created with 2 items.' },
                    snapshot: created3
                },
                {
                    invoiceId: created3.id,
                    revisionNo: 2,
                    action: 'VOIDED',
                    changedById: admin.id,
                    changes: { action: 'VOIDED', reason: 'Order canceled by client.' },
                    snapshot: created3
                }
            ]
        });
    } else {
        await prisma.invoice.update({
            where: { id: inv3.id },
            data: inv3Data
        });
        if (inv3.items.length === 0) {
            await prisma.invoiceItem.createMany({
                data: inv3Items.map(item => ({ ...item, invoiceId: inv3.id }))
            });
        }
    }

    // 5d. QTN-2026-0001 (ACTIVE, Nexus Cybernetics, Mar 01 2026)
    const qtn1 = await prisma.invoice.findUnique({
        where: { invoiceNumber: 'QTN-2026-0001' },
        include: { items: true, revisions: true }
    });

    const qtn1Data = {
        documentType: 'QUOTATION',
        invoiceNumber: 'QTN-2026-0001',
        clientName: 'Nexus Cybernetics',
        invoiceDate: new Date('2026-03-01'),
        financialYearId: fy2025_26.id,
        gstEnabled: true,
        gstRate: '18.00',
        subtotal: '85000.00',
        gstAmount: '15300.00',
        roundOff: '0.00',
        grandTotal: '100300.00',
        status: 'ACTIVE',
        version: 1,
        deletedAt: null,
        createdById: admin.id,
        updatedById: admin.id
    };

    const qtn1Items = [
        { lineNumber: 1, name: 'AI Pipeline Architecture Design', quantity: '1.00', unit: 'Project', rate: '55000.00', amount: '55000.00' },
        { lineNumber: 2, name: 'Data Pipeline Engineering', quantity: '20.00', unit: 'Hours', rate: '1500.00', amount: '30000.00' }
    ];

    if (!qtn1) {
        const createdQ1 = await prisma.invoice.create({
            data: {
                ...qtn1Data,
                items: { create: qtn1Items }
            }
        });
        await prisma.invoiceRevision.create({
            data: {
                invoiceId: createdQ1.id,
                revisionNo: 1,
                action: 'CREATED',
                changedById: admin.id,
                changes: { action: 'CREATED', summary: 'Quotation QTN-2026-0001 created.' },
                snapshot: createdQ1
            }
        });
    } else {
        await prisma.invoice.update({
            where: { id: qtn1.id },
            data: qtn1Data
        });
        if (qtn1.items.length === 0) {
            await prisma.invoiceItem.createMany({
                data: qtn1Items.map(item => ({ ...item, invoiceId: qtn1.id }))
            });
        }
    }

    // 5e. QTN-2026-0002 (INACTIVE, Solaris Energy Ltd, Mar 05 2026)
    const qtn2 = await prisma.invoice.findUnique({
        where: { invoiceNumber: 'QTN-2026-0002' },
        include: { items: true, revisions: true }
    });

    const qtn2Data = {
        documentType: 'QUOTATION',
        invoiceNumber: 'QTN-2026-0002',
        clientName: 'Solaris Energy Ltd',
        invoiceDate: new Date('2026-03-05'),
        financialYearId: fy2025_26.id,
        gstEnabled: true,
        gstRate: '12.00',
        subtotal: '45000.00',
        gstAmount: '5400.00',
        roundOff: '0.00',
        grandTotal: '50400.00',
        status: 'INACTIVE',
        version: 2,
        deletedAt: null,
        createdById: admin.id,
        updatedById: admin.id
    };

    const qtn2Items = [
        { lineNumber: 1, name: 'Solar Array Telemetry Software', quantity: '1.00', unit: 'System', rate: '45000.00', amount: '45000.00' }
    ];

    if (!qtn2) {
        const createdQ2 = await prisma.invoice.create({
            data: {
                ...qtn2Data,
                items: { create: qtn2Items }
            }
        });
        await prisma.invoiceRevision.createMany({
            data: [
                {
                    invoiceId: createdQ2.id,
                    revisionNo: 1,
                    action: 'CREATED',
                    changedById: admin.id,
                    changes: { action: 'CREATED', summary: 'Quotation QTN-2026-0002 created.' },
                    snapshot: createdQ2
                },
                {
                    invoiceId: createdQ2.id,
                    revisionNo: 2,
                    action: 'DEACTIVATED',
                    changedById: admin.id,
                    changes: { action: 'DEACTIVATED', reason: 'Client requested postponement to next quarter.' },
                    snapshot: createdQ2
                }
            ]
        });
    } else {
        await prisma.invoice.update({
            where: { id: qtn2.id },
            data: qtn2Data
        });
        if (qtn2.items.length === 0) {
            await prisma.invoiceItem.createMany({
                data: qtn2Items.map(item => ({ ...item, invoiceId: qtn2.id }))
            });
        }
    }

    // 6. Synchronize Sequence Counters to Prevent Clashing With Fixtures
    const allInvoices2026 = await prisma.invoice.findMany({
        where: { documentType: 'INVOICE', invoiceNumber: { startsWith: 'INV-2026-' } },
        select: { invoiceNumber: true }
    });
    let maxInvNum = 3;
    for (const inv of allInvoices2026) {
        const m = inv.invoiceNumber.match(/^INV-2026-(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n) && n > maxInvNum) maxInvNum = n;
        }
    }
    await prisma.invoiceNumberSequence.upsert({
        where: { documentType_year: { documentType: 'INVOICE', year: 2026 } },
        update: { currentNumber: { set: maxInvNum } },
        create: { documentType: 'INVOICE', year: 2026, currentNumber: maxInvNum }
    });

    const allQuotations2026 = await prisma.invoice.findMany({
        where: { documentType: 'QUOTATION', invoiceNumber: { startsWith: 'QTN-2026-' } },
        select: { invoiceNumber: true }
    });
    let maxQtnNum = 2;
    for (const qtn of allQuotations2026) {
        const m = qtn.invoiceNumber.match(/^QTN-2026-(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n) && n > maxQtnNum) maxQtnNum = n;
        }
    }
    await prisma.invoiceNumberSequence.upsert({
        where: { documentType_year: { documentType: 'QUOTATION', year: 2026 } },
        update: { currentNumber: { set: maxQtnNum } },
        create: { documentType: 'QUOTATION', year: 2026, currentNumber: maxQtnNum }
    });

    // 7. Ensure all existing invoices and payments have financialYearId populated
    const unassignedInvoices = await prisma.invoice.findMany({
        where: { financialYearId: null },
        select: { id: true, invoiceDate: true }
    });
    for (const inv of unassignedInvoices) {
        const fy = await ensureFinancialYear(inv.invoiceDate);
        await prisma.invoice.update({
            where: { id: inv.id },
            data: { financialYearId: fy.id }
        });
    }

    const unassignedPayments = await prisma.payment.findMany({
        where: { financialYearId: null },
        select: { id: true, paymentDate: true }
    });
    for (const pay of unassignedPayments) {
        const fy = await ensureFinancialYear(pay.paymentDate);
        await prisma.payment.update({
            where: { id: pay.id },
            data: { financialYearId: fy.id }
        });
    }

    console.log('[TEST FIXTURES] Applied deterministic test fixtures successfully.');
}

module.exports = {
    applyTestFixtures
};

if (require.main === module) {
    applyTestFixtures()
        .then(() => prisma.$disconnect())
        .catch((err) => {
            console.error('[TEST FIXTURES ERROR]:', err);
            prisma.$disconnect().finally(() => process.exit(1));
        });
}
