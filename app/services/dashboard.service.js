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
 * Efficient SQL queries with zero N+1 and robust handling of empty datasets.
 */
async function getDashboardMetrics({ range = 'this_month', from = null, to = null } = {}, referenceDate = new Date()) {
    const dateFilter = getDateRangeFilter(range, from, to, referenceDate);
    const now = new Date(referenceDate);

    // Build Prisma date where condition
    const dateCondition = {};
    if (dateFilter.startDate || dateFilter.endDate) {
        if (dateFilter.startDate) dateCondition.gte = dateFilter.startDate;
        if (dateFilter.endDate) dateCondition.lte = dateFilter.endDate;
    }
    const hasDateFilter = Object.keys(dateCondition).length > 0;

    const invoiceDateClause = hasDateFilter ? { invoiceDate: dateCondition } : {};
    const paymentDateClause = hasDateFilter ? { paymentDate: dateCondition } : {};

    // Calculate overdue cutoff: 30 days prior to current reference date
    const overdueCutoff = new Date(now);
    overdueCutoff.setDate(overdueCutoff.getDate() - 30);

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
        recentActivity
    ] = await Promise.all([
        // 1. Total Quotations
        prisma.invoice.count({
            where: { documentType: 'QUOTATION', ...invoiceDateClause }
        }),

        // 2. Active Quotations
        prisma.invoice.count({
            where: { documentType: 'QUOTATION', status: 'ACTIVE', ...invoiceDateClause }
        }),

        // 3. Converted Quotations (source quotation of an invoice)
        prisma.invoice.count({
            where: {
                documentType: 'QUOTATION',
                convertedInvoice: { isNot: null },
                ...invoiceDateClause
            }
        }),

        // 4. Total Invoices
        prisma.invoice.count({
            where: { documentType: 'INVOICE', ...invoiceDateClause }
        }),

        // 5. Active Invoices
        prisma.invoice.count({
            where: { documentType: 'INVOICE', status: 'ACTIVE', ...invoiceDateClause }
        }),

        // 6. Void Invoices
        prisma.invoice.count({
            where: { documentType: 'INVOICE', status: 'VOID', ...invoiceDateClause }
        }),

        // 7. Active/Inactive Invoice Financials (grandTotal, paidAmount, outstandingAmount)
        prisma.invoice.aggregate({
            where: {
                documentType: 'INVOICE',
                status: { in: ['ACTIVE', 'INACTIVE'] },
                ...invoiceDateClause
            },
            _sum: {
                grandTotal: true,
                paidAmount: true,
                outstandingAmount: true
            }
        }),

        // 8. Overdue Invoices Aggregation (ACTIVE, outstanding > 0, dueDate < now OR (dueDate is null AND invoiceDate < now - 30d))
        prisma.invoice.aggregate({
            where: {
                documentType: 'INVOICE',
                status: 'ACTIVE',
                outstandingAmount: { gt: 0 },
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
                status: 'RECORDED',
                ...paymentDateClause
            },
            _sum: {
                amount: true
            },
            _count: {
                id: true
            }
        }),

        // 10. Recent 5 documents for quick table
        prisma.invoice.findMany({
            where: invoiceDateClause,
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
        })
    ]);

    // Financial numbers
    const totalInvoiced = Number(invoiceFinancials._sum.grandTotal) || 0;
    const paidAmount = Number(invoiceFinancials._sum.paidAmount) || 0;
    const outstandingAmount = Number(invoiceFinancials._sum.outstandingAmount) || 0;
    const overdueAmount = Number(overdueAgg._sum.outstandingAmount) || 0;
    const overdueCount = Number(overdueAgg._count.id) || 0;
    const totalCollected = Number(paymentsAgg._sum.amount) || 0;
    const paymentsCount = Number(paymentsAgg._count.id) || 0;

    // Conversion metrics
    const conversionRate = totalQuotations > 0
        ? Number(((convertedQuotations / totalQuotations) * 100).toFixed(1))
        : 0;

    // Build trend analytics (6 time buckets based on dateFilter)
    const trends = await generateTrendSeries(dateFilter, now);

    return {
        range: dateFilter.key,
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
                void: voidInvoices
            },
            financials: {
                totalInvoiced,
                paidAmount,
                outstandingAmount,
                overdueAmount,
                overdueCount,
                totalCollected,
                paymentsCount
            }
        },
        trends,
        recentActivity
    };
}

/**
 * Generate 6 trend data points for chart analytics
 */
async function generateTrendSeries(dateFilter, now) {
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

    // Parallel aggregate for each bucket
    const trendResults = await Promise.all(buckets.map(async ({ bStart, bEnd, label }) => {
        const [revAgg, quoteAgg, convCount, collAgg] = await Promise.all([
            prisma.invoice.aggregate({
                where: {
                    documentType: 'INVOICE',
                    status: { in: ['ACTIVE', 'INACTIVE'] },
                    invoiceDate: { gte: bStart, lte: bEnd }
                },
                _sum: { grandTotal: true }
            }),
            prisma.invoice.aggregate({
                where: {
                    documentType: 'QUOTATION',
                    invoiceDate: { gte: bStart, lte: bEnd }
                },
                _sum: { grandTotal: true },
                _count: { id: true }
            }),
            prisma.invoice.count({
                where: {
                    documentType: 'QUOTATION',
                    convertedInvoice: { isNot: null },
                    invoiceDate: { gte: bStart, lte: bEnd }
                }
            }),
            prisma.payment.aggregate({
                where: {
                    status: 'RECORDED',
                    paymentDate: { gte: bStart, lte: bEnd }
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
        quotations: trendResults.map(t => t.quotationsValue),
        conversions: trendResults.map(t => t.convertedCount)
    };
}

module.exports = {
    getDateRangeFilter,
    getDashboardMetrics
};
