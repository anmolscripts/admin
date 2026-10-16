'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const numberingService = require('../app/services/numbering.service');
const businessService = require('../app/services/business.service');

describe('Identifier Recovery & Watermark Guarantees Test Suite', () => {
    let testBiz;
    let client;
    const testYear = 2029;
    const testMonth = 6;
    const testDate = new Date(`${testYear}-06-15T10:00:00Z`);

    before(async () => {
        const ts = Date.now();
        testBiz = await businessService.createBusiness({
            code: `RECOV_${ts}`,
            name: 'Recovery Test Org',
            currency: 'INR',
            timezone: 'Asia/Kolkata'
        });

        client = await prisma.client.create({
            data: {
                businessId: testBiz.id,
                name: 'Recovery Test Client',
                active: true
            }
        });
    });

    after(async () => {
        if (client) {
            await prisma.invoice.deleteMany({ where: { clientId: client.id } }).catch(() => {});
            await prisma.client.delete({ where: { id: client.id } }).catch(() => {});
        }
        if (testBiz && testBiz.id) {
            await prisma.userActivityLog.deleteMany({ where: { businessId: testBiz.id } }).catch(() => {});
            await prisma.numberingSequence.deleteMany({ where: { businessId: testBiz.id } }).catch(() => {});
            await prisma.businessMembership.deleteMany({ where: { businessId: testBiz.id } }).catch(() => {});
            await prisma.businessPrefixConfig.deleteMany({ where: { businessId: testBiz.id } }).catch(() => {});
            await prisma.$executeRawUnsafe('UPDATE chart_of_accounts SET parentId = NULL WHERE businessId = ?', testBiz.id).catch(() => {});
            await prisma.chartOfAccount.deleteMany({ where: { businessId: testBiz.id } }).catch(() => {});
            await prisma.financialYear.deleteMany({ where: { businessId: testBiz.id } }).catch(() => {});
            await prisma.businessProfile.deleteMany({ where: { businessId: testBiz.id } }).catch(() => {});
            await prisma.business.delete({ where: { id: testBiz.id } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('1. Role authorization: non-admin and non-owner callers are strictly rejected', async () => {
        await assert.rejects(
            async () => {
                await numberingService.syncAndRecoverSequence({
                    businessId: testBiz.id,
                    entityType: 'INVOICE',
                    year: testYear,
                    month: testMonth,
                    actorUserId: 99,
                    actorRole: 'STAFF'
                });
            },
            (err) => {
                assert.strictEqual(err.name, 'NumberingError');
                assert.strictEqual(err.statusCode, 403);
                assert.match(err.message, /Only administrators and business owners/i);
                return true;
            }
        );
    });

    it('2. Watermark Unknowability: reports watermarkUnknowable when both records and audit history are absent', async () => {
        // Year 2045 Month 11 has 0 records and 0 audit entries
        const result = await numberingService.syncAndRecoverSequence({
            businessId: testBiz.id,
            entityType: 'INVOICE',
            year: 2045,
            month: 11,
            actorUserId: 1,
            actorRole: 'OWNER'
        });

        assert.strictEqual(result.watermarkUnknowable, true);
        assert.strictEqual(result.recordsScanned, 0);
        assert.strictEqual(result.recoveredNumber, '0');
        assert.strictEqual(result.recovered, false);
        assert.match(result.reason, /absent from both current database records and durable audit\/tombstone history/i);
        assert.match(result.reason, /original sequence watermark is unknowable/i);
    });

    it('3. Desynchronization recovery: recovers counter when records exist in target table', async () => {
        // Create 3 invoices in June 2029
        for (let i = 1; i <= 3; i++) {
            await prisma.invoice.create({
                data: {
                    businessId: testBiz.id,
                    invoiceNumber: `INVO/${testYear}/06/${i}`,
                    invoiceDate: testDate,
                    clientId: client.id,
                    clientName: client.name,
                    subtotal: 1000 * i,
                    gstAmount: 0,
                    roundOff: 0,
                    grandTotal: 1000 * i,
                    status: 'ACTIVE',
                    documentType: 'INVOICE',
                    createdById: 1,
                    updatedById: 1
                }
            });
        }

        // Artificially delete the sequence record to simulate sequence-table desynchronization
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBiz.id,
                entityType: 'INVOICE',
                year: testYear,
                month: testMonth
            }
        });

        // Run recovery
        const recoveryResult = await numberingService.syncAndRecoverSequence({
            businessId: testBiz.id,
            entityType: 'INVOICE',
            year: testYear,
            month: testMonth,
            actorUserId: 1,
            actorRole: 'ADMIN'
        });

        assert.strictEqual(recoveryResult.recovered, true);
        assert.strictEqual(recoveryResult.recoveredNumber, '3');
        assert.strictEqual(recoveryResult.recordsScanned, 3);
        assert.strictEqual(recoveryResult.watermarkUnknowable, false);

        // Next allocated number must be /4
        const nextAllocated = await numberingService.allocateNumber({
            businessId: testBiz.id,
            entityType: 'INVOICE',
            date: testDate
        });
        assert.strictEqual(nextAllocated, `INVO/${testYear}/06/4`);
    });

    it('4. Monotonic recovery guarantee: recovery NEVER decreases an existing sequence counter', async () => {
        // Sequence is currently at 4. If we run recovery with only 3 records in DB, sequence must NOT regress to 3.
        const result = await numberingService.syncAndRecoverSequence({
            businessId: testBiz.id,
            entityType: 'INVOICE',
            year: testYear,
            month: testMonth,
            actorUserId: 1,
            actorRole: 'ADMIN'
        });

        assert.strictEqual(result.recoveredNumber, '4');
        const seq = await prisma.numberingSequence.findUnique({
            where: {
                businessId_entityType_year_month: {
                    businessId: testBiz.id,
                    entityType: 'INVOICE',
                    year: testYear,
                    month: testMonth
                }
            }
        });
        assert.strictEqual(seq.currentNumber.toString(), '4');
    });

    it('5. Allocate number automatically avoids collision if sequence was desynchronized', async () => {
        // Manually force sequence table back to 1
        await prisma.numberingSequence.update({
            where: {
                businessId_entityType_year_month: {
                    businessId: testBiz.id,
                    entityType: 'INVOICE',
                    year: testYear,
                    month: testMonth
                }
            },
            data: { currentNumber: 1n }
        });

        // Invoices /1, /2, /3 exist. allocateNumber must skip existing and advance past /3 to /5 (or /4 if /4 was unpersisted)
        const allocated = await numberingService.allocateNumber({
            businessId: testBiz.id,
            entityType: 'INVOICE',
            date: testDate
        });

        const num = parseInt(allocated.split('/').pop(), 10);
        assert.ok(num >= 4, `Allocated number ${allocated} must not collide with existing /1, /2, /3`);
    });
});
