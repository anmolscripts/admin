'use strict';

const prisma = require('../config/prisma');
const projectService = require('../services/project.service');
const attachmentService = require('../services/attachment.service');
const projectCostLedgerService = require('../services/projectCostLedger.service');
const stockMovementService = require('../services/stockMovement.service');

/**
 * -------------------------------------------------------------
 * VIEW RENDERING CONTROLLERS (AURORA GLASS DESIGN SYSTEM)
 * -------------------------------------------------------------
 */

/**
 * Render /projects workspace list
 */
async function renderProjectsList(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) {
            return res.redirect('/select-business');
        }

        const { status, clientId, search, page } = req.query;
        const result = await projectService.listProjects({
            businessId,
            status,
            clientId,
            search,
            page: page || 1,
            limit: 20
        });

        // Compute top-level portfolio KPIs
        const allProjects = await prisma.project.findMany({
            where: { businessId },
            include: {
                costs: { where: { status: 'POSTED' } },
                invoices: { where: { status: 'ACTIVE', documentType: 'INVOICE' } }
            }
        });

        let portfolioContractValue = 0;
        let portfolioBudget = 0;
        let portfolioActualCost = 0;
        let portfolioInvoiced = 0;
        let activeCount = 0;

        for (const p of allProjects) {
            portfolioContractValue += parseFloat(p.contractValue) || 0;
            portfolioBudget += parseFloat(p.budgetAmount) || 0;
            if (p.status === 'ACTIVE') activeCount++;

            for (const c of p.costs) {
                portfolioActualCost += parseFloat(c.amount) || 0;
            }
            for (const inv of p.invoices) {
                portfolioInvoiced += parseFloat(inv.subtotal) || 0;
            }
        }

        const portfolioMargin = Math.round((portfolioInvoiced - portfolioActualCost) * 100) / 100;
        const clients = await prisma.client.findMany({
            where: { businessId, active: true },
            orderBy: { name: 'asc' }
        });

        res.render('projects/index', {
            pageTitle: 'Projects Workspace',
            projects: result.records,
            totalProjects: result.total,
            currentPage: result.page,
            totalPages: Math.ceil(result.total / result.limit) || 1,
            kpis: {
                totalCount: allProjects.length,
                activeCount,
                contractValue: Math.round(portfolioContractValue * 100) / 100,
                budget: Math.round(portfolioBudget * 100) / 100,
                actualCost: Math.round(portfolioActualCost * 100) / 100,
                invoiced: Math.round(portfolioInvoiced * 100) / 100,
                margin: portfolioMargin
            },
            clients,
            filters: { status: status || '', clientId: clientId || '', search: search || '' }
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Render /projects/new editor
 */
async function renderNewProject(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.redirect('/select-business');

        const [clients, users] = await Promise.all([
            prisma.client.findMany({ where: { businessId, active: true }, orderBy: { name: 'asc' } }),
            prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } })
        ]);

        res.render('projects/editor', {
            pageTitle: 'New Project',
            project: null,
            clients,
            users,
            isEdit: false
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Render /projects/:id/edit editor
 */
async function renderEditProject(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.redirect('/select-business');

        const project = await projectService.getProjectById(req.params.id, businessId);
        const [clients, users] = await Promise.all([
            prisma.client.findMany({ where: { businessId, active: true }, orderBy: { name: 'asc' } }),
            prisma.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } })
        ]);

        res.render('projects/editor', {
            pageTitle: `Edit Project — ${project.code}`,
            project,
            clients,
            users,
            isEdit: true
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Render /projects/:id full workspace with 9 sections
 */
async function renderProjectDetails(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.redirect('/select-business');

        const projectId = parseInt(req.params.id, 10);
        const project = await projectService.getProjectById(projectId, businessId);
        const summary = await projectService.getProjectFinancialSummary(projectId, businessId);

        // Fetch section records strictly scoped to tenant
        const [
            supplierBills,
            stockMovements,
            timesheets,
            dailyLabour,
            contractorOrders,
            expenses,
            invoices,
            quotations,
            purchaseOrders,
            goodsReceipts,
            creditNotes,
            tasks,
            attachments,
            subledgerCosts,
            dailyWorkers,
            suppliers,
            inventoryItems,
            manualCosts,
            activityLogs,
            reimbursements
        ] = await Promise.all([
            prisma.supplierBill.findMany({
                where: { businessId, projectId },
                include: {
                    supplier: true,
                    items: true,
                    createdBy: { select: { id: true, name: true } },
                    supplierPayments: { include: { createdBy: { select: { id: true, name: true } } } }
                },
                orderBy: { billDate: 'desc' }
            }),
            prisma.stockMovement.findMany({
                where: { businessId, projectId },
                include: { item: true },
                orderBy: { movementDate: 'desc' }
            }),
            prisma.timesheetEntry.findMany({
                where: { projectId },
                include: { user: { select: { id: true, name: true } }, task: true },
                orderBy: { entryDate: 'desc' }
            }),
            projectService.listDailyLabour(projectId, businessId),
            projectService.listContractorWorkOrders(projectId, businessId),
            prisma.expense.findMany({
                where: { businessId, projectId },
                include: { createdBy: { select: { id: true, name: true } } },
                orderBy: { expenseDate: 'desc' }
            }),
            prisma.invoice.findMany({
                where: { businessId, projectId, documentType: 'INVOICE' },
                include: {
                    createdBy: { select: { id: true, name: true } },
                    payments: { include: { createdBy: { select: { id: true, name: true } } } }
                },
                orderBy: { invoiceDate: 'desc' }
            }),
            prisma.invoice.findMany({
                where: { businessId, projectId, documentType: 'QUOTATION' },
                include: { createdBy: { select: { id: true, name: true } } },
                orderBy: { invoiceDate: 'desc' }
            }),
            prisma.purchaseOrder.findMany({
                where: { businessId, projectId },
                include: {
                    supplier: true,
                    items: true,
                    createdBy: { select: { id: true, name: true } }
                },
                orderBy: { orderDate: 'desc' }
            }),
            prisma.goodsReceipt.findMany({
                where: { businessId, projectId },
                include: {
                    supplier: true,
                    items: true,
                    receivedBy: { select: { id: true, name: true } }
                },
                orderBy: { receiptDate: 'desc' }
            }),
            prisma.creditDebitNote.findMany({
                where: { businessId, projectId },
                include: { createdBy: { select: { id: true, name: true } } },
                orderBy: { noteDate: 'desc' }
            }),
            prisma.projectTask.findMany({
                where: { projectId },
                include: { assignedTo: { select: { id: true, name: true } } },
                orderBy: { createdAt: 'desc' }
            }),
            attachmentService.listAttachments({ businessId, projectId }),
            projectCostLedgerService.listProjectCosts(projectId, businessId, { limit: 100 }),
            projectService.listDailyWorkers(businessId),
            prisma.supplier.findMany({ where: { businessId, active: true }, orderBy: { name: 'asc' } }),
            prisma.item.findMany({ where: { businessId, active: true }, orderBy: { name: 'asc' } }),
            prisma.projectCost.findMany({
                where: { businessId, projectId, sourceType: 'MANUAL', status: 'POSTED' },
                orderBy: { costDate: 'desc' }
            }),
            prisma.userActivityLog.findMany({
                where: {
                    OR: [{ businessId: project.businessId }, { businessId: null }],
                    module: 'PROJECTS',
                    targetType: 'PROJECT',
                    targetId: String(project.id)
                },
                include: { actorUser: { select: { id: true, name: true } } },
                orderBy: { createdAt: 'asc' }
            }),
            prisma.employeeReimbursement.findMany({
                where: { businessId, projectId },
                include: { employee: { select: { firstName: true, lastName: true } }, approvedBy: { select: { name: true } } },
                orderBy: { expenseDate: 'desc' }
            })
        ]);

        // General Ledger subledger reconciliation check
        const totalSubledgerAmount = subledgerCosts.records.reduce((acc, c) => acc + (parseFloat(c.amount) || 0), 0);
        const glDiscrepancy = Math.abs(totalSubledgerAmount - summary.financials.costs.actualTotal);
        const isReconciled = glDiscrepancy < 0.05;

        // Build Chronological Unified Activity Timeline (Phase 9)
        const timelineEvents = [];

        // 1. Project Creation
        timelineEvents.push({
            type: 'PROJECT',
            badge: 'Project Initiated',
            title: `Project ${project.code} Created`,
            description: project.description || `Contract Value: ₹${parseFloat(project.contractValue || 0).toLocaleString('en-IN')}`,
            date: project.createdAt,
            actor: project.createdBy ? project.createdBy.name : 'System',
            status: project.status,
            link: null
        });

        // 2. Quotations
        for (const q of quotations) {
            timelineEvents.push({
                type: 'QUOTATION',
                badge: 'Quotation Sent',
                title: `Quotation ${q.invoiceNumber}`,
                description: `Client: ${q.clientName} | Amount: ₹${parseFloat(q.grandTotal || 0).toLocaleString('en-IN')}`,
                date: q.createdAt || q.invoiceDate,
                actor: q.createdBy ? q.createdBy.name : 'Sales Team',
                status: q.status,
                link: `/documents/${q.id}`
            });
        }

        // 3. Invoices & Payments
        for (const inv of invoices) {
            timelineEvents.push({
                type: 'INVOICE',
                badge: 'Invoice Issued',
                title: `Invoice ${inv.invoiceNumber}`,
                description: `Subtotal: ₹${parseFloat(inv.subtotal || 0).toLocaleString('en-IN')} | Total: ₹${parseFloat(inv.grandTotal || 0).toLocaleString('en-IN')}`,
                date: inv.createdAt || inv.invoiceDate,
                actor: inv.createdBy ? inv.createdBy.name : 'Billing',
                status: inv.status,
                link: `/documents/${inv.id}`
            });

            if (Array.isArray(inv.payments)) {
                for (const pay of inv.payments) {
                    const pendingCheque = pay.method === 'CHEQUE' && pay.status === 'PENDING_CLEARANCE';
                    const voidedPayment = pay.status === 'VOID';
                    timelineEvents.push({
                        type: 'PAYMENT',
                        badge: pendingCheque ? 'Cheque Pending' : (voidedPayment ? 'Payment Voided' : 'Customer Payment'),
                        title: pendingCheque
                            ? `Cheque Received for ${inv.invoiceNumber}`
                            : (voidedPayment ? `Payment Voided for ${inv.invoiceNumber}` : `Payment Received on ${inv.invoiceNumber}`),
                        description: pendingCheque
                            ? `Cheque of ₹${parseFloat(pay.amount || 0).toLocaleString('en-IN')} via ${pay.method} is pending clearance and has not been applied to the invoice.`
                            : (voidedPayment
                                ? `Payment of ₹${parseFloat(pay.amount || 0).toLocaleString('en-IN')} via ${pay.method || 'BANK_TRANSFER'} was voided and is not included in the invoice balance.`
                                : `Collected: ₹${parseFloat(pay.amount || 0).toLocaleString('en-IN')} via ${pay.method || 'BANK_TRANSFER'}`),
                        date: pendingCheque
                            ? (pay.createdAt || pay.paymentDate)
                            : ((pay.clearedAt || voidedPayment) ? (pay.updatedAt || pay.clearedAt || pay.paymentDate) : (pay.createdAt || pay.paymentDate)),
                        actor: pay.createdBy ? pay.createdBy.name : 'Finance',
                        status: pay.status || 'COMPLETED',
                        link: `/documents/${inv.id}`
                    });
                }
            }
        }

        // 4. Credit and debit notes
        for (const note of creditNotes) {
            const isCredit = note.noteType === 'CREDIT';
            timelineEvents.push({
                type: 'CREDIT_DEBIT_NOTE',
                badge: isCredit ? 'Credit Note' : 'Debit Note',
                title: `${isCredit ? 'Credit' : 'Debit'} Note ${note.noteNumber}`,
                description: `Invoice: ${note.originalInvoiceNumber} | Amount: ₹${parseFloat(note.grandTotal || 0).toLocaleString('en-IN')} | ${note.reason}`,
                date: note.createdAt || note.noteDate,
                actor: note.createdBy ? note.createdBy.name : 'Accounts',
                status: note.status,
                link: `/credit-debit-notes/${note.id}`
            });
        }

        // 5. Purchase Orders
        for (const po of purchaseOrders) {
            const poTotal = po.items ? po.items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0) : 0;
            timelineEvents.push({
                type: 'PURCHASE_ORDER',
                badge: 'Purchase Order',
                title: `PO ${po.orderNumber}`,
                description: `Supplier: ${po.supplierName} | Commitment: ₹${poTotal.toLocaleString('en-IN')}`,
                date: po.createdAt || po.orderDate,
                actor: po.createdBy ? po.createdBy.name : 'Procurement',
                status: po.status,
                link: `/purchases/orders/${po.id}`
            });
        }

        // 6. Goods Receipts (GRN)
        for (const gr of goodsReceipts) {
            timelineEvents.push({
                type: 'GOODS_RECEIPT',
                badge: 'Goods Receipt (GRN)',
                title: `GRN ${gr.receiptNumber}`,
                description: `Supplier: ${gr.supplierName} | Items: ${(gr.items || []).length} | Store: ${gr.storeLocation}${gr.deliveryChallanNumber ? ` | Challan: ${gr.deliveryChallanNumber}` : ''}`,
                date: gr.createdAt || gr.receiptDate,
                actor: gr.receivedBy ? gr.receivedBy.name : 'Warehouse',
                status: gr.status,
                link: `/purchases/receipts/${gr.id}`
            });
        }

        // 7. Materials Issued & Returned
        for (const sm of stockMovements) {
            const isIssue = sm.movementType === 'ISSUE';
            timelineEvents.push({
                type: isIssue ? 'MATERIAL_ISSUE' : 'MATERIAL_RETURN',
                badge: isIssue ? 'Material Issued' : 'Material Returned',
                title: `${isIssue ? 'Issued' : 'Returned'} ${Math.abs(parseFloat(sm.quantity))} ${sm.item ? sm.item.unit : 'units'} of ${sm.item ? sm.item.name : 'Stock Item'}`,
                description: `Total Cost: ₹${parseFloat(sm.totalCost || 0).toLocaleString('en-IN')} | Ref: ${sm.movementNumber}${sm.storeLocation ? ` | Store: ${sm.storeLocation}` : ''}`,
                date: sm.createdAt || sm.movementDate,
                actor: 'Inventory',
                status: 'POSTED',
                link: `#project-movement-${sm.id}`
            });
        }

        // 8. Supplier Bills and payments
        for (const sb of supplierBills) {
            timelineEvents.push({
                type: 'SUPPLIER_BILL',
                badge: 'Supplier Bill',
                title: `Bill #${sb.billNumber}`,
                description: `Vendor: ${sb.supplierName} | Payable: ₹${parseFloat(sb.totalAmount || 0).toLocaleString('en-IN')}`,
                date: sb.createdAt || sb.billDate,
                actor: sb.createdBy ? sb.createdBy.name : 'Accounts Payable',
                status: sb.status,
                link: `#project-bill-${sb.id}`
            });
            for (const payment of sb.supplierPayments || []) {
                timelineEvents.push({
                    type: 'SUPPLIER_PAYMENT',
                    badge: 'Supplier Payment',
                    title: `Payment ${payment.paymentNumber} for Bill ${sb.billNumber}`,
                    description: `Paid: ₹${parseFloat(payment.amount || 0).toLocaleString('en-IN')} via ${payment.method || 'BANK_TRANSFER'}${payment.reference ? ` | Ref: ${payment.reference}` : ''}`,
                    date: payment.createdAt || payment.paymentDate,
                    actor: payment.createdBy ? payment.createdBy.name : 'Accounts Payable',
                    status: payment.status,
                    link: `#project-bill-${sb.id}`
                });
            }
        }

        // 9. Operating Expenses
        for (const exp of expenses) {
            timelineEvents.push({
                type: 'EXPENSE',
                badge: 'Project Expense',
                title: `Expense: ${exp.category || 'General'}`,
                description: `${exp.description || 'Operating Expense'} | Amount: ₹${parseFloat(exp.amount || 0).toLocaleString('en-IN')}`,
                date: exp.createdAt || exp.expenseDate,
                actor: exp.createdBy ? exp.createdBy.name : 'Operations',
                status: 'POSTED',
                link: `#project-expense-${exp.id}`
            });
        }

        // 10. Labour and work tracking
        for (const ts of timesheets) {
            timelineEvents.push({
                type: 'TIMESHEET',
                badge: 'Staff Timesheet',
                title: `${ts.user ? ts.user.name : 'Staff'} — ${ts.task ? ts.task.title : 'General work'}`,
                description: `${parseFloat(ts.hours || 0)} hours | Cost: ₹${parseFloat(ts.costAmount || 0).toLocaleString('en-IN')} | ${ts.isBillable ? 'Billable' : 'Non-billable'}`,
                date: ts.entryDate,
                actor: ts.user ? ts.user.name : 'Staff',
                status: ts.status,
                link: `#project-timesheet-${ts.id}`
            });
        }
        for (const labour of dailyLabour) {
            timelineEvents.push({
                type: 'DAILY_LABOUR',
                badge: 'Daily Labour',
                title: `${labour.worker ? labour.worker.name : 'Worker'} — ${labour.trade || 'General work'}`,
                description: `${parseFloat(labour.hours || 0)} hours | Net payable: ₹${parseFloat(labour.netPayable || 0).toLocaleString('en-IN')} | Payment: ${labour.paymentStatus}`,
                date: labour.workDate,
                actor: labour.supervisor ? labour.supervisor.name : 'Site Supervisor',
                status: labour.status,
                link: `#project-daily-labour-${labour.id}`
            });
        }
        for (const order of contractorOrders) {
            timelineEvents.push({
                type: 'CONTRACTOR_ORDER',
                badge: 'Contractor Work Order',
                title: `${order.orderNumber} — ${order.contractTitle}`,
                description: `Contractor: ${order.supplier ? order.supplier.name : 'Supplier'} | Contract value: ₹${parseFloat(order.contractValue || 0).toLocaleString('en-IN')}`,
                date: order.createdAt,
                actor: 'Procurement',
                status: order.status,
                link: `#project-contractor-order-${order.id}`
            });
        }

        // 11. Tasks and manual cost entries
        for (const task of tasks) {
            timelineEvents.push({
                type: 'TASK',
                badge: 'Task / Milestone',
                title: task.title,
                description: `Assigned to: ${task.assignedTo ? task.assignedTo.name : 'Unassigned'} | ${parseFloat(task.actualHours || 0)} of ${parseFloat(task.estimatedHours || 0)} hours logged`,
                date: task.updatedAt || task.createdAt,
                actor: task.assignedTo ? task.assignedTo.name : 'Project Team',
                status: task.status,
                link: `#project-task-${task.id}`
            });
        }
        for (const cost of manualCosts) {
            timelineEvents.push({
                type: 'PROJECT_COST',
                badge: 'Manual Project Cost',
                title: cost.sourceReference || `${cost.category} cost`,
                description: `${cost.description || cost.category} | Amount: ₹${parseFloat(cost.amount || 0).toLocaleString('en-IN')}`,
                date: cost.costDate,
                actor: 'Project Finance',
                status: cost.status,
                link: null
            });
        }
        for (const reimbursement of reimbursements) {
            const employeeName = [reimbursement.employee.firstName, reimbursement.employee.lastName].filter(Boolean).join(' ');
            timelineEvents.push({
                type: 'EMPLOYEE_REIMBURSEMENT',
                badge: 'Employee Reimbursement',
                title: `${reimbursement.claimNumber || reimbursement.category} — ${employeeName}`,
                description: `${reimbursement.description || reimbursement.category} | Amount: ₹${parseFloat(reimbursement.amount || 0).toLocaleString('en-IN')}`,
                date: reimbursement.updatedAt || reimbursement.expenseDate,
                actor: reimbursement.approvedBy ? reimbursement.approvedBy.name : employeeName,
                status: reimbursement.status,
                link: null
            });
        }

        // 12. Project audit activity
        for (const activity of activityLogs) {
            if (activity.action === 'CREATE') continue;
            const actionLabel = activity.action.charAt(0) + activity.action.slice(1).toLowerCase();
            timelineEvents.push({
                type: 'PROJECT_ACTIVITY',
                badge: `Project ${actionLabel}`,
                title: activity.metadata && activity.metadata.description
                    ? activity.metadata.description
                    : `${actionLabel} project ${project.code}`,
                description: activity.targetReference ? `Reference: ${activity.targetReference}` : `Project ${project.code} activity`,
                date: activity.createdAt,
                actor: activity.actorUser ? activity.actorUser.name : 'System',
                status: activity.action,
                link: null
            });
        }

        // 13. Documents & Certificates
        for (const att of attachments) {
            timelineEvents.push({
                type: 'ATTACHMENT',
                badge: `Document: ${att.category || 'OTHER'}`,
                title: att.title || att.originalFilename,
                description: `Category: ${att.category || 'OTHER'}${att.referenceNumber ? ` | Ref: ${att.referenceNumber}` : ''}`,
                date: att.createdAt,
                actor: att.uploadedBy ? att.uploadedBy.name : 'Uploader',
                status: 'ACTIVE',
                link: `/api/attachments/${att.id}/download`
            });
        }

        // Show the project lifecycle from earliest event to most recent.
        timelineEvents.sort((a, b) => {
            const aTime = new Date(a.date).getTime();
            const bTime = new Date(b.date).getTime();
            const safeATime = Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER;
            const safeBTime = Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER;
            return safeATime - safeBTime;
        });

        res.render('projects/details', {
            pageTitle: `${project.name} (${project.code})`,
            project,
            summary,
            supplierBills,
            stockMovements,
            timesheets,
            dailyLabour,
            contractorOrders,
            expenses,
            invoices,
            quotations,
            purchaseOrders,
            goodsReceipts,
            creditNotes,
            tasks,
            attachments,
            timelineEvents,
            subledgerCosts: subledgerCosts.records,
            reconciliation: {
                isReconciled,
                discrepancy: Math.round(glDiscrepancy * 100) / 100,
                subledgerTotal: Math.round(totalSubledgerAmount * 100) / 100,
                ledgerTotal: summary.financials.costs.actualTotal
            },
            helpers: {
                dailyWorkers,
                suppliers,
                inventoryItems
            }
        });
    } catch (err) {
        next(err);
    }
}

