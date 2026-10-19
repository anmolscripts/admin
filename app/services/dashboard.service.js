'use strict';

const prisma = require('../config/prisma');

/**
 * Calculates start and end Date objects for standard ranges
 */
function getDateRangeFilter(rangeKey = 'this_month', customFrom = null, customTo = null, referenceDate = new Date()) {
    const now = new Date(referenceDate);
    const key = (rangeKey || 'this_month').toLowerCase();

    let startDate = null;
    let endDate = null;

    if (key === 'today') {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    } else if (key === 'this_week') {
        const day = now.getDay();
        const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
        startDate = new Date(now.getFullYear(), now.getMonth(), diff, 0, 0, 0, 0);
        endDate = new Date(now.getFullYear(), now.getMonth(), diff + 6, 23, 59, 59, 999);
    } else if (key === 'this_month') {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    } else if (key === 'this_quarter') {
        const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
        startDate = new Date(now.getFullYear(), quarterMonth, 1, 0, 0, 0, 0);
        endDate = new Date(now.getFullYear(), quarterMonth + 3, 0, 23, 59, 59, 999);
    } else if (key === 'this_year') {
        startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
        endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    } else if (key === 'custom' && (customFrom || customTo)) {
        if (customFrom) {
            const dFrom = new Date(customFrom);
            if (!isNaN(dFrom.getTime())) {
                startDate = new Date(dFrom.getFullYear(), dFrom.getMonth(), dFrom.getDate(), 0, 0, 0, 0);
            }
        }
        if (customTo) {
            const dTo = new Date(customTo);
            if (!isNaN(dTo.getTime())) {
                endDate = new Date(dTo.getFullYear(), dTo.getMonth(), dTo.getDate(), 23, 59, 59, 999);
            }
        }
    }

    return { key, startDate, endDate };
}

/**
 * Server-side KPI and Analytics aggregation
 * Efficient SQL queries strictly scoped to authorized businessId and date filter.
 */
