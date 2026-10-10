-- CreateTable
CREATE TABLE `supplier_payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `paymentNumber` VARCHAR(50) NOT NULL,
    `supplierId` INTEGER NOT NULL,
    `supplierBillId` INTEGER NULL,
    `paymentDate` DATE NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `method` VARCHAR(50) NOT NULL DEFAULT 'BANK_TRANSFER',
    `reference` VARCHAR(255) NULL,
    `notes` TEXT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'POSTED',
    `financialYearId` INTEGER NULL,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `supplier_payments_paymentNumber_key`(`paymentNumber`),
    INDEX `supplier_payments_supplierId_idx`(`supplierId`),
    INDEX `supplier_payments_supplierBillId_idx`(`supplierBillId`),
    INDEX `supplier_payments_paymentDate_idx`(`paymentDate`),
    INDEX `supplier_payments_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_movements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `movementNumber` VARCHAR(50) NOT NULL,
    `itemId` INTEGER NOT NULL,
    `movementType` VARCHAR(30) NOT NULL,
    `quantity` DECIMAL(10, 2) NOT NULL,
    `unitCost` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `totalCost` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `referenceType` VARCHAR(50) NULL,
    `referenceId` INTEGER NULL,
    `movementDate` DATE NOT NULL,
    `notes` TEXT NULL,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_movements_movementNumber_key`(`movementNumber`),
    INDEX `stock_movements_itemId_idx`(`itemId`),
    INDEX `stock_movements_movementDate_idx`(`movementDate`),
    INDEX `stock_movements_movementType_idx`(`movementType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employees` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employeeCode` VARCHAR(50) NOT NULL,
    `firstName` VARCHAR(100) NOT NULL,
    `lastName` VARCHAR(100) NOT NULL,
    `email` VARCHAR(150) NOT NULL,
    `phone` VARCHAR(50) NULL,
    `department` VARCHAR(100) NULL,
    `designation` VARCHAR(100) NULL,
    `dateOfJoining` DATE NOT NULL,
    `dateOfLeaving` DATE NULL,
    `panNumber` VARCHAR(20) NULL,
    `uanNumber` VARCHAR(30) NULL,
    `bankAccountNumber` VARCHAR(50) NULL,
    `bankIfsc` VARCHAR(20) NULL,
    `bankName` VARCHAR(100) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `employees_employeeCode_key`(`employeeCode`),
    UNIQUE INDEX `employees_email_key`(`email`),
    INDEX `employees_status_idx`(`status`),
    INDEX `employees_department_idx`(`department`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `salary_structures` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employeeId` INTEGER NOT NULL,
    `effectiveFrom` DATE NOT NULL,
    `basicSalary` DECIMAL(12, 2) NOT NULL,
    `hra` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `conveyance` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `specialAllowance` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `epfApplicable` BOOLEAN NOT NULL DEFAULT true,
    `esiApplicable` BOOLEAN NOT NULL DEFAULT false,
    `ptApplicable` BOOLEAN NOT NULL DEFAULT true,
    `tdsMonthly` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `salary_structures_employeeId_idx`(`employeeId`),
    INDEX `salary_structures_effectiveFrom_idx`(`effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_periods` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `financialYearId` INTEGER NOT NULL,
    `periodCode` VARCHAR(20) NOT NULL,
    `month` INTEGER NOT NULL,
    `year` INTEGER NOT NULL,
    `startDate` DATE NOT NULL,
    `endDate` DATE NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `approvedById` INTEGER NULL,
    `approvedAt` DATETIME(3) NULL,
    `journalEntryId` INTEGER NULL,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payroll_periods_periodCode_key`(`periodCode`),
    INDEX `payroll_periods_financialYearId_idx`(`financialYearId`),
    INDEX `payroll_periods_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_entries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `payrollPeriodId` INTEGER NOT NULL,
    `employeeId` INTEGER NOT NULL,
    `basicSalary` DECIMAL(12, 2) NOT NULL,
    `hra` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `allowances` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `grossEarnings` DECIMAL(12, 2) NOT NULL,
    `employeeEpf` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `employerEpf` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `employeeEsi` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `employerEsi` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `professionalTax` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `tds` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `totalDeductions` DECIMAL(12, 2) NOT NULL,
    `netPay` DECIMAL(12, 2) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `paymentMethod` VARCHAR(50) NULL DEFAULT 'BANK_TRANSFER',
    `paymentDate` DATE NULL,
    `paymentReference` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payroll_entries_payrollPeriodId_idx`(`payrollPeriodId`),
    INDEX `payroll_entries_employeeId_idx`(`employeeId`),
    UNIQUE INDEX `payroll_entries_payrollPeriodId_employeeId_key`(`payrollPeriodId`, `employeeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_reimbursements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employeeId` INTEGER NOT NULL,
    `expenseDate` DATE NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `category` VARCHAR(100) NOT NULL,
    `description` TEXT NULL,
    `receiptUrl` VARCHAR(255) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `approvedById` INTEGER NULL,
    `financialYearId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `employee_reimbursements_employeeId_idx`(`employeeId`),
    INDEX `employee_reimbursements_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `projects` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `clientId` INTEGER NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `startDate` DATE NOT NULL,
    `endDate` DATE NULL,
    `budgetAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    `hourlyRate` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `billingType` VARCHAR(30) NOT NULL DEFAULT 'TIME_AND_MATERIALS',
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `projects_code_key`(`code`),
    INDEX `projects_clientId_idx`(`clientId`),
    INDEX `projects_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_tasks` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'TODO',
    `estimatedHours` DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
    `actualHours` DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
    `assignedToUserId` INTEGER NULL,
    `dueDate` DATE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `project_tasks_projectId_idx`(`projectId`),
    INDEX `project_tasks_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `timesheet_entries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `taskId` INTEGER NULL,
    `userId` INTEGER NOT NULL,
    `entryDate` DATE NOT NULL,
    `hours` DECIMAL(6, 2) NOT NULL,
    `hourlyRate` DECIMAL(10, 2) NOT NULL,
    `costAmount` DECIMAL(12, 2) NOT NULL,
    `isBillable` BOOLEAN NOT NULL DEFAULT true,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `approvedById` INTEGER NULL,
    `approvedAt` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `timesheet_entries_projectId_idx`(`projectId`),
    INDEX `timesheet_entries_userId_idx`(`userId`),
    INDEX `timesheet_entries_entryDate_idx`(`entryDate`),
    INDEX `timesheet_entries_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_costs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `projectId` INTEGER NOT NULL,
    `costType` VARCHAR(30) NOT NULL,
    `sourceReference` VARCHAR(100) NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `costDate` DATE NOT NULL,
    `description` TEXT NULL,
    `journalEntryId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `project_costs_projectId_idx`(`projectId`),
    INDEX `project_costs_costDate_idx`(`costDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_supplierBillId_fkey` FOREIGN KEY (`supplierBillId`) REFERENCES `supplier_bills`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `salary_structures` ADD CONSTRAINT `salary_structures_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `salary_structures` ADD CONSTRAINT `salary_structures_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `journal_entries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_entries` ADD CONSTRAINT `payroll_entries_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payroll_entries` ADD CONSTRAINT `payroll_entries_payrollPeriodId_fkey` FOREIGN KEY (`payrollPeriodId`) REFERENCES `payroll_periods`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_reimbursements` ADD CONSTRAINT `employee_reimbursements_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `employee_reimbursements` ADD CONSTRAINT `employee_reimbursements_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `employee_reimbursements` ADD CONSTRAINT `employee_reimbursements_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `projects` ADD CONSTRAINT `projects_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_tasks` ADD CONSTRAINT `project_tasks_assignedToUserId_fkey` FOREIGN KEY (`assignedToUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `project_tasks` ADD CONSTRAINT `project_tasks_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `timesheet_entries` ADD CONSTRAINT `timesheet_entries_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `timesheet_entries` ADD CONSTRAINT `timesheet_entries_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `timesheet_entries` ADD CONSTRAINT `timesheet_entries_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `project_tasks`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `timesheet_entries` ADD CONSTRAINT `timesheet_entries_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_costs` ADD CONSTRAINT `project_costs_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `journal_entries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `project_costs` ADD CONSTRAINT `project_costs_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
