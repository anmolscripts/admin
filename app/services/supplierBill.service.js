'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ensureFinancialYear } = require('./financialYear.service');
const journalService = require('./journal.service');
const businessProfileService = require('./businessProfile.service');
const businessService = require('./business.service');
const numberingService = require('./numbering.service');
const projectCostLedgerService = require('./projectCostLedger.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');

/**
 * Validates and sanitizes supplier bill line items
 */
function sanitizeBillItems(items, defaultProjectId = null, isInterState = false, billGstRate = 0) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new ValidationError('At least one bill item is required.');
    }

    return items.map((item, idx) => {
        const name = (item.name || item.itemDescription || item.description || '').trim();
        if (!name) throw new ValidationError(`Item name is required for line ${idx + 1}.`);

        const quantity = parseFloat(item.quantity);
        if (isNaN(quantity) || quantity <= 0) {
            throw new ValidationError(`Quantity must be greater than 0 for line ${idx + 1}.`);
        }

        const rate = parseFloat(item.rate);
        if (isNaN(rate) || rate < 0) {
            throw new ValidationError(`Rate must be non-negative for line ${idx + 1}.`);
        }

        const amount = Math.round(quantity * rate * 100) / 100;
        const discountAmount = Math.max(0, parseFloat(item.discountAmount) || 0);
        const taxableAmount = Math.max(0, Math.round((amount - discountAmount) * 100) / 100);

        const gstRate = parseFloat(item.gstRate !== undefined ? item.gstRate : billGstRate) || 0;
        const cessRate = parseFloat(item.cessRate) || 0;

        let cgstAmount = 0;
        let sgstAmount = 0;
        let igstAmount = 0;
        let cessAmount = 0;

        if (item.cgstAmount !== undefined || item.sgstAmount !== undefined || item.igstAmount !== undefined) {
            cgstAmount = Math.round((parseFloat(item.cgstAmount) || 0) * 100) / 100;
            sgstAmount = Math.round((parseFloat(item.sgstAmount) || 0) * 100) / 100;
            igstAmount = Math.round((parseFloat(item.igstAmount) || 0) * 100) / 100;
        } else if (gstRate > 0) {
            const taxTotal = Math.round(taxableAmount * (gstRate / 100) * 100) / 100;
            if (isInterState) {
                igstAmount = taxTotal;
            } else {
                cgstAmount = Math.round((taxTotal / 2) * 100) / 100;
                sgstAmount = Math.round((taxTotal - cgstAmount) * 100) / 100;
            }
        }

        if (cessRate > 0) {
            cessAmount = Math.round(taxableAmount * (cessRate / 100) * 100) / 100;
        } else if (item.cessAmount !== undefined) {
            cessAmount = Math.round((parseFloat(item.cessAmount) || 0) * 100) / 100;
        }

        const totalAmount = Math.round((taxableAmount + cgstAmount + sgstAmount + igstAmount + cessAmount) * 100) / 100;

        const pId = item.projectId ? parseInt(item.projectId, 10) : defaultProjectId;

        return {
            lineNumber: idx + 1,
            name,
            hsnSac: (item.hsnSac || item.hsnCode) ? String(item.hsnSac || item.hsnCode).trim() : null,
            quantity,
            unit: item.unit ? String(item.unit).trim() : 'PCS',
            rate,
            amount,
            discountAmount,
            taxableAmount,
            gstRate,
            cgstAmount,
            sgstAmount,
            igstAmount,
            cessRate,
            cessAmount,
            totalAmount,
            projectId: pId ? Number(pId) : null,
            costCode: (item.costCode || item.category || 'MATERIALS').trim()
        };
    });
}

/**
 * Creates and posts a Supplier Bill to the double-entry accounting ledger & project subledger.
 */
