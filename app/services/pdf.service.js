const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const ejs = require('ejs');
const PDFDocument = require('pdfkit');
const documentViewService = require('./documentView.service');

const TEMPLATE_PATH = path.join(__dirname, '../views/documents/templates/document.ejs');

/**
 * Locate Chrome, Chromium, or Edge executable across standard OS locations
 */
function findBrowserExecutable() {
    if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
    if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;

    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe') : null,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ].filter(Boolean);

    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Render the unified document template to an HTML string
 * Consumes the exact same Normalized Document View Model as Print.
 */
async function renderDocumentHtml(document, businessProfile = {}) {
    const model = documentViewService.buildDocumentViewModel(document, businessProfile);
    const bodyHtml = await ejs.renderFile(TEMPLATE_PATH, { model });
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${model.invoiceNumber} - ${model.documentType}</title>
  <style>
    @page {
      size: A4;
      margin: 10mm 12mm;
    }
    body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
  </style>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

/**
 * Generate PDF buffer using headless browser rendering of the shared document template
 */
function renderPdfWithBrowser(browserPath, htmlContent) {
    return new Promise((resolve, reject) => {
        const uniqueId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const tempHtml = path.join(os.tmpdir(), `${uniqueId}.html`);
        const tempPdf = path.join(os.tmpdir(), `${uniqueId}.pdf`);

        fs.writeFile(tempHtml, htmlContent, 'utf8', (writeErr) => {
            if (writeErr) return reject(writeErr);

            const args = [
                '--headless',
                '--disable-gpu',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--no-pdf-header-footer',
                '--run-all-compositor-stages-before-draw',
                `--print-to-pdf=${tempPdf}`,
                tempHtml
            ];

            execFile(browserPath, args, { timeout: 15000 }, (execErr) => {
                if (execErr) {
                    try { if (fs.existsSync(tempHtml)) fs.unlinkSync(tempHtml); } catch (_) {}
                    try { if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf); } catch (_) {}
                    return reject(execErr);
                }

                fs.readFile(tempPdf, (readErr, data) => {
                    try { if (fs.existsSync(tempHtml)) fs.unlinkSync(tempHtml); } catch (_) {}
                    try { if (fs.existsSync(tempPdf)) fs.unlinkSync(tempPdf); } catch (_) {}

                    if (readErr) return reject(readErr);
                    resolve(data);
                });
            });
        });
    });
}

/**
 * Fallback PDF generator using PDFKit consuming the same Normalized Document View Model
 */
function renderPdfWithPdfKit(model) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: 40,
                info: {
                    Title: `${model.invoiceNumber} - ${model.documentType}`,
                    Author: 'Spark Admin',
                    Subject: `${model.documentType} ${model.invoiceNumber}`
                }
            });

            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => resolve(Buffer.concat(buffers)));
            doc.on('error', reject);

            const primaryColor = model.themeColor;
            const darkColor = '#1f2937';
            const mutedColor = '#6b7280';
            const lightBg = '#f8fafc';

            // Watermark for VOID / DELETED
            if (model.watermark) {
                doc.save();
                doc.rotate(-30, { origin: [300, 400] });
                doc.fontSize(72).fillColor(model.watermark === 'VOID' ? '#ef4444' : '#9ca3af').opacity(0.18);
                doc.text(model.watermark, 150, 360, { align: 'center', width: 300 });
                doc.restore();
            }

            // Header: Seller Info
            doc.fillColor(primaryColor).fontSize(18).font('Helvetica-Bold').text(model.seller.name, 40, 40);
            doc.fillColor(mutedColor).fontSize(9).font('Helvetica')
                .text(`GSTIN: ${model.seller.gstin}`, 40, 62)
                .text(model.seller.address, 40, 74, { width: 280 })
                .text(`Phone: ${model.seller.phone} | Email: ${model.seller.email}`, 40, 96);

            // Document Title & Number
            doc.fillColor(primaryColor).fontSize(18).font('Helvetica-Bold').text(model.documentTitle, 340, 40, { align: 'right', width: 215 });
            doc.fillColor(darkColor).fontSize(12).font('Helvetica-Bold').text(model.invoiceNumber, 340, 62, { align: 'right', width: 215 });
            doc.fillColor(primaryColor).fontSize(9.5).font('Helvetica-Bold').text(`STATUS: ${model.status}`, 340, 78, { align: 'right', width: 215 });

            // Divider
            doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(40, 114).lineTo(555, 114).stroke();

            // Client & Metadata Box
            const metaTop = 124;
            doc.rect(40, metaTop, 250, 95).fillAndStroke(lightBg, '#e5e7eb');
            doc.fillColor(darkColor).fontSize(9.5).font('Helvetica-Bold').text('BILL TO:', 50, metaTop + 8);
            doc.fillColor(darkColor).fontSize(10).font('Helvetica-Bold').text(model.client.name, 50, metaTop + 22, { width: 230 });
            doc.fillColor(mutedColor).fontSize(8.5).font('Helvetica')
                .text(model.client.billingAddress, 50, metaTop + 36, { width: 230, height: 28 })
                .text(`GSTIN: ${model.client.gstin}`, 50, metaTop + 66)
                .text(`Phone: ${model.client.phone} | Email: ${model.client.email}`, 50, metaTop + 78);

            doc.rect(305, metaTop, 250, 95).fillAndStroke(lightBg, '#e5e7eb');
            doc.fillColor(darkColor).fontSize(9.5).font('Helvetica-Bold').text('DOCUMENT DETAILS:', 315, metaTop + 8);
            doc.fillColor(mutedColor).fontSize(8.5).font('Helvetica');
            doc.text('Date:', 315, metaTop + 24);
            doc.fillColor(darkColor).font('Helvetica-Bold').text(model.dates.invoiceDate, 410, metaTop + 24);

            doc.fillColor(mutedColor).font('Helvetica').text(`${model.dates.dueOrExpiryLabel}:`, 315, metaTop + 38);
            doc.fillColor(darkColor).font('Helvetica-Bold').text(model.dates.dueOrExpiryDate, 410, metaTop + 38);

            doc.fillColor(mutedColor).font('Helvetica').text('Place of Supply:', 315, metaTop + 52);
            doc.fillColor(darkColor).font('Helvetica-Bold').text(model.client.placeOfSupply, 410, metaTop + 52);

            if (model.reference.sourceQuotation) {
                doc.fillColor(mutedColor).font('Helvetica').text('Source Quote:', 315, metaTop + 66);
                doc.fillColor(primaryColor).font('Helvetica-Bold').text(model.reference.sourceQuotation.invoiceNumber, 410, metaTop + 66);
            }

            // Items Table Header
            const tableTop = 230;
            doc.rect(40, tableTop, 515, 20).fill(primaryColor);
            doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold');
            doc.text('#', 45, tableTop + 5, { width: 20, align: 'center' });
            doc.text('DESCRIPTION', 70, tableTop + 5, { width: 210 });
            doc.text('HSN/SAC', 285, tableTop + 5, { width: 50, align: 'center' });
            doc.text('QTY', 340, tableTop + 5, { width: 40, align: 'right' });
            doc.text('UNIT', 385, tableTop + 5, { width: 40, align: 'center' });
            doc.text('RATE', 430, tableTop + 5, { width: 55, align: 'right' });
            doc.text('AMOUNT', 490, tableTop + 5, { width: 60, align: 'right' });

            let y = tableTop + 24;
            model.items.forEach((item, idx) => {
                if (idx % 2 === 1) {
                    doc.rect(40, y - 3, 515, 18).fill('#f9fafb');
                }
                doc.fillColor(mutedColor).fontSize(8.5).font('Helvetica').text(String(item.lineNumber), 45, y, { width: 20, align: 'center' });
                doc.fillColor(darkColor).font('Helvetica-Bold').text(item.name, 70, y, { width: 210 });
                doc.fillColor(mutedColor).font('Helvetica').text(item.hsnSac, 285, y, { width: 50, align: 'center' });
                doc.fillColor(darkColor).text(item.quantity, 340, y, { width: 40, align: 'right' });
                doc.fillColor(mutedColor).text(item.unit, 385, y, { width: 40, align: 'center' });
                doc.fillColor(darkColor).text(item.formattedRate, 430, y, { width: 55, align: 'right' });
                doc.fillColor(darkColor).font('Helvetica-Bold').text(item.formattedAmount, 490, y, { width: 60, align: 'right' });
                y += 18;
            });

            // Bottom Section: Summary & Totals
            y = Math.max(y + 12, 380);
            doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(40, y).lineTo(555, y).stroke();
            y += 10;

            // Bank Details
            if (!model.isQuotation) {
                doc.rect(40, y, 260, 80).fillAndStroke(lightBg, '#e5e7eb');
                doc.fillColor(darkColor).fontSize(8.5).font('Helvetica-Bold').text('BANK & REMITTANCE DETAILS', 50, y + 8);
                doc.fillColor(mutedColor).fontSize(8).font('Helvetica')
                    .text(`Bank: ${model.seller.bankName}`, 50, y + 22)
                    .text(`A/C: ${model.seller.accountNumber} | IFSC: ${model.seller.ifscCode}`, 50, y + 34)
                    .text(`Branch: ${model.seller.branch}`, 50, y + 46)
                    .text(`UPI ID: ${model.seller.upiId}`, 50, y + 58);
            }

            // Totals Table (Right)
            const totX = 350;
            const totValX = 475;
            let totY = y;

            const addTotLine = (lbl, val, isBold = false, color = darkColor) => {
                doc.fillColor(mutedColor).fontSize(8.5).font('Helvetica').text(lbl, totX, totY);
                doc.fillColor(color).font(isBold ? 'Helvetica-Bold' : 'Helvetica').text(val, totValX, totY, { align: 'right', width: 75 });
                totY += 14;
            };

            addTotLine('Subtotal:', model.financials.formattedSubtotal);
            if (model.financials.gstEnabled) {
                if (model.financials.isInterState) {
                    addTotLine(`IGST (${model.financials.gstRate}%):`, model.financials.formattedIgstAmount);
                } else {
                    const half = (Number(model.financials.gstRate) / 2).toFixed(2);
                    addTotLine(`CGST (${half}%):`, model.financials.formattedCgstAmount);
                    addTotLine(`SGST (${half}%):`, model.financials.formattedSgstAmount);
                }
            }
            if (Number(model.financials.roundOff) !== 0) {
                addTotLine('Round Off:', model.financials.formattedRoundOff);
            }

            totY += 2;
            doc.rect(totX - 5, totY - 3, 210, 18).fill(model.themeBg);
            doc.fillColor(primaryColor).fontSize(10).font('Helvetica-Bold').text('Grand Total:', totX, totY);
            doc.text(model.financials.formattedGrandTotal, totValX - 5, totY, { align: 'right', width: 80 });
            totY += 18;

            if (!model.isQuotation) {
                addTotLine('Paid Amount:', model.financials.formattedPaidAmount, false, '#166534');
                addTotLine('Outstanding:', model.financials.formattedOutstandingAmount, true, '#dc2626');
            }

            // Terms
            const termsY = Math.max(totY + 15, y + 95);
            doc.fillColor(darkColor).fontSize(8).font('Helvetica-Bold').text('TERMS & CONDITIONS:', 40, termsY);
            doc.fillColor(mutedColor).fontSize(7.5).font('Helvetica').text(model.terms, 40, termsY + 10, { width: 515 });

            // Footer
            doc.strokeColor('#e5e7eb').lineWidth(0.5).moveTo(40, 770).lineTo(555, 770).stroke();
            doc.fillColor(mutedColor).fontSize(7.5).font('Helvetica').text(`Generated via Spark ERP • ${model.invoiceNumber}`, 40, 775);
            doc.text('Authorized Signatory', 450, 775, { align: 'right', width: 105 });

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Generate a PDF Buffer for a quotation or invoice document.
 * Consumes the ONE shared view model and shared template.
 * @param {Object} document - Full document record with items and relations
 * @param {Object} businessProfile - Optional business profile settings
 * @returns {Promise<Buffer>} PDF file buffer
 */
async function generateDocumentPdf(document, businessProfile = {}) {
    const model = documentViewService.buildDocumentViewModel(document, businessProfile);
    const browserPath = findBrowserExecutable();

    if (browserPath) {
        try {
            const html = await renderDocumentHtml(document, businessProfile);
            const pdfBuffer = await renderPdfWithBrowser(browserPath, html);
            return pdfBuffer;
        } catch (browserErr) {
            console.warn('[PDF GENERATION] Browser rendering failed, falling back to PDFKit:', browserErr.message);
        }
    }

    // High-fidelity fallback using the exact same normalized view model
    return renderPdfWithPdfKit(model);
}

module.exports = {
    generateDocumentPdf,
    renderDocumentHtml,
    buildDocumentViewModel: documentViewService.buildDocumentViewModel,
    formatMoney: documentViewService.formatCurrency,
    formatDate: documentViewService.formatDate
};
