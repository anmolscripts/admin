'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const reportService = require('../app/services/accounting/report.service');
const journalService = require('../app/services/journal.service');
const coaService = require('../app/services/chartOfAccounts.service');
const postingService = require('../app/services/accounting/posting.service');
const businessService = require('../app/services/business.service');
const clientService = require('../app/services/client.service');
const { ensureFinancialYear } = require('../app/services/financialYear.service');

describe('Accounting Report Multi-Tenant Isolation & Account Collision Regression Suite', () => {
    let tenantA;
    let tenantB;
    let userA;
    let userB;
    let fyA;
    let fyB;
    let bankA;
    let bankB;
    let salesA;
    let salesB;
    let arA;
    let arB;
    let clientA;
    let clientB;
    let invoiceA;
    let invoiceB;

    const ts = Date.now().toString().slice(-6);

    before(async () => {
        // 1. Create two isolated corporate tenants
        tenantA = await businessService.createBusiness({
            code: `ISO_T1_${ts}`,
            name: `Tenant Isolation Alpha ${ts}`,
            legalName: `Tenant Isolation Alpha Pvt Ltd`,
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '27AAAAA1111A1Z1'
        });

        tenantB = await businessService.createBusiness({
            code: `ISO_T2_${ts}`,
            name: `Tenant Isolation Beta ${ts}`,
            legalName: `Tenant Isolation Beta LLP`,
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '24BBBBB2222B2Z2'
        });

        // 2. Provision Users
        userA = await prisma.user.create({
            data: {
                name: `User Alpha ${ts}`,
                email: `alpha_${ts}@iso.test`,
                password: 'test-hash-alpha',
                role: 'ADMIN',
                active: true
            }
        });
        await businessService.addOrUpdateMember({ businessId: tenantA.id, userId: userA.id, role: 'ADMIN' });

        userB = await prisma.user.create({
            data: {
                name: `User Beta ${ts}`,
                email: `beta_${ts}@iso.test`,
                password: 'test-hash-beta',
                role: 'ADMIN',
                active: true
            }
        });
        await businessService.addOrUpdateMember({ businessId: tenantB.id, userId: userB.id, role: 'ADMIN' });

        // 3. Provision Financial Years
        fyA = await ensureFinancialYear(new Date('2026-06-15'), tenantA.id);
        fyB = await ensureFinancialYear(new Date('2026-06-15'), tenantB.id);

        // 4. Ensure System Accounts for Both Tenants (creates identical account codes 1112, 1121, 4110)
        await coaService.ensureSystemAccounts(userA.id, tenantA.id);
        await coaService.ensureSystemAccounts(userB.id, tenantB.id);

        bankA = await coaService.getSystemAccount('BANK_ACCOUNT', tenantA.id);
        bankB = await coaService.getSystemAccount('BANK_ACCOUNT', tenantB.id);
        salesA = await coaService.getSystemAccount('SALES_REVENUE', tenantA.id);
        salesB = await coaService.getSystemAccount('SALES_REVENUE', tenantB.id);
        arA = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE', tenantA.id);
        arB = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE', tenantB.id);

        // Invariant: Both tenants possess separate account IDs but identical account codes
        assert.notEqual(bankA.id, bankB.id);
        assert.equal(bankA.code, bankB.code); // Both are 1112
        assert.notEqual(arA.id, arB.id);
        assert.equal(arA.code, arB.code); // Both are 1121

        // 5. Post Manual Journals with distinct amounts
        // Tenant A: ₹50,000 (Dr Bank 1112 / Cr Sales 4110)
        await journalService.postJournalEntry({
            entryDate: new Date('2026-06-10'),
            financialYearId: fyA.id,
            sourceType: 'MANUAL',
            narration: 'Tenant A Seed Capital',
            businessId: tenantA.id,
            userId: userA.id,
            lines: [
                { accountId: bankA.id, debit: 50000.00, credit: 0.00, description: 'Bank Inward' },
                { accountId: salesA.id, debit: 0.00, credit: 50000.00, description: 'Direct Sales' }
            ]
        });

        // Tenant B: ₹25,000 (Dr Bank 1112 / Cr Sales 4110)
        await journalService.postJournalEntry({
            entryDate: new Date('2026-06-12'),
            financialYearId: fyB.id,
            sourceType: 'MANUAL',
            narration: 'Tenant B Consulting Advance',
            businessId: tenantB.id,
            userId: userB.id,
            lines: [
                { accountId: bankB.id, debit: 25000.00, credit: 0.00, description: 'Bank Inward' },
                { accountId: salesB.id, debit: 0.00, credit: 25000.00, description: 'Consulting Revenue' }
            ]
        });

        // 6. Create Clients and Post Invoices
        clientA = await clientService.createClient({
            businessId: tenantA.id,
            name: `Client Alpha Corp ${ts}`,
            email: `client_a_${ts}@test.com`,
            gstin: '27AAAAA9999A1Z9',
            stateCode: '27'
        }, userA.id);

        clientB = await clientService.createClient({
            businessId: tenantB.id,
            name: `Client Beta Logistics ${ts}`,
            email: `client_b_${ts}@test.com`,
            gstin: '24BBBBB8888B1Z8',
            stateCode: '24'
        }, userB.id);

        // Invoice A: ₹11,800 under Tenant A
        invoiceA = await prisma.invoice.create({
            data: {
                businessId: tenantA.id,
                documentType: 'INVOICE',
                invoiceNumber: `INV-ISO-A-${ts}`,
                clientId: clientA.id,
                clientName: clientA.name,
                clientGSTIN: clientA.gstin,
                sellerStateCode: '27',
                placeOfSupplyStateCode: '27',
                invoiceDate: new Date('2026-06-15'),
                dueDate: new Date('2026-07-15'),
                subtotal: 10000.00,
                gstRate: 18.00,
                gstAmount: 1800.00,
                cgstAmount: 900.00,
                sgstAmount: 900.00,
                igstAmount: 0.00,
                roundOff: 0.00,
                grandTotal: 11800.00,
                paidAmount: 0.00,
                outstandingAmount: 11800.00,
                status: 'ACTIVE',
                financialYearId: fyA.id,
                createdById: userA.id,
                updatedById: userA.id,
                items: {
                    create: [
                        { lineNumber: 1, name: 'Engine Component', quantity: 1, rate: 10000.00, amount: 10000.00 }
                    ]
                }
            }
        });
        await postingService.postInvoice(invoiceA.id, { userId: userA.id });

        // Invoice B: ₹23,600 under Tenant B
        invoiceB = await prisma.invoice.create({
            data: {
                businessId: tenantB.id,
                documentType: 'INVOICE',
                invoiceNumber: `INV-ISO-B-${ts}`,
                clientId: clientB.id,
                clientName: clientB.name,
                clientGSTIN: clientB.gstin,
                sellerStateCode: '24',
                placeOfSupplyStateCode: '24',
                invoiceDate: new Date('2026-06-16'),
                dueDate: new Date('2026-07-16'),
                subtotal: 20000.00,
                gstRate: 18.00,
                gstAmount: 3600.00,
                cgstAmount: 1800.00,
                sgstAmount: 1800.00,
                igstAmount: 0.00,
                roundOff: 0.00,
                grandTotal: 23600.00,
                paidAmount: 0.00,
                outstandingAmount: 23600.00,
                status: 'ACTIVE',
                financialYearId: fyB.id,
                createdById: userB.id,
                updatedById: userB.id,
                items: {
                    create: [
                        { lineNumber: 1, name: 'Warehouse Rental', quantity: 1, rate: 20000.00, amount: 20000.00 }
                    ]
                }
            }
        });
        await postingService.postInvoice(invoiceB.id, { userId: userB.id });
    });

    after(async () => {
        await prisma.$disconnect();
    });

    it('1. Trial Balance must isolate accounts and balances by businessId without cross-tenant contamination', async () => {
        const tbA = await reportService.getTrialBalance({ businessId: tenantA.id });
        const tbB = await reportService.getTrialBalance({ businessId: tenantB.id });

        assert.equal(tbA.summary.isBalanced, true, 'Tenant A Trial Balance must balance');
        assert.equal(tbB.summary.isBalanced, true, 'Tenant B Trial Balance must balance');

        // Check Bank Account 1112
        const bankRowA = tbA.rows.find(r => r.code === '1112');
        const bankRowB = tbB.rows.find(r => r.code === '1112');

        assert.ok(bankRowA, 'Tenant A must have bank row 1112');
        assert.ok(bankRowB, 'Tenant B must have bank row 1112');

        assert.equal(bankRowA.debitBalance, '50000.00', 'Tenant A bank balance must be exactly ₹50,000.00');
        assert.equal(bankRowB.debitBalance, '25000.00', 'Tenant B bank balance must be exactly ₹25,000.00');

        // Check Revenue Accounts: Tenant A = 50,000 + 10,000 = 60,000; Tenant B = 25,000 + 20,000 = 45,000
        const salesRowA = tbA.rows.find(r => r.code === '4110');
        const salesRowB = tbB.rows.find(r => r.code === '4110');
        assert.equal(salesRowA.creditBalance, '60000.00');
        assert.equal(salesRowB.creditBalance, '45000.00');
    });

    it('2. General Ledger must retrieve transactions strictly scoped to the requested business account', async () => {
        const glA = await reportService.getGeneralLedgerReport({
            accountId: bankA.id,
            businessId: tenantA.id
        });
        const glB = await reportService.getGeneralLedgerReport({
            accountId: bankB.id,
            businessId: tenantB.id
        });

        assert.equal(glA.account.id, bankA.id);
        assert.equal(glB.account.id, bankB.id);

        assert.equal(glA.summary.totalDebit, '50000.00', 'Tenant A bank GL total debit must be 50,000');
        assert.equal(glB.summary.totalDebit, '25000.00', 'Tenant B bank GL total debit must be 25,000');

        // Verify transactions do not bleed across
        assert.ok(glA.transactions.every(t => t.debit === '50000.00' || t.credit !== '0.00'));
        assert.ok(glB.transactions.every(t => t.debit === '25000.00' || t.credit !== '0.00'));
    });

    it('3. Customer Receivables Report must reconcile strictly with tenant-scoped GL 1121 control account', async () => {
        const recA = await reportService.getCustomerReceivablesReport({ businessId: tenantA.id });
        const recB = await reportService.getCustomerReceivablesReport({ businessId: tenantB.id });

        assert.equal(recA.summary.isReconciled, true, 'Tenant A receivables must reconcile with GL 1121');
        assert.equal(recB.summary.isReconciled, true, 'Tenant B receivables must reconcile with GL 1121');

        assert.equal(recA.summary.difference, '0.00');
        assert.equal(recB.summary.difference, '0.00');

        assert.equal(recA.summary.glAccountsReceivable, '11800.00');
        assert.equal(recB.summary.glAccountsReceivable, '23600.00');

        // Verify clients are strictly partitioned
        assert.ok(recA.clients.some(c => c.id === clientA.id), 'Tenant A must include Client A');
        assert.ok(!recA.clients.some(c => c.id === clientB.id), 'Tenant A must strictly exclude Client B');

        assert.ok(recB.clients.some(c => c.id === clientB.id), 'Tenant B must include Client B');
        assert.ok(!recB.clients.some(c => c.id === clientA.id), 'Tenant B must strictly exclude Client A');
    });

    it('4. Default Company queries must strictly exclude tenant accounts and journals', async () => {
        // Querying without businessId targets the default company (businessId: 1 or null)
        const tbDefault = await reportService.getTrialBalance();
        assert.equal(tbDefault.summary.isBalanced, true, 'Default company trial balance must be balanced');

        // The bank accounts in tbDefault should only belong to businessId: null or 1
        const bankRows = tbDefault.rows.filter(r => r.code === '1112');
        assert.equal(bankRows.length, 1, 'Default company must have exactly one canonical bank account row');

        // Must NOT match Tenant A or Tenant B specific accounts
        assert.notEqual(bankRows[0].id, bankA.id, 'Must not be Tenant A bank account');
        assert.notEqual(bankRows[0].id, bankB.id, 'Must not be Tenant B bank account');
    });
});