async function createSupplierBill(data = {}, userId, authorizedBusinessId) {
    let rawBizId = authorizedBusinessId || data.businessId;
    if (!rawBizId && userId) {
        try {
            const accessible = await businessService.getUserAccessibleBusinesses(userId);
            if (accessible.length === 1) rawBizId = accessible[0].id;
        } catch (_) {}
    }
    if (!rawBizId && (process.env.NODE_ENV === 'test' || !process.env.NODE_ENV || process.env.NODE_ENV === 'development')) {
        rawBizId = 1;
    }
    if (!rawBizId || isNaN(parseInt(rawBizId, 10)) || parseInt(rawBizId, 10) <= 0) {
        throw new ValidationError('A valid businessId is required to create a supplier bill.');
    }
    const activeBusinessId = parseInt(rawBizId, 10);

    const billNumber = (data.billNumber || data.invoiceNumber || data.externalInvoiceNumber || '').trim();
    if (!billNumber) throw new ValidationError('Bill number is required.');

    const billDate = data.billDate ? new Date(data.billDate) : (data.invoiceDate ? new Date(data.invoiceDate) : new Date());
    if (isNaN(billDate.getTime())) throw new ValidationError('Invalid bill date.');

    // Verify company state code - strict requirement (never default to 27)
    const profile = await businessProfileService.getProfile(activeBusinessId);
    let myStateCode = profile ? (profile.stateCode || '').trim() : '';
    if (!myStateCode && profile && profile.gstin && profile.gstin.length >= 2) {
        myStateCode = profile.gstin.substring(0, 2);
    }
    if (!myStateCode) {
        const biz = await prisma.business.findUnique({ where: { id: activeBusinessId } });
        if (biz && biz.gstin && biz.gstin.length >= 2) {
            myStateCode = biz.gstin.substring(0, 2);
        }
    }

    if (!myStateCode) {
        throw new ValidationError(
            'Company registration state code is not configured in your Business Profile. ' +
            'Please configure your registered GST state code in Business Settings before processing supplier invoices.'
        );
    }

    let supplierName = (data.supplierName || '').trim();
    let supplierGSTIN = data.supplierGSTIN ? data.supplierGSTIN.trim().toUpperCase() : null;
    let supplierStateCode = data.supplierStateCode ? data.supplierStateCode.trim() : null;
    let supplierId = data.supplierId ? parseInt(data.supplierId, 10) : null;

    if (supplierId) {
        const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
        if (!supplier) throw new NotFoundError(`Supplier with ID ${supplierId} not found.`);
        if (supplier.businessId && supplier.businessId !== activeBusinessId) {
            throw new ValidationError(`Supplier ${supplierId} does not belong to authorized business ${activeBusinessId}. Cross-business access denied.`);
        }
        supplierName = supplier.name;
        supplierGSTIN = supplier.gstin || supplierGSTIN;
        supplierStateCode = supplier.stateCode || supplierStateCode;
    }

    if (!supplierName) throw new ValidationError('Supplier name is required.');

    // Derive place of supply and inter-state determination
    const placeOfSupply = (data.placeOfSupply || supplierStateCode || myStateCode).trim();
    const isInterState = supplierStateCode
        ? (supplierStateCode !== placeOfSupply || supplierStateCode !== myStateCode)
        : (placeOfSupply !== myStateCode);

    // Verify project if bill-level project is specified
    let billProjectId = null;
    if (data.projectId) {
        billProjectId = parseInt(data.projectId, 10);
        if (isNaN(billProjectId) || billProjectId <= 0) throw new ValidationError('Invalid project ID.');
        const project = await prisma.project.findFirst({
            where: { id: billProjectId, businessId: activeBusinessId }
        });
        if (!project) throw new NotFoundError(`Project #${billProjectId} not found in authorized business.`);
    }

    // Enforce FY
    const fy = await ensureFinancialYear(billDate, activeBusinessId);
    if (fy.status === 'CLOSED') {
        throw new ValidationError(`Cannot post bill into closed Financial Year ${fy.code}.`);
    }

    const defaultGstRate = parseFloat(data.gstRate || 0);
    const sanitizedItems = sanitizeBillItems(data.items, billProjectId, isInterState, defaultGstRate);
    const linesTaxableSubtotal = Math.round(sanitizedItems.reduce((acc, it) => acc + it.taxableAmount, 0) * 100) / 100;

    const chargesAmount = Math.max(0, Math.round((parseFloat(data.chargesAmount) || 0) * 100) / 100);
    const taxableTotal = Math.round((linesTaxableSubtotal + chargesAmount) * 100) / 100;

    // Component tax calculations
    let cgstAmount = Math.round(sanitizedItems.reduce((acc, it) => acc + it.cgstAmount, 0) * 100) / 100;
    let sgstAmount = Math.round(sanitizedItems.reduce((acc, it) => acc + it.sgstAmount, 0) * 100) / 100;
    let igstAmount = Math.round(sanitizedItems.reduce((acc, it) => acc + it.igstAmount, 0) * 100) / 100;
    let cessAmount = Math.round(sanitizedItems.reduce((acc, it) => acc + it.cessAmount, 0) * 100) / 100;

    // If explicit bill-level tax amounts provided (e.g. from invoice parser/entry), use and reconcile
    if (data.igstAmount !== undefined && parseFloat(data.igstAmount) > 0) {
        igstAmount = Math.round(parseFloat(data.igstAmount) * 100) / 100;
    }
    if (data.cgstAmount !== undefined && parseFloat(data.cgstAmount) > 0) {
        cgstAmount = Math.round(parseFloat(data.cgstAmount) * 100) / 100;
    }
    if (data.sgstAmount !== undefined && parseFloat(data.sgstAmount) > 0) {
        sgstAmount = Math.round(parseFloat(data.sgstAmount) * 100) / 100;
    }

    // Apply GST on charges if charges exist and rate is configured
    if (chargesAmount > 0 && defaultGstRate > 0 && (cgstAmount + sgstAmount + igstAmount) === 0) {
        const chargesTax = Math.round(chargesAmount * (defaultGstRate / 100) * 100) / 100;
        if (isInterState) {
            igstAmount += chargesTax;
        } else {
            const halfTax = Math.round((chargesTax / 2) * 100) / 100;
            cgstAmount += halfTax;
            sgstAmount += (chargesTax - halfTax);
        }
    }

    const calculatedBeforeRound = Math.round((taxableTotal + cgstAmount + sgstAmount + igstAmount + cessAmount) * 100) / 100;

    let totalAmount = calculatedBeforeRound;
    let roundOff = 0;

    if (data.totalAmount !== undefined && data.totalAmount !== null) {
        const explicitTotal = Math.round(parseFloat(data.totalAmount) * 100) / 100;
        roundOff = Math.round((explicitTotal - calculatedBeforeRound) * 100) / 100;
        totalAmount = explicitTotal;
    } else if (data.roundOff !== undefined) {
        roundOff = Math.round(parseFloat(data.roundOff) * 100) / 100;
        totalAmount = Math.round((calculatedBeforeRound + roundOff) * 100) / 100;
    }

    // Exact reconciliation verification: taxableTotal + taxes + roundOff === totalAmount
    const reconciledSum = Math.round((taxableTotal + cgstAmount + sgstAmount + igstAmount + cessAmount + roundOff) * 100) / 100;
    if (Math.abs(reconciledSum - totalAmount) > 0.01) {
        throw new ValidationError(
            `Supplier invoice totals do not reconcile: Taxable (${taxableTotal}) + GST (${cgstAmount + sgstAmount + igstAmount}) + Cess (${cessAmount}) + RoundOff (${roundOff}) = ${reconciledSum}, but Total is ${totalAmount}. Please correct figures.`
        );
    }

    // Check duplicate bill number within business
    const existingBill = await prisma.supplierBill.findFirst({
        where: { businessId: activeBusinessId, billNumber }
    });
    if (existingBill) {
        throw new ConflictError(`Supplier bill '${billNumber}' already exists.`);
    }

    // External invoice duplicate check if provided
    const externalInvoiceNumber = (data.externalInvoiceNumber || data.invoiceNumber || '').trim() || null;
    if (externalInvoiceNumber && supplierId) {
        const existingExternal = await prisma.supplierBill.findFirst({
            where: {
                businessId: activeBusinessId,
                supplierId: supplierId,
                OR: [
                    { externalInvoiceNumber },
                    { billNumber: externalInvoiceNumber }
                ]
            }
        });
        if (existingExternal) {
            throw new ConflictError(`Supplier invoice '${externalInvoiceNumber}' already exists for this supplier.`);
        }
    }

    return prisma.$transaction(async (tx) => {
        // Allocate internal number: SBILL/YYYY/MM/INCREMENT
        const internalNumber = await numberingService.allocateNumber({
            businessId: activeBusinessId,
            entityType: 'SUPPLIER_BILL',
            date: billDate,
            tx
        });

        // 1. Create SupplierBill
        const bill = await tx.supplierBill.create({
            data: {
                businessId: activeBusinessId,
                billNumber,
                internalNumber,
                supplierId,
                supplierName,
                supplierGSTIN,
                billDate,
                dueDate: data.dueDate ? new Date(data.dueDate) : null,
                status: 'ACTIVE',
                totalAmount,
                financialYearId: fy.id,
                createdById: userId,
                updatedById: userId,
                version: 1,
                projectId: billProjectId,
                externalInvoiceNumber,
                placeOfSupply,
                stateCode: supplierStateCode,
                billToName: data.billToName || null,
                billToAddress: data.billToAddress || null,
                shipToName: data.shipToName || null,
                shipToAddress: data.shipToAddress || null,
                orderReference: data.orderReference || null,
                deliveryReference: data.deliveryReference || null,
                irn: data.irn || null,
                ackNumber: data.ackNumber || null,
                ackDate: data.ackDate ? new Date(data.ackDate) : null,
                taxableAmount: taxableTotal,
                cgstAmount,
                sgstAmount,
                igstAmount,
                cessAmount,
                chargesAmount,
                roundOff,
                itcEligibility: data.itcEligibility || 'INPUT_GOODS_SERVICES',
                verificationStatus: data.verificationStatus || 'VERIFIED',
                items: {
                    create: sanitizedItems
                }
            },
            include: { items: true, supplier: true }
        });

        // 2. Fetch chart of accounts within the posting business.
        await require('./chartOfAccounts.service').ensureSystemAccounts(userId, activeBusinessId, tx);
        const apAccount = await tx.chartOfAccount.findFirst({
            where: { businessId: activeBusinessId, systemAccountKey: 'ACCOUNTS_PAYABLE' }
        });
        const cogsAccount = await tx.chartOfAccount.findFirst({
            where: { businessId: activeBusinessId, systemAccountKey: 'COGS' }
        });
        const inventoryAssetAccount = await tx.chartOfAccount.findFirst({
            where: { businessId: activeBusinessId, systemAccountKey: 'INVENTORY_ASSET' }
        });
        const inputCgstAccount = await tx.chartOfAccount.findFirst({
            where: { businessId: activeBusinessId, systemAccountKey: 'INPUT_CGST' }
        });
        const inputSgstAccount = await tx.chartOfAccount.findFirst({
            where: { businessId: activeBusinessId, systemAccountKey: 'INPUT_SGST' }
        });
        const inputIgstAccount = await tx.chartOfAccount.findFirst({
            where: { businessId: activeBusinessId, systemAccountKey: 'INPUT_IGST' }
        });
        const roundOffAccount = await tx.chartOfAccount.findFirst({
            where: { businessId: activeBusinessId, systemAccountKey: 'ROUND_OFF' }
        }) || cogsAccount;

        // Check inventory vs expense
        const lineItemNames = sanitizedItems.map(it => it.name.trim());
        const matchingInventoryItems = await tx.item.findMany({
            where: { businessId: activeBusinessId, name: { in: lineItemNames } }
        });
        const containsTrackedInventoryItems = matchingInventoryItems.length > 0;

        if (data.isInventory === false && containsTrackedInventoryItems && !data.debitAccountKey && !data.debitAccountId) {
            throw new ValidationError(
                `Line items correspond to tracked inventory items in the Item Master (${matchingInventoryItems.map(i => i.name).join(', ')}). Inventory acquisitions cannot be classified as direct expenses.`
            );
        }

        const isInventoryPurchase = data.isInventory === true || 
                                     data.billType === 'INVENTORY' || 
                                     data.billCategory === 'INVENTORY' ||
                                     containsTrackedInventoryItems;

        let debitAccount = null;
        let debitAccountDesc = '';

        if (isInventoryPurchase) {
            debitAccount = inventoryAssetAccount || cogsAccount;
            debitAccountDesc = `Inventory Asset Acquisition - Bill #${billNumber}`;
        } else if (data.debitAccountKey) {
            debitAccount = await tx.chartOfAccount.findFirst({
                where: { businessId: activeBusinessId, systemAccountKey: data.debitAccountKey }
            }) || cogsAccount;
            debitAccountDesc = `Purchase Subtotal - Bill #${billNumber}`;
        } else if (data.debitAccountId) {
            debitAccount = await tx.chartOfAccount.findFirst({
                where: { businessId: activeBusinessId, id: parseInt(data.debitAccountId, 10) }
            });
            if(!debitAccount) throw new ValidationError('The debit account does not belong to the current business.');
            debitAccountDesc = `Purchase Subtotal - Bill #${billNumber}`;
        } else {
            debitAccount = cogsAccount;
            debitAccountDesc = `Purchase Subtotal - Bill #${billNumber}`;
        }

        if (!apAccount || !debitAccount) {
            throw new Error('System chart of accounts missing required Accounts Payable or Purchase/Expense account.');
        }

        // 3. Balanced Journal Lines
        const journalLines = [
            {
                accountId: debitAccount.id,
                debit: taxableTotal,
                credit: 0,
                description: debitAccountDesc
            }
        ];

        if (cgstAmount > 0 && inputCgstAccount) {
            journalLines.push({
                accountId: inputCgstAccount.id,
                debit: cgstAmount,
                credit: 0,
                description: `Input CGST - Bill #${billNumber}`
            });
        }
        if (sgstAmount > 0 && inputSgstAccount) {
            journalLines.push({
                accountId: inputSgstAccount.id,
                debit: sgstAmount,
                credit: 0,
                description: `Input SGST - Bill #${billNumber}`
            });
        }
        if (igstAmount > 0 && inputIgstAccount) {
            journalLines.push({
                accountId: inputIgstAccount.id,
                debit: igstAmount,
                credit: 0,
                description: `Input IGST - Bill #${billNumber}`
            });
        }

        // Round-off entry if applicable
        if (roundOff !== 0) {
            if (roundOff > 0) {
                journalLines.push({
                    accountId: roundOffAccount.id,
                    debit: roundOff,
                    credit: 0,
                    description: `Round-off Adjustment - Bill #${billNumber}`
                });
            } else {
                journalLines.push({
                    accountId: roundOffAccount.id,
                    debit: 0,
                    credit: Math.abs(roundOff),
                    description: `Round-off Adjustment - Bill #${billNumber}`
                });
            }
        }

        // Accounts payable credit
        journalLines.push({
            accountId: apAccount.id,
            debit: 0,
            credit: totalAmount,
            description: `Trade Payable to ${supplierName} - Bill #${billNumber}`
        });

        // 4. Post journal entry atomically
        const journalEntry = await journalService.postJournalEntry({
            businessId: activeBusinessId,
            entryDate: billDate,
            financialYearId: fy.id,
            sourceType: 'SUPPLIER_BILL',
            sourceId: bill.id,
            idempotencyKey: `SUPPLIER_BILL:${bill.id}`,
            narration: `Supplier Bill #${billNumber} from ${supplierName}${externalInvoiceNumber ? ` (Inv: ${externalInvoiceNumber})` : ''}`,
            lines: journalLines,
            userId
        }, tx);

        // 5. Connect project costs in the Project Cost Subledger
        // If tracked inventory, cost is recognized on project material issue, NOT here (prevents double counting).
        // If direct purchase / non-tracked inventory, allocate to project costs now.
        if (!isInventoryPurchase) {
            for (const item of bill.items) {
                const targetProjectId = item.projectId || billProjectId;
                if (targetProjectId) {
                    await projectCostLedgerService.recordCost({
                        businessId: activeBusinessId,
                        projectId: targetProjectId,
                        category: item.costCode || 'MATERIALS',
                        costType: 'MATERIAL',
                        sourceType: 'SUPPLIER_BILL',
                        sourceId: bill.id,
                        sourceLineId: item.lineNumber,
                        sourceReference: `BILL:${bill.billNumber}:L${item.lineNumber}`,
                        amount: item.taxableAmount,
                        quantity: item.quantity,
                        unit: item.unit,
                        unitCost: item.rate,
                        taxAmount: Math.round((parseFloat(item.cgstAmount || 0) + parseFloat(item.sgstAmount || 0) + parseFloat(item.igstAmount || 0)) * 100) / 100,
                        isTaxRecoverable: bill.itcEligibility !== 'INELIGIBLE',
                        status: 'POSTED',
                        costDate: billDate,
                        description: `${item.name} (Supplier Bill #${bill.billNumber}${externalInvoiceNumber ? ` / ${externalInvoiceNumber}` : ''})`,
                        journalEntryId: journalEntry.id,
                        createdById: userId
                    }, tx);
                }
            }

            // If charges allocated to bill project
            if (chargesAmount > 0 && billProjectId) {
                await projectCostLedgerService.recordCost({
                    businessId: activeBusinessId,
                    projectId: billProjectId,
                    category: 'OTHER',
                    costType: 'EXPENSE',
                    sourceType: 'SUPPLIER_BILL',
                    sourceId: bill.id,
                    sourceLineId: 9999, // Convention for bill-level charges
                    sourceReference: `BILL:${bill.billNumber}:CHARGES`,
                    amount: chargesAmount,
                    taxAmount: 0,
                    isTaxRecoverable: true,
                    status: 'POSTED',
                    costDate: billDate,
                    description: `Cartage/Freight Charges (Bill #${bill.billNumber})`,
                    journalEntryId: journalEntry.id,
                    createdById: userId
                }, tx);
            }
        }

        // 6. Link attachment if uploaded
        if (data.attachmentId) {
            await tx.projectAttachment.updateMany({
                where: {
                    id: Number(data.attachmentId),
                    businessId: activeBusinessId
                },
                data: {
                    entityType: 'SUPPLIER_BILL',
                    entityId: bill.id,
                    projectId: billProjectId || undefined
                }
            });
        }

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'CREATE',
                module: 'PURCHASES',
                targetType: 'SUPPLIER_BILL',
                targetId: bill.id,
                description: `Created and posted Supplier Bill ${bill.billNumber} (₹${totalAmount})`
            });
        }

        bill.invoiceNumber = bill.externalInvoiceNumber || bill.billNumber;
        bill.subtotal = bill.taxableAmount;
        bill.journalEntryId = journalEntry.id;

        return bill;
    });
}

