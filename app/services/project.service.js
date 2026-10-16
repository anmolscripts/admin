'use strict';

const prisma = require('../config/prisma');
const activityService = require('./activity.service');
const { ValidationError, NotFoundError, ConflictError } = require('./errorTypes');

const numberingService = require('./numbering.service');

const VALID_PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'];
const VALID_BILLING_TYPES = ['TIME_AND_MATERIALS', 'FIXED_PRICE', 'NON_BILLABLE'];
const VALID_TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE', 'CANCELLED'];

/**
 * -------------------------------------------------------------
 * 1. PROJECT MANAGEMENT
 * -------------------------------------------------------------
 */
async function createProject(data = {}, userId) {
    const name = (data.name || '').trim();
    if (!name) throw new ValidationError('Project name is required.');

    if (!data.startDate) throw new ValidationError('Project start date is required.');
    const startDate = new Date(data.startDate);
    if (isNaN(startDate.getTime())) throw new ValidationError('Invalid start date.');

    const endDate = data.endDate ? new Date(data.endDate) : null;
    if (endDate && isNaN(endDate.getTime())) throw new ValidationError('Invalid end date.');

    const businessId = data.businessId ? parseInt(data.businessId, 10) : 1;
    let code = (data.code || '').trim().toUpperCase();
    if (!code) {
        code = await numberingService.allocateNumber({
            businessId,
            entityType: 'PROJECT',
            date: startDate
        });
    }

    const existing = await prisma.project.findFirst({ where: { businessId, code } });
    if (existing) throw new ConflictError(`Project with code "${code}" already exists.`);

    let clientId = null;
    if (data.clientId) {
        clientId = parseInt(data.clientId, 10);
        if (isNaN(clientId) || clientId <= 0) throw new ValidationError('Invalid client ID.');
        const client = await prisma.client.findUnique({ where: { id: clientId } });
        if (!client) throw new NotFoundError(`Client with ID ${clientId} not found.`);
    }

    const budgetAmount = Math.max(0, parseFloat(data.budgetAmount) || 0);
    const hourlyRate = Math.max(0, parseFloat(data.hourlyRate) || 0);
    const billingType = VALID_BILLING_TYPES.includes(data.billingType) ? data.billingType : 'TIME_AND_MATERIALS';
    const status = VALID_PROJECT_STATUSES.includes(data.status) ? data.status : 'ACTIVE';

    const project = await prisma.project.create({
        data: {
            businessId,
            code,
            name,
            description: data.description ? String(data.description).trim() : null,
            clientId,
            startDate,
            endDate,
            budgetAmount,
            hourlyRate,
            billingType,
            status,
            createdById: userId
        },
        include: { client: true }
    });

    if (userId) {
        await activityService.log({
            actorUserId: userId,
            action: 'CREATE',
            module: 'PROJECTS',
            targetType: 'PROJECT',
            targetId: project.id,
            description: `Created project ${project.code} (${project.name})`
        });
    }

    return project;
}

async function getProjectById(id) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid project ID.');

    const project = await prisma.project.findUnique({
        where: { id: numId },
        include: {
            client: true,
            tasks: { orderBy: { createdAt: 'desc' } },
            costs: { orderBy: { costDate: 'desc' } },
            createdBy: { select: { id: true, name: true, email: true } }
        }
    });

    if (!project) throw new NotFoundError(`Project with ID ${numId} not found.`);
    return project;
}

