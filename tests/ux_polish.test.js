require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const prisma = require('../app/config/prisma');
const unitService = require('../app/services/unit.service');
const clientService = require('../app/services/client.service');
const itemService = require('../app/services/item.service');
const invoiceService = require('../app/services/invoice.service');

describe('UX Polish, Unit Master & Master Data Tests', () => {

    let adminUserId = null;

    before(async () => {
        // Ensure predefined units exist
        await unitService.seedDefaultUnits();
        const user = await prisma.user.findFirst();
        if (user) {
            adminUserId = user.id;
        }
    });

    after(async () => {
        await prisma.$disconnect();
    });

    describe('1. Unit Master Domain & Service', () => {
        const testSymbol = 'tst_' + Date.now().toString().slice(-4);
        let createdUnitId = null;

        it('should list active units including default units', async () => {
            const activeUnits = await unitService.getActiveUnits();
            assert.ok(Array.isArray(activeUnits));
            assert.ok(activeUnits.length >= 10);
            
            const symbols = activeUnits.map(u => u.symbol);
            assert.ok(symbols.includes('PCS'));
            assert.ok(symbols.includes('m'));
            assert.ok(symbols.includes('unit'));
        });

        it('should create a new unit successfully', async () => {
            const unit = await unitService.createUnit({
                name: 'Test Kilowatt',
                symbol: testSymbol,
                description: 'Measurement for electrical power'
            });

            assert.ok(unit.id);
            assert.strictEqual(unit.name, 'Test Kilowatt');
            assert.strictEqual(unit.symbol, testSymbol);
            assert.strictEqual(unit.active, true);
            createdUnitId = unit.id;
        });

        it('should reject creating a unit with duplicate symbol', async () => {
            await assert.rejects(async () => {
                await unitService.createUnit({
                    name: 'Duplicate Test',
                    symbol: testSymbol
                });
            }, (err) => {
                assert.ok(err instanceof unitService.ConflictError || err.message.includes('already exists'));
                return true;
            });
        });

        it('should update unit details', async () => {
            const updated = await unitService.updateUnit(createdUnitId, {
                name: 'Test Kilowatt Hour',
                description: 'Updated description'
            });

            assert.strictEqual(updated.name, 'Test Kilowatt Hour');
            assert.strictEqual(updated.description, 'Updated description');
        });

        it('should deactivate a unit and exclude it from active list', async () => {
            const deactivated = await unitService.updateUnit(createdUnitId, {
                active: false
            });
            assert.strictEqual(deactivated.active, false);

            const activeUnits = await unitService.getActiveUnits();
            const found = activeUnits.find(u => u.id === createdUnitId);
            assert.strictEqual(found, undefined, 'Deactivated unit should not appear in activeUnits');
        });

        it('should reactivate a unit', async () => {
            const reactivated = await unitService.updateUnit(createdUnitId, {
                active: true
            });
            assert.strictEqual(reactivated.active, true);

            const activeUnits = await unitService.getActiveUnits();
            const found = activeUnits.find(u => u.id === createdUnitId);
            assert.ok(found, 'Reactivated unit should appear in activeUnits');
        });

        it('should delete unit', async () => {
            await unitService.deleteUnit(createdUnitId);
            const activeUnits = await unitService.getActiveUnits();
            const found = activeUnits.find(u => u.id === createdUnitId);
            assert.strictEqual(found, undefined);
        });

        it('should idempotently seed predefined units without duplicating', async () => {
            const countBefore = await prisma.unit.count();
            await unitService.seedDefaultUnits();
            const countAfter = await prisma.unit.count();
            assert.strictEqual(countBefore, countAfter, 'Second seed run should not insert duplicates');
        });
    });

    describe('2. Client Optional Email & Phone Validation', () => {
        let createdClientId = null;

        it('should create client with blank email and blank phone', async () => {
            const client = await clientService.createClient({
                name: 'Test Client Blank Contact ' + Date.now(),
                email: '',
                phone: '',
                billingAddress: '123 Test Street, Mumbai',
                shippingAddress: '123 Test Street, Mumbai'
            });

            assert.ok(client.id);
            assert.strictEqual(client.email, null);
            assert.strictEqual(client.phone, null);
            createdClientId = client.id;
        });

        it('should update client with null/blank email and phone', async () => {
            const updated = await clientService.updateClient(createdClientId, {
                name: 'Test Client Updated ' + Date.now(),
                email: '   ',
                phone: null
            });

            assert.strictEqual(updated.email, null);
            assert.strictEqual(updated.phone, null);
        });

        it('should accept valid email and phone format', async () => {
            const client = await clientService.createClient({
                name: 'Test Client With Valid Contact ' + Date.now(),
                email: 'valid.client@example.com',
                phone: '+91 98765 43210'
            });

            assert.ok(client.id);
            assert.strictEqual(client.email, 'valid.client@example.com');
            assert.strictEqual(client.phone, '+91 98765 43210');
            // Clean up
            await prisma.client.delete({ where: { id: client.id } });
        });

        it('should reject invalid email format when supplied', async () => {
            await assert.rejects(async () => {
                await clientService.createClient({
                    name: 'Bad Email Client ' + Date.now(),
                    email: 'not-an-email-address',
                    phone: ''
                });
            }, (err) => {
                assert.ok(err.message.includes('email') || err.name === 'ValidationError');
                return true;
            });
        });

        it('should reject invalid phone format when supplied', async () => {
            await assert.rejects(async () => {
                await clientService.createClient({
                    name: 'Bad Phone Client ' + Date.now(),
                    email: '',
                    phone: 'abc-def-invalid'
                });
            }, (err) => {
                assert.ok(err.message.includes('Phone') || err.name === 'ValidationError');
                return true;
            });
        });

        // Cleanup
        after(async () => {
            if (createdClientId) {
                await prisma.client.delete({ where: { id: createdClientId } }).catch(() => {});
            }
        });
    });

    describe('3. Document Invoice Creation with Optional Client Fields', () => {
        let testInvoiceId = null;

        it('should create an invoice with blank client email and phone', async () => {
            const invoice = await invoiceService.createInvoice({
                documentType: 'INVOICE',
                clientName: 'Invoice Client Blank Contact ' + Date.now(),
                clientEmail: '',
                clientPhone: '',
                billingAddress: '77 Testing Boulevard',
                invoiceDate: new Date().toISOString(),
                items: [
                    {
                        name: 'Pipe Seamless S-40 Sudul 40 extra heavy pipe 40/50 mm PNG',
                        unit: 'm',
                        rate: 900.00,
                        quantity: 10,
                        hsnSac: '7304'
                    }
                ],
                gstEnabled: false
            }, adminUserId);

            assert.ok(invoice.id);
            assert.strictEqual(invoice.clientEmail, null);
            assert.strictEqual(invoice.clientPhone, null);
            assert.strictEqual(invoice.items[0].unit, 'm');
            testInvoiceId = invoice.id;
        });

        it('should preserve document client snapshot even if client master changes', async () => {
            // Create a client in master
            const masterClient = await clientService.createClient({
                name: 'Snapshot Master Client ' + Date.now(),
                email: 'original@client.com',
                phone: '+91 99999 88888',
                billingAddress: 'Original Master Address'
            });

            // Create invoice using snapshot of this client
            const invoice = await invoiceService.createInvoice({
                documentType: 'INVOICE',
                clientName: masterClient.name,
                clientEmail: masterClient.email,
                clientPhone: masterClient.phone,
                billingAddress: masterClient.billingAddress,
                invoiceDate: new Date().toISOString(),
                items: [
                    {
                        name: 'Testing Services',
                        unit: 'Hours',
                        rate: 500,
                        quantity: 2
                    }
                ],
                gstEnabled: false
            }, adminUserId);

            // Modify client master
            await clientService.updateClient(masterClient.id, {
                name: 'Changed Master Name ' + Date.now(),
                email: 'newemail@client.com',
                billingAddress: 'New Address'
            });

            // Verify invoice client data is unchanged
            const retrieved = await invoiceService.getInvoiceById(invoice.id);
            assert.strictEqual(retrieved.clientName, masterClient.name);
            assert.strictEqual(retrieved.clientEmail, 'original@client.com');
            assert.strictEqual(retrieved.billingAddress, 'Original Master Address');

            // Cleanup
            await prisma.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } }).catch(() => {});
            await prisma.invoice.delete({ where: { id: invoice.id } }).catch(() => {});
            await prisma.client.delete({ where: { id: masterClient.id } }).catch(() => {});
        });

        after(async () => {
            if (testInvoiceId) {
                await prisma.invoiceItem.deleteMany({ where: { invoiceId: testInvoiceId } }).catch(() => {});
                await prisma.invoice.delete({ where: { id: testInvoiceId } }).catch(() => {});
            }
        });
    });

    describe('4. Master Items Seeding & Case Preservation', () => {
        it('should contain the 21 master items with exact casing and rates', async () => {
            const expectedItems = [
                { name: 'Pipe Seamless S-40 Sudul 40 extra heavy pipe 40/50 mm PNG', unit: 'm', rate: 900.00 },
                { name: 'Band Seamless 1BR with Lab Testing Reporting TC 50, 40 mm', unit: 'm', rate: 300.00 },
                { name: 'Ball Valve L&T Audco 40/50 mm super strong extra autocut', unit: 'unit', rate: 6800.00 },
                { name: 'Line Valve heat proof super strong extra autocut L&T', unit: 'unit', rate: 900.00 },
                { name: 'Clamps industrial with fastener, nut bolt, super strong with Gaskit', unit: 'unit', rate: 300.00 },
                { name: 'Tee 50mm with TC Lab Reporting 18R Seamless', unit: 'unit', rate: 1200.00 },
                { name: 'Meter Gauge 4” dia looking pressure Liquid 10KG', unit: 'unit', rate: 2000.00 },
                { name: 'Bullnose with brass nut Gaskit with reducer', unit: 'unit', rate: 1800.00 },
                { name: 'Flexible Hydraulic Suraksha Long heavy', unit: 'unit', rate: 700.00 },
                { name: 'Nitrogen Pressure holding Line testing', unit: 'unit', rate: 8500.00 },
                { name: 'Labour charges, Welding, testing, fitting charges etc', unit: 'unit', rate: 145000.00 },
                { name: 'TPT (Third Party Testing) by Govt Body IGL & Report', unit: 'unit', rate: 9500.00 },
                { name: 'Paint, Primer, Cutting, Welding Rod, Loading & Unloading Fare', unit: 'unit', rate: 18000.00 },
                { name: 'Sonolet Valve, Midas, Made in Japan, 40mm', unit: 'unit', rate: 18500.00 },
                { name: 'DBR 8 zone, Panel automatic super sensor', unit: 'unit', rate: 22500.00 },
                { name: 'Leak Detector LED Imported Auto Sensor LED', unit: 'unit', rate: 12500.00 },
                { name: 'Hooter Alarm Auto Detect super power', unit: 'unit', rate: 2000.00 },
                { name: 'Cabel 4 core super single controller', unit: 'unit', rate: 180.00 },
                { name: 'Canduit Metal with fastener nut bolt', unit: 'unit', rate: 80.00 },
                { name: 'Labour Charge Electronic working with TC', unit: 'unit', rate: 20000.00 },
                { name: 'Imported Gas Meter 1 Bar super flame', unit: 'unit', rate: 68000.00 }
            ];

            for (const expected of expectedItems) {
                const item = await prisma.item.findUnique({
                    where: { name: expected.name }
                });
                assert.ok(item, `Item "${expected.name}" should exist in Item Master`);
                assert.strictEqual(item.unit, expected.unit, `Unit for "${expected.name}" should be "${expected.unit}"`);
                assert.strictEqual(Number(item.rate), expected.rate, `Rate for "${expected.name}" should be ${expected.rate}`);
            }
        });

        it('should return matching items from searchItems autocomplete', async () => {
            const results = await itemService.searchItems({ query: 'Seamless', limit: 10 });
            assert.ok(results.length >= 2);
            assert.ok(results.some(r => r.name.includes('Pipe Seamless')));
            assert.ok(results.some(r => r.name.includes('Band Seamless')));
        });
    });

    describe('5. Template Cleanliness & UI System Integrity', () => {
        const fs = require('fs');
        const path = require('path');

        it('should ensure header navigation has no stale demo links', () => {
            const headerPath = path.join(__dirname, '..', 'app', 'views', 'layouts', 'header.ejs');
            const content = fs.readFileSync(headerPath, 'utf8');

            // Must NOT contain template demo pages
            assert.strictEqual(content.includes('tables-basic.html'), false);
            assert.strictEqual(content.includes('ui-forms.html'), false);
            assert.strictEqual(content.includes('ui-buttons.html'), false);
            assert.strictEqual(content.includes('page-blank.html'), false);
            assert.strictEqual(content.includes('page-login.html'), false);
            assert.strictEqual(content.includes('page-404.html'), false);

            // Must contain implemented application sections
            assert.ok(content.includes('/dashboard'));
            assert.ok(content.includes('/documents'));
            assert.ok(content.includes('/clients'));
            assert.ok(content.includes('/items'));
            assert.ok(content.includes('/units'));
            assert.ok(content.includes('/settings'));
        });

        it('should ensure editor script implements body portal and fast keyboard flow', () => {
            const scriptPath = path.join(__dirname, '..', 'assets', 'js', 'editor.js');
            const content = fs.readFileSync(scriptPath, 'utf8');

            assert.ok(content.includes('item-autocomplete-portal'), 'Must contain body portal logic');
            assert.ok(content.includes('btn-clear-client'), 'Must contain clear client button handler');
            assert.ok(content.includes('client-select'), 'Must contain client select logic');
            assert.ok(content.includes('ArrowDown'), 'Must handle ArrowDown key');
            assert.ok(content.includes('ArrowUp'), 'Must handle ArrowUp key');
            assert.ok(content.includes('Escape'), 'Must handle Escape key');

            // Also verify the client snapshot badge in editor.ejs
            const editorViewPath = path.join(__dirname, '..', 'app', 'views', 'documents', 'editor.ejs');
            const viewContent = fs.readFileSync(editorViewPath, 'utf8');
            assert.ok(viewContent.includes('client-snapshot-badge'), 'Must contain document-level client snapshot badge');
            assert.ok(viewContent.includes('Document-level client snapshot'));
        });

        it('should ensure editor styles define portal and positioning', () => {
            const cssPath = path.join(__dirname, '..', 'assets', 'css', 'editor.css');
            const content = fs.readFileSync(cssPath, 'utf8');

            assert.ok(content.includes('#item-autocomplete-portal'));
            assert.ok(content.includes('item-autocomplete-item'));
            assert.ok(content.includes('z-index: 10050'));
        });

        it('should ensure main.css contains unified button design system', () => {
            const cssPath = path.join(__dirname, '..', 'assets', 'css', 'main.css');
            const content = fs.readFileSync(cssPath, 'utf8');

            assert.ok(content.includes('.btn-primary'));
            assert.ok(content.includes('.btn-secondary'));
            assert.ok(content.includes('.btn-outline-primary'));
            assert.ok(content.includes('.btn-outline-secondary'));
        });
    });

    describe('6. HTTP API & Web Routes', () => {
        const http = require('http');
        const app = require('../app/app');
        let server;
        let baseUrl;
        let authCookie;

        before(async () => {
            server = http.createServer(app);
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;

            // Login
            const loginPageRes = await fetch(`${baseUrl}/login`);
            const initialCookie = (loginPageRes.headers.get('set-cookie') || '').match(/spark\.sid=[^;]+/)?.[0];
            const html = await loginPageRes.text();
            const csrfMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
            const csrfToken = csrfMatch ? csrfMatch[1] : '';

            const loginRes = await fetch(`${baseUrl}/login`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: initialCookie
                },
                body: new URLSearchParams({
                    _csrf: csrfToken,
                    email: 'admin@email.com',
                    password: process.env.SEED_ADMIN_PASSWORD || 'choose-a-local-development-password'
                }),
                redirect: 'manual'
            });
            authCookie = (loginRes.headers.get('set-cookie') || '').match(/spark\.sid=[^;]+/)?.[0] || initialCookie;
        });

        after(async () => {
            if (server) {
                if (typeof server.closeAllConnections === 'function') {
                    server.closeAllConnections();
                }
                await new Promise((resolve) => server.close(resolve));
            }
        });

        it('GET /api/units/active should return JSON list of active units', async () => {
            const res = await fetch(`${baseUrl}/api/units/active`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const data = await res.json();
            assert.strictEqual(data.success, true);
            assert.ok(Array.isArray(data.data));
            assert.ok(data.data.length >= 10);
            const symbols = data.data.map(u => u.symbol);
            assert.ok(symbols.includes('m'));
            assert.ok(symbols.includes('unit'));
        });

        it('GET /units should render Unit Master page', async () => {
            const res = await fetch(`${baseUrl}/units`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const text = await res.text();
            assert.ok(text.includes('Unit Master'));
            assert.ok(text.includes('Add Unit'));
        });

        it('GET /documents/new should render editor with active units and saved clients', async () => {
            const res = await fetch(`${baseUrl}/documents/new?type=INVOICE`, {
                headers: { Cookie: authCookie }
            });
            assert.strictEqual(res.status, 200);
            const text = await res.text();
            assert.ok(text.includes('Choose Saved Client'));
            assert.ok(text.includes('Document-level client snapshot'));
            assert.ok(text.includes('window.__AVAILABLE_UNITS__'));
        });
    });
});