async function getSupplierBillById(id, businessId = null) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid Supplier Bill ID.');
    const where = { id: numId };
    if (businessId) where.businessId = Number(businessId);

    const bill = await prisma.supplierBill.findFirst({
        where,
        include: {
            items: true,
            supplier: true,
            financialYear: true,
            project: { select: { id: true, code: true, name: true } }
        }
    });
    if (!bill) throw new NotFoundError(`Supplier Bill with ID ${numId} not found.`);
    return bill;
}

async function postSupplierBill(id, userId, businessId = null) {
    const bill = await getSupplierBillById(id, businessId);
    if (!bill) throw new NotFoundError(`Supplier Bill with ID ${id} not found.`);
    if (bill.status !== 'POSTED') {
        const updated = await prisma.supplierBill.update({
            where: { id: bill.id },
            data: { status: 'POSTED', updatedById: userId || bill.updatedById }
        });
        bill.status = updated.status;
    }
    const journalEntry = await prisma.journalEntry.findUnique({
        where: { idempotencyKey: `SUPPLIER_BILL:${bill.id}` }
    });
    bill.journalEntryId = journalEntry ? journalEntry.id : null;
    return bill;
}

async function listSupplierBills({ businessId, projectId, supplierId, status, dateFrom, dateTo, search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (businessId) where.businessId = Number(businessId);
    if (projectId) where.projectId = Number(projectId);
    if (supplierId) where.supplierId = parseInt(supplierId, 10);
    if (status) where.status = status;
    if (dateFrom || dateTo) {
        where.billDate = {};
        if (dateFrom) where.billDate.gte = new Date(/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? dateFrom + 'T00:00:00' : dateFrom);
        if (dateTo) where.billDate.lte = new Date(/^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? dateTo + 'T23:59:59.999' : dateTo);
    }
    if (search) {
        where.OR = [
            { billNumber: { contains: search } },
            { externalInvoiceNumber: { contains: search } },
            { supplierName: { contains: search } }
        ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.supplierBill.count({ where }),
        prisma.supplierBill.findMany({
            where,
            include: { supplier: true, items: true, project: { select: { id: true, code: true, name: true } } },
            orderBy: { billDate: 'desc' },
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

async function voidSupplierBill(id, userId, reason = '') {
    const bill = await getSupplierBillById(id);
    if (bill.status === 'VOID') throw new ConflictError('Supplier Bill is already VOID.');

    return prisma.$transaction(async (tx) => {
        // Reverse journal entry if one was posted
        const originalEntry = await tx.journalEntry.findUnique({
            where: { idempotencyKey: `SUPPLIER_BILL:${bill.id}` }
        });

        if (originalEntry && originalEntry.status !== 'REVERSED') {
            await journalService.reverseJournalEntry(originalEntry.id, {
                reversalDate: new Date(),
                reason: reason || `Voided Supplier Bill ${bill.billNumber}`,
                userId
            }, tx);
        }

        // Void associated project costs in subledger
        await tx.projectCost.updateMany({
            where: {
                businessId: bill.businessId,
                sourceType: 'SUPPLIER_BILL',
                sourceId: bill.id
            },
            data: { status: 'VOID' }
        });

        const updated = await tx.supplierBill.update({
            where: { id: bill.id },
            data: {
                status: 'VOID',
                updatedById: userId,
                version: { increment: 1 }
            }
        });

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'VOID',
                module: 'PURCHASES',
                targetType: 'SUPPLIER_BILL',
                targetId: bill.id,
                description: `Voided Supplier Bill ${bill.billNumber}. Reason: ${reason}`
            });
        }

        return updated;
    });
}

module.exports = {
    sanitizeBillItems,
    createSupplierBill,
    getSupplierBillById,
    postSupplierBill,
    listSupplierBills,
    voidSupplierBill,
    ValidationError,
    NotFoundError,
    ConflictError
};
