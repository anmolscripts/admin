'use strict';
// Isolated visual fixtures only. Never creates invoices or changes database records.
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const templates = require('../app/services/template.service');
const views = require('../app/services/documentView.service');
const pdf = require('../app/services/pdf.service');

const out = path.resolve(__dirname, '../evidence/rajesh-template');
const profile = {
    legalName: 'Rajesh International', address: '42, Industrial Estate, Sector 18, Gurugram, Haryana 122015',
    phone: '+91 98765 43210', email: 'accounts@rajeshinternational.com', website: 'www.rajeshinternational.com',
    gstin: '06AABCR1234F1Z5', stateCode: '06', bankName: 'HDFC Bank', accountNumber: '50200012345678', ifsc: 'HDFC0000123'
};
function document(type, count = 3) {
    return {
        id: 0, businessId: 1, documentType: type, invoiceNumber: type === 'QUOTATION' ? 'RI/QT/2026/0042' : 'RI/INV/2026/0089',
        status: 'ACTIVE', invoiceDate: '2026-10-19', dueDate: '2026-11-18', validUntil: '2026-11-03',
        sellerName: profile.legalName, clientName: 'Apex Precision Engineering Works', clientGSTIN: '06AAACP4455Q1ZT',
        clientPhone: '+91 98220 11223', clientEmail: 'procurement@apexprecision.com',
        billingAddress: 'Plot 89, Udyog Vihar, Phase IV, Gurugram, Haryana 122016', placeOfSupplyStateCode: '06',
        items: Array.from({ length: count }, (_, index) => ({
            name: ['Industrial Servo Drive Motor 5.5kW', 'Programmable Logic Controller Unit', 'Installation & Commissioning'][index % 3],
            description: count > 3 ? 'Detailed scope: supply, installation, testing, commissioning and verification of industrial equipment. '.repeat(index % 3 + 1) : '',
            quantity: [2,1,16][index % 3], rate: [34500,42000,1500][index % 3], amount: [69000,42000,24000][index % 3],
            unit: ['PCS','UNIT','HRS'][index % 3], hsnSac: ['8501','8537','9983'][index % 3]
        })),
        subtotal: 135000 * count / 3, gstEnabled: true, gstRate: 18, cgstAmount: 12150 * count / 3,
        sgstAmount: 12150 * count / 3, gstAmount: 24300 * count / 3, grandTotal: 159300 * count / 3,
        paidAmount: 0, termsAndConditions: '1. Delivery within 7–10 working days from order confirmation.\n2. Payment: 50% advance; balance before dispatch.\n3. Prices include GST as shown. Freight charged separately.',
        remarks: 'Please quote the document number in all correspondence.'
    };
}
async function main() {
    fs.mkdirSync(out, { recursive: true });
    for (const [name, doc] of [['invoice', document('INVOICE')], ['quotation', document('QUOTATION')], ['long-quotation', document('QUOTATION', 36)]]) {
        const config = templates.getTemplate('rajesh-signature', 1);
        const html = await pdf.renderDocumentHtml(doc, profile, config);
        fs.writeFileSync(path.join(out, name + '.html'), html);
        fs.writeFileSync(path.join(out, name + '.pdf'), await pdf.generateDocumentPdf(doc, profile, config));
    }
    const model = templates.buildSampleViewModel('rajesh-signature', 'INVOICE', profile);
    const templateConfig = templates.getTemplate('rajesh-signature', 1);
    const body = await ejs.renderFile(path.resolve(__dirname, '../app/views/documents/templates/document.ejs'), { model, templateConfig });
    const content = body.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, '');
    if (content.includes('undefined') || content.includes('NaN')) throw new Error('Incomplete preview view model');
    console.log('Invoice, quotation, long quotation PDFs and gallery preview rendered: ' + out);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { document, profile };