async function getDashboardMetrics({ range = 'this_month', from = null, to = null, businessId = null } = {}, referenceDate = new Date()) {
    const dateFilter = getDateRangeFilter(range, from, to, referenceDate);
    const now = new Date(referenceDate);

    // Build Prisma date where condition
    const dateCondition = {};
    if (dateFilter.startDate || dateFilter.endDate) {
        if (dateFilter.startDate) dateCondition.gte = dateFilter.startDate;
        if (dateFilter.endDate) dateCondition.lte = dateFilter.endDate;
    }
    const hasDateFilter = Object.keys(dateCondition).length > 0;

    // Tenant Scoping Clause
    const bizIdNum = businessId ? parseInt(businessId, 10) : null;
    const businessClause = (bizIdNum && !isNaN(bizIdNum) && bizIdNum > 0)
        ? { businessId: bizIdNum }
        : {};

    const invoiceDateClause = hasDateFilter ? { invoiceDate: dateCondition } : {};
    const paymentDateClause = hasDateFilter ? { paymentDate: dateCondition } : {};
    const expenseDateClause = hasDateFilter ? { expenseDate: dateCondition } : {};

    // Calculate overdue cutoff: 30 days prior to current reference date
    const overdueCutoff = new Date(now);
    overdueCutoff.setDate(overdueCutoff.getDate() - 30);

    // Calculate aging bucket cutoffs
    const d30 = new Date(now);
    d30.setDate(d30.getDate() - 30);
    const d60 = new Date(now);
    d60.setDate(d60.getDate() - 60);
    const d90 = new Date(now);
    d90.setDate(d90.getDate() - 90);

    // Run parallel server-side aggregations
    const [
        totalQuotations,
        activeQuotations,
        convertedQuotations,
        totalInvoices,
        activeInvoices,
        voidInvoices,
        invoiceFinancials,
        overdueAgg,
        paymentsAgg,
        expensesAgg,
        recentActivity,
        expenseCategoryGroups,
        topClientsGroup,
        agingAggCurrent,
        agingAgg30,
        agingAgg60,
        agingAgg90
    ] = await Promise.all([
        // 1. Total Quotations
        prisma.invoice.count({
            where: { documentType: 'QUOTATION', ...businessClause, ...invoiceDateClause }
        }),

        // 2. Active Quotations
        prisma.invoice.count({
            where: { documentType: 'QUOTATION', status: 'ACTIVE', ...businessClause, ...invoiceDateClause }
        }),

        // 3. Converted Quotations (source quotation of an invoice)
        prisma.invoice.count({
            where: {
                documentType: 'QUOTATION',
                convertedInvoice: { isNot: null },
                ...businessClause,
                ...invoiceDateClause
            }
        }),

        // 4. Total Invoices
        prisma.invoice.count({
            where: { documentType: 'INVOICE', ...businessClause, ...invoiceDateClause }
        }),

        // 5. Active Invoices
        prisma.invoice.count({
            where: { documentType: 'INVOICE', status: 'ACTIVE', ...businessClause, ...invoiceDateClause }
        }),

        // 6. Void Invoices
        prisma.invoice.count({
            where: { documentType: 'INVOICE', status: 'VOID', ...businessClause, ...invoiceDateClause }
        }),

        // 7. Active/Inactive Invoice Financials
        prisma.invoice.aggregate({
            where: {
                documentType: 'INVOICE',
                status: { in: ['ACTIVE', 'INACTIVE'] },
                ...businessClause,
                ...invoiceDateClause
            },
            _sum: {
                grandTotal: true,
                paidAmount: true,
                outstandingAmount: true
            }
        }),

        // 8. Overdue Invoices Aggregation
        prisma.invoice.aggregate({
            where: {
                documentType: 'INVOICE',
                status: 'ACTIVE',
                outstandingAmount: { gt: 0 },
                ...businessClause,
                OR: [
                    { dueDate: { not: null, lt: now } },
                    { dueDate: null, invoiceDate: { lt: overdueCutoff } }
                ]
            },
            _sum: {
                outstandingAmount: true
            },
            _count: {
                id: true
            }
        }),

        // 9. Payment Collection Aggregation
        prisma.payment.aggregate({
            where: {
                status: { in: ['POSTED', 'RECORDED'] },
                ...businessClause,
                ...paymentDateClause
            },
            _sum: {
                amount: true
            },
            _count: {
                id: true
            }
        }),

        // 10. Expenses Aggregation
        prisma.expense.aggregate({
            where: {
                ...businessClause,
                ...expenseDateClause
            },
            _sum: {
                amount: true
            },
            _count: {
                id: true
            }
        }),

        // 11. Recent 5 documents
        prisma.invoice.findMany({
            where: { ...businessClause, ...invoiceDateClause },
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                invoiceNumber: true,
                documentType: true,
                clientName: true,
                invoiceDate: true,
                grandTotal: true,
                status: true,
                paidAmount: true,
                outstandingAmount: true
            }
        }),

        // 12. Expense Category Breakdown (Top categories)
        prisma.expense.groupBy({
            by: ['category'],
            where: {
                ...businessClause,
                ...expenseDateClause
            },
            _sum: {
                amount: true
            },
            _count: {
                id: true
            },
            orderBy: {
                _sum: {
                    amount: 'desc'
                }
            },
            take: 6
        }),

        // 13. Top Clients by Revenue
        prisma.invoice.groupBy({
            by: ['clientName'],
            where: {
                documentType: 'INVOICE',
                status: { in: ['ACTIVE', 'INACTIVE'] },
                ...businessClause,
                ...invoiceDateClause
            },
            _sum: {
                grandTotal: true
            },
            _count: {
                id: true
            },
            orderBy: {
                _sum: {
                    grandTotal: 'desc'
                }
            },
            take: 5
        }),

        // 14. Ageing: Current (0 - 30 days)
        prisma.invoice.aggregate({
            where: {
                documentType: 'INVOICE',
                status: 'ACTIVE',
                outstandingAmount: { gt: 0 },
                invoiceDate: { gte: d30 },
                ...businessClause
            },
            _sum: { outstandingAmount: true },
            _count: { id: true }
        }),

        // 15. Ageing: 31 - 60 days
        prisma.invoice.aggregate({
            where: {
                documentType: 'INVOICE',
                status: 'ACTIVE',
                outstandingAmount: { gt: 0 },
                invoiceDate: { lt: d30, gte: d60 },
                ...businessClause
            },
            _sum: { outstandingAmount: true },
            _count: { id: true }
        }),

        // 16. Ageing: 61 - 90 days
        prisma.invoice.aggregate({
            where: {
                documentType: 'INVOICE',
                status: 'ACTIVE',
                outstandingAmount: { gt: 0 },
                invoiceDate: { lt: d60, gte: d90 },
                ...businessClause
            },
            _sum: { outstandingAmount: true },
            _count: { id: true }
        }),

        // 17. Ageing: Over 90 days
        prisma.invoice.aggregate({
            where: {
                documentType: 'INVOICE',
                status: 'ACTIVE',
                outstandingAmount: { gt: 0 },
                invoiceDate: { lt: d90 },
                ...businessClause
            },
            _sum: { outstandingAmount: true },
            _count: { id: true }
        })
    ]);

    // Financial calculations
    const totalInvoiced = Number(invoiceFinancials._sum.grandTotal) || 0;
    const paidAmount = Number(invoiceFinancials._sum.paidAmount) || 0;
    const outstandingAmount = Number(invoiceFinancials._sum.outstandingAmount) || 0;
    const overdueAmount = Number(overdueAgg._sum.outstandingAmount) || 0;
    const overdueCount = Number(overdueAgg._count.id) || 0;
    const totalCollected = Number(paymentsAgg._sum.amount) || 0;
    const paymentsCount = Number(paymentsAgg._count.id) || 0;
    const totalExpenses = Number(expensesAgg._sum.amount) || 0;
    const expensesCount = Number(expensesAgg._count.id) || 0;

    // Conversion metrics
    const conversionRate = totalQuotations > 0
        ? Number(((convertedQuotations / totalQuotations) * 100).toFixed(1))
        : 0;

    // Paid rate
    const collectionRate = totalInvoiced > 0
        ? Number(((paidAmount / totalInvoiced) * 100).toFixed(1))
        : 0;

    // Build trend analytics (6 time buckets strictly scoped by businessId)
    const trends = await generateTrendSeries(dateFilter, now, businessClause);

    // Format Expense Categories for Chart
    const expenseCategories = {
        labels: expenseCategoryGroups.map(g => g.category || 'General Expense'),
        series: expenseCategoryGroups.map(g => Number(g._sum.amount) || 0),
        counts: expenseCategoryGroups.map(g => g._count.id)
    };

    // Format Invoices by Status for Donut Chart
    const paidInvoicesCount = await prisma.invoice.count({
        where: { documentType: 'INVOICE', status: 'ACTIVE', paidAmount: { gt: 0 }, outstandingAmount: 0, ...businessClause, ...invoiceDateClause }
    });
    const partiallyPaidInvoicesCount = await prisma.invoice.count({
        where: { documentType: 'INVOICE', status: 'ACTIVE', paidAmount: { gt: 0 }, outstandingAmount: { gt: 0 }, ...businessClause, ...invoiceDateClause }
    });
    const unpaidInvoicesCount = await prisma.invoice.count({
        where: { documentType: 'INVOICE', status: 'ACTIVE', paidAmount: 0, ...businessClause, ...invoiceDateClause }
    });

    const statusBreakdown = {
        labels: ['Fully Paid', 'Partially Paid', 'Unpaid', 'Voided'],
        series: [paidInvoicesCount, partiallyPaidInvoicesCount, unpaidInvoicesCount, voidInvoices]
    };

    // Format Top Clients for Horizontal Bar Chart
    const topClients = {
        labels: topClientsGroup.map(c => c.clientName || 'Unnamed Client'),
        series: topClientsGroup.map(c => Number(c._sum.grandTotal) || 0)
    };

    // Format Receivables Ageing for Column Chart
    const receivablesAgeing = {
        labels: ['Current (0-30d)', '31-60 Days', '61-90 Days', 'Over 90 Days'],
        series: [
            Number(agingAggCurrent._sum.outstandingAmount) || 0,
            Number(agingAgg30._sum.outstandingAmount) || 0,
            Number(agingAgg60._sum.outstandingAmount) || 0,
            Number(agingAgg90._sum.outstandingAmount) || 0
        ],
        counts: [
            Number(agingAggCurrent._count.id) || 0,
            Number(agingAgg30._count.id) || 0,
            Number(agingAgg60._count.id) || 0,
            Number(agingAgg90._count.id) || 0
        ]
    };

    return {
        range: dateFilter.key,
        businessId: bizIdNum,
        dateFilter: {
            startDate: dateFilter.startDate ? dateFilter.startDate.toISOString() : null,
            endDate: dateFilter.endDate ? dateFilter.endDate.toISOString() : null
        },
        kpis: {
            quotations: {
                total: totalQuotations,
                active: activeQuotations,
                converted: convertedQuotations,
                conversionRate
            },
            invoices: {
                total: totalInvoices,
                active: activeInvoices,
                void: voidInvoices,
                collectionRate
            },
            financials: {
                totalInvoiced,
                paidAmount,
                outstandingAmount,
                overdueAmount,
                overdueCount,
                totalCollected,
                paymentsCount,
                totalExpenses,
                expensesCount
            }
        },
        trends,
        charts: {
            statusBreakdown,
            expenseCategories,
            topClients,
            receivablesAgeing
        },
        statusBreakdown,
        expenseCategories,
        topClients,
        receivablesAgeing,
        recentActivity
    };
}

