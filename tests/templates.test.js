'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const app = require('../app/app');
const prisma = require('../app/config/prisma');
const templateService = require('../app/services/template.service');
const businessProfileService = require('../app/services/businessProfile.service');

describe('Document & Invoice Template System & Business Isolation Test Suite', () => {
    let server;
    let baseUrl;
    let authCookie;
    let csrfToken;

    const adminEmail = 'admin@email.com';
    const adminPassword = process.env.SEED_ADMIN_PASSWORD;
    if (!adminPassword) throw new Error('SEED_ADMIN_PASSWORD environment variable is required to run tests');

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
        try {
            const adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });
            assert.ok(adminUser, 'Admin user must exist in database');

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
                    Cookie: initialCookie
                },
                body: new URLSearchParams({
                    _csrf: loginCsrf,
                    email: adminEmail,
                    password: adminPassword
                }).toString(),
                redirect: 'manual'
            });

            authCookie = extractCookie(loginRes);
            assert.ok(authCookie, 'Authentication session cookie must be set');

            // Extract authenticated session CSRF token
            const settingsRes = await fetch(`${baseUrl}/settings`, {
                headers: { Cookie: authCookie }
            });
            const settingsHtml = await settingsRes.text();
            csrfToken = extractCsrfToken(settingsHtml);
        } catch (err) {
            console.error('BEFORE HOOK ERROR:', err);
            throw err;
        }
    });

    after(async () => {
        if (server) {
            if (server.closeAllConnections) server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        await prisma.$disconnect();
    });


    describe('1. Template Service Core Logic', () => {
        it('returns all 4 built-in system templates', () => {
            const templates = templateService.listTemplates(1);
            assert.ok(Array.isArray(templates));
            assert.ok(templates.length >= 4);

            const ids = templates.map(t => t.id);
            assert.ok(ids.includes('modern-minimal'));
            assert.ok(ids.includes('classic-corporate'));
            assert.ok(ids.includes('industrial-bold'));
            assert.ok(ids.includes('executive-emerald'));
        });

        it('retrieves specific template with correct metadata and colors', () => {
            const corporate = templateService.getTemplate('classic-corporate', 1);
            assert.strictEqual(corporate.id, 'classic-corporate');
            assert.strictEqual(corporate.accentColor, '#1e3a8a');
            assert.strictEqual(corporate.themeClass, 'theme-classic-corporate');
            assert.strictEqual(corporate.isBuiltIn, true);

            const emerald = templateService.getTemplate('executive-emerald', 1);
            assert.strictEqual(emerald.id, 'executive-emerald');
            assert.strictEqual(emerald.accentColor, '#0f766e');
        });

        it('falls back to modern-minimal when non-existent template ID is requested', () => {
            const fallback = templateService.getTemplate('unknown-template-xyz', 1);
            assert.strictEqual(fallback.id, 'modern-minimal');
        });

        it('manages custom templates per business with strict isolation', () => {
            const bizA = 8881;
            const bizB = 8882;

            // Save custom template for Business A
            const customA = templateService.saveCustomTemplate(bizA, {
                name: 'Alpha Cyber Theme',
                category: 'High-Tech',
                baseTemplate: 'modern-minimal',
                accentColor: '#6366f1',
                accentSubtle: '#e0e7ff',
                showHsn: false,
                showUpiQr: true
            });

            assert.ok(customA.id.startsWith('custom'));
            assert.strictEqual(customA.name, 'Alpha Cyber Theme');
            assert.strictEqual(customA.showHsn, false);

            // Business A should list customA
            const listA = templateService.listTemplates(bizA);
            assert.ok(listA.some(t => t.id === customA.id));

            // Business B should NOT see customA
            const listB = templateService.listTemplates(bizB);
            assert.ok(!listB.some(t => t.id === customA.id));

            // Set active templates for Business A
            templateService.setActiveTemplates(bizA, {
                invoiceTemplate: customA.id,
                quotationTemplate: 'executive-emerald'
            });

            // Set active templates for Business B
            templateService.setActiveTemplates(bizB, {
                invoiceTemplate: 'industrial-bold',
                quotationTemplate: 'classic-corporate'
            });

            const activeA = templateService.getActiveTemplates(bizA);
            const activeB = templateService.getActiveTemplates(bizB);

            assert.strictEqual(activeA.invoiceTemplate, customA.id);
            assert.strictEqual(activeA.quotationTemplate, 'executive-emerald');
            assert.strictEqual(activeB.invoiceTemplate, 'industrial-bold');
            assert.strictEqual(activeB.quotationTemplate, 'classic-corporate');

            // Delete custom template from Business A
            templateService.deleteCustomTemplate(bizA, customA.id);
            const listAAfter = templateService.listTemplates(bizA);
            assert.ok(!listAAfter.some(t => t.id === customA.id));
        });

        it('prevents deletion of built-in templates', () => {
            assert.throws(() => {
                templateService.deleteCustomTemplate(1, 'classic-corporate');
            }, /Built-in system templates cannot be deleted/);
        });

        it('builds sample view models for preview with CA standard totals', () => {
            const sampleInvoice = templateService.buildSampleViewModel('classic-corporate', 'INVOICE', {
                legalName: 'Apex Accounting Corp',
                stateCode: '27'
            });

            assert.strictEqual(sampleInvoice.documentType, 'INVOICE');
            assert.strictEqual(sampleInvoice.seller.name, 'Apex Accounting Corp');
            assert.ok(sampleInvoice.financials.grandTotal);
            assert.strictEqual(sampleInvoice.financials.gstEnabled, true);

            const sampleQuotation = templateService.buildSampleViewModel('modern-minimal', 'QUOTATION', {});
            assert.strictEqual(sampleQuotation.documentType, 'QUOTATION');
            assert.ok(sampleQuotation.invoiceNumber.startsWith('QT-'));
        });
    });

    describe('2. Multi-Business Profile Isolation', () => {
        it('isolates profile updates between distinct business IDs', async () => {
            const biz1 = 1;
            const biz99 = 99;

            await prisma.business.upsert({
                where: { id: biz99 },
                update: {},
                create: { id: biz99, name: 'Business 99 Enterprise', code: 'BIZ99' }
            });

            // Ensure profile 1 exists
            await businessProfileService.updateProfile({
                legalName: 'Business One Corp',
                displayName: 'Biz One',
                gstin: '27AAAAA1111A1Z1',
                stateCode: '27',
                currency: 'INR'
            }, biz1);

            // Update profile 99
            await businessProfileService.updateProfile({
                legalName: 'Business Ninety-Nine LLC',
                displayName: 'Biz 99',
                gstin: '29BBBBB9999B1Z9',
                stateCode: '29',
                currency: 'USD'
            }, biz99);

            const p1 = await businessProfileService.getProfile(biz1);
            const p99 = await businessProfileService.getProfile(biz99);

            assert.strictEqual(p1.legalName, 'Business One Corp');
            assert.strictEqual(p1.gstin, '27AAAAA1111A1Z1');
            assert.strictEqual(p1.stateCode, '27');
            assert.strictEqual(p1.currency, 'INR');

            assert.strictEqual(p99.legalName, 'Business Ninety-Nine LLC');
            assert.strictEqual(p99.gstin, '29BBBBB9999B1Z9');
            assert.strictEqual(p99.stateCode, '29');
            assert.strictEqual(p99.currency, 'USD');
        });
    });

    describe('3. Template HTTP Endpoints & UI Rendering', () => {
        it('GET /settings renders the settings page with Template System gallery and controls', async () => {
            const res = await fetch(`${baseUrl}/settings`, {
                headers: { Cookie: authCookie }
            });

            assert.strictEqual(res.status, 200);
            const html = await res.text();

            assert.ok(html.includes('Document & Invoice Templates'), 'Must render template tab title');
            assert.ok(html.includes('Template Gallery'), 'Must render template gallery');
            assert.ok(html.includes('Modern Minimalist'), 'Must list Modern Minimalist template');
            assert.ok(html.includes('Classic Corporate'), 'Must list Classic Corporate template');
            assert.ok(html.includes('Industrial Bold'), 'Must list Industrial Bold template');
            assert.ok(html.includes('Executive Emerald'), 'Must list Executive Emerald template');
            assert.ok(html.includes('templatePreviewModal'), 'Must include preview modal');
            assert.ok(html.includes('templateEditorModal'), 'Must include editor modal');
        });

        it('GET /settings/templates/preview/classic-corporate renders sample document with corporate theme', async () => {
            const res = await fetch(`${baseUrl}/settings/templates/preview/classic-corporate?type=INVOICE`, {
                headers: { Cookie: authCookie }
            });

            assert.strictEqual(res.status, 200);
            const html = await res.text();

            assert.ok(html.includes('theme-classic-corporate'), 'Must contain theme class');
            assert.ok(html.includes('TAX INVOICE'), 'Must render sample Tax Invoice');
            assert.ok(html.includes('--doc-accent: #1e3a8a'), 'Must set corporate accent color in CSS variables');
            assert.ok(html.includes('TOTAL'), 'Must render total bar');
        });

        it('GET /settings/templates/preview/modern-minimal?type=QUOTATION renders quotation sample', async () => {
            const res = await fetch(`${baseUrl}/settings/templates/preview/modern-minimal?type=QUOTATION`, {
                headers: { Cookie: authCookie }
            });

            assert.strictEqual(res.status, 200);
            const html = await res.text();

            assert.ok(html.includes('theme-modern-minimal'), 'Must contain theme class');
            assert.ok(html.includes('QUOTATION'), 'Must render quotation badge');
            assert.ok(html.includes('--doc-accent: #2563eb'), 'Must set modern minimal accent color');
        });

        it('POST /api/settings/templates/active updates active templates via API', async () => {
            const res = await fetch(`${baseUrl}/api/settings/templates/active`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({
                    invoiceTemplate: 'industrial-bold',
                    quotationTemplate: 'executive-emerald'
                })
            });

            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.strictEqual(body.activeTemplates.invoiceTemplate, 'industrial-bold');
            assert.strictEqual(body.activeTemplates.quotationTemplate, 'executive-emerald');
        });

        it('POST /api/settings/templates/save creates custom template via API', async () => {
            const res = await fetch(`${baseUrl}/api/settings/templates/save`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                },
                body: JSON.stringify({
                    name: 'API Custom Neon Theme',
                    category: 'Creative Tech',
                    baseTemplate: 'modern-minimal',
                    accentColor: '#10b981',
                    accentSubtle: '#ecfdf5',
                    showHsn: true,
                    showUpiQr: true,
                    showDiscount: true,
                    showUnit: true
                })
            });

            assert.strictEqual(res.status, 200);
            const body = await res.json();
            assert.strictEqual(body.success, true);
            assert.ok(body.template.id);
            assert.strictEqual(body.template.name, 'API Custom Neon Theme');

            // Delete it via DELETE endpoint
            const delRes = await fetch(`${baseUrl}/api/settings/templates/${body.template.id}`, {
                method: 'DELETE',
                headers: {
                    'x-csrf-token': csrfToken,
                    Cookie: authCookie
                }
            });

            assert.strictEqual(delRes.status, 200);
            const delBody = await delRes.json();
            assert.strictEqual(delBody.success, true);
        });
    });
});

