'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ejs = require('ejs');
const { JSDOM, VirtualConsole } = require('jsdom');
const root = path.resolve(__dirname, '..');
const script = name => fs.readFileSync(path.join(root, name), 'utf8');

async function dom(html, editor = false) {
    const instance = new JSDOM(html, { url: 'http://audit.invalid/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
    const w = instance.window;
    w.HTMLElement.prototype.scrollIntoView = function () {};
    w.fetch = () => { throw new Error('DOM tests must not access a server'); };
    w.eval(script('assets/libs/tom-select/js/tom-select.complete.min.js'));
    w.eval(script('assets/js/spark-tom-select.js'));
    if (editor) {
        w.__SELLER_STATE_CODE__ = '27';
        w.__EDITOR_MODE__ = 'create';
        w.__DOCUMENT_TYPE__ = 'QUOTATION';
        w.__AVAILABLE_UNITS__ = [{ symbol: 'PCS', name: 'Pieces' }];
        w.__INITIAL_DOCUMENT__ = { invoiceDate: '2026-10-19', clientName: 'Test client', gstEnabled: true, gstRate: 18,
            items: [{ name: 'Equipment', quantity: 2, unit: 'PCS', rate: 100 }] };
        w.eval(script('assets/js/editor.js'));
    }
    await new Promise(resolve => w.addEventListener('load', resolve, { once: true }));
    return instance;
}

test('SweetAlert hidden selects stay native and long Bootstrap dialogs keep their header and footer visible', async()=>{
    const instance=await dom('<select id="ordinary"><option>One</option></select><div class="swal2-container"><select class="swal2-select" id="alert-select" style="display:none"><option>Hidden</option></select></div><main><div class="modal"><div class="modal-dialog modal-dialog-centered"><div class="modal-content"><div class="modal-body">Form</div></div></div></div></main>');
    try{
        const w=instance.window;
        assert.ok(w.document.getElementById('ordinary').tomselect);
        assert.equal(w.document.getElementById('alert-select').tomselect,undefined);
        assert.equal(w.document.querySelector('.swal2-container .ts-wrapper'),null);
        w.eval(script('assets/js/spark-modals.js'));
        assert.ok(w.document.querySelector('.modal-dialog').classList.contains('modal-dialog-scrollable'));
        assert.equal(w.document.querySelector('.modal').parentElement,w.document.body);
    }finally{instance.window.close();}
});

test('dynamically inserted body modals also receive centered and scrollable dialog behaviour',async()=>{
 const instance=await dom('');try{const w=instance.window;w.eval(script('assets/js/spark-modals.js'));const modal=w.document.createElement('div');modal.className='modal';modal.innerHTML='<div class="modal-dialog"><div class="modal-content"><div class="modal-body">Details</div></div></div>';w.document.body.append(modal);modal.dispatchEvent(new w.Event('show.bs.modal',{bubbles:true}));assert.ok(modal.querySelector('.modal-dialog').classList.contains('modal-dialog-centered'));assert.ok(modal.querySelector('.modal-dialog').classList.contains('modal-dialog-scrollable'));}finally{instance.window.close();}
});

test('enhanced selects have one shell and one clear action, with a single native change', async () => {
    const instance = await dom('<div class="input-group"><select class="form-select-custom" id="client"><option value="">Choose</option><option value="1">Customer</option></select><button id="btn-clear-client">Clear</button></div><select id="plain"><option value="">Choose</option><option value="a">Alpha</option></select>');
    try {
        const w = instance.window, select = w.document.getElementById('client');
        assert.ok(!select.tomselect.wrapper.classList.contains('form-select-custom'));
        assert.equal(select.tomselect.wrapper.querySelectorAll('.clear-button').length, 0);
        let changes = 0, inline = 0;
        select.addEventListener('change', () => changes++);
        select.onchange = () => inline++;
        select.tomselect.setValue('1');
        assert.equal(select.value, '1');
        assert.equal(changes, 1);
        assert.equal(inline, 1);
        const plain = w.document.getElementById('plain');
        plain.tomselect.setValue('a');
        const button = plain.tomselect.control.querySelector('button.clear-button');
        assert.equal(button.type, 'button');
        button.click();
        assert.equal(plain.value, '');
        plain.value = 'a';
        assert.ok(plain.tomselect.wrapper.classList.contains('has-real-value'));
        plain.value = '';
        assert.ok(!plain.tomselect.wrapper.classList.contains('has-real-value'));
    } finally { instance.window.close(); }
});

test('dropdown closes on viewport scroll but remains usable when scrolling its own options', async () => {
    const instance = await dom('<select id="sample"><option value="">Choose</option><option value="a">Alpha</option></select>');
    try {
        const w = instance.window, ts = w.document.getElementById('sample').tomselect;
        ts.open();
        assert.equal(ts.isOpen, true);
        ts.dropdown_content.dispatchEvent(new w.Event('scroll'));
        assert.equal(ts.isOpen, true);
        w.document.dispatchEvent(new w.Event('scroll'));
        assert.equal(ts.isOpen, false);
        ts.destroy();
    } finally { instance.window.close(); }
});

test('small modal dropdowns are searchable and remain inside the focus trap outside clipped content', async () => {
    const instance = await dom('<div class="modal"><div class="modal-content"><div class="modal-body"><select id="sample"><option value="0">Nil</option><option value="18">Standard</option></select></div></div></div>');
    try {
        const w = instance.window, ts = w.document.getElementById('sample').tomselect;
        assert.equal(ts.dropdown.parentElement, w.document.querySelector('.modal'));
        assert.ok(ts.dropdown.querySelector('input'));
        ts.control.getBoundingClientRect = () => ({ left: 120, bottom: 240, width: 180 });
        ts.dropdown.parentElement.getBoundingClientRect = () => ({ left: 20, top: 30 });
        ts.open();
        assert.equal(ts.dropdown.style.left, '100px');
        assert.equal(ts.dropdown.style.top, '210px');
        assert.equal(ts.dropdown.style.width, '180px');
        ts.setTextboxValue('Standard');
        ts.refreshOptions(false);
        assert.equal(ts.dropdown_content.querySelectorAll('[data-selectable]').length, 1);
        ts.setValue('18');
        assert.equal(w.document.getElementById('sample').value, '18');
    } finally { instance.window.close(); }
});
test('removed dynamic rows release their detached dropdowns and select instances', async () => {
    const instance = await dom('<div id="row"><select id="sample"><option value="">Choose</option><option value="a">Alpha</option></select></div>');
    try {
        const w = instance.window, select = w.document.getElementById('sample');
        const dropdown = select.tomselect.dropdown;
        w.document.getElementById('row').remove();
        await new Promise(resolve => w.queueMicrotask(resolve));
        assert.equal(select.tomselect, undefined);
        assert.equal(dropdown.isConnected, false);
    } finally { instance.window.close(); }
});

test('actual editor updates interstate tax and fills shipping from billing without duplicate client clear controls', async () => {
    const html = await ejs.renderFile(path.join(root, 'app/views/documents/editor.ejs'), {
        pageTitle: 'New Quotation', pageSubtitle: 'Audit', mode: 'create', documentType: 'QUOTATION', document: null,
        csrfToken: 'audit-only', sellerStateCode: '27', user: { role: 'ADMIN', name: 'Auditor' },
        currentPath: '/documents/new', projectList: [], unitList: [{ symbol: 'PCS', name: 'Pieces' }],
        clientList: [{ id: 1, name: 'Interstate customer', email: 'audit@example.test', stateCode: '06', billingAddress: 'Audit address', shippingAddress: '' }]
    });
    const instance = await dom(html, true);
    try {
        const w = instance.window, d = w.document;
        d.getElementById('client-select').tomselect.setValue('1');
        assert.equal(d.getElementById('summary-cgst-label').textContent, 'IGST (18.00%):');
        assert.ok(d.getElementById('summary-sgst-label').parentElement.classList.contains('d-none'));
        assert.equal(d.getElementById('shipping-address').value, 'Audit address');
        assert.equal(d.getElementById('shipping-address').readOnly, true);
        assert.equal(d.getElementById('client-select').tomselect.control.querySelectorAll('.clear-button').length, 0);
        d.getElementById('place-of-supply').value = '27';
        d.getElementById('place-of-supply').dispatchEvent(new w.Event('input'));
        assert.equal(d.getElementById('summary-cgst-label').textContent, 'CGST (9.00%):');
        assert.ok(!d.getElementById('summary-sgst-label').parentElement.classList.contains('d-none'));
        assert.equal(d.getElementById('summary-grandtotal').textContent, '₹236.00');
    } finally { instance.window.close(); }
});
