'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const express = require('express');
const { csrfProtection } = require('../app/middleware/csrf.middleware');

function client(fetchImpl, token = 'page-session-token') {
    const page = fs.readFileSync(require.resolve('../app/views/settings/index.ejs'), 'utf8');
    const start=page.indexOf('(function() {',page.indexOf('TEMPLATE SYSTEM INTERACTIVITY'));
    const script = page.slice(start,page.indexOf('</script>',start));
    const context = {
        fetch: fetchImpl,
        document: {
            querySelector: () => token ? { value: token } : null,
            querySelectorAll: () => [], getElementById: () => null
        }
    };
    vm.runInNewContext(script.replace(/\}\)\(\);\s*$/, 'globalThis.templateRequest = templateRequest;})();'), context);
    return context.templateRequest;
}

test('actual settings requests pass real CSRF protection for POST and DELETE', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { csrfToken: 'page-session-token' }; next(); });
    app.use(csrfProtection);
    app.post('/api/settings/templates/active', (req, res) => res.json({ success: true, activeTemplates: req.body }));
    app.post('/api/settings/templates/save', (req, res) => res.json({ success: true, template: req.body }));
    app.delete('/api/settings/templates/custom-test', (req, res) => res.json({ success: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.on('listening', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        const rejected = await fetch(base + '/api/settings/templates/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(rejected.status, 403);
        const request = client((url, options) => fetch(base + url, options));
        const result = await request('/api/settings/templates/active', { method: 'POST', body: JSON.stringify({ invoiceTemplate: 'rajesh-signature', quotationTemplate: 'rajesh-signature' }) });
        assert.equal(result.activeTemplates.invoiceTemplate, 'rajesh-signature');
        assert.equal((await request('/api/settings/templates/save', { method: 'POST', body: '{"name":"Test"}' })).template.name, 'Test');
        assert.equal((await request('/api/settings/templates/custom-test', { method: 'DELETE' })).success, true);
    } finally { await new Promise(resolve => server.close(resolve)); }
});

test('settings display server errors and expired-session guidance', async () => {
    const denied = client(async () => new Response(JSON.stringify({ success: false, message: 'CSRF token missing or invalid.' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(() => denied('/api/settings/templates/active', {}), /CSRF token missing or invalid/);
    const expired = client(async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }));
    await assert.rejects(() => expired('/api/settings/templates/active', {}), /session may have expired/);
    const missing = client(() => { throw new Error('Request must not be sent'); }, '');
    await assert.rejects(() => missing('/api/settings/templates/active', {}), /refresh this page/);
});
