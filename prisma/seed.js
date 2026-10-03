require('dotenv').config();

const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const { PrismaMariaDb } = require('@prisma/adapter-mariadb');

const adapter = new PrismaMariaDb({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 3306),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME
});

const prisma = new PrismaClient({ adapter });
const rbacService = require('../app/services/rbac.service');

async function main() {
    // 0. Seed RBAC Permissions & System Roles
    console.log('Seeding RBAC permissions and system roles...');
    await rbacService.seedPermissionsAndRoles();

    const ownerRole = await prisma.role.findUnique({ where: { name: 'OWNER' } });

    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
        console.log('[SEED POLICY] Production mode detected (NODE_ENV=production).');
        console.log('[SEED POLICY] Only system metadata (roles, permissions, mappings) and master data (units, items, profile) will be seeded.');
        console.log('[SEED POLICY] Demo clients, invoices, quotations, payments, and revisions will NOT be seeded.');
    }

    const email = process.env.SEED_ADMIN_EMAIL || 'admin@email.com';

    let admin = await prisma.user.findUnique({
        where: { email }
    });

    if (!admin) {
        const password = process.env.SEED_ADMIN_PASSWORD;

        if (!password) {
            if (isProduction) {
                console.log('[SEED POLICY] SEED_ADMIN_PASSWORD not set. Skipping initial admin user creation in production.');
            } else {
                throw new Error('SEED_ADMIN_PASSWORD is missing from .env');
            }
        } else {
            const passwordHash = await bcrypt.hash(password, 12);

            admin = await prisma.user.create({
                data: {
                    name: 'Administrator',
                    email,
                    password: passwordHash,
                    role: 'ADMIN',
                    roleId: ownerRole ? ownerRole.id : null,
                    status: 'ACTIVE',
                    active: true
                }
            });

            console.log('Initial admin created:', admin.email);
        }
    } else {
        if (ownerRole && admin.roleId !== ownerRole.id) {
            await prisma.user.update({
                where: { id: admin.id },
                data: { roleId: ownerRole.id, status: 'ACTIVE', active: true }
            });
            console.log('Updated existing admin with OWNER role:', email);
        } else {
            console.log('Admin already exists:', email);
        }
    }

    // Seed Development Invoices and Quotations if not already present (strictly excluded in production)
    if (!isProduction) {
        const existingInvoicesCount = await prisma.invoice.count({
            where: { documentType: 'INVOICE' }
        });

        if (existingInvoicesCount === 0 && admin) {
            console.log('Seeding development invoice data...');

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

        console.log('Seeded 3 development invoices (ACTIVE, INACTIVE, VOID).');
    } else {
        console.log(`Development invoices already seeded (${existingInvoicesCount} existing).`);
    }

    // Seed Development Quotations if not already present
    const existingQuotationsCount = await prisma.invoice.count({
        where: { documentType: 'QUOTATION' }
    });

    if (existingQuotationsCount === 0) {
        console.log('Seeding development quotation data...');

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

        console.log('Seeded 2 development quotations (ACTIVE, INACTIVE).');
    } else {
        console.log(`Development quotations already seeded (${existingQuotationsCount} existing).`);
    }
    }

    // Synchronize sequences
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

    // Seed or Update Business Profile with standard default terms
    const STANDARD_TERMS = [
        '1. All work is done adhering to government standards and ISI approved.',
        '2. Work is done to the customer\'s utmost satisfaction.',
        '3. 18% GST is excluded.',
        '4. 50% advance is required before work is conducted.'
    ].join('\n');

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
        console.log('Default business profile seeded with standard terms.');
    } else {
        await prisma.businessProfile.update({
            where: { id: profile.id },
            data: { defaultTerms: STANDARD_TERMS }
        });
        console.log('Business profile default terms updated with standard notes.');
    }

    // Seed Predefined Unit Master entries (idempotent)
    const DEFAULT_UNITS = [
        { name: 'Piece', symbol: 'PCS', description: 'Standard piece count' },
        { name: 'Meter', symbol: 'm', description: 'Length in meters' },
        { name: 'Unit', symbol: 'unit', description: 'Standard unit count' },
        { name: 'Project', symbol: 'Project', description: 'Fixed price project engagement' },
        { name: 'Hours', symbol: 'Hours', description: 'Time in hours' },
        { name: 'Months', symbol: 'Months', description: 'Duration in months' },
        { name: 'Units', symbol: 'Units', description: 'Quantity count' },
        { name: 'License', symbol: 'License', description: 'Software license seat or subscription' },
        { name: 'Year', symbol: 'Year', description: 'Annual subscription or duration' },
        { name: 'Package', symbol: 'Package', description: 'Bundled package' },
        { name: 'Set', symbol: 'Set', description: 'Matched set of components' },
        { name: 'Kilogram', symbol: 'KG', description: 'Weight in kilograms' },
        { name: 'Service', symbol: 'Service', description: 'Professional service delivery' }
    ];

    let unitsCreated = 0;
    for (const u of DEFAULT_UNITS) {
        const existingUnit = await prisma.unit.findFirst({
            where: { symbol: { equals: u.symbol } }
        });
        if (!existingUnit) {
            await prisma.unit.create({
                data: {
                    name: u.name,
                    symbol: u.symbol,
                    description: u.description,
                    active: true,
                    createdById: admin ? admin.id : null
                }
            });
            unitsCreated++;
        }
    }
    console.log(`Units master seeded (${unitsCreated} new units created).`);

    // Seed Provided 21 Master Items (idempotent)
    const MASTER_ITEMS = [
        {
            name: 'Pipe Seamless S-40 Sudul 40 extra heavy pipe 40/50 mm PNG',
            unit: 'm',
            rate: 900.00
        },
        {
            name: 'Band Seamless 1BR with Lab Testing Reporting TC 50, 40 mm',
            unit: 'm',
            rate: 300.00
        },
        {
            name: 'Ball Valve L&T Audco 40/50 mm super strong extra autocut',
            unit: 'unit',
            rate: 6800.00
        },
        {
            name: 'Line Valve heat proof super strong extra autocut L&T',
            unit: 'unit',
            rate: 900.00
        },
        {
            name: 'Clamps industrial with fastener, nut bolt, super strong with Gaskit',
            unit: 'unit',
            rate: 300.00
        },
        {
            name: 'Tee 50mm with TC Lab Reporting 18R Seamless',
            unit: 'unit',
            rate: 1200.00
        },
        {
            name: 'Meter Gauge 4” dia looking pressure Liquid 10KG',
            unit: 'unit',
            rate: 2000.00
        },
        {
            name: 'Bullnose with brass nut Gaskit with reducer',
            unit: 'unit',
            rate: 1800.00
        },
        {
            name: 'Flexible Hydraulic Suraksha Long heavy',
            unit: 'unit',
            rate: 700.00
        },
        {
            name: 'Nitrogen Pressure holding Line testing',
            unit: 'unit',
            rate: 8500.00
        },
        {
            name: 'Labour charges, Welding, testing, fitting charges etc',
            unit: 'unit',
            rate: 145000.00
        },
        {
            name: 'TPT (Third Party Testing) by Govt Body IGL & Report',
            unit: 'unit',
            rate: 9500.00
        },
        {
            name: 'Paint, Primer, Cutting, Welding Rod, Loading & Unloading Fare',
            unit: 'unit',
            rate: 18000.00
        },
        {
            name: 'Sonolet Valve, Midas, Made in Japan, 40mm',
            unit: 'unit',
            rate: 18500.00
        },
        {
            name: 'DBR 8 zone, Panel automatic super sensor',
            unit: 'unit',
            rate: 22500.00
        },
        {
            name: 'Leak Detector LED Imported Auto Sensor LED',
            unit: 'unit',
            rate: 12500.00
        },
        {
            name: 'Hooter Alarm Auto Detect super power',
            unit: 'unit',
            rate: 2000.00
        },
        {
            name: 'Cabel 4 core super single controller',
            unit: 'unit',
            rate: 180.00
        },
        {
            name: 'Canduit Metal with fastener nut bolt',
            unit: 'unit',
            rate: 80.00
        },
        {
            name: 'Labour Charge Electronic working with TC',
            unit: 'unit',
            rate: 20000.00
        },
        {
            name: 'Imported Gas Meter 1 Bar super flame',
            unit: 'unit',
            rate: 68000.00
        }
    ];

    let itemsCreated = 0;
    for (const item of MASTER_ITEMS) {
        const trimmedName = item.name.trim();
        const existingItem = await prisma.item.findUnique({
            where: { name: trimmedName }
        });

        if (!existingItem) {
            await prisma.item.create({
                data: {
                    name: trimmedName,
                    unit: item.unit.trim(),
                    rate: item.rate,
                    active: true,
                    createdById: admin ? admin.id : null
                }
            });
            itemsCreated++;
        }
    }
    console.log(`Item Master seeded (${itemsCreated} new items created out of 21 specified).`);

    // Seed Sample Clients if not present (strictly excluded in production)
    if (!isProduction) {
        const clientsCount = await prisma.client.count();
        if (clientsCount === 0 && admin) {
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
            console.log('Sample clients seeded.');
        }
    }

    console.log('Seed completed successfully.');
}

main()
    .catch((error) => {
        console.error('Seed failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });