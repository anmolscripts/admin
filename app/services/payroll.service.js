'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const journalService = require('./journal.service');
const { ensureSystemAccounts } = require('./chartOfAccounts.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');

/**
 * -------------------------------------------------------------
 * 1. EMPLOYEE MASTER
 * -------------------------------------------------------------
 */
async function createEmployee(data = {}, userId) {
    const employeeCode = (data.employeeCode || '').trim().toUpperCase();
    if (!employeeCode) throw new ValidationError('Employee code is required.');

    const firstName = (data.firstName || '').trim();
    const lastName = (data.lastName || '').trim();
    if (!firstName || !lastName) throw new ValidationError('Employee first and last name are required.');

    const email = (data.email || '').trim().toLowerCase();
    if (!email) throw new ValidationError('Employee email is required.');

    if (!data.dateOfJoining) throw new ValidationError('Date of joining is required.');
    const dateOfJoining = new Date(data.dateOfJoining);
    if (isNaN(dateOfJoining.getTime())) throw new ValidationError('Invalid date of joining.');

    const existingCode = await prisma.employee.findUnique({ where: { employeeCode } });
    if (existingCode) throw new ConflictError(`Employee code "${employeeCode}" already exists.`);

    const existingEmail = await prisma.employee.findUnique({ where: { email } });
    if (existingEmail) throw new ConflictError(`Employee email "${email}" already exists.`);

    const employee = await prisma.employee.create({
        data: {
            employeeCode,
            firstName,
            lastName,
            email,
            phone: data.phone ? String(data.phone).trim() : null,
            department: data.department ? String(data.department).trim() : 'General',
            designation: data.designation ? String(data.designation).trim() : 'Staff',
            dateOfJoining,
            panNumber: data.panNumber ? String(data.panNumber).trim().toUpperCase() : null,
            uanNumber: data.uanNumber ? String(data.uanNumber).trim() : null,
            bankAccountNumber: data.bankAccountNumber ? String(data.bankAccountNumber).trim() : null,
            bankIfsc: data.bankIfsc ? String(data.bankIfsc).trim().toUpperCase() : null,
            bankName: data.bankName ? String(data.bankName).trim() : null,
            status: data.status || 'ACTIVE',
            createdById: userId
        }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'CREATE',
            module: 'PAYROLL',
            targetType: 'EMPLOYEE',
            targetId: employee.id,
            description: `Created employee record ${employee.employeeCode} (${employee.firstName} ${employee.lastName})`
        });
    }

    return employee;
}

async function getEmployeeById(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid employee ID.');

    const emp = await prisma.employee.findUnique({
        where: { id: numId },
        include: {
            salaryStructures: { orderBy: { effectiveFrom: 'desc' } },
            createdBy: { select: { id: true, name: true, email: true } }
        }
    });
    if (!emp) throw new NotFoundError(`Employee with ID ${numId} not found.`);
    return emp;
}

async function listEmployees({ department, status, search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (department) where.department = department;
    if (status) where.status = status;
    if (search) {
        where.OR = [
            { employeeCode: { contains: search } },
            { firstName: { contains: search } },
            { lastName: { contains: search } },
            { email: { contains: search } }
        ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.employee.count({ where }),
        prisma.employee.findMany({
            where,
            include: { salaryStructures: { orderBy: { effectiveFrom: 'desc' }, take: 1 } },
            orderBy: { employeeCode: 'asc' },
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

/**
 * -------------------------------------------------------------
 * 2. SALARY STRUCTURE
 * -------------------------------------------------------------
 */
async function setSalaryStructure(employeeIdInput, data = {}, userId) {
    const employeeId = parseInt(employeeIdInput, 10);
    if (isNaN(employeeId) || employeeId <= 0) throw new ValidationError('Invalid employee ID.');

    const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp) throw new NotFoundError(`Employee with ID ${employeeId} not found.`);

    if (!data.effectiveFrom) throw new ValidationError('Effective from date is required.');
    const effectiveFrom = new Date(data.effectiveFrom);
    if (isNaN(effectiveFrom.getTime())) throw new ValidationError('Invalid effective date.');

    const basicSalary = Math.round(Math.max(0, parseFloat(data.basicSalary) || 0) * 100) / 100;
    if (basicSalary <= 0) throw new ValidationError('Basic salary must be greater than 0.');

    const hra = Math.round(Math.max(0, parseFloat(data.hra) || 0) * 100) / 100;
    const conveyance = Math.round(Math.max(0, parseFloat(data.conveyance) || 0) * 100) / 100;
    const specialAllowance = Math.round(Math.max(0, parseFloat(data.specialAllowance) || 0) * 100) / 100;
    const tdsMonthly = Math.round(Math.max(0, parseFloat(data.tdsMonthly) || 0) * 100) / 100;

    const epfApplicable = data.epfApplicable !== undefined ? Boolean(data.epfApplicable) : true;
    const esiApplicable = data.esiApplicable !== undefined ? Boolean(data.esiApplicable) : false;
    const ptApplicable = data.ptApplicable !== undefined ? Boolean(data.ptApplicable) : true;

    const structure = await prisma.salaryStructure.create({
        data: {
            employeeId,
            effectiveFrom,
            basicSalary,
            hra,
            conveyance,
            specialAllowance,
            epfApplicable,
            esiApplicable,
            ptApplicable,
            tdsMonthly,
            createdById: userId
        }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'CREATE',
            module: 'PAYROLL',
            targetType: 'SALARY_STRUCTURE',
            targetId: structure.id,
            description: `Configured salary structure for ${emp.employeeCode} effective from ${effectiveFrom.toISOString().slice(0, 10)}`
        });
    }

    return structure;
}

async function getActiveSalaryStructure(employeeId, asOfDate = new Date()) {
    return prisma.salaryStructure.findFirst({
        where: {
            employeeId,
            effectiveFrom: { lte: asOfDate }
        },
        orderBy: { effectiveFrom: 'desc' }
    });
}

/**
 * -------------------------------------------------------------
 * 3. STATUTORY CALCULATION ENGINE & CONFIGURABLE RULES
 * -------------------------------------------------------------
 * Rules & Authoritative Citations:
 * - EPF: Employees' Provident Funds and Miscellaneous Provisions Act, 1952.
 *   Statutory wage ceiling: ₹15,000/mo (amended w.e.f. 01-Sep-2014).
 *   Mandatory 12% employee contribution on eligible wage (capped at ₹1,800/mo).
 *   Voluntary higher employee contribution (VPF) on full basic does not mandate employer match.
 *   Employer 12% is legally apportioned into:
 *     * Employees' Pension Scheme (EPS 1995): 8.33% of eligible wage (max ₹1,250/mo). Ceases at age 58.
 *     * Employees' Provident Fund (EPF Scheme 1952): 3.67% of eligible wage (min ₹550/mo), or 100% if age >= 58.
 * - ESI: Employees' State Insurance Act, 1948 & Rule 50, ESI (Central) Rules, 1950.
 *   Statutory eligibility wage threshold: Gross <= ₹21,000/mo (₹25,000 for Persons with Disabilities).
 *   Rule 50 Proviso: If an employee's wage exceeds ceiling after the start of a contribution period,
 *   coverage continues until the expiration of that contribution period (Apr-Sep or Oct-Mar).
 *   Employee contribution: 0.75% of gross earnings (exempt if daily average wage <= ₹176).
 *   Employer contribution: 3.25% of gross earnings.
 * - PT: Maharashtra State Tax on Professions, Trades, Callings and Employments Act, 1975.
 *   Gross <= ₹7,500: Nil.
 *   Gross ₹7,501 - ₹10,000: ₹175/mo.
 *   Gross > ₹10,000: ₹200/mo (Months 1, 3-12), ₹300 in February (Month 2).
 * - TDS on Salary Statutory Transition:
 *   * Income Tax Department transition guidance: salary TDS is chargeable strictly on payment date basis.
 *   * Salary paid on or before 31 March 2026: Section 192 of the Income-tax Act, 1961.
 *   * Salary paid on or after 1 April 2026: Section 392(1) of the Income-tax Act, 2025.
 *   * Pending / unpaid payroll runs are assigned provisional status until disbursement.
 */
const STATUTORY_RULES = {
    epf: {
        effectiveDate: '2014-09-01',
        wageCeiling: 15000,
        employeeRate: 0.12,
        employerRateTotal: 0.12,
        epsRate: 0.0833,
        epsMaxMonthly: 1250,
        epsAgeLimit: 58,
        authority: 'Employees\' Provident Funds and Miscellaneous Provisions Act, 1952'
    },
    esi: {
        effectiveDate: '2017-01-01',
        standardWageCeiling: 21000,
        pwdWageCeiling: 25000,
        employeeRate: 0.0075,
        employerRate: 0.0325,
        dailyWageExemptionLimit: 176,
        monthlyExemptionThreshold: 4576,
        authority: 'Employees\' State Insurance Act, 1948 & Rule 50, ESI (Central) Rules, 1950'
    },
    pt: {
        state: 'MAHARASHTRA',
        authority: 'Maharashtra State Tax on Professions, Trades, Callings and Employments Act, 1975 (as amended by Act VIII of 2023)',
        maxAnnualLimit: 2500,
        menExemptionLimit: 7500,
        menMidSlabLimit: 10000,
        menMidSlabAmount: 175,
        womenExemptionLimit: 25000,
        womenAmendmentEffectiveDate: '2023-04-01',
        standardMonthlyAmount: 200,
        februaryMonthlyAmount: 300
    },
    tds: {
        transitionCutoffDate: '2026-04-01',
        withholdingProvisions: {
            prior: {
                act: 'Income-tax Act, 1961',
                section: 'Section 192',
                authority: 'Section 192, Income-tax Act, 1961 (Salaries paid on or before 31 March 2026)'
            },
            current: {
                act: 'Income-tax Act, 2025',
                section: 'Section 392(1)',
                authority: 'Section 392(1), Income-tax Act, 2025 (Salaries paid on or after 1 April 2026)'
            }
        },
        taxYears: {
            '2026-27': {
                taxYear: '2026-27',
                governingAct: 'Income-tax Act, 2025',
                defaultRegimeSection: 'Section 202',
                optionalRegimeSection: 'Section 202(4)',
                rebateSection: 'Section 156',
                cessRate: 0.04,
                regimes: {
                    DEFAULT: {
                        name: 'DEFAULT',
                        section: 'Section 202',
                        act: 'Income-tax Act, 2025',
                        standardDeduction: 75000,
                        slabs: [
                            { upTo: 400000, rate: 0.00, label: 'Up to ₹4,00,000' },
                            { upTo: 800000, rate: 0.05, label: '₹4,00,001–₹8,00,000' },
                            { upTo: 1200000, rate: 0.10, label: '₹8,00,001–₹12,00,000' },
                            { upTo: 1600000, rate: 0.15, label: '₹12,00,001–₹16,00,000' },
                            { upTo: 2000000, rate: 0.20, label: '₹16,00,001–₹20,00,000' },
                            { upTo: 2400000, rate: 0.25, label: '₹20,00,001–₹24,00,000' },
                            { upTo: Infinity, rate: 0.30, label: 'Above ₹24,00,000' }
                        ],
                        rebate: {
                            section: 'Section 156',
                            residentOnly: true,
                            threshold: 1200000,
                            maxRebate: 60000,
                            hasMarginalRelief: true
                        },
                        surcharge: [
                            { threshold: 5000000, rate: 0.10 },
                            { threshold: 10000000, rate: 0.15 },
                            { threshold: 20000000, rate: 0.25 }
                        ],
                        allowChapterVia: false
                    },
                    OPTIONAL: {
                        name: 'OPTIONAL',
                        section: 'Section 202(4)',
                        act: 'Income-tax Act, 2025',
                        standardDeduction: 50000,
                        slabs: [
                            { upTo: 250000, rate: 0.00, label: 'Up to ₹2,50,000' },
                            { upTo: 500000, rate: 0.05, label: '₹2,50,001–₹5,00,000' },
                            { upTo: 1000000, rate: 0.20, label: '₹5,00,001–₹10,00,000' },
                            { upTo: Infinity, rate: 0.30, label: 'Above ₹10,00,000' }
                        ],
                        rebate: {
                            section: 'Section 156',
                            residentOnly: true,
                            threshold: 500000,
                            maxRebate: 12500,
                            hasMarginalRelief: false
                        },
                        surcharge: [
                            { threshold: 5000000, rate: 0.10 },
                            { threshold: 10000000, rate: 0.15 },
                            { threshold: 20000000, rate: 0.25 },
                            { threshold: 50000000, rate: 0.37 }
                        ],
                        allowChapterVia: true
                    }
                }
            },
            '2025-26': {
                taxYear: '2025-26',
                governingAct: 'Income-tax Act, 1961',
                defaultRegimeSection: 'Section 115BAC',
                optionalRegimeSection: 'Normal Provisions',
                rebateSection: 'Section 87A',
                cessRate: 0.04,
                regimes: {
                    DEFAULT: {
                        name: 'NEW',
                        section: 'Section 115BAC',
                        act: 'Income-tax Act, 1961',
                        standardDeduction: 75000,
                        slabs: [
                            { upTo: 300000, rate: 0.00, label: 'Up to ₹3,00,000' },
                            { upTo: 700000, rate: 0.05, label: '₹3,00,001–₹7,00,000' },
                            { upTo: 1000000, rate: 0.10, label: '₹7,00,001–₹10,00,000' },
                            { upTo: 1200000, rate: 0.15, label: '₹10,00,001–₹12,00,000' },
                            { upTo: 1500000, rate: 0.20, label: '₹12,00,001–₹15,00,000' },
                            { upTo: Infinity, rate: 0.30, label: 'Above ₹15,00,000' }
                        ],
                        rebate: {
                            section: 'Section 87A',
                            residentOnly: true,
                            threshold: 700000,
                            maxRebate: 25000,
                            hasMarginalRelief: true
                        },
                        surcharge: [
                            { threshold: 5000000, rate: 0.10 },
                            { threshold: 10000000, rate: 0.15 },
                            { threshold: 20000000, rate: 0.25 }
                        ],
                        allowChapterVia: false
                    },
                    OPTIONAL: {
                        name: 'OLD',
                        section: 'Normal Provisions',
                        act: 'Income-tax Act, 1961',
                        standardDeduction: 50000,
                        slabs: [
                            { upTo: 250000, rate: 0.00, label: 'Up to ₹2,50,000' },
                            { upTo: 500000, rate: 0.05, label: '₹2,50,001–₹5,00,000' },
                            { upTo: 1000000, rate: 0.20, label: '₹5,00,001–₹10,00,000' },
                            { upTo: Infinity, rate: 0.30, label: 'Above ₹10,00,000' }
                        ],
                        rebate: {
                            section: 'Section 87A',
                            residentOnly: true,
                            threshold: 500000,
                            maxRebate: 12500,
                            hasMarginalRelief: false
                        },
                        surcharge: [
                            { threshold: 5000000, rate: 0.10 },
                            { threshold: 10000000, rate: 0.15 },
                            { threshold: 20000000, rate: 0.25 },
                            { threshold: 50000000, rate: 0.37 }
                        ],
                        allowChapterVia: true
                    }
                }
            }
        }
    }
};

/**
 * Resolves the statutory Tax Year from explicit options, payment date, or payroll pay period.
 */
function resolveTaxYear({ taxYear, paymentDate, month, year }) {
    if (taxYear && typeof taxYear === 'string') {
        const clean = taxYear.trim();
        if (clean === '2026-27' || clean === '2025-26') return clean;
        if (clean === '2026') return '2026-27';
        if (clean === '2025') return '2025-26';
        throw new ValidationError(`Unsupported tax year "${taxYear}". Supported tax years: "2026-27", "2025-26".`);
    }

    if (paymentDate !== null && paymentDate !== undefined && paymentDate !== '') {
        const parsed = (paymentDate instanceof Date) ? paymentDate : new Date(paymentDate);
        if (!isNaN(parsed.getTime())) {
            const dateStr = parsed.toISOString().slice(0, 10);
            return (dateStr >= '2026-04-01') ? '2026-27' : '2025-26';
        }
    }

    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (!isNaN(m) && !isNaN(y)) {
        if (y > 2026 || (y === 2026 && m >= 4)) {
            return '2026-27';
        }
        return '2025-26';
    }

    return '2026-27';
}

/**
 * Calculates progressive tax across statutory marginal bands with breakdown.
 */
function calculateProgressiveSlabs(taxableIncome, slabs) {
    if (taxableIncome <= 0) {
        return {
            grossTax: 0,
            breakdown: slabs.map(s => ({
                upTo: s.upTo,
                rate: s.rate,
                label: s.label,
                taxableInBand: 0,
                taxInBand: 0
            }))
        };
    }

    let grossTax = 0;
    let lowerBound = 0;
    const breakdown = [];

    for (const slab of slabs) {
        let taxableInBand = 0;
        let taxInBand = 0;

        if (taxableIncome > lowerBound) {
            taxableInBand = Math.min(taxableIncome, slab.upTo) - lowerBound;
            if (taxableInBand > 0 && slab.rate > 0) {
                taxInBand = Math.round(taxableInBand * slab.rate * 100) / 100;
                grossTax += taxInBand;
            }
            lowerBound = slab.upTo;
        }

        breakdown.push({
            upTo: slab.upTo,
            rate: slab.rate,
            label: slab.label,
            taxableInBand,
            taxInBand
        });

        if (taxableIncome <= slab.upTo) {
            for (let i = breakdown.length; i < slabs.length; i++) {
                breakdown.push({
                    upTo: slabs[i].upTo,
                    rate: slabs[i].rate,
                    label: slabs[i].label,
                    taxableInBand: 0,
                    taxInBand: 0
                });
            }
            break;
        }
    }

    return {
        grossTax: Math.round(grossTax * 100) / 100,
        breakdown
    };
}

/**
 * Server-authoritative progressive Income-tax TDS calculation for salaried employees.
 *
 * Separates:
 * 1. Statutory Withholding Provision at Disbursement:
 *    - On/before 31 March 2026: Section 192, Income-tax Act, 1961.
 *    - On/after 1 April 2026: Section 392(1), Income-tax Act, 2025.
 * 2. Tax Year Computation Rules:
 *    - Tax Year 2026–27: Section 202 (Default) / Section 202(4) (Optional), Income-tax Act, 2025.
 *      Default slabs: 0–4L (Nil), 4L–8L (5%), 8L–12L (10%), 12L–16L (15%), 16L–20L (20%), 20L–24L (25%), >24L (30%).
 *      Rebate u/s 156: ₹60,000 for taxable income <= ₹12,00,000 with marginal relief.
 *    - Tax Year 2025–26 (Historical): Section 115BAC / Section 87A, Income-tax Act, 1961.
 *      Slabs: 0–3L (Nil), 3L–7L (5%), 7L–10L (10%), 10L–12L (15%), 12L–15L (20%), >15L (30%).
 *      Rebate u/s 87A: ₹25,000 for taxable income <= ₹7,00,000 with marginal relief.
 */
function calculateSalaryTds({
    grossMonthlyEarnings,
    month,
    year,
    paymentDate = null,
    structure = {},
    options = {}
}) {
    const rawGross = parseFloat(grossMonthlyEarnings);
    if (!isNaN(rawGross) && rawGross < 0) {
        throw new ValidationError('Gross monthly earnings cannot be negative.');
    }
    if (options.ytdGrossEarnings !== undefined && parseFloat(options.ytdGrossEarnings) < 0) {
        throw new ValidationError('YTD gross earnings cannot be negative.');
    }
    if (options.projectedAnnualGross !== undefined && parseFloat(options.projectedAnnualGross) < 0) {
        throw new ValidationError('Projected annual gross earnings cannot be negative.');
    }

    const rawRegime = (options.taxRegime || structure.taxRegime || 'DEFAULT').toString().trim().toUpperCase();
    let regimeKey = 'DEFAULT';
    if (['DEFAULT', 'NEW'].includes(rawRegime)) {
        regimeKey = 'DEFAULT';
    } else if (['OPTIONAL', 'OLD'].includes(rawRegime)) {
        regimeKey = 'OPTIONAL';
    } else {
        throw new ValidationError(`Unsupported tax regime "${rawRegime}". Supported regimes: DEFAULT (or NEW), OPTIONAL (or OLD).`);
    }

    const taxYear = resolveTaxYear({
        taxYear: options.taxYear,
        paymentDate,
        month,
        year
    });

    const taxYearConfig = STATUTORY_RULES.tds.taxYears[taxYear];
    if (!taxYearConfig) {
        throw new ValidationError(`Statutory tax configuration for Tax Year "${taxYear}" not found.`);
    }

    const regimeConfig = taxYearConfig.regimes[regimeKey];
    const tdsProvision = resolveStatutoryTdsProvision(paymentDate, month, year);

    if (options.useManualTdsOverride === true && structure.tdsMonthly !== undefined) {
        const manualTds = Math.round(Math.max(0, parseFloat(structure.tdsMonthly) || 0) * 100) / 100;
        return {
            method: 'MANUAL_OVERRIDE',
            taxYear,
            governingAct: taxYearConfig.governingAct,
            regime: regimeConfig.name,
            regimeKey,
            computationSection: regimeConfig.section,
            monthlyTds: manualTds,
            provision: tdsProvision,
            isEstimated: false,
            statutoryScopeLimitation: 'Manual employer TDS override applied. Bypassed dynamic progressive tax estimation.'
        };
    }

    const grossMonthly = Math.round(Math.max(0, rawGross || 0) * 100) / 100;
    const monthNum = parseInt(month, 10);
    const remainingMonths = options.remainingMonths !== undefined
        ? Math.max(1, parseInt(options.remainingMonths, 10))
        : (!isNaN(monthNum) && monthNum >= 4 ? 16 - monthNum : (!isNaN(monthNum) ? 4 - monthNum : 12));

    let estimatedAnnualGross = 0;
    if (options.projectedAnnualGross !== undefined) {
        estimatedAnnualGross = Math.max(0, parseFloat(options.projectedAnnualGross) || 0);
    } else if (options.ytdGrossEarnings !== undefined) {
        const ytd = Math.max(0, parseFloat(options.ytdGrossEarnings) || 0);
        estimatedAnnualGross = Math.round((ytd + (grossMonthly * remainingMonths)) * 100) / 100;
    } else {
        estimatedAnnualGross = Math.round(grossMonthly * 12 * 100) / 100;
    }

    if (estimatedAnnualGross < 0) {
        throw new ValidationError('Estimated annual gross income cannot be negative.');
    }

    let standardDeduction = 0;
    let declaredChapterViaDeductions = 0;
    let ptDeduction = 0;

    if (regimeKey === 'DEFAULT') {
        standardDeduction = Math.min(estimatedAnnualGross, regimeConfig.standardDeduction || 75000);
        const npsEmployer = Math.max(0, parseFloat(options.declaredNpsEmployer || 0));
        declaredChapterViaDeductions = npsEmployer;
    } else {
        standardDeduction = Math.min(estimatedAnnualGross, regimeConfig.standardDeduction || 50000);
        ptDeduction = Math.min(2500, Math.max(0, parseFloat(options.declaredPtAnnual || 2400)));

        const dec80c = Math.min(150000, Math.max(0, parseFloat(options.declared80C || 0)));
        const dec80d = Math.min(50000, Math.max(0, parseFloat(options.declared80D || 0)));
        const decNps = Math.min(50000, Math.max(0, parseFloat(options.declared80CCD1B || 0)));
        declaredChapterViaDeductions = dec80c + dec80d + decNps;
    }

    const totalDeductions = standardDeduction + declaredChapterViaDeductions + ptDeduction;
    const netTaxableIncome = Math.max(0, Math.round((estimatedAnnualGross - totalDeductions) * 100) / 100);

    const slabResult = calculateProgressiveSlabs(netTaxableIncome, regimeConfig.slabs);
    const grossAnnualTax = slabResult.grossTax;

    let rebate = 0;
    const isResident = options.isResident !== false && structure.isResident !== false;

    if (isResident && regimeConfig.rebate) {
        const rebateCfg = regimeConfig.rebate;
        if (netTaxableIncome <= rebateCfg.threshold) {
            rebate = Math.min(grossAnnualTax, rebateCfg.maxRebate);
        } else if (rebateCfg.hasMarginalRelief) {
            const excessIncome = netTaxableIncome - rebateCfg.threshold;
            if (grossAnnualTax > excessIncome) {
                const taxPayableUnderRelief = excessIncome;
                rebate = Math.max(0, grossAnnualTax - taxPayableUnderRelief);
            }
        }
    }

    rebate = Math.round(rebate * 100) / 100;
    const taxAfterRebate = Math.max(0, grossAnnualTax - rebate);

    let surcharge = 0;
    if (regimeConfig.surcharge && regimeConfig.surcharge.length > 0 && taxAfterRebate > 0) {
        let applicableRate = 0;
        let applicableThreshold = 0;
        for (let i = regimeConfig.surcharge.length - 1; i >= 0; i--) {
            if (netTaxableIncome > regimeConfig.surcharge[i].threshold) {
                applicableRate = regimeConfig.surcharge[i].rate;
                applicableThreshold = regimeConfig.surcharge[i].threshold;
                break;
            }
        }
        if (applicableRate > 0) {
            surcharge = Math.round(taxAfterRebate * applicableRate * 100) / 100;
            const taxAtThreshold = calculateProgressiveSlabs(applicableThreshold, regimeConfig.slabs).grossTax;
            const maxTotalAllowed = taxAtThreshold + (netTaxableIncome - applicableThreshold);
            if (taxAfterRebate + surcharge > maxTotalAllowed) {
                surcharge = Math.max(0, Math.round((maxTotalAllowed - taxAfterRebate) * 100) / 100);
            }
        }
    }

    const cessRate = taxYearConfig.cessRate || 0.04;
    const cess = Math.round((taxAfterRebate + surcharge) * cessRate * 100) / 100;
    const netAnnualTax = Math.round((taxAfterRebate + surcharge + cess) * 100) / 100;

    const ytdTdsDeducted = Math.max(0, parseFloat(options.ytdTdsDeducted || 0));
    const remainingTax = Math.max(0, netAnnualTax - ytdTdsDeducted);
    const monthlyTds = Math.round(remainingTax / remainingMonths);

    return {
        method: 'STATUTORY_ESTIMATE',
        taxYear,
        governingAct: taxYearConfig.governingAct,
        regime: regimeConfig.name,
        regimeKey,
        computationSection: regimeConfig.section,
        rebateSection: regimeConfig.rebate.section,
        provision: tdsProvision,
        estimatedAnnualGross,
        standardDeduction,
        declaredChapterViaDeductions,
        ptDeduction,
        totalDeductions,
        netTaxableIncome,
        grossAnnualTax,
        slabBreakdown: slabResult.breakdown,
        section156Rebate: taxYear === '2026-27' ? rebate : 0,
        section87aRebate: taxYear === '2025-26' ? rebate : 0,
        rebateAmount: rebate,
        taxAfterRebate,
        surcharge,
        cess,
        netAnnualTax,
        ytdTdsDeducted,
        remainingMonths,
        remainingTax,
        monthlyTds,
        isResident,
        isEstimated: true,
        statutoryCitation: `${regimeConfig.section}, ${taxYearConfig.governingAct} (Tax Year ${taxYear}) [Withholding: ${tdsProvision.section}]`,
        statutoryScopeLimitation: 'Salary TDS engine estimates progressive withholding for payroll operations under Section 202 / Section 392(1) (Income-tax Act, 2025) or Section 115BAC / Section 192 (Income-tax Act, 1961). It incorporates Standard Deduction (₹75k Default / ₹50k Optional), declared deductions, Section 156/87A rebates with marginal relief, surcharge, and 4% Cess. Dynamic payroll estimation does not constitute statutory annual tax filing (Form 16/Form 24Q/Form 12BB), nor does it account for external non-salary income unless explicitly declared.'
    };
}

function resolveStatutoryTdsProvision(paymentDateOrMonth = null, monthOrYear = null, maybeYear = null) {
    let paymentDate = null;
    let month = null;
    let year = null;

    if (paymentDateOrMonth && typeof paymentDateOrMonth === 'object' && !(paymentDateOrMonth instanceof Date)) {
        paymentDate = paymentDateOrMonth.paymentDate || null;
        month = paymentDateOrMonth.month || null;
        year = paymentDateOrMonth.year || null;
    } else if (typeof paymentDateOrMonth === 'number' && typeof monthOrYear === 'number') {
        // Called historically as (month, year, paymentDate?)
        month = paymentDateOrMonth;
        year = monthOrYear;
        paymentDate = maybeYear || null;
    } else {
        paymentDate = paymentDateOrMonth;
        month = monthOrYear;
        year = maybeYear;
    }

    if (paymentDate !== null && paymentDate !== undefined && paymentDate !== '') {
        const parsedDate = (paymentDate instanceof Date) ? paymentDate : new Date(paymentDate);
        if (isNaN(parsedDate.getTime())) {
            throw new ValidationError('Invalid payment date provided for statutory TDS provision determination.');
        }

        const dateStr = parsedDate.toISOString().slice(0, 10);
        const isPaidOnOrAfterApril2026 = (dateStr >= '2026-04-01');

        if (isPaidOnOrAfterApril2026) {
            return {
                act: 'Income-tax Act, 2025',
                section: 'Section 392(1)',
                citation: 'Section 392(1), Income-tax Act, 2025 (Salary paid on or after 1 April 2026)',
                status: 'CONFIRMED',
                isProvisional: false,
                paymentDate: dateStr,
                transitionBasis: 'PAYMENT_DATE'
            };
        } else {
            return {
                act: 'Income-tax Act, 1961',
                section: 'Section 192',
                citation: 'Section 192, Income-tax Act, 1961 (Salary paid on or before 31 March 2026)',
                status: 'CONFIRMED',
                isProvisional: false,
                paymentDate: dateStr,
                transitionBasis: 'PAYMENT_DATE'
            };
        }
    }

    // Payment date is not provided
    if (typeof month === 'number' && typeof year === 'number') {
        const isScheduledNewAct = (year > 2026) || (year === 2026 && month >= 4);
        return {
            act: isScheduledNewAct ? 'Income-tax Act, 2025' : 'Income-tax Act, 1961',
            section: isScheduledNewAct ? 'Section 392(1)' : 'Section 192',
            citation: isScheduledNewAct 
                ? 'Section 392(1), Income-tax Act, 2025 (Provisional - determined upon payment date)' 
                : 'Section 192, Income-tax Act, 1961 (Provisional - determined upon payment date)',
            status: 'PROVISIONAL',
            isProvisional: true,
            paymentDate: null,
            transitionBasis: 'SCHEDULED_PAY_PERIOD'
        };
    }

    // Unpaid / pending disbursement without pay period context
    return {
        act: null,
        section: 'PENDING_PAYMENT_DATE',
        citation: 'Provisional (Pending disbursement: Governed by Section 192 if paid on/before 31 March 2026, or Section 392(1) of the Income-tax Act, 2025 if paid on/after 1 April 2026)',
        status: 'PROVISIONAL',
        isProvisional: true,
        paymentDate: null,
        transitionBasis: 'PENDING_DISBURSEMENT'
    };
}


function calculateStatutoryPayroll(structure, month, year, paymentDate = null, employee = null, options = {}) {
    const basic = parseFloat(structure.basicSalary) || 0;
    const hra = parseFloat(structure.hra) || 0;
    const allowances = (parseFloat(structure.conveyance) || 0) + (parseFloat(structure.specialAllowance) || 0);
    const grossEarnings = Math.round((basic + hra + allowances) * 100) / 100;

    const statutoryWarnings = [];
    const statutoryNotes = [];

    // --- 1. EPF & EPS Apportionment ---
    let employeeEpf = 0;
    let employerEpf = 0;
    let employerEps = 0;
    let employerEpfOnly = 0;

    const isExcludedEmployee = structure.isExcludedEmployee === true || 
                               options.isExcludedEmployee === true || 
                               employee?.isExcludedEmployee === true;

    const isInternationalWorker = structure.isInternationalWorker === true || 
                                  options.isInternationalWorker === true || 
                                  employee?.isInternationalWorker === true;

    if (structure.epfApplicable) {
        if (isExcludedEmployee) {
            statutoryNotes.push('Excluded Employee under Para 2(f) EPF Scheme 1952: Not covered under EPF/EPS.');
        } else {
            const ceiling = isInternationalWorker ? Infinity : STATUTORY_RULES.epf.wageCeiling;
            if (isInternationalWorker) {
                statutoryNotes.push('International Worker: Statutory wage ceiling waived, contributions calculated on full wages.');
            }
            
            // Employee contribution (Statutory rounding: nearest whole rupee per Rule 38)
            if (structure.higherPfOpted === true || options.higherPfOpted === true) {
                employeeEpf = Math.round(basic * STATUTORY_RULES.epf.employeeRate);
                statutoryNotes.push(`Voluntary higher employee PF opted on full basic ₹${basic}`);
            } else {
                const eligibleWage = Math.min(basic, ceiling);
                employeeEpf = Math.round(eligibleWage * STATUTORY_RULES.epf.employeeRate);
            }

            // Employer contribution - strictly capped at ceiling unless higher match agreed
            if (structure.employerMatchesHigherPf === true || options.employerMatchesHigherPf === true) {
                employerEpf = Math.round(basic * STATUTORY_RULES.epf.employerRateTotal);
                statutoryNotes.push(`Employer agreed to match higher PF contribution on full basic ₹${basic}`);
            } else {
                const employerEligibleWage = Math.min(basic, ceiling);
                employerEpf = Math.round(employerEligibleWage * STATUTORY_RULES.epf.employerRateTotal);
            }

            // Age determination for EPS (Para 6 EPS 1995: ceases at age 58)
            let age = options.employeeAge !== undefined ? options.employeeAge : null;
            if (age === null && employee && employee.dateOfBirth) {
                const dob = new Date(employee.dateOfBirth);
                if (!isNaN(dob.getTime())) {
                    const asOfDate = new Date(Date.UTC(year, month - 1, 1));
                    let diffYears = asOfDate.getUTCFullYear() - dob.getUTCFullYear();
                    if (asOfDate.getUTCMonth() < dob.getUTCMonth()) diffYears--;
                    age = diffYears;
                }
            }

            if (age === null && !employee?.dateOfBirth && options.isSeniorPensionExempt === undefined) {
                statutoryWarnings.push('Employee dateOfBirth is missing; assumed age < 58 for EPS allocation. Please update employee profile.');
            }

            const isOver58 = (age !== null && age >= STATUTORY_RULES.epf.epsAgeLimit) || options.isSeniorPensionExempt === true;

            if (isOver58) {
                employerEps = 0;
                employerEpfOnly = employerEpf;
                statutoryNotes.push('Employee aged 58 or older: EPS contribution is 0; full employer share allocated to EPF.');
            } else {
                const epsEligibleWage = Math.min(basic, ceiling);
                employerEps = Math.round(Math.min(epsEligibleWage * STATUTORY_RULES.epf.epsRate, isInternationalWorker ? Infinity : STATUTORY_RULES.epf.epsMaxMonthly) * 100) / 100;
                employerEpfOnly = Math.round((employerEpf - employerEps) * 100) / 100;
            }

            if (employee && !employee.uanNumber) {
                statutoryWarnings.push('Employee UAN is not recorded.');
            }
        }
    }

    // --- 2. ESI Eligibility & Contribution ---
    let employeeEsi = 0;
    let employerEsi = 0;

    if (structure.esiApplicable) {
        const isPwD = structure.isPersonWithDisability === true || options.isPersonWithDisability === true;
        const wageCeiling = isPwD ? STATUTORY_RULES.esi.pwdWageCeiling : STATUTORY_RULES.esi.standardWageCeiling;

        // Rule 50 Proviso: coverage continues until expiration of contribution period if covered at period start
        const coveredAtPeriodStart = structure.coveredAtPeriodStart === true || options.coveredAtPeriodStart === true;
        const isEligibleForCoverage = (grossEarnings <= wageCeiling) || coveredAtPeriodStart;

        if (isEligibleForCoverage) {
            if (grossEarnings > wageCeiling && coveredAtPeriodStart) {
                statutoryNotes.push(`Rule 50 Proviso applied: Gross wages (₹${grossEarnings}) exceed ceiling (₹${wageCeiling}), but employee remains covered until end of contribution period.`);
            }

            // Low wage exemption under Rule 52 (daily wage <= 176 / monthly gross <= 4576)
            if (grossEarnings <= STATUTORY_RULES.esi.monthlyExemptionThreshold) {
                employeeEsi = 0;
                employerEsi = Math.round(grossEarnings * STATUTORY_RULES.esi.employerRate * 100) / 100;
                statutoryNotes.push('Low wage exemption under Rule 52 applied: Employee ESI contribution waived.');
            } else {
                employeeEsi = Math.round(grossEarnings * STATUTORY_RULES.esi.employeeRate * 100) / 100;
                employerEsi = Math.round(grossEarnings * STATUTORY_RULES.esi.employerRate * 100) / 100;
            }

        } else {
            statutoryNotes.push(`Gross wages ₹${grossEarnings} exceed ESI wage ceiling ₹${wageCeiling}; exempt from ESI.`);
        }
    }

    // --- 3. Professional Tax (Maharashtra Schedule) ---
    let pt = 0;
    let ptScheduleApplied = null;
    if (structure.ptApplicable) {
        const rawGender = (options.gender || structure.gender || employee?.gender || '').toString().trim().toUpperCase();
        let normalizedGender = null;
        if (['M', 'MALE', 'MEN'].includes(rawGender)) {
            normalizedGender = 'MALE';
        } else if (['F', 'FEMALE', 'WOMEN'].includes(rawGender)) {
            normalizedGender = 'FEMALE';
        }

        const isPostApril2023 = (year > 2023) || (year === 2023 && month >= 4);

        if (!normalizedGender) {
            statutoryWarnings.push('Employee gender is missing or unrecognized; cannot verify whether ₹25,000 female exemption threshold applies under Maharashtra PT schedule. Flagged for verification.');
            if (options.requireGender === true) {
                throw new ValidationError('Employee gender is required to determine applicable Maharashtra Professional Tax schedule.');
            }
        }

        if (normalizedGender === 'FEMALE' && isPostApril2023) {
            ptScheduleApplied = 'MAHARASHTRA_WOMEN_2023';
            // Women: Gross <= ₹25,000 is EXEMPT
            if (grossEarnings > STATUTORY_RULES.pt.womenExemptionLimit) {
                pt = (month === 2) ? STATUTORY_RULES.pt.februaryMonthlyAmount : STATUTORY_RULES.pt.standardMonthlyAmount;
                statutoryNotes.push(`Maharashtra PT (Women): Gross earnings ₹${grossEarnings} exceed ₹25,000 exemption limit. PT: ₹${pt}.`);
            } else {
                pt = 0;
                statutoryNotes.push(`Maharashtra PT (Women): Gross earnings ₹${grossEarnings} <= ₹25,000 exemption limit. PT exempt (₹0).`);
            }
        } else {
            ptScheduleApplied = normalizedGender === 'MALE' ? 'MAHARASHTRA_MEN' : 'MAHARASHTRA_DEFAULT_UNVALIDATED';
            // Men (and unvalidated default): Gross <= 7,500 exempt; 7,501 - 10,000: 175; > 10,000: 200 (300 in Feb)
            if (grossEarnings > STATUTORY_RULES.pt.menMidSlabLimit) {
                pt = (month === 2) ? STATUTORY_RULES.pt.februaryMonthlyAmount : STATUTORY_RULES.pt.standardMonthlyAmount;
            } else if (grossEarnings > STATUTORY_RULES.pt.menExemptionLimit) {
                pt = STATUTORY_RULES.pt.menMidSlabAmount;
            } else {
                pt = 0;
            }
            if (normalizedGender === 'MALE') {
                statutoryNotes.push(`Maharashtra PT (Men): Gross earnings ₹${grossEarnings}, Month ${month}. PT: ₹${pt}.`);
            }
        }

        // Enforce annual PT ceiling of ₹2,500 if YTD PT tracking is supplied
        if (options.ytdProfessionalTax !== undefined) {
            const ytdPt = Math.max(0, parseFloat(options.ytdProfessionalTax) || 0);
            const maxAnnualPt = STATUTORY_RULES.pt.maxAnnualLimit || 2500;
            if (ytdPt + pt > maxAnnualPt) {
                const adjustedPt = Math.max(0, maxAnnualPt - ytdPt);
                statutoryNotes.push(`Maharashtra PT capped at annual maximum ₹${maxAnnualPt}. Monthly PT adjusted from ₹${pt} to ₹${adjustedPt}.`);
                pt = adjustedPt;
            }
        }
    }

    // --- 4. TDS on Salary with Validated Payment-Date Basis & Dynamic Estimation ---
    const tdsCalc = calculateSalaryTds({
        grossMonthlyEarnings: grossEarnings,
        month,
        year,
        paymentDate,
        structure,
        options
    });

    let tds = 0;
    if (options.computeDynamicTds === true || (structure.tdsMonthly === undefined && options.useManualTdsOverride !== true)) {
        tds = tdsCalc.monthlyTds;
    } else {
        tds = Math.round((parseFloat(structure.tdsMonthly) || 0) * 100) / 100;
    }

    const tdsProvision = tdsCalc.provision;

    const totalDeductions = Math.round((employeeEpf + employeeEsi + pt + tds) * 100) / 100;
    const netPay = Math.round((grossEarnings - totalDeductions) * 100) / 100;

    return {
        basicSalary: basic,
        hra,
        allowances,
        grossEarnings,
        employeeEpf,
        employerEpf,
        employerEps,
        employerEpfOnly,
        employeeEsi,
        employerEsi,
        professionalTax: pt,
        ptScheduleApplied,
        tds,
        tdsCalculation: tdsCalc,
        statutoryTdsSection: tdsProvision.section,
        statutoryTdsAct: tdsProvision.act,
        statutoryTdsCitation: tdsProvision.citation,
        statutoryTdsStatus: tdsProvision.status,
        statutoryTdsIsProvisional: tdsProvision.isProvisional,
        totalDeductions,
        netPay,
        statutoryWarnings,
        statutoryNotes
    };
}


/**
 * -------------------------------------------------------------
 * 4. PAYROLL PERIOD LIFECYCLE & LEDGER POSTING
 * -------------------------------------------------------------
 */
async function generatePayrollPeriod({ month, year }, userId) {
    const m = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (isNaN(m) || m < 1 || m > 12) throw new ValidationError('Month must be between 1 and 12.');
    if (isNaN(y) || y < 2000 || y > 2100) throw new ValidationError('Invalid year.');

    const periodCode = `PAY-${y}-${String(m).padStart(2, '0')}`;
    const existing = await prisma.payrollPeriod.findUnique({ where: { periodCode } });
    if (existing) throw new ConflictError(`Payroll period ${periodCode} already generated.`);

    const startDate = new Date(Date.UTC(y, m - 1, 1));
    const endDate = new Date(Date.UTC(y, m, 0)); // last day of month

    const fy = await ensureFinancialYear(endDate);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot generate payroll into closed Financial Year ${fy.code}.`);
    }

    // Fetch active employees
    const activeEmployees = await prisma.employee.findMany({
        where: {
            status: 'ACTIVE',
            dateOfJoining: { lte: endDate }
        }
    });

    if (activeEmployees.length === 0) {
        throw new ValidationError('No active employees found to generate payroll for.');
    }

    return prisma.$transaction(async (tx) => {
        const period = await tx.payrollPeriod.create({
            data: {
                periodCode,
                month: m,
                year: y,
                startDate,
                endDate,
                financialYearId: fy.id,
                status: 'DRAFT',
                createdById: userId
            }
        });

        const entries = [];
        for (const emp of activeEmployees) {
            const structure = await getActiveSalaryStructure(emp.id, endDate);
            if (!structure) continue; // skip employees without salary structure configured

            const calc = calculateStatutoryPayroll(structure, m, y, null, emp);
            const entry = await tx.payrollEntry.create({
                data: {
                    payrollPeriodId: period.id,
                    employeeId: emp.id,
                    basicSalary: calc.basicSalary,
                    hra: calc.hra,
                    allowances: calc.allowances,
                    grossEarnings: calc.grossEarnings,
                    employeeEpf: calc.employeeEpf,
                    employerEpf: calc.employerEpf,
                    employeeEsi: calc.employeeEsi,
                    employerEsi: calc.employerEsi,
                    professionalTax: calc.professionalTax,
                    tds: calc.tds,
                    totalDeductions: calc.totalDeductions,
                    netPay: calc.netPay,
                    status: 'DRAFT'
                }
            });
            entries.push(entry);
        }

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'GENERATE',
                module: 'PAYROLL',
                targetType: 'PAYROLL_PERIOD',
                targetId: period.id,
                description: `Generated payroll period ${periodCode} with ${entries.length} entries.`
            });
        }

        return { ...period, entriesCount: entries.length };
    });
}

async function approvePayrollPeriod(periodId, userId) {
    const numId = parseInt(periodId, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid payroll period ID.');

    const period = await prisma.payrollPeriod.findUnique({
        where: { id: numId },
        include: { entries: true }
    });
    if (!period) throw new NotFoundError(`Payroll period ${numId} not found.`);
    if (period.status !== 'DRAFT') throw new ConflictError(`Only DRAFT payroll periods can be approved. Current: ${period.status}`);
    if (period.entries.length === 0) throw new ValidationError('Cannot approve payroll period with zero entries.');

    const updated = await prisma.payrollPeriod.update({
        where: { id: numId },
        data: {
            status: 'APPROVED',
            approvedById: userId,
            approvedAt: new Date(),
            entries: {
                updateMany: {
                    where: { payrollPeriodId: numId },
                    data: { status: 'APPROVED' }
                }
            }
        },
        include: { entries: true, approvedBy: { select: { id: true, name: true } } }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'APPROVE',
            module: 'PAYROLL',
            targetType: 'PAYROLL_PERIOD',
            targetId: period.id,
            description: `Approved payroll period ${period.periodCode}`
        });
    }

    return updated;
}

async function postPayrollToLedger(periodId, userId) {
    const numId = parseInt(periodId, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid payroll period ID.');

    const period = await prisma.payrollPeriod.findUnique({
        where: { id: numId },
        include: { entries: true, financialYear: true }
    });
    if (!period) throw new NotFoundError(`Payroll period ${numId} not found.`);
    if (period.status !== 'APPROVED') {
        throw new ValidationError(`Payroll period must be in APPROVED status to post to ledger. Current: ${period.status}`);
    }

    const fy = await ensureFinancialYear(period.endDate);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot post payroll into closed Financial Year ${fy.code}.`);
    }

    await ensureSystemAccounts(userId);

    // Aggregate entries
    let totalGross = 0;
    let totalEmployeeEpf = 0;
    let totalEmployerEpf = 0;
    let totalEmployeeEsi = 0;
    let totalEmployerEsi = 0;
    let totalPt = 0;
    let totalTds = 0;
    let totalNet = 0;

    for (const e of period.entries) {
        totalGross += parseFloat(e.grossEarnings);
        totalEmployeeEpf += parseFloat(e.employeeEpf);
        totalEmployerEpf += parseFloat(e.employerEpf);
        totalEmployeeEsi += parseFloat(e.employeeEsi);
        totalEmployerEsi += parseFloat(e.employerEsi);
        totalPt += parseFloat(e.professionalTax);
        totalTds += parseFloat(e.tds);
        totalNet += parseFloat(e.netPay);
    }

    totalGross = Math.round(totalGross * 100) / 100;
    totalEmployeeEpf = Math.round(totalEmployeeEpf * 100) / 100;
    totalEmployerEpf = Math.round(totalEmployerEpf * 100) / 100;
    totalEmployeeEsi = Math.round(totalEmployeeEsi * 100) / 100;
    totalEmployerEsi = Math.round(totalEmployerEsi * 100) / 100;
    totalPt = Math.round(totalPt * 100) / 100;
    totalTds = Math.round(totalTds * 100) / 100;
    totalNet = Math.round(totalNet * 100) / 100;

    return prisma.$transaction(async (tx) => {
        // Find required accounts
        const salariesExp = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: 'SALARIES_EXPENSE' } });
        const employerContribExp = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: 'EMPLOYER_CONTRIBUTIONS' } });
        const salariesPayable = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: 'SALARIES_PAYABLE' } });
        const epfPayable = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: 'EPF_PAYABLE' } });
        const esiPayable = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: 'ESI_PAYABLE' } });
        const ptPayable = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: 'PT_PAYABLE' } });
        const tdsPayable = await tx.chartOfAccount.findFirst({ where: { systemAccountKey: 'TDS_PAYABLE' } });

        if (!salariesExp || !salariesPayable) {
            throw new Error('System chart of accounts missing Salaries Expense or Salaries Payable account.');
        }

        const journalLines = [
            // Debit Salaries Expense for Total Gross
            {
                accountId: salariesExp.id,
                debit: totalGross,
                credit: 0,
                description: `Salaries & Wages - Period ${period.periodCode}`
            }
        ];

        // Debit Employer Contributions
        const totalEmployerContrib = Math.round((totalEmployerEpf + totalEmployerEsi) * 100) / 100;
        if (totalEmployerContrib > 0 && employerContribExp) {
            journalLines.push({
                accountId: employerContribExp.id,
                debit: totalEmployerContrib,
                credit: 0,
                description: `Employer Statutory Contributions (EPF & ESI) - ${period.periodCode}`
            });
        }

        // Credit Salaries Payable for Net Pay
        journalLines.push({
            accountId: salariesPayable.id,
            debit: 0,
            credit: totalNet,
            description: `Net Salaries Payable - Period ${period.periodCode}`
        });

        // Credit EPF Payable (Employee + Employer)
        const totalEpf = Math.round((totalEmployeeEpf + totalEmployerEpf) * 100) / 100;
        if (totalEpf > 0 && epfPayable) {
            journalLines.push({
                accountId: epfPayable.id,
                debit: 0,
                credit: totalEpf,
                description: `EPF Contributions Payable (EE: ${totalEmployeeEpf}, ER: ${totalEmployerEpf}) - ${period.periodCode}`
            });
        }

        // Credit ESI Payable (Employee + Employer)
        const totalEsi = Math.round((totalEmployeeEsi + totalEmployerEsi) * 100) / 100;
        if (totalEsi > 0 && esiPayable) {
            journalLines.push({
                accountId: esiPayable.id,
                debit: 0,
                credit: totalEsi,
                description: `ESI Contributions Payable (EE: ${totalEmployeeEsi}, ER: ${totalEmployerEsi}) - ${period.periodCode}`
            });
        }

        // Credit Professional Tax Payable
        if (totalPt > 0 && ptPayable) {
            journalLines.push({
                accountId: ptPayable.id,
                debit: 0,
                credit: totalPt,
                description: `Professional Tax Payable - Period ${period.periodCode}`
            });
        }

        // Credit TDS Payable
        if (totalTds > 0 && tdsPayable) {
            journalLines.push({
                accountId: tdsPayable.id,
                debit: 0,
                credit: totalTds,
                description: `TDS on Salaries Payable - Period ${period.periodCode}`
            });
        }

        // Post Journal Entry
        const journal = await journalService.postJournalEntry({
            entryDate: period.endDate,
            financialYearId: fy.id,
            sourceType: 'PAYROLL',
            sourceId: period.id,
            idempotencyKey: `PAYROLL:${period.id}`,
            narration: `Payroll Posting for ${period.periodCode} (Net: ₹${totalNet}, Gross: ₹${totalGross})`,
            lines: journalLines,
            userId
        }, tx);

        // Update Payroll Period & Entries status
        const updated = await tx.payrollPeriod.update({
            where: { id: period.id },
            data: {
                status: 'POSTED',
                journalEntryId: journal.id,
                entries: {
                    updateMany: {
                        where: { payrollPeriodId: period.id },
                        data: { status: 'POSTED' }
                    }
                }
            },
            include: { entries: true, journalEntry: true }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'POST',
                module: 'PAYROLL',
                targetType: 'PAYROLL_PERIOD',
                targetId: period.id,
                description: `Posted payroll period ${period.periodCode} to GL Journal #${journal.entryNumber}`
            });
        }

        return updated;
    });
}

