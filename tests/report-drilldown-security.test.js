'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

test('all report detail renderers display hostile saved values as text without executable markup', async t => {
    const hostile = '<img src=x onerror="window.injected = true"><svg onload="window.injected = true"></svg> & "quoted" <script>window.injected = true</script>';
    const item = { lineNumber: hostile, name: hostile, hsnSac: hostile, unit: hostile, quantity: 2, rate: 10, amount: 20 };
    const cases = [
        ['INVOICE', { id: 1, documentType: 'INVOICE', invoiceNumber: hostile, clientName: hostile, clientGSTIN: hostile, status: 'ACTIVE', items: [item], grandTotal: 20 }],
        ['QUOTATION', { id: 1, documentType: 'QUOTATION', invoiceNumber: hostile, clientName: hostile, status: 'ACTIVE', items: [item], grandTotal: 20 }],
        ['CREDIT_NOTE', { id: 1, noteNumber: hostile, noteType: 'CREDIT', client: { name: hostile }, originalInvoiceNumber: hostile, reason: hostile, items: [item] }],
        ['MANUAL', { id: 1, entryNumber: hostile, sourceType: hostile, sourceId: hostile, financialYear: { code: hostile }, narration: hostile, lines: [{ account: { code: hostile, name: hostile }, client: { name: hostile }, description: hostile, debit: 20 }] }],
        ['SUPPLIER_BILL', { id: 1, billNumber: hostile, supplier: { name: hostile }, grandTotal: 20 }],
        ['PURCHASE_ORDER', { id: 1, poNumber: hostile, supplier: { name: hostile }, grandTotal: 20 }],
        ['UNKNOWN', null]
    ];
    for (const [sourceType, data] of cases) await t.test(sourceType, async () => {
        const dom = new JSDOM('<body></body>', { url: 'http://report.test', runScripts: 'dangerously' });
        try {
            dom.window.bootstrap = { Modal: { getOrCreateInstance: () => ({ show() {} }) } };
            dom.window.fetch = async () => ({ ok: true, json: async () => ({ data }) });
            dom.window.eval(fs.readFileSync('assets/js/report-drilldown.js', 'utf8'));
            const row = dom.window.document.createElement('tr');
            Object.assign(row.dataset, { sourceType, sourceId: '1', sourceRef: hostile });
            await dom.window.SparkReportDrilldown.open(row);
            const body = dom.window.document.getElementById('reportModalBody');
            for (const image of body.querySelectorAll('img')) image.dispatchEvent(new dom.window.Event('error'));
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(dom.window.injected, undefined);
            assert.equal(body.querySelectorAll('img, svg, script, [onerror], [onload]').length, 0);
            assert.ok(body.textContent.includes(hostile), 'Saved text must remain readable, with its characters preserved');
            if (data) assert.ok(body.querySelector('table') || body.querySelector('.row'), 'Report layout remains present');
        } finally { dom.window.close(); }
    });
});

test('report URL identifiers cannot escape into paths or HTML attributes', async () => {
    const dom = new JSDOM('<body></body>', { url: 'http://report.test', runScripts: 'dangerously' });
    try {
        const id = '1/../../other?x=" onmouseover="window.injected=true';
        let requested;
        dom.window.bootstrap = { Modal: { getOrCreateInstance: () => ({ show() {} }) } };
        dom.window.console.warn = () => {};
        dom.window.fetch = async url => { requested = url; return { ok: false, status: 404 }; };
        dom.window.eval(fs.readFileSync('assets/js/report-drilldown.js', 'utf8'));
        const row = dom.window.document.createElement('tr');
        Object.assign(row.dataset, { sourceType: 'MANUAL', sourceId: id, journalId: id, sourceRef: 'Record' });
        await dom.window.SparkReportDrilldown.open(row);
        assert.equal(requested, '/api/journals/' + encodeURIComponent(id));
        const link = dom.window.document.querySelector('#reportModalBody a');
        assert.equal(link.getAttribute('href'), '/reports/journals/' + encodeURIComponent(id));
        assert.equal(dom.window.document.querySelectorAll('[onmouseover]').length, 0);
        link.dispatchEvent(new dom.window.Event('mouseover'));
        assert.equal(dom.window.injected, undefined);
    } finally { dom.window.close(); }
});
