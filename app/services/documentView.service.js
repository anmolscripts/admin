/**
 * Document View Model Service
 * Single source of truth for normalizing Document data into a standard
 * presentation view model consumed identically by Browser Print and PDF generation.
 */

function formatCurrency(val) {
    const num = Number(val) || 0;
    return '₹' + num.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatDate(dateVal) {
    if (!dateVal) return '—';
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
}

/**
 * Builds a normalized, immutable document view model
 * @param {Object} doc - Raw invoice/quotation record from Prisma (including items and relations)
 * @param {Object} businessProfile - Optional business profile settings
 * @returns {Object} Normalised document view model
 */
function buildDocumentViewModel(doc, businessProfile = {}) {
    if (!doc) {
        throw new Error('Document data is required to build document view model.');
    }

    const isQuotation = doc.documentType === 'QUOTATION';
    const documentType = isQuotation ? 'QUOTATION' : 'INVOICE';
    const documentTitle = isQuotation ? 'QUOTATION' : 'TAX INVOICE';
    const typeLabel = isQuotation ? 'Quotation' : 'Invoice';

    // Theme & Aesthetics
    const themeColor = isQuotation ? '#0070f3' : '#1b5e20';
    const themeBg = isQuotation ? '#eff6ff' : '#f0fdf4';
    const themeBorder = isQuotation ? '#bfdbfe' : '#bbf7d0';

    // Seller Information (server authoritative, falls back to profile defaults)
    const seller = {
        name: doc.sellerName || businessProfile.legalName || 'Spark ERP Technologies Pvt Ltd',
        gstin: doc.sellerGSTIN || businessProfile.gstin || '29AAAAA0000A1Z5',
        address: doc.sellerAddress || businessProfile.address || 'Tech Park Tower, 4th Floor, MG Road, Bengaluru, Karnataka 560001',
        email: doc.sellerEmail || businessProfile.email || 'billing@sparkadmin.com',
        phone: doc.sellerPhone || businessProfile.phone || '+91 80 4000 1234',
        stateCode: doc.sellerStateCode || '29',
        bankName: businessProfile.bankName || 'HDFC Bank Ltd',
        accountNumber: businessProfile.accountNumber || '50200012345678',
        ifscCode: businessProfile.ifscCode || 'HDFC0001234',
        branch: businessProfile.branch || 'Koramangala Branch',
        upiId: businessProfile.upiId || 'sparkerp@hdfcbank'
    };

    // Client Information
    const client = {
        name: doc.clientName || 'Valued Customer',
        email: doc.clientEmail || '—',
        phone: doc.clientPhone || '—',
        gstin: doc.clientGSTIN || 'Unregistered',
        billingAddress: doc.billingAddress || 'No billing address provided',
        shippingAddress: doc.shippingAddress || doc.billingAddress || 'Same as billing address',
        placeOfSupply: doc.placeOfSupplyStateCode
            ? `State Code ${doc.placeOfSupplyStateCode}`
            : (doc.sellerStateCode ? `State Code ${doc.sellerStateCode}` : 'Default State')
    };

    // Due / Validity Dates
    const invoiceDateFormatted = formatDate(doc.invoiceDate);
    const invoiceDateObj = new Date(doc.invoiceDate);
    let dueOrExpiryDateObj;
    if (doc.dueDate || doc.validUntil) {
        dueOrExpiryDateObj = new Date(doc.dueDate || doc.validUntil);
    } else {
        dueOrExpiryDateObj = new Date(invoiceDateObj);
        dueOrExpiryDateObj.setDate(dueOrExpiryDateObj.getDate() + (isQuotation ? 15 : 30));
    }
    const dueOrExpiryDateFormatted = formatDate(dueOrExpiryDateObj);
    const dueOrExpiryLabel = isQuotation ? 'Valid Until' : 'Due Date';

    // Status & Watermark
    const status = doc.status || 'ACTIVE';
    let statusClass = 'badge-active';
    if (status === 'INACTIVE') statusClass = 'badge-inactive';
    if (status === 'VOID') statusClass = 'badge-void';
    if (status === 'DELETED') statusClass = 'badge-deleted';

    let watermark = null;
    if (status === 'VOID') watermark = 'VOID';
    else if (status === 'DELETED') watermark = 'DELETED';

    // Normalized Line Items
    const items = (doc.items || []).map((item, index) => {
        const qty = Number(item.quantity) || 0;
        const rate = Number(item.rate) || 0;
        const amount = Number(item.amount) || (qty * rate);
        return {
            lineNumber: item.lineNumber || (index + 1),
            name: item.name || 'Unnamed Item',
            hsnSac: item.hsnSac || '—',
            quantity: qty.toFixed(2),
            unit: item.unit || 'units',
            rate: rate.toFixed(2),
            amount: amount.toFixed(2),
            formattedRate: formatCurrency(rate),
            formattedAmount: formatCurrency(amount)
        };
    });

    // Financials & Tax breakdown
    const subtotal = Number(doc.subtotal) || 0;
    const gstRate = Number(doc.gstRate) || 0;
    const gstAmount = Number(doc.gstAmount) || 0;
    const cgstAmount = Number(doc.cgstAmount) || 0;
    const sgstAmount = Number(doc.sgstAmount) || 0;
    const igstAmount = Number(doc.igstAmount) || 0;
    const isInterState = igstAmount > 0;
    const roundOff = Number(doc.roundOff) || 0;
    const grandTotal = Number(doc.grandTotal) || 0;
    const paidAmount = Number(doc.paidAmount) || 0;
    const outstandingAmount = isQuotation ? 0 : Math.max(0, Number(doc.outstandingAmount !== undefined ? doc.outstandingAmount : (grandTotal - paidAmount)));

    const financials = {
        gstEnabled: Boolean(doc.gstEnabled),
        gstRate: gstRate.toFixed(2),
        subtotal: subtotal.toFixed(2),
        gstAmount: gstAmount.toFixed(2),
        cgstAmount: cgstAmount.toFixed(2),
        sgstAmount: sgstAmount.toFixed(2),
        igstAmount: igstAmount.toFixed(2),
        isInterState,
        roundOff: roundOff.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        paidAmount: paidAmount.toFixed(2),
        outstandingAmount: outstandingAmount.toFixed(2),
        formattedSubtotal: formatCurrency(subtotal),
        formattedGstAmount: formatCurrency(gstAmount),
        formattedCgstAmount: formatCurrency(cgstAmount),
        formattedSgstAmount: formatCurrency(sgstAmount),
        formattedIgstAmount: formatCurrency(igstAmount),
        formattedRoundOff: formatCurrency(roundOff),
        formattedGrandTotal: formatCurrency(grandTotal),
        formattedPaidAmount: formatCurrency(paidAmount),
        formattedOutstandingAmount: formatCurrency(outstandingAmount)
    };

    // Reference relations
    const reference = {
        sourceQuotation: doc.sourceQuotation ? {
            id: doc.sourceQuotation.id,
            invoiceNumber: doc.sourceQuotation.invoiceNumber
        } : null,
        convertedInvoice: doc.convertedInvoice ? {
            id: doc.convertedInvoice.id,
            invoiceNumber: doc.convertedInvoice.invoiceNumber
        } : null
    };

    // Payment History for Invoices
    const payments = (doc.payments || []).map((p) => ({
        id: p.id,
        receiptNumber: p.receiptNumber,
        amount: Number(p.amount).toFixed(2),
        formattedAmount: formatCurrency(p.amount),
        paymentMethod: p.paymentMethod,
        paymentDate: formatDate(p.paymentDate),
        status: p.status,
        notes: p.notes
    }));

    // Notes and terms
    const notes = doc.remarks || 'Thank you for your business!';
    const terms = doc.termsAndConditions || (isQuotation
        ? 'This quotation is valid for 15 days from the date of issue. Prices are subject to final confirmation.'
        : 'Payment is due within 30 days from invoice date. Goods once sold will not be taken back without prior authorization.');

    // UPI Payment String for quick scan on invoices
    const upiLink = !isQuotation && seller.upiId
        ? `upi://pay?pa=${seller.upiId}&pn=${encodeURIComponent(seller.name)}&am=${financials.grandTotal}&cu=INR&tn=${encodeURIComponent(doc.invoiceNumber)}`
        : null;

    return {
        id: doc.id,
        documentType,
        documentTitle,
        typeLabel,
        invoiceNumber: doc.invoiceNumber,
        status,
        statusClass,
        watermark,
        themeColor,
        themeBg,
        themeBorder,
        isQuotation,
        dates: {
            invoiceDate: invoiceDateFormatted,
            invoiceDateRaw: doc.invoiceDate,
            dueOrExpiryDate: dueOrExpiryDateFormatted,
            dueOrExpiryLabel
        },
        seller,
        client,
        items,
        financials,
        reference,
        payments,
        notes,
        terms,
        upiLink
    };
}

module.exports = {
    buildDocumentViewModel,
    formatCurrency,
    formatDate
};
