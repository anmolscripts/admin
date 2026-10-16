'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../app/config/prisma');
const clientService = require('../app/services/client.service');
const projectService = require('../app/services/project.service');

test('Project Management, Timesheets & Labour Costing Test Suite', async (t) => {
    let testUser;
    let testClient;
    let project;

    await t.test('Setup test dependencies (Admin & Client)', async () => {
        testUser = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
        if (!testUser) {
            testUser = await prisma.user.create({
                data: {
                    email: `proj_admin_${Date.now()}@example.com`,
                    name: 'Project Test Admin',
                    passwordHash: 'dummyhash',
                    role: 'ADMIN'
                }
            });
        }

        testClient = await clientService.createClient({
            name: `Enterprise Client ${Date.now()}`,
            email: `client_${Date.now()}@example.com`
        }, testUser.id);
        assert.ok(testClient.id);
    });

    await t.test('Create project and validate configurations', async () => {
        const projCode = `PRJ-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        project = await projectService.createProject({
            code: projCode,
            name: 'Cloud Migration & Modernization',
            description: 'Core ERP cloud deployment',
            clientId: testClient.id,
            startDate: '2026-01-01',
            budgetAmount: 50000.0,
            hourlyRate: 150.0,
            billingType: 'TIME_AND_MATERIALS',
            status: 'ACTIVE'
        }, testUser.id);

        assert.ok(project.id);
        assert.equal(project.code, projCode);
        assert.equal(Number(project.budgetAmount), 50000.0);
        assert.equal(Number(project.hourlyRate), 150.0);

        // Reject duplicate project code
        await assert.rejects(
            projectService.createProject({
                code: projCode,
                name: 'Duplicate Code Test',
                startDate: '2026-01-01'
            }, testUser.id),
            /already exists/
        );
    });

    let task1;
    let task2;

    await t.test('Create and assign project tasks', async () => {
        task1 = await projectService.createProjectTask(project.id, {
            title: 'Architecture & Security Setup',
            estimatedHours: 20,
            assignedToUserId: testUser.id,
            status: 'IN_PROGRESS'
        }, testUser.id);
        assert.ok(task1.id);
        assert.equal(Number(task1.estimatedHours), 20);
        assert.equal(Number(task1.actualHours), 0);

        task2 = await projectService.createProjectTask(project.id, {
            title: 'Database Migration Scripts',
            estimatedHours: 15,
            assignedToUserId: testUser.id,
            status: 'TODO'
        }, testUser.id);
        assert.ok(task2.id);

        const tasks = await projectService.listProjectTasks(project.id);
        assert.equal(tasks.length, 2);
    });

    let timesheet1;
    let timesheet2;

    await t.test('Log timesheets with rate validation and cost calculation', async () => {
        // Timesheet 1: 8 hours on Task 1 using default project rate ($150) -> Cost = $1200
        timesheet1 = await projectService.logTimesheetEntry({
            projectId: project.id,
            taskId: task1.id,
            entryDate: '2026-02-10',
            hours: 8,
            notes: 'Completed initial VPC and IAM configuration'
        }, testUser.id);

        assert.ok(timesheet1.id);
        assert.equal(timesheet1.status, 'DRAFT');
        assert.equal(Number(timesheet1.hours), 8);
        assert.equal(Number(timesheet1.hourlyRate), 150);
        assert.equal(Number(timesheet1.costAmount), 1200);

        // Timesheet 2: 4 hours with custom rate ($200) -> Cost = $800
        timesheet2 = await projectService.logTimesheetEntry({
            projectId: project.id,
            taskId: task2.id,
            entryDate: '2026-02-11',
            hours: 4,
            hourlyRate: 200,
            notes: 'Data dump and validation'
        }, testUser.id);

        assert.equal(Number(timesheet2.costAmount), 800);

        // Disallow hours > 24
        await assert.rejects(
            projectService.logTimesheetEntry({
                projectId: project.id,
                entryDate: '2026-02-12',
                hours: 25
            }, testUser.id),
            /not exceed 24 hours/
        );
    });

    await t.test('Approve timesheet and verify automatic labour cost attribution', async () => {
        const approved1 = await projectService.approveTimesheetEntry(timesheet1.id, testUser.id);
        assert.equal(approved1.status, 'APPROVED');

        // Verify task actualHours was incremented by 8
        const updatedTask1 = await prisma.projectTask.findUnique({ where: { id: task1.id } });
        assert.equal(Number(updatedTask1.actualHours), 8);

        // Verify labour cost was created in project_costs
        const labourCost = await prisma.projectCost.findFirst({
            where: {
                projectId: project.id,
                sourceReference: `TIMESHEET:${timesheet1.id}`
            }
        });
        assert.ok(labourCost, 'Labour cost must be automatically attributed to project_costs');
        assert.equal(labourCost.costType, 'LABOUR');
        assert.equal(Number(labourCost.amount), 1200);

        // Approve timesheet 2 as well
        await projectService.approveTimesheetEntry(timesheet2.id, testUser.id);
    });

    await t.test('Record other direct project costs (Material, Expense)', async () => {
        // Material cost (e.g. server hardware or SSL certs)
        const matCost = await projectService.recordProjectCost({
            projectId: project.id,
            costType: 'MATERIAL',
            amount: 500,
            costDate: '2026-02-12',
            description: 'SSL Certificates and domain licenses'
        }, testUser.id);
        assert.ok(matCost.id);

        // Travel expense
        const expCost = await projectService.recordProjectCost({
            projectId: project.id,
            costType: 'EXPENSE',
            amount: 300,
            costDate: '2026-02-13',
            description: 'Onsite deployment travel expenses'
        }, testUser.id);
        assert.ok(expCost.id);
    });

    await t.test('Calculate project financial summary and profitability', async () => {
        const summary = await projectService.getProjectFinancialSummary(project.id);

        // Total hours worked: 8 + 4 = 12 hours
        assert.equal(summary.totalHoursWorked, 12);
        assert.equal(summary.billableHours, 12);

        // Labour cost = 1200 + 800 = 2000
        assert.equal(summary.breakdown.labourCost, 2000);
        // Material = 500
        assert.equal(summary.breakdown.materialCost, 500);
        // Expense = 300
        assert.equal(summary.breakdown.expenseCost, 300);

        // Total Cost = 2000 + 500 + 300 = 2800
        assert.equal(summary.totalCost, 2800);

        // Effective revenue = 12 billable hours * $150 project rate = 1800
        assert.equal(summary.effectiveRevenue, 1800);

        // Gross margin = 1800 - 2800 = -1000
        assert.equal(summary.grossMargin, -1000);

        // Budget burn = 2800 / 50000 = 5.6%
        assert.equal(summary.budgetBurnPercentage, 5.6);
    });

    await prisma.$disconnect();
});
