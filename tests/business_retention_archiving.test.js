'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const businessService = require('../app/services/business.service');
const invoiceService = require('../app/services/invoice.service');
const reportingWorkbenchService = require('../app/services/reportingWorkbench.service');

describe('Business Retention & Archiving Safeguards Test Suite', () => {
    let testBiz, emptyBiz;
    let adminUser;
    let client, item, invoice;

    before(async () => {
        const ts = Date.now();
        // Create an organization with financial operations
        testBiz = await businessService.createBusiness({
            code: `RET_BIZ_${ts}`,
            name: 'Retention Guarded Corp',
            legalName: 'Retention Guarded Corp Pvt Ltd',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '27AABCR1234A1Z5'
        });

        // Create an unutilized business with zero financial history
        emptyBiz = await businessService.createBusiness({
            code: `EMPTY_BIZ_${ts}`,
            name: 'Empty Unutilized Org',
            currency: 'INR',
            timezone: 'Asia/Kolkata'
        });

        adminUser = await prisma.user.create({
            data: {
                name: 'Audit Super Admin',
                email: `audit_admin_${ts}@retention.test`,
                password: 'audit-secret-2026',
                role: 'ADMIN',
                active: true
            }
        });

        client = await prisma.client.create({
            data: {
                businessId: testBiz.id,
                name: 'Retention Audit Client',
                email: 'client@retention.test',
                active: true
            }
        });

        item = await prisma.item.create({
            data: {
                businessId: testBiz.id,
                name: `Retention Item ${ts}`,
                rate: 5000,
                unit: 'PCS',
                active: true
            }
        });

        invoice = await invoiceService.createDocument({
            businessId: testBiz.id,
            documentType: 'INVOICE',
            invoiceDate: new Date('2026-10-15T10:00:00Z'),
            clientId: client.id,
            clientName: client.name,
            items: [
                {
                    itemId: item.id,
                    name: item.name,
                    unit: 'PCS',
                    quantity: 2,
                    rate: 5000,
                    taxRate: 18
                }
            ],
            gstEnabled: true,
            status: 'ACTIVE'
        }, adminUser.id);
    });

    after(async () => {
        // Clean up retained test business
        if (invoice) {
            await prisma.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } }).catch(() => {});
            await prisma.invoice.delete({ where: { id: invoice.id } }).catch(() => {});
        }
        if (client) await prisma.client.delete({ where: { id: client.id } }).catch(() => {});
        if (item) await prisma.item.delete({ where: { id: item.id } }).catch(() => {});

        for (const b of [testBiz, emptyBiz]) {
            if (b && b.id) {
                await prisma.userActivityLog.deleteMany({ where: { businessId: b.id } }).catch(() => {});
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

        if (adminUser) await prisma.user.delete({ where: { id: adminUser.id } }).catch(() => {});
        await prisma.$disconnect();
    });

    it('1. Refuses deletion of default organization (ID: 1 / code: DEFAULT)', async () => {
        await assert.rejects(
            async () => {
                await businessService.deleteBusiness(1, adminUser.id);
            },
            (err) => {
                assert.strictEqual(err.name, 'BusinessError');
                assert.match(err.message, /default organization cannot be deleted/i);
                return true;
            }
        );
    });

    it('2. Refuses deletion of business containing retained financial records with clear admin explanation', async () => {
        await assert.rejects(
            async () => {
                await businessService.deleteBusiness(testBiz.id, adminUser.id);
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

        // Verify invoices remain completely intact
        const count = await prisma.invoice.count({ where: { businessId: testBiz.id } });
        assert.ok(count >= 1, 'Invoices must not be deleted');
    });

    it('3. Archiving business updates status to ARCHIVED and preserves all records', async () => {
        const archived = await businessService.archiveBusiness(testBiz.id, adminUser.id);
        assert.strictEqual(archived.status, 'ARCHIVED');

        const inDb = await prisma.business.findUnique({ where: { id: testBiz.id } });
        assert.strictEqual(inDb.status, 'ARCHIVED');

        // Document snapshot intact
        const inv = await prisma.invoice.findUnique({ where: { id: invoice.id } });
        assert.strictEqual(inv.status, 'ACTIVE');
        assert.strictEqual(Number(inv.grandTotal), 11800);
    });

    it('4. assertBusinessActive blocks new transactions on an ARCHIVED business', async () => {
        await assert.rejects(
            async () => {
                await businessService.assertBusinessActive(testBiz.id);
            },
            (err) => {
                assert.strictEqual(err.name, 'BusinessError');
                assert.strictEqual(err.statusCode, 403);
                assert.match(err.message, /is archived/i);
                return true;
            }
        );
    });

    it('5. Archiving does NOT disable authorized historical reporting', async () => {
        const report = await reportingWorkbenchService.queryWorkbench({
            user: adminUser,
            dataset: 'INVOICES',
            filters: { businessIds: [testBiz.id] }
        });

        assert.ok(report.total >= 1, 'Archived business records must remain accessible in reporting');
        assert.strictEqual(report.summary.grandTotal, 11800);
    });

    it('6. Suspending business updates status to SUSPENDED and blocks posting', async () => {
        const suspended = await businessService.suspendBusiness(testBiz.id, adminUser.id);
        assert.strictEqual(suspended.status, 'SUSPENDED');

        await assert.rejects(
            async () => {
                await businessService.assertBusinessActive(testBiz.id);
            },
            (err) => {
                assert.strictEqual(err.name, 'BusinessError');
                assert.strictEqual(err.statusCode, 403);
                assert.match(err.message, /is suspended/i);
                return true;
            }
        );
    });

    it('7. Reactivating business restores ACTIVE status and permits operations', async () => {
        const active = await businessService.reactivateBusiness(testBiz.id, adminUser.id);
        assert.strictEqual(active.status, 'ACTIVE');

        // assertBusinessActive succeeds without error
        const checked = await businessService.assertBusinessActive(testBiz.id);
        assert.strictEqual(checked.id, testBiz.id);
    });

    it('8. Clean deletion succeeds on unutilized business with zero transactions', async () => {
        const result = await businessService.deleteBusiness(emptyBiz.id, adminUser.id);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.deletedBusinessId, emptyBiz.id);

        const check = await prisma.business.findUnique({ where: { id: emptyBiz.id } });
        assert.strictEqual(check, null, 'Unutilized business should be removed cleanly');
        emptyBiz = null; // Mark cleaned
    });
});