/**
 * Generate 6 trend data points for chart analytics strictly scoped by business
 */
async function generateTrendSeries(dateFilter, now, businessClause = {}) {
    const buckets = [];
    const numBuckets = 6;

    let bucketStart = dateFilter.startDate ? new Date(dateFilter.startDate) : new Date(now.getFullYear(), now.getMonth() - 5, 1);
    let bucketEnd = dateFilter.endDate ? new Date(dateFilter.endDate) : new Date(now);

    const timeSpanMs = bucketEnd.getTime() - bucketStart.getTime();
    const intervalMs = Math.max(86400000, Math.floor(timeSpanMs / numBuckets));

    for (let i = 0; i < numBuckets; i++) {
        const bStart = new Date(bucketStart.getTime() + (i * intervalMs));
        const bEnd = new Date(Math.min(bucketEnd.getTime(), bStart.getTime() + intervalMs - 1));

        const label = bStart.toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short'
        });

        buckets.push({ bStart, bEnd, label });
    }

    // Parallel aggregate for each bucket strictly scoped to businessClause
    const trendResults = await Promise.all(buckets.map(async ({ bStart, bEnd, label }) => {
        const [revAgg, quoteAgg, convCount, collAgg] = await Promise.all([
            prisma.invoice.aggregate({
                where: {
                    documentType: 'INVOICE',
                    status: { in: ['ACTIVE', 'INACTIVE'] },
                    invoiceDate: { gte: bStart, lte: bEnd },
                    ...businessClause
                },
                _sum: { grandTotal: true }
            }),
            prisma.invoice.aggregate({
                where: {
                    documentType: 'QUOTATION',
                    invoiceDate: { gte: bStart, lte: bEnd },
                    ...businessClause
                },
                _sum: { grandTotal: true },
                _count: { id: true }
            }),
            prisma.invoice.count({
                where: {
                    documentType: 'QUOTATION',
                    convertedInvoice: { isNot: null },
                    invoiceDate: { gte: bStart, lte: bEnd },
                    ...businessClause
                }
            }),
            prisma.payment.aggregate({
                where: {
                    status: { in: ['POSTED', 'RECORDED'] },
                    paymentDate: { gte: bStart, lte: bEnd },
                    ...businessClause
                },
                _sum: { amount: true }
            })
        ]);

        return {
            period: label,
            revenue: Number(revAgg._sum.grandTotal) || 0,
            quotationsValue: Number(quoteAgg._sum.grandTotal) || 0,
            quotationsCount: Number(quoteAgg._count.id) || 0,
            convertedCount: convCount || 0,
            collections: Number(collAgg._sum.amount) || 0
        };
    }));

    return {
        labels: trendResults.map(t => t.period),
        revenue: trendResults.map(t => t.revenue),
        collections: trendResults.map(t => t.collections),
        quotations: trendResults.map(t => t.quotationsCount),
        quotationsCount: trendResults.map(t => t.quotationsCount),
        quotationsValue: trendResults.map(t => t.quotationsValue),
        conversions: trendResults.map(t => t.convertedCount)
    };
}

module.exports = {
    getDateRangeFilter,
    getDashboardMetrics
};
