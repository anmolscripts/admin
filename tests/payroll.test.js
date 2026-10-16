'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const payrollService = require('../app/services/payroll.service');
const { ensureFinancialYear } = require('../app/services/financialYear.service');
const { ensureSystemAccounts } = require('../app/services/chartOfAccounts.service');

test('Payroll Calculation & GL Posting Integration Test Suite', async (t) => {
    let testUser;
    let employee1;
    let employee2;

    await t.test('Setup test dependencies (Admin, Accounts, FY)', async () => {
        testUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testUser) {
            testUser = await prisma.user.create({
                data: {
                    email: `payroll_admin_${Date.now()}@example.com`,
                    name: 'Payroll Test Admin',
                    passwordHash: 'dummyhash',
                    role: 'ADMIN'
                }
            });
        }

        await ensureSystemAccounts(testUser.id);
        const fy = await ensureFinancialYear(new Date());
        assert.ok(fy && fy.id);
    });

    await t.test('Create employee master records and handle uniqueness', async () => {
        const empCode1 = `EMP${Date.now()}_${Math.floor(Math.random() * 10000)}A`;
        const empCode2 = `EMP${Date.now()}_${Math.floor(Math.random() * 10000)}B`;

        employee1 = await payrollService.createEmployee({
            employeeCode: empCode1,
            firstName: 'Aarav',
            lastName: 'Sharma',
            email: `aarav_${Date.now()}@example.com`,
            department: 'Engineering',
            designation: 'Senior Developer',
            dateOfJoining: '2025-01-15',
            panNumber: 'ABCDE1234F',
            uanNumber: '100200300400',
            bankAccountNumber: '987654321012',
            bankIfsc: 'HDFC0001234'
        }, testUser.id);
        assert.ok(employee1.id);

        employee2 = await payrollService.createEmployee({
            employeeCode: empCode2,
            firstName: 'Priya',
            lastName: 'Patel',
            email: `priya_${Date.now()}@example.com`,
            department: 'Operations',
            designation: 'Associate',
            dateOfJoining: '2025-02-01',
            panNumber: 'FGHIJ5678K',
            uanNumber: '100200300401',
            bankAccountNumber: '987654321013',
            bankIfsc: 'SBIN0001234'
        }, testUser.id);
        assert.ok(employee2.id);

        // Reject duplicate code
        await assert.rejects(
            payrollService.createEmployee({
                employeeCode: empCode1,
                firstName: 'Duplicate',
                lastName: 'Test',
                email: `unique_${Date.now()}@example.com`,
                dateOfJoining: '2025-01-01'
            }, testUser.id),
            /already exists/
        );
    });

    await t.test('Configure salary structures for employees', async () => {
        // High earner: Basic 60,000, HRA 25,000, Special 15,000 (Gross = 100,000)
        // EPF applicable (capped at 15k -> 1,800), ESI not applicable, PT applicable, TDS 5,000
        const struct1 = await payrollService.setSalaryStructure(employee1.id, {
            effectiveFrom: '2025-01-15',
            basicSalary: 60000,
            hra: 25000,
            conveyance: 5000,
            specialAllowance: 10000,
            epfApplicable: true,
            esiApplicable: true, // Should be excluded by engine as Gross > 21,000
            ptApplicable: true,
            tdsMonthly: 5000
        }, testUser.id);
        assert.ok(struct1.id);

        // Associate: Basic 12,000, HRA 5,000, Special 1,000 (Gross = 18,000)
        // EPF applicable (12% of 12,000 = 1,440), ESI applicable (Gross <= 21,000 -> 0.75% = 135), PT 200, TDS 0
        const struct2 = await payrollService.setSalaryStructure(employee2.id, {
            effectiveFrom: '2025-02-01',
            basicSalary: 12000,
            hra: 5000,
            conveyance: 500,
            specialAllowance: 500,
            epfApplicable: true,
            esiApplicable: true,
            ptApplicable: true,
            tdsMonthly: 0
        }, testUser.id);
        assert.ok(struct2.id);
    });

    await t.test('Verify statutory calculation engine precision & legal citations', () => {
        // Statutory TDS Transition Check (TASK-FINAL-004)
        const tdsHist = payrollService.resolveStatutoryTdsProvision(3, 2026); // March 2026 (FY 2025-26)
        assert.equal(tdsHist.section, 'Section 192');
        assert.equal(tdsHist.act, 'Income-tax Act, 1961');

        const tdsCurrent = payrollService.resolveStatutoryTdsProvision(4, 2026); // April 2026 (FY 2026-27)
        assert.equal(tdsCurrent.section, 'Section 392(1)');
        assert.equal(tdsCurrent.act, 'Income-tax Act, 2025');

        const tdsOct = payrollService.resolveStatutoryTdsProvision(10, 2026); // Oct 2026
        assert.equal(tdsOct.section, 'Section 392(1)');

        // Check Employee 1 (High earner: Basic 60,000, Gross 100,000)
        const calc1 = payrollService.calculateStatutoryPayroll({
            basicSalary: 60000,
            hra: 25000,
            conveyance: 5000,
            specialAllowance: 10000,
            epfApplicable: true,
            esiApplicable: true,
            ptApplicable: true,
            tdsMonthly: 5000
        }, 4, 2026); // April 2026

        assert.equal(calc1.grossEarnings, 100000);
        assert.equal(calc1.employeeEpf, 1800); // 12% of 15,000 cap
        assert.equal(calc1.employerEpf, 1800);
        assert.equal(calc1.employerEps, 1249.5); // EPS 8.33% of 15,000 = 1,249.50 (capped at ₹1,250)
        assert.equal(calc1.employerEpfOnly, 550.5); // EPF employer share: 1800 - 1249.50 = 550.50
        assert.equal(calc1.employeeEsi, 0); // Excluded because Gross > 21,000
        assert.equal(calc1.professionalTax, 200);
        assert.equal(calc1.tds, 5000);
        assert.equal(calc1.statutoryTdsSection, 'Section 392(1)');
        assert.equal(calc1.statutoryTdsAct, 'Income-tax Act, 2025');
        // Total Deductions = 1800 + 200 + 5000 = 7000
        assert.equal(calc1.totalDeductions, 7000);
        assert.equal(calc1.netPay, 93000);

        // Check ESI Threshold Boundaries (₹21,000 eligibility test)
        const calcEsiEligible = payrollService.calculateStatutoryPayroll({
            basicSalary: 15000,
            hra: 6000,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: false,
            esiApplicable: true,
            ptApplicable: false,
            tdsMonthly: 0
        }, 4, 2026); // Gross = exactly 21,000
        assert.equal(calcEsiEligible.grossEarnings, 21000);
        assert.equal(calcEsiEligible.employeeEsi, 157.5); // 0.75% of 21,000
        assert.equal(calcEsiEligible.employerEsi, 682.5); // 3.25% of 21,000

        const calcEsiIneligible = payrollService.calculateStatutoryPayroll({
            basicSalary: 15001,
            hra: 6000,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: false,
            esiApplicable: true,
            ptApplicable: false,
            tdsMonthly: 0
        }, 4, 2026); // Gross = 21,001 (exceeds ₹21,000 threshold)
        assert.equal(calcEsiIneligible.grossEarnings, 21001);
        assert.equal(calcEsiIneligible.employeeEsi, 0); // Strictly excluded
        assert.equal(calcEsiIneligible.employerEsi, 0);

        // Check Professional Tax Slabs (Maharashtra schedule)
        const calcPtLow = payrollService.calculateStatutoryPayroll({
            basicSalary: 7500,
            hra: 0,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: false,
            esiApplicable: false,
            ptApplicable: true,
            tdsMonthly: 0
        }, 4, 2026);
        assert.equal(calcPtLow.professionalTax, 0); // <= 7,500 is nil

        const calcPtMid = payrollService.calculateStatutoryPayroll({
            basicSalary: 8000,
            hra: 0,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: false,
            esiApplicable: false,
            ptApplicable: true,
            tdsMonthly: 0
        }, 4, 2026);
        assert.equal(calcPtMid.professionalTax, 175); // 7,501 to 10,000 is 175

        // Check February PT slab (₹300)
        const calcFeb = payrollService.calculateStatutoryPayroll({
            basicSalary: 60000,
            hra: 25000,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: false,
            esiApplicable: false,
            ptApplicable: true,
            tdsMonthly: 0
        }, 2, 2026); // Feb
        assert.equal(calcFeb.professionalTax, 300);

        // Check Employee 2 (Associate earner: Basic 12,000, Gross 18,000)
        const calc2 = payrollService.calculateStatutoryPayroll({
            basicSalary: 12000,
            hra: 5000,
            conveyance: 500,
            specialAllowance: 500,
            epfApplicable: true,
            esiApplicable: true,
            ptApplicable: true,
            tdsMonthly: 0
        }, 4, 2026);

        assert.equal(calc2.grossEarnings, 18000);
        assert.equal(calc2.employeeEpf, 1440); // 12% of 12,000
        assert.equal(calc2.employerEpf, 1440);
        assert.equal(calc2.employeeEsi, 135); // 0.75% of 18,000
        assert.equal(calc2.employerEsi, 585); // 3.25% of 18,000
        assert.equal(calc2.professionalTax, 200);
        // Deductions = 1440 + 135 + 200 = 1775
        assert.equal(calc2.totalDeductions, 1775);
        assert.equal(calc2.netPay, 16225);
    });

    let generatedPeriod;

    await t.test('Generate payroll period and entries', async () => {
        // Use dynamically unique year/month combination to ensure idempotency across repeated test runs
        const yr = 2035 + (Math.floor(Date.now() / 1000) % 50);
        const mo = 1 + (Math.floor(Date.now() / 60000) % 12);
        const periodCode = `PAY-${yr}-${String(mo).padStart(2, '0')}`;
        await prisma.payrollPeriod.deleteMany({ where: { periodCode } });

        // Missing or invalid businessId must be rejected with ValidationError
        await assert.rejects(
            payrollService.generatePayrollPeriod({ month: mo, year: yr }, testUser.id),
            /valid, positive integer businessId is required/i
        );
        await assert.rejects(
            payrollService.generatePayrollPeriod({ businessId: 'not-a-number', month: mo, year: yr }, testUser.id),
            /valid, positive integer businessId is required/i
        );
        await assert.rejects(
            payrollService.generatePayrollPeriod({ businessId: -1, month: mo, year: yr }, testUser.id),
            /valid, positive integer businessId is required/i
        );

        generatedPeriod = await payrollService.generatePayrollPeriod({ businessId: 1, month: mo, year: yr }, testUser.id);
        assert.ok(generatedPeriod.id);
        assert.equal(generatedPeriod.businessId, 1);
        assert.equal(generatedPeriod.status, 'DRAFT');
        assert.ok(generatedPeriod.entriesCount >= 2);

        // Disallow duplicate period generation for the same business
        await assert.rejects(
            payrollService.generatePayrollPeriod({ businessId: 1, month: mo, year: yr }, testUser.id),
            /already generated/
        );
    });

    await t.test('Approve payroll period', async () => {
        const approved = await payrollService.approvePayrollPeriod(generatedPeriod.id, testUser.id);
        assert.equal(approved.status, 'APPROVED');
        assert.ok(approved.approvedAt);
    });

    await t.test('Post approved payroll period to GL and verify double-entry balance', async () => {
        const posted = await payrollService.postPayrollToLedger(generatedPeriod.id, testUser.id);
        assert.equal(posted.status, 'POSTED');
        assert.ok(posted.journalEntryId);

        // Fetch journal entry with lines
        const journal = await prisma.journalEntry.findUnique({
            where: { id: posted.journalEntryId },
            include: { lines: { include: { account: true } } }
        });
        assert.ok(journal);
        assert.equal(journal.businessId, 1, 'Journal must be posted strictly to Business 1');

        // Double-entry validation: Total Debit must equal Total Credit exactly to the cent
        const totalDebit = journal.lines.reduce((s, l) => s + Number(l.debit), 0);
        const totalCredit = journal.lines.reduce((s, l) => s + Number(l.credit), 0);
        assert.equal(Math.round(totalDebit * 100) / 100, Math.round(totalCredit * 100) / 100);

        // Verify account keys
        const accountKeys = journal.lines.map(l => l.account.systemAccountKey);
        assert.ok(accountKeys.includes('SALARIES_EXPENSE'), 'Must include Salaries Expense');
        assert.ok(accountKeys.includes('SALARIES_PAYABLE'), 'Must include Salaries Payable');
        assert.ok(accountKeys.includes('EPF_PAYABLE'), 'Must include EPF Payable');

        // Requirement 5: Payroll journal postings use central JRNL/YYYY/MM/INCREMENT sequence independent of periodCode
        assert.match(journal.entryNumber, /^JRNL\/\d{4}\/\d{2}\/\d+$/, 'Journal entry number must adhere to canonical JRNL/YYYY/MM/INCREMENT');
    });

    await t.test('Multi-business tenancy: Coexistence of identical periodCode across separate businesses and same-business duplicate prevention', async () => {
        // Create or find a secondary test business
        const biz2 = await prisma.business.upsert({
            where: { code: 'PAYROLL_BIZ_2' },
            create: {
                code: 'PAYROLL_BIZ_2',
                name: 'Secondary Payroll Corp',
                currency: 'INR'
            },
            update: {}
        });

        // Create an employee in biz2
        const empBiz2 = await payrollService.createEmployee({
            businessId: biz2.id,
            employeeCode: `EMP_BIZ2_${Date.now()}`,
            firstName: 'Karan',
            lastName: 'Mehta',
            email: `karan_${Date.now()}@biz2.test`,
            dateOfJoining: '2025-01-01'
        }, testUser.id);

        await payrollService.setSalaryStructure(empBiz2.id, {
            effectiveFrom: '2025-01-01',
            basicSalary: 30000,
            hra: 10000,
            epfApplicable: false,
            esiApplicable: false,
            ptApplicable: false,
            tdsMonthly: 0
        }, testUser.id);

        // Generated period for Business 1 has periodCode: generatedPeriod.periodCode
        // Now generate the EXACT SAME period for Business 2:
        const periodBiz2 = await payrollService.generatePayrollPeriod({
            businessId: biz2.id,
            month: generatedPeriod.month,
            year: generatedPeriod.year
        }, testUser.id);

        assert.equal(periodBiz2.periodCode, generatedPeriod.periodCode, 'Both businesses must use identical periodCode PAY-YYYY-MM');
        assert.equal(periodBiz2.businessId, biz2.id);
        assert.notEqual(periodBiz2.id, generatedPeriod.id);

        // Same-business duplicate creation on Business 2 must be rejected
        await assert.rejects(
            payrollService.generatePayrollPeriod({
                businessId: biz2.id,
                month: generatedPeriod.month,
                year: generatedPeriod.year
            }, testUser.id),
            /already generated/
        );

        // Approve and post periodBiz2 to GL -> journal must be allocated strictly to biz2.id
        await payrollService.approvePayrollPeriod(periodBiz2.id, testUser.id);
        const postedBiz2 = await payrollService.postPayrollToLedger(periodBiz2.id, testUser.id);
        assert.equal(postedBiz2.status, 'POSTED');

        const journalBiz2 = await prisma.journalEntry.findUnique({
            where: { id: postedBiz2.journalEntryId }
        });
        assert.ok(journalBiz2);
        assert.equal(journalBiz2.businessId, biz2.id, 'Business 2 payroll posting must strictly allocate journal in Business 2');
        assert.match(journalBiz2.entryNumber, /^JRNL\/\d{4}\/\d{2}\/\d+$/);

        // Cross-business unauthorized access check: staff member of biz2 cannot create or post payroll for Business 1
        const staffUserB = await prisma.user.create({
            data: {
                name: 'Staff B User',
                email: `staff_b_${Date.now()}@biz2.test`,
                password: 'test-secret-2026',
                role: 'STAFF',
                active: true
            }
        });
        await prisma.businessMembership.create({
            data: {
                userId: staffUserB.id,
                businessId: biz2.id,
                role: 'STAFF',
                status: 'ACTIVE'
            }
        });

        await assert.rejects(
            payrollService.generatePayrollPeriod({
                businessId: 1,
                month: 11,
                year: 2026
            }, staffUserB.id),
            /not authorized/i
        );

        await assert.rejects(
            payrollService.postPayrollToLedger(generatedPeriod.id, staffUserB.id),
            /not authorized/i
        );

        // Posting period with missing or corrupt business context must fail with actionable domain error
        await assert.rejects(
            payrollService.postPayrollToLedger(99999999, testUser.id),
            /not found/i
        );

        // Clean up staffUserB
        await prisma.businessMembership.deleteMany({ where: { userId: staffUserB.id } });
        await prisma.user.delete({ where: { id: staffUserB.id } });
    });

    await t.test('Retrieve employee payslip breakdown', async () => {
        const periodWithEntries = await prisma.payrollPeriod.findUnique({
            where: { id: generatedPeriod.id },
            include: { entries: true }
        });

        const entry = periodWithEntries.entries[0];
        const payslip = await payrollService.getPayslip(entry.id);
        assert.ok(payslip.id);
        assert.ok(payslip.employee.name);
        assert.ok(payslip.earnings.grossEarnings > 0);
        assert.ok(payslip.netPay > 0);
    });

    await t.test('Employee reimbursement lifecycle', async () => {
        const reimb = await payrollService.createReimbursement({
            employeeId: employee1.id,
            amount: 750,
            category: 'Client Dinner',
            description: 'Dinner with client executive'
        }, testUser.id);
        assert.equal(reimb.status, 'PENDING');

        const approvedReimb = await payrollService.approveReimbursement(reimb.id, testUser.id);
        assert.equal(approvedReimb.status, 'APPROVED');
    });

    await t.test('Salary TDS Transition: Validated Payment-Date Basis (TASK 1)', async () => {
        // 1. March 2026 salary paid on 31 March 2026 -> Section 192, Income-tax Act, 1961
        const marchPaidMarch = payrollService.resolveStatutoryTdsProvision('2026-03-31', 3, 2026);
        assert.equal(marchPaidMarch.section, 'Section 192');
        assert.equal(marchPaidMarch.act, 'Income-tax Act, 1961');
        assert.equal(marchPaidMarch.status, 'CONFIRMED');
        assert.equal(marchPaidMarch.isProvisional, false);

        // 2. March 2026 salary paid on 1 April 2026 or later -> Section 392(1), Income-tax Act, 2025
        const marchPaidApril = payrollService.resolveStatutoryTdsProvision('2026-04-01', 3, 2026);
        assert.equal(marchPaidApril.section, 'Section 392(1)');
        assert.equal(marchPaidApril.act, 'Income-tax Act, 2025');
        assert.equal(marchPaidApril.status, 'CONFIRMED');
        assert.equal(marchPaidApril.isProvisional, false);

        // March 2026 salary paid on 7 April 2026 -> Section 392(1)
        const marchPaidApril7 = payrollService.resolveStatutoryTdsProvision('2026-04-07', 3, 2026);
        assert.equal(marchPaidApril7.section, 'Section 392(1)');
        assert.equal(marchPaidApril7.act, 'Income-tax Act, 2025');

        // 3. April 2026 salary paid in April 2026 -> Section 392(1)
        const aprilPaidApril = payrollService.resolveStatutoryTdsProvision('2026-04-30', 4, 2026);
        assert.equal(aprilPaidApril.section, 'Section 392(1)');
        assert.equal(aprilPaidApril.act, 'Income-tax Act, 2025');
        assert.equal(aprilPaidApril.status, 'CONFIRMED');

        // 4. Missing payment date -> PROVISIONAL
        const unpaid = payrollService.resolveStatutoryTdsProvision(null);
        assert.equal(unpaid.status, 'PROVISIONAL');
        assert.equal(unpaid.isProvisional, true);
        assert.equal(unpaid.section, 'PENDING_PAYMENT_DATE');

        // 5. Invalid payment date -> ValidationError
        assert.throws(
            () => payrollService.resolveStatutoryTdsProvision('not-a-valid-date'),
            /Invalid payment date/
        );
    });

    await t.test('EPF Eligibility, Higher-Wage & Age 58 Exceptions (TASK 2)', () => {
        // A. Higher employee voluntary PF without employer match
        // Basic 50,000, higherPfOpted = true, employerMatchesHigherPf = false
        const calcHigherPfNoMatch = payrollService.calculateStatutoryPayroll({
            basicSalary: 50000,
            hra: 10000,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: true,
            higherPfOpted: true,
            employerMatchesHigherPf: false,
            esiApplicable: false,
            ptApplicable: false,
            tdsMonthly: 0
        }, 4, 2026, '2026-04-30');

        assert.equal(calcHigherPfNoMatch.employeeEpf, 6000); // 12% of 50,000 full basic
        assert.equal(calcHigherPfNoMatch.employerEpf, 1800); // Capped at statutory wage ceiling (12% of 15,000)
        assert.equal(calcHigherPfNoMatch.employerEps, 1249.5); // 8.33% of 15,000
        assert.equal(calcHigherPfNoMatch.employerEpfOnly, 550.5);

        // B. Higher employee voluntary PF WITH employer match
        const calcHigherPfWithMatch = payrollService.calculateStatutoryPayroll({
            basicSalary: 50000,
            hra: 10000,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: true,
            higherPfOpted: true,
            employerMatchesHigherPf: true,
            esiApplicable: false,
            ptApplicable: false,
            tdsMonthly: 0
        }, 4, 2026, '2026-04-30');

        assert.equal(calcHigherPfWithMatch.employeeEpf, 6000);
        assert.equal(calcHigherPfWithMatch.employerEpf, 6000); // Matched on full basic
        assert.equal(calcHigherPfWithMatch.employerEps, 1249.5); // EPS remains statutory capped
        assert.equal(calcHigherPfWithMatch.employerEpfOnly, 4750.5); // Remainder 6000 - 1249.50 = 4750.50

        // C. Employee aged >= 58 years (Para 6(a) EPS 1995: 0% to EPS; 100% to EPF)
        const calcSeniorEmployee = payrollService.calculateStatutoryPayroll({
            basicSalary: 20000,
            hra: 5000,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: true,
            esiApplicable: false,
            ptApplicable: false,
            tdsMonthly: 0
        }, 4, 2026, '2026-04-30', null, { employeeAge: 59 });

        assert.equal(calcSeniorEmployee.employerEpf, 1800);
        assert.equal(calcSeniorEmployee.employerEps, 0); // Excluded from EPS
        assert.equal(calcSeniorEmployee.employerEpfOnly, 1800); // 100% goes to EPF

        // D. Missing dateOfBirth emits statutory warning
        const calcMissingDob = payrollService.calculateStatutoryPayroll({
            basicSalary: 20000,
            hra: 0,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: true,
            esiApplicable: false,
            ptApplicable: false,
            tdsMonthly: 0
        }, 4, 2026);
        assert.ok(calcMissingDob.statutoryWarnings.some(w => w.includes('dateOfBirth is missing')));
    });

    await t.test('ESI Contribution Periods, Rule 50 Proviso & PwD Limits (TASK 2)', () => {
        // A. Rule 50 Proviso: Mid-period wage increase beyond ₹21,000 remains covered until period end
        const calcRule50Proviso = payrollService.calculateStatutoryPayroll({
            basicSalary: 20000,
            hra: 4000,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: false,
            esiApplicable: true,
            coveredAtPeriodStart: true, // Employee was covered at start of contribution period (e.g. in April)
            ptApplicable: false,
            tdsMonthly: 0
        }, 6, 2026, '2026-06-30'); // June: Gross = 24,000 (exceeds ₹21,000 ceiling)

        assert.equal(calcRule50Proviso.grossEarnings, 24000);
        assert.equal(calcRule50Proviso.employeeEsi, 180); // 24,000 * 0.75% = 180
        assert.equal(calcRule50Proviso.employerEsi, 780); // 24,000 * 3.25% = 780
        assert.ok(calcRule50Proviso.statutoryNotes.some(n => n.includes('Rule 50 Proviso applied')));

        // B. Person with Disability (PwD) statutory ceiling is ₹25,000
        const calcPwdEligible = payrollService.calculateStatutoryPayroll({
            basicSalary: 18000,
            hra: 5000,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: false,
            esiApplicable: true,
            isPersonWithDisability: true, // PwD limit = 25,000
            ptApplicable: false,
            tdsMonthly: 0
        }, 4, 2026, '2026-04-30'); // Gross = 23,000 (> 21,000 standard ceiling, but <= 25,000 PwD ceiling)

        assert.equal(calcPwdEligible.grossEarnings, 23000);
        assert.equal(calcPwdEligible.employeeEsi, 172.5); // 23,000 * 0.75%
        assert.equal(calcPwdEligible.employerEsi, 747.5); // 23,000 * 3.25%

        // C. Low wage exemption under Rule 52 (gross <= 4,576 -> employee contribution waived)
        const calcLowWage = payrollService.calculateStatutoryPayroll({
            basicSalary: 4000,
            hra: 0,
            conveyance: 0,
            specialAllowance: 0,
            epfApplicable: false,
            esiApplicable: true,
            ptApplicable: false,
            tdsMonthly: 0
        }, 4, 2026, '2026-04-30');

        assert.equal(calcLowWage.grossEarnings, 4000);
        assert.equal(calcLowWage.employeeEsi, 0); // Exempt under Rule 52
        assert.equal(calcLowWage.employerEsi, 130); // 4,000 * 3.25% = 130
        assert.ok(calcLowWage.statutoryNotes.some(n => n.includes('Low wage exemption under Rule 52')));
    });

    await t.test('Salary Disbursement & Changed Payment Date Audit Trail (TASK 1)', async () => {
        const periodWithEntries = await prisma.payrollPeriod.findUnique({
            where: { id: generatedPeriod.id },
            include: { entries: true }
        });

        const entry = periodWithEntries.entries[0];

        // 1. Before payment: payslip shows provisional status
        const initialPayslip = await payrollService.getPayslip(entry.id);
        assert.equal(initialPayslip.statutoryTds.isProvisional, true);
        assert.equal(initialPayslip.paymentDetails.date, null);

        // 2. Disburse salary with payment date in April 2026
        const disburseResult = await payrollService.disbursePayrollEntry({
            payrollEntryId: entry.id,
            paymentDate: '2026-04-05',
            paymentMethod: 'NEFT',
            paymentReference: 'NEFT-20260405-001'
        }, testUser.id);

        assert.equal(disburseResult.entry.status, 'PAID');
        assert.equal(disburseResult.statutoryTds.section, 'Section 392(1)');
        assert.equal(disburseResult.statutoryTds.act, 'Income-tax Act, 2025');
        assert.equal(disburseResult.statutoryTds.status, 'CONFIRMED');

        // 3. Payslip now shows confirmed citation and payment date
        const updatedPayslip = await payrollService.getPayslip(entry.id);
        assert.equal(updatedPayslip.statutoryTds.isProvisional, false);
        assert.equal(updatedPayslip.statutoryTds.section, 'Section 392(1)');
        assert.equal(updatedPayslip.paymentDetails.method, 'NEFT');
        assert.equal(updatedPayslip.paymentDetails.date, '2026-04-05');

        // 4. Verify audit log was recorded
        const log = await prisma.userActivityLog.findFirst({
            where: {
                module: 'PAYROLL',
                action: 'DISBURSE',
                targetType: 'PAYROLL_ENTRY',
                targetId: String(entry.id)
            }
        });
        assert.ok(log, 'Disbursement audit log must exist');
        const desc = (log.metadata && log.metadata.description) || log.targetReference || '';
        assert.ok(desc.includes('Section 392(1)'), 'Log description or reference must cite Section 392(1)');
    });

    await t.test('Maharashtra Professional Tax: Gender Slabs, Exemption Thresholds, February & Annual Limits (TASK 1)', async () => {
        // --- 1. MEN's SCHEDULE ---
        // Men Gross <= 7,500: Exempt (PT = 0)
        const manLow = payrollService.calculateStatutoryPayroll(
            { basicSalary: 7000, ptApplicable: true }, 4, 2026, null, null, { gender: 'MALE' }
        );
        assert.equal(manLow.professionalTax, 0, 'Men with gross <= 7500 must be exempt');
        assert.equal(manLow.ptScheduleApplied, 'MAHARASHTRA_MEN');

        // Men Gross 7,501 to 10,000: 175 per month
        const manMid = payrollService.calculateStatutoryPayroll(
            { basicSalary: 9000, ptApplicable: true }, 4, 2026, null, null, { gender: 'MALE' }
        );
        assert.equal(manMid.professionalTax, 175, 'Men with gross 7501-10000 must pay 175');

        // Men Gross > 10,000: 200/mo in standard months (April)
        const manHighApr = payrollService.calculateStatutoryPayroll(
            { basicSalary: 20000, ptApplicable: true }, 4, 2026, null, null, { gender: 'MALE' }
        );
        assert.equal(manHighApr.professionalTax, 200, 'Men with gross > 10000 must pay 200 in April');

        // Men Gross > 10,000: 300/mo in February (Month 2)
        const manHighFeb = payrollService.calculateStatutoryPayroll(
            { basicSalary: 20000, ptApplicable: true }, 2, 2026, null, null, { gender: 'MALE' }
        );
        assert.equal(manHighFeb.professionalTax, 300, 'Men with gross > 10000 must pay 300 in February');

        // Men annual schedule total: 11 x 200 + 300 = 2,500
        let manAnnualTotal = 0;
        for (let m = 1; m <= 12; m++) {
            const res = payrollService.calculateStatutoryPayroll(
                { basicSalary: 20000, ptApplicable: true }, m, 2026, null, null, { gender: 'MALE' }
            );
            manAnnualTotal += res.professionalTax;
        }
        assert.equal(manAnnualTotal, 2500, 'Men earning > 10,000 must total exactly 2,500 across 12 months');

        // --- 2. WOMEN's SCHEDULE (w.e.f. 01-April-2023 Amendment) ---
        // Women Gross <= 25,000: Exempt (PT = 0) even if > 10,000!
        const womanBelow25k = payrollService.calculateStatutoryPayroll(
            { basicSalary: 22000, ptApplicable: true }, 4, 2026, null, null, { gender: 'FEMALE' }
        );
        assert.equal(womanBelow25k.professionalTax, 0, 'Women with gross <= 25,000 must be exempt');
        assert.equal(womanBelow25k.ptScheduleApplied, 'MAHARASHTRA_WOMEN_2023');

        // Women Gross exactly 25,000: Exempt
        const womanAt25k = payrollService.calculateStatutoryPayroll(
            { basicSalary: 25000, ptApplicable: true }, 4, 2026, null, null, { gender: 'FEMALE' }
        );
        assert.equal(womanAt25k.professionalTax, 0, 'Women with gross exactly 25,000 must be exempt');

        // Women Gross > 25,000: 200/mo in standard months
        const womanAbove25kApr = payrollService.calculateStatutoryPayroll(
            { basicSalary: 35000, ptApplicable: true }, 4, 2026, null, null, { gender: 'FEMALE' }
        );
        assert.equal(womanAbove25kApr.professionalTax, 200, 'Women with gross > 25,000 must pay 200 in April');

        // Women Gross > 25,000: 300 in February
        const womanAbove25kFeb = payrollService.calculateStatutoryPayroll(
            { basicSalary: 35000, ptApplicable: true }, 2, 2026, null, null, { gender: 'FEMALE' }
        );
        assert.equal(womanAbove25kFeb.professionalTax, 300, 'Women with gross > 25,000 must pay 300 in February');

        // Women annual schedule total: 11 x 200 + 300 = 2,500
        let womanAnnualTotal = 0;
        for (let m = 1; m <= 12; m++) {
            const res = payrollService.calculateStatutoryPayroll(
                { basicSalary: 35000, ptApplicable: true }, m, 2026, null, null, { gender: 'FEMALE' }
            );
            womanAnnualTotal += res.professionalTax;
        }
        assert.equal(womanAnnualTotal, 2500, 'Women earning > 25,000 must total exactly 2,500 across 12 months');

        // --- 3. MISSING OR UNVALIDATED GENDER ---
        const missingGender = payrollService.calculateStatutoryPayroll(
            { basicSalary: 15000, ptApplicable: true }, 4, 2026, null, null, {}
        );
        assert.ok(missingGender.statutoryWarnings.some(w => w.includes('gender is missing')),
            'Missing gender must record warning in statutoryWarnings');

        // If requireGender option is set, must throw ValidationError
        assert.throws(() => {
            payrollService.calculateStatutoryPayroll(
                { basicSalary: 15000, ptApplicable: true }, 4, 2026, null, null, { requireGender: true }
            );
        }, /gender is required/);

        // --- 4. ANNUAL STATUTORY CAP ENFORCEMENT ---
        // If YTD PT is already 2,400, February PT (normally 300) must cap at 100 to not exceed 2,500
        const cappedFeb = payrollService.calculateStatutoryPayroll(
            { basicSalary: 30000, ptApplicable: true }, 2, 2026, null, null, {
                gender: 'MALE',
                ytdProfessionalTax: 2400
            }
        );
        assert.equal(cappedFeb.professionalTax, 100, 'PT must be capped so that YTD + monthly <= 2,500');
    });

    await t.test('Actual Salary TDS Calculation Engine: Section 202 Slabs, Section 156 Rebates, Cess, Revisions & Scope (TASK 1-4)', async () => {
        // =========================================================================
        // PART A: AY 2026-27 DEFAULT REGIME (SLAB BANDS, REBATES & MARGINAL RELIEF)
        // (Applies to both FY 2025-26 under amended 1961 Act and TY 2026-27 under 2025 Act)
        // =========================================================================

        // --- 1. SLAB BOUNDARY 1: At ₹4,00,000 (0% band) ---
        // Expected: Slab tax = ₹0, Rebate = ₹0, Net Tax = ₹0
        const b1At = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 475000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 475000 } // 4.75L - 75k std ded = 4.00L taxable
        });
        assert.equal(b1At.taxYear, '2026-27');
        assert.equal(b1At.governingAct, 'Income-tax Act, 2025');
        assert.equal(b1At.computationSection, 'Section 202');
        assert.equal(b1At.standardDeduction, 75000);
        assert.equal(b1At.netTaxableIncome, 400000);
        assert.equal(b1At.grossAnnualTax, 0);
        assert.equal(b1At.netAnnualTax, 0);
        assert.equal(b1At.monthlyTds, 0);

        // --- 2. SLAB BOUNDARY 1: Immediately Above at ₹4,00,100 (5% band) ---
        // Expected: Slab tax = 100 * 5% = ₹5. Resident Rebate = ₹5. Net Tax = ₹0
        const b1Above = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 475100 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 475100 } // 400,100 taxable
        });
        assert.equal(b1Above.netTaxableIncome, 400100);
        assert.equal(b1Above.grossAnnualTax, 5);
        assert.equal(b1Above.section156Rebate, 5);
        assert.equal(b1Above.netAnnualTax, 0);
        assert.equal(b1Above.monthlyTds, 0);

        // --- 3. SLAB BOUNDARY 2: At ₹8,00,000 (5% band top) ---
        // Expected: Slab tax = 4,00,000 * 5% = ₹20,000. Resident Rebate = ₹20,000. Net Tax = ₹0
        const b2At = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 875000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 875000 } // 8.00L taxable
        });
        assert.equal(b2At.netTaxableIncome, 800000);
        assert.equal(b2At.grossAnnualTax, 20000);
        assert.equal(b2At.section156Rebate, 20000);
        assert.equal(b2At.netAnnualTax, 0);

        // --- 4. SLAB BOUNDARY 2: Immediately Above at ₹8,00,100 (10% band) ---
        // Expected: Slab tax = 20,000 + (100 * 10%) = ₹20,010. Resident Rebate = ₹20,010. Net Tax = ₹0
        const b2Above = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 875100 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 875100 } // 800,100 taxable
        });
        assert.equal(b2Above.netTaxableIncome, 800100);
        assert.equal(b2Above.grossAnnualTax, 20010);
        assert.equal(b2Above.section156Rebate, 20010);
        assert.equal(b2Above.netAnnualTax, 0);

        // --- 5. MID-BAND 3: At ₹10,00,000 Taxable Income (AY 2026-27 Statutory Requirement) ---
        // Slabs: 0-4L (0) + 4L-8L (4L * 5% = 20k) + 8L-10L (2L * 10% = 20k) = ₹40,000 gross tax.
        // Resident Individual: Taxable 10L <= 12L threshold -> Full rebate of ₹40,000 -> Net Tax = ₹0!
        const b10LResident = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1075000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', isResident: true, projectedAnnualGross: 1075000 }
        });
        assert.equal(b10LResident.netTaxableIncome, 1000000);
        assert.equal(b10LResident.grossAnnualTax, 40000, 'Slab tax before rebate must be ₹40,000 at ₹10L taxable income');
        assert.equal(b10LResident.section156Rebate, 40000, 'Eligible resident rebate reduces ₹40,000 tax to zero');
        assert.equal(b10LResident.taxAfterRebate, 0);
        assert.equal(b10LResident.cess, 0);
        assert.equal(b10LResident.netAnnualTax, 0);
        assert.equal(b10LResident.monthlyTds, 0);

        // Non-Resident Individual at ₹10,00,000 Taxable Income:
        // Ineligible for rebate: Gross Tax = ₹40,000, Rebate = ₹0, Cess (4%) = ₹1,600, Net Tax = ₹41,600, Monthly TDS = ₹3,467
        const b10LNonResident = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1075000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', isResident: false, projectedAnnualGross: 1075000 }
        });
        assert.equal(b10LNonResident.netTaxableIncome, 1000000);
        assert.equal(b10LNonResident.grossAnnualTax, 40000);
        assert.equal(b10LNonResident.section156Rebate, 0, 'Non-resident is statutorily ineligible for rebate');
        assert.equal(b10LNonResident.cess, 1600);
        assert.equal(b10LNonResident.netAnnualTax, 41600);
        assert.equal(b10LNonResident.monthlyTds, 3467);

        // --- 6. SLAB BOUNDARY 3: At ₹12,00,000 (Rebate Ceiling - 100% Tax Rebated) ---
        // Gross ₹12,75,000 - ₹75k std ded = ₹12,00,000 taxable.
        // Tax: 4L @ 5% (20k) + 4L @ 10% (40k) = ₹60,000 gross tax.
        // Resident Individual: Full rebate of ₹60,000 -> Net Tax = ₹0, Final Liability = ₹0!
        const b12LResident = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1275000 / 12,
            month: 4,
            year: 2026,
            paymentDate: '2026-04-30',
            options: { taxRegime: 'DEFAULT', isResident: true, projectedAnnualGross: 1275000 }
        });
        assert.equal(b12LResident.netTaxableIncome, 1200000);
        assert.equal(b12LResident.grossAnnualTax, 60000, 'Slab tax before rebate must be ₹60,000 at ₹12L taxable income');
        assert.equal(b12LResident.section156Rebate, 60000, 'Resident with taxable <= 12L gets 100% rebate (max 60k)');
        assert.equal(b12LResident.taxAfterRebate, 0);
        assert.equal(b12LResident.cess, 0);
        assert.equal(b12LResident.netAnnualTax, 0);
        assert.equal(b12LResident.monthlyTds, 0);
        assert.equal(b12LResident.provision.section, 'Section 392(1)');

        // Non-Resident Individual at ₹12,00,000 Taxable Income:
        // Ineligible for rebate: Gross Tax = ₹60,000, Rebate = ₹0, Cess (4%) = ₹2,400, Net Tax = ₹62,400, Monthly TDS = ₹5,200
        const b12LNonResident = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1275000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', isResident: false, projectedAnnualGross: 1275000 }
        });
        assert.equal(b12LNonResident.netTaxableIncome, 1200000);
        assert.equal(b12LNonResident.grossAnnualTax, 60000);
        assert.equal(b12LNonResident.section156Rebate, 0);
        assert.equal(b12LNonResident.cess, 2400);
        assert.equal(b12LNonResident.netAnnualTax, 62400);
        assert.equal(b12LNonResident.monthlyTds, 5200);

        // --- 7. MARGINAL RELIEF ON REBATE: At ₹12,10,000 (Excess Income = ₹10,000) ---
        // Gross tax = 60,000 + (10,000 * 15%) = 61,500.
        // Excess over 12L = 10,000.
        // Tax before cess cannot exceed excess income (10,000).
        // Marginal relief = 61,500 - 10,000 = 51,500.
        // Tax after relief = 10,000. Cess (4%) = 400. Net annual tax = 10,400. Monthly TDS = 867.
        const marginalRelief = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1285000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', isResident: true, projectedAnnualGross: 1285000 } // 12,10,000 taxable
        });
        assert.equal(marginalRelief.netTaxableIncome, 1210000);
        assert.equal(marginalRelief.grossAnnualTax, 61500);
        assert.equal(marginalRelief.section156Rebate, 51500, 'Marginal relief caps tax before cess at excess income (10k)');
        assert.equal(marginalRelief.taxAfterRebate, 10000);
        assert.equal(marginalRelief.cess, 400);
        assert.equal(marginalRelief.netAnnualTax, 10400);
        assert.equal(marginalRelief.monthlyTds, 867);

        // Non-Resident at ₹12,10,000 (No Marginal Relief):
        // Gross tax = 61,500, Relief = 0, Cess = 2,460, Net annual tax = 63,960, Monthly TDS = 5,330
        const nonResidentMarginal = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1285000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', isResident: false, projectedAnnualGross: 1285000 }
        });
        assert.equal(nonResidentMarginal.netTaxableIncome, 1210000);
        assert.equal(nonResidentMarginal.grossAnnualTax, 61500);
        assert.equal(nonResidentMarginal.section156Rebate, 0);
        assert.equal(nonResidentMarginal.cess, 2460);
        assert.equal(nonResidentMarginal.netAnnualTax, 63960);
        assert.equal(nonResidentMarginal.monthlyTds, 5330);

        // --- 8. SLAB BOUNDARY 4: At ₹15,00,000 Taxable (Above Rebate Zone) ---
        // Gross Tax: 4L@5% (20k) + 4L@10% (40k) + 3L@15% (45k) = 1,05,000.
        // Rebate = 0. Cess (4%) = 4,200. Net Tax = 1,09,200. Monthly TDS = 9,100.
        const b15L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1575000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 1575000 } // 15L taxable
        });
        assert.equal(b15L.netTaxableIncome, 1500000);
        assert.equal(b15L.grossAnnualTax, 105000);
        assert.equal(b15L.section156Rebate, 0);
        assert.equal(b15L.cess, 4200);
        assert.equal(b15L.netAnnualTax, 109200);
        assert.equal(b15L.monthlyTds, 9100);

        // --- 9. SLAB BOUNDARY 5: At ₹16,00,000 (15% band top) ---
        // Gross Tax: 20k + 40k + 4L@15% (60k) = 1,20,000.
        // Cess (4%) = 4,800. Net = 1,24,800. Monthly TDS = 10,400.
        const b16L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1675000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 1675000 }
        });
        assert.equal(b16L.netTaxableIncome, 1600000);
        assert.equal(b16L.grossAnnualTax, 120000);
        assert.equal(b16L.cess, 4800);
        assert.equal(b16L.netAnnualTax, 124800);
        assert.equal(b16L.monthlyTds, 10400);

        // --- 10. SLAB BOUNDARY 6: At ₹20,00,000 (20% band top) ---
        // Gross Tax: 1,20,000 + 4L@20% (80k) = 2,00,000.
        // Cess = 8,000. Net = 2,08,000. Monthly TDS = 17,333.
        const b20L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 2075000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 2075000 }
        });
        assert.equal(b20L.netTaxableIncome, 2000000);
        assert.equal(b20L.slabBreakdown.find(s => s.upTo === 2000000).taxInBand, 80000);
        assert.equal(b20L.grossAnnualTax, 200000);
        assert.equal(b20L.cess, 8000);
        assert.equal(b20L.netAnnualTax, 208000);
        assert.equal(b20L.monthlyTds, 17333);

        // --- 11. SLAB BOUNDARY 7: At ₹24,00,000 (25% band top) ---
        // Gross Tax: 2,00,000 + 4L@25% (1,00,000) = 3,00,000.
        // Cess = 12,000. Net = 3,12,000. Monthly TDS = 26,000.
        const b24L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 2475000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 2475000 }
        });
        assert.equal(b24L.netTaxableIncome, 2400000);
        assert.equal(b24L.grossAnnualTax, 300000);
        assert.equal(b24L.cess, 12000);
        assert.equal(b24L.netAnnualTax, 312000);
        assert.equal(b24L.monthlyTds, 26000);

        // --- 12. ABOVE ₹24 LAKH: At ₹30,00,000 (30% band) ---
        // Gross Tax: 3,00,000 + 6L@30% (1,80,000) = 4,80,000.
        // Cess = 19,200. Net = 4,99,200. Monthly TDS = 41,600.
        const b30L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 3075000 / 12,
            month: 4,
            year: 2026,
            options: { taxRegime: 'DEFAULT', projectedAnnualGross: 3075000 }
        });
        assert.equal(b30L.netTaxableIncome, 3000000);
        assert.equal(b30L.grossAnnualTax, 480000);
        assert.equal(b30L.cess, 19200);
        assert.equal(b30L.netAnnualTax, 499200);
        assert.equal(b30L.monthlyTds, 41600);

        // --- 13. MID-YEAR SALARY INCREMENT & PRIOR DEDUCTION RECONCILIATION ---
        // In November (5 remaining months), projected annual gross is ₹18,00,000.
        // Std Ded = 75,000 -> Taxable = 17,25,000.
        // Slabs: 0-16L: 1,20,000. 16L-17.25L: 1,25,000 @ 20% = 25,000.
        // Gross Tax = 1,45,000. Cess = 5,800. Net Annual Tax = 1,50,800.
        // Prior TDS deducted in Apr-Oct = ₹70,000.
        // Remaining tax = 1,50,800 - 70,000 = 80,800.
        // Monthly TDS for remaining 5 months = 80,800 / 5 = 16,160.
        const midYearRevision = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 175000,
            month: 11,
            year: 2026,
            paymentDate: '2026-11-30',
            options: {
                taxRegime: 'DEFAULT',
                projectedAnnualGross: 1800000,
                ytdTdsDeducted: 70000,
                remainingMonths: 5
            }
        });
        assert.equal(midYearRevision.netTaxableIncome, 1725000);
        assert.equal(midYearRevision.grossAnnualTax, 145000);
        assert.equal(midYearRevision.cess, 5800);
        assert.equal(midYearRevision.netAnnualTax, 150800);
        assert.equal(midYearRevision.ytdTdsDeducted, 70000);
        assert.equal(midYearRevision.remainingTax, 80800);
        assert.equal(midYearRevision.monthlyTds, 16160);

        // =========================================================================
        // PART B: THREE-PERIOD VERSIONED TAX RULES MATRIX VERIFICATION
        // =========================================================================

        // --- 14. PERIOD 2: FY 2025-26 / AY 2026-27 (INCOME-TAX ACT, 1961 AS AMENDED) ---
        // Rules: Income-tax Act, 1961, Section 115BAC amended slabs (4L/8L/12L/16L/20L/24L),
        // Section 87A amended rebate (₹12L ceiling, max ₹60,000), Withholding: Section 192.
        
        // 14A. Resident Employee with ₹10,00,000 Taxable Income in FY 2025-26:
        // Slab Tax: 4L@5% (20k) + 2L@10% (20k) = ₹40,000 gross tax.
        // Section 87A rebate covers ₹40,000 -> Net Tax = ₹0!
        const fy25Resident10L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1075000 / 12,
            month: 5,
            year: 2025,
            paymentDate: '2025-05-31',
            options: { taxRegime: 'NEW', taxYear: '2025-26', isResident: true, projectedAnnualGross: 1075000 }
        });
        assert.equal(fy25Resident10L.taxYear, '2025-26');
        assert.equal(fy25Resident10L.governingAct, 'Income-tax Act, 1961');
        assert.equal(fy25Resident10L.computationSection, 'Section 115BAC');
        assert.equal(fy25Resident10L.provision.section, 'Section 192');
        assert.equal(fy25Resident10L.netTaxableIncome, 1000000);
        assert.equal(fy25Resident10L.grossAnnualTax, 40000, 'FY 2025-26 uses amended ₹4L/₹8L/₹12L slabs');
        assert.equal(fy25Resident10L.section87aRebate, 40000, 'FY 2025-26 Section 87A rebate covers up to ₹12L');
        assert.equal(fy25Resident10L.netAnnualTax, 0);
        assert.equal(fy25Resident10L.monthlyTds, 0);

        // 14B. Resident Employee with ₹12,00,000 Taxable Income in FY 2025-26:
        // Slab Tax: 4L@5% (20k) + 4L@10% (40k) = ₹60,000 gross tax.
        // Section 87A rebate covers ₹60,000 -> Net Tax = ₹0!
        const fy25Resident12L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1275000 / 12,
            month: 5,
            year: 2025,
            paymentDate: '2025-05-31',
            options: { taxRegime: 'NEW', taxYear: '2025-26', isResident: true, projectedAnnualGross: 1275000 }
        });
        assert.equal(fy25Resident12L.netTaxableIncome, 1200000);
        assert.equal(fy25Resident12L.grossAnnualTax, 60000);
        assert.equal(fy25Resident12L.section87aRebate, 60000);
        assert.equal(fy25Resident12L.netAnnualTax, 0);

        // 14C. Non-Resident with ₹10,00,000 Taxable Income in FY 2025-26:
        // Ineligible for Section 87A rebate: Gross Tax = ₹40,000, Rebate = 0, Cess = ₹1,600, Net = ₹41,600
        const fy25NonResident10L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1075000 / 12,
            month: 5,
            year: 2025,
            paymentDate: '2025-05-31',
            options: { taxRegime: 'NEW', taxYear: '2025-26', isResident: false, projectedAnnualGross: 1075000 }
        });
        assert.equal(fy25NonResident10L.netTaxableIncome, 1000000);
        assert.equal(fy25NonResident10L.grossAnnualTax, 40000);
        assert.equal(fy25NonResident10L.section87aRebate, 0);
        assert.equal(fy25NonResident10L.cess, 1600);
        assert.equal(fy25NonResident10L.netAnnualTax, 41600);

        // 14D. Old Regime in FY 2025-26 with Chapter VI-A Deductions:
        // Gross ₹12,00,000. Std Ded ₹50,000. PT ₹2,400. 80C ₹1,50,000. 80D ₹25,000.
        // Total Deductions = 2,27,400. Taxable = 9,72,600.
        // Slabs: 2.5L@0% + 2.5L@5%(12.5k) + 4.726L@20%(94,520) = 1,07,020.
        // Cess = 4,280.80. Net = 1,11,300.80.
        const fy25OldRegime = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 100000,
            month: 5,
            year: 2025,
            paymentDate: '2025-05-31',
            options: {
                taxRegime: 'OLD',
                taxYear: '2025-26',
                declared80C: 150000,
                declared80D: 25000,
                declaredPtAnnual: 2400
            }
        });
        assert.equal(fy25OldRegime.taxYear, '2025-26');
        assert.equal(fy25OldRegime.standardDeduction, 50000);
        assert.equal(fy25OldRegime.totalDeductions, 227400);
        assert.equal(fy25OldRegime.netTaxableIncome, 972600);
        assert.equal(fy25OldRegime.grossAnnualTax, 107020);
        assert.equal(fy25OldRegime.provision.section, 'Section 192');

        // --- 15. PERIOD 1: HISTORICAL FY 2024-25 / AY 2025-26 (INCOME-TAX ACT, 1961) ---
        // Rules: Income-tax Act, 1961, Section 115BAC slabs (₹3L, ₹7L, ₹10L, ₹12L, ₹15L),
        // Section 87A rebate ceiling ₹7,00,000 (max ₹25,000), Withholding: Section 192.

        // 15A. At Historical Rebate Ceiling: Taxable Income ₹7,00,000:
        // Slabs: 0-3L (0) + 3L-7L (4L @ 5% = 20,000) = ₹20,000. Section 87A Rebate = ₹20,000. Net Tax = ₹0
        const fy24RebateAt7L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 775000 / 12,
            month: 4,
            year: 2024,
            paymentDate: '2024-04-30',
            options: { taxRegime: 'NEW', taxYear: '2024-25', isResident: true, projectedAnnualGross: 775000 }
        });
        assert.equal(fy24RebateAt7L.taxYear, '2024-25');
        assert.equal(fy24RebateAt7L.governingAct, 'Income-tax Act, 1961');
        assert.equal(fy24RebateAt7L.computationSection, 'Section 115BAC');
        assert.equal(fy24RebateAt7L.provision.section, 'Section 192');
        assert.equal(fy24RebateAt7L.netTaxableIncome, 700000);
        assert.equal(fy24RebateAt7L.grossAnnualTax, 20000);
        assert.equal(fy24RebateAt7L.section87aRebate, 20000);
        assert.equal(fy24RebateAt7L.netAnnualTax, 0);

        // 15B. Above Historical Rebate Ceiling: Taxable Income ₹10,00,000:
        // Slabs: 3L@0% + 4L@5%(20k) + 3L@10%(30k) = ₹50,000. Rebate = ₹0 (taxable > 7L).
        // Cess (4%) = ₹2,000. Net Annual Tax = ₹52,000.
        const fy24Above7L = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 1075000 / 12,
            month: 4,
            year: 2024,
            paymentDate: '2024-04-30',
            options: { taxRegime: 'NEW', taxYear: '2024-25', isResident: true, projectedAnnualGross: 1075000 }
        });
        assert.equal(fy24Above7L.taxYear, '2024-25');
        assert.equal(fy24Above7L.netTaxableIncome, 1000000);
        assert.equal(fy24Above7L.grossAnnualTax, 50000);
        assert.equal(fy24Above7L.section87aRebate, 0, 'In FY 2024-25, Section 87A rebate ceases above ₹7L');
        assert.equal(fy24Above7L.cess, 2000);
        assert.equal(fy24Above7L.netAnnualTax, 52000);

        // 15C. Historical ₹71,500 Test Case (Properly Verified Under FY 2024-25):
        // Gross ₹12,00,000. Std Ded ₹75,000 -> Taxable ₹11,25,000.
        // Slabs: 3L@0% + 4L@5%(20k) + 3L@10%(30k) + 1.25L@15%(18,750) = ₹68,750.
        // Cess (4%) = ₹2,750. Net Annual Tax = ₹71,500. Monthly TDS = ₹5,958.
        const fy24Historical71500 = payrollService.calculateSalaryTds({
            grossMonthlyEarnings: 100000,
            month: 4,
            year: 2024,
            paymentDate: '2024-04-30',
            options: { taxRegime: 'NEW', taxYear: '2024-25' }
        });
        assert.equal(fy24Historical71500.taxYear, '2024-25');
        assert.equal(fy24Historical71500.governingAct, 'Income-tax Act, 1961');
        assert.equal(fy24Historical71500.computationSection, 'Section 115BAC');
        assert.equal(fy24Historical71500.provision.section, 'Section 192');
        assert.equal(fy24Historical71500.netTaxableIncome, 1125000);
        assert.equal(fy24Historical71500.grossAnnualTax, 68750);
        assert.equal(fy24Historical71500.cess, 2750);
        assert.equal(fy24Historical71500.netAnnualTax, 71500, 'Historical ₹71,500 tax belongs strictly to FY 2024-25 rules');
        assert.equal(fy24Historical71500.monthlyTds, 5958);

        // =========================================================================
        // PART C: SCOPE TRANSPARENCY & INPUT VALIDATIONS
        // =========================================================================

        assert.ok(b12LResident.statutoryScopeLimitation.includes('Salary TDS engine estimates progressive withholding'));
        assert.ok(b12LResident.statutoryCitation.includes('Section 202, Income-tax Act, 2025'));

        assert.throws(() => {
            payrollService.calculateSalaryTds({
                grossMonthlyEarnings: 50000,
                month: 4,
                year: 2026,
                options: { taxRegime: 'INVALID_REGIME' }
            });
        }, /Unsupported tax regime/);

        assert.throws(() => {
            payrollService.calculateSalaryTds({
                grossMonthlyEarnings: 50000,
                month: 4,
                year: 2026,
                options: { taxYear: 'INVALID_YEAR' }
            });
        }, /Unsupported tax year/);

        assert.throws(() => {
            payrollService.calculateSalaryTds({
                grossMonthlyEarnings: -100,
                month: 4,
                year: 2026
            });
        }, /cannot be negative/);
    });

    await t.test('EPF Membership & ESI Contribution Period Edge Cases (TASK 3)', async () => {
        // --- 1. EPF: Excluded Employee under Para 2(f) ---
        const excludedEmpCalc = payrollService.calculateStatutoryPayroll(
            { basicSalary: 25000, epfApplicable: true }, 4, 2026, null, null, { isExcludedEmployee: true }
        );
        assert.equal(excludedEmpCalc.employeeEpf, 0, 'Excluded employee must have 0 EPF');
        assert.equal(excludedEmpCalc.employerEpf, 0, 'Excluded employee must have 0 employer EPF');
        assert.ok(excludedEmpCalc.statutoryNotes.some(n => n.includes('Excluded Employee')));

        // --- 2. EPF: International Worker (No Wage Ceiling) ---
        const iwCalc = payrollService.calculateStatutoryPayroll(
            { basicSalary: 50000, epfApplicable: true }, 4, 2026, null, null, { isInternationalWorker: true }
        );
        // Full 12% on 50,000 = 6,000
        assert.equal(iwCalc.employeeEpf, 6000, 'International worker contributes on full basic without 15k ceiling');
        assert.equal(iwCalc.employerEpf, 6000);
        assert.ok(iwCalc.statutoryNotes.some(n => n.includes('International Worker')));

        // --- 3. ESI: Rule 50 Proviso across Contribution Period ---
        // Salary was 20,000 in April (eligible). In June, salary raised to 24,000 (exceeds 21,000).
        // Since covered at period start, employee remains covered throughout April-September period.
        const rule50MidPeriod = payrollService.calculateStatutoryPayroll(
            { basicSalary: 24000, esiApplicable: true }, 6, 2026, null, null, { coveredAtPeriodStart: true }
        );
        assert.equal(rule50MidPeriod.employeeEsi, 180, '0.75% of 24,000 = 180');
        assert.equal(rule50MidPeriod.employerEsi, 780, '3.25% of 24,000 = 780');
        assert.ok(rule50MidPeriod.statutoryNotes.some(n => n.includes('Rule 50 Proviso applied')));

        // If not covered at period start, gross 24,000 is exempt
        const notCoveredCalc = payrollService.calculateStatutoryPayroll(
            { basicSalary: 24000, esiApplicable: true }, 6, 2026, null, null, { coveredAtPeriodStart: false }
        );
        assert.equal(notCoveredCalc.employeeEsi, 0);
        assert.equal(notCoveredCalc.employerEsi, 0);
    });

    await prisma.$disconnect();
});


