'use strict';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const closingService = require('../app/services/financialYearClosing.service');
const financialYearService = require('../app/services/financialYear.service');
const journalService = require('../app/services/journal.service');
const coaService = require('../app/services/chartOfAccounts.service');
const postingService = require('../app/services/accounting/posting.service');
const invoiceService = require('../app/services/invoice.service');
const paymentService = require('../app/services/payment.service');
const creditDebitNoteService = require('../app/services/creditDebitNote.service');
const reportService = require('../app/services/accounting/report.service');
const rbacService = require('../app/services/rbac.service');

describe('Milestone 8: Financial Year Closing, Opening Balances & Period Locking', () => {
    let server = null;
    let baseUrl = null;
    let authCookie = null;
    let csrfToken = null;
    let testAdmin = null;

    let fy2024 = null;
    let fy2025 = null;
    let fy2026 = null;

    let testClient = null;
    let retainedEarningsAccount = null;

    function extractCookie(res) {
        const setCookie = res.headers.get('set-cookie');
        if (!setCookie) return null;
        const match = setCookie.match(/spark\.sid=[^;]+/);
        return match ? match[0] : null;
    }

    function extractCsrfToken(html) {
        const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/id="csrf-token"\s+value="([^"]+)"/);
        return match ? match[1] : null;
    }

    before(async () => {
        // 1. Start HTTP Server for UI and Controller testing
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // 2. Login as admin
        const getLoginRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getLoginRes);
        const loginCsrf = extractCsrfToken(await getLoginRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: initialCookie
            },
            body: new URLSearchParams({
                _csrf: loginCsrf,
                email: 'admin@email.com',
                password: process.env.SEED_ADMIN_PASSWORD || 'Admin@123'
            }).toString(),
            redirect: 'manual'
        });
        authCookie = extractCookie(loginRes);

        const getFyPage = await fetch(`${baseUrl}/financial-years`, {
            headers: { Cookie: authCookie }
        });
        csrfToken = extractCsrfToken(await getFyPage.text());

        testAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testAdmin) {
            testAdmin = await prisma.user.findFirst();
        }
        assert.ok(testAdmin, 'Admin user should exist');

        // 3. Ensure System Accounts & Retained Earnings
        await coaService.ensureSystemAccounts(testAdmin.id);
        retainedEarningsAccount = await coaService.getSystemAccount('RETAINED_EARNINGS');
        assert.strictEqual(retainedEarningsAccount.code, '3120');

        // 4. Ensure test financial years
        const fy2023 = await financialYearService.ensureFinancialYear('2023-05-01');
        fy2024 = await financialYearService.ensureFinancialYear('2024-06-15');
        fy2025 = await financialYearService.ensureFinancialYear('2025-06-15');
        fy2026 = await financialYearService.ensureFinancialYear('2026-06-15');

        assert.strictEqual(fy2023.code, '2023-24');
        assert.strictEqual(fy2024.code, '2024-25');
        assert.strictEqual(fy2025.code, '2025-26');
        assert.strictEqual(fy2026.code, '2026-27');

        const isolatedFyIds = [fy2023.id, fy2024.id, fy2026.id];

        // Clean up test journal entries and documents for isolated test financial years
        await prisma.journalEntryLine.deleteMany({
            where: { journalEntry: { financialYearId: { in: isolatedFyIds } } }
        });
        await prisma.journalEntry.deleteMany({
            where: { financialYearId: { in: isolatedFyIds } }
        });
        await prisma.payment.deleteMany({
            where: { financialYearId: { in: isolatedFyIds } }
        });
        await prisma.creditDebitNoteItem.deleteMany({
            where: { note: { financialYearId: { in: isolatedFyIds } } }
        });
        await prisma.creditDebitNote.deleteMany({
            where: { financialYearId: { in: isolatedFyIds } }
        });
        await prisma.invoiceItem.deleteMany({
            where: { invoice: { financialYearId: { in: isolatedFyIds } } }
        });
        await prisma.invoiceRevision.deleteMany({
            where: { invoice: { financialYearId: { in: isolatedFyIds } } }
        });
        await prisma.invoice.updateMany({
            where: { sourceQuotationId: { not: null } },
            data: { sourceQuotationId: null }
        });
        await prisma.invoice.deleteMany({
            where: { financialYearId: { in: isolatedFyIds } }
        });

        // For fy2025 (standard dev/fixture FY), clean up only closing journals and specific test activity
        await prisma.journalEntryLine.deleteMany({
            where: {
                journalEntry: {
                    financialYearId: fy2025.id,
                    OR: [
                        { sourceType: { in: ['YEAR_END_CLOSE', 'YEAR_END_CLOSE_REVERSAL'] } },
                        { narration: 'Activity in 2025-26' }
                    ]
                }
            }
        });
        await prisma.journalEntry.deleteMany({
            where: {
                financialYearId: fy2025.id,
                OR: [
                    { sourceType: { in: ['YEAR_END_CLOSE', 'YEAR_END_CLOSE_REVERSAL'] } },
                    { narration: 'Activity in 2025-26' }
                ]
            }
        });

        // Ensure all test financial years start OPEN
        await prisma.financialYear.update({ where: { id: fy2023.id }, data: { status: 'OPEN', closedAt: null, closedById: null } });
        await prisma.financialYear.update({ where: { id: fy2024.id }, data: { status: 'OPEN', closedAt: null, closedById: null } });
        await prisma.financialYear.update({ where: { id: fy2025.id }, data: { status: 'OPEN', closedAt: null, closedById: null } });
        await prisma.financialYear.update({ where: { id: fy2026.id }, data: { status: 'OPEN', closedAt: null, closedById: null } });

        // 5. Ensure a test client
        testClient = await prisma.client.create({
            data: {
                name: `Milestone 8 Test Enterprise Ltd ${Date.now()}`,
                stateCode: '27',
                createdById: testAdmin.id
            }
        });
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    describe('1. Close Preview & Double-Entry Calculation', () => {
        let salesAccount = null;
        let cogsAccount = null;
        let adminExpenseAccount = null;

        before(async () => {
            salesAccount = await coaService.getSystemAccount('SALES_REVENUE');
            cogsAccount = await coaService.getSystemAccount('COGS');
            adminExpenseAccount = await prisma.chartOfAccount.findUnique({ where: { code: '5210' } });

            // Post accounting transactions in FY 2024-25:
            // 1. Revenue: ₹100,000 (Dr Cash / Cr Sales)
            const cashAccount = await coaService.getSystemAccount('CASH_ON_HAND');
            await journalService.postJournalEntry({
                entryDate: '2024-05-10',
                financialYearId: fy2024.id,
                narration: 'Cash sales for FY 2024-25',
                lines: [
                    { accountId: cashAccount.id, debit: '100000.00', credit: '0.00', description: 'Cash received' },
                    { accountId: salesAccount.id, debit: '0.00', credit: '100000.00', description: 'Sales Revenue' }
                ],
                userId: testAdmin.id
            });

            // 2. Expense: COGS ₹40,000 (Dr COGS / Cr Cash)
            await journalService.postJournalEntry({
                entryDate: '2024-06-15',
                financialYearId: fy2024.id,
                narration: 'Material cost for FY 2024-25',
                lines: [
                    { accountId: cogsAccount.id, debit: '40000.00', credit: '0.00', description: 'Direct Materials' },
                    { accountId: cashAccount.id, debit: '0.00', credit: '40000.00', description: 'Payment for materials' }
                ],
                userId: testAdmin.id
            });

            // 3. Expense: Office expenses ₹15,000 (Dr Office Expense / Cr Cash)
            await journalService.postJournalEntry({
                entryDate: '2024-07-20',
                financialYearId: fy2024.id,
                narration: 'Office expenses for FY 2024-25',
                lines: [
                    { accountId: adminExpenseAccount.id, debit: '15000.00', credit: '0.00', description: 'Office supplies' },
                    { accountId: cashAccount.id, debit: '0.00', credit: '15000.00', description: 'Cash paid' }
                ],
                userId: testAdmin.id
            });
        });

        it('should generate an accurate, balanced closing preview for FY 2024-25', async () => {
            const preview = await closingService.previewCloseFinancialYear(fy2024.id);

            assert.strictEqual(preview.financialYear.code, '2024-25');
            assert.strictEqual(preview.financialYear.status, 'OPEN');
            assert.strictEqual(preview.totals.totalIncome, '100000.00');
            assert.strictEqual(preview.totals.totalExpense, '55000.00');
            assert.strictEqual(preview.totals.netProfitOrLoss, '45000.00'); // 100k - 55k = 45k
            assert.strictEqual(preview.totals.isProfit, true);
            assert.strictEqual(preview.totals.isLoss, false);

            assert.strictEqual(preview.retainedEarningsAccount.code, '3120');
            assert.strictEqual(preview.retainedEarningsAccount.impact, '45000.00');
            assert.strictEqual(preview.retainedEarningsAccount.action, 'CREDIT');

            assert.strictEqual(preview.closingJournal.isBalanced, true);
            assert.strictEqual(preview.closingJournal.totalDebit, '100000.00');
            assert.strictEqual(preview.closingJournal.totalCredit, '100000.00');
            assert.strictEqual(preview.canClose, true);
            assert.strictEqual(preview.blockers.length, 0);

            // Lines check:
            // Dr Sales 100k
            // Cr COGS 40k
            // Cr Office Expense 15k
            // Cr Retained Earnings 45k
            const salesLine = preview.closingJournal.lines.find(l => l.accountCode === '4110');
            assert.ok(salesLine, 'Sales line must be present in preview');
            assert.strictEqual(salesLine.debit, '100000.00');
            assert.strictEqual(salesLine.credit, '0.00');

            const reLine = preview.closingJournal.lines.find(l => l.accountCode === '3120');
            assert.ok(reLine, 'Retained earnings line must be present');
            assert.strictEqual(reLine.credit, '45000.00');
            assert.strictEqual(reLine.debit, '0.00');
        });

        it('should ensure closing preview is completely read-only and causes zero side effects', async () => {
            const journalsBefore = await prisma.journalEntry.count();
            const logCountBefore = await prisma.userActivityLog.count();
            const fyBefore = await prisma.financialYear.findUnique({ where: { id: fy2024.id } });
            const reAccBefore = await prisma.chartOfAccount.findUnique({ where: { code: '3120' } });

            await closingService.previewCloseFinancialYear(fy2024.id);

            const journalsAfter = await prisma.journalEntry.count();
            const logCountAfter = await prisma.userActivityLog.count();
            const fyAfter = await prisma.financialYear.findUnique({ where: { id: fy2024.id } });
            const reAccAfter = await prisma.chartOfAccount.findUnique({ where: { code: '3120' } });

            assert.strictEqual(journalsAfter, journalsBefore, 'Preview must not create journal entries');
            assert.strictEqual(logCountAfter, logCountBefore, 'Preview must not log audit events');
            assert.strictEqual(fyAfter.status, fyBefore.status, 'Preview must not change FY status');
            assert.strictEqual(reAccAfter.currentBalance.toString(), reAccBefore.currentBalance.toString(), 'Preview must not mutate account balances');
        });
    });

    describe('2. Financial Year Closure Execution', () => {
        let closingResult = null;
        let initialRetainedEarnings = null;

        before(async () => {
            const reAcc = await prisma.chartOfAccount.findUnique({ where: { code: '3120' } });
            initialRetainedEarnings = Number(reAcc.currentBalance);

            closingResult = await closingService.closeFinancialYear(fy2024.id, testAdmin.id, {
                ip: '127.0.0.1',
                userAgent: 'milestone-8-test-agent'
            });
        });

        it('should mark FinancialYear status as CLOSED with audit metadata', async () => {
            assert.strictEqual(closingResult.financialYear.status, 'CLOSED');
            assert.ok(closingResult.financialYear.closedAt instanceof Date);
            assert.strictEqual(closingResult.financialYear.closedById, testAdmin.id);

            const dbFy = await prisma.financialYear.findUnique({ where: { id: fy2024.id } });
            assert.strictEqual(dbFy.status, 'CLOSED');
        });

        it('should create an immutable closing journal with exact debit/credit equality', async () => {
            const journal = closingResult.closingJournal;
            assert.ok(journal, 'Closing journal must be created');
            assert.strictEqual(journal.sourceType, 'YEAR_END_CLOSE');
            assert.strictEqual(journal.financialYearId, fy2024.id);
            assert.strictEqual(journal.status, 'POSTED');
            assert.strictEqual(journal.idempotencyKey, `YEAR_END_CLOSE:${fy2024.id}`);

            let totalDr = 0n;
            let totalCr = 0n;
            for (const line of journal.lines) {
                totalDr += closingService.toCents(line.debit);
                totalCr += closingService.toCents(line.credit);
            }
            assert.strictEqual(totalDr, totalCr, 'Total Debit must equal Total Credit exactly down to the cent');
            assert.strictEqual(closingService.fromCents(totalDr), '100000.00');
        });

        it('should update Retained Earnings (3120) by exactly the net profit', async () => {
            const reAcc = await prisma.chartOfAccount.findUnique({ where: { code: '3120' } });
            const expectedBalance = initialRetainedEarnings + 45000;
            assert.strictEqual(Number(reAcc.currentBalance), expectedBalance);
        });

        it('should record an activity audit log for the close operation', async () => {
            const log = await prisma.userActivityLog.findFirst({
                where: {
                    action: 'CLOSE_FINANCIAL_YEAR',
                    targetId: String(fy2024.id)
                }
            });
            assert.ok(log, 'User activity log must be created');
            assert.strictEqual(log.actorUserId, testAdmin.id);
            assert.strictEqual(log.targetReference, '2024-25');
        });

        it('should be idempotent on repeated close requests', async () => {
            // Calling close on already closed FY throws ConflictError or handles idempotency safely
            await assert.rejects(
                async () => {
                    await closingService.closeFinancialYear(fy2024.id, testAdmin.id);
                },
                /already CLOSED/
            );

            // Count closing journals for FY 2024-25: strictly exactly 1
            const closingCount = await prisma.journalEntry.count({
                where: {
                    financialYearId: fy2024.id,
                    sourceType: 'YEAR_END_CLOSE'
                }
            });
            assert.strictEqual(closingCount, 1, 'Only one closing journal entry may exist for a closed financial year');
        });
    });

    describe('3. Chronological Sequence Enforcement', () => {
        it('should block closing FY 2026-27 if earlier FY 2025-26 has activity and is OPEN', async () => {
            // Post an activity in FY 2025-26
            const cashAccount = await coaService.getSystemAccount('CASH_ON_HAND');
            const salesAccount = await coaService.getSystemAccount('SALES_REVENUE');

            await journalService.postJournalEntry({
                entryDate: '2025-05-15',
                financialYearId: fy2025.id,
                narration: 'Activity in 2025-26',
                lines: [
                    { accountId: cashAccount.id, debit: '1000.00', credit: '0.00' },
                    { accountId: salesAccount.id, debit: '0.00', credit: '1000.00' }
                ],
                userId: testAdmin.id
            });

            // Now attempt to close FY 2026-27 directly
            await assert.rejects(
                async () => {
                    await closingService.closeFinancialYear(fy2026.id, testAdmin.id);
                },
                /Earlier Financial Year 2025-26 has \d+ accounting transactions and must be closed first/
            );
        });
    });

    describe('4. Period Locking Across All Posting Paths', () => {
        it('Path 1: should reject postJournalEntry into closed FY 2024-25', async () => {
            const cash = await coaService.getSystemAccount('CASH_ON_HAND');
            const sales = await coaService.getSystemAccount('SALES_REVENUE');

            await assert.rejects(
                async () => {
                    await journalService.postJournalEntry({
                        entryDate: '2024-08-10', // inside closed FY 2024-25
                        financialYearId: fy2024.id,
                        narration: 'Should be rejected',
                        lines: [
                            { accountId: cash.id, debit: '500.00', credit: '0.00' },
                            { accountId: sales.id, debit: '0.00', credit: '500.00' }
                        ],
                        userId: testAdmin.id
                    });
                },
                /Cannot post journal entry into CLOSED financial year 2024-25/
            );
        });

        it('Path 2: should reject createDocument (INVOICE) into closed FY 2024-25', async () => {
            await assert.rejects(
                async () => {
                    await invoiceService.createInvoice({
                        invoiceDate: '2024-09-01', // inside closed FY 2024-25
                        clientId: testClient.id,
                        clientName: testClient.name,
                        items: [
                            { name: 'Consulting', quantity: 1, rate: 5000 }
                        ]
                    }, testAdmin.id);
                },
                /Cannot create invoice in CLOSED Financial Year 2024-25/
            );
        });

        it('Path 3: should reject recordPayment into closed FY 2024-25', async () => {
            // Create invoice in open FY 2025-26
            const openInvoice = await invoiceService.createInvoice({
                invoiceDate: '2025-06-01',
                clientId: testClient.id,
                clientName: testClient.name,
                items: [
                    { name: 'Hardware', quantity: 1, rate: 10000 }
                ]
            }, testAdmin.id);

            // Attempt to record payment dated in closed FY 2024-25
            await assert.rejects(
                async () => {
                    await paymentService.recordPayment(openInvoice.id, {
                        amount: 5000,
                        paymentDate: '2024-11-01', // closed FY
                        method: 'BANK_TRANSFER'
                    }, testAdmin.id);
                },
                /Cannot record payment in CLOSED Financial Year 2024-25/
            );
        });

        it('Path 4: should reject createCreditDebitNote into closed FY 2024-25', async () => {
            // Create invoice in open FY 2025-26
            const inv = await invoiceService.createInvoice({
                invoiceDate: '2025-06-10',
                clientId: testClient.id,
                clientName: testClient.name,
                items: [
                    { name: 'Service', quantity: 2, rate: 2000 }
                ]
            }, testAdmin.id);

            // Attempt note dated in closed FY 2024-25
            await assert.rejects(
                async () => {
                    await creditDebitNoteService.createCreditDebitNote({
                        noteType: 'CREDIT',
                        invoiceId: inv.id,
                        noteDate: '2024-12-01', // closed FY
                        reason: 'Adjustment in closed period',
                        items: [
                            { name: 'Service Return', quantity: 1, rate: 2000 }
                        ]
                    }, testAdmin.id);
                },
                /Cannot issue note in closed Financial Year 2024-25/
            );
        });

        it('Path 5: should reject reverseJournalEntry if reversal date falls in closed FY 2024-25', async () => {
            // Find a journal
            const journal = await prisma.journalEntry.findFirst({
                where: { status: 'POSTED', sourceType: 'MANUAL' }
            });
            if (journal) {
                await assert.rejects(
                    async () => {
                        await journalService.reverseJournalEntry(journal.id, {
                            reversalDate: '2024-10-15', // closed FY
                            reason: 'Attempt reversal in closed FY',
                            userId: testAdmin.id
                        });
                    },
                    /Cannot post reversal into CLOSED financial year 2024-25/
                );
            }
        });

        it('Path 6: should continue accepting postings in OPEN Financial Years', async () => {
            const cash = await coaService.getSystemAccount('CASH_ON_HAND');
            const sales = await coaService.getSystemAccount('SALES_REVENUE');

            const openJournal = await journalService.postJournalEntry({
                entryDate: '2025-07-01', // FY 2025-26 is OPEN
                financialYearId: fy2025.id,
                narration: 'Valid posting in open FY 2025-26',
                lines: [
                    { accountId: cash.id, debit: '2500.00', credit: '0.00' },
                    { accountId: sales.id, debit: '0.00', credit: '2500.00' }
                ],
                userId: testAdmin.id
            });
            assert.ok(openJournal, 'Postings into open financial years must succeed');
            assert.strictEqual(openJournal.financialYearId, fy2025.id);
        });
    });

    describe('5. Reporting Compatibility Post-Closure', () => {
        it('should show genuine revenue, expense, and net profit in P&L for closed FY 2024-25 (not zero)', async () => {
            const pl = await reportService.getProfitAndLoss({ financialYearId: fy2024.id });

            // P&L must NOT be zeroed out
            assert.strictEqual(pl.revenue.grossRevenue, '100000.00');
            assert.strictEqual(pl.summary.totalExpenses, '55000.00');
            assert.strictEqual(pl.summary.netProfitOrLoss, '45000.00');
        });

        it('should reflect balanced Trial Balance for closed FY 2024-25 with nominal accounts at zero', async () => {
            const tb = await reportService.getTrialBalance({ financialYearId: fy2024.id });

            assert.strictEqual(tb.summary.isBalanced, true);

            // In TB after closure, nominal accounts (Sales, COGS, Office Exp) have closing balance = 0.00
            const salesRow = tb.rows.find(a => a.code === '4110');
            assert.ok(salesRow);
            assert.strictEqual(salesRow.debitBalance, '0.00');
            assert.strictEqual(salesRow.creditBalance, '0.00');

            const cogsRow = tb.rows.find(a => a.code === '5110');
            assert.ok(cogsRow);
            assert.strictEqual(cogsRow.debitBalance, '0.00');
            assert.strictEqual(cogsRow.creditBalance, '0.00');
        });

        it('should maintain Balance Sheet balance equation (Assets = Liabilities + Equity) without double-counting profit', async () => {
            const bs = await reportService.getBalanceSheet({ asOfDate: '2025-03-31' });

            assert.strictEqual(bs.summary.isBalanced, true);
            assert.strictEqual(bs.summary.totalAssets, bs.summary.totalLiabilitiesAndEquity);
            assert.strictEqual(bs.summary.difference, '0.00');
        });
    });

    describe('6. Controlled Reopening & Downstream Constraints', () => {
        it('should reject reopening without a mandatory reason', async () => {
            await assert.rejects(
                async () => {
                    await closingService.reopenFinancialYear(fy2024.id, testAdmin.id, '');
                },
                /non-empty reason is required/
            );
        });

        it('should successfully reopen FY 2024-25 with reason when no later year is closed', async () => {
            const result = await closingService.reopenFinancialYear(
                fy2024.id,
                testAdmin.id,
                'Auditor adjustments required for FY 2024-25'
            );

            assert.strictEqual(result.financialYear.status, 'OPEN');
            assert.strictEqual(result.financialYear.closedAt, null);
            assert.strictEqual(result.financialYear.closedById, null);

            assert.ok(result.reversalJournal, 'Reversal journal must be created');
            assert.strictEqual(result.reversalJournal.sourceType, 'YEAR_END_CLOSE_REVERSAL');

            // Check original closing journal marked REVERSED
            const originalClosing = await prisma.journalEntry.findUnique({
                where: { idempotencyKey: `YEAR_END_CLOSE:${fy2024.id}` }
            });
            assert.strictEqual(originalClosing.status, 'REVERSED');
            assert.strictEqual(originalClosing.reversedEntryId, result.reversalJournal.id);
        });

        it('should re-close FY 2024-25 cleanly after reopening', async () => {
            const reclose = await closingService.closeFinancialYear(fy2024.id, testAdmin.id);
            assert.strictEqual(reclose.financialYear.status, 'CLOSED');
        });

        it('should block reopening earlier FY 2024-25 if subsequent FY 2025-26 is closed', async () => {
            // First close FY 2025-26
            await closingService.closeFinancialYear(fy2025.id, testAdmin.id);

            // Now FY 2024-25 and FY 2025-26 are both CLOSED.
            // Attempting to reopen FY 2024-25 should fail because subsequent FY 2025-26 is closed!
            await assert.rejects(
                async () => {
                    await closingService.reopenFinancialYear(fy2024.id, testAdmin.id, 'Try reopening earlier year');
                },
                /Cannot reopen Financial Year 2024-25 because subsequent Financial Year 2025-26 is closed/
            );

            // Reopen 2025-26 first
            await closingService.reopenFinancialYear(fy2025.id, testAdmin.id, 'Reopen later year first');
            const fy25 = await prisma.financialYear.findUnique({ where: { id: fy2025.id } });
            assert.strictEqual(fy25.status, 'OPEN');
        });
    });

    describe('7. Initial Company Opening Balances Workflow', () => {
        let testFyNew = null;

        before(async () => {
            testFyNew = await financialYearService.ensureFinancialYear('2023-05-01');
            await prisma.journalEntryLine.deleteMany({
                where: { journalEntry: { financialYearId: testFyNew.id } }
            });
            await prisma.journalEntry.deleteMany({
                where: { financialYearId: testFyNew.id }
            });
            await prisma.financialYear.update({ where: { id: testFyNew.id }, data: { status: 'OPEN', closedAt: null, closedById: null } });
        });

        it('should preview and reject unbalanced opening balances', async () => {
            const cash = await coaService.getSystemAccount('CASH_ON_HAND');
            const capital = await coaService.getSystemAccount('CAPITAL');

            const preview = await closingService.previewOpeningBalances(testFyNew.id, [
                { accountId: cash.id, debit: '50000.00', credit: '0.00' },
                { accountId: capital.id, debit: '0.00', credit: '40000.00' } // Imbalance of 10k
            ]);

            assert.strictEqual(preview.summary.isBalanced, false);
            assert.strictEqual(preview.summary.difference, '10000.00');
            assert.strictEqual(preview.isValid, false);
        });

        it('should preview and accept balanced opening balances for permanent accounts', async () => {
            const cash = await coaService.getSystemAccount('CASH_ON_HAND');
            const bank = await coaService.getSystemAccount('BANK_ACCOUNT');
            const capital = await coaService.getSystemAccount('CAPITAL');

            const preview = await closingService.previewOpeningBalances(testFyNew.id, [
                { accountId: cash.id, debit: '25000.00', credit: '0.00' },
                { accountId: bank.id, debit: '75000.00', credit: '0.00' },
                { accountId: capital.id, debit: '0.00', credit: '100000.00' }
            ]);

            assert.strictEqual(preview.summary.isBalanced, true);
            assert.strictEqual(preview.summary.difference, '0.00');
            assert.strictEqual(preview.isValid, true);
        });

        it('should post opening balances and update account current balances', async () => {
            const cash = await coaService.getSystemAccount('CASH_ON_HAND');
            const capital = await coaService.getSystemAccount('CAPITAL');

            const postRes = await closingService.postOpeningBalances(
                testFyNew.id,
                testAdmin.id,
                [
                    { accountId: cash.id, debit: '50000.00', credit: '0.00' },
                    { accountId: capital.id, debit: '0.00', credit: '50000.00' }
                ],
                'Initial Setup for FY 2023-24'
            );

            assert.ok(postRes.journal);
            assert.strictEqual(postRes.journal.sourceType, 'OPENING_BALANCE');
            assert.strictEqual(postRes.journal.status, 'POSTED');
            assert.strictEqual(postRes.summary.isBalanced, true);
        });
    });

    describe('8. Web Routes, CSRF & RBAC Permissions', () => {
        it('GET /financial-years should return 200 and list configured years', async () => {
            const res = await fetch(`${baseUrl}/financial-years`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Configured Financial Years'));
            assert.ok(html.includes('2024-25'));
        });

        it('GET /financial-years/:id/close-preview should render close preview with details', async () => {
            const res = await fetch(`${baseUrl}/financial-years/${fy2024.id}/close-preview`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Year-End Close Preview'));
            assert.ok(html.includes('2024-25'));
        });

        it('POST /financial-years/:id/close should reject if CSRF is missing or invalid', async () => {
            const res = await fetch(`${baseUrl}/financial-years/${fy2025.id}/close`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: authCookie
                },
                body: new URLSearchParams({
                    _csrf: 'invalid-csrf-token'
                }).toString()
            });
            assert.strictEqual(res.status, 403);
        });
    });

    after(async () => {
        if (server) {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });
});

