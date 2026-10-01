const PDFDocument = require('pdfkit');

/**
 * Format currency to 2 decimal places
 */
function formatMoney(amount) {
    const num = Number(amount) || 0;
    return num.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

/**
 * Format date to DD/MM/YYYY
 */
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
 * Generate a PDF Buffer for a quotation or invoice document
 * @param {Object} document - Full document record with items and relations
 * @param {Object} businessProfile - Optional business profile settings
 * @returns {Promise<Buffer>} PDF file buffer
 */
function generateDocumentPdf(document, businessProfile = {}) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 40,
                info: {
                    Title: `${document.invoiceNumber} - ${document.documentType}`,
                    Author: 'Spark Admin',
                    Subject: `${document.documentType} ${document.invoiceNumber}`,
                    Keywords: `${document.documentType}, Invoice, Quotation`
                }
            });

            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfData = Buffer.concat(buffers);
                resolve(pdfData);
            });
            doc.on('error', reject);

            const isQuotation = document.documentType === 'QUOTATION';
            const title = isQuotation ? 'QUOTATION' : 'TAX INVOICE';
            const primaryColor = isQuotation ? '#0070f3' : '#1b5e20';
            const darkColor = '#1f2937';
            const mutedColor = '#6b7280';
            const lightBg = '#f3f4f6';

            // Seller Info
            const sellerName = document.sellerName || businessProfile.legalName || 'Spark ERP Technologies Pvt Ltd';
            const sellerGstin = document.sellerGSTIN || businessProfile.gstin || '29AAAAA0000A1Z5';
            const sellerAddress = document.sellerAddress || businessProfile.address || 'Tech Park Tower, 4th Floor, MG Road, Bengaluru, Karnataka 560001';
            const sellerEmail = document.sellerEmail || businessProfile.email || 'billing@sparkadmin.com';
            const sellerPhone = document.sellerPhone || businessProfile.phone || '+91 80 4000 1234';

            // -------------------------------------------------------------
            // VOID / DELETED Watermark
            // -------------------------------------------------------------
            if (document.status === 'VOID' || document.status === 'DELETED') {
                doc.save();
                doc.rotate(-30, { origin: [300, 400] });
                doc.fontSize(72).fillColor(document.status === 'VOID' ? '#ef4444' : '#9ca3af').opacity(0.18);
                doc.text(document.status, 150, 360, { align: 'center', width: 300 });
                doc.restore();
            }

            // -------------------------------------------------------------
            // HEADER SECTION
            // -------------------------------------------------------------
            doc.fillColor(primaryColor).fontSize(20).font('Helvetica-Bold').text(sellerName, 40, 40);
            doc.fillColor(mutedColor).fontSize(9).font('Helvetica')
                .text(`GSTIN: ${sellerGstin}`, 40, 65)
                .text(sellerAddress, 40, 78, { width: 280 })
                .text(`Phone: ${sellerPhone} | Email: ${sellerEmail}`, 40, 102);

            // Document Title & Number (Top Right)
            doc.fillColor(primaryColor).fontSize(18).font('Helvetica-Bold').text(title, 340, 40, { align: 'right', width: 215 });
            doc.fillColor(darkColor).fontSize(12).font('Helvetica-Bold').text(document.invoiceNumber, 340, 65, { align: 'right', width: 215 });
            
            // Status Badge Text
            let statusDisplay = document.status;
            doc.fillColor(
                document.status === 'ACTIVE' ? '#1b5e20' :
                document.status === 'INACTIVE' ? '#b45309' :
                document.status === 'VOID' ? '#b91c1c' : '#4b5563'
            ).fontSize(10).font('Helvetica-Bold').text(`STATUS: ${statusDisplay}`, 340, 82, { align: 'right', width: 215 });

            // Horizontal Divider
            doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(40, 120).lineTo(555, 120).stroke();

            // -------------------------------------------------------------
            // DOCUMENT METADATA & CLIENT SECTION
            // -------------------------------------------------------------
            const metaTop = 130;

            // Bill To Box
            doc.rect(40, metaTop, 250, 100).fillAndStroke(lightBg, '#e5e7eb');
            doc.fillColor(darkColor).fontSize(10).font('Helvetica-Bold').text('BILL TO:', 50, metaTop + 8);
            doc.fillColor(darkColor).fontSize(10).font('Helvetica-Bold').text(document.clientName, 50, metaTop + 22, { width: 230 });
            doc.fillColor(mutedColor).fontSize(8.5).font('Helvetica')
                .text(document.billingAddress || 'No billing address provided', 50, metaTop + 36, { width: 230, height: 32 })
                .text(`Email: ${document.clientEmail || '—'}`, 50, metaTop + 72)
                .text(`Phone: ${document.clientPhone || '—'}`, 50, metaTop + 84);

            // Document Dates & Supply Box
            doc.rect(305, metaTop, 250, 100).fillAndStroke(lightBg, '#e5e7eb');
            doc.fillColor(darkColor).fontSize(9).font('Helvetica-Bold').text('DOCUMENT DETAILS:', 315, metaTop + 8);
            
            doc.fillColor(mutedColor).fontSize(8.5).font('Helvetica');
            doc.text('Date:', 315, metaTop + 24);
            doc.fillColor(darkColor).font('Helvetica-Bold').text(formatDate(document.invoiceDate), 410, metaTop + 24);

            doc.fillColor(mutedColor).font('Helvetica').text(isQuotation ? 'Valid Until:' : 'Due Date:', 315, metaTop + 38);
            const dueDateCalc = new Date(document.invoiceDate);
            dueDateCalc.setDate(dueDateCalc.getDate() + (isQuotation ? 15 : 30));
            doc.fillColor(darkColor).font('Helvetica-Bold').text(formatDate(dueDateCalc), 410, metaTop + 38);

            doc.fillColor(mutedColor).font('Helvetica').text('Place of Supply:', 315, metaTop + 52);
            doc.fillColor(darkColor).font('Helvetica-Bold').text(document.placeOfSupplyStateCode ? `State Code ${document.placeOfSupplyStateCode}` : 'Default State', 410, metaTop + 52);

            if (document.sourceQuotation) {
                doc.fillColor(mutedColor).font('Helvetica').text('Source Quote:', 315, metaTop + 66);
                doc.fillColor(primaryColor).font('Helvetica-Bold').text(document.sourceQuotation.invoiceNumber, 410, metaTop + 66);
            } else if (document.convertedInvoice) {
                doc.fillColor(mutedColor).font('Helvetica').text('Converted Inv:', 315, metaTop + 66);
                doc.fillColor(primaryColor).font('Helvetica-Bold').text(document.convertedInvoice.invoiceNumber, 410, metaTop + 66);
            }

            // -------------------------------------------------------------
            // LINE ITEMS TABLE
            // -------------------------------------------------------------
            const tableTop = 245;
            doc.rect(40, tableTop, 515, 22).fill(primaryColor);

            // Table Header Labels
            doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold');
            doc.text('#', 45, tableTop + 6, { width: 25, align: 'center' });
            doc.text('Item Description', 75, tableTop + 6, { width: 220, align: 'left' });
            doc.text('Qty', 300, tableTop + 6, { width: 50, align: 'right' });
            doc.text('Unit', 355, tableTop + 6, { width: 45, align: 'center' });
            doc.text('Rate (₹)', 405, tableTop + 6, { width: 65, align: 'right' });
            doc.text('Amount (₹)', 475, tableTop + 6, { width: 75, align: 'right' });

            let yPos = tableTop + 24;
            const items = document.items || [];

            items.forEach((item, index) => {
                const rowBg = index % 2 === 1 ? '#f9fafb' : '#ffffff';
                doc.rect(40, yPos, 515, 20).fill(rowBg);

                doc.fillColor(darkColor).fontSize(8.5).font('Helvetica');
                doc.text(String(item.lineNumber || index + 1), 45, yPos + 5, { width: 25, align: 'center' });
                doc.font('Helvetica-Bold').text(item.name || 'Item', 75, yPos + 5, { width: 220, align: 'left', ellipsis: true });
                doc.font('Helvetica').text(Number(item.quantity).toFixed(2), 300, yPos + 5, { width: 50, align: 'right' });
                doc.text(item.unit || 'PCS', 355, yPos + 5, { width: 45, align: 'center' });
                doc.text(formatMoney(item.rate), 405, yPos + 5, { width: 65, align: 'right' });
                doc.font('Helvetica-Bold').text(formatMoney(item.amount), 475, yPos + 5, { width: 75, align: 'right' });

                yPos += 20;

                // Add page break if items table exceeds page capacity
                if (yPos > 680 && index < items.length - 1) {
                    doc.addPage();
                    yPos = 40;
                }
            });

            // Table Bottom Border
            doc.strokeColor('#d1d5db').lineWidth(1).moveTo(40, yPos).lineTo(555, yPos).stroke();
            yPos += 15;

            // -------------------------------------------------------------
            // TOTALS & TERMS SECTION
            // -------------------------------------------------------------
            if (yPos > 650) {
                doc.addPage();
                yPos = 40;
            }

            const totalsBoxY = yPos;

            // Left Side: Terms and Remarks
            doc.fillColor(darkColor).fontSize(8.5).font('Helvetica-Bold').text('Terms & Conditions:', 40, totalsBoxY);
            doc.fillColor(mutedColor).fontSize(7.5).font('Helvetica')
                .text(document.termsAndConditions || 'Payment is due within stated terms. Goods once sold are not returnable.', 40, totalsBoxY + 12, { width: 280, height: 40 });

            doc.fillColor(darkColor).fontSize(8.5).font('Helvetica-Bold').text('Notes & Remarks:', 40, totalsBoxY + 56);
            doc.fillColor(mutedColor).fontSize(7.5).font('Helvetica')
                .text(document.remarks || 'Thank you for your business.', 40, totalsBoxY + 68, { width: 280, height: 35 });

            // Right Side: Server-Authoritative Totals Box
            const totalsX = 330;
            const totalsW = 225;
            doc.rect(totalsX, totalsBoxY, totalsW, 115).fillAndStroke('#ffffff', '#e5e7eb');

            let curY = totalsBoxY + 8;
            function addTotalRow(label, value, bold = false, color = darkColor, size = 8.5) {
                doc.fillColor(mutedColor).fontSize(size).font('Helvetica').text(label, totalsX + 10, curY);
                doc.fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(`₹ ${value}`, totalsX + 100, curY, { width: totalsW - 115, align: 'right' });
                curY += 15;
            }

            addTotalRow('Subtotal:', formatMoney(document.subtotal));

            if (document.gstEnabled) {
                const numericRate = Number(document.gstRate);
                const halfRate = (numericRate / 2).toFixed(2);
                const totalGst = Number(document.gstAmount);
                const halfGst = Math.round((totalGst / 2) * 100) / 100;
                const remainingGst = Math.round((totalGst - halfGst) * 100) / 100;

                addTotalRow(`CGST (${halfRate}%):`, formatMoney(halfGst));
                addTotalRow(`SGST (${halfRate}%):`, formatMoney(remainingGst));
                addTotalRow(`Total GST (${numericRate.toFixed(2)}%):`, formatMoney(document.gstAmount));
            } else {
                addTotalRow('GST (0%):', '0.00 (Exempt/Nil)');
            }

            if (Number(document.roundOff) !== 0) {
                addTotalRow('Round Off:', formatMoney(document.roundOff));
            }

            // Grand Total Row (Highlighted)
            doc.rect(totalsX, curY - 2, totalsW, 24).fill(primaryColor);
            doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold').text('Grand Total:', totalsX + 10, curY + 4);
            doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold').text(`₹ ${formatMoney(document.grandTotal)}`, totalsX + 100, curY + 4, { width: totalsW - 115, align: 'right' });

            // -------------------------------------------------------------
            // FOOTER SECTION
            // -------------------------------------------------------------
            const footerY = 760;
            doc.strokeColor('#e5e7eb').lineWidth(0.5).moveTo(40, footerY).lineTo(555, footerY).stroke();
            doc.fillColor(mutedColor).fontSize(7.5).font('Helvetica')
                .text('This is a computer-generated document and requires no physical signature.', 40, footerY + 8, { align: 'center', width: 515 })
                .text(`Generated on ${formatDate(new Date())} | Spark Admin ERP`, 40, footerY + 18, { align: 'center', width: 515 });

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

module.exports = {
    generateDocumentPdf
};