/**
 * -------------------------------------------------------------
 * 5. PAYSLIP GENERATION
 * -------------------------------------------------------------
 */
async function getPayslip(payrollEntryId) {
    const numId = parseInt(payrollEntryId, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid payroll entry ID.');

    const entry = await prisma.payrollEntry.findUnique({
        where: { id: numId },
        include: {
            employee: true,
            payrollPeriod: { include: { financialYear: true } }
        }
    });

    if (!entry) throw new NotFoundError(`Payroll entry ${numId} not found.`);

    const tdsProvision = resolveStatutoryTdsProvision(entry.paymentDate, entry.payrollPeriod.month, entry.payrollPeriod.year);

    return {
        id: entry.id,
        periodCode: entry.payrollPeriod.periodCode,
        month: entry.payrollPeriod.month,
        year: entry.payrollPeriod.year,
        employee: {
            id: entry.employee.id,
            employeeCode: entry.employee.employeeCode,
            name: `${entry.employee.firstName} ${entry.employee.lastName}`,
            department: entry.employee.department,
            designation: entry.employee.designation,
            panNumber: entry.employee.panNumber,
            uanNumber: entry.employee.uanNumber,
            bankAccount: entry.employee.bankAccountNumber,
            bankIfsc: entry.employee.bankIfsc
        },
        earnings: {
            basicSalary: parseFloat(entry.basicSalary),
            hra: parseFloat(entry.hra),
            allowances: parseFloat(entry.allowances),
            grossEarnings: parseFloat(entry.grossEarnings)
        },
        deductions: {
            employeeEpf: parseFloat(entry.employeeEpf),
            employeeEsi: parseFloat(entry.employeeEsi),
            professionalTax: parseFloat(entry.professionalTax),
            tds: parseFloat(entry.tds),
            totalDeductions: parseFloat(entry.totalDeductions)
        },
        statutoryTds: {
            section: tdsProvision.section,
            act: tdsProvision.act,
            citation: tdsProvision.citation,
            status: tdsProvision.status,
            isProvisional: tdsProvision.isProvisional,
            paymentDate: entry.paymentDate ? entry.paymentDate.toISOString().slice(0, 10) : null
        },
        employerContributions: {
            employerEpf: parseFloat(entry.employerEpf),
            employerEsi: parseFloat(entry.employerEsi)
        },
        netPay: parseFloat(entry.netPay),
        status: entry.status,
        paymentDetails: {
            method: entry.paymentMethod,
            date: entry.paymentDate ? entry.paymentDate.toISOString().slice(0, 10) : null,
            reference: entry.paymentReference
        }
    };
}

/**
 * -------------------------------------------------------------
 * 5B. PAYROLL DISBURSEMENT & PAYMENT RECORDING
 * -------------------------------------------------------------
 */
async function disbursePayrollEntry({ payrollEntryId, paymentDate, paymentMethod = 'BANK_TRANSFER', paymentReference = null }, userId) {
    const numId = parseInt(payrollEntryId, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid payroll entry ID.');

    if (!paymentDate) throw new ValidationError('Payment date is required for disbursement.');
    const parsedDate = (paymentDate instanceof Date) ? paymentDate : new Date(paymentDate);
    if (isNaN(parsedDate.getTime())) throw new ValidationError('Invalid payment date.');

    const entry = await prisma.payrollEntry.findUnique({
        where: { id: numId },
        include: { employee: true, payrollPeriod: true }
    });
    if (!entry) throw new NotFoundError(`Payroll entry ${numId} not found.`);

    const tdsProvision = resolveStatutoryTdsProvision(parsedDate, entry.payrollPeriod.month, entry.payrollPeriod.year);

    const updated = await prisma.payrollEntry.update({
        where: { id: numId },
        data: {
            status: 'PAID',
            paymentDate: parsedDate,
            paymentMethod: paymentMethod || 'BANK_TRANSFER',
            paymentReference: paymentReference ? String(paymentReference).trim() : null
        },
        include: { employee: true, payrollPeriod: true }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'DISBURSE',
            module: 'PAYROLL',
            targetType: 'PAYROLL_ENTRY',
            targetId: String(entry.id),
            targetReference: `Statutory TDS: ${tdsProvision.section}`,
            metadata: {
                description: `Disbursed salary for ${entry.employee.employeeCode} (${entry.payrollPeriod.periodCode}) on ${parsedDate.toISOString().slice(0, 10)}. Statutory TDS: ${tdsProvision.section} (${tdsProvision.act || 'Provisional'}).`,
                statutoryTdsSection: tdsProvision.section,
                statutoryTdsAct: tdsProvision.act
            }
        });
    }

    return {
        entry: updated,
        statutoryTds: tdsProvision
    };

}

/**
 * -------------------------------------------------------------
 * 6. EMPLOYEE REIMBURSEMENTS
 * -------------------------------------------------------------
 */
async function createReimbursement(data = {}, userId) {
    const employeeId = parseInt(data.employeeId, 10);
    if (isNaN(employeeId) || employeeId <= 0) throw new ValidationError('Valid employee ID is required.');

    const rawAmount = parseFloat(data.amount);
    if (isNaN(rawAmount) || rawAmount <= 0) throw new ValidationError('Amount must be greater than 0.');
    const amount = Math.round(rawAmount * 100) / 100;

    const expenseDate = data.expenseDate ? new Date(data.expenseDate) : new Date();
    if (isNaN(expenseDate.getTime())) throw new ValidationError('Invalid expense date.');

    const category = (data.category || 'Travel').trim();
    const fy = await ensureFinancialYear(expenseDate);

    const reimb = await prisma.employeeReimbursement.create({
        data: {
            employeeId,
            expenseDate,
            amount,
            category,
            description: data.description ? String(data.description).trim() : null,
            receiptUrl: data.receiptUrl ? String(data.receiptUrl).trim() : null,
            status: 'PENDING',
            financialYearId: fy.id
        },
        include: { employee: true }
    });

    return reimb;
}

async function approveReimbursement(id, userId) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid reimbursement ID.');

    const reimb = await prisma.employeeReimbursement.findUnique({ where: { id: numId } });
    if (!reimb) throw new NotFoundError(`Reimbursement ${numId} not found.`);
    if (reimb.status !== 'PENDING') throw new ConflictError(`Reimbursement is already ${reimb.status}.`);

    return prisma.employeeReimbursement.update({
        where: { id: numId },
        data: {
            status: 'APPROVED',
            approvedById: userId
        },
        include: { employee: true, approvedBy: { select: { id: true, name: true } } }
    });
}

module.exports = {
    createEmployee,
    getEmployeeById,
    listEmployees,
    setSalaryStructure,
    getActiveSalaryStructure,
    STATUTORY_RULES,
    resolveStatutoryTdsProvision,
    calculateSalaryTds,
    calculateStatutoryPayroll,
    generatePayrollPeriod,
    approvePayrollPeriod,
    postPayrollToLedger,
    getPayslip,
    disbursePayrollEntry,
    createReimbursement,
    approveReimbursement,
    ValidationError,
    NotFoundError,
    ConflictError
};

