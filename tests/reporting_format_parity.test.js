'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const businessService = require('../app/services/business.service');
const reportingWorkbenchService = require('../app/services/reportingWorkbench.service');
const invoiceService = require('../app/services/invoice.service');

describe('Reporting Format Parity & Multidimensional Reconciliation Test Suite', () => {
    let biz1, biz2;
    let user1, user2, platformAdmin;
    let client1, client2;
    let item1, item2;
    let inv1, inv2;

    before(async () => {
        const ts = Date.now();
        biz1 = await businessService.createBusiness({
            code: `REP_A_${ts}`,
            name: 'Report Parity Corp A',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '27AAAAA1111A1Z1'
        });

        biz2 = await businessService.createBusiness({
            code: `REP_B_${ts}`,
            name: 'Report Parity Corp B',
            currency: 'USD',
            timezone: 'America/New_York'
        });

        platformAdmin = await prisma.user.create({
            data: {
                name: 'Reporting Super Admin',
                email: `rep_admin_${ts}@reporting.test`,
                password: 'secret-reporting',
                role: 'ADMIN',
                active: true
            }
        });

        user1 = await prisma.user.create({
            data: {
                name: 'User Org A',
                email: `rep_user1_${ts}@reporting.test`,
                password: 'secret-reporting',
                role: 'STAFF',
                active: true
            }
        });

        user2 = await prisma.user.create({
            data: {
                name: 'User Org B',
                email: `rep_user2_${ts}@reporting.test`,
                password: 'secret-reporting',
                role: 'STAFF',
                active: true
            }
        });

        // Memberships
        await businessService.addOrUpdateMember({
            businessId: biz1.id,
            userId: user1.id,
            role: 'MANAGER'
        });

        await businessService.addOrUpdateMember({
            businessId: biz2.id,
            userId: user2.id,
            role: 'STAFF'
        });

        // Clients
        client1 = await prisma.client.create({
            data: {
                businessId: biz1.id,
                name: 'Client Alpha INR',
                active: true
            }
        });

        client2 = await prisma.client.create({
            data: {
                businessId: biz2.id,
                name: 'Client Beta USD',
                active: true
            }
        });

        item1 = await prisma.item.create({
            data: {
                businessId: biz1.id,
                name: `Consulting Unit ${ts}`,
                rate: 10000,
                unit: 'Hours',
                active: true
            }
        });

        item2 = await prisma.item.create({
            data: {
                businessId: biz2.id,
                name: `Software License ${ts}`,
                rate: 500,
                unit: 'Units',
                active: true
            }
        });

        // Invoices
        inv1 = await invoiceService.createDocument({
            businessId: biz1.id,
            documentType: 'INVOICE',
            invoiceDate: new Date('2026-10-10T10:00:00Z'),
            clientId: client1.id,
            clientName: client1.name,
            items: [
                {
                    itemId: item1.id,
                    name: item1.name,
                    unit: 'Hours',
                    quantity: 2,
                    rate: 10000,
                    taxRate: 18
                }
            ],
            gstEnabled: true,
            status: 'ACTIVE'
        }, user1.id);

        inv2 = await invoiceService.createDocument({
            businessId: biz2.id,
            documentType: 'INVOICE',
            invoiceDate: new Date('2026-10-12T10:00:00Z'),
            clientId: client2.id,
            clientName: client2.name,
            items: [
                {
                    itemId: item2.id,
                    name: 'Software License',
                    unit: 'Units',
                    quantity: 1,
                    rate: 500,
                    taxRate: 0
                }
            ],
            gstEnabled: false,
            status: 'ACTIVE'
        }, user2.id);
    });

    after(async () => {
        for (const inv of [inv1, inv2]) {
            if (inv) {
                await prisma.invoiceItem.deleteMany({ where: { invoiceId: inv.id } }).catch(() => {});
                await prisma.invoice.delete({ where: { id: inv.id } }).catch(() => {});
            }
        }
        if (client1) await prisma.client.delete({ where: { id: client1.id } }).catch(() => {});
        if (client2) await prisma.client.delete({ where: { id: client2.id } }).catch(() => {});
        if (item1) await prisma.item.delete({ where: { id: item1.id } }).catch(() => {});
        if (item2) await prisma.item.delete({ where: { id: item2.id } }).catch(() => {});

        for (const b of [biz1, biz2]) {
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

        for (const u of [user1, user2, platformAdmin]) {
            if (u) await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('1. Multidimensional query filters: business, date range, status, party match accurately', async () => {
        const rep = await reportingWorkbenchService.queryWorkbench({
            user: user1,
            dataset: 'INVOICES',
            filters: {
                businessIds: [biz1.id],
                dateFrom: '2026-10-01',
                dateTo: '2026-10-31',
                status: 'ACTIVE',
                clientId: client1.id
            }
        });

        assert.strictEqual(rep.records.length, 1);
        assert.strictEqual(rep.records[0].referenceNumber, inv1.invoiceNumber);
        assert.strictEqual(rep.records[0].grandTotal, 23600);
        assert.strictEqual(rep.summary.grandTotal, 23600);
        assert.strictEqual(rep.summary.subtotal, 20000);
        assert.strictEqual(rep.summary.taxAmount, 3600);
    });

    it('2. Format parity: identical filtered dataset successfully renders across CSV, Excel, PDF, and Print', async () => {
        const rep = await reportingWorkbenchService.queryWorkbench({
            user: user1,
            dataset: 'INVOICES',
            filters: { businessIds: [biz1.id] }
        });

        // 2.1 CSV
        const csv = reportingWorkbenchService.generateWorkbenchCsv(rep);
        assert.strictEqual(typeof csv, 'string');
        assert.match(csv, /Report Parity Corp A/);
        assert.match(csv, /23600/);

        // 2.2 Excel
        const excel = await reportingWorkbenchService.generateWorkbenchExcel(rep);
        assert.ok(Buffer.isBuffer(excel));
        assert.ok(excel.length > 500);

        // 2.3 PDF
        const pdf = await reportingWorkbenchService.generateWorkbenchPdf(rep);
        assert.ok(Buffer.isBuffer(pdf));
        assert.strictEqual(pdf.slice(0, 4).toString(), '%PDF');

        // 2.4 Print HTML
        const printHtml = reportingWorkbenchService.generateWorkbenchHtmlPrint(rep);
        assert.strictEqual(typeof printHtml, 'string');
        assert.match(printHtml, /@media print/);
        assert.match(printHtml, /Report Parity Corp A/);
        assert.match(printHtml, /23600/);
    });

    it('3. Multi-currency segregation: values from different businesses are never added without conversion', async () => {
        const rep = await reportingWorkbenchService.queryWorkbench({
            user: platformAdmin,
            dataset: 'INVOICES',
            filters: { businessIds: [biz1.id, biz2.id] }
        });

        assert.strictEqual(rep.summary.isSingleCurrency, false);
        assert.ok(rep.summary.mixedCurrencyWarning);
        assert.strictEqual(rep.summary.currencyBreakdown.INR.grandTotal, 23600);
        assert.strictEqual(rep.summary.currencyBreakdown.USD.grandTotal, 500);
        assert.match(rep.summary.displayGrandTotal, /INR 23600\.00/);
        assert.match(rep.summary.displayGrandTotal, /USD 500\.00/);
    });

    it('4. Tenant boundary enforcement: user cannot query across unauthorized businesses', async () => {
        await assert.rejects(
            async () => {
                await reportingWorkbenchService.queryWorkbench({
                    user: user1,
                    dataset: 'INVOICES',
                    filters: { businessIds: [biz2.id] }
                });
            },
            { name: 'ForbiddenError' }
        );
    });

    it('5. Revoked membership immediately invalidates report access', async () => {
        // Revoke user1 from biz1
        await businessService.revokeMember(biz1.id, user1.id);

        await assert.rejects(
            async () => {
                await reportingWorkbenchService.queryWorkbench({
                    user: user1,
                    dataset: 'INVOICES',
                    filters: { businessIds: [biz1.id] }
                });
            },
            { name: 'ForbiddenError' }
        );

        // Re-grant for clean teardown
        await businessService.addOrUpdateMember({
            businessId: biz1.id,
            userId: user1.id,
            role: 'MANAGER'
        });
    });
});
