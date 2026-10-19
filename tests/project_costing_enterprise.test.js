'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const prisma = require('../app/config/prisma');
const businessService = require('../app/services/business.service');
const clientService = require('../app/services/client.service');
const supplierBillService = require('../app/services/supplierBill.service');
const projectService = require('../app/services/project.service');
const projectCostLedgerService = require('../app/services/projectCostLedger.service');
const attachmentService = require('../app/services/attachment.service');
const invoiceService = require('../app/services/invoice.service');
const creditDebitNoteService = require('../app/services/creditDebitNote.service');

test('Enterprise Project Costing & Profitability Architecture Test Suite', async (t) => {
    let bizA, bizB;
    let userA, userB;
    let clientA, clientB;
    let supplierSME, supplierB;
    let projectA, projectB;
    let trackedItem;

    await t.test('Phase 0: Multi-Tenant Setup (Alpha Corp vs Beta Logistics)', async () => {
        const ts = Date.now();

        // 1. Create two distinct corporate tenants
        bizA = await businessService.createBusiness({
            code: `ALPHA_${ts}`,
            name: 'Rajesh International',
            legalName: 'Rajesh International',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '06AORPS1239N4Z6' // State 06: Haryana (Canonical Buyer GSTIN)
        });

        // Set business profile stateCode and exact buyer address
        await prisma.businessProfile.create({
            data: {
                business: { connect: { id: bizA.id } },
                legalName: 'Rajesh International',
                displayName: 'Rajesh International',
                gstin: '06AORPS1239N4Z6',
                stateCode: '06',
                email: `billing_${ts}@rajeshintl.test`,
                phone: '+91 129 256 7890',
                address: '33-A Surya Colony Part 2, Sehatpur Extension, Faridabad, Haryana'
            }
        });

        bizB = await businessService.createBusiness({
            code: `BETA_${ts}`,
            name: 'Beta Global Logistics LLP',
            legalName: 'Beta Global Logistics LLP',
            currency: 'INR',
            timezone: 'Asia/Kolkata',
            gstin: '24BBBBB5678B2Z8' // State 24: Gujarat
        });

        await prisma.businessProfile.create({
            data: {
                business: { connect: { id: bizB.id } },
                legalName: 'Beta Global Logistics LLP',
                displayName: 'Beta Logistics',
                gstin: '24BBBBB5678B2Z8',
                stateCode: '24',
                email: `accounts_${ts}@beta.test`,
                phone: '+91 79 3344 5566',
                address: '404 Logistics Hub, SG Highway, Ahmedabad 380015'
            }
        });

        // 2. Create users
        userA = await prisma.user.create({
            data: {
                name: 'Alice Alpha PM',
                email: `alice_${ts}@alpha.test`,
                password: 'test-secret-alpha',
                role: 'ADMIN',
                active: true
            }
        });
        await businessService.addOrUpdateMember({ businessId: bizA.id, userId: userA.id, role: 'ADMIN' });

        userB = await prisma.user.create({
            data: {
                name: 'Bob Beta PM',
                email: `bob_${ts}@beta.test`,
                password: 'test-secret-beta',
                role: 'ADMIN',
                active: true
            }
        });
        await businessService.addOrUpdateMember({ businessId: bizB.id, userId: userB.id, role: 'ADMIN' });

        // 3. Create scoped clients
        clientA = await clientService.createClient({
            businessId: bizA.id,
            name: 'Reliance Metro Projects',
            email: `metro_${ts}@ril.test`,
            gstin: '27AAACR1234C1ZV',
            stateCode: '27',
            billingAddress: 'Navi Mumbai, Maharashtra'
        }, userA.id);

        clientB = await clientService.createClient({
            businessId: bizB.id,
            name: 'Adani Port Logistics',
            email: `ports_${ts}@adani.test`,
            gstin: '24AAAAP4321D1ZW',
            stateCode: '24',
            billingAddress: 'Mundra, Gujarat'
        }, userB.id);

        // 4. Create Supplier: Shree Mahalaxmi Enterprises (Interstate UP supplier 09 -> Haryana Buyer 06)
        supplierSME = await prisma.supplier.create({
            data: {
                business: { connect: { id: bizA.id } },
                supplierCode: `SUP-SME-${ts}`,
                name: 'SHREE MAHALAXMI ENTERPRISES',
                gstin: '09AMAPG1241K1ZC', // State 09: Uttar Pradesh (Canonical Supplier GSTIN)
                stateCode: '09',
                email: 'contact@shreemahalaxmi.test',
                phone: '+91 120 456 7890',
                address: 'B-31, Sector-9, Noida, Uttar Pradesh',
                active: true,
                createdBy: { connect: { id: userA.id } }
            }
        });

        supplierB = await prisma.supplier.create({
            data: {
                business: { connect: { id: bizB.id } },
                supplierCode: `SUP-BETA-${ts}`,
                name: 'Beta Transport Contractors',
                gstin: '24BBBBP1234Q1Z2',
                stateCode: '24',
                active: true,
                createdBy: { connect: { id: userB.id } }
            }
        });

        // 5. Create projects for both businesses
        projectA = await projectService.createProject({
            code: `PRJ-A-${ts}`,
            name: 'Metro Line 4 - Piping and Structural Fab',
            description: 'Underground MS piping and fitting installation',
            clientId: clientA.id,
            startDate: '2026-10-01',
            contractValue: 500000.0, // Distinct Contract Value
            budgetAmount: 350000.0,  // Distinct Cost Budget
            budgetMaterials: 150000.0,
            budgetLabour: 120000.0,
            budgetSubcontractor: 50000.0,
            budgetExpenses: 30000.0,
            hourlyRate: 850.0,       // Customer sales billable rate
            costRate: 400.0,         // Internal employee cost rate
            billingType: 'TIME_AND_MATERIALS',
            status: 'ACTIVE'
        }, userA.id, bizA.id);

        projectB = await projectService.createProject({
            code: `PRJ-B-${ts}`,
            name: 'Mundra Yard Automation',
            description: 'Warehouse conveyor and dispatch tracking',
            clientId: clientB.id,
            startDate: '2026-10-05',
            contractValue: 250000.0,
            budgetAmount: 180000.0,
            billingType: 'FIXED_PRICE',
            status: 'ACTIVE'
        }, userB.id, bizB.id);

        assert.ok(projectA.id);
        assert.ok(projectB.id);
        assert.equal(projectA.businessId, bizA.id);
        assert.equal(projectB.businessId, bizB.id);
    });

    await t.test('Priority 0: Strict Multi-Tenant Isolation & Cross-Tenant Rejection', async () => {
        // Attempt 1: Tenant B tries to view Project A using its authorized context
        await assert.rejects(
            projectService.getProjectById(projectA.id, bizB.id),
            /not found/i,
            'Cross-tenant project view must be rejected with 404/not found'
        );

        // Attempt 2: Tenant B tries to update Project A
        await assert.rejects(
            projectService.updateProject(projectA.id, { name: 'Compromised Name' }, userB.id, bizB.id),
            /not found/i,
            'Cross-tenant project update must be rejected'
        );

        // Attempt 3: Tenant A tries to allocate a task or bill using a client belonging to Tenant B
        await assert.rejects(
            projectService.updateProject(projectA.id, { clientId: clientB.id }, userA.id, bizA.id),
            /not found/i,
            'Linking a foreign business client to a project must be rejected'
        );

        // Attempt 4: Guessed project IDs outside the authorized business
        const nonExistentId = 999999;
        await assert.rejects(
            projectService.getProjectById(nonExistentId, bizA.id),
            /not found/i,
            'Guessed non-existent IDs must return 404'
        );
    });

    let uploadedAttachment;

    await t.test('Priority 0 & Section 2: Secure File Attachments & Magic Byte Validation', async () => {
        // 1. Create a valid mock PDF with proper %PDF-1.4 header
        const pdfHeader = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
        const uploadResult = await attachmentService.saveAttachment({
            businessId: bizA.id,
            projectId: projectA.id,
            entityType: 'SUPPLIER_INVOICE',
            fileBuffer: pdfHeader,
            originalFilename: 'SME-26-27-6244-Original.pdf',
            mimeType: 'application/pdf',
            uploadedById: userA.id
        });

        assert.ok(uploadResult.id);
        assert.equal(uploadResult.businessId, bizA.id);
        assert.equal(uploadResult.originalFilename, 'SME-26-27-6244-Original.pdf');
        assert.ok(uploadResult.storedFilename);
        assert.ok(!uploadResult.storedFilename.includes('..'), 'Path traversal must be prevented');

        uploadedAttachment = uploadResult;

        // 2. Reject malicious spoofed extension (executable disguised with .pdf extension)
        const fakePdf = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00'); // Windows EXE PE signature
        await assert.rejects(
            attachmentService.saveAttachment({
                businessId: bizA.id,
                projectId: projectA.id,
                entityType: 'SUPPLIER_INVOICE',
                fileBuffer: fakePdf,
                originalFilename: 'malicious.pdf',
                mimeType: 'application/pdf',
                uploadedById: userA.id
            }),
            (err) => err.status === 415 && /invalid or unsupported/i.test(err.message),
            'File spoofing with invalid magic bytes must be rejected with HTTP 415 status'
        );

        // 3. Reject unpermitted extension (.exe) directly
        await assert.rejects(
            attachmentService.saveAttachment({
                businessId: bizA.id,
                projectId: projectA.id,
                entityType: 'PROJECT',
                fileBuffer: fakePdf,
                originalFilename: 'installer.exe',
                uploadedById: userA.id
            }),
            (err) => err.status === 415 && /unsupported/i.test(err.message),
            'Unpermitted .exe extension must be rejected with HTTP 415 status'
        );

        // 4. Verification: Invalid file does NOT create metadata or leave a stored file behind
        const filesBefore = fs.readdirSync(attachmentService.ATTACHMENT_STORAGE_DIR);
        const countBefore = await prisma.projectAttachment.count({ where: { businessId: bizA.id } });
        const costsBefore = await prisma.projectCost.count({ where: { projectId: projectA.id } });

        await assert.rejects(
            attachmentService.saveAttachment({
                businessId: bizA.id,
                projectId: projectA.id,
                entityType: 'PROJECT',
                fileBuffer: Buffer.from('NOT_A_VALID_FILE_PAYLOAD'),
                originalFilename: 'invalid_data.pdf',
                uploadedById: userA.id
            }),
            (err) => err.status === 415
        );

        const filesAfter = fs.readdirSync(attachmentService.ATTACHMENT_STORAGE_DIR);
        const countAfter = await prisma.projectAttachment.count({ where: { businessId: bizA.id } });
        const costsAfter = await prisma.projectCost.count({ where: { projectId: projectA.id } });

        assert.equal(filesAfter.length, filesBefore.length, 'No orphaned disk file must remain on disk after failed validation');
        assert.equal(countAfter, countBefore, 'No metadata record must be inserted in database after failed validation');
        assert.equal(costsAfter, costsBefore, 'Failed upload must not create partial project-cost records');

        // 5. Cross-Tenant Download Protection: User B tries to download User A attachment
        await assert.rejects(
            attachmentService.getAttachmentForDownload(uploadResult.id, bizB.id),
            (err) => (err.statusCode === 404 || err.status === 404 || /not found/i.test(err.message)),
            'Foreign tenant must NOT be able to download private attachment'
        );

        // 6. Authorized Tenant Download succeeds and byte contents match
        const downloadData = await attachmentService.getAttachmentForDownload(uploadResult.id, bizA.id);
        assert.equal(downloadData.attachment.id, uploadResult.id);
        assert.ok(fs.existsSync(downloadData.fullPath));
        const downloadedPdfBytes = fs.readFileSync(downloadData.fullPath);
        assert.deepEqual(downloadedPdfBytes, pdfHeader, 'Downloaded PDF bytes must match uploaded bytes exactly');

        // 7. Valid PNG image upload and download
        const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52]);
        const pngUpload = await attachmentService.saveAttachment({
            businessId: bizA.id,
            projectId: projectA.id,
            entityType: 'PROJECT',
            fileBuffer: pngHeader,
            originalFilename: 'site_blueprint.png',
            uploadedById: userA.id
        });
        assert.ok(pngUpload.id);
        assert.equal(pngUpload.mimeType, 'image/png');
        const pngDownload = await attachmentService.getAttachmentForDownload(pngUpload.id, bizA.id);
        assert.equal(pngDownload.attachment.id, pngUpload.id);
        const readBuffer = fs.readFileSync(pngDownload.fullPath);
        assert.deepEqual(readBuffer, pngHeader, 'Downloaded image bytes must match uploaded bytes exactly');
    });

    let smeBill;

    await t.test('Section 2: Shree Mahalaxmi Enterprises Regression Case Reconciliation', async () => {
        /**
         * CANONICAL REGRESSION SPECIFICATION (EXACT SOURCE INVOICE):
         * Supplier: SHREE MAHALAXMI ENTERPRISES (State 09: Uttar Pradesh, GSTIN: 09AMAPG1241K1ZC)
         * Supplier Address: B-31, Sector-9, Noida, Uttar Pradesh
         * Buyer: Rajesh International (State 06: Haryana, GSTIN: 06AORPS1239N4Z6) -> Interstate IGST @ 18%
         * Buyer Bill-To: 33-A Surya Colony Part 2, Sehatpur Extension, Faridabad, Haryana
         * Invoice Number: SME/26-27/6244 dated 17-Oct-2026
         *
         * Line 1: MS Pipe (HSN 73063090): 49.200 kg at ₹75 = ₹3,690.00
         * Line 2: DTT Weld Fittings (HSN 730793): 10 pc at ₹15 = ₹150.00
         * Line 3: Loading/cartage (SAC 996511): ₹397.00
         *
         * Taxable Total: ₹4,237.00
         * IGST: ₹762.66 (4237 * 18% = 762.66)
         * Round-off: ₹0.34
         * Invoice Total: ₹5,000.00
         *
         * Reconciliation Gate: ₹4,237.00 + ₹762.66 + ₹0.34 = ₹5,000.00
         */
        const billData = {
            supplierId: supplierSME.id,
            invoiceNumber: 'SME/26-27/6244',
            invoiceDate: '2026-10-17',
            dueDate: '2026-11-16',
            placeOfSupply: '06', // Delivered to Haryana project site
            billToName: 'Rajesh International',
            billToAddress: '33-A Surya Colony Part 2, Sehatpur Extension, Faridabad, Haryana',
            shipToName: 'Rajesh International',
            shipToAddress: 'Garden Galleria Mall, Gate No. 11, Sector 38A, Noida, Uttar Pradesh',
            orderReference: null,
            deliveryReference: null,
            notes: 'Project structural piping materials',
            projectId: projectA.id,
            attachmentId: uploadedAttachment.id,
            roundOff: 0.34,
            items: [
                {
                    itemDescription: 'MS Pipe',
                    quantity: 49.200,
                    unit: 'kg',
                    rate: 75.0,
                    hsnSac: '73063090',
                    gstRate: 18.0,
                    category: 'MATERIALS',
                    projectId: projectA.id
                },
                {
                    itemDescription: 'DTT Weld Fittings',
                    quantity: 10,
                    unit: 'pc',
                    rate: 15.0,
                    hsnSac: '730793',
                    gstRate: 18.0,
                    category: 'MATERIALS',
                    projectId: projectA.id
                },
                {
                    itemDescription: 'Loading/cartage',
                    quantity: 1,
                    unit: 'job',
                    rate: 397.0,
                    hsnSac: '996511',
                    gstRate: 18.0,
                    category: 'EXPENSE',
                    projectId: projectA.id
                }
            ]
        };

        smeBill = await supplierBillService.createSupplierBill(billData, userA.id, bizA.id);

        assert.ok(smeBill.id);
        assert.equal(smeBill.invoiceNumber, 'SME/26-27/6244');
        assert.equal(smeBill.billToName, 'Rajesh International');
        assert.equal(smeBill.billToAddress, '33-A Surya Colony Part 2, Sehatpur Extension, Faridabad, Haryana');
        assert.equal(smeBill.shipToName, 'Rajesh International');
        assert.equal(smeBill.shipToAddress, 'Garden Galleria Mall, Gate No. 11, Sector 38A, Noida, Uttar Pradesh');
        assert.notEqual(smeBill.billToAddress, smeBill.shipToAddress, 'Bill-to and ship-to addresses must remain distinct');
        assert.equal(smeBill.orderReference, null);
        assert.equal(smeBill.deliveryReference, null);
        assert.equal(smeBill.placeOfSupply, '06');
        assert.equal(smeBill.stateCode, '09');
        assert.equal(Number(smeBill.subtotal), 4237.0);
        assert.equal(Number(smeBill.igstAmount), 762.66);
        assert.equal(Number(smeBill.cgstAmount), 0.0);
        assert.equal(Number(smeBill.sgstAmount), 0.0);
        assert.equal(Number(smeBill.roundOff), 0.34);
        assert.equal(Number(smeBill.totalAmount), 5000.0);

        // Verify exact HSN/SAC codes
        assert.equal(smeBill.items[0].hsnSac, '73063090');
        assert.equal(smeBill.items[1].hsnSac, '730793');
        assert.equal(smeBill.items[2].hsnSac, '996511');

        // Arithmetic gate check
        const calculatedSum = Number(smeBill.subtotal) + Number(smeBill.igstAmount) + Number(smeBill.roundOff);
        assert.equal(calculatedSum, 5000.0, 'Reconciliation: 4,237.00 + 762.66 + 0.34 must equal 5,000.00');

        // Post the supplier bill into general ledger and project subledger
        const postedBill = await supplierBillService.postSupplierBill(smeBill.id, userA.id, bizA.id);
        assert.equal(postedBill.status, 'POSTED');
        assert.ok(postedBill.journalEntryId, 'Journal entry must be posted for supplier bill');

        // Verify project cost subledger entries were posted idempotently
        const subledgerCosts = await prisma.projectCost.findMany({
            where: {
                businessId: bizA.id,
                projectId: projectA.id,
                sourceType: 'SUPPLIER_BILL',
                sourceId: smeBill.id
            }
        });

        assert.equal(subledgerCosts.length, 3, 'Three line items must be posted into project cost ledger');

        const totalDirectProjectCost = subledgerCosts.reduce((sum, c) => sum + Number(c.amount), 0);
        assert.equal(totalDirectProjectCost, 4237.0, 'Recoverable IGST (762.66) must NOT inflate direct project cost!');
    });

    await t.test('Section 2: Duplicate Supplier Invoice Rejection', async () => {
        // Attempt to create duplicate invoice SME/26-27/6244 under the same supplier and business
        await assert.rejects(
            supplierBillService.createSupplierBill({
                supplierId: supplierSME.id,
                invoiceNumber: 'SME/26-27/6244',
                invoiceDate: '2026-10-17',
                dueDate: '2026-11-16',
                projectId: projectA.id,
                items: [{ itemDescription: 'Duplicate item', quantity: 1, rate: 100, gstRate: 18 }]
            }, userA.id, bizA.id),
            /already exists/i,
            'Duplicate supplier invoice number for the same supplier must be rejected'
        );
    });

    await t.test('Section 3: Idempotent Cost Posting & Ledger Constraint', async () => {
        // Posting the same cost entry with the same sourceId and sourceLineId must update, not duplicate
        const item1Cost = await projectCostLedgerService.recordCost({
            businessId: bizA.id,
            projectId: projectA.id,
            category: 'MATERIALS',
            sourceType: 'SUPPLIER_BILL',
            sourceId: smeBill.id,
            sourceLineId: 1,
            amount: 3690.0,
            quantity: 49.2,
            unit: 'kg',
            costDate: new Date('2026-10-17'),
            description: 'MS Pipe idempotent test',
            createdById: userA.id
        });

        assert.ok(item1Cost.id);

        // Count records in DB for this exact line
        const count = await prisma.projectCost.count({
            where: {
                businessId: bizA.id,
                sourceType: 'SUPPLIER_BILL',
                sourceId: smeBill.id,
                sourceLineId: 1
            }
        });

        assert.equal(count, 1, 'Subledger must enforce exactly one row per (businessId, sourceType, sourceId, sourceLineId)');
    });

    await t.test('Section 3: Tracked Inventory Purchase vs Stock Issue (No Double-Counting)', async () => {
        // 1. Create a tracked inventory item (e.g. Valves)
        trackedItem = await prisma.item.create({
            data: {
                business: { connect: { id: bizA.id } },
                itemCode: `ITM-VALVE-${Date.now()}`,
                name: 'High Pressure Ball Valve 2 inch',
                unit: 'PCS',
                rate: 500.0,
                gstRate: 18.0,
                createdBy: { connect: { id: userA.id } }
            }
        });

        // 2. Buy 20 Valves into central warehouse on a Supplier Bill
        const inventoryBill = await supplierBillService.createSupplierBill({
            supplierId: supplierSME.id,
            invoiceNumber: `INV-VALVES-${Date.now()}`,
            invoiceDate: '2026-10-18',
            dueDate: '2026-11-18',
            projectId: projectA.id, // Linked to project context but items are tracked inventory
            items: [
                {
                    itemId: trackedItem.id,
                    itemDescription: 'High Pressure Ball Valve 2 inch',
                    quantity: 20,
                    unit: 'PCS',
                    rate: 500.0,
                    gstRate: 18.0,
                    category: 'MATERIALS',
                    projectId: projectA.id
                }
            ]
        }, userA.id, bizA.id);

        await supplierBillService.postSupplierBill(inventoryBill.id, userA.id, bizA.id);

        // Verify that purchasing tracked inventory into warehouse DID NOT debit ProjectCost ledger
        const prematureCost = await prisma.projectCost.findFirst({
            where: {
                businessId: bizA.id,
                projectId: projectA.id,
                sourceType: 'SUPPLIER_BILL',
                sourceId: inventoryBill.id
            }
        });

        assert.equal(prematureCost, null, 'Purchasing warehouse inventory must NOT debit project costs until issued!');

        // 3. Issue 5 valves to Project A
        // When issued, stock movement posts consumption to Project Cost Subledger
        const stockMovement = await prisma.stockMovement.create({
            data: {
                movementNumber: `SM-${Date.now()}`,
                business: { connect: { id: bizA.id } },
                item: { connect: { id: trackedItem.id } },
                movementType: 'PROJECT_ISSUE',
                quantity: 5,
                unitCost: 500.0,
                totalCost: 2500.0,
                movementDate: new Date('2026-10-19'),
                project: { connect: { id: projectA.id } },
                notes: 'Issued 5 valves for Metro Line 4 piping manifold',
                createdBy: { connect: { id: userA.id } }
            }
        });

        const issueCost = await projectCostLedgerService.recordCost({
            businessId: bizA.id,
            projectId: projectA.id,
            category: 'MATERIALS',
            costType: 'MATERIAL',
            sourceType: 'STOCK_MOVEMENT',
            sourceId: stockMovement.id,
            sourceLineId: 0,
            sourceReference: stockMovement.reference,
            amount: 2500.0,
            quantity: 5,
            unit: 'pc',
            unitCost: 500.0,
            costDate: new Date('2026-10-19'),
            description: 'Issued 5 valves from warehouse to Project A',
            createdById: userA.id
        });

        assert.ok(issueCost.id);
        assert.equal(Number(issueCost.amount), 2500.0);
    });

    let taskA;

    await t.test('Section 4: Labour Stream 1 — Internal Staff Timesheets', async () => {
        // Create project task
        taskA = await projectService.createProjectTask(projectA.id, {
            title: 'Underground Pipe Welding & Radiography',
            estimatedHours: 40,
            assignedToUserId: userA.id,
            status: 'IN_PROGRESS'
        }, userA.id, bizA.id);

        // Employee logs 10 hours.
        // Sales rate = 850 (customer billable rate)
        // Internal Cost rate = 400 (configured on projectA)
        // Expected labour cost = 10 * 400 = 4,000.00
        const timesheet = await projectService.logTimesheet({
            projectId: projectA.id,
            taskId: taskA.id,
            entryDate: '2026-10-20',
            hours: 10,
            notes: 'Welded joints 1 through 12 and prep for NDT inspection'
        }, userA.id, bizA.id);

        assert.equal(Number(timesheet.hours), 10);
        assert.equal(Number(timesheet.costAmount), 4000.0, 'Labour cost must use costRate (400), not sales rate (850)');

        // Approve timesheet -> posts into project cost ledger
        const approvedTimesheet = await projectService.approveTimesheetEntry(timesheet.id, userA.id, bizA.id);
        assert.equal(approvedTimesheet.status, 'APPROVED');

        const labourCost = await prisma.projectCost.findFirst({
            where: {
                businessId: bizA.id,
                projectId: projectA.id,
                sourceType: 'TIMESHEET',
                sourceId: timesheet.id
            }
        });

        assert.ok(labourCost);
        assert.equal(labourCost.category, 'LABOUR');
        assert.equal(Number(labourCost.amount), 4000.0);
    });

    await t.test('Section 4: Labour Stream 2 — Daily / Casual Labour Muster Roll', async () => {
        // Register daily worker
        const worker = await projectService.createDailyWorker({
            name: 'Rameshwar Kumar',
            workerCode: `WRK-${Date.now()}`,
            trade: 'RIGGER',
            phone: '+91 91234 56789',
            defaultWageRate: 650.0,
            wageBasis: 'DAILY'
        }, bizA.id);

        assert.ok(worker.id);
        assert.equal(worker.businessId, bizA.id);

        // Record daily muster roll entry: 1 day work, wage 650, advance 150, net 500
        const labourEntry = await projectService.recordDailyLabour({
            projectId: projectA.id,
            workerId: worker.id,
            workDate: '2026-10-21',
            trade: 'RIGGER',
            hours: 8,
            wageRate: 650.0,
            wageBasis: 'DAILY',
            advancesDeducted: 150.0,
            paymentMethod: 'CASH',
            notes: 'Rigging and hoist assistance for heavy pipe sections'
        }, userA.id, bizA.id);

        assert.ok(labourEntry.id);
        assert.equal(Number(labourEntry.grossPayable), 650.0);
        assert.equal(Number(labourEntry.advancesDeducted), 150.0);
        assert.equal(Number(labourEntry.netPayable), 500.0);

        // Verify daily labour cost in subledger
        const dailyCost = await prisma.projectCost.findFirst({
            where: {
                businessId: bizA.id,
                projectId: projectA.id,
                sourceType: 'DAILY_LABOUR',
                sourceId: labourEntry.id
            }
        });

        assert.ok(dailyCost);
        assert.equal(dailyCost.category, 'LABOUR');
        assert.equal(Number(dailyCost.amount), 650.0, 'Gross labour wage (650) is the cost to the project');
    });

    await t.test('Section 4: Labour Stream 3 — Subcontractor Work Orders', async () => {
        // Create subcontractor work order with supplier SME or specialized contractor
        const workOrder = await projectService.createContractorWorkOrder({
            projectId: projectA.id,
            supplierId: supplierSME.id,
            contractTitle: 'Radiography & Ultrasonic NDT Inspection Subcontract',
            contractValue: 25000.0,
            withholdingTaxRate: 2.0, // 2% TDS on contractor
            startDate: '2026-10-22',
            endDate: '2026-10-25',
            terms: 'Payment within 15 days upon certified NDT inspection report'
        }, bizA.id);

        assert.ok(workOrder.id);
        assert.equal(Number(workOrder.contractValue), 25000.0);
        assert.equal(workOrder.businessId, bizA.id);

        // Subcontractor bills ₹12,000 for Milestone 1
        const subconCost = await projectCostLedgerService.recordCost({
            businessId: bizA.id,
            projectId: projectA.id,
            category: 'SUBCONTRACTOR',
            costType: 'SUBCONTRACTOR',
            sourceType: 'CONTRACTOR_ORDER',
            sourceId: workOrder.id,
            sourceLineId: 1,
            sourceReference: `WO-MILESTONE-1`,
            amount: 12000.0,
            costDate: new Date('2026-10-23'),
            description: 'Certified 50 weld radiography films',
            createdById: userA.id
        });

        assert.ok(subconCost.id);
        assert.equal(Number(subconCost.amount), 12000.0);
    });

    let customerInvoice;

    await t.test('Section 5: Customer Sales, Credit Notes & Actual Profit Calculation', async () => {
        /**
         * PROJECT A REVENUE FLOW:
         * Client: Reliance Metro Projects
         * Contract Value: ₹500,000.00
         * Customer Invoice 1:
         * Subtotal: ₹100,000.00
         * IGST/CGST/SGST (18%): ₹18,000.00
         * Grand Total: ₹118,000.00
         */
        const { ensureFinancialYear } = require('../app/services/financialYear.service');
        const fy = await ensureFinancialYear(new Date('2026-10-24'));

        customerInvoice = await prisma.invoice.create({
            data: {
                business: { connect: { id: bizA.id } },
                project: { connect: { id: projectA.id } },
                documentType: 'INVOICE',
                invoiceNumber: `INV-METRO-${Date.now()}`,
                clientName: 'Reliance Metro Projects',
                invoiceDate: new Date('2026-10-24'),
                financialYear: { connect: { id: fy.id } },
                subtotal: 100000.0,
                gstAmount: 18000.0,
                roundOff: 0.00,
                grandTotal: 118000.0,
                status: 'ACTIVE',
                createdBy: { connect: { id: userA.id } },
                updatedBy: { connect: { id: userA.id } }
            }
        });

        // Customer pays ₹60,000 towards the invoice
        await prisma.payment.create({
            data: {
                invoiceId: customerInvoice.id,
                paymentDate: new Date('2026-10-25'),
                amount: 60000.0,
                method: 'BANK_TRANSFER',
                reference: 'NEFT-REL-09823',
                status: 'POSTED'
            }
        });

        // Issue Credit Note of ₹5,000 (taxable subtotal) for quality tolerance deduction
        await prisma.creditDebitNote.create({
            data: {
                business: { connect: { id: bizA.id } },
                project: { connect: { id: projectA.id } },
                invoice: { connect: { id: customerInvoice.id } },
                financialYear: { connect: { id: fy.id } },
                noteType: 'CREDIT',
                noteNumber: `CN-METRO-${Date.now()}`,
                noteDate: new Date('2026-10-26'),
                clientName: 'Reliance Metro Projects',
                sellerName: 'Alpha Engineering Projects Private Limited',
                originalInvoiceNumber: customerInvoice.invoiceNumber,
                originalInvoiceDate: customerInvoice.invoiceDate,
                originalInvoiceGrandTotal: customerInvoice.grandTotal,
                subtotal: 5000.0,
                gstAmount: 900.0,
                grandTotal: 5900.0,
                reason: 'Minor dimensional variation rebate',
                status: 'ISSUED',
                createdBy: { connect: { id: userA.id } }
            }
        });

        // Get Financial Summary for Project A
        const summary = await projectService.getProjectFinancialSummary(projectA.id, bizA.id);

        // 1. Revenue verification:
        // Invoiced Revenue = Subtotal (100,000) - Credit Note (5,000) = 95,000.00
        // (Statutory GST 18,000 collected for govt is strictly excluded from corporate revenue!)
        assert.equal(summary.financials.revenue.invoiced, 95000.0);
        assert.equal(summary.financials.revenue.cashCollected, 60000.0);
        assert.equal(summary.financials.revenue.customerOutstanding, 58000.0); // 118,000 - 60,000 = 58,000

        // 2. Costs verification:
        // Materials: SME Bill (3690 + 150 = 3840) + Stock Issue (2500) = 6340.00
        // Other Expense: SME Cartage = 397.00
        // Labour: Timesheet (4000) + Daily Labour (650) = 4650.00
        // Subcontractor: Milestone 1 = 12000.00
        // Total Actual Cost = 6340 + 397 + 4650 + 12000 = 23,387.00
        assert.equal(summary.financials.costs.actualTotal, 23387.0);
        assert.equal(summary.financials.costs.materials, 6340.0);
        assert.equal(summary.financials.costs.labour, 4650.0);
        assert.equal(summary.financials.costs.subcontractor, 12000.0);
        assert.equal(summary.financials.costs.expense, 397.0);

        // 3. Profitability verification:
        // Margin = Net Invoiced Revenue (95,000) - Actual Cost (23,387) = 71,613.00
        assert.equal(summary.financials.profitability.margin, 71613.0);
        // Margin Percentage = (71613 / 95000) * 100 = 75.38%
        assert.equal(summary.financials.profitability.marginPercentage, 75.38);

        // Remaining Budget = Cost Budget (350,000) - Actual Cost (23,387) = 326,613.00
        assert.equal(summary.financials.profitability.remainingBudget, 326613.0);

        // Verification: Contract Value (500,000) is never conflated with Cost Budget (350,000)
        assert.equal(summary.financials.contractValue, 500000.0);
        assert.equal(summary.financials.costBudget, 350000.0);
        assert.notEqual(summary.financials.contractValue, summary.financials.costBudget);
    });

    await t.test('Section 7: Voiding and Controlled Reversals Audit', async () => {
        // Void an allocation in subledger
        const costToVoid = await prisma.projectCost.findFirst({
            where: {
                businessId: bizA.id,
                projectId: projectA.id,
                sourceReference: 'WO-MILESTONE-1'
            }
        });

        assert.ok(costToVoid);

        await projectCostLedgerService.voidCostAllocation(
            bizA.id,
            costToVoid.sourceType,
            costToVoid.sourceId,
            costToVoid.sourceLineId
        );

        // Verify status became VOID
        const voided = await prisma.projectCost.findUnique({ where: { id: costToVoid.id } });
        assert.equal(voided.status, 'VOID');

        // Re-check financial summary: voided cost of 12,000 must NO LONGER be counted!
        const updatedSummary = await projectService.getProjectFinancialSummary(projectA.id, bizA.id);
        assert.equal(updatedSummary.financials.costs.subcontractor, 0.0);
        assert.equal(updatedSummary.financials.costs.actualTotal, 23387.0 - 12000.0);
    });

    await prisma.$disconnect();
});
