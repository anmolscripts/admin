'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const path = require('path');
const templates = require('../app/services/template.service');
const views = require('../app/services/documentView.service');
const { document, profile } = require('../scripts/preview-rajesh-template');
const file = path.resolve(__dirname, '../app/views/documents/templates/document.ejs');
test('both document types render current customer, contact, dates and amounts', async () => {
    for (const type of ['INVOICE', 'QUOTATION']) {
        const raw = document(type);
        raw.clientName = 'Dynamic Customer <script>alert(1)</script>';
        const model = views.buildDocumentViewModel(raw, { ...profile, phone: '+91 12345 67890' });
        const html = await ejs.renderFile(file, { model, templateConfig: templates.getTemplate('rajesh-signature', 1) });
        assert.ok(html.includes('Dynamic Customer &lt;script&gt;'));
        assert.ok(!html.includes('<script>alert(1)</script>'));
        for (const value of ['+91 12345 67890', profile.website, raw.invoiceNumber, '₹1,59,300.00', 'Industrial Servo', 'data:image/png;base64,']) assert.ok(html.includes(value), value);
        assert.ok(!html.includes('123 Business Avenue'));
        assert.ok(!html.includes('undefined'));
        assert.ok(!html.replace(/data:(?:image\/png|font\/ttf);base64,[A-Za-z0-9+/=]+/g, '').includes('NaN'));
    }
});
test('new template supports complete preview data and keeps old fallback', async () => {
    assert.equal(templates.getTemplate('missing', 1).id, 'modern-minimal');
    const model = templates.buildSampleViewModel('rajesh-signature', 'QUOTATION', profile);
    const html = await ejs.renderFile(file, { model, templateConfig: templates.getTemplate('rajesh-signature', 1) });
    assert.ok(html.includes('Industrial Servo'));
    assert.ok(html.includes('₹12,150.00'));
    assert.ok(!html.includes('undefined'));
});
test('tax treatment and void watermark remain driven by the document', async () => {
    const raw = { ...document('INVOICE'), status: 'VOID', cgstAmount: 0, sgstAmount: 0, igstAmount: 24300 };
    const config = templates.getTemplate('rajesh-signature', 1);
    const html = await ejs.renderFile(file, { model: views.buildDocumentViewModel(raw, profile), templateConfig: config });
    assert.ok(html.includes('watermark-void'));
    assert.ok(html.includes('IGST (18.00%)'));
    assert.ok(!html.includes('CGST (9.00%)'));
    const withoutGst = await ejs.renderFile(file, { model: views.buildDocumentViewModel({ ...raw, gstEnabled: false }, profile), templateConfig: config });
    assert.ok(!withoutGst.includes('IGST (18.00%)'));
});