async function listProjects({ businessId, clientId, status, search, page = 1, limit = 20 } = {}) {
    const where = {};
    if (businessId) where.businessId = parseInt(businessId, 10);
    if (clientId) where.clientId = parseInt(clientId, 10);
    if (status) where.status = status;
    if (search) {
        where.OR = [
            { code: { contains: search } },
            { name: { contains: search } },
            { description: { contains: search } }
        ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.project.count({ where }),
        prisma.project.findMany({
            where,
            include: { client: true, _count: { select: { tasks: true, timesheetEntries: true } } },
            orderBy: { createdAt: 'desc' },
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

/**
 * -------------------------------------------------------------
 * 2. PROJECT TASKS
 * -------------------------------------------------------------
 */
async function createProjectTask(projectIdInput, data = {}, userId) {
    const projectId = parseInt(projectIdInput, 10);
    if (isNaN(projectId) || projectId <= 0) throw new ValidationError('Invalid project ID.');

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundError(`Project with ID ${projectId} not found.`);

    const title = (data.title || '').trim();
    if (!title) throw new ValidationError('Task title is required.');

    const estimatedHours = Math.max(0, parseFloat(data.estimatedHours) || 0);
    let assignedToUserId = null;
    if (data.assignedToUserId) {
        assignedToUserId = parseInt(data.assignedToUserId, 10);
        if (isNaN(assignedToUserId) || assignedToUserId <= 0) throw new ValidationError('Invalid assigned user ID.');
    }

    const dueDate = data.dueDate ? new Date(data.dueDate) : null;
    const status = VALID_TASK_STATUSES.includes(data.status) ? data.status : 'TODO';

    const task = await prisma.projectTask.create({
        data: {
            projectId,
            title,
            description: data.description ? String(data.description).trim() : null,
            estimatedHours,
            actualHours: 0,
            assignedToUserId,
            dueDate,
            status
        },
        include: { assignedTo: { select: { id: true, name: true, email: true } } }
    });

    return task;
}

async function listProjectTasks(projectIdInput, { status, assignedToUserId } = {}) {
    const projectId = parseInt(projectIdInput, 10);
    if (isNaN(projectId) || projectId <= 0) throw new ValidationError('Invalid project ID.');

    const where = { projectId };
    if (status) where.status = status;
    if (assignedToUserId) where.assignedToUserId = parseInt(assignedToUserId, 10);

    return prisma.projectTask.findMany({
        where,
        include: { assignedTo: { select: { id: true, name: true, email: true } } },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }]
    });
}

/**
 * -------------------------------------------------------------
 * 3. TIMESHEETS & LABOUR COSTING
 * -------------------------------------------------------------
 */
async function logTimesheetEntry(data = {}, userId) {
    const projectId = parseInt(data.projectId, 10);
    if (isNaN(projectId) || projectId <= 0) throw new ValidationError('Invalid project ID.');

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundError(`Project with ID ${projectId} not found.`);

    let taskId = null;
    if (data.taskId) {
        taskId = parseInt(data.taskId, 10);
        if (isNaN(taskId) || taskId <= 0) throw new ValidationError('Invalid task ID.');
        const task = await prisma.projectTask.findUnique({ where: { id: taskId } });
        if (!task || task.projectId !== projectId) {
            throw new ValidationError(`Task ID ${taskId} does not belong to project ${project.code}.`);
        }
    }

    if (!data.entryDate) throw new ValidationError('Timesheet entry date is required.');
    const entryDate = new Date(data.entryDate);
    if (isNaN(entryDate.getTime())) throw new ValidationError('Invalid entry date.');

    const hours = parseFloat(data.hours);
    if (isNaN(hours) || hours <= 0 || hours > 24) {
        throw new ValidationError('Hours logged must be greater than 0 and not exceed 24 hours per entry.');
    }

    // Determine hourly rate
    let hourlyRate = parseFloat(data.hourlyRate);
    if (isNaN(hourlyRate) || hourlyRate < 0) {
        hourlyRate = parseFloat(project.hourlyRate) || 0;
    }

    const costAmount = Math.round(hours * hourlyRate * 100) / 100;
    const isBillable = data.isBillable !== undefined ? Boolean(data.isBillable) : true;

    const entry = await prisma.timesheetEntry.create({
        data: {
            projectId,
            taskId,
            userId,
            entryDate,
            hours,
            hourlyRate,
            costAmount,
            isBillable,
            status: 'DRAFT',
            notes: data.notes ? String(data.notes).trim() : null
        },
        include: {
            project: true,
            task: true,
            user: { select: { id: true, name: true, email: true } }
        }
    });

    return entry;
}

async function approveTimesheetEntry(id, userId) {
    const numId = parseInt(id, 10);
    if (isNaN(numId) || numId <= 0) throw new ValidationError('Invalid timesheet entry ID.');

    const entry = await prisma.timesheetEntry.findUnique({
        where: { id: numId },
        include: { project: true, task: true }
    });
    if (!entry) throw new NotFoundError(`Timesheet entry ${numId} not found.`);
    if (entry.status !== 'DRAFT') {
        throw new ConflictError(`Timesheet entry is already ${entry.status}.`);
    }

    return prisma.$transaction(async (tx) => {
        // 1. Mark timesheet approved
        const approved = await tx.timesheetEntry.update({
            where: { id: numId },
            data: {
                status: 'APPROVED',
                approvedById: userId,
                approvedAt: new Date()
            },
            include: {
                project: true,
                task: true,
                user: { select: { id: true, name: true, email: true } },
                approvedBy: { select: { id: true, name: true } }
            }
        });

        // 2. Increment task actual hours if associated
        if (entry.taskId) {
            await tx.projectTask.update({
                where: { id: entry.taskId },
                data: {
                    actualHours: { increment: parseFloat(entry.hours) }
                }
            });
        }

        // 3. Attribute Labour Cost in project_costs
        const costAmount = parseFloat(entry.costAmount);
        if (costAmount > 0) {
            await tx.projectCost.create({
                data: {
                    projectId: entry.projectId,
                    costType: 'LABOUR',
                    sourceReference: `TIMESHEET:${entry.id}`,
                    amount: costAmount,
                    costDate: entry.entryDate,
                    description: `Labour Cost: ${entry.hours}h @ $${entry.hourlyRate}/h (${entry.task ? entry.task.title : 'General'})`
                }
            });
        }

        if (userId) {
            await activityService.log({
                actorUserId: userId,
                action: 'APPROVE',
                module: 'PROJECTS',
                targetType: 'TIMESHEET',
                targetId: entry.id,
                description: `Approved ${entry.hours}h timesheet entry for project ${entry.project.code} ($${costAmount})`
            });
        }

        return approved;
    });
}

async function listTimesheets({ projectId, userId, status, dateFrom, dateTo, page = 1, limit = 20 } = {}) {
    const where = {};
    if (projectId) where.projectId = parseInt(projectId, 10);
    if (userId) where.userId = parseInt(userId, 10);
    if (status) where.status = status;
    if (dateFrom || dateTo) {
        where.entryDate = {};
        if (dateFrom) where.entryDate.gte = new Date(dateFrom);
        if (dateTo) where.entryDate.lte = new Date(dateTo);
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * pageSize;

    const [total, records] = await Promise.all([
        prisma.timesheetEntry.count({ where }),
        prisma.timesheetEntry.findMany({
            where,
            include: {
                project: true,
                task: true,
                user: { select: { id: true, name: true, email: true } },
                approvedBy: { select: { id: true, name: true } }
            },
            orderBy: [{ entryDate: 'desc' }, { id: 'desc' }],
            skip,
            take: pageSize
        })
    ]);

    return { total, page: pageNum, limit: pageSize, records };
}

/**
 * -------------------------------------------------------------
 * 4. PROJECT COSTING & PROFITABILITY SUMMARY
 * -------------------------------------------------------------
 */
async function recordProjectCost(data = {}, userId) {
    const projectId = parseInt(data.projectId, 10);
    if (isNaN(projectId) || projectId <= 0) throw new ValidationError('Invalid project ID.');

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundError(`Project with ID ${projectId} not found.`);

    const rawAmount = parseFloat(data.amount);
    if (isNaN(rawAmount) || rawAmount <= 0) throw new ValidationError('Amount must be greater than 0.');
    const amount = Math.round(rawAmount * 100) / 100;

    const costDate = data.costDate ? new Date(data.costDate) : new Date();
    if (isNaN(costDate.getTime())) throw new ValidationError('Invalid cost date.');

    const costType = (data.costType || 'EXPENSE').toString().trim().toUpperCase();

    const cost = await prisma.projectCost.create({
        data: {
            projectId,
            costType,
            sourceReference: data.sourceReference ? String(data.sourceReference).trim() : null,
            amount,
            costDate,
            description: data.description ? String(data.description).trim() : null
        },
        include: { project: true }
    });

    return cost;
}

async function getProjectFinancialSummary(projectIdInput) {
    const projectId = parseInt(projectIdInput, 10);
    if (isNaN(projectId) || projectId <= 0) throw new ValidationError('Invalid project ID.');

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: {
            client: true,
            costs: true,
            timesheetEntries: { where: { status: 'APPROVED' } }
        }
    });

    if (!project) throw new NotFoundError(`Project with ID ${projectId} not found.`);

    let totalHoursWorked = 0;
    let billableHours = 0;

    for (const t of project.timesheetEntries) {
        const h = parseFloat(t.hours);
        totalHoursWorked += h;
        if (t.isBillable) billableHours += h;
    }

    let labourCost = 0;
    let materialCost = 0;
    let expenseCost = 0;
    let otherCost = 0;

    for (const c of project.costs) {
        const amt = parseFloat(c.amount);
        switch (c.costType) {
            case 'LABOUR':
                labourCost += amt;
                break;
            case 'MATERIAL':
                materialCost += amt;
                break;
            case 'EXPENSE':
                expenseCost += amt;
                break;
            default:
                otherCost += amt;
                break;
        }
    }

    const totalCost = Math.round((labourCost + materialCost + expenseCost + otherCost) * 100) / 100;
    const budgetAmount = parseFloat(project.budgetAmount) || 0;
    const hourlyRate = parseFloat(project.hourlyRate) || 0;

    // Projected/Billable Revenue for Time & Materials
    const billableRevenue = Math.round(billableHours * hourlyRate * 100) / 100;
    const effectiveRevenue = project.billingType === 'FIXED_PRICE' ? budgetAmount : billableRevenue;
    const grossMargin = Math.round((effectiveRevenue - totalCost) * 100) / 100;
    const marginPercentage = effectiveRevenue > 0
        ? Math.round((grossMargin / effectiveRevenue) * 10000) / 100
        : 0;

    const budgetBurnPercentage = budgetAmount > 0
        ? Math.round((totalCost / budgetAmount) * 10000) / 100
        : 0;

    return {
        projectId: project.id,
        projectCode: project.code,
        projectName: project.name,
        clientName: project.client ? project.client.name : null,
        billingType: project.billingType,
        budgetAmount,
        hourlyRate,
        totalHoursWorked: Math.round(totalHoursWorked * 100) / 100,
        billableHours: Math.round(billableHours * 100) / 100,
        breakdown: {
            labourCost: Math.round(labourCost * 100) / 100,
            materialCost: Math.round(materialCost * 100) / 100,
            expenseCost: Math.round(expenseCost * 100) / 100,
            otherCost: Math.round(otherCost * 100) / 100
        },
        totalCost,
        effectiveRevenue,
        grossMargin,
        marginPercentage,
        budgetBurnPercentage
    };
}

module.exports = {
    createProject,
    getProjectById,
    listProjects,
    createProjectTask,
    listProjectTasks,
    logTimesheetEntry,
    approveTimesheetEntry,
    listTimesheets,
    recordProjectCost,
    getProjectFinancialSummary,
    VALID_PROJECT_STATUSES,
    VALID_BILLING_TYPES,
    VALID_TASK_STATUSES,
    ValidationError,
    NotFoundError,
    ConflictError
};
