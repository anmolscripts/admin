const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const ejs = require('ejs');
const documentViewService = require('./documentView.service');

const TEMPLATE_PATH = path.join(__dirname, '../views/documents/templates/document.ejs');

class PdfConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PdfConfigurationError';
        this.statusCode = 500;
    }
}

class PdfRenderingError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PdfRenderingError';
        this.statusCode = 500;
    }
}

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
                    return reject(new PdfRenderingError(`Headless browser PDF rendering failed: ${execErr.message}`));
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
 * Generate a PDF Buffer for a quotation or invoice document.
 * Enforces the Single Document Presentation Source architecture:
 * Database Document -> buildDocumentViewModel() -> templates/document.ejs -> PDF
 *
 * If no browser executable is available, fails clearly with a controlled configuration error.
 *
 * @param {Object} document - Full document record with items and relations
 * @param {Object} businessProfile - Optional business profile settings
 * @returns {Promise<Buffer>} PDF file buffer
 */
async function generateDocumentPdf(document, businessProfile = {}) {
    const browserPath = findBrowserExecutable();

    if (!browserPath) {
        throw new PdfConfigurationError(
            'PDF generation engine (Chrome/Chromium) is unavailable on this system. ' +
            'Please install Google Chrome or Chromium, or configure CHROME_BIN in your environment.'
        );
    }

    const html = await renderDocumentHtml(document, businessProfile);
    return renderPdfWithBrowser(browserPath, html);
}

module.exports = {
    generateDocumentPdf,
    renderDocumentHtml,
    findBrowserExecutable,
    buildDocumentViewModel: documentViewService.buildDocumentViewModel,
    formatMoney: documentViewService.formatCurrency,
    formatDate: documentViewService.formatDate,
    PdfConfigurationError,
    PdfRenderingError
};
