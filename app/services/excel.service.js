const ExcelJS = require('exceljs');
const prisma = require('../config/prisma');

/**
 * Format date to YYYY-MM-DD
 */
function formatDate(dateVal) {
    if (!dateVal) return '';
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().split('T')[0];
}

/**
 * Generate an Excel Workbook Buffer for export
 * @param {Object} filters - Filter criteria matching listInvoices (documentType, status, search, dateFrom, dateTo)
 * @returns {Promise<Buffer>} Excel file buffer
 */
async function generateInvoicesExcel(filters = {}) {
    const { documentType, status, search, dateFrom, dateTo, limit = 1000 } = filters;

    const where = {};

    if (documentType && ['QUOTATION', 'INVOICE'].includes(documentType.toUpperCase())) {
        where.documentType = documentType.toUpperCase();
    }

    if (status && ['ACTIVE', 'INACTIVE', 'VOID', 'DELETED'].includes(status.toUpperCase())) {
        where.status = status.toUpperCase();
    } else if (!status) {
        where.status = { not: 'DELETED' };
    }

    if (search && typeof search === 'string' && search.trim()) {
        const query = search.trim();
        where.OR = [
            { invoiceNumber: { contains: query } },
            { clientName: { contains: query } }
        ];
    }

    if (dateFrom || dateTo) {
        where.invoiceDate = {};
        if (dateFrom) where.invoiceDate.gte = new Date(dateFrom);
        if (dateTo) {
            const to = new Date(dateTo);
            to.setHours(23, 59, 59, 999);
            where.invoiceDate.lte = to;
        }
    }

    const documents = await prisma.invoice.findMany({
        where,
        take: Math.min(1000, Math.max(1, parseInt(limit, 10) || 1000)),
        orderBy: { invoiceDate: 'desc' },
        include: {
            items: { orderBy: { lineNumber: 'asc' } },
            sourceQuotation: { select: { invoiceNumber: true } },
            convertedInvoice: { select: { invoiceNumber: true } },
            createdBy: { select: { name: true, email: true } }
        }
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Spark Admin ERP';
    workbook.created = new Date();

    // -----------------------------------------------------------------
    // SHEET 1: Documents Summary
    // -----------------------------------------------------------------
    const docSheet = workbook.addWorksheet('Documents', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });

    docSheet.columns = [
        { header: 'Document No', key: 'invoiceNumber', width: 18 },
        { header: 'Type', key: 'documentType', width: 14 },
        { header: 'Status', key: 'status', width: 12 },
        { header: 'Date', key: 'invoiceDate', width: 14 },
        { header: 'Client Name', key: 'clientName', width: 26 },
        { header: 'Client Email', key: 'clientEmail', width: 24 },
        { header: 'Client Phone', key: 'clientPhone', width: 16 },
        { header: 'Subtotal (₹)', key: 'subtotal', width: 16 },
        { header: 'GST Rate (%)', key: 'gstRate', width: 14 },
        { header: 'GST Amount (₹)', key: 'gstAmount', width: 16 },
        { header: 'Round Off (₹)', key: 'roundOff', width: 14 },
        { header: 'Grand Total (₹)', key: 'grandTotal', width: 18 },
        { header: 'Related Document', key: 'relatedDoc', width: 20 },
        { header: 'Created By', key: 'createdBy', width: 22 }
    ];

    // Style Header Row
    const headerRow = docSheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF1B5E20' } // Pine green
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
    headerRow.height = 24;

    documents.forEach((doc) => {
        let relatedDoc = '';
        if (doc.sourceQuotation) relatedDoc = `From: ${doc.sourceQuotation.invoiceNumber}`;
        if (doc.convertedInvoice) relatedDoc = `To: ${doc.convertedInvoice.invoiceNumber}`;

        const row = docSheet.addRow({
            invoiceNumber: doc.invoiceNumber,
            documentType: doc.documentType,
            status: doc.status,
            invoiceDate: formatDate(doc.invoiceDate),
            clientName: doc.clientName,
            clientEmail: doc.clientEmail || '',
            clientPhone: doc.clientPhone || '',
            subtotal: Number(doc.subtotal) || 0,
            gstRate: doc.gstEnabled ? Number(doc.gstRate) || 0 : 0,
            gstAmount: Number(doc.gstAmount) || 0,
            roundOff: Number(doc.roundOff) || 0,
            grandTotal: Number(doc.grandTotal) || 0,
            relatedDoc,
            createdBy: doc.createdBy ? (doc.createdBy.name || doc.createdBy.email) : ''
        });

        // Numeric column formats
        row.getCell('subtotal').numFmt = '#,##0.00';
        row.getCell('gstAmount').numFmt = '#,##0.00';
        row.getCell('roundOff').numFmt = '#,##0.00';
        row.getCell('grandTotal').numFmt = '#,##0.00';
    });

    // -----------------------------------------------------------------
    // SHEET 2: Line Items Detail
    // -----------------------------------------------------------------
    const itemSheet = workbook.addWorksheet('Line Items', {
        views: [{ state: 'frozen', ySplit: 1 }]
    });

    itemSheet.columns = [
        { header: 'Document No', key: 'invoiceNumber', width: 18 },
        { header: 'Document Type', key: 'documentType', width: 14 },
        { header: 'Line #', key: 'lineNumber', width: 8 },
        { header: 'Description', key: 'name', width: 30 },
        { header: 'Quantity', key: 'quantity', width: 12 },
        { header: 'Unit', key: 'unit', width: 10 },
        { header: 'Rate (₹)', key: 'rate', width: 14 },
        { header: 'Amount (₹)', key: 'amount', width: 16 }
    ];

    const itemHeaderRow = itemSheet.getRow(1);
    itemHeaderRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    itemHeaderRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF374151' } // Dark slate
    };
    itemHeaderRow.alignment = { vertical: 'middle', horizontal: 'center' };
    itemHeaderRow.height = 24;

    documents.forEach((doc) => {
        (doc.items || []).forEach((item) => {
            const itemRow = itemSheet.addRow({
                invoiceNumber: doc.invoiceNumber,
                documentType: doc.documentType,
                lineNumber: item.lineNumber,
                name: item.name,
                quantity: Number(item.quantity) || 0,
                unit: item.unit || 'PCS',
                rate: Number(item.rate) || 0,
                amount: Number(item.amount) || 0
            });

            itemRow.getCell('quantity').numFmt = '#,##0.00';
            itemRow.getCell('rate').numFmt = '#,##0.00';
            itemRow.getCell('amount').numFmt = '#,##0.00';
        });
    });

    return workbook.xlsx.writeBuffer();
}

module.exports = {
    generateInvoicesExcel
};
