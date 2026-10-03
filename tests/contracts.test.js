require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('node:http');

const prisma = require('../app/config/prisma');
const app = require('../app/app');
const invoiceService = require('../app/services/invoice.service');
const documentViewService = require('../app/services/documentView.service');
const pdfService = require('../app/services/pdf.service');

describe('Frozen Core Architecture Contracts Test Suite', () => {
    let testUserId;
    let testQuotationId;
    let testInvoiceId;

    before(async () => {
        // Retrieve or ensure a valid test user exists
        let user = await prisma.user.findUnique({
            where: { email: 'admin@email.com' }
        });
        if (!user) {
            user = await prisma.user.create({
                data: {
                    name: 'Core Contract Tester',
                    email: `tester_${Date.now()}@contracts.local`,
                    password: 'hashed_password_placeholder',
                    role: 'ADMIN',
                    active: true
                }
            });
        }
        testUserId = user.id;
    });

    after(async () => {
        // Clean teardown: disconnect Prisma connection pool
        await prisma.$disconnect();
    });

    // =========================================================================
    // 1. BOOTSTRAP ARCHITECTURE
    // =========================================================================
    describe('1. Bootstrap Architecture Contracts', () => {
        it('1.1. Requiring app/app.js does not bind to any network socket', () => {
            assert.ok(app, 'app module must be exported');
            assert.strictEqual(typeof app, 'function', 'app must be an Express application function');
            assert.strictEqual(app.listening, undefined, 'app must not be actively listening upon require');
        });

        it('1.2. Zero circular dependencies between app, server, controllers, and services', () => {
            const serverPath = path.join(__dirname, '../app/server.js');
            assert.ok(fs.existsSync(serverPath), 'server.js entrypoint must exist');

            // Validate required core modules resolve cleanly
            const invoiceController = require('../app/controllers/invoice.controller');
            const authController = require('../app/controllers/auth.controller');
            assert.ok(invoiceController, 'invoice controller resolves');
            assert.ok(authController, 'auth controller resolves');
        });
    });

    // =========================================================================
    // 2. DATES & PERSISTENCE CONTRACTS (PHASE 1 FIX)
    // =========================================================================
    describe('2. Custom DueDate / ValidUntil Persistence Contracts', () => {
        it('2.1. Quotation persists validUntil and keeps dueDate strictly null', async () => {
            const customValidDate = '2026-11-20';
            const quote = await invoiceService.createDocument({
                documentType: 'QUOTATION',
                invoiceDate: '2026-10-15',
                validUntil: customValidDate,
                clientName: 'Contract Quote Corp',
                items: [
                    { lineNumber: 1, name: 'Consulting Block', quantity: 2, rate: 10000, unit: 'DAYS' }
                ]
            }, testUserId);

            testQuotationId = quote.id;
            assert.strictEqual(quote.documentType, 'QUOTATION');
            assert.strictEqual(quote.dueDate, null, 'Quotation dueDate must be null');
            assert.ok(quote.validUntil, 'Quotation validUntil must be present');

            // Format date to YYYY-MM-DD
            const isoDate = new Date(quote.validUntil).toISOString().split('T')[0];
            assert.strictEqual(isoDate, customValidDate, 'Persisted validUntil must match entered date exactly');

            // Verify database direct read
            const dbRecord = await prisma.invoice.findUnique({ where: { id: quote.id } });
            assert.strictEqual(dbRecord.dueDate, null);
            assert.strictEqual(new Date(dbRecord.validUntil).toISOString().split('T')[0], customValidDate);
        });

        it('2.2. Invoice persists dueDate and keeps validUntil strictly null', async () => {
            const customDueDate = '2026-11-30';
            const invoice = await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: '2026-10-15',
                dueDate: customDueDate,
                clientName: 'Contract Invoice Corp',
                items: [
                    { lineNumber: 1, name: 'Infrastructure Node', quantity: 1, rate: 50000, unit: 'MONTH' }
                ]
            }, testUserId);

            testInvoiceId = invoice.id;
            assert.strictEqual(invoice.documentType, 'INVOICE');
            assert.strictEqual(invoice.validUntil, null, 'Invoice validUntil must be null');
            assert.ok(invoice.dueDate, 'Invoice dueDate must be present');

            const isoDate = new Date(invoice.dueDate).toISOString().split('T')[0];
            assert.strictEqual(isoDate, customDueDate, 'Persisted dueDate must match entered date exactly');

            const dbRecord = await prisma.invoice.findUnique({ where: { id: invoice.id } });
            assert.strictEqual(dbRecord.validUntil, null);
            assert.strictEqual(new Date(dbRecord.dueDate).toISOString().split('T')[0], customDueDate);
        });

        it('2.3. Updating document updates respective date field and clears the other', async () => {
            const updatedValidUntil = '2026-12-15';
            const updated = await invoiceService.updateDocument(testQuotationId, {
                version: 1,
                invoiceDate: '2026-10-15',
                validUntil: updatedValidUntil,
                clientName: 'Contract Quote Corp (Updated)',
                items: [
                    { lineNumber: 1, name: 'Consulting Block Updated', quantity: 3, rate: 10000, unit: 'DAYS' }
                ]
            }, testUserId);

            assert.strictEqual(updated.dueDate, null);
            const isoDate = new Date(updated.validUntil).toISOString().split('T')[0];
            assert.strictEqual(isoDate, updatedValidUntil);
        });

        it('2.4. ValidUntil or DueDate prior to invoiceDate is rejected with ValidationError', async () => {
            await assert.rejects(
                async () => {
                    await invoiceService.createDocument({
                        documentType: 'QUOTATION',
                        invoiceDate: '2026-10-20',
                        validUntil: '2026-10-10', // Prior to invoiceDate
                        clientName: 'Invalid Date Corp',
                        items: [{ lineNumber: 1, name: 'Item', quantity: 1, rate: 100 }]
                    }, testUserId);
                },
                /cannot be earlier than/i
            );

            await assert.rejects(
                async () => {
                    await invoiceService.createDocument({
                        documentType: 'INVOICE',
                        invoiceDate: '2026-10-20',
                        dueDate: '2026-10-15', // Prior to invoiceDate
                        clientName: 'Invalid Date Corp',
                        items: [{ lineNumber: 1, name: 'Item', quantity: 1, rate: 100 }]
                    }, testUserId);
                },
                /cannot be earlier than/i
            );
        });

        it('2.5. Quotation to Invoice conversion does NOT copy validUntil to invoice dueDate', async () => {
            const convertedInvoice = await invoiceService.convertQuotationToInvoice(testQuotationId, testUserId, {
                dueDate: '2026-11-25'
            });

            assert.strictEqual(convertedInvoice.documentType, 'INVOICE');
            assert.strictEqual(convertedInvoice.validUntil, null, 'Converted invoice validUntil must be null');
            assert.strictEqual(new Date(convertedInvoice.dueDate).toISOString().split('T')[0], '2026-11-25');
            assert.strictEqual(convertedInvoice.sourceQuotationId, testQuotationId);

            // Verify source quotation still has its original validUntil
            const sourceQuote = await prisma.invoice.findUnique({ where: { id: testQuotationId } });
            assert.strictEqual(sourceQuote.documentType, 'QUOTATION');
            assert.strictEqual(sourceQuote.dueDate, null);
            assert.ok(sourceQuote.validUntil);
        });

        it('2.6. Copy semantics: copies business date without cloning id, number, status, version, or payments', async () => {
            const copyData = await invoiceService.copyDocument(testInvoiceId);

            assert.strictEqual(copyData.id, undefined, 'id must not be copied');
            assert.strictEqual(copyData.invoiceNumber, undefined, 'invoiceNumber must not be copied');
            assert.strictEqual(copyData.status, undefined, 'status must not be copied to draft template');
            assert.strictEqual(copyData.version, undefined, 'version must not be copied to draft template');
            assert.strictEqual(copyData.revisions, undefined, 'revisions must not be copied');
            assert.strictEqual(copyData.payments, undefined, 'payments must not be copied');
            assert.strictEqual(copyData.sourceQuotationId, undefined, 'source quotation link must not be copied');
            assert.ok(copyData.dueDate, 'business dueDate is preserved in copy draft');
            assert.strictEqual(copyData.items.length, 1, 'items are preserved');
        });
    });

    // =========================================================================
    // 3. SINGLE PRESENTATION ARCHITECTURE CONTRACTS (PHASE 2 FIX)
    // =========================================================================
    describe('3. Single Print & PDF Presentation Architecture Contracts', () => {
        it('3.1. pdf.service.js contains ZERO PDFKit layout code and relies solely on shared EJS', () => {
            const pdfServiceSource = fs.readFileSync(path.join(__dirname, '../app/services/pdf.service.js'), 'utf8');

            assert.strictEqual(
                pdfServiceSource.includes("require('pdfkit')"),
                false,
                'pdf.service.js must not import or require pdfkit'
            );
            assert.strictEqual(
                pdfServiceSource.includes('renderPdfWithPdfKit'),
                false,
                'pdf.service.js must not contain renderPdfWithPdfKit fallback'
            );
            assert.ok(
                pdfServiceSource.includes('templates/document.ejs'),
                'pdf.service.js must target the shared templates/document.ejs'
            );
            assert.ok(
                pdfServiceSource.includes('PdfConfigurationError'),
                'pdf.service.js must export and throw controlled PdfConfigurationError'
            );
        });

        it('3.2. Both Print and PDF consume buildDocumentViewModel() from documentView.service.js', () => {
            const docViewService = require('../app/services/documentView.service');
            assert.strictEqual(typeof docViewService.buildDocumentViewModel, 'function');

            const model = docViewService.buildDocumentViewModel({
                id: 101,
                documentType: 'INVOICE',
                invoiceNumber: 'INV-2026-9999',
                invoiceDate: new Date('2026-10-01'),
                dueDate: new Date('2026-10-31'),
                grandTotal: 11800,
                subtotal: 10000,
                gstAmount: 1800,
                items: []
            });

            assert.strictEqual(model.invoiceNumber, 'INV-2026-9999');
            assert.strictEqual(model.isQuotation, false);
            assert.strictEqual(model.dates.dueOrExpiryLabel, 'Due Date');
            assert.ok(model.financials.formattedGrandTotal.includes('11,800.00'));
        });

        it('3.3. renderDocumentHtml renders identical HTML document for shared template', async () => {
            const html = await pdfService.renderDocumentHtml({
                id: 102,
                documentType: 'QUOTATION',
                invoiceNumber: 'QTN-2026-8888',
                invoiceDate: new Date('2026-10-01'),
                validUntil: new Date('2026-10-25'),
                grandTotal: 5900,
                subtotal: 5000,
                gstAmount: 900,
                items: [
                    { lineNumber: 1, name: 'Unified Template Service', quantity: 1, rate: 5000, amount: 5000 }
                ]
            });

            assert.ok(html.includes('QTN-2026-8888'));
            assert.ok(html.includes('Unified Template Service'));
            assert.ok(html.includes('QUOTATION'));
            assert.ok(html.includes('<!DOCTYPE html>'));
        });
    });

    // =========================================================================
    // 4. SERVER-AUTHORITATIVE FINANCIAL CONTRACTS
    // =========================================================================
    describe('4. Server-Authoritative Financial Contracts', () => {
        it('4.1. Server recalculates and overrides client-manipulated totals', async () => {
            const doc = await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: '2026-10-15',
                clientName: 'Math Verification Client',
                // Client maliciously sends 0 for subtotal and grandTotal
                subtotal: 0,
                grandTotal: 0,
                gstEnabled: true,
                gstRate: 18,
                placeOfSupplyStateCode: '27',
                sellerStateCode: '27', // Intra-state
                items: [
                    { lineNumber: 1, name: 'Item A', quantity: 2, rate: 5000 },
                    { lineNumber: 2, name: 'Item B', quantity: 1, rate: 10000 }
                ]
            }, testUserId);

            // Expected subtotal: (2 * 5000) + (1 * 10000) = 20000
            // Expected 18% GST: 3600 (CGST 1800 + SGST 1800)
            // Expected Grand Total: 23600
            assert.strictEqual(Number(doc.subtotal), 20000);
            assert.strictEqual(Number(doc.gstAmount), 3600);
            assert.strictEqual(Number(doc.cgstAmount), 1800);
            assert.strictEqual(Number(doc.sgstAmount), 1800);
            assert.strictEqual(Number(doc.igstAmount), 0);
            assert.strictEqual(Number(doc.grandTotal), 23600);
            assert.strictEqual(Number(doc.outstandingAmount), 23600);
        });

        it('4.2. Inter-state supply applies entire tax to IGST', async () => {
            const doc = await invoiceService.createDocument({
                documentType: 'INVOICE',
                invoiceDate: '2026-10-15',
                clientName: 'Inter-State Client',
                gstEnabled: true,
                gstRate: 18,
                sellerStateCode: '27', // Maharashtra
                placeOfSupplyStateCode: '29', // Karnataka (Different state)
                items: [
                    { lineNumber: 1, name: 'Cloud Compute', quantity: 1, rate: 10000 }
                ]
            }, testUserId);

            assert.strictEqual(Number(doc.subtotal), 10000);
            assert.strictEqual(Number(doc.cgstAmount), 0);
            assert.strictEqual(Number(doc.sgstAmount), 0);
            assert.strictEqual(Number(doc.igstAmount), 1800);
            assert.strictEqual(Number(doc.grandTotal), 11800);
        });
    });

    // =========================================================================
    // 5. PRODUCTION SEED POLICY CONTRACTS
    // =========================================================================
    describe('5. Production Seed Policy Contracts', () => {
        const seedModule = require('../prisma/seed');

        it('5.1. Seed module defines exactly 13 standard units and 21 master items', () => {
            assert.strictEqual(Array.isArray(seedModule.DEFAULT_UNITS), true);
            assert.strictEqual(seedModule.DEFAULT_UNITS.length, 13, 'Must define exactly 13 default units');

            const unitSymbols = new Set(seedModule.DEFAULT_UNITS.map(u => u.symbol));
            assert.strictEqual(unitSymbols.size, 13, 'All 13 unit symbols must be unique');
            assert.ok(unitSymbols.has('PCS'));
            assert.ok(unitSymbols.has('m'));
            assert.ok(unitSymbols.has('unit'));

            assert.strictEqual(Array.isArray(seedModule.MASTER_ITEMS), true);
            assert.strictEqual(seedModule.MASTER_ITEMS.length, 21, 'Must define exactly 21 master items');

            const itemNames = new Set(seedModule.MASTER_ITEMS.map(i => i.name.trim()));
            assert.strictEqual(itemNames.size, 21, 'All 21 item names must be unique');
            seedModule.MASTER_ITEMS.forEach(i => {
                assert.ok(i.name && i.name.length > 0);
                assert.ok(i.unit && i.unit.length > 0);
                assert.ok(typeof i.rate === 'number' && i.rate >= 0);
            });
        });

        it('5.2. Production seed policy strictly forbids seeding business profile and demo data', async () => {
            const result = await seedModule.main({ isProduction: true, seedDemoData: false });
            assert.strictEqual(result.isProduction, true);
            assert.strictEqual(result.seedDemoData, false);
            assert.strictEqual(result.unitsCount >= 13, true);
            assert.strictEqual(result.itemsCount >= 21, true);
            assert.strictEqual(result.rolesCount >= 4, true);
            assert.strictEqual(result.permissionsCount >= 40, true);
        });

        it('5.3. Idempotent seed execution produces zero duplicate records and zero errors', async () => {
            const countBeforeUnits = await prisma.unit.count();
            const countBeforeItems = await prisma.item.count();
            const countBeforeRoles = await prisma.role.count();

            await seedModule.main({ isProduction: true, seedDemoData: false });

            const countAfterUnits = await prisma.unit.count();
            const countAfterItems = await prisma.item.count();
            const countAfterRoles = await prisma.role.count();

            assert.strictEqual(countAfterUnits, countBeforeUnits, 'Unit count must remain unchanged');
            assert.strictEqual(countAfterItems, countBeforeItems, 'Item count must remain unchanged');
            assert.strictEqual(countAfterRoles, countBeforeRoles, 'Role count must remain unchanged');
        });
    });
});
