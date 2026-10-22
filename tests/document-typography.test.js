'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const pdf = require('../app/services/pdf.service');
const templates = require('../app/services/template.service');
const { document: fixture, profile } = require('../scripts/preview-rajesh-template');

test('document footer uses current business address without changing the seller snapshot or leaking another business', async () => {
    const raw = { ...fixture('QUOTATION'), businessId: 1, sellerAddress: 'Historical address' };
    const current = { ...profile, businessId: 1, address: 'Current registered address <safe>' };
    const model = pdf.buildDocumentViewModel(raw, current);
    assert.equal(model.seller.address, 'Historical address');
    assert.equal(model.seller.footerAddress, current.address);
    const html = await pdf.renderDocumentHtml(raw, current, templates.getTemplate('rajesh-signature', 1));
    const dom = new JSDOM(html);
    try {
        const doc = dom.window.document;
        assert.ok(doc.querySelector('.footer-address').textContent.includes(current.address));
        assert.equal(doc.querySelector('.footer-address safe'), null);
        assert.equal(doc.querySelector('.bill-to-label').textContent, raw.invoiceNumber);
        assert.equal(doc.querySelector('.doc-auth-meta'), null);
        assert.ok(!doc.body.textContent.includes('Document reference'));
        assert.ok(!doc.body.textContent.includes('QUOTATION FOR'));
        assert.equal(doc.body.textContent.split(raw.invoiceNumber).length - 1, 1);
        assert.ok(html.includes('data:font/ttf;base64,'));
        assert.ok(!html.includes('fonts.googleapis.com'));
    } finally { dom.window.close(); }
    assert.equal(pdf.buildDocumentViewModel(raw, { ...current, businessId: 2 }).seller.footerAddress, 'Historical address');
});

test('Montserrat font files include the rupee glyph and both app and standalone exports load local fonts', () => {
    for (const style of ['Regular', 'SemiBold', 'Bold', 'Italic']) {
        const font = require('fontkit').openSync(`assets/fonts/montserrat/Montserrat-${style}.ttf`);
        assert.match(font.familyName, /^Montserrat(?: SemiBold)?$/);
        assert.ok(font.hasGlyphForCodePoint(0x20b9));
    }
    assert.match(fs.readFileSync('assets/css/theme.css', 'utf8'), /@import url\('fonts.css'\)/);
    assert.ok(require('../app/services/itemTransfer.service').printHtml([], { companyName: 'Test', timeZone: 'Asia/Kolkata' }).includes('data:font/ttf;base64,'));
});

const prisma = require('../app/config/prisma');
require('node:test').after(() => prisma.$disconnect());

test('existing documents show current catalog descriptions only from their own business, with separate quantity/unit cells', async () => {
    require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
    const businessService = require('../app/services/business.service');
    const key = require('node:crypto').randomUUID();
    const a = await businessService.createBusiness({ code: `BRAND_A_${key}`, name: 'Brand A', gstin: '27AABCA1234A1Z5', stateCode: '27' });
    const b = await businessService.createBusiness({ code: `BRAND_B_${key}`, name: 'Brand B', gstin: '27AABCA1234A1Z5', stateCode: '27' });
    const name = `Brand item ${key}`;
    const brand = 'Acme Brand <img src=x onerror=alert(1)>';
    const item = await prisma.item.create({ data: { businessId: a.id, name, description: brand } });
    await prisma.item.create({ data: { businessId: b.id, name, description: 'Other business secret brand' } });
    const views = require('../app/services/documentView.service');
    const raw = { ...fixture('QUOTATION'), businessId: a.id, items: [{ name, quantity: 2, unit: 'PCS', rate: 10, amount: 20 }] };
    const snapshot = JSON.stringify(raw);
    const enriched = await views.withCatalogDescriptions(raw);
    assert.equal(enriched.items[0].description, brand);
    assert.equal(JSON.stringify(raw), snapshot);
    for (const type of ['QUOTATION', 'INVOICE']) {
        const dom = new JSDOM(await pdf.renderDocumentHtml({ ...enriched, documentType: type }, profile, templates.getTemplate('rajesh-signature', a.id)));
        try {
            const row = dom.window.document.querySelector('.doc-items-table tbody tr');
            assert.equal(row.querySelector('.item-description').textContent, brand);
            assert.equal(row.querySelector('.item-description img'), null);
            assert.equal(row.querySelector('.col-qty').textContent.trim(), '2.00');
            assert.equal(row.querySelector('.col-unit').textContent.trim(), 'PCS');
            assert.equal(row.cells.length, 7);
            assert.ok(!dom.window.document.body.textContent.includes('Other business secret brand'));
            const rule = [...dom.window.document.styleSheets].flatMap(s => [...s.cssRules]).find(r => r.selectorText === '.item-description');
            assert.equal(rule.style['font-size'], 'inherit');
            assert.equal(rule.style.color, 'rgb(16, 60, 169)');
            const contactRule = [...dom.window.document.styleSheets].flatMap(s => [...s.cssRules]).find(r => r.selectorText === '.contact-item');
            const iconRule = [...dom.window.document.styleSheets].flatMap(s => [...s.cssRules]).find(r => r.selectorText === '.contact-icon');
            assert.equal(contactRule.style['align-items'], 'center');
            assert.equal(iconRule.style.color, 'rgb(213, 154, 40)');
        } finally { dom.window.close(); }
    }
    await prisma.item.update({ where: { id: item.id }, data: { description: 'Updated current brand' } });
    assert.equal((await views.withCatalogDescriptions(raw)).items[0].description, 'Updated current brand');
    assert.equal((await views.withCatalogDescriptions({ ...raw, businessId: null })).items[0].description, undefined);
});

