'use strict';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const reportService = require('../app/services/accounting/report.service');
const journalService = require('../app/services/journal.service');
const coaService = require('../app/services/chartOfAccounts.service');
const postingService = require('../app/services/accounting/posting.service');
const creditDebitNoteService = require('../app/services/creditDebitNote.service');
const paymentService = require('../app/services/payment.service');
const invoiceService = require('../app/services/invoice.service');
const { hashPassword } = require('../app/services/auth.service');
const { ensureFinancialYear } = require('../app/services/financialYear.service');
const rbacService = require('../app/services/rbac.service');

describe('Milestone 7: Core Financial Reports & Accounting Reconciliation', () => {
    let server = null;
    let baseUrl = null;
    let authCookie = null;
    let testAdmin = null;
    let testFy = null;
    let testClientA = null;
    let testClientB = null;
    let createdInvoiceA = null;
    let createdInvoiceB = null;
    let createdPaymentA = null;
    let createdCreditNoteA = null;

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
        // Ephemeral HTTP test server
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

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
        // 1. Identify admin user
        testAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testAdmin) {
            testAdmin = await prisma.user.findFirst();
        }

        // 2. Provision Financial Year & System Accounts
        testFy = await ensureFinancialYear(new Date('2026-06-15'));
        await coaService.ensureSystemAccounts(testAdmin ? testAdmin.id : null);
        await rbacService.seedPermissionsAndRoles();

        // 3. Create isolated test clients
        const timestamp = Date.now().toString().slice(-6);
        testClientA = await prisma.client.create({
            data: {
                name: `Reconciliation Client Alpha ${timestamp}`,
                email: `alpha_${timestamp}@example.com`,
                phone: '9876543210',
                gstin: '27AAAAA0000A1Z5',
                stateCode: '27',
                billingAddress: '101 Alpha Industrial Area, Mumbai'
            }
        });

        testClientB = await prisma.client.create({
            data: {
                name: `Reconciliation Client Beta ${timestamp}`,
                email: `beta_${timestamp}@example.com`,
                phone: '9876543211',
                gstin: '24BBBBB0000B1Z6',
                stateCode: '24',
                billingAddress: '202 Beta Commercial Hub, Surat'
            }
        });

        // 4. Create & Post Invoice A (Intra-state, 18% GST: Rs 10,000 subtotal + 900 CGST + 900 SGST = Rs 11,800)
        createdInvoiceA = await prisma.invoice.create({
            data: {
                documentType: 'INVOICE',
                invoiceNumber: `INV-REC-A-${timestamp}`,
                clientId: testClientA.id,
                clientName: testClientA.name,
                clientGSTIN: testClientA.gstin,
                placeOfSupplyStateCode: '27',
                sellerStateCode: '27',
                invoiceDate: new Date('2026-06-10'),
                dueDate: new Date('2026-07-10'),
                gstEnabled: true,
                gstRate: 18.00,
                subtotal: 10000.00,
                gstAmount: 1800.00,
                cgstAmount: 900.00,
                sgstAmount: 900.00,
                igstAmount: 0.00,
                roundOff: 0.00,
                grandTotal: 11800.00,
                paidAmount: 0.00,
                outstandingAmount: 11800.00,
                status: 'ACTIVE',
                financialYearId: testFy.id,
                createdById: testAdmin.id,
                updatedById: testAdmin.id,
                items: {
                    create: [
                        {
                            lineNumber: 1,
                            name: 'Industrial Valve Component',
                            quantity: 10,
                            unit: 'PCS',
                            rate: 1000.00,
                            amount: 10000.00
                        }
                    ]
                }
            }
        });
        await postingService.postInvoice(createdInvoiceA.id, { userId: testAdmin.id });

        // 5. Create & Post Invoice B (Inter-state, 18% GST: Rs 20,000 subtotal + 3600 IGST = Rs 23,600)
        createdInvoiceB = await prisma.invoice.create({
            data: {
                documentType: 'INVOICE',
                invoiceNumber: `INV-REC-B-${timestamp}`,
                clientId: testClientB.id,
                clientName: testClientB.name,
                clientGSTIN: testClientB.gstin,
                placeOfSupplyStateCode: '24',
                sellerStateCode: '27',
                invoiceDate: new Date('2026-06-12'),
                dueDate: new Date('2026-07-12'),
                gstEnabled: true,
                gstRate: 18.00,
                subtotal: 20000.00,
                gstAmount: 3600.00,
                cgstAmount: 0.00,
                sgstAmount: 0.00,
                igstAmount: 3600.00,
                roundOff: 0.00,
                grandTotal: 23600.00,
                paidAmount: 0.00,
                outstandingAmount: 23600.00,
                status: 'ACTIVE',
                financialYearId: testFy.id,
                createdById: testAdmin.id,
                updatedById: testAdmin.id,
                items: {
                    create: [
                        {
                            lineNumber: 1,
                            name: 'Pressure Transmitter',
                            quantity: 4,
                            unit: 'PCS',
                            rate: 5000.00,
                            amount: 20000.00
                        }
                    ]
                }
            }
        });
        await postingService.postInvoice(createdInvoiceB.id, { userId: testAdmin.id });

        // 6. Post Partial Payment on Invoice A: Rs 5,000 via Bank
        createdPaymentA = await prisma.payment.create({
            data: {
                invoiceId: createdInvoiceA.id,
                paymentDate: new Date('2026-06-15'),
                amount: 5000.00,
                method: 'BANK_TRANSFER',
                reference: `NEFT-${timestamp}`,
                status: 'POSTED',
                financialYearId: testFy.id,
                createdById: testAdmin.id
            }
        });
        await prisma.invoice.update({
            where: { id: createdInvoiceA.id },
            data: {
                paidAmount: 5000.00,
                outstandingAmount: 6800.00
            }
        });
        await postingService.postPayment(createdPaymentA.id, { userId: testAdmin.id });

        // 7. Post Credit Note on Invoice A: Rs 1,000 + Rs 180 GST = Rs 1,180
        const cnResult = await creditDebitNoteService.createCreditDebitNote({
            invoiceId: createdInvoiceA.id,
            noteType: 'CREDIT',
            noteDate: new Date('2026-06-18'),
            reason: 'Defective valve return',
            items: [
                {
                    name: 'Industrial Valve Component (Return)',
                    quantity: 1,
                    unit: 'PCS',
                    rate: 1000.00,
                    taxRate: 18.00
                }
            ],
            status: 'ISSUED'
        }, testAdmin.id);
        createdCreditNoteA = cnResult.note;
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });

    describe('1. Journal Register Queries & Balance Invariant', () => {
        it('1.1 should query journal register with pagination and verify balanced debits and credits', async () => {
            const result = await reportService.getJournalRegister({
                financialYearId: testFy.id,
                page: 1,
                limit: 50
            });

            assert.ok(result);
            assert.ok(Array.isArray(result.entries));
            assert.ok(result.entries.length >= 4, 'Should contain at least our 4 test transactions');
            assert.equal(result.summary.isBalanced, true, 'Journal register page debits must strictly equal credits');
            assert.equal(result.summary.pageDebit, result.summary.pageCredit);
        });

        it('1.2 should filter journal register by sourceType', async () => {
            const invoiceJournals = await reportService.getJournalRegister({
                financialYearId: testFy.id,
                sourceType: 'INVOICE'
            });

            assert.ok(invoiceJournals.entries.length >= 2);
            invoiceJournals.entries.forEach(entry => {
                assert.equal(entry.sourceType, 'INVOICE');
                assert.equal(entry.isBalanced, true);
            });
        });

        it('1.3 should filter journal register by date range', async () => {
            const filtered = await reportService.getJournalRegister({
                fromDate: '2026-06-10',
                toDate: '2026-06-12'
            });

            assert.ok(filtered.entries.length >= 2);
            filtered.entries.forEach(entry => {
                const d = new Date(entry.entryDate);
                assert.ok(d >= new Date('2026-06-10') && d <= new Date('2026-06-12'));
            });
        });

        it('1.4 should retrieve single journal detail with line item accounts and subledger tags', async () => {
            const sample = (await reportService.getJournalRegister({ sourceType: 'INVOICE', limit: 1 })).entries[0];
            const detail = await journalService.getJournalEntryById(sample.id);

            assert.ok(detail);
            assert.equal(detail.id, sample.id);
            assert.ok(detail.lines.length >= 2);

            let drSum = 0n;
            let crSum = 0n;
            detail.lines.forEach(l => {
                drSum += reportService.toCents(l.debit);
                crSum += reportService.toCents(l.credit);
            });
            assert.equal(drSum, crSum, 'Every individual journal entry must be exactly balanced');
        });
    });

    describe('2. General Ledger Statement & Running Balances', () => {
        it('2.1 should retrieve individual account ledger statement with accurate running balance', async () => {
            const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');
            const ledger = await reportService.getGeneralLedgerReport({
                accountId: arAccount.id,
                financialYearId: testFy.id
            });

            assert.ok(ledger.account);
            assert.equal(ledger.account.code, '1121');
            assert.equal(ledger.account.isDebitNormal, true);
            assert.ok(ledger.transactions.length >= 4, 'Must include both invoices, payment, and credit note');

            // Verify running balance calculation sequentially
            let expectedCents = reportService.toCents(ledger.account.openingBalance);
            for (const tx of ledger.transactions) {
                const dr = reportService.toCents(tx.debit);
                const cr = reportService.toCents(tx.credit);
                expectedCents += (dr - cr);
                assert.equal(tx.runningBalance, reportService.fromCents(expectedCents));
            }
            assert.equal(ledger.account.closingBalance, reportService.fromCents(expectedCents));
        });

        it('2.2 should retrieve multi-account General Ledger summary and confirm global equilibrium', async () => {
            const summary = await reportService.getGeneralLedgerReport({
                financialYearId: testFy.id
            });

            assert.ok(summary.accounts);
            assert.ok(summary.accounts.length >= 15);
            assert.equal(summary.summary.isBalanced, true, 'Sum of all debit movements must equal credit movements');
            assert.equal(summary.summary.totalDebit, summary.summary.totalCredit);
        });
    });

    describe('3. Trial Balance & Control Total Verification', () => {
        it('3.1 should produce an exactly balanced Trial Balance verifying Total Debits === Total Credits', async () => {
            const tb = await reportService.getTrialBalance({
                financialYearId: testFy.id
            });

            assert.ok(tb);
            assert.equal(tb.summary.isBalanced, true, 'Trial Balance must be in equilibrium');
            assert.equal(tb.summary.difference, '0.00');
            assert.equal(tb.summary.totalDebitBalance, tb.summary.totalCreditBalance);
            assert.ok(parseFloat(tb.summary.totalDebitBalance) > 0, 'Total debit balance must be positive');

            // Confirm all 5 classes are classified in groupedByType
            assert.ok(tb.groupedByType.ASSET.length > 0);
            assert.ok(tb.groupedByType.LIABILITY.length > 0);
            assert.ok(tb.groupedByType.EQUITY.length > 0);
            assert.ok(tb.groupedByType.INCOME.length > 0);
            assert.ok(tb.groupedByType.EXPENSE.length > 0);
        });

        it('3.2 should maintain Trial Balance equilibrium after posting and reversing a transaction', async () => {
            // Post an ad-hoc invoice then reverse it immediately
            const tempTimestamp = Date.now().toString().slice(-5);
            const tempClient = await prisma.client.create({
                data: {
                    name: `Temp Reversal Client ${tempTimestamp}`
                }
            });
            const tempInv = await prisma.invoice.create({
                data: {
                    documentType: 'INVOICE',
                    invoiceNumber: `INV-TEMP-${tempTimestamp}`,
                    clientId: tempClient.id,
                    clientName: tempClient.name,
                    invoiceDate: new Date('2026-06-20'),
                    subtotal: 5000.00,
                    gstAmount: 0.00,
                    roundOff: 0.00,
                    grandTotal: 5000.00,
                    status: 'ACTIVE',
                    financialYearId: testFy.id,
                    createdById: testAdmin.id,
                    updatedById: testAdmin.id,
                    items: {
                        create: [{ lineNumber: 1, name: 'Temporary Item', quantity: 1, rate: 5000.00, amount: 5000.00 }]
                    }
                }
            });

            // 1. Post temp invoice
            const postRes = await postingService.postInvoice(tempInv.id, { userId: testAdmin.id });
            const tb1 = await reportService.getTrialBalance({ financialYearId: testFy.id });
            assert.equal(tb1.summary.isBalanced, true);

            // 2. Reverse temp invoice journal entry
            await journalService.reverseJournalEntry(postRes.journal.id, { reason: 'Test reversal', userId: testAdmin.id });
            const tb2 = await reportService.getTrialBalance({ financialYearId: testFy.id });
            assert.equal(tb2.summary.isBalanced, true, 'Trial Balance must remain balanced after reversal');
            assert.equal(tb2.summary.difference, '0.00');
        });
    });

    describe('4. Profit & Loss Statement Calculations', () => {
        it('4.1 should correctly calculate Gross Revenue, Sales Returns, and Net Revenue', async () => {
            const pnl = await reportService.getProfitAndLoss({
                financialYearId: testFy.id
            });

            assert.ok(pnl);
            // Gross Revenue = Invoice A subtotal (10,000) + Invoice B subtotal (20,000) = 30,000
            assert.ok(parseFloat(pnl.revenue.grossRevenue) >= 30000.00);

            // Sales Returns = Credit Note A subtotal (1,000)
            assert.ok(parseFloat(pnl.revenue.salesReturns) >= 1000.00);

            // Net Revenue = Gross Revenue - Sales Returns
            const expectedNetCents = reportService.toCents(pnl.revenue.grossRevenue) - reportService.toCents(pnl.revenue.salesReturns);
            assert.equal(pnl.revenue.netRevenue, reportService.fromCents(expectedNetCents));

            // Net Profit = Net Revenue - Total Expenses
            const expNetProfitCents = reportService.toCents(pnl.revenue.netRevenue) - reportService.toCents(pnl.summary.totalExpenses);
            assert.equal(pnl.summary.netProfitOrLoss, reportService.fromCents(expNetProfitCents));
            assert.equal(pnl.summary.isProfit, expNetProfitCents >= 0n);
        });
    });

    describe('5. Balance Sheet Equation Balance (Assets = Liabilities + Equity)', () => {
        it('5.1 should verify that Total Assets strictly equals Total Liabilities + Equity', async () => {
            const bs = await reportService.getBalanceSheet({
                financialYearId: testFy.id,
                asOfDate: '2026-06-30'
            });

            assert.ok(bs);
            assert.equal(bs.summary.isBalanced, true, 'Accounting equation Assets = Liabilities + Equity must strictly hold');
            assert.equal(bs.summary.difference, '0.00');
            assert.equal(bs.summary.totalAssets, bs.summary.totalLiabilitiesAndEquity);

            // Confirm assets include Trade Receivables (1121) and Bank (1112)
            const arAssets = bs.assets.items.filter(i => i.code === '1121');
            assert.ok(arAssets.length);
            assert.ok(arAssets.reduce((sum, item) => sum + parseFloat(item.balance), 0) > 0);

            const bankAssets = bs.assets.items.filter(i => i.code === '1112');
            assert.ok(bankAssets.length);
            assert.ok(bankAssets.reduce((sum, item) => sum + parseFloat(item.balance), 0) > 0);

            // Confirm liabilities include Output GST accounts
            const gstLiab = bs.liabilities.items.filter(i => i.code.startsWith('211'));
            assert.ok(gstLiab.length > 0);

            // Confirm Equity includes current period net earnings
            assert.ok(bs.equity.currentPeriodEarnings);
        });
    });

    describe('6. Customer Receivables & Subledger to GL 1121 Reconciliation', () => {
        it('6.1 should verify client subledger balances and cross-reconcile with GL 1121 control account', async () => {
            const rec = await reportService.getCustomerReceivablesReport({
                asOfDate: '2026-06-30'
            });

            assert.ok(rec);
            assert.ok(rec.clients.length >= 2);
            assert.equal(rec.summary.isReconciled, true, 'Customer subledger total must strictly reconcile with GL Account 1121');
            assert.equal(rec.summary.difference, '0.00');

            // Verify Client A balance:
            // Invoice A: 11,800
            // Paid: 5,000
            // Credit Note: 1,180
            // Net Outstanding: 11,800 - 5,000 - 1,180 = 5,620
            const clientAData = rec.clients.find(c => c.id === testClientA.id);
            assert.ok(clientAData);
            assert.equal(clientAData.totalInvoiced, '11800.00');
            assert.equal(clientAData.totalPaid, '5000.00');
            assert.equal(clientAData.creditNotes, '1180.00');
            assert.equal(clientAData.subledgerBalance, '5620.00');

            // Verify Client B balance:
            // Invoice B: 23,600 (unpaid)
            const clientBData = rec.clients.find(c => c.id === testClientB.id);
            assert.ok(clientBData);
            assert.equal(clientBData.totalInvoiced, '23600.00');
            assert.equal(clientBData.subledgerBalance, '23600.00');
        });

        it('6.2 should calculate ageing buckets accurately based on 30-day intervals', async () => {
            const rec = await reportService.getCustomerReceivablesReport({
                asOfDate: '2026-06-30'
            });

            // Invoices created around 2026-06-10 evaluated at 2026-06-30 is ~20 days old -> Current (0-30 days)
            assert.ok(parseFloat(rec.summary.ageingSummary.current) > 0);
            assert.equal(parseFloat(rec.summary.totalOutstanding),
                parseFloat(rec.summary.ageingSummary.current) +
                parseFloat(rec.summary.ageingSummary.days31to60) +
                parseFloat(rec.summary.ageingSummary.days61to90) +
                parseFloat(rec.summary.ageingSummary.daysOver90)
            );
        });

        it('6.3 should generate customer account statement with chronological running balance', async () => {
            const stmt = await reportService.getCustomerStatement(testClientA.id);

            assert.ok(stmt);
            assert.equal(stmt.client.id, testClientA.id);
            assert.ok(stmt.transactions.length >= 3, 'Invoice A + Payment A + Credit Note A');
            assert.equal(stmt.statement.closingBalance, '5620.00');

            // Check running balance progression
            assert.equal(stmt.transactions[0].debit, '11800.00');
            assert.equal(stmt.transactions[0].runningBalance, '11800.00');

            assert.equal(stmt.transactions[1].credit, '5000.00');
            assert.equal(stmt.transactions[1].runningBalance, '6800.00');

            assert.equal(stmt.transactions[2].credit, '1180.00');
            assert.equal(stmt.transactions[2].runningBalance, '5620.00');
        });

        it('6.4 should include active invoices that have not yet been posted to the ledger', async () => {
            const unpostedInvoice = await invoiceService.createInvoice({
                clientName: testClientA.name,
                clientId: testClientA.id,
                invoiceDate: new Date('2026-06-25'),
                gstEnabled: false,
                items: [{ name: 'Unposted statement test', quantity: 1, rate: 900, unit: 'NOS' }]
            }, testAdmin.id);

            const stmt = await reportService.getCustomerStatement(testClientA.id);
            const unpostedRow = stmt.transactions.find(transaction => transaction.sourceId === unpostedInvoice.id);

            assert.ok(unpostedRow);
            assert.equal(unpostedRow.status, 'UNPOSTED');
            assert.equal(unpostedRow.journalId, null);
            assert.equal(unpostedRow.debit, '900.00');
            assert.equal(stmt.statement.closingBalance, '6520.00');
        });
    });

    describe('7. RBAC Security & Authorization for Reports', () => {
        it('7.1 should confirm REPORTS module is registered in permissions catalog', async () => {
            const reportPerms = await prisma.permission.findMany({
                where: { module: 'REPORTS' }
            });

            assert.ok(reportPerms.length >= 3);
            const actions = reportPerms.map(p => p.action);
            assert.ok(actions.includes('VIEW'));
            assert.ok(actions.includes('EXPORT'));
            assert.ok(actions.includes('PRINT'));
        });

        it('7.2 should confirm MANAGER role possesses REPORTS:VIEW permission', async () => {
            const managerRole = await prisma.role.findUnique({
                where: { name: 'MANAGER' },
                include: { rolePermissions: { include: { permission: true } } }
            });

            assert.ok(managerRole);
            const hasReportsView = managerRole.rolePermissions.some(
                rp => rp.permission.module === 'REPORTS' && rp.permission.action === 'VIEW'
            );
            assert.equal(hasReportsView, true, 'MANAGER must possess REPORTS:VIEW');
        });
    });

    describe('8. Web Route Integration & Permission Enforcement', () => {
        it('8.1 should return 200 for GET /reports when authenticated', async () => {
            const res = await fetch(`${baseUrl}/reports`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Financial Reports'));
            assert.ok(html.includes('Trial Balance'));
        });

        it('8.2 should return 200 for GET /reports/journals', async () => {
            const res = await fetch(`${baseUrl}/reports/journals`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Journal Register'));
        });

        it('8.3 should return 200 for GET /reports/general-ledger', async () => {
            const res = await fetch(`${baseUrl}/reports/general-ledger`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('General Ledger'));
        });

        it('8.4 should return 200 for GET /reports/trial-balance', async () => {
            const res = await fetch(`${baseUrl}/reports/trial-balance`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Trial Balance'));
        });

        it('8.5 should return 200 for GET /reports/profit-and-loss', async () => {
            const res = await fetch(`${baseUrl}/reports/profit-and-loss`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Profit') && html.includes('Loss'));
        });

        it('8.6 should return 200 for GET /reports/balance-sheet', async () => {
            const res = await fetch(`${baseUrl}/reports/balance-sheet`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Balance Sheet'));
        });

        it('8.7 should return 200 for GET /reports/customer-receivables', async () => {
            const res = await fetch(`${baseUrl}/reports/customer-receivables`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes('Customer Receivables'));
        });

        it('8.8 should return 200 for GET /reports/customer-statement/:id', async () => {
            const res = await fetch(`${baseUrl}/reports/customer-statement/${testClientA.id}`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes(testClientA.name));
        });

        it('8.9 should return 200 for GET /reports/journals/:id', async () => {
            const entry = (await reportService.getJournalRegister({ limit: 1 })).entries[0];
            const res = await fetch(`${baseUrl}/reports/journals/${entry.id}`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200);
            const html = await res.text();
            assert.ok(html.includes(entry.entryNumber));
        });

        it('8.10 should redirect unauthenticated request to /login', async () => {
            const res = await fetch(`${baseUrl}/reports`, { redirect: 'manual' });
            assert.equal(res.status, 302);
            assert.ok(res.headers.get('location').includes('/login'));
        });
    });

    describe('9. Financial Year Boundaries (31 March / 1 April Cutoff & Carried-Forward Balances)', () => {
        let fy2025_26 = null;
        let fy2026_27 = null;
        let march31Journal = null;
        let april01Journal = null;

        before(async () => {
            fy2025_26 = await ensureFinancialYear(new Date('2026-03-31'));
            fy2026_27 = await ensureFinancialYear(new Date('2026-04-01'));

            const bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');
            const equityAccount = await coaService.getSystemAccount('CAPITAL');

            // Post entry on 31 March (FY 2025-26): Dr Bank 15,000, Cr Equity 15,000
            march31Journal = await journalService.postJournalEntry({
                entryDate: new Date('2026-03-31T10:00:00.000Z'),
                financialYearId: fy2025_26.id,
                sourceType: 'MANUAL',
                narration: 'Year-end capital infusion 31 March',
                lines: [
                    { accountId: bankAccount.id, debit: 15000.00, credit: 0.00, description: 'Bank deposit' },
                    { accountId: equityAccount.id, debit: 0.00, credit: 15000.00, description: 'Capital infusion' }
                ],
                userId: testAdmin.id
            });

            // Post entry on 1 April (FY 2026-27): Dr Expense 2,500, Cr Bank 2,500
            const officeExpense = await prisma.chartOfAccount.findFirst({ where: { type: 'EXPENSE', allowPosting: true } });
            april01Journal = await journalService.postJournalEntry({
                entryDate: new Date('2026-04-01T10:00:00.000Z'),
                financialYearId: fy2026_27.id,
                sourceType: 'MANUAL',
                narration: 'New year operating expense 1 April',
                lines: [
                    { accountId: officeExpense.id, debit: 2500.00, credit: 0.00, description: 'New year rent' },
                    { accountId: bankAccount.id, debit: 0.00, credit: 2500.00, description: 'Bank payout' }
                ],
                userId: testAdmin.id
            });
        });

        it('9.1 should include 31 March entry and strictly exclude 1 April entry when asOfDate is 2026-03-31', async () => {
            const tbMarch31 = await reportService.getTrialBalance({
                asOfDate: '2026-03-31'
            });

            assert.equal(tbMarch31.summary.isBalanced, true, 'Trial Balance as of 31 March must be balanced');
            assert.equal(tbMarch31.summary.difference, '0.00');

            // General Ledger for Bank as of 2026-03-31
            const bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');
            const glMarch31 = await reportService.getGeneralLedgerReport({
                accountId: bankAccount.id,
                toDate: '2026-03-31'
            });
            const txIds = glMarch31.transactions.map(t => t.journalId);
            assert.ok(txIds.includes(march31Journal.id), 'Must include 31 March entry');
            assert.equal(txIds.includes(april01Journal.id), false, 'Must strictly exclude 1 April entry');
        });

        it('9.2 should carry forward 31 March balances into FY 2026-27 Trial Balance and maintain equilibrium', async () => {
            const tbFY27 = await reportService.getTrialBalance({
                financialYearId: fy2026_27.id
            });

            assert.equal(tbFY27.summary.isBalanced, true, 'Trial Balance for FY 2026-27 must be balanced');
            assert.equal(tbFY27.summary.difference, '0.00');

            // Bank balance should reflect carried forward prior year balance
            const bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');
            const bankRow = tbFY27.rows.find(row => row.id === bankAccount.id);
            assert.ok(bankRow);
            const bankLedger = await reportService.getGeneralLedgerReport({ accountId: bankAccount.id, financialYearId: fy2026_27.id });
            assert.equal(Number(bankRow.debitBalance) - Number(bankRow.creditBalance), Number(bankLedger.account.closingBalance),
                'Trial Balance must exactly match the bank ledger including carried-forward balances');
        });

        it('9.3 should accurately calculate General Ledger opening balance for FY 2026-27', async () => {
            const bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');
            const glFY27 = await reportService.getGeneralLedgerReport({
                accountId: bankAccount.id,
                financialYearId: fy2026_27.id
            });

            // Opening balance entering FY 2026-27 must include the 15,000 from 31 March
            assert.ok(parseFloat(glFY27.account.openingBalance) >= 15000.00);
            assert.ok(glFY27.transactions.some(t => t.journalId === april01Journal.id));
        });
    });

    describe('10. Round-Off Discrepancy & Contra-Revenue Handling', () => {
        it('10.1 should handle round-off gain (Credit 5230) and round-off loss (Debit 5230) in Trial Balance and P&L', async () => {
            const roundOffAccount = await coaService.getSystemAccount('ROUND_OFF');
            assert.ok(roundOffAccount);
            assert.equal(roundOffAccount.code, '5230');

            const tb = await reportService.getTrialBalance();
            assert.equal(tb.summary.isBalanced, true);

            const pnl = await reportService.getProfitAndLoss();
            assert.ok(pnl.summary);
            assert.equal(pnl.summary.totalIncome, pnl.revenue.netRevenue);
        });
    });

    describe('11. Customer Receivables Lifecycle Invariants (Drafts, Voids, Reversals, Debit Notes)', () => {
        it('11.1 should confirm DRAFT credit notes do NOT reduce receivables or affect subledger', async () => {
            const recBefore = await reportService.getCustomerReceivablesReport({ clientId: testClientA.id });
            const clientBefore = recBefore.clients.find(c => c.id === testClientA.id);
            const subledgerBefore = clientBefore.subledgerBalance;

            // Create DRAFT note
            await creditDebitNoteService.createCreditDebitNote({
                invoiceId: createdInvoiceA.id,
                noteType: 'CREDIT',
                noteDate: new Date('2026-06-25'),
                reason: 'Draft note for review',
                items: [{ name: 'Test return', quantity: 1, rate: 500.00, taxRate: 18.00 }],
                status: 'DRAFT'
            }, testAdmin.id);

            const recAfter = await reportService.getCustomerReceivablesReport({ clientId: testClientA.id });
            const clientAfter = recAfter.clients.find(c => c.id === testClientA.id);

            assert.equal(clientAfter.subledgerBalance, subledgerBefore, 'DRAFT credit note must not affect subledger balance');
        });

        it('11.2 should confirm VOID credit notes do NOT reduce receivables', async () => {
            // Issue note then void it
            const noteRes = await creditDebitNoteService.createCreditDebitNote({
                invoiceId: createdInvoiceA.id,
                noteType: 'CREDIT',
                noteDate: new Date('2026-06-26'),
                reason: 'Mistaken note to void',
                items: [{ name: 'Voided item', quantity: 1, rate: 200.00, taxRate: 18.00 }],
                status: 'ISSUED'
            }, testAdmin.id);

            const recIssued = await reportService.getCustomerReceivablesReport({ clientId: testClientA.id });
            const subledgerIssued = recIssued.clients.find(c => c.id === testClientA.id).subledgerBalance;

            // Void note
            await creditDebitNoteService.voidCreditDebitNote(noteRes.note.id, testAdmin.id, 'Wrong product code');

            const recVoided = await reportService.getCustomerReceivablesReport({ clientId: testClientA.id });
            const subledgerVoided = recVoided.clients.find(c => c.id === testClientA.id).subledgerBalance;

            // Subledger balance should have restored (+ 236.00)
            const diffCents = reportService.toCents(subledgerVoided) - reportService.toCents(subledgerIssued);
            assert.equal(diffCents, 23600n, 'Voiding credit note must restore client subledger by note amount');
        });

        it('11.3 should confirm DEBIT notes increase receivables and subledger balance', async () => {
            const recBefore = await reportService.getCustomerReceivablesReport({ clientId: testClientA.id });
            const subBefore = recBefore.clients.find(c => c.id === testClientA.id).subledgerBalance;

            // Issue DEBIT note: 1,000 + 180 = 1,180
            await creditDebitNoteService.createCreditDebitNote({
                invoiceId: createdInvoiceA.id,
                noteType: 'DEBIT',
                noteDate: new Date('2026-06-27'),
                reason: 'Price escalation',
                items: [{ name: 'Price hike', quantity: 1, rate: 1000.00, taxRate: 18.00 }],
                status: 'ISSUED'
            }, testAdmin.id);

            const recAfter = await reportService.getCustomerReceivablesReport({ clientId: testClientA.id });
            const subAfter = recAfter.clients.find(c => c.id === testClientA.id).subledgerBalance;

            const diff = reportService.toCents(subAfter) - reportService.toCents(subBefore);
            assert.equal(diff, 118000n, 'Debit note must increase subledger balance by exactly 1,180.00');
        });
    });

    describe('12. Role-Based Access Control Rejection for Unauthorized Users', () => {
        let staffCookie = null;

        before(async () => {
            const staffEmail = `staff_rec_${Date.now()}@example.com`;
            const pwdHash = await hashPassword('Staff@12345');
            await prisma.user.create({
                data: {
                    name: 'Staff Reconciler',
                    email: staffEmail,
                    password: pwdHash,
                    role: 'STAFF',
                    status: 'ACTIVE'
                }
            });

            // Log in as STAFF
            const getLoginRes = await fetch(`${baseUrl}/login`);
            const initCookie = extractCookie(getLoginRes);
            const csrf = extractCsrfToken(await getLoginRes.text());

            const loginRes = await fetch(`${baseUrl}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: initCookie
                },
                body: new URLSearchParams({
                    _csrf: csrf,
                    email: staffEmail,
                    password: 'Staff@12345'
                }).toString(),
                redirect: 'manual'
            });
            staffCookie = extractCookie(loginRes);
        });

        it('12.1 should reject STAFF role with 403 Forbidden on GET /reports', async () => {
            const res = await fetch(`${baseUrl}/reports`, { headers: { Cookie: staffCookie } });
            assert.equal(res.status, 403, 'STAFF user must receive 403 Forbidden for /reports');
        });

        it('12.2 should reject STAFF role with 403 Forbidden on GET /reports/trial-balance', async () => {
            const res = await fetch(`${baseUrl}/reports/trial-balance`, { headers: { Cookie: staffCookie } });
            assert.equal(res.status, 403, 'STAFF user must receive 403 Forbidden for /reports/trial-balance');
        });
    });

    describe('13. Customer Sub-Ledger Statement, CSV Export & Universal Drilldown API', () => {
        it('13.1 should render GET /reports/customer-statement without clientId with 200 OK', async () => {
            const res = await fetch(`${baseUrl}/reports/customer-statement`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200, 'Customer sub-ledger landing must return 200 OK');
            const text = await res.text();
            assert.ok(text.includes('Customer') || text.includes('Sub-Ledger'), 'Must contain Customer or Sub-Ledger text');
        });

        it('13.2 should export customer statement as CSV via GET /reports/customer-statement/:clientId/export', async () => {
            const res = await fetch(`${baseUrl}/reports/customer-statement/${testClientA.id}/export`, { headers: { Cookie: authCookie } });
            assert.equal(res.status, 200, 'Exporting sub-ledger as CSV must return 200 OK');
            const contentType = res.headers.get('content-type');
            assert.ok(contentType.includes('text/csv'), 'Content-Type must be text/csv');
            const text = await res.text();
            assert.ok(text.includes('CUSTOMER SUB-LEDGER STATEMENT'), 'CSV must contain statement title');
            assert.ok(text.includes(testClientA.name), 'CSV must contain client name');
        });

        it('13.3 should return journal JSON via GET /api/journals/:id for drilldown modal', async () => {
            const journal = await prisma.journalEntry.findFirst();
            if (journal) {
                const res = await fetch(`${baseUrl}/api/journals/${journal.id}`, { headers: { Cookie: authCookie } });
                assert.equal(res.status, 200, 'GET /api/journals/:id must return 200 OK');
                const json = await res.json();
                assert.equal(json.success, true);
                assert.equal(json.data.id, journal.id);
            }
        });

        it('13.4 should strictly isolate invoices by businessId', async () => {
            const resultForUnknownBiz = await invoiceService.listInvoices({ businessId: 99999 });
            assert.equal(resultForUnknownBiz.data.length, 0, 'Nonexistent business must return 0 invoices');
            assert.equal(resultForUnknownBiz.pagination.total, 0, 'Pagination total must be 0');

            const kpisForUnknownBiz = await invoiceService.getDashboardKPIs(99999);
            assert.equal(kpisForUnknownBiz.activeInvoices, 0, 'Active invoices for new/empty business must be 0');
            assert.equal(kpisForUnknownBiz.activeQuotations, 0, 'Active quotations for new/empty business must be 0');
            assert.equal(kpisForUnknownBiz.overdueCount, 0, 'Overdue count for new/empty business must be 0');
        });
    });
});
