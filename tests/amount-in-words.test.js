'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const views = require('../app/services/documentView.service');
const pdf = require('../app/services/pdf.service');
const templates = require('../app/services/template.service');
const { document: fixture, profile } = require('../scripts/preview-rajesh-template');

test('Indian amount wording preserves exact rupees and paise across lakh/crore boundaries', () => {
    for (const [value, expected] of [
        ['0.00', 'Rupees Zero Only'],
        ['1.01', 'Rupees One and One Paisa Only'],
        ['0.50', 'Rupees Zero and Fifty Paise Only'],
        ['107852.00', 'Rupees One Lakh Seven Thousand Eight Hundred and Fifty Two Only'],
        ['10000000.25', 'Rupees One Crore and Twenty Five Paise Only'],
        ['1000000000000.01', 'Rupees One Lakh Crore and One Paisa Only'],
        ['-0.50', 'Minus Rupees Zero and Fifty Paise Only'],
        ['-0.00', 'Rupees Zero Only']
    ]) assert.equal(views.amountInIndianWords(value), expected, value);
    for (const invalid of ['', null, undefined, 'NaN', '12.001', '12x']) assert.throws(() => views.amountInIndianWords(invalid));
});

test('amount in words uses the grand total and terms follow below the totals in print/PDF and gallery previews', async () => {
    for (const type of ['QUOTATION', 'INVOICE']) {
        const raw = { ...fixture(type), grandTotal: '107852.25', termsAndConditions: 'Delivery within seven days.', remarks: 'Keep this instruction.' };
        const html = await pdf.renderDocumentHtml(raw, profile, templates.getTemplate('rajesh-signature', 1));
        const dom = new JSDOM(html), doc = dom.window.document;
        try {
            const row = doc.querySelector('.doc-terms-totals');
            assert.ok(row.querySelector('.doc-amount-in-words').textContent.includes('One Lakh Seven Thousand Eight Hundred and Fifty Two and Twenty Five Paise Only'));
            assert.equal(row.querySelector('.terms-text-content'), null);
            assert.equal(row.nextElementSibling.querySelector('.terms-text-content').textContent, raw.termsAndConditions);
            assert.ok(row.nextElementSibling.textContent.includes(raw.remarks));
            assert.ok(row.querySelector('.total-badge-val').textContent.includes('1,07,852.25'));
            assert.equal(raw.grandTotal, '107852.25');
        } finally { dom.window.close(); }
    }
    assert.ok(templates.buildSampleViewModel('rajesh-signature', 'QUOTATION', profile).financials.amountInWords.includes('One Lakh Fifty Nine Thousand Three Hundred'));
});
