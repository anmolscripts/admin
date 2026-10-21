'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcrypt');
const prisma = require('../app/config/prisma');
const app = require('../app/app');
const businesses = require('../app/services/business.service');
const invoices = require('../app/services/invoice.service');
const payments = require('../app/services/payment.service');
const posting = require('../app/services/accounting/posting.service');
const rbac = require('../app/services/rbac.service');

describe('Document security with real authentication and database transactions', () => {
    let server, base, a, b, ownerA, ownerB, editor, viewer, authA, authB, authEditor, authViewer, invoiceB, quotationB, paymentB, chequeB;
    const password = 'Document-security-test-2026!';
    const payload = (businessId, extra = {}) => ({ businessId, clientName: 'Security client', invoiceDate: new Date().toISOString().slice(0, 10), gstEnabled: false, items: [{ name: 'Service', quantity: 1, rate: 1000, unit: 'PCS' }], ...extra });

    async function login(user) {
        const page = await fetch(base + '/login');
        const cookie = page.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
        const csrf = (await page.text()).match(/name="_csrf"\s+value="([^"]+)"/)[1];
        const response = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, email: user.email, password }) });
        assert.equal(response.status, 302);
        const authenticatedCookie = response.headers.get('set-cookie').match(/spark\.sid=[^;]+/)[0];
        const dashboard = await fetch(base + '/', { headers: { Cookie: authenticatedCookie } });
        assert.equal(dashboard.status, 200);
        const token = (await dashboard.text()).match(/name="_csrf"\s+value="([^"]+)"|name="csrf-token" content="([^"]+)"/);
        assert.ok(token);
        return { Cookie: authenticatedCookie, Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': token[1] || token[2] };
    }
    const request = (auth, path, method = 'GET', data, headers = {}) => fetch(base + path, { method, redirect: 'manual', headers: { ...auth, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    async function state() {
        return JSON.stringify(await Promise.all([
            prisma.invoice.findMany({ where: { businessId: b.id }, include: { items: true, revisions: true } }),
            prisma.payment.findMany({ where: { businessId: b.id } }),
            prisma.journalEntry.findMany({ where: { businessId: b.id }, include: { lines: true } }),
            prisma.chartOfAccount.findMany({ where: { businessId: b.id } }),
            prisma.numberingSequence.findMany({ where: { businessId: b.id } })
        ]), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    }

    before(async () => {
        require('../scripts/lib/test-database-config').assertDisposableTestDatabase();
        await require('../scripts/guard').validateTestEnv(prisma);
        const stamp = Date.now();
        a = await businesses.createBusiness({ code: `SECA_${stamp}`, name: 'Security A' });
        b = await businesses.createBusiness({ code: `SECB_${stamp}`, name: 'Security B' });
        const hash = await bcrypt.hash(password, 10);
        const ownerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'OWNER' } });
        const memberRole = await prisma.role.findUniqueOrThrow({ where: { name: 'MEMBER' } });
        const viewerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'VIEWER' } });
        const user = (suffix, roleId) => prisma.user.create({ data: { name: suffix, email: `${suffix}-${stamp}@security.test`, password: hash, role: 'STAFF', roleId, active: true, status: 'ACTIVE' } });
        ownerA = await user('owner-a', ownerRole.id);
        ownerB = await user('owner-b', ownerRole.id);
        editor = await user('editor-a', memberRole.id);
        viewer = await user('viewer-a', viewerRole.id);
        for (const [person, business] of [[ownerA, a], [ownerB, b], [editor, a], [viewer, a]]) await businesses.setBusinessMembership(business.id, person.id);
        invoiceB = await invoices.createInvoice(payload(b.id), ownerB.id);
        quotationB = await invoices.createQuotation(payload(b.id), ownerB.id);
        paymentB = (await payments.recordPayment(invoiceB.id, { amount: 100, method: 'CASH' }, ownerB.id)).payment;
        chequeB = (await payments.recordPayment(invoiceB.id, { amount: 50, method: 'CHEQUE', reference: 'security-cheque', paymentDate: new Date().toISOString().slice(0, 10) }, ownerB.id)).payment;
        server = http.createServer(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        authA = await login(ownerA);
        authB = await login(ownerB);
        authEditor = await login(editor);
        authViewer = await login(viewer);
    });

    after(async () => {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        // Fixtures remain only in the explicitly disposable test database.
        await prisma.$disconnect();
    });

    it('blocks every foreign invoice/payment read, including pages, exports, copies and accounting', async () => {
        const encodedPaymentId = [...String(paymentB.id)].map(char => '%' + char.charCodeAt(0).toString(16)).join('');
        const paths = [
            `/api/invoices/${invoiceB.id}`, `/api/invoices/${invoiceB.id}/history`, `/api/invoices/${invoiceB.id}/payments`,
            `/api/invoices/${invoiceB.id}/accounting`, `/api/invoices/${invoiceB.id}/notes`, `/api/invoices/${invoiceB.id}/copy`, `/api/invoices/${invoiceB.id}/pdf`,
            `/documents/${invoiceB.id}`, `/documents/${invoiceB.id}/edit`, `/documents/${invoiceB.id}/print`, `/documents/${invoiceB.id}/pdf`,
            `/documents/new?copyFrom=${invoiceB.id}`, `/credit-debit-notes/new?invoiceId=${invoiceB.id}`, `/api/payments/${paymentB.id}/accounting`,
            `/api/payments/${encodedPaymentId}/accounting`, `/API/PAYMENTS/${paymentB.id}/ACCOUNTING`
        ];
        for (const path of paths) { const res = await request(authA, path); assert.equal(res.status, 404, `${path}: ${await res.text()}`); }
        assert.equal((await request(authA, `/api/payments/${paymentB.id}suffix/accounting`)).status, 400);
        const allowed = await request(authB, `/api/invoices/${invoiceB.id}`);
        assert.equal(allowed.status, 200);
        assert.equal((await allowed.json()).data.businessId, b.id);
        assert.equal((await request(authB, `/api/invoices/${invoiceB.id}/payments`)).status, 200);
        assert.equal((await request(authB, `/api/payments/${paymentB.id}/accounting`)).status, 200);
    });

    it('rejects foreign writes before changing invoices, payments, revisions, balances or journals', async () => {
        const before = await state();
        const attempts = [
            ['PUT', `/api/invoices/${invoiceB.id}`, payload(b.id, { version: invoiceB.version })],
            ['PATCH', `/api/invoices/${invoiceB.id}/status`, { status: 'VOID' }],
            ['DELETE', `/api/invoices/${invoiceB.id}`, {}], ['POST', `/api/invoices/${invoiceB.id}/restore`, {}],
            ['POST', `/api/invoices/${quotationB.id}/convert`, {}], ['POST', `/api/invoices/${quotationB.id}/accept`, {}],
            ['POST', `/api/invoices/${invoiceB.id}/post`, {}], ['POST', `/api/invoices/${invoiceB.id}/payments`, { amount: 1, method: 'CASH' }],
            ['POST', `/api/payments/${paymentB.id}/void`, { reason: 'foreign' }], ['POST', `/api/payments/${paymentB.id}/post`, {}],
            ['POST', `/api/payments/${chequeB.id}/clear`, { clearedAt: new Date().toISOString().slice(0, 10) }]
        ];
        for (const [method, path, body] of attempts) { const res = await request(authA, path, method, body); assert.equal(res.status, 404, `${method} ${path}: ${await res.text()}`); }
        assert.equal(await state(), before);
    });

    it('does not trust forged business selectors or foreign linked records', async () => {
        const list = await request(authA, `/api/invoices?businessId=${b.id}`, 'GET', undefined, { 'X-Business-Id': String(b.id) });
        assert.equal(list.status, 200);
        assert.ok(!(await list.json()).data.some(doc => doc.businessId === b.id));
        const before = await state();
        const forged = await request(authA, '/api/invoices', 'POST', payload(b.id));
        assert.equal(forged.status, 403, await forged.text());
        const copy = await request(authA, '/api/invoices', 'POST', payload(a.id, { copyFromId: invoiceB.id }));
        assert.equal(copy.status, 404, await copy.text());
        const own = await invoices.createQuotation(payload(a.id), ownerA.id);
        const clientB = await prisma.client.create({ data: { businessId: b.id, name: 'Foreign client' } });
        const linked = await request(authA, `/api/invoices/${own.id}`, 'PUT', payload(a.id, { version: own.version, clientId: clientB.id }));
        assert.equal(linked.status, 404, await linked.text());
        assert.equal(await state(), before);
    });

    it('also enforces membership inside mutation services and rejects revoked memberships', async () => {
        const before = await state();
        await assert.rejects(payments.voidPayment(paymentB.id, ownerA.id, 'foreign', { businessId: b.id }), { statusCode: 403 });
        await assert.rejects(payments.recordPayment(invoiceB.id, { amount: 1 }, ownerA.id, { businessId: b.id }), { statusCode: 403 });
        await assert.rejects(payments.clearPayment(chequeB.id, ownerA.id, new Date().toISOString().slice(0, 10), { businessId: b.id }), { statusCode: 403 });
        await assert.rejects(invoices.updateInvoiceStatus(quotationB.id, 'VOID', ownerA.id, {}, { businessId: b.id }), { statusCode: 403 });
        await assert.rejects(posting.postPayment(paymentB.id, { userId: ownerA.id, businessId: b.id }), { statusCode: 403 });
        assert.equal(await state(), before);
        await businesses.revokeBusinessMembership(a.id, ownerA.id);
        assert.equal((await request(authA, '/api/invoices')).status, 403);
        await businesses.setBusinessMembership(a.id, ownerA.id);
    });

    it('rejects mismatched payment parents, journals and foreign deposit accounts', async () => {
        await prisma.payment.update({ where: { id: paymentB.id }, data: { businessId: a.id } });
        try {
            assert.equal((await request(authA, `/api/payments/${paymentB.id}/accounting`)).status, 404);
            await assert.rejects(payments.voidPayment(paymentB.id, ownerB.id), { statusCode: 400 });
        } finally { await prisma.payment.update({ where: { id: paymentB.id }, data: { businessId: b.id } }); }
        const journal = await prisma.journalEntry.findUniqueOrThrow({ where: { idempotencyKey: posting.getPaymentIdempotencyKey(paymentB.id) } });
        await prisma.journalEntry.update({ where: { id: journal.id }, data: { businessId: a.id } });
        try {
            const before = await state();
            assert.equal((await request(authB, `/api/payments/${paymentB.id}/accounting`)).status, 404);
            await assert.rejects(payments.voidPayment(paymentB.id, ownerB.id), { statusCode: 400 });
            assert.equal(await state(), before);
        } finally { await prisma.journalEntry.update({ where: { id: journal.id }, data: { businessId: b.id } }); }
        const accountA = await prisma.chartOfAccount.findFirstOrThrow({ where: { businessId: a.id, systemAccountKey: 'BANK_ACCOUNT' } });
        const before = await state();
        const res = await request(authB, `/api/invoices/${invoiceB.id}/payments`, 'POST', { amount: 1, method: 'BANK_TRANSFER', depositAccountId: accountA.id });
        assert.equal(res.status, 400, await res.text());
        assert.equal(await state(), before);
    });

    it('preserves authorized same-business edits, receipt posting, cheque clearing and void reversals', async () => {
        const own = await invoices.createQuotation(payload(a.id), ownerA.id);
        const edited = await request(authEditor, `/api/invoices/${own.id}`, 'PUT', payload(a.id, { clientName: 'Edited safely', version: own.version }));
        assert.equal(edited.status, 200, await edited.text());
        const receipt = await request(authB, `/api/invoices/${invoiceB.id}/payments`, 'POST', { amount: 10, method: 'CASH' });
        assert.equal(receipt.status, 201);
        const receiptId = (await receipt.json()).data.payment.id;
        assert.equal((await request(authB, `/api/payments/${receiptId}/post`, 'POST', {})).status, 200);
        const cleared = await request(authB, `/api/payments/${chequeB.id}/clear`, 'POST', { clearedAt: new Date().toISOString().slice(0, 10) });
        assert.equal(cleared.status, 200, await cleared.text());
        const voided = await request(authB, `/api/payments/${receiptId}/void`, 'POST', { reason: 'Authorized correction' });
        assert.equal(voided.status, 200, await voided.text());
        const invoice = await invoices.getInvoiceById(invoiceB.id, b.id);
        assert.equal(Number(invoice.paidAmount), 150);
        assert.equal(Number(invoice.outstandingAmount), 850);
        assert.equal((await posting.getPaymentPosting(receiptId)).status, 'REVERSED');
    });

    it('keeps legacy business-1 documents usable without exposing them to other businesses', async () => {
        await businesses.setBusinessMembership(1, ownerA.id);
        try {
            const legacy = await invoices.createInvoice(payload(1), ownerA.id);
            await prisma.invoice.update({ where: { id: legacy.id }, data: { businessId: null } });
            const headers = { 'X-Business-Id': '1' };
            assert.equal((await request(authA, `/api/invoices/${legacy.id}`, 'GET', undefined, headers)).status, 200);
            assert.equal((await request(authB, `/api/invoices/${legacy.id}`)).status, 404);
            const receipt = await request(authA, `/api/invoices/${legacy.id}/payments`, 'POST', { amount: 1, method: 'CASH' }, headers);
            assert.equal(receipt.status, 201);
            const receiptId = (await receipt.json()).data.payment.id;
            assert.equal((await request(authA, `/api/payments/${receiptId}/void`, 'POST', {}, headers)).status, 200);
        } finally { await businesses.revokeBusinessMembership(1, ownerA.id); }
    });

    it('requires the correct permission for status changes and dedicated lifecycle endpoints', async () => {
        const doc = await invoices.createQuotation(payload(a.id), ownerA.id);
        const initialRevisions = await prisma.invoiceRevision.count({ where: { invoiceId: doc.id } });
        for (const status of invoices.ALLOWED_STATUSES) {
            const denied = await request(authViewer, `/api/invoices/${doc.id}/status`, 'PATCH', { status });
            assert.equal(denied.status, 403, `${status}: ${await denied.text()}`);
        }
        for (const [method, path, body] of [
            ['PATCH', `/api/invoices/${doc.id}/status`, { status: 'DELETED' }],
            ['PATCH', `/api/invoices/${doc.id}/status`, { status: ' void ' }],
            ['DELETE', `/api/invoices/${doc.id}`, {}], ['POST', `/api/invoices/${doc.id}/restore`, {}]
        ]) {
            const res = await request(authEditor, path, method, body);
            assert.equal(res.status, 403, `${method} ${path}: ${await res.text()}`);
        }
        await assert.rejects(invoices.updateInvoiceStatus(doc.id, 'VOID', editor.id), { statusCode: 403 });
        await assert.rejects(invoices.softDeleteDocument(doc.id, 'bypass', editor.id), { statusCode: 403 });
        await assert.rejects(invoices.restoreDocument(doc.id, editor.id), { statusCode: 403 });
        assert.equal((await invoices.getInvoiceById(doc.id)).status, 'ACTIVE');
        assert.equal(await prisma.invoiceRevision.count({ where: { invoiceId: doc.id } }), initialRevisions);
        for (const status of ['INACTIVE', 'ACTIVE']) {
            const res = await request(authEditor, `/api/invoices/${doc.id}/status`, 'PATCH', { status });
            assert.equal(res.status, 200, await res.text());
        }
        assert.equal((await request(authA, `/api/invoices/${doc.id}/status`, 'PATCH', { status: 'DELETED' })).status, 200);
        assert.equal((await request(authEditor, `/api/invoices/${doc.id}/status`, 'PATCH', { status: 'ACTIVE' })).status, 400);
        assert.equal((await request(authA, `/api/invoices/${doc.id}/restore`, 'POST', {})).status, 200);
        assert.equal((await request(authA, `/api/invoices/${doc.id}/status`, 'PATCH', { status: 'VOID' })).status, 200);
        assert.equal((await request(authA, `/api/invoices/${doc.id}/status`, 'PATCH', { status: 'ACTIVE' })).status, 400);
        rbac.invalidateUser(editor.id);
    });

    it('honors independent DELETE, RESTORE and VOID grants without requiring EDIT', async () => {
        const doc = await invoices.createQuotation(payload(a.id), ownerA.id);
        async function grant(action) {
            const permission = await prisma.permission.findUniqueOrThrow({ where: { module_action: { module: 'DOCUMENTS', action } } });
            await prisma.userPermission.create({ data: { userId: viewer.id, permissionId: permission.id } });
            rbac.invalidateUser(viewer.id);
        }
        await grant('DELETE');
        assert.equal((await request(authViewer, `/api/invoices/${doc.id}/status`, 'PATCH', { status: 'VOID' })).status, 403);
        assert.equal((await request(authViewer, `/api/invoices/${doc.id}/status`, 'PATCH', { status: 'DELETED' })).status, 200);
        assert.equal((await request(authViewer, `/api/invoices/${doc.id}/restore`, 'POST', {})).status, 403);
        await grant('RESTORE');
        assert.equal((await request(authViewer, `/api/invoices/${doc.id}/restore`, 'POST', {})).status, 200);
        await prisma.userPermission.deleteMany({ where: { userId: viewer.id } });
        await grant('VOID');
        assert.equal((await request(authViewer, `/api/invoices/${doc.id}/status`, 'PATCH', { status: 'DELETED' })).status, 403);
        assert.equal((await request(authViewer, `/api/invoices/${doc.id}/status`, 'PATCH', { status: 'VOID' })).status, 200);
    });
});
