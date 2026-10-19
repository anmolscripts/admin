'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const businessService = require('../app/services/business.service');
const clientService = require('../app/services/client.service');
const projectService = require('../app/services/project.service');
const invoiceService = require('../app/services/invoice.service');
const { NotFoundError, ValidationError } = require('../app/services/errorTypes');

test('Project-to-Invoice Linkage & Tenant Security Regression Suite', async (t) => {
    let bizA, bizB;
    let userA, userB;
    let clientA1, clientA2, clientB1;
    let projectA1, projectA2, projectB1;

    await t.test('Setup: Create Distinct Tenants, Clients, and Projects', async () => {
        const ts = Date.now();

        // 1. Create Business A
        bizA = await businessService.createBusiness({
            code: `PIL_BIZA_${ts}`,
            name: 'Apex Construction Ltd',
            legalName: 'Apex Construction Ltd',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '07AAAAA0000A1Z5'
        });

        // 2. Create Business B
        bizB = await businessService.createBusiness({
            code: `PIL_BIZB_${ts}`,
            name: 'Beta Infra Corp',
            legalName: 'Beta Infra Corp',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '24BBBBB0000B1Z9'
        });

        // Users
        userA = await prisma.user.create({
            data: {
                name: 'Alice PM',
                email: `alice_${ts}@apex.test`,
                password: 'test-secret-alpha',
                role: 'ADMIN',
                active: true
            }
        });
        await businessService.addOrUpdateMember({ businessId: bizA.id, userId: userA.id, role: 'ADMIN' });

        userB = await prisma.user.create({
            data: {
                name: 'Bob PM',
                email: `bob_${ts}@beta.test`,
                password: 'test-secret-beta',
                role: 'ADMIN',
                active: true
            }
        });
        await businessService.addOrUpdateMember({ businessId: bizB.id, userId: userB.id, role: 'ADMIN' });

        // 3. Create Clients in Business A
        clientA1 = await clientService.createClient({
            businessId: bizA.id,
            name: 'Acme Highrise Developers',
            email: `acme_${ts}@apex.test`,
            phone: '+91 98765 43210',
            stateCode: '07'
        }, userA.id);

        clientA2 = await clientService.createClient({
            businessId: bizA.id,
            name: 'Zenith Retail Spaces',
            email: `zenith_${ts}@apex.test`,
            phone: '+91 98765 43211',
            stateCode: '07'
        }, userA.id);

        // 4. Create Client in Business B
        clientB1 = await clientService.createClient({
            businessId: bizB.id,
            name: 'Omega Commercial Assets',
            email: `omega_${ts}@beta.test`,
            phone: '+91 98765 43212',
            stateCode: '24'
        }, userB.id);

        // 5. Create Projects in Business A
        projectA1 = await projectService.createProject({
            code: `PRJ-A1-${ts}`,
            name: 'Apex Skyline Tower',
            clientId: clientA1.id,
            startDate: '2026-10-01',
            budgetAmount: 5000000,
            status: 'ACTIVE'
        }, userA.id, bizA.id);

        projectA2 = await projectService.createProject({
            code: `PRJ-A2-${ts}`,
            name: 'Apex Shopping Plaza',
            clientId: clientA2.id,
            startDate: '2026-10-01',
            budgetAmount: 3500000,
            status: 'ACTIVE'
        }, userA.id, bizA.id);

        // 6. Create Project in Business B
        projectB1 = await projectService.createProject({
            code: `PRJ-B1-${ts}`,
            name: 'Beta Port Terminal',
            clientId: clientB1.id,
            startDate: '2026-10-01',
            budgetAmount: 10000000,
            status: 'ACTIVE'
        }, userB.id, bizB.id);

        assert.ok(bizA.id, 'Business A created');
        assert.ok(bizB.id, 'Business B created');
        assert.ok(projectA1.id, 'Project A1 created');
        assert.ok(projectB1.id, 'Project B1 created');
    });

    await t.test('Case 1: Valid direct project-to-invoice assignment', async () => {
        const inv = await invoiceService.createDocument({
            businessId: bizA.id,
            documentType: 'INVOICE',
            clientId: clientA1.id,
            projectId: projectA1.id,
            clientName: clientA1.name,
            invoiceDate: new Date(),
            items: [
                { name: 'Phase 1 Architectural Blueprint', quantity: 1, unit: 'SET', rate: 250000 }
            ]
        }, userA.id);

        assert.ok(inv.id, 'Invoice created successfully');
        assert.strictEqual(inv.projectId, projectA1.id, 'Invoice persists projectId');
        assert.ok(inv.project, 'Project relation is included');
        assert.strictEqual(inv.project.id, projectA1.id, 'Project ID matches');
        assert.strictEqual(inv.project.code, projectA1.code, 'Project code matches');

        // Fetch invoice by ID to ensure read persistence
        const fetched = await invoiceService.getInvoiceById(inv.id, bizA.id);
        assert.strictEqual(fetched.projectId, projectA1.id);
        assert.ok(fetched.project);
        assert.strictEqual(fetched.project.name, projectA1.name);
    });

    await t.test('Case 2: Auto-population of clientId from project if not provided', async () => {
        const inv = await invoiceService.createDocument({
            businessId: bizA.id,
            documentType: 'INVOICE',
            projectId: projectA1.id, // Client ID omitted
            invoiceDate: new Date(),
            items: [
                { name: 'Foundation Soil Testing', quantity: 1, unit: 'NOS', rate: 50000 }
            ]
        }, userA.id);

        assert.strictEqual(inv.projectId, projectA1.id);
        assert.strictEqual(inv.clientId, clientA1.id, 'Client ID auto-populated from project');
        assert.strictEqual(inv.clientName, clientA1.name, 'Client name auto-populated from project client');
    });

    await t.test('Case 3: Unlinked invoices continue to function normally', async () => {
        const unlinkedInv = await invoiceService.createDocument({
            businessId: bizA.id,
            documentType: 'INVOICE',
            clientId: clientA2.id,
            clientName: clientA2.name,
            invoiceDate: new Date(),
            projectId: null,
            items: [
                { name: 'General Advisory Fee', quantity: 2, unit: 'HRS', rate: 10000 }
            ]
        }, userA.id);

        assert.ok(unlinkedInv.id);
        assert.strictEqual(unlinkedInv.projectId, null);

        const fetched = await invoiceService.getInvoiceById(unlinkedInv.id, bizA.id);
        assert.strictEqual(fetched.projectId, null);
        assert.strictEqual(fetched.project, null);
    });

    await t.test('Case 4: Rejection of invalid or nonexistent project ID', async () => {
        // Nonexistent project ID
        await assert.rejects(
            async () => {
                await invoiceService.createDocument({
                    businessId: bizA.id,
                    documentType: 'INVOICE',
                    clientId: clientA1.id,
                    clientName: clientA1.name,
                    projectId: 999999999,
                    items: [{ name: 'Test Item', quantity: 1, unit: 'NOS', rate: 100 }]
                }, userA.id);
            },
            (err) => {
                assert.ok(err instanceof NotFoundError || err.statusCode === 404, 'Must throw NotFoundError');
                return true;
            }
        );

        // Invalid format
        await assert.rejects(
            async () => {
                await invoiceService.createDocument({
                    businessId: bizA.id,
                    documentType: 'INVOICE',
                    clientId: clientA1.id,
                    clientName: clientA1.name,
                    projectId: 'abc_not_a_number',
                    items: [{ name: 'Test Item', quantity: 1, unit: 'NOS', rate: 100 }]
                }, userA.id);
            },
            (err) => {
                assert.ok(err instanceof ValidationError || err.statusCode === 400, 'Must throw ValidationError');
                return true;
            }
        );
    });

    await t.test('Case 5: Tenant isolation — Prevent linking to foreign business project', async () => {
        // Business A attempting to link to Project B1 (belongs to Business B)
        await assert.rejects(
            async () => {
                await invoiceService.createDocument({
                    businessId: bizA.id,
                    documentType: 'INVOICE',
                    clientId: clientA1.id,
                    clientName: clientA1.name,
                    projectId: projectB1.id, // Belongs to bizB
                    items: [{ name: 'Cross-Tenant Breach Attempt', quantity: 1, unit: 'NOS', rate: 1000 }]
                }, userA.id); // In bizA context
            },
            (err) => {
                // Must be NotFoundError so it does NOT disclose existence of projectB1
                assert.ok(err instanceof NotFoundError || err.statusCode === 404, 'Must reject foreign project as NotFound');
                return true;
            }
        );

        // Business B attempting to link to Project A1 (belongs to Business A)
        await assert.rejects(
            async () => {
                await invoiceService.createDocument({
                    businessId: bizB.id,
                    documentType: 'INVOICE',
                    clientId: clientB1.id,
                    clientName: clientB1.name,
                    projectId: projectA1.id,
                    items: [{ name: 'Cross-Tenant Breach Attempt 2', quantity: 1, unit: 'NOS', rate: 1000 }]
                }, userB.id);
            },
            (err) => {
                assert.ok(err instanceof NotFoundError || err.statusCode === 404);
                return true;
            }
        );
    });

    await t.test('Case 6: Client/project relationship mismatch validation', async () => {
        // Project A1 is assigned to clientA1. Attempting to assign invoice to clientA2 while linking projectA1:
        await assert.rejects(
            async () => {
                await invoiceService.createDocument({
                    businessId: bizA.id,
                    documentType: 'INVOICE',
                    clientId: clientA2.id, // Mismatched client!
                    clientName: clientA2.name,
                    projectId: projectA1.id, // Project belongs to clientA1
                    invoiceDate: new Date(),
                    items: [{ name: 'Mismatch Item', quantity: 1, unit: 'NOS', rate: 500 }]
                }, userA.id);
            },
            (err) => {
                assert.ok(err instanceof ValidationError || err.statusCode === 400, 'Must throw ValidationError for client mismatch');
                assert.match(err.message, /does not match/i);
                return true;
            }
        );
    });

    await t.test('Case 7: Quotation creation with projectId & Quotation-to-Invoice conversion', async () => {
        // 1. Create Quotation linked to projectA1
        const quotation = await invoiceService.createDocument({
            businessId: bizA.id,
            documentType: 'QUOTATION',
            clientId: clientA1.id,
            clientName: clientA1.name,
            projectId: projectA1.id,
            invoiceDate: new Date(),
            validUntil: new Date(Date.now() + 15 * 86400000),
            items: [
                { name: 'Steel Reinforcement Framework', quantity: 10, unit: 'TON', rate: 65000 },
                { name: 'Concrete Grade M30 Pouring', quantity: 50, unit: 'CUM', rate: 4500 }
            ]
        }, userA.id);

        assert.strictEqual(quotation.documentType, 'QUOTATION');
        assert.strictEqual(quotation.projectId, projectA1.id);
        assert.ok(quotation.project);
        assert.strictEqual(quotation.project.code, projectA1.code);

        // 2. Convert Quotation to Invoice
        const convertedInvoice = await invoiceService.convertQuotationToInvoice(quotation.id, userA.id);

        assert.strictEqual(convertedInvoice.documentType, 'INVOICE');
        assert.strictEqual(convertedInvoice.projectId, projectA1.id, 'Converted invoice must preserve quotation projectId');
        assert.ok(convertedInvoice.project);
        assert.strictEqual(convertedInvoice.project.id, projectA1.id);
        assert.strictEqual(convertedInvoice.sourceQuotationId, quotation.id);

        // Verify quotation convertedInvoice relation
        const reloadedQuotation = await invoiceService.getInvoiceById(quotation.id, bizA.id);
        assert.ok(reloadedQuotation.convertedInvoice, 'Quotation must have convertedInvoice relation');
        assert.strictEqual(reloadedQuotation.convertedInvoice.id, convertedInvoice.id);

        // 3. Duplicate conversion protection
        await assert.rejects(
            async () => {
                await invoiceService.convertQuotationToInvoice(quotation.id, userA.id);
            },
            (err) => {
                assert.ok(err.statusCode === 409 || err.name === 'ConflictError' || err instanceof ValidationError, 'Must reject duplicate conversion');
                assert.match(err.message, /already been converted/i);
                return true;
            }
        );
    });

    await t.test('Case 8: Update invoice projectId and unlink', async () => {
        // Create unlinked invoice
        const inv = await invoiceService.createDocument({
            businessId: bizA.id,
            documentType: 'INVOICE',
            clientId: clientA2.id,
            clientName: clientA2.name,
            invoiceDate: new Date(),
            items: [{ name: 'Design Consultation', quantity: 5, unit: 'HRS', rate: 4000 }]
        }, userA.id);

        assert.strictEqual(inv.projectId, null);

        // Update to link projectA2
        const updated = await invoiceService.updateInvoice(inv.id, {
            clientName: inv.clientName,
            invoiceDate: inv.invoiceDate,
            projectId: projectA2.id,
            version: inv.version,
            items: [{ name: 'Design Consultation', quantity: 5, unit: 'HRS', rate: 4000 }]
        }, userA.id);

        assert.strictEqual(updated.projectId, projectA2.id);

        // Update to unlink (set to null)
        const unlinked = await invoiceService.updateInvoice(inv.id, {
            clientName: updated.clientName,
            invoiceDate: updated.invoiceDate,
            projectId: null,
            version: updated.version,
            items: [{ name: 'Design Consultation', quantity: 5, unit: 'HRS', rate: 4000 }]
        }, userA.id);

        assert.strictEqual(unlinked.projectId, null);
    });

    await t.test('Case 9: Document copying preserves projectId', async () => {
        const original = await invoiceService.createDocument({
            businessId: bizA.id,
            documentType: 'INVOICE',
            clientId: clientA1.id,
            clientName: clientA1.name,
            projectId: projectA1.id,
            invoiceDate: new Date(),
            items: [{ name: 'Curtain Wall Facade Panel', quantity: 20, unit: 'SQM', rate: 12000 }]
        }, userA.id);

        const copied = await invoiceService.copyDocument(original.id, userA.id);
        assert.strictEqual(copied.projectId, projectA1.id, 'Copy document must carry over projectId');
    });

    await t.test('Case 10: Project workspace Sales queries & isolation verification', async () => {
        // Query invoices for projectA1
        const invoicesA1 = await prisma.invoice.findMany({
            where: {
                businessId: bizA.id,
                projectId: projectA1.id,
                documentType: 'INVOICE',
                status: 'ACTIVE'
            },
            include: { project: true }
        });

        assert.ok(invoicesA1.length >= 2, 'Should have multiple invoices linked to projectA1');
        for (const item of invoicesA1) {
            assert.strictEqual(item.businessId, bizA.id);
            assert.strictEqual(item.projectId, projectA1.id);
        }

        // Query invoices for projectB1
        const invoicesB1 = await prisma.invoice.findMany({
            where: {
                businessId: bizB.id,
                projectId: projectB1.id,
                documentType: 'INVOICE'
            }
        });
        assert.strictEqual(invoicesB1.length, 0, 'Project B1 has no invoices');

        // Verify projectA1 invoices are never visible under projectB1 or bizB
        const crossCheck = await prisma.invoice.findMany({
            where: {
                businessId: bizB.id,
                projectId: projectA1.id
            }
        });
        assert.strictEqual(crossCheck.length, 0, 'Zero cross-tenant invoice leakage');
    });

    await prisma.$disconnect();
});

