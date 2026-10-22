'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM } = require('jsdom');
const pdf = require('../app/services/pdf.service');
const templates = require('../app/services/template.service');
const { document: fixture, profile } = require('../scripts/preview-rajesh-template');
const config = templates.getTemplate('rajesh-signature', 1);

test('quotation header is elevated and concise while invoices retain their thank-you and customer contact details', async () => {
    for (const type of ['QUOTATION', 'INVOICE']) {
        const dom = new JSDOM(await pdf.renderDocumentHtml(fixture(type), profile, config));
        try {
            const doc = dom.window.document;
            assert.ok(doc.querySelector('.doc-generation-statement').textContent.includes('does not require a physical signature'));
            assert.ok(!doc.body.textContent.includes('Authorized Signatory for'));
            if (type === 'QUOTATION') {
                assert.equal(doc.querySelector('.ri-seller-identity .doc-hero-title').textContent.trim(), 'QUOTATION');
                assert.equal(doc.querySelector('.doc-meta-section .doc-hero-title'), null);
                assert.equal(doc.querySelector('.doc-status-badge'), null);
                assert.equal(doc.querySelector('.doc-thank-you-box'), null);
                assert.ok(!doc.querySelector('.bill-to-section').textContent.includes('procurement@apexprecision.com'));
                assert.ok(!doc.querySelector('.bill-to-section').textContent.includes('Place of Supply:'));
            } else {
                assert.ok(doc.querySelector('.doc-thank-you-box'));
                assert.ok(doc.querySelector('.doc-status-badge'));
                assert.ok(doc.querySelector('.bill-to-section').textContent.includes('procurement@apexprecision.com'));
            }
        } finally { dom.window.close(); }
    }
    const voidHtml = await pdf.renderDocumentHtml({ ...fixture('QUOTATION'), status: 'VOID' }, profile, config);
    assert.ok(voidHtml.includes('watermark-void'), 'Removing the status badge must retain the financial lifecycle watermark');
    const boilerplate = new JSDOM(await pdf.renderDocumentHtml({ ...fixture('QUOTATION'), remarks: 'Thank you for your business!' }, profile, config));
    assert.equal(boilerplate.window.document.querySelector('.doc-remarks-content'), null);
    boilerplate.window.close();
});

test('print and PDF share the same paginated content, safe page spacing and repeating branding', async () => {
    const raw = fixture('QUOTATION', 12);
    const model = pdf.buildDocumentViewModel(raw, profile);
    const html = await pdf.renderDocumentHtml(raw, profile, config);
    const printed = await ejs.renderFile(path.resolve('app/views/documents/print.ejs'), { model, templateConfig: config });
    const dom = new JSDOM(html), printDom = new JSDOM(printed);
    try {
        const doc = dom.window.document;
        assert.equal(doc.querySelector('#unified-document-root').outerHTML, printDom.window.document.querySelector('#unified-document-root').outerHTML);
        assert.ok(doc.querySelector('.ri-page-frame > thead .ri-page-top-space'));
        assert.ok(doc.querySelector('.ri-page-frame > tfoot .ri-page-bottom-space'));
        assert.equal(doc.querySelectorAll('.doc-items-table tbody tr').length, 12);
        const rules = [...doc.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.conditionText === 'print').flatMap(rule => [...rule.cssRules]);
        function property(selector, key) {
            const element = doc.querySelector(selector);
            return rules.filter(rule => rule.selectorText && element.matches(rule.selectorText)).map(rule => rule.style.getPropertyValue(key)).filter(Boolean).at(-1);
        }
        for (const selector of ['.ri-top-art', '.ri-watermark', '.doc-footer-bar', '.ri-bottom-art']) assert.equal(property(selector, 'position'), 'fixed', selector);
        assert.equal(parseFloat(property('.ri-bottom-art', 'bottom')), 0);
        assert.ok(parseFloat(property('.ri-page-top-space', 'height')) >= 12);
        assert.ok(parseFloat(property('.ri-page-bottom-space', 'height')) >= 30);
        assert.equal(property('.ri-page-top-space', 'height'), '13mm');
        assert.equal(property('.ri-bottom-art', 'height'), '17mm');
        assert.ok(parseFloat(property('.ri-watermark', 'opacity')) <= .06);
        assert.equal(property('#unified-document-root', 'isolation'), 'auto');
    } finally { dom.window.close(); printDom.window.close(); }
});

test('actual Chromium PDFs retain a single page for short documents and paginate long documents without blank trailing sheets', async () => {
    for (const type of ['QUOTATION', 'INVOICE']) {
        const buffer = await pdf.generateDocumentPdf(fixture(type), profile, config);
        assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
        assert.equal((buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length, 1, type);
    }
    const buffer = await pdf.generateDocumentPdf(fixture('QUOTATION', 36), profile, config);
    const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    assert.ok(pages >= 3 && pages <= 6, `Unexpected long-document pagination: ${pages}`);
});