/**
 * -------------------------------------------------------------
 * JSON API CONTROLLERS (STRICT TENANT SCOPING)
 * -------------------------------------------------------------
 */

async function apiListProjects(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });

        const result = await projectService.listProjects({
            businessId,
            ...req.query
        });
        res.json({ success: true, ...result });
    } catch (err) {
        next(err);
    }
}

async function apiCreateProject(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });

        const userId = req.user?.id || req.session?.user?.id;
        const project = await projectService.createProject(req.body, userId, businessId);
        res.status(201).json({ success: true, project });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiCreateProjectFromQuotation(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const userId = req.user?.id || req.session?.user?.id;
        const project = await projectService.createProjectFromAcceptedQuotation(req.params.quotationId, req.body, userId, businessId);
        return res.status(201).json({ success: true, project });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        return next(err);
    }
}

async function apiGetProject(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });

        const project = await projectService.getProjectById(req.params.id, businessId);
        res.json({ success: true, project });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiUpdateProject(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });

        const userId = req.user?.id || req.session?.user?.id;
        const project = await projectService.updateProject(req.params.id, req.body, userId, businessId);
        res.json({ success: true, project });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiGetProjectFinancials(req, res, next) {
    try {
        const businessId = req.businessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });

        const summary = await projectService.getProjectFinancialSummary(req.params.id, businessId);
        res.json({ success: true, summary });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiGetProjectClosurePreview(req, res, next) {
    try {
        const preview = await projectService.getProjectClosurePreview(req.params.id, req.businessId || req.session?.activeBusinessId);
        return res.json({ success: true, preview });
    } catch (err) { return next(err); }
}

