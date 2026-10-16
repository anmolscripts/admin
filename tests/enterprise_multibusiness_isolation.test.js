const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const businessService = require('../app/services/business.service');
const numberingService = require('../app/services/numbering.service');
const reportingWorkbenchService = require('../app/services/reportingWorkbench.service');
const invoiceService = require('../app/services/invoice.service');
const clientService = require('../app/services/client.service');
const itemService = require('../app/services/item.service');
const payrollService = require('../app/services/payroll.service');
const businessController = require('../app/controllers/business.controller');

describe('Enterprise Multi-Business Tenancy & Isolation Test Suite', () => {
    let bizA, bizB;
    let userA, userB, superAdmin;
    let clientA, clientB;
    let itemA, itemB;
    let invA1, invA2, invB1;

    before(async () => {
        // Setup disposable test organizations
        const ts = Date.now();
        bizA = await businessService.createBusiness({
            code: `ALPHA_${ts}`,
            name: 'Enterprise Alpha Corp',
            legalName: 'Enterprise Alpha Corporation Pvt Ltd',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '27AAAAA0000A1Z5'
        });

        bizB = await businessService.createBusiness({
            code: `BETA_${ts}`,
            name: 'Beta Global Logistics',
            legalName: 'Beta Global Logistics LLP',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '27BBBBB1111B2Z6'
        });

        // Create test users
        userA = await prisma.user.create({
            data: {
                name: 'Alice Alpha',
                email: `alice_${ts}@alphacorp.test`,
                password: 'test-secret-2026',
                role: 'STAFF',
                active: true
            }
        });

        userB = await prisma.user.create({
            data: {
                name: 'Bob Beta',
                email: `bob_${ts}@betaglobal.test`,
                password: 'test-secret-2026',
                role: 'STAFF',
                active: true
            }
        });

        superAdmin = await prisma.user.create({
            data: {
                name: 'Super Admin',
                email: `admin_${ts}@platform.test`,
                password: 'test-secret-2026',
                role: 'ADMIN',
                active: true
            }
        });

        // Assign memberships: userA -> bizA only, userB -> bizB only
        await businessService.addOrUpdateMember({
            businessId: bizA.id,
            userId: userA.id,
            role: 'MANAGER'
        });

        await businessService.addOrUpdateMember({
            businessId: bizB.id,
            userId: userB.id,
            role: 'STAFF'
        });
    });

    after(async () => {
        // Clean up created records in disposable test DB
        if (invA1) await prisma.invoiceItem.deleteMany({ where: { invoiceId: invA1.id } }).catch(() => {});
        if (invA2) await prisma.invoiceItem.deleteMany({ where: { invoiceId: invA2.id } }).catch(() => {});
        if (invB1) await prisma.invoiceItem.deleteMany({ where: { invoiceId: invB1.id } }).catch(() => {});
        if (invA1) await prisma.invoice.delete({ where: { id: invA1.id } }).catch(() => {});
        if (invA2) await prisma.invoice.delete({ where: { id: invA2.id } }).catch(() => {});
        if (invB1) await prisma.invoice.delete({ where: { id: invB1.id } }).catch(() => {});

        if (clientA) await prisma.client.delete({ where: { id: clientA.id } }).catch(() => {});
        if (clientB) await prisma.client.delete({ where: { id: clientB.id } }).catch(() => {});

        if (itemA) await prisma.item.delete({ where: { id: itemA.id } }).catch(() => {});
        if (itemB) await prisma.item.delete({ where: { id: itemB.id } }).catch(() => {});

        for (const b of [bizA, bizB]) {
            if (b && b.id) {
                await prisma.businessMembership.deleteMany({ where: { businessId: b.id } }).catch(() => {});
                await prisma.numberingSequence.deleteMany({ where: { businessId: b.id } }).catch(() => {});
                await prisma.businessPrefixConfig.deleteMany({ where: { businessId: b.id } }).catch(() => {});
                await prisma.$executeRawUnsafe('UPDATE chart_of_accounts SET parentId = NULL WHERE businessId = ?', b.id).catch(() => {});
                await prisma.chartOfAccount.deleteMany({ where: { businessId: b.id } }).catch(() => {});
                await prisma.financialYear.deleteMany({ where: { businessId: b.id } }).catch(() => {});
                await prisma.businessProfile.deleteMany({ where: { businessId: b.id } }).catch(() => {});
                await prisma.business.delete({ where: { id: b.id } }).catch(() => {});
            }
        }

        if (userA) await prisma.user.delete({ where: { id: userA.id } }).catch(() => {});
        if (userB) await prisma.user.delete({ where: { id: userB.id } }).catch(() => {});
        if (superAdmin) await prisma.user.delete({ where: { id: superAdmin.id } }).catch(() => {});

        await prisma.$disconnect();
    });

    it('1. Single-business user auto-resolves accessible business', async () => {
        const accessibleA = await businessService.getAccessibleBusinesses(userA.id, false);
        assert.equal(accessibleA.length, 1);
        assert.equal(accessibleA[0].id, bizA.id);
        assert.equal(accessibleA[0].name, 'Enterprise Alpha Corp');

        const accessibleB = await businessService.getAccessibleBusinesses(userB.id, false);
        assert.equal(accessibleB.length, 1);
        assert.equal(accessibleB[0].id, bizB.id);
    });

    it('2. Multi-business user can access both businesses', async () => {
        // Grant userA membership to bizB as well
        await businessService.addOrUpdateMember({
            businessId: bizB.id,
            userId: userA.id,
            role: 'VIEWER'
        });

        const accessible = await businessService.getAccessibleBusinesses(userA.id, false);
        assert.equal(accessible.length, 2);
        const ids = accessible.map(b => b.id);
        assert.ok(ids.includes(bizA.id));
        assert.ok(ids.includes(bizB.id));

        // Revoke userA from bizB
        await businessService.revokeMember({
            businessId: bizB.id,
            userId: userA.id
        });

        const afterRevocation = await businessService.getAccessibleBusinesses(userA.id, false);
        assert.equal(afterRevocation.length, 1);
        assert.equal(afterRevocation[0].id, bizA.id);
    });

    it('3. Master data isolation: Clients and Items scoped strictly by businessId', async () => {
        // Business A and Business B can each have an item named "Consulting Service"
        itemA = await itemService.createItem({
            businessId: bizA.id,
            name: 'Consulting Service',
            unit: 'Hours',
            rate: 2500,
            active: true
        }, userA.id);

        itemB = await itemService.createItem({
            businessId: bizB.id,
            name: 'Consulting Service',
            unit: 'Hours',
            rate: 4000,
            active: true
        }, userB.id);

        assert.ok(itemA.id);
        assert.ok(itemB.id);
        assert.notEqual(itemA.id, itemB.id);

        // Searching items in bizA only returns bizA's item
        const itemsBizA = await itemService.searchItems({ query: 'Consulting', businessId: bizA.id });
        assert.equal(itemsBizA.length, 1);
        assert.equal(itemsBizA[0].id, itemA.id);
        assert.equal(itemsBizA[0].rate, 2500);

        const itemsBizB = await itemService.searchItems({ query: 'Consulting', businessId: bizB.id });
        assert.equal(itemsBizB.length, 1);
        assert.equal(itemsBizB[0].id, itemB.id);
        assert.equal(itemsBizB[0].rate, 4000);

        // Create clients for each business
        clientA = await clientService.createClient({
            businessId: bizA.id,
            name: 'Acme Client Corp',
            email: 'billing@acme.test'
        }, userA.id);

        clientB = await clientService.createClient({
            businessId: bizB.id,
            name: 'Beta Freight Client',
            email: 'ops@betafreight.test'
        }, userB.id);

        const clientsBizA = await clientService.searchClients('Acme', bizA.id);
        assert.equal(clientsBizA.length, 1);
        assert.equal(clientsBizA[0].id, clientA.id);

        const clientsBizB = await clientService.searchClients('Acme', bizB.id);
        assert.equal(clientsBizB.length, 0); // Biz B cannot see Acme Client Corp
    });

    it('4. Central Numbering isolation: Independent sequences per business', async () => {
        const testDate = new Date('2026-10-15T10:00:00.000Z');

        // Business A allocates first invoice in 2026/10
        const numA1 = await numberingService.allocateNumber({
            businessId: bizA.id,
            entityType: 'INVOICE',
            date: testDate
        });
        assert.equal(numA1, 'INVO/2026/10/1');

        // Business B independently allocates first invoice in 2026/10
        const numB1 = await numberingService.allocateNumber({
            businessId: bizB.id,
            entityType: 'INVOICE',
            date: testDate
        });
        assert.equal(numB1, 'INVO/2026/10/1'); // Both start at 1 without collision

        // Business A allocates second invoice
        const numA2 = await numberingService.allocateNumber({
            businessId: bizA.id,
            entityType: 'INVOICE',
            date: testDate
        });
        assert.equal(numA2, 'INVO/2026/10/2');
    });

    it('5. Transactional Document Creation with businessId ownership', async () => {
        const testDate = new Date('2026-10-16T12:00:00.000Z');

        invA1 = await invoiceService.createDocument({
            businessId: bizA.id,
            documentType: 'INVOICE',
            invoiceDate: testDate,
            clientId: clientA.id,
            clientName: clientA.name,
            clientEmail: clientA.email,
            items: [
                {
                    itemId: itemA.id,
                    name: itemA.name,
                    unit: itemA.unit,
                    quantity: 2,
                    rate: 2500,
                    taxRate: 18
                }
            ],
            gstEnabled: true,
            status: 'ACTIVE'
        }, userA.id);

        assert.equal(invA1.businessId, bizA.id);
        assert.ok(invA1.invoiceNumber.startsWith('INVO/2026/10/'));

        invA2 = await invoiceService.createDocument({
            businessId: bizA.id,
            documentType: 'INVOICE',
            invoiceDate: testDate,
            clientId: clientA.id,
            clientName: clientA.name,
            clientEmail: clientA.email,
            items: [
                {
                    itemId: itemA.id,
                    name: itemA.name,
                    unit: itemA.unit,
                    quantity: 1,
                    rate: 1500,
                    taxRate: 18
                }
            ],
            gstEnabled: true,
            status: 'ACTIVE'
        }, userA.id);

        assert.equal(invA2.businessId, bizA.id);
        assert.ok(invA2.invoiceNumber.startsWith('INVO/2026/10/'));

        invB1 = await invoiceService.createDocument({
            businessId: bizB.id,
            documentType: 'INVOICE',
            invoiceDate: testDate,
            clientId: clientB.id,
            clientName: clientB.name,
            clientEmail: clientB.email,
            items: [
                {
                    itemId: itemB.id,
                    name: itemB.name,
                    unit: itemB.unit,
                    quantity: 1,
                    rate: 4000,
                    taxRate: 18
                }
            ],
            gstEnabled: true,
            status: 'ACTIVE'
        }, userB.id);

        assert.equal(invB1.businessId, bizB.id);
        assert.ok(invB1.invoiceNumber.startsWith('INVO/2026/10/'));
    });

    it('6. Reporting Workbench strictly enforces business permissions', async () => {
        // User A querying for Business B data should be rejected with ForbiddenError
        await assert.rejects(
            async () => {
                await reportingWorkbenchService.queryWorkbench({
                    user: userA,
                    dataset: 'INVOICES',
                    filters: { businessIds: [bizB.id] }
                });
            },
            { name: 'ForbiddenError' }
        );

        // User A querying for their authorized business succeeds
        const repA = await reportingWorkbenchService.queryWorkbench({
            user: userA,
            dataset: 'INVOICES',
            filters: { businessIds: [bizA.id] }
        });
        assert.ok(repA.records.length >= 1);
        assert.ok(repA.records.every(r => r.businessId === bizA.id));

        // Platform Admin querying across multiple businesses succeeds
        const repAdmin = await reportingWorkbenchService.queryWorkbench({
            user: superAdmin,
            dataset: 'INVOICES',
            filters: { businessIds: [bizA.id, bizB.id] },
            grouping: 'byBusiness'
        });
        assert.ok(repAdmin.grouped);
        assert.ok(repAdmin.grouped.length >= 2);
        assert.equal(repAdmin.summary.totalRecords, repAdmin.allRecords.length);
    });

    it('7. Reporting Workbench export formats produce valid outputs', async () => {
        const reportResult = await reportingWorkbenchService.queryWorkbench({
            user: superAdmin,
            dataset: 'INVOICES',
            filters: { businessIds: [bizA.id, bizB.id] }
        });

        // CSV export
        const csv = reportingWorkbenchService.generateWorkbenchCsv(reportResult);
        assert.ok(typeof csv === 'string');
        assert.ok(csv.includes('Dataset'));
        assert.ok(csv.includes('TOTALS'));

        // Excel export
        const xlsxBuffer = await reportingWorkbenchService.generateWorkbenchExcel(reportResult);
        assert.ok(Buffer.isBuffer(xlsxBuffer));
        assert.ok(xlsxBuffer.length > 500);

        // PDF export
        const pdfBuffer = await reportingWorkbenchService.generateWorkbenchPdf(reportResult);
        assert.ok(Buffer.isBuffer(pdfBuffer));
        assert.ok(pdfBuffer.length > 500);
    });

    it('8. Platform Administrator Scope: Explicit Global mode vs deliberate tenant switching', async () => {
        // Admin switches to global mode
        let jsonPayload = null;
        const mockReqGlobal = {
            session: { user: superAdmin, activeBusinessId: bizA.id, isGlobalAdminMode: false, save: (cb) => cb && cb() },
            body: { businessId: 'global' },
            params: {},
            query: {},
            headers: { 'content-type': 'application/json' },
            path: '/api/switch-business'
        };
        const mockResGlobal = {
            json: (p) => { jsonPayload = p; return mockResGlobal; },
            status: () => mockResGlobal
        };

        await businessController.switchBusiness(mockReqGlobal, mockResGlobal, () => {});
        assert.ok(jsonPayload);
        assert.strictEqual(jsonPayload.success, true);
        assert.strictEqual(jsonPayload.activeBusinessId, 'global');
        assert.strictEqual(jsonPayload.isGlobalAdminMode, true);
        assert.strictEqual(mockReqGlobal.session.activeBusinessId, null);
        assert.strictEqual(mockReqGlobal.session.isGlobalAdminMode, true);

        // Admin deliberately switches into tenant Biz B
        let jsonTenant = null;
        const mockReqTenant = {
            session: { user: superAdmin, activeBusinessId: null, isGlobalAdminMode: true, save: (cb) => cb && cb() },
            body: { businessId: bizB.id },
            params: {},
            query: {},
            headers: { 'content-type': 'application/json' },
            path: '/api/switch-business'
        };
        const mockResTenant = {
            json: (p) => { jsonTenant = p; return mockResTenant; },
            status: () => mockResTenant
        };

        await businessController.switchBusiness(mockReqTenant, mockResTenant, () => {});
        assert.ok(jsonTenant);
        assert.strictEqual(jsonTenant.success, true);
        assert.strictEqual(jsonTenant.activeBusinessId, bizB.id);
        assert.strictEqual(mockReqTenant.session.activeBusinessId, bizB.id);
        assert.strictEqual(mockReqTenant.session.isGlobalAdminMode, false);
    });

    it('9. Non-admin user cannot switch to global mode or unauthorized tenant', async () => {
        // Alice attempts to enter global mode
        let statusForbiddenGlobal = null;
        const mockReqAliceGlobal = {
            session: { user: userA, activeBusinessId: bizA.id, save: (cb) => cb && cb() },
            body: { businessId: 'global' },
            params: {},
            query: {},
            headers: { 'content-type': 'application/json' },
            path: '/api/switch-business'
        };
        const mockResAliceGlobal = {
            status: (code) => { statusForbiddenGlobal = code; return mockResAliceGlobal; },
            json: () => mockResAliceGlobal
        };

        await businessController.switchBusiness(mockReqAliceGlobal, mockResAliceGlobal, () => {});
        assert.strictEqual(statusForbiddenGlobal, 403, 'Non-admin must be forbidden from entering global mode');

        // Alice attempts to switch to Biz B (unauthorized)
        let statusForbiddenBizB = null;
        const mockReqAliceBizB = {
            session: { user: userA, activeBusinessId: bizA.id, save: (cb) => cb && cb() },
            body: { businessId: bizB.id },
            params: {},
            query: {},
            headers: { 'content-type': 'application/json' },
            path: '/api/switch-business'
        };
        const mockResAliceBizB = {
            status: (code) => { statusForbiddenBizB = code; return mockResAliceBizB; },
            json: () => mockResAliceBizB
        };

        await businessController.switchBusiness(mockReqAliceBizB, mockResAliceBizB, () => {});
        assert.strictEqual(statusForbiddenBizB, 403, 'User without membership must be forbidden from accessing tenant');
    });

    it('10. Expanded Workbench Datasets (CUSTOMERS, SUPPLIERS, TAX_GST) enforce tenant boundaries', async () => {
        // Query CUSTOMERS dataset for User A
        const custRepA = await reportingWorkbenchService.queryWorkbench({
            user: userA,
            dataset: 'CUSTOMERS',
            filters: { businessIds: [bizA.id] }
        });
        assert.ok(custRepA.records);
        assert.ok(custRepA.records.every(r => r.businessId === bizA.id));

        // Query TAX_GST dataset for User B
        const gstRepB = await reportingWorkbenchService.queryWorkbench({
            user: userB,
            dataset: 'TAX_GST',
            filters: { businessIds: [bizB.id] }
        });
        assert.ok(gstRepB.records);
        assert.ok(gstRepB.records.every(r => r.businessId === bizB.id));
    });

    it('11. Two businesses with overlapping names & numeric structures have zero financial contamination', async () => {
        // Both businesses have an identical client name "Shared Global Client"
        const sharedClientA = await clientService.createClient({
            businessId: bizA.id,
            name: 'Shared Global Client Corp',
            email: 'shared@client.test'
        }, userA.id);

        const sharedClientB = await clientService.createClient({
            businessId: bizB.id,
            name: 'Shared Global Client Corp',
            email: 'shared@client.test'
        }, userB.id);

        try {
            assert.notStrictEqual(sharedClientA.id, sharedClientB.id);

            // Create a ₹7,500 invoice in Business A only
            const invSharedA = await invoiceService.createDocument({
                businessId: bizA.id,
                documentType: 'INVOICE',
                invoiceDate: new Date('2026-10-20T10:00:00Z'),
                clientId: sharedClientA.id,
                clientName: sharedClientA.name,
                items: [
                    {
                        itemId: itemA.id,
                        name: itemA.name,
                        unit: 'Hours',
                        quantity: 3,
                        rate: 2500,
                        taxRate: 0
                    }
                ],
                gstEnabled: false,
                status: 'ACTIVE'
            }, userA.id);

            // Verify Business B customer report has 0 financial contamination from Business A's invoice
            const repCustB = await reportingWorkbenchService.queryWorkbench({
                user: userB,
                dataset: 'CUSTOMERS',
                filters: { businessIds: [bizB.id], search: 'Shared Global Client Corp' }
            });

            const custRowB = repCustB.records.find(r => r.id === sharedClientB.id);
            assert.ok(custRowB, 'Business B finds its own client');
            assert.strictEqual(custRowB.subtotal, 0, 'Business B total billed must remain 0');
            assert.strictEqual(custRowB.grandTotal, 0, 'Business B outstanding must remain 0');

            // Business A customer report reflects the exact ₹7,500
            const repCustA = await reportingWorkbenchService.queryWorkbench({
                user: userA,
                dataset: 'CUSTOMERS',
                filters: { businessIds: [bizA.id], search: 'Shared Global Client Corp' }
            });
            const custRowA = repCustA.records.find(r => r.id === sharedClientA.id);
            assert.ok(custRowA);
            assert.strictEqual(custRowA.subtotal, 7500);

            // Clean up invoice
            await prisma.invoiceItem.deleteMany({ where: { invoiceId: invSharedA.id } });
            await prisma.invoice.delete({ where: { id: invSharedA.id } });
        } finally {
            await prisma.client.delete({ where: { id: sharedClientA.id } }).catch(() => {});
            await prisma.client.delete({ where: { id: sharedClientB.id } }).catch(() => {});
        }
    });

    it('12. Refuses deletion of default organization (ID: 1 / code: DEFAULT)', async () => {
        await assert.rejects(
            async () => {
                await businessService.deleteBusiness(1, superAdmin.id);
            },
            (err) => {
                assert.strictEqual(err.name, 'BusinessError');
                assert.match(err.message, /default organization cannot be deleted/i);
                return true;
            }
        );
    });

    it('13. Refuses deletion of business containing retained financial records with clear admin explanation', async () => {
        // bizA contains invoices (invA1, invA2)
        await assert.rejects(
            async () => {
                await businessService.deleteBusiness(bizA.id, superAdmin.id);
            },
            (err) => {
                assert.strictEqual(err.name, 'BusinessError');
                assert.strictEqual(err.statusCode, 400);
                assert.match(err.message, /Cannot delete business/);
                assert.match(err.message, /retained compliance records/);
                assert.match(err.message, /invoice\(s\)/);
                assert.match(err.message, /Please archive or suspend the business instead/);
                return true;
            }
        );

        // Verify invoices still exist 100% intact
        const invCount = await prisma.invoice.count({ where: { businessId: bizA.id } });
        assert.ok(invCount >= 2, 'Invoices must not be deleted');
    });

    it('14. Archiving business updates status to ARCHIVED and preserves all records', async () => {
        const archived = await businessService.archiveBusiness(bizA.id, superAdmin.id);
        assert.strictEqual(archived.status, 'ARCHIVED');

        const dbBiz = await prisma.business.findUnique({ where: { id: bizA.id } });
        assert.strictEqual(dbBiz.status, 'ARCHIVED');

        // Restore active status for subsequent tests
        await businessService.reactivateBusiness(bizA.id, superAdmin.id);
    });

    it('15. assertBusinessActive blocks new transactions on an ARCHIVED or SUSPENDED business', async () => {
        await businessService.archiveBusiness(bizA.id, superAdmin.id);

        await assert.rejects(
            async () => {
                await businessService.assertBusinessActive(bizA.id);
            },
            (err) => {
                assert.strictEqual(err.name, 'BusinessError');
                assert.strictEqual(err.statusCode, 403);
                assert.match(err.message, /is archived/i);
                return true;
            }
        );

        await businessService.suspendBusiness(bizA.id, superAdmin.id);
        await assert.rejects(
            async () => {
                await businessService.assertBusinessActive(bizA.id);
            },
            (err) => {
                assert.strictEqual(err.statusCode, 403);
                assert.match(err.message, /is suspended/i);
                return true;
            }
        );

        // Restore active
        await businessService.reactivateBusiness(bizA.id, superAdmin.id);
    });

    it('16. Archiving does NOT disable authorized historical reporting', async () => {
        await businessService.archiveBusiness(bizA.id, superAdmin.id);

        const report = await reportingWorkbenchService.queryWorkbench({
            user: superAdmin,
            dataset: 'INVOICES',
            filters: { businessIds: [bizA.id] }
        });

        assert.ok(report.total >= 2, 'Archived business records must remain accessible in reporting');
        assert.ok(report.summary.grandTotal > 0);

        // Restore active
        await businessService.reactivateBusiness(bizA.id, superAdmin.id);
    });

    it('17. Output format parity: CSV, Excel, PDF, and Print generated for identical filtered data', async () => {
        const report = await reportingWorkbenchService.queryWorkbench({
            user: superAdmin,
            dataset: 'INVOICES',
            filters: { businessIds: [bizA.id] }
        });

        // 17.1 CSV
        const csv = reportingWorkbenchService.generateWorkbenchCsv(report);
        assert.strictEqual(typeof csv, 'string');
        assert.match(csv, /Grand Total/);
        assert.match(csv, /Enterprise Alpha Corp/);

        // 17.2 Excel
        const excelBuf = await reportingWorkbenchService.generateWorkbenchExcel(report);
        assert.ok(Buffer.isBuffer(excelBuf));
        assert.ok(excelBuf.length > 500);

        // 17.3 PDF
        const pdfBuf = await reportingWorkbenchService.generateWorkbenchPdf(report);
        assert.ok(Buffer.isBuffer(pdfBuf));
        assert.strictEqual(pdfBuf.slice(0, 4).toString(), '%PDF');

        // 17.4 Print HTML
        const printHtml = reportingWorkbenchService.generateWorkbenchHtmlPrint(report);
        assert.strictEqual(typeof printHtml, 'string');
        assert.match(printHtml, /<!DOCTYPE html>/);
        assert.match(printHtml, /Enterprise Alpha Corp/);
        assert.match(printHtml, /@media print/);
    });

    it('18. Multi-currency segregation: values from different currencies are never added without conversion', async () => {
        // Update bizB currency to USD temporarily to test multi-currency reporting
        await prisma.business.update({ where: { id: bizB.id }, data: { currency: 'USD' } });

        try {
            const report = await reportingWorkbenchService.queryWorkbench({
                user: superAdmin,
                dataset: 'INVOICES',
                filters: { businessIds: [bizA.id, bizB.id] }
            });

            assert.strictEqual(report.summary.isSingleCurrency, false);
            assert.ok(report.summary.mixedCurrencyWarning);
            assert.ok(report.summary.currencyBreakdown.INR, 'Must have INR breakdown');
            assert.ok(report.summary.currencyBreakdown.USD, 'Must have USD breakdown');
            assert.match(report.summary.displayGrandTotal, /INR/);
            assert.match(report.summary.displayGrandTotal, /USD/);
        } finally {
            await prisma.business.update({ where: { id: bizB.id }, data: { currency: 'INR' } });
        }
    });

    it('19. State-changing GET /switch-business is rejected with 405 Method Not Allowed', async () => {
        let statusCode = null;
        let responseJson = null;
        const req = {
            method: 'GET',
            session: { user: userA },
            headers: {}
        };
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => { responseJson = data; }
                };
            }
        };

        await businessController.switchBusiness(req, res, () => {});
        assert.strictEqual(statusCode, 405);
        assert.strictEqual(responseJson.success, false);
        assert.match(responseJson.error, /State-changing GET business-switch is disabled/);
    });

    it('20. POST /switch-business strictly rejects non-member tenant switching with 403', async () => {
        let statusCode = null;
        let responseJson = null;
        const req = {
            method: 'POST',
            session: { user: userA, activeBusinessId: bizA.id },
            body: { businessId: bizB.id },
            headers: { 'content-type': 'application/json' }
        };
        const res = {
            status: (code) => {
                statusCode = code;
                return {
                    json: (data) => { responseJson = data; }
                };
            }
        };

        await businessController.switchBusiness(req, res, () => {});
        assert.strictEqual(statusCode, 403);
        assert.strictEqual(responseJson.success, false);
        assert.match(responseJson.error, /Access to this business is not authorized/);
    });

    it('21. Open-redirect prevention sanitizes malicious external and protocol-relative redirect URLs', async () => {
        const maliciousTargets = [
            '//evil.com/phish',
            'http://attacker.example/steal',
            'https://evil.com',
            '\\evil.com/bypass',
            '/\\evil.com',
            'javascript:alert(1)',
            'data:text/html,<script>alert(1)</script>'
        ];

        for (const target of maliciousTargets) {
            let redirectLocation = null;
            let saved = false;
            const req = {
                method: 'POST',
                session: {
                    user: userA,
                    activeBusinessId: null,
                    save: (cb) => { saved = true; cb(null); }
                },
                body: { businessId: bizA.id, redirect: target },
                headers: {},
                query: {}
            };
            const res = {
                redirect: (loc) => { redirectLocation = loc; }
            };

            await businessController.switchBusiness(req, res, () => {});
            assert.strictEqual(redirectLocation, '/', `Failed to sanitize malicious redirect: ${target}`);
            assert.strictEqual(saved, true);
        }

        // Legitimate relative paths must be preserved
        let safeLocation = null;
        const safeReq = {
            method: 'POST',
            session: {
                user: userA,
                activeBusinessId: null,
                save: (cb) => cb(null)
            },
            body: { businessId: bizA.id, redirect: '/invoices?page=2' },
            headers: {},
            query: {}
        };
        const safeRes = {
            redirect: (loc) => { safeLocation = loc; }
        };
        await businessController.switchBusiness(safeReq, safeRes, () => {});
        assert.strictEqual(safeLocation, '/invoices?page=2');
    });

    it('22. POST /switch-business synchronously saves session and immediately refreshes req.businessId context', async () => {
        let savedSession = false;
        const req = {
            method: 'POST',
            session: {
                user: userA,
                activeBusinessId: null,
                save: (cb) => {
                    savedSession = true;
                    cb(null);
                }
            },
            body: { businessId: bizA.id },
            headers: { 'content-type': 'application/json' }
        };
        let responseJson = null;
        const res = {
            json: (data) => { responseJson = data; }
        };

        await businessController.switchBusiness(req, res, () => {});
        assert.strictEqual(savedSession, true);
        assert.strictEqual(req.session.activeBusinessId, bizA.id);
        assert.strictEqual(req.businessId, bizA.id);
        assert.strictEqual(responseJson.success, true);
        assert.strictEqual(responseJson.activeBusinessId, bizA.id);
    });

    it('23. Cross-business tampering: creating invoice in Business B referencing Client of Business A is rejected', async () => {
        await assert.rejects(async () => {
            await invoiceService.createDocument({
                businessId: bizB.id,
                documentType: 'INVOICE',
                invoiceDate: new Date('2026-10-15'),
                clientId: clientA.id, // clientA belongs to bizA!
                currency: 'INR',
                items: [
                    { name: 'Service B', quantity: 1, rate: 500, amount: 500 }
                ]
            }, userB.id);
        }, (err) => {
            assert.strictEqual(err.name, 'ValidationError');
            assert.match(err.message, /does not belong to authorized business/i);
            return true;
        });
    });

    it('24. Cross-business tampering: creating invoice in Business B referencing Item of Business A is rejected', async () => {
        await assert.rejects(async () => {
            await invoiceService.createDocument({
                businessId: bizB.id,
                documentType: 'INVOICE',
                invoiceDate: new Date('2026-10-15'),
                clientName: 'Walk-in Beta Client',
                currency: 'INR',
                items: [
                    { itemId: itemA.id, name: 'Item A Tampered', quantity: 1, rate: 1000, amount: 1000 } // itemA belongs to bizA!
                ]
            }, userB.id);
        }, (err) => {
            assert.strictEqual(err.name, 'ValidationError');
            assert.match(err.message, /does not belong to authorized business/i);
            return true;
        });
    });

    it('25. Multi-business user without businessId receives actionable validation error', async () => {
        // Create user with access to both bizA and bizB
        const multiUser = await prisma.user.create({
            data: {
                name: 'Multi Org User',
                email: `multi_${Date.now()}@platform.test`,
                password: 'test-secret-2026',
                role: 'STAFF',
                active: true
            }
        });
        await businessService.addOrUpdateMember({ businessId: bizA.id, userId: multiUser.id, role: 'STAFF' });
        await businessService.addOrUpdateMember({ businessId: bizB.id, userId: multiUser.id, role: 'STAFF' });

        await assert.rejects(async () => {
            await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: new Date('2026-10-15'),
                clientName: 'Ambiguous Client',
                currency: 'INR',
                items: [{ name: 'Service', quantity: 1, rate: 100, amount: 100 }]
            }, multiUser.id);
        }, (err) => {
            assert.strictEqual(err.name, 'ValidationError');
            assert.match(err.message, /valid businessId is required/i);
            return true;
        });
    });

    it('26. Revoked business membership is immediately enforced on the next protected request', async () => {
        const revokedUser = await prisma.user.create({
            data: {
                name: 'Revoked Member User',
                email: `revoked_${Date.now()}@platform.test`,
                password: 'test-secret-2026',
                role: 'STAFF',
                active: true
            }
        });
        await businessService.addOrUpdateMember({ businessId: bizA.id, userId: revokedUser.id, role: 'STAFF' });

        // Revoke membership
        await businessService.revokeBusinessMembership(bizA.id, revokedUser.id, superAdmin.id);

        // Attempt switch-business into bizA
        const req = {
            session: {
                user: { id: revokedUser.id, role: 'STAFF' },
                activeBusinessId: null,
                save: (cb) => cb(null)
            },
            body: { businessId: bizA.id },
            headers: { 'content-type': 'application/json' }
        };
        let statusCode = null;
        let responseJson = null;
        const res = {
            status: (code) => {
                statusCode = code;
                return res;
            },
            json: (data) => { responseJson = data; }
        };

        await businessController.switchBusiness(req, res, () => {});
        assert.strictEqual(statusCode, 403);
        assert.strictEqual(responseJson.success, false);
        assert.match(responseJson.error, /not authorized/i);
    });

    it('27. Payroll period tenancy: Business A and Business B can each create PAY-2026-10 for the same calendar month, while same-business duplicate is rejected', async () => {
        // Create an employee in bizA
        const empA = await payrollService.createEmployee({
            businessId: bizA.id,
            employeeCode: `EMPA_${Date.now()}`,
            firstName: 'Alice',
            lastName: 'Staff',
            email: `alice_${Date.now()}@alphacorp.test`,
            dateOfJoining: '2026-01-01'
        }, userA.id);
        await payrollService.setSalaryStructure(empA.id, {
            effectiveFrom: '2026-01-01',
            basicSalary: 50000,
            hra: 20000,
            epfApplicable: false,
            esiApplicable: false,
            ptApplicable: false,
            tdsMonthly: 0
        }, userA.id);

        // Create an employee in bizB
        const empB = await payrollService.createEmployee({
            businessId: bizB.id,
            employeeCode: `EMPB_${Date.now()}`,
            firstName: 'Bob',
            lastName: 'Staff',
            email: `bob_${Date.now()}@betaglobal.test`,
            dateOfJoining: '2026-01-01'
        }, userB.id);
        await payrollService.setSalaryStructure(empB.id, {
            effectiveFrom: '2026-01-01',
            basicSalary: 60000,
            hra: 24000,
            epfApplicable: false,
            esiApplicable: false,
            ptApplicable: false,
            tdsMonthly: 0
        }, userB.id);

        // 1. Missing businessId is rejected
        await assert.rejects(
            payrollService.generatePayrollPeriod({ month: 10, year: 2026 }, userA.id),
            /valid, positive integer businessId is required/i
        );

        // 2. Cross-tenant tampering: userA (bizA only) cannot create period for bizB
        await assert.rejects(
            payrollService.generatePayrollPeriod({
                businessId: bizB.id,
                month: 10,
                year: 2026
            }, userA.id),
            /not authorized/i
        );

        // 3. Business A creates period for October 2026 -> PAY-2026-10
        const periodA = await payrollService.generatePayrollPeriod({
            businessId: bizA.id,
            month: 10,
            year: 2026
        }, userA.id);
        assert.strictEqual(periodA.businessId, bizA.id);
        assert.strictEqual(periodA.periodCode, 'PAY-2026-10');

        // 4. Business B creates period for October 2026 -> PAY-2026-10 (SAME periodCode!)
        const periodB = await payrollService.generatePayrollPeriod({
            businessId: bizB.id,
            month: 10,
            year: 2026
        }, userB.id);
        assert.strictEqual(periodB.businessId, bizB.id);
        assert.strictEqual(periodB.periodCode, 'PAY-2026-10');
        assert.notStrictEqual(periodA.id, periodB.id);

        // 5. Same-business duplicate creation is rejected
        await assert.rejects(
            async () => {
                await payrollService.generatePayrollPeriod({
                    businessId: bizA.id,
                    month: 10,
                    year: 2026
                }, userA.id);
            },
            /already generated/
        );

        // 6. Cross-tenant posting rejection: userA cannot post periodB
        await assert.rejects(
            payrollService.postPayrollToLedger(periodB.id, userA.id),
            /not authorized/i
        );

        // 7. Approve and post periodA in bizA -> journal allocated strictly to bizA
        await payrollService.approvePayrollPeriod(periodA.id, userA.id);
        const postedA = await payrollService.postPayrollToLedger(periodA.id, userA.id);
        const journalA = await prisma.journalEntry.findUnique({ where: { id: postedA.journalEntryId } });
        assert.ok(journalA);
        assert.strictEqual(journalA.businessId, bizA.id);
        assert.match(journalA.entryNumber, /^JRNL\/2026\/10\/\d+$/);

        // 8. Clean up payroll periods, entries, and journals
        if (postedA && postedA.journalEntryId) {
            await prisma.journalEntryLine.deleteMany({ where: { journalEntryId: postedA.journalEntryId } }).catch(() => {});
            await prisma.journalEntry.delete({ where: { id: postedA.journalEntryId } }).catch(() => {});
        }
        await prisma.payrollEntry.deleteMany({ where: { payrollPeriodId: { in: [periodA.id, periodB.id] } } });
        await prisma.payrollPeriod.deleteMany({ where: { id: { in: [periodA.id, periodB.id] } } });
        await prisma.salaryStructure.deleteMany({ where: { employeeId: { in: [empA.id, empB.id] } } });
        await prisma.employee.deleteMany({ where: { id: { in: [empA.id, empB.id] } } });
    });
});

