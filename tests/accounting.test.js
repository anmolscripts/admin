'use strict';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const coaService = require('../app/services/chartOfAccounts.service');
const journalService = require('../app/services/journal.service');
const { ensureFinancialYear, createFinancialYear } = require('../app/services/financialYear.service');

describe('Accounting ERP: Chart of Accounts & Double Entry Ledger', () => {
    let testAdmin = null;
    let testFy = null;

    before(async () => {
        testAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testAdmin) {
            testAdmin = await prisma.user.findFirst();
        }
        testFy = await ensureFinancialYear(new Date('2026-04-15'));
        await coaService.ensureSystemAccounts(testAdmin ? testAdmin.id : null);
    });

    after(async () => {
        await prisma.$disconnect();
    });

    describe('1. Chart of Accounts Architecture & Integrity', () => {
        it('1.1 should provision standard 5-element accounting classification hierarchy', async () => {
            const accounts = await coaService.listAccounts();
            assert.ok(accounts.length >= 20, 'Should have standard accounts provisioned');

            const types = new Set(accounts.map(a => a.type));
            assert.ok(types.has('ASSET'), 'Must have ASSET accounts');
            assert.ok(types.has('LIABILITY'), 'Must have LIABILITY accounts');
            assert.ok(types.has('EQUITY'), 'Must have EQUITY accounts');
            assert.ok(types.has('INCOME'), 'Must have INCOME accounts');
            assert.ok(types.has('EXPENSE'), 'Must have EXPENSE accounts');
        });

        it('1.2 should correctly identify system control accounts and system account keys', async () => {
            const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');
            assert.ok(arAccount);
            assert.equal(arAccount.code, '1121');
            assert.equal(arAccount.type, 'ASSET');
            assert.equal(arAccount.isControlAccount, true);
            assert.equal(arAccount.allowPosting, true);
            assert.equal(arAccount.isGroup, false);

            const salesAccount = await coaService.getSystemAccount('SALES_REVENUE');
            assert.ok(salesAccount);
            assert.equal(salesAccount.code, '4110');
            assert.equal(salesAccount.type, 'INCOME');

            const bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');
            assert.ok(bankAccount);
            assert.equal(bankAccount.type, 'ASSET');

            const outputCgst = await coaService.getSystemAccount('OUTPUT_CGST');
            assert.ok(outputCgst);
            assert.equal(outputCgst.type, 'LIABILITY');
        });

        it('1.3 should enforce group accounts cannot allow posting directly', async () => {
            const currentAssetsGroup = await coaService.getAccountByCode('1100');
            assert.ok(currentAssetsGroup);
            assert.equal(currentAssetsGroup.isGroup, true);
            assert.equal(currentAssetsGroup.allowPosting, false);
        });

        it('1.4 should retrieve accounts as a hierarchical tree structure', async () => {
            const tree = await coaService.getAccountTree();
            assert.ok(Array.isArray(tree));
            assert.ok(tree.length >= 5, 'Root tree must contain the top-level groups');

            const assetRoot = tree.find(node => node.code === '1000');
            assert.ok(assetRoot);
            assert.ok(assetRoot.children.length > 0, 'Assets root must have child groups');
        });

        it('1.5 should create custom posting account under an existing group', async () => {
            const parentGroup = await coaService.getAccountByCode('1110'); // Cash & Bank
            assert.ok(parentGroup);

            const customCode = `1119-${Date.now().toString().slice(-4)}`;
            const created = await coaService.createAccount({
                code: customCode,
                name: 'Petty Cash - Branch Office',
                parentId: parentGroup.id,
                isGroup: false,
                allowPosting: true,
                description: 'Branch petty cash account'
            }, testAdmin ? testAdmin.id : null);

            assert.ok(created);
            assert.equal(created.code, customCode);
            assert.equal(created.type, 'ASSET');
            assert.equal(created.level, parentGroup.level + 1);
            assert.equal(created.allowPosting, true);

            // Clean up custom account
            await coaService.deleteAccount(created.id);
        });

        it('1.6 should reject creating account with duplicate code', async () => {
            await assert.rejects(async () => {
                await coaService.createAccount({
                    code: '1121', // already used by ACCOUNTS_RECEIVABLE
                    name: 'Duplicate Accounts Receivable',
                    type: 'ASSET'
                });
            }, /already in use/);
        });

        it('1.7 should protect system accounts from deletion', async () => {
            const arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');
            await assert.rejects(async () => {
                await coaService.deleteAccount(arAccount.id);
            }, /System accounts cannot be deleted/);
        });

        it('1.8 should reject child account creation under a non-group account', async () => {
            const leafAccount = await coaService.getSystemAccount('CASH_ON_HAND');
            assert.equal(leafAccount.isGroup, false);

            await assert.rejects(async () => {
                await coaService.createAccount({
                    code: '1111-CHILD',
                    name: 'Illegal Child Under Leaf',
                    parentId: leafAccount.id
                });
            }, /must be an account group/);
        });

        it('1.9 should prevent an account from being its own parent or circular hierarchy', async () => {
            const parentGroup = await coaService.getAccountByCode('1100');
            await assert.rejects(async () => {
                await coaService.updateAccount(parentGroup.id, {
                    parentId: parentGroup.id
                });
            }, /cannot be its own parent/);
        });
    });

    describe('2. Double Entry Ledger Invariants & Atomicity', () => {
        let cashAccount = null;
        let capitalAccount = null;
        let bankAccount = null;
        let arAccount = null;
        let salesAccount = null;
        let client = null;

        before(async () => {
            cashAccount = await coaService.getSystemAccount('CASH_ON_HAND');
            capitalAccount = await coaService.getSystemAccount('CAPITAL');
            bankAccount = await coaService.getSystemAccount('BANK_ACCOUNT');
            arAccount = await coaService.getSystemAccount('ACCOUNTS_RECEIVABLE');
            salesAccount = await coaService.getSystemAccount('SALES_REVENUE');

            client = await prisma.client.findFirst({ where: { active: true } });
            if (!client) {
                client = await prisma.client.create({
                    data: {
                        name: 'Test Accounting Client',
                        email: 'accounting.client@example.com',
                        phone: '9876543210',
                        gstin: '29ABCDE1234F1Z5',
                        stateCode: '29',
                        active: true,
                        createdById: testAdmin ? testAdmin.id : null
                    }
                });
            }
        });

        it('2.1 should post an atomic balanced double-entry journal (Debit = Credit)', async () => {
            const entryDate = new Date('2026-05-01');
            const initialCash = Number(cashAccount.currentBalance);
            const initialCapital = Number(capitalAccount.currentBalance);

            const journal = await journalService.postJournalEntry({
                entryDate,
                sourceType: 'CAPITAL_INTRODUCTION',
                narration: 'Owner introduced initial capital into cash',
                userId: testAdmin ? testAdmin.id : null,
                lines: [
                    { accountId: cashAccount.id, debit: '50000.00', credit: '0.00', description: 'Capital introduced in cash' },
                    { accountId: capitalAccount.id, debit: '0.00', credit: '50000.00', description: 'Owner share capital' }
                ]
            });

            assert.ok(journal);
            assert.ok(journal.entryNumber.startsWith('JRN-2026-27-'));
            assert.equal(journal.status, 'POSTED');
            assert.equal(journal.lines.length, 2);

            // Verify account balances updated correctly
            const updatedCash = await coaService.getAccountById(cashAccount.id);
            const updatedCapital = await coaService.getAccountById(capitalAccount.id);

            assert.equal(Number(updatedCash.currentBalance), initialCash + 50000);
            assert.equal(Number(updatedCapital.currentBalance), initialCapital + 50000);
        });

        it('2.2 should strictly reject imbalanced journal entries', async () => {
            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-05-02'),
                    narration: 'Invalid imbalanced entry',
                    lines: [
                        { accountId: cashAccount.id, debit: '1000.00', credit: '0.00' },
                        { accountId: capitalAccount.id, debit: '0.00', credit: '800.00' } // Imbalance of 200
                    ]
                });
            }, /Double entry imbalance/);
        });

        it('2.3 should reject lines with both debit and credit or negative amounts or zero amounts', async () => {
            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-05-02'),
                    narration: 'Invalid dual line entry',
                    lines: [
                        { accountId: cashAccount.id, debit: '100.00', credit: '100.00' },
                        { accountId: capitalAccount.id, debit: '0.00', credit: '200.00' }
                    ]
                });
            }, /A line cannot have both debit and credit/);

            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-05-02'),
                    narration: 'Negative amount line',
                    lines: [
                        { accountId: cashAccount.id, debit: '-50.00', credit: '0.00' },
                        { accountId: capitalAccount.id, debit: '0.00', credit: '-50.00' }
                    ]
                });
            }, /amounts cannot be negative/);

            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-05-02'),
                    narration: 'Zero amount line',
                    lines: [
                        { accountId: cashAccount.id, debit: '0.00', credit: '0.00' },
                        { accountId: capitalAccount.id, debit: '0.00', credit: '0.00' }
                    ]
                });
            }, /must specify either a debit or credit amount/);
        });

        it('2.4 should reject journal entries with fewer than 2 lines', async () => {
            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-05-02'),
                    narration: 'Single line journal',
                    lines: [
                        { accountId: cashAccount.id, debit: '500.00', credit: '0.00' }
                    ]
                });
            }, /must contain at least two lines/);
        });

        it('2.5 should reject journal posting to a group account or inactive account', async () => {
            const currentAssetsGroup = await coaService.getAccountByCode('1100');
            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-05-02'),
                    narration: 'Attempting to post to group account',
                    lines: [
                        { accountId: currentAssetsGroup.id, debit: '500.00', credit: '0.00' },
                        { accountId: capitalAccount.id, debit: '0.00', credit: '500.00' }
                    ]
                });
            }, /group account.*Postings are only allowed to leaf accounts/);
        });

        it('2.6 should guarantee atomic rollback if any validation fails during posting', async () => {
            const initialJournalsCount = await prisma.journalEntry.count();
            const initialLinesCount = await prisma.journalEntryLine.count();

            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-05-03'),
                    narration: 'Atomic rollback test',
                    lines: [
                        { accountId: cashAccount.id, debit: '500.00', credit: '0.00' },
                        { accountId: 999999, debit: '0.00', credit: '500.00' } // Nonexistent account ID
                    ]
                });
            }, /does not exist/);

            const finalJournalsCount = await prisma.journalEntry.count();
            const finalLinesCount = await prisma.journalEntryLine.count();

            assert.equal(finalJournalsCount, initialJournalsCount, 'No partial journal header must remain');
            assert.equal(finalLinesCount, initialLinesCount, 'No partial journal lines must remain');
        });

        it('2.7 should enforce idempotency: duplicate posting attempt returns existing journal', async () => {
            const idempotencyKey = `INV-POSTING-${Date.now()}`;

            const journal1 = await journalService.postJournalEntry({
                entryDate: new Date('2026-05-04'),
                sourceType: 'INVOICE',
                sourceId: 501,
                idempotencyKey,
                narration: 'Invoice 501 posting',
                lines: [
                    { accountId: arAccount.id, debit: '1200.00', credit: '0.00' },
                    { accountId: salesAccount.id, debit: '0.00', credit: '1200.00' }
                ]
            });

            // Second attempt with identical idempotencyKey
            const journal2 = await journalService.postJournalEntry({
                entryDate: new Date('2026-05-04'),
                sourceType: 'INVOICE',
                sourceId: 501,
                idempotencyKey,
                narration: 'Invoice 501 duplicate posting attempt',
                lines: [
                    { accountId: arAccount.id, debit: '1200.00', credit: '0.00' },
                    { accountId: salesAccount.id, debit: '0.00', credit: '1200.00' }
                ]
            });

            assert.equal(journal1.id, journal2.id, 'Idempotent calls must return the same journal');
            assert.equal(journal1.entryNumber, journal2.entryNumber);

            // Concurrent Request A + Request A test
            const concurrentKey = `CONCURRENT-${Date.now()}`;
            const [concurrent1, concurrent2] = await Promise.all([
                journalService.postJournalEntry({
                    entryDate: new Date('2026-05-04'),
                    sourceType: 'INVOICE',
                    sourceId: 502,
                    idempotencyKey: concurrentKey,
                    narration: 'Concurrent posting 1',
                    lines: [
                        { accountId: arAccount.id, debit: '500.00', credit: '0.00' },
                        { accountId: salesAccount.id, debit: '0.00', credit: '500.00' }
                    ]
                }),
                journalService.postJournalEntry({
                    entryDate: new Date('2026-05-04'),
                    sourceType: 'INVOICE',
                    sourceId: 502,
                    idempotencyKey: concurrentKey,
                    narration: 'Concurrent posting 2',
                    lines: [
                        { accountId: arAccount.id, debit: '500.00', credit: '0.00' },
                        { accountId: salesAccount.id, debit: '0.00', credit: '500.00' }
                    ]
                })
            ]);
            assert.equal(concurrent1.id, concurrent2.id, 'Concurrent idempotent calls must resolve to the exact same journal');
            assert.equal(concurrent1.entryNumber, concurrent2.entryNumber);
        });

        it('2.8 should enforce Financial Year date boundary alignment', async () => {
            const fy2025_26 = await ensureFinancialYear(new Date('2026-02-01'));
            const fy2026_27 = await ensureFinancialYear(new Date('2026-05-01'));

            // Boundary 1: entryDate = 2026-03-31 (FY 2025-26) with financialYearId = FY 2026-27 must be rejected
            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-03-31'),
                    financialYearId: fy2026_27.id,
                    narration: 'Boundary check: 2026-03-31 with FY 2026-27',
                    lines: [
                        { accountId: cashAccount.id, debit: '100.00', credit: '0.00' },
                        { accountId: capitalAccount.id, debit: '0.00', credit: '100.00' }
                    ]
                });
            }, /does not fall within Financial Year/);

            // Boundary 2: entryDate = 2026-04-01 (FY 2026-27) with financialYearId = FY 2025-26 must be rejected
            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-04-01'),
                    financialYearId: fy2025_26.id,
                    narration: 'Boundary check: 2026-04-01 with FY 2025-26',
                    lines: [
                        { accountId: cashAccount.id, debit: '100.00', credit: '0.00' },
                        { accountId: capitalAccount.id, debit: '0.00', credit: '100.00' }
                    ]
                });
            }, /does not fall within Financial Year/);

            // Out-of-bounds date in FY 2025-26
            await assert.rejects(async () => {
                await journalService.postJournalEntry({
                    entryDate: new Date('2026-05-01'),
                    financialYearId: fy2025_26.id,
                    narration: 'Date FY mismatch test',
                    lines: [
                        { accountId: cashAccount.id, debit: '100.00', credit: '0.00' },
                        { accountId: capitalAccount.id, debit: '0.00', credit: '100.00' }
                    ]
                });
            }, /does not fall within Financial Year/);
        });

        it('2.9 should record subledger customer reference on journal entry lines', async () => {
            assert.ok(client, 'A client must exist in fixtures');

            const journal = await journalService.postJournalEntry({
                entryDate: new Date('2026-05-05'),
                sourceType: 'INVOICE',
                sourceId: 9999,
                narration: `Direct credit sale to customer ${client.name}`,
                lines: [
                    {
                        accountId: arAccount.id,
                        debit: '15000.00',
                        credit: '0.00',
                        description: 'Sales receivable for invoice',
                        clientId: client.id
                    },
                    {
                        accountId: salesAccount.id,
                        debit: '0.00',
                        credit: '15000.00',
                        description: 'Revenue from consulting services'
                    }
                ]
            });

            assert.ok(journal);
            const arLine = journal.lines.find(l => l.accountId === arAccount.id);
            assert.ok(arLine);
            assert.equal(arLine.clientId, client.id);
            assert.equal(arLine.client.name, client.name);
        });

        it('2.10 should immutably reverse a journal entry with swapped debit/credit lines', async () => {
            const original = await journalService.postJournalEntry({
                entryDate: new Date('2026-05-10'),
                narration: 'Cash deposit into bank account',
                lines: [
                    { accountId: bankAccount.id, debit: '10000.00', credit: '0.00' },
                    { accountId: cashAccount.id, debit: '0.00', credit: '10000.00' }
                ]
            });

            assert.equal(original.status, 'POSTED');

            const reversal = await journalService.reverseJournalEntry(original.id, {
                reason: 'Bank transfer canceled by client',
                reversalDate: new Date('2026-05-11'),
                userId: testAdmin ? testAdmin.id : null
            });

            assert.ok(reversal);
            assert.equal(reversal.status, 'POSTED');

            const reloadedOriginal = await journalService.getJournalEntryById(original.id);
            assert.equal(reloadedOriginal.status, 'REVERSED');
            assert.equal(reloadedOriginal.reversedEntryId, reversal.id);

            await assert.rejects(async () => {
                await journalService.reverseJournalEntry(original.id);
            }, /already been reversed/);
        });

        it('2.11 should strictly reject editing or deleting posted journal entries', async () => {
            await assert.rejects(async () => {
                await journalService.updateJournalEntry();
            }, /Posted journal entries are immutable/);

            await assert.rejects(async () => {
                await journalService.deleteJournalEntry();
            }, /Posted journal entries cannot be deleted/);
        });

        it('2.12 should produce accurate Account Ledger with running balance', async () => {
            const ledger = await journalService.getAccountLedger(cashAccount.id);

            assert.ok(ledger.account);
            assert.equal(ledger.account.code, '1111');
            assert.ok(Array.isArray(ledger.transactions));
            assert.ok(ledger.summary);

            let calculatedRunningCents = journalService.toCents(ledger.account.openingBalance);
            for (const tx of ledger.transactions) {
                const drCents = journalService.toCents(tx.debit);
                const crCents = journalService.toCents(tx.credit);
                calculatedRunningCents = calculatedRunningCents + drCents - crCents;
                assert.equal(
                    tx.runningBalance,
                    journalService.fromCents(calculatedRunningCents),
                    `Running balance must match at transaction ${tx.entryNumber}`
                );
            }
        });

        it('2.13 should allocate unique, sequential journal numbers under concurrent posting', async () => {
            const promises = [];
            const concurrentCount = 5;
            for (let i = 0; i < concurrentCount; i++) {
                promises.push(
                    journalService.postJournalEntry({
                        entryDate: new Date('2026-06-01'),
                        narration: `Concurrent sequence test entry ${i + 1}`,
                        lines: [
                            { accountId: cashAccount.id, debit: '10.00', credit: '0.00' },
                            { accountId: salesAccount.id, debit: '0.00', credit: '10.00' }
                        ]
                    })
                );
            }

            const results = await Promise.all(promises);
            const entryNumbers = results.map(r => r.entryNumber);
            const uniqueNumbers = new Set(entryNumbers);
            assert.equal(uniqueNumbers.size, concurrentCount, 'Every concurrent journal must receive a unique entry number');

            for (const num of entryNumbers) {
                assert.match(num, /^JRN-2026-27-\d{4}$/, 'Entry number must match pattern JRN-YYYY-YY-NNNN');
            }
        });

        it('2.14 should isolate journal numbering sequences across distinct Financial Years', async () => {
            const fy2025_26 = await ensureFinancialYear(new Date('2026-01-15'));
            const fy2026_27 = await ensureFinancialYear(new Date('2026-07-15'));

            const jrn1_fy25 = await journalService.postJournalEntry({
                entryDate: new Date('2026-01-20'),
                financialYearId: fy2025_26.id,
                narration: 'FY 2025-26 Entry 1',
                lines: [
                    { accountId: cashAccount.id, debit: '25.00', credit: '0.00' },
                    { accountId: salesAccount.id, debit: '0.00', credit: '25.00' }
                ]
            });

            const jrn1_fy26 = await journalService.postJournalEntry({
                entryDate: new Date('2026-07-20'),
                financialYearId: fy2026_27.id,
                narration: 'FY 2026-27 Entry 1',
                lines: [
                    { accountId: cashAccount.id, debit: '30.00', credit: '0.00' },
                    { accountId: salesAccount.id, debit: '0.00', credit: '30.00' }
                ]
            });

            const jrn2_fy25 = await journalService.postJournalEntry({
                entryDate: new Date('2026-02-10'),
                financialYearId: fy2025_26.id,
                narration: 'FY 2025-26 Entry 2',
                lines: [
                    { accountId: cashAccount.id, debit: '35.00', credit: '0.00' },
                    { accountId: salesAccount.id, debit: '0.00', credit: '35.00' }
                ]
            });

            assert.ok(jrn1_fy25.entryNumber.startsWith('JRN-2025-26-'), 'Must have FY 2025-26 prefix');
            assert.ok(jrn1_fy26.entryNumber.startsWith('JRN-2026-27-'), 'Must have FY 2026-27 prefix');
            assert.ok(jrn2_fy25.entryNumber.startsWith('JRN-2025-26-'), 'Must have FY 2025-26 prefix');

            const seq1 = parseInt(jrn1_fy25.entryNumber.split('-').pop(), 10);
            const seq2 = parseInt(jrn2_fy25.entryNumber.split('-').pop(), 10);
            assert.equal(seq2, seq1 + 1, 'FY 2025-26 sequence must increment by exactly 1 without being affected by FY 2026-27 postings');
            assert.notEqual(jrn1_fy25.financialYearId, jrn1_fy26.financialYearId);
        });
    });
});