async function apiCloseProject(req, res, next) {
    try {
        if (req.body.overrideReason && !req.hasPermission?.('PROJECTS', 'MANAGE')) {
            return res.status(403).json({ success: false, error: 'Project management permission is required to override closure blockers.' });
        }
        const project = await projectService.closeProject(req.params.id, req.user?.id || req.session?.user?.id, req.businessId || req.session?.activeBusinessId, { overrideReason: req.body.overrideReason });
        return res.json({ success: true, project });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        return next(err);
    }
}

async function apiCreateTask(req, res, next) {
    try {
        const businessId = req.businessId;
        const task = await projectService.createProjectTask(req.params.id, req.body, req.user?.id, businessId);
        res.status(201).json({ success: true, task });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiLogTimesheet(req, res, next) {
    try {
        const businessId = req.businessId;
        const entry = await projectService.logTimesheet(req.body, req.user?.id, businessId);
        res.status(201).json({ success: true, entry });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiApproveTimesheet(req, res, next) {
    try {
        const businessId = req.businessId;
        const entry = await projectService.approveTimesheetEntry(req.params.id, req.user?.id, businessId);
        res.json({ success: true, entry });
    } catch (err) {
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        if (err.name === 'ConflictError') return res.status(409).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiCreateDailyWorker(req, res, next) {
    try {
        const businessId = req.businessId;
        const worker = await projectService.createDailyWorker(req.body, businessId);
        res.status(201).json({ success: true, worker });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiRecordDailyLabour(req, res, next) {
    try {
        const businessId = req.businessId;
        const labour = await projectService.recordDailyLabour(
            { ...req.body, projectId: req.params.id },
            req.user?.id,
            businessId
        );
        res.status(201).json({ success: true, labour });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

async function apiCreateContractorOrder(req, res, next) {
    try {
        const businessId = req.businessId;
        const order = await projectService.createContractorWorkOrder(
            { ...req.body, projectId: req.params.id },
            businessId
        );
        res.status(201).json({ success: true, order });
    } catch (err) {
        if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
        if (err.name === 'NotFoundError') return res.status(404).json({ success: false, error: err.message });
        next(err);
    }
}

/**
 * -------------------------------------------------------------
 * SECURE FILE ATTACHMENTS CONTROLLERS
 * -------------------------------------------------------------
 */

async function apiUploadAttachment(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.status(400).json({ success: false, error: 'Business context required' });
        if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

        const userId = req.user?.id || req.session?.user?.id || 1;

        const attachment = await attachmentService.saveAttachment({
            businessId,
            projectId: req.params.id ? parseInt(req.params.id, 10) : (req.body.projectId ? parseInt(req.body.projectId, 10) : null),
            entityType: req.body.entityType || 'PROJECT',
            entityId: req.body.entityId ? parseInt(req.body.entityId, 10) : null,
            title: req.body.title || null,
            category: req.body.category || 'OTHER',
            description: req.body.description || null,
            referenceNumber: req.body.referenceNumber || null,
            issueDate: req.body.issueDate || null,
            expiryDate: req.body.expiryDate || null,
            fileBuffer: req.file.buffer,
            originalFilename: req.file.originalname,
            uploadedById: userId
        });

        res.status(201).json({ success: true, attachment });
    } catch (err) {
        const status = err.status || err.statusCode || (err.code === 'INVALID_FILE_TYPE' ? 415 : 400);
        res.status(status).json({ success: false, error: err.message });
    }
}

async function apiDownloadAttachment(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.status(403).json({ success: false, error: 'Authorized business context required' });

        const fileData = await attachmentService.getAttachmentStream(req.params.id, businessId);
        if (!fileData) {
            return res.status(404).json({ success: false, error: 'Attachment not found or access denied across organizations' });
        }

        res.setHeader('Content-Type', fileData.attachment.mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${fileData.attachment.originalFilename}"`);
        fileData.stream.pipe(res);
    } catch (err) {
        next(err);
    }
}

async function apiDeleteAttachment(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        await attachmentService.deleteAttachment(req.params.id, businessId);
        res.json({ success: true, message: 'Attachment deleted successfully' });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
}

async function apiUpdateAttachment(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        if (!businessId) return res.status(403).json({ success: false, error: 'Authorized business context required' });

        const updated = await attachmentService.updateAttachmentMetadata({
            id: req.params.attachmentId || req.params.id,
            businessId,
            title: req.body.title,
            category: req.body.category,
            description: req.body.description,
            referenceNumber: req.body.referenceNumber,
            issueDate: req.body.issueDate,
            expiryDate: req.body.expiryDate
        });

        res.json({ success: true, attachment: updated });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
}

async function apiIssueMaterial(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const userId = req.user?.id || req.session?.user?.id;
        const projectId = parseInt(req.params.id, 10);

        const movement = await stockMovementService.issueMaterialToProject({
            businessId,
            projectId,
            itemId: parseInt(req.body.itemId, 10),
            quantity: parseFloat(req.body.quantity),
            storeLocation: req.body.storeLocation,
            unitCost: req.body.unitCost ? parseFloat(req.body.unitCost) : null,
            notes: req.body.notes,
            date: req.body.date ? new Date(req.body.date) : null,
            idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey
        }, userId);

        res.status(201).json({ success: true, stockMovement: movement });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
}

async function apiReturnMaterial(req, res, next) {
    try {
        const businessId = req.businessId || req.session?.activeBusinessId;
        const userId = req.user?.id || req.session?.user?.id;
        const projectId = parseInt(req.params.id, 10);

        const movement = await stockMovementService.returnMaterialFromProject({
            businessId,
            projectId,
            itemId: parseInt(req.body.itemId, 10),
            quantity: parseFloat(req.body.quantity),
            storeLocation: req.body.storeLocation,
            unitCost: req.body.unitCost ? parseFloat(req.body.unitCost) : null,
            notes: req.body.notes,
            date: req.body.date ? new Date(req.body.date) : null,
            idempotencyKey: req.get('Idempotency-Key') || req.body.idempotencyKey
        }, userId);

        res.status(201).json({ success: true, stockMovement: movement });
    } catch (err) {
        res.status(err.statusCode || 400).json({ success: false, error: err.message });
    }
}

module.exports = {
    renderProjectsList,
    renderNewProject,
    renderEditProject,
    renderProjectDetails,
    apiListProjects,
    apiCreateProject,
    apiCreateProjectFromQuotation,
    apiGetProject,
    apiUpdateProject,
    apiGetProjectFinancials,
    apiGetProjectClosurePreview,
    apiCloseProject,
    apiCreateTask,
    apiLogTimesheet,
    apiApproveTimesheet,
    apiCreateDailyWorker,
    apiRecordDailyLabour,
    apiCreateContractorOrder,
    apiIssueMaterial,
    apiReturnMaterial,
    apiUploadAttachment,
    apiUpdateAttachment,
    apiDownloadAttachment,
    apiDeleteAttachment
};
