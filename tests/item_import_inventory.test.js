'use strict';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const itemService = require('../app/services/item.service');

describe('Phase 5: Inventory & Item CSV Import with Dry-Run Preview Tests', () => {
    let server = null;
    let baseUrl = null;
    let authCookie = null;
    let csrfToken = null;
    let testAdmin = null;

    function extractCookie(res) {
        const setCookie = res.headers.get('set-cookie');
        if (!setCookie) return null;
        const match = setCookie.match(/spark\.sid=[^;]+/);
        return match ? match[0] : null;
    }

    function extractCsrfToken(html) {
        const match = html.match(/name="_csrf"\s+value="([^"]+)"/) || html.match(/id="csrf-token"\s+value="([^"]+)"/);
        return match ? match[1] : null;
    }

    before(async () => {
        testAdmin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        assert.ok(testAdmin, 'Admin user must exist');

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        const getLoginRes = await fetch(`${baseUrl}/login`);
        const initialCookie = extractCookie(getLoginRes);
        const loginCsrf = extractCsrfToken(await getLoginRes.text());

        const loginRes = await fetch(`${baseUrl}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': initialCookie || ''
            },
            body: new URLSearchParams({
                email: testAdmin.email,
                password: process.env.SEED_ADMIN_PASSWORD || 'test-secret-2026',
                _csrf: loginCsrf || ''
            }),
            redirect: 'manual'
        });

        authCookie = extractCookie(loginRes) || initialCookie;

        const dashRes = await fetch(`${baseUrl}/`, {
            headers: { Cookie: authCookie }
        });
        csrfToken = extractCsrfToken(await dashRes.text());
        assert.ok(csrfToken, 'Should obtain post-auth CSRF token');
    });

    after(async () => {
        if (server) {
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });

    describe('1. CSV Parsing & Dry-Run Preview', () => {
        it('1.1 parses valid CSV with preview details and action detection', async () => {
            const csv = `name,unit,rate,hsn,gstrate,description
Imported Widget Alpha,PCS,250.00,8471,18,High performance widget
Imported Cable Beta,MTR,15.50,8544,18,Shielded network cable`;

            const beforeCount = await prisma.item.count();
            const result = await itemService.parseAndValidateItemCsv(csv);
            const afterCount = await prisma.item.count();

            // CRITICAL INVARIANT: Zero database changes during dry-run preview
            assert.equal(beforeCount, afterCount, 'Dry-run preview must NOT mutate database state');

            assert.equal(result.summary.totalRows, 2);
            assert.equal(result.summary.validCount, 2);
            assert.equal(result.summary.invalidCount, 0);
            assert.equal(result.errors.length, 0);

            assert.equal(result.preview[0].name, 'Imported Widget Alpha');
            assert.equal(result.preview[0].rate, 250.00);
            assert.equal(result.preview[0].action, 'CREATE');
        });

        it('1.2 detects and flags validation errors on invalid rows', async () => {
            const invalidCsv = `name,unit,rate,hsn,gstrate
,PCS,100,8471,18
Bad Rate Item,PCS,-50,8471,18
Bad Tax Item,PCS,100,8471,150`;

            const result = await itemService.parseAndValidateItemCsv(invalidCsv);
            assert.equal(result.summary.invalidCount, 3);
            assert.equal(result.summary.validCount, 0);
            assert.ok(result.errors.some(e => e.error.includes('name is required')));
            assert.ok(result.errors.some(e => e.error.includes('Rate must be a non-negative')));
            assert.ok(result.errors.some(e => e.error.includes('GST rate must be between')));
        });

        it('1.3 catches duplicate item names within the CSV itself', async () => {
            const dupCsv = `name,unit,rate
Unique Item A,PCS,10
Unique Item A,PCS,20`;

            const result = await itemService.parseAndValidateItemCsv(dupCsv);
            assert.equal(result.summary.validCount, 1);
            assert.equal(result.summary.invalidCount, 1);
            assert.ok(result.errors[0].error.includes('Duplicate item name'));
        });
    });

    describe('2. Transactional Commit Execution', () => {
        let importedName = null;

        it('2.1 commits validated rows into Item Master', async () => {
            importedName = `Test Batch Item ${Date.now()}`;
            const rows = [
                {
                    name: importedName,
                    unit: 'PCS',
                    rate: 899.00,
                    hsnSac: '847130',
                    description: 'Batch imported item',
                    gstRate: 18,
                    action: 'CREATE'
                }
            ];

            const commitRes = await itemService.importItemsFromCsv(rows, testAdmin.id);
            assert.equal(commitRes.created, 1);
            assert.equal(commitRes.updated, 0);

            const savedItem = await prisma.item.findUnique({ where: { name: importedName } });
            assert.ok(savedItem);
            assert.equal(Number(savedItem.rate), 899.00);
            assert.equal(savedItem.hsnSac, '847130');
        });

        it('2.2 updates existing items when action is UPDATE', async () => {
            const existing = await prisma.item.findUnique({ where: { name: importedName } });
            assert.ok(existing);

            const updateRows = [
                {
                    name: importedName,
                    unit: 'BOX',
                    rate: 999.00,
                    hsnSac: '847130',
                    description: 'Updated batch item',
                    gstRate: 18,
                    action: 'UPDATE',
                    existingId: existing.id
                }
            ];

            const commitRes = await itemService.importItemsFromCsv(updateRows, testAdmin.id);
            assert.equal(commitRes.created, 0);
            assert.equal(commitRes.updated, 1);

            const updatedItem = await prisma.item.findUnique({ where: { id: existing.id } });
            assert.equal(Number(updatedItem.rate), 999.00);
            assert.equal(updatedItem.unit, 'BOX');
        });
    });

    describe('3. HTTP API End-to-End Delivery', () => {
        it('3.1 POST /api/items/import/preview returns preview data', async () => {
            const csv = `name,unit,rate\nAPI Test Item ${Date.now()},PCS,120.00`;
            const res = await fetch(`${baseUrl}/api/items/import/preview`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': authCookie || '',
                    'x-csrf-token': csrfToken
                },
                body: JSON.stringify({ csvContent: csv })
            });

            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.success, true);
            assert.equal(data.summary.validCount, 1);
        });

        it('3.2 POST /api/items/import/commit creates items via API', async () => {
            const apiItemName = `API Created Item ${Date.now()}`;
            const res = await fetch(`${baseUrl}/api/items/import/commit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': authCookie || '',
                    'x-csrf-token': csrfToken
                },
                body: JSON.stringify({
                    rows: [{
                        name: apiItemName,
                        unit: 'PCS',
                        rate: 450.00,
                        action: 'CREATE'
                    }]
                })
            });

            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.success, true);
            assert.equal(data.created, 1);

            const saved = await prisma.item.findUnique({ where: { name: apiItemName } });
            assert.ok(saved);
        });
    });
});
