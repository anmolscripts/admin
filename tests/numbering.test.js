'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const prisma = require('../app/config/prisma');
const numberingService = require('../app/services/numbering.service');
const businessController = require('../app/controllers/business.controller');

describe('Enterprise Centralized Numbering Service Test Suite', () => {
    let testBusiness1Id = 1;
    let testBusiness2Id;

    before(async () => {
        // Ensure default business 1 exists
        let b1 = await prisma.business.findUnique({ where: { id: 1 } });
        if (!b1) {
            b1 = await prisma.business.create({
                data: {
                    id: 1,
                    code: 'DEFAULT_TEST',
                    name: 'Test Business 1',
                    currency: 'INR'
                }
            });
        }
        testBusiness1Id = b1.id;

        // Create independent business 2
        let b2 = await prisma.business.findUnique({ where: { code: 'BIZ_TWO_TEST' } });
        if (!b2) {
            b2 = await prisma.business.create({
                data: {
                    code: 'BIZ_TWO_TEST',
                    name: 'Test Business 2',
                    currency: 'USD'
                }
            });
        }
        testBusiness2Id = b2.id;

        // Clean up any conflicting mock invoices from previous test runs
        await prisma.invoiceItem.deleteMany({
            where: { invoice: { businessId: testBusiness1Id, invoiceNumber: { startsWith: 'INVO/2026/10/' } } }
        }).catch(() => {});
        await prisma.invoiceItem.deleteMany({
            where: { invoice: { businessId: testBusiness1Id, invoiceNumber: { startsWith: 'QUOT/2026/10/' } } }
        }).catch(() => {});
        await prisma.invoiceRevision.deleteMany({
            where: { invoice: { businessId: testBusiness1Id, invoiceNumber: { startsWith: 'INVO/2026/10/' } } }
        }).catch(() => {});
        await prisma.payment.deleteMany({
            where: { invoice: { businessId: testBusiness1Id, invoiceNumber: { startsWith: 'INVO/2026/10/' } } }
        }).catch(() => {});
        await prisma.invoice.deleteMany({
            where: { businessId: testBusiness1Id, invoiceNumber: { startsWith: 'INVO/2026/10/' } }
        }).catch(() => {});
        await prisma.invoice.deleteMany({
            where: { businessId: testBusiness1Id, invoiceNumber: { startsWith: 'QUOT/2026/10/' } }
        }).catch(() => {});
    });

    after(async () => {
        await prisma.$disconnect();
    });

    it('1. First invoice in October 2026 is INVO/2026/10/1', async () => {
        const dateOct = new Date('2026-10-05T10:00:00Z');
        // Clean any existing sequence for this test slot
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 10
            }
        });

        const num1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: dateOct
        });
        assert.strictEqual(num1, 'INVO/2026/10/1');
    });

    it('2. Subsequent invoices increment sequentially without leading zeroes', async () => {
        const dateOct = new Date('2026-10-15T12:00:00Z');
        const num2 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: dateOct
        });
        assert.strictEqual(num2, 'INVO/2026/10/2');

        const num3 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: dateOct
        });
        assert.strictEqual(num3, 'INVO/2026/10/3');
    });

    it('3. Quotation uses QUOT prefix and maintains an independent sequence', async () => {
        const dateOct = new Date('2026-10-12T10:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'QUOTATION',
                year: 2026,
                month: 10
            }
        });

        const q1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'QUOTATION',
            date: dateOct
        });
        assert.strictEqual(q1, 'QUOT/2026/10/1');

        const q2 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'QUOTATION',
            date: dateOct
        });
        assert.strictEqual(q2, 'QUOT/2026/10/2');
    });

    it('4. November starts its corresponding series at /1', async () => {
        const dateNov = new Date('2026-11-01T09:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 11
            }
        });

        const numNov1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: dateNov
        });
        assert.strictEqual(numNov1, 'INVO/2026/11/1');
    });

    it('5. January 2027 starts at .../2027/01/1 across year boundary', async () => {
        const dateJan27 = new Date('2027-01-05T14:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2027,
                month: 1
            }
        });

        const numJan1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: dateJan27
        });
        assert.strictEqual(numJan1, 'INVO/2027/01/1');
    });

    it('6. Calendar year/month is used, not Indian financial year', async () => {
        // February 2026 is in Indian FY 2025-26, but calendar month is 02 and calendar year is 2026
        const dateFeb = new Date('2026-02-15T00:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 2
            }
        });

        const numFeb = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: dateFeb
        });
        assert.strictEqual(numFeb, 'INVO/2026/02/1');
    });

    it('7. Different businesses maintain independent sequences', async () => {
        const dateOct = new Date('2026-10-18T10:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness2Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 10
            }
        });

        const b2Num1 = await numberingService.allocateNumber({
            businessId: testBusiness2Id,
            entityType: 'INVOICE',
            date: dateOct
        });
        // Starts at 1 for business 2 even though business 1 is at 3
        assert.strictEqual(b2Num1, 'INVO/2026/10/1');
    });

    it('8. Failed record-creation transaction rolls back sequence increment', async () => {
        const dateMarch = new Date('2026-03-10T10:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness2Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 3
            }
        });

        // Intentional rollback transaction
        try {
            await prisma.$transaction(async (tx) => {
                await numberingService.allocateNumber({
                    businessId: testBusiness2Id,
                    entityType: 'INVOICE',
                    date: dateMarch,
                    tx
                });
                throw new Error('Forced simulation of failed invoice creation');
            });
        } catch (err) {
            assert.strictEqual(err.message, 'Forced simulation of failed invoice creation');
        }

        // After rollback, the sequence record was either rolled back or can allocate 1
        const nextNum = await numberingService.allocateNumber({
            businessId: testBusiness2Id,
            entityType: 'INVOICE',
            date: dateMarch
        });
        assert.strictEqual(nextNum, 'INVO/2026/03/1');
    });

    it('9. Prefix change does NOT reset the underlying integer sequence', async () => {
        const dateApril = new Date('2026-04-10T10:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'EXPENSE',
                year: 2026,
                month: 4
            }
        });

        const e1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'EXPENSE',
            date: dateApril
        });
        assert.strictEqual(e1, 'EXP/2026/04/1');

        // Configure custom prefix 'EXPN' for this business
        await numberingService.setPrefixForEntity(testBusiness1Id, 'EXPENSE', 'EXPN');

        const e2 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'EXPENSE',
            date: dateApril
        });
        // Increments to 2 under new prefix!
        assert.strictEqual(e2, 'EXPN/2026/04/2');

        // Reset prefix back to default
        await numberingService.setPrefixForEntity(testBusiness1Id, 'EXPENSE', 'EXP');
    });

    it('10. Safely handles large 14-digit integer values without precision loss', async () => {
        const dateMay = new Date('2026-05-01T10:00:00Z');
        const largeVal = 99999999999990n; // 14-digit BigInt

        await prisma.numberingSequence.upsert({
            where: {
                businessId_entityType_year_month: {
                    businessId: testBusiness1Id,
                    entityType: 'INVOICE',
                    year: 2026,
                    month: 5
                }
            },
            create: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 5,
                currentNumber: largeVal
            },
            update: {
                currentNumber: largeVal
            }
        });

        const nextLarge = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: dateMay
        });

        assert.strictEqual(nextLarge, 'INVO/2026/05/99999999999991');
    });

    it('11. High concurrency: 20 concurrent requests allocate 20 unique numbers without collision', async () => {
        const dateJune = new Date('2026-06-15T10:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 6
            }
        });

        const concurrentTasks = Array.from({ length: 20 }, () =>
            numberingService.allocateNumber({
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                date: dateJune
            })
        );

        const results = await Promise.all(concurrentTasks);
        assert.strictEqual(results.length, 20);

        const uniqueSet = new Set(results);
        assert.strictEqual(uniqueSet.size, 20, 'All 20 concurrent numbers must be unique');

        // Verify increments from 1 to 20 exist
        const increments = results.map(r => parseInt(r.split('/')[3], 10)).sort((a, b) => a - b);
        for (let i = 1; i <= 20; i++) {
            assert.strictEqual(increments[i - 1], i);
        }
    });

    it('12. Prefix validation rejects invalid prefixes with slashes', () => {
        assert.throws(() => numberingService.validatePrefix('INV/2026'), {
            name: 'NumberingError',
            message: /must not contain forward or backward slashes/
        });
        assert.throws(() => numberingService.validatePrefix(''), {
            name: 'NumberingError'
        });
        assert.strictEqual(numberingService.validatePrefix('  bill  '), 'BILL');
    });

    it('13. syncAndRecoverSequence recovers sequence from verifiable records and writes audit log', async () => {
        const testDate = new Date('2026-11-20T12:00:00Z');
        // Ensure clean state for 2026/11 for business 1
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 11
            }
        });

        // Create a test client & invoices directly simulating issued records up to increment 5
        const client = await prisma.client.create({
            data: {
                businessId: testBusiness1Id,
                name: 'Recovery Test Client Corp',
                active: true
            }
        });

        const inv = await prisma.invoice.create({
            data: {
                businessId: testBusiness1Id,
                invoiceNumber: 'INVO/2026/11/5',
                invoiceDate: testDate,
                clientId: client.id,
                clientName: client.name,
                subtotal: 500,
                gstAmount: 0,
                roundOff: 0,
                grandTotal: 500,
                status: 'ACTIVE',
                documentType: 'INVOICE',
                createdById: 1,
                updatedById: 1
            }
        });

        try {
            // Sequence table currently has NO row or 0 for 2026/11
            const recoveryResult = await numberingService.syncAndRecoverSequence({
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 11,
                actorUserId: 1
            });

            assert.strictEqual(recoveryResult.recovered, true);
            assert.strictEqual(recoveryResult.recoveredNumber, '5');

            // Verify the sequence row is now 5
            const seq = await prisma.numberingSequence.findUnique({
                where: {
                    businessId_entityType_year_month: {
                        businessId: testBusiness1Id,
                        entityType: 'INVOICE',
                        year: 2026,
                        month: 11
                    }
                }
            });
            assert.ok(seq);
            assert.strictEqual(seq.currentNumber.toString(), '5');

            // Next allocated number must be INVO/2026/11/6 without duplicate
            const nextAlloc = await numberingService.allocateNumber({
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                date: testDate
            });
            assert.strictEqual(nextAlloc, 'INVO/2026/11/6');

            // Verify audit log entry in user_activity_logs
            const auditLog = await prisma.userActivityLog.findFirst({
                where: {
                    businessId: testBusiness1Id,
                    action: 'SEQUENCE_RECOVERED',
                    module: 'NUMBERING'
                },
                orderBy: { id: 'desc' }
            });
            assert.ok(auditLog, 'Must record immutable audit log for sequence recovery');
            assert.strictEqual(auditLog.action, 'SEQUENCE_RECOVERED');
        } finally {
            await prisma.invoice.deleteMany({ where: { clientId: client.id } });
            await prisma.client.delete({ where: { id: client.id } });
        }
    });

    it('14. Recovery never regresses currentNumber backwards (monotonic guarantee)', async () => {
        // Explicitly set current sequence to 10
        await prisma.numberingSequence.upsert({
            where: {
                businessId_entityType_year_month: {
                    businessId: testBusiness1Id,
                    entityType: 'INVOICE',
                    year: 2026,
                    month: 12
                }
            },
            create: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 12,
                currentNumber: 10n
            },
            update: {
                currentNumber: 10n
            }
        });

        // Run recovery when only record in DB is lower (or 0)
        const result = await numberingService.syncAndRecoverSequence({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            year: 2026,
            month: 12
        });

        // Recovered number must NOT decrease from 10
        assert.strictEqual(result.recoveredNumber, '10');
        const seq = await prisma.numberingSequence.findUnique({
            where: {
                businessId_entityType_year_month: {
                    businessId: testBusiness1Id,
                    entityType: 'INVOICE',
                    year: 2026,
                    month: 12
                }
            }
        });
        assert.strictEqual(seq.currentNumber.toString(), '10');
    });

    it('15. allocateNumber skips existing candidates if sequence was artificially desynchronized', async () => {
        const testDate = new Date('2027-02-15T12:00:00Z');
        const client = await prisma.client.create({
            data: {
                businessId: testBusiness1Id,
                name: 'Collision Skip Client',
                active: true
            }
        });

        // Insert document with identifier 'INVO/2027/02/1'
        await prisma.invoice.create({
            data: {
                businessId: testBusiness1Id,
                invoiceNumber: 'INVO/2027/02/1',
                invoiceDate: testDate,
                clientId: client.id,
                clientName: client.name,
                subtotal: 100,
                gstAmount: 0,
                roundOff: 0,
                grandTotal: 100,
                status: 'ACTIVE',
                documentType: 'INVOICE',
                createdById: 1,
                updatedById: 1
            }
        });

        // Reset sequence table row to 0
        await prisma.numberingSequence.upsert({
            where: {
                businessId_entityType_year_month: {
                    businessId: testBusiness1Id,
                    entityType: 'INVOICE',
                    year: 2027,
                    month: 2
                }
            },
            create: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2027,
                month: 2,
                currentNumber: 0n
            },
            update: {
                currentNumber: 0n
            }
        });

        try {
            // Allocation must detect candidate 'INVO/2027/02/1' exists and advance to /2
            const allocated = await numberingService.allocateNumber({
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                date: testDate
            });

            assert.strictEqual(allocated, 'INVO/2027/02/2', 'Must skip existing candidate and allocate next safe number');
        } finally {
            await prisma.invoice.deleteMany({ where: { clientId: client.id } });
            await prisma.client.delete({ where: { id: client.id } });
        }
    });

    it('16. syncAndRecoverSequence reports watermarkUnknowable when both records and audit history are absent', async () => {
        // Use an unused period like year 2035 month 5 where zero records or audit logs exist
        const result = await numberingService.syncAndRecoverSequence({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            year: 2035,
            month: 5,
            actorUserId: 1,
            actorRole: 'OWNER'
        });

        assert.strictEqual(result.watermarkUnknowable, true);
        assert.strictEqual(result.recordsScanned, 0);
        assert.strictEqual(result.recoveredNumber, '0');
        assert.match(result.reason, /absent from both current database records and durable audit\/tombstone history/i);
        assert.match(result.reason, /original sequence watermark is unknowable/i);
    });

    it('17. syncAndRecoverSequence strictly enforces role authorization (rejects non-admin/non-owner with 403)', async () => {
        await assert.rejects(
            async () => {
                await numberingService.syncAndRecoverSequence({
                    businessId: testBusiness1Id,
                    entityType: 'INVOICE',
                    year: 2026,
                    month: 11,
                    actorUserId: 2,
                    actorRole: 'VIEWER'
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

    it('18. renderNumberingConfig passes prefixes, activeSequences, and businessId to view', async () => {
        let renderedView = null;
        let renderedData = null;
        const req = {
            session: { user: { id: 1, role: 'ADMIN' } },
            query: { businessId: String(testBusiness1Id) },
            csrfToken: () => 'mock-csrf-token'
        };
        const res = {
            locals: {},
            render: (view, data) => {
                renderedView = view;
                renderedData = data;
            },
            status: () => res
        };

        await businessController.renderNumberingConfig(req, res, (err) => { if (err) throw err; });

        assert.strictEqual(renderedView, 'admin/numbering');
        assert.ok(Array.isArray(renderedData.prefixes), 'prefixes must be an array');
        assert.ok(renderedData.prefixes.length > 0, 'prefixes must contain default entity series');
        assert.ok(Array.isArray(renderedData.activeSequences), 'activeSequences must be an array');
        assert.strictEqual(renderedData.businessId, testBusiness1Id);
        assert.strictEqual(renderedData.csrfToken, 'mock-csrf-token');
        assert.ok(renderedData.prefixes.some(p => p.entityType === 'INVOICE' && p.sample.includes('/')));
    });

    it('19. renderNumberingConfig handles empty state when no active sequences exist', async () => {
        let renderedData = null;
        const req = {
            session: { user: { id: 1, role: 'ADMIN' } },
            query: { businessId: String(testBusiness2Id) },
            csrfToken: () => 'mock-csrf-token'
        };
        const res = {
            locals: {},
            render: (view, data) => { renderedData = data; },
            status: () => res
        };

        // Clear sequences for testBusiness2Id
        await prisma.numberingSequence.deleteMany({ where: { businessId: testBusiness2Id } });

        await businessController.renderNumberingConfig(req, res, (err) => { if (err) throw err; });

        assert.ok(Array.isArray(renderedData.prefixes), 'prefixes must still be populated in empty state');
        assert.ok(Array.isArray(renderedData.activeSequences), 'activeSequences must be empty array');
        assert.strictEqual(renderedData.activeSequences.length, 0);
    });

    it('20. renderNumberingConfig rejects unauthorized non-admin user with 403', async () => {
        let statusCode = null;
        let renderedView = null;
        const req = {
            session: { user: { id: 9999, role: 'STAFF' } },
            query: { businessId: String(testBusiness1Id) },
            csrfToken: () => 'mock-csrf-token'
        };
        const res = {
            locals: {},
            status: (code) => {
                statusCode = code;
                return res;
            },
            render: (view) => {
                renderedView = view;
            }
        };

        await businessController.renderNumberingConfig(req, res, () => {});

        assert.strictEqual(statusCode, 403);
        assert.strictEqual(renderedView, 'errors/403');
    });

    it('21. updatePrefixConfig validates syntax, enforces authorization, and updates prefix', async () => {
        // Test unauthorized update
        let unauthorizedStatus = null;
        let unauthorizedJson = null;
        const unauthorizedReq = {
            session: { user: { id: 9999, role: 'STAFF' } },
            params: { id: String(testBusiness1Id) },
            body: { entityType: 'INVOICE', prefix: 'INV' },
            xhr: true,
            headers: { accept: 'application/json' }
        };
        const unauthorizedRes = {
            status: (code) => {
                unauthorizedStatus = code;
                return unauthorizedRes;
            },
            json: (data) => {
                unauthorizedJson = data;
            }
        };
        await businessController.updatePrefixConfig(unauthorizedReq, unauthorizedRes, () => {});
        assert.strictEqual(unauthorizedStatus, 403);
        assert.strictEqual(unauthorizedJson.success, false);

        // Test invalid prefix syntax (contains slash)
        let invalidStatus = null;
        let invalidJson = null;
        const invalidReq = {
            session: { user: { id: 1, role: 'ADMIN' } },
            params: { id: String(testBusiness1Id) },
            body: { entityType: 'INVOICE', prefix: 'INV/2026' },
            xhr: true,
            headers: { accept: 'application/json' }
        };
        const invalidRes = {
            status: (code) => {
                invalidStatus = code;
                return invalidRes;
            },
            json: (data) => {
                invalidJson = data;
            }
        };
        await businessController.updatePrefixConfig(invalidReq, invalidRes, () => {});
        assert.strictEqual(invalidStatus, 400);
        assert.match(invalidJson.error, /slash/i);

        // Test valid prefix update
        let validStatus = null;
        let validJson = null;
        const validReq = {
            session: { user: { id: 1, role: 'ADMIN' } },
            params: { id: String(testBusiness1Id) },
            body: { entityType: 'INVOICE', prefix: 'INVOICE' },
            xhr: true,
            headers: { accept: 'application/json' }
        };
        const validRes = {
            status: (code) => {
                validStatus = code;
                return validRes;
            },
            json: (data) => {
                validJson = data;
            }
        };
        await businessController.updatePrefixConfig(validReq, validRes, () => {});
        assert.strictEqual(validJson.success, true);
        assert.strictEqual(validJson.config.prefix, 'INVOICE');

        // Reset prefix back to default
        await numberingService.setPrefixForEntity(testBusiness1Id, 'INVOICE', 'INVO');
    });

    it('22. allocates sequential codes for master entities (CLIENT, SUPPLIER, ITEM, UNIT)', async () => {
        const octDate = new Date('2026-10-15T10:00:00Z');
        const clientCode = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'CLIENT',
            date: octDate
        });
        const supplierCode = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'SUPPLIER',
            date: octDate
        });
        const itemCode = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'ITEM',
            date: octDate
        });
        const unitCode = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'UNIT',
            date: octDate
        });

        assert.match(clientCode, /^CUST\/2026\/10\/\d+$/);
        assert.match(supplierCode, /^SUPP\/2026\/10\/\d+$/);
        assert.match(itemCode, /^ITEM\/2026\/10\/\d+$/);
        assert.match(unitCode, /^UNIT\/2026\/10\/\d+$/);
    });

    it('23. master record numbering enforces monthly rollover and cross-business isolation', async () => {
        const octDate = new Date('2026-10-20T10:00:00Z');
        const novDate = new Date('2026-11-01T10:00:00Z');

        // Clear existing sequences for this test window
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: { in: [testBusiness1Id, testBusiness2Id] },
                entityType: 'CLIENT',
                year: 2026,
                month: { in: [10, 11] }
            }
        });

        const biz1Oct1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'CLIENT',
            date: octDate
        });
        const biz2Oct1 = await numberingService.allocateNumber({
            businessId: testBusiness2Id,
            entityType: 'CLIENT',
            date: octDate
        });

        // Cross-business isolation: both start at /1
        assert.strictEqual(biz1Oct1, 'CUST/2026/10/1');
        assert.strictEqual(biz2Oct1, 'CUST/2026/10/1');

        // Monthly rollover: November starts at /1
        const biz1Nov1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'CLIENT',
            date: novDate
        });
        assert.strictEqual(biz1Nov1, 'CUST/2026/11/1');
    });

    it('24. renderNumberingConfig displays prefixes for all master records (CLIENT, SUPPLIER, ITEM, UNIT)', async () => {
        let renderedData = null;
        const req = {
            session: { user: { id: 1, role: 'ADMIN' } },
            query: { businessId: String(testBusiness1Id) },
            csrfToken: () => 'mock-csrf-token'
        };
        const res = {
            locals: {},
            render: (view, data) => { renderedData = data; },
            status: () => res
        };

        await businessController.renderNumberingConfig(req, res, () => {});

        const entityTypes = renderedData.prefixes.map(p => p.entityType);
        assert.ok(entityTypes.includes('CLIENT'), 'Prefixes must include CLIENT');
        assert.ok(entityTypes.includes('SUPPLIER'), 'Prefixes must include SUPPLIER');
        assert.ok(entityTypes.includes('ITEM'), 'Prefixes must include ITEM');
        assert.ok(entityTypes.includes('UNIT'), 'Prefixes must include UNIT');
    });

    it('25. December-to-January year boundary reset enforces independent sequence counters', async () => {
        const decDate = new Date('2026-12-15T12:00:00Z');
        const janDate = new Date('2027-01-15T12:00:00Z');

        // Clean sequences for these slots
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                OR: [
                    { year: 2026, month: 12 },
                    { year: 2027, month: 1 }
                ]
            }
        });

        const dec1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: decDate
        });
        const dec2 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: decDate
        });

        assert.strictEqual(dec1, 'INVO/2026/12/1');
        assert.strictEqual(dec2, 'INVO/2026/12/2');

        const jan1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: janDate
        });
        assert.strictEqual(jan1, 'INVO/2027/01/1');
    });

    it('26. Complete coverage matrix: every registered entity type generates exact PREFIX/YYYY/MM/INCREMENT format', async () => {
        const testDate = new Date('2026-10-11T12:00:00Z');
        const entityTypes = [
            'INVOICE', 'QUOTATION', 'CREDIT_NOTE', 'DEBIT_NOTE',
            'PURCHASE_ORDER', 'SUPPLIER_BILL', 'PAYMENT', 'SUPPLIER_PAYMENT',
            'JOURNAL', 'EXPENSE', 'OTHER_INCOME', 'ITEM', 'UNIT',
            'CLIENT', 'SUPPLIER', 'EMPLOYEE', 'PROJECT', 'STOCK_MOVEMENT',
            'REIMBURSEMENT'
        ];

        for (const entityType of entityTypes) {
            const num = await numberingService.allocateNumber({
                businessId: testBusiness1Id,
                entityType,
                date: testDate
            });

            // Must strictly match PREFIX/YYYY/MM/INCREMENT pattern
            const pattern = /^[A-Z0-9_-]+\/2026\/10\/[1-9]\d*$/;
            assert.match(
                num,
                pattern,
                `Entity ${entityType} produced invalid identifier format: ${num}`
            );

            // Verify increment has NO leading zeroes
            const parts = num.split('/');
            assert.strictEqual(parts.length, 4, `${num} must contain exactly 4 parts`);
            assert.strictEqual(parts[1], '2026', 'Year must be 2026');
            assert.strictEqual(parts[2], '10', 'Month must be 10');
            assert.ok(!parts[3].startsWith('0'), 'Increment must have no leading zeroes');
        }
    });

    it('27. Changing prefix preserves existing historical document numbers without renaming or counter reset', async () => {
        const dateTest = new Date('2026-10-25T10:00:00Z');
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'PROJECT',
                year: 2026,
                month: 10
            }
        });

        const p1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'PROJECT',
            date: dateTest
        });
        assert.strictEqual(p1, 'PROJ/2026/10/1');

        // Update prefix to 'PRJ'
        await numberingService.setPrefixForEntity(testBusiness1Id, 'PROJECT', 'PRJ');

        const p2 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'PROJECT',
            date: dateTest
        });
        assert.strictEqual(p2, 'PRJ/2026/10/2');

        // Historical p1 is immutable and remains 'PROJ/2026/10/1'
        assert.strictEqual(p1, 'PROJ/2026/10/1');

        // Revert prefix back to default PROJ
        await numberingService.setPrefixForEntity(testBusiness1Id, 'PROJECT', 'PROJ');
    });

    it('28. Exact numbering service keys audit: getPrefixForEntity and peekNextNumber match creation service entities', async () => {
        const testDate = new Date('2026-10-15T12:00:00Z');

        // Audit the 19 canonical entities passed by record-creation services
        const canonicalKeyAudits = [
            { entity: 'INVOICE', expectedPrefix: 'INVO', service: 'invoice.service.js' },
            { entity: 'QUOTATION', expectedPrefix: 'QUOT', service: 'invoice.service.js' },
            { entity: 'CREDIT_NOTE', expectedPrefix: 'CRN', service: 'creditDebitNote.service.js' },
            { entity: 'DEBIT_NOTE', expectedPrefix: 'DBN', service: 'creditDebitNote.service.js' },
            { entity: 'PURCHASE_ORDER', expectedPrefix: 'PO', service: 'purchaseOrder.service.js' },
            { entity: 'SUPPLIER_BILL', expectedPrefix: 'SBILL', service: 'supplierBill.service.js' },
            { entity: 'PAYMENT', expectedPrefix: 'RCPT', service: 'payment.service.js' },
            { entity: 'SUPPLIER_PAYMENT', expectedPrefix: 'SPAY', service: 'supplierPayment.service.js' },
            { entity: 'JOURNAL', expectedPrefix: 'JRNL', service: 'journal.service.js' },
            { entity: 'EXPENSE', expectedPrefix: 'EXP', service: 'expense.service.js' },
            { entity: 'OTHER_INCOME', expectedPrefix: 'INC', service: 'otherIncome.service.js' },
            { entity: 'ITEM', expectedPrefix: 'ITEM', service: 'item.service.js' },
            { entity: 'UNIT', expectedPrefix: 'UNIT', service: 'unit.service.js' },
            { entity: 'CLIENT', expectedPrefix: 'CUST', service: 'client.service.js' },
            { entity: 'SUPPLIER', expectedPrefix: 'SUPP', service: 'supplier.service.js' },
            { entity: 'EMPLOYEE', expectedPrefix: 'EMP', service: 'payroll.service.js' },
            { entity: 'PROJECT', expectedPrefix: 'PROJ', service: 'project.service.js' },
            { entity: 'STOCK_MOVEMENT', expectedPrefix: 'STK', service: 'stockMovement.service.js' },
            { entity: 'REIMBURSEMENT', expectedPrefix: 'REIMB', service: 'payroll.service.js' }
        ];

        for (const item of canonicalKeyAudits) {
            const prefix = await numberingService.getPrefixForEntity(testBusiness1Id, item.entity);
            assert.strictEqual(
                prefix,
                item.expectedPrefix,
                `Entity ${item.entity} from ${item.service} must have prefix ${item.expectedPrefix}, got ${prefix}`
            );
            assert.ok(
                numberingService.DEFAULT_PREFIXES[item.entity] !== undefined,
                `Entity ${item.entity} must be explicitly defined in DEFAULT_PREFIXES (never fallback)`
            );

            const peeked = await numberingService.peekNextNumber({
                businessId: testBusiness1Id,
                entityType: item.entity,
                date: testDate
            });
            assert.match(
                peeked,
                new RegExp(`^${item.expectedPrefix}/2026/10/\\d+$`),
                `peekNextNumber for ${item.entity} must start with ${item.expectedPrefix}/2026/10/`
            );
        }

        // Specific audit for JOURNAL vs JOURNAL_ENTRY
        const journalPrefix = await numberingService.getPrefixForEntity(testBusiness1Id, 'JOURNAL');
        const journalEntryPrefix = await numberingService.getPrefixForEntity(testBusiness1Id, 'JOURNAL_ENTRY');
        assert.strictEqual(journalPrefix, 'JRNL');
        assert.strictEqual(journalEntryPrefix, 'JRNL');

        // Specific audit for CREDIT_NOTE / DEBIT_NOTE vs shorthand CRN / DBN
        assert.strictEqual(await numberingService.getPrefixForEntity(testBusiness1Id, 'CREDIT_NOTE'), 'CRN');
        assert.strictEqual(await numberingService.getPrefixForEntity(testBusiness1Id, 'CRN'), 'CRN');
        assert.strictEqual(await numberingService.getPrefixForEntity(testBusiness1Id, 'DEBIT_NOTE'), 'DBN');
        assert.strictEqual(await numberingService.getPrefixForEntity(testBusiness1Id, 'DBN'), 'DBN');

        // Clean sequence for peek verification
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'QUOTATION',
                year: 2026,
                month: 10
            }
        });

        // Verify peek does NOT increment counter
        const peek1 = await numberingService.peekNextNumber({
            businessId: testBusiness1Id,
            entityType: 'QUOTATION',
            date: testDate
        });
        assert.strictEqual(peek1, 'QUOT/2026/10/1');

        const peek2 = await numberingService.peekNextNumber({
            businessId: testBusiness1Id,
            entityType: 'QUOTATION',
            date: testDate
        });
        assert.strictEqual(peek2, 'QUOT/2026/10/1', 'Peek must be idempotent and not increment sequence');

        // Verify independence between INVOICE and QUOTATION sequences
        await prisma.numberingSequence.deleteMany({
            where: {
                businessId: testBusiness1Id,
                entityType: 'INVOICE',
                year: 2026,
                month: 10
            }
        });

        const inv1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'INVOICE',
            date: testDate
        });
        const quot1 = await numberingService.allocateNumber({
            businessId: testBusiness1Id,
            entityType: 'QUOTATION',
            date: testDate
        });
        assert.strictEqual(inv1, 'INVO/2026/10/1');
        assert.strictEqual(quot1, 'QUOT/2026/10/1');
    });

    it('29. Registry completeness: PAYROLL_RUN, PAYROLL_PERIOD, and comprehensive aliases resolve accurately', async () => {
        // Payroll run and period prefix resolution
        const runPrefix = await numberingService.getPrefixForEntity(testBusiness1Id, 'PAYROLL_RUN');
        const periodPrefix = await numberingService.getPrefixForEntity(testBusiness1Id, 'PAYROLL_PERIOD');
        const payPrefix = await numberingService.getPrefixForEntity(testBusiness1Id, 'PAY');
        assert.strictEqual(runPrefix, 'PAY');
        assert.strictEqual(periodPrefix, 'PAY');
        assert.strictEqual(payPrefix, 'PAY');

        // Canonical alias mapping checks
        assert.strictEqual(numberingService.toCanonicalEntity('PAYROLL_RUN'), 'PAYROLL_PERIOD');
        assert.strictEqual(numberingService.toCanonicalEntity('BILL'), 'SUPPLIER_BILL');
        assert.strictEqual(await numberingService.getPrefixForEntity(testBusiness1Id, 'BILL'), 'SBILL');

        // Plural aliases normalization checks
        const pluralCases = [
            { alias: 'INVOICES', canonical: 'INVOICE', prefix: 'INVO' },
            { alias: 'QUOTATIONS', canonical: 'QUOTATION', prefix: 'QUOT' },
            { alias: 'CREDIT_NOTES', canonical: 'CREDIT_NOTE', prefix: 'CRN' },
            { alias: 'DEBIT_NOTES', canonical: 'DEBIT_NOTE', prefix: 'DBN' },
            { alias: 'PURCHASE_ORDERS', canonical: 'PURCHASE_ORDER', prefix: 'PO' },
            { alias: 'SUPPLIER_BILLS', canonical: 'SUPPLIER_BILL', prefix: 'SBILL' },
            { alias: 'PAYMENTS', canonical: 'PAYMENT', prefix: 'RCPT' },
            { alias: 'SUPPLIER_PAYMENTS', canonical: 'SUPPLIER_PAYMENT', prefix: 'SPAY' },
            { alias: 'JOURNALS', canonical: 'JOURNAL', prefix: 'JRNL' },
            { alias: 'EXPENSES', canonical: 'EXPENSE', prefix: 'EXP' },
            { alias: 'OTHER_INCOMES', canonical: 'OTHER_INCOME', prefix: 'INC' },
            { alias: 'ITEMS', canonical: 'ITEM', prefix: 'ITEM' },
            { alias: 'UNITS', canonical: 'UNIT', prefix: 'UNIT' },
            { alias: 'CLIENTS', canonical: 'CLIENT', prefix: 'CUST' },
            { alias: 'SUPPLIERS', canonical: 'SUPPLIER', prefix: 'SUPP' },
            { alias: 'EMPLOYEES', canonical: 'EMPLOYEE', prefix: 'EMP' },
            { alias: 'PROJECTS', canonical: 'PROJECT', prefix: 'PROJ' },
            { alias: 'STOCK_MOVEMENTS', canonical: 'STOCK_MOVEMENT', prefix: 'STK' },
            { alias: 'REIMBURSEMENTS', canonical: 'REIMBURSEMENT', prefix: 'REIMB' }
        ];

        for (const item of pluralCases) {
            assert.strictEqual(
                numberingService.toCanonicalEntity(item.alias),
                item.canonical,
                `Alias ${item.alias} must normalize to ${item.canonical}`
            );
            assert.strictEqual(
                await numberingService.getPrefixForEntity(testBusiness1Id, item.alias),
                item.prefix,
                `Alias ${item.alias} must resolve to prefix ${item.prefix}`
            );
        }

        // Exhaustive coverage check: every canonical entity must have description and default prefix
        for (const entity of numberingService.CANONICAL_ENTITIES) {
            assert.ok(numberingService.DEFAULT_PREFIXES[entity], `Missing DEFAULT_PREFIXES for canonical entity: ${entity}`);
            assert.ok(numberingService.ENTITY_DESCRIPTIONS[entity], `Missing ENTITY_DESCRIPTIONS for canonical entity: ${entity}`);
            assert.strictEqual(numberingService.toCanonicalEntity(entity), entity, `Canonical entity must map to itself: ${entity}`);
        }
    });

    it('30. Safeguard: allocateNumber and peekNextNumber throw NumberingError for PAYROLL_PERIOD/PAYROLL_RUN/PAY', async () => {
        const testDate = new Date('2026-10-15T12:00:00Z');
        const restrictedEntities = ['PAYROLL_PERIOD', 'PAYROLL_RUN', 'PAY'];

        for (const entityType of restrictedEntities) {
            await assert.rejects(
                async () => {
                    await numberingService.allocateNumber({
                        businessId: testBusiness1Id,
                        entityType,
                        date: testDate
                    });
                },
                (err) => {
                    assert.strictEqual(err.name, 'NumberingError');
                    assert.strictEqual(err.statusCode, 400);
                    assert.match(err.message, /Payroll periods use calendar batch codes \(PAY-YYYY-MM\) scoped to business/i);
                    return true;
                },
                `allocateNumber must reject ${entityType}`
            );

            await assert.rejects(
                async () => {
                    await numberingService.peekNextNumber({
                        businessId: testBusiness1Id,
                        entityType,
                        date: testDate
                    });
                },
                (err) => {
                    assert.strictEqual(err.name, 'NumberingError');
                    assert.strictEqual(err.statusCode, 400);
                    assert.match(err.message, /Payroll periods use calendar batch codes \(PAY-YYYY-MM\) scoped to business/i);
                    return true;
                },
                `peekNextNumber must reject ${entityType}`
            );
        }
    });
});

