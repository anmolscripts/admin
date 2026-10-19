-- AlterTable
ALTER TABLE `business_memberships` ALTER COLUMN `updatedAt` DROP DEFAULT;

-- AlterTable
ALTER TABLE `business_prefix_configs` ALTER COLUMN `updatedAt` DROP DEFAULT;

-- AlterTable
ALTER TABLE `businesses` ALTER COLUMN `updatedAt` DROP DEFAULT;

-- AlterTable
ALTER TABLE `credit_debit_notes` ADD COLUMN `projectId` INTEGER NULL;

-- AlterTable
ALTER TABLE `employee_reimbursements` ADD COLUMN `projectId` INTEGER NULL;

-- AlterTable
ALTER TABLE `expenses` ADD COLUMN `projectId` INTEGER NULL;

-- AlterTable
ALTER TABLE `invoice_items` ADD COLUMN `projectId` INTEGER NULL;

-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `projectId` INTEGER NULL;

-- AlterTable
ALTER TABLE `numbering_sequences` ALTER COLUMN `updatedAt` DROP DEFAULT;

-- AlterTable
ALTER TABLE `project_costs` ADD COLUMN `businessId` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `category` VARCHAR(50) NOT NULL DEFAULT 'OTHER',
    ADD COLUMN `createdById` INTEGER NULL,
    ADD COLUMN `isTaxRecoverable` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `quantity` DECIMAL(12, 4) NULL,
    ADD COLUMN `sourceId` INTEGER NULL,
    ADD COLUMN `sourceLineId` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `sourceType` VARCHAR(50) NULL,
    ADD COLUMN `status` VARCHAR(30) NOT NULL DEFAULT 'POSTED',
    ADD COLUMN `taxAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `unit` VARCHAR(20) NULL,
    ADD COLUMN `unitCost` DECIMAL(12, 2) NULL;

-- Backfill project_costs.businessId from parent project where available
UPDATE `project_costs` pc
INNER JOIN `projects` p ON pc.projectId = p.id
SET pc.businessId = p.businessId
WHERE p.businessId IS NOT NULL AND p.businessId > 0;

-- Ensure all project_costs reference an existing business
UPDATE `project_costs` SET `businessId` = 1 WHERE `businessId` = 0 OR `businessId` IS NULL;

-- Drop default on businessId
ALTER TABLE `project_costs` ALTER COLUMN `businessId` DROP DEFAULT;

-- Ensure all projects have businessId
UPDATE `projects` SET `businessId` = 1 WHERE `businessId` IS NULL OR `businessId` = 0;

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `budgetExpenses` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `budgetLabour` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `budgetMaterials` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `budgetSubcontractor` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `contractValue` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `costRate` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `managerId` INTEGER NULL,
    ADD COLUMN `revenueRecognitionMethod` VARCHAR(50) NOT NULL DEFAULT 'COMPLETED_CONTRACT',
    ADD COLUMN `siteLocation` VARCHAR(255) NULL,
    MODIFY `businessId` INTEGER NOT NULL;

-- AlterTable
ALTER TABLE `purchase_orders` ADD COLUMN `projectId` INTEGER NULL;

-- AlterTable
ALTER TABLE `stock_movements` ADD COLUMN `projectId` INTEGER NULL;

-- AlterTable
ALTER TABLE `supplier_bill_items` ADD COLUMN `cessAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `cessRate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `cgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `costCode` VARCHAR(50) NULL,
    ADD COLUMN `discountAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `gstRate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `igstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `projectId` INTEGER NULL,
    ADD COLUMN `sgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `taxableAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `totalAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00;

-- AlterTable
ALTER TABLE `supplier_bills` ADD COLUMN `ackDate` DATETIME(3) NULL,
    ADD COLUMN `ackNumber` VARCHAR(100) NULL,
    ADD COLUMN `billToAddress` TEXT NULL,
    ADD COLUMN `billToName` VARCHAR(255) NULL,
    ADD COLUMN `cessAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `cgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `chargesAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `deliveryReference` VARCHAR(100) NULL,
    ADD COLUMN `externalInvoiceNumber` VARCHAR(100) NULL,
    ADD COLUMN `igstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `irn` VARCHAR(100) NULL,
    ADD COLUMN `itcEligibility` VARCHAR(50) NOT NULL DEFAULT 'INPUT_GOODS_SERVICES',
    ADD COLUMN `orderReference` VARCHAR(100) NULL,
    ADD COLUMN `placeOfSupply` VARCHAR(10) NULL,
    ADD COLUMN `projectId` INTEGER NULL,
    ADD COLUMN `roundOff` DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `sgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `shipToAddress` TEXT NULL,
    ADD COLUMN `shipToName` VARCHAR(255) NULL,
    ADD COLUMN `stateCode` VARCHAR(5) NULL,
    ADD COLUMN `taxableAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `verificationStatus` VARCHAR(30) NOT NULL DEFAULT 'VERIFIED';

-- CreateTable
CREATE TABLE `project_attachments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `businessId` INTEGER NOT NULL,
    `projectId` INTEGER NULL,
    `entityType` VARCHAR(50) NOT NULL,
    `entityId` INTEGER NULL,
    `originalFilename` VARCHAR(255) NOT NULL,
    `storedFilename` VARCHAR(255) NOT NULL,
    `filePath` VARCHAR(500) NOT NULL,
    `fileSize` INTEGER NOT NULL,
    `mimeType` VARCHAR(100) NOT NULL,
    `sha256Hash` VARCHAR(64) NULL,
    `uploadedById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `project_attachments_storedFilename_key`(`storedFilename`),
    INDEX `project_attachments_businessId_projectId_idx`(`businessId`, `projectId`),
    INDEX `project_attachments_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `daily_workers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `businessId` INTEGER NOT NULL,
    `workerCode` VARCHAR(50) NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `trade` VARCHAR(100) NULL,
    `phone` VARCHAR(50) NULL,
    `aadhaarNumber` VARCHAR(20) NULL,
    `defaultWageRate` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `wageBasis` VARCHAR(20) NOT NULL DEFAULT 'DAILY',
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `daily_workers_businessId_status_idx`(`businessId`, `status`),
    UNIQUE INDEX `daily_workers_businessId_workerCode_key`(`businessId`, `workerCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_daily_labour` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `businessId` INTEGER NOT NULL,
    `projectId` INTEGER NOT NULL,
    `workerId` INTEGER NOT NULL,
    `workDate` DATE NOT NULL,
    `trade` VARCHAR(100) NULL,
    `hours` DECIMAL(6, 2) NOT NULL DEFAULT 8.00,
    `wageRate` DECIMAL(10, 2) NOT NULL,
    `wageBasis` VARCHAR(20) NOT NULL DEFAULT 'DAILY',
    `grossPayable` DECIMAL(12, 2) NOT NULL,
    `advancesDeducted` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `netPayable` DECIMAL(12, 2) NOT NULL,
    `paymentMethod` VARCHAR(30) NOT NULL DEFAULT 'CASH',
    `paymentStatus` VARCHAR(20) NOT NULL DEFAULT 'UNPAID',
    `paidAt` DATETIME(3) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'APPROVED',
    `supervisorId` INTEGER NULL,
    `journalEntryId` INTEGER NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `project_daily_labour_projectId_workDate_idx`(`projectId`, `workDate`),
    INDEX `project_daily_labour_businessId_idx`(`businessId`),
    INDEX `project_daily_labour_workerId_idx`(`workerId`),
    INDEX `project_daily_labour_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_contractor_work_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `businessId` INTEGER NOT NULL,
    `projectId` INTEGER NOT NULL,
    `supplierId` INTEGER NOT NULL,
    `orderNumber` VARCHAR(50) NOT NULL,
    `contractTitle` VARCHAR(255) NOT NULL,
    `contractValue` DECIMAL(14, 2) NOT NULL,
    `withholdingTaxRate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `startDate` DATE NULL,
    `endDate` DATE NULL,
    `terms` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `project_contractor_work_orders_projectId_idx`(`projectId`),
    INDEX `project_contractor_work_orders_supplierId_idx`(`supplierId`),
    INDEX `project_contractor_work_orders_status_idx`(`status`),
    UNIQUE INDEX `project_contractor_work_orders_businessId_orderNumber_key`(`businessId`, `orderNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `credit_debit_notes_projectId_idx` ON `credit_debit_notes`(`projectId`);

-- CreateIndex
CREATE INDEX `employee_reimbursements_projectId_idx` ON `employee_reimbursements`(`projectId`);

-- CreateIndex
CREATE INDEX `expenses_projectId_idx` ON `expenses`(`projectId`);

-- CreateIndex
CREATE INDEX `invoice_items_projectId_idx` ON `invoice_items`(`projectId`);

-- CreateIndex
CREATE INDEX `invoices_projectId_idx` ON `invoices`(`projectId`);

-- CreateIndex
CREATE INDEX `project_costs_businessId_idx` ON `project_costs`(`businessId`);

-- CreateIndex
CREATE INDEX `project_costs_category_idx` ON `project_costs`(`category`);

-- CreateIndex
CREATE INDEX `project_costs_status_idx` ON `project_costs`(`status`);

-- CreateIndex
CREATE UNIQUE INDEX `project_costs_businessId_sourceType_sourceId_sourceLineId_key` ON `project_costs`(`businessId`, `sourceType`, `sourceId`, `sourceLineId`);

-- CreateIndex
CREATE INDEX `projects_managerId_idx` ON `projects`(`managerId`);

-- CreateIndex
CREATE INDEX `purchase_orders_projectId_idx` ON `purchase_orders`(`projectId`);

-- CreateIndex
CREATE INDEX `stock_movements_projectId_idx` ON `stock_movements`(`projectId`);

-- CreateIndex
CREATE INDEX `supplier_bill_items_projectId_idx` ON `supplier_bill_items`(`projectId`);

-- CreateIndex
CREATE INDEX `business_profiles_businessId_idx` ON `business_profiles`(`businessId`);

-- CreateIndex
CREATE INDEX `supplier_bills_projectId_idx` ON `supplier_bills`(`projectId`);

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `supplier_bills` ADD CONSTRAINT `supplier_bills_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `supplier_bill_items` ADD CONSTRAINT `supplier_bill_items_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_items` ADD CONSTRAINT `invoice_items_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_notes` ADD CONSTRAINT `credit_debit_notes_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_reimbursements` ADD CONSTRAINT `employee_reimbursements_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_managerId_fkey` FOREIGN KEY (`managerId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE `project_costs` DROP FOREIGN KEY `project_costs_projectId_fkey`;

-- AddForeignKey
ALTER TABLE `project_costs` ADD CONSTRAINT `project_costs_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_costs` ADD CONSTRAINT `project_costs_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_attachments` ADD CONSTRAINT `project_attachments_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_attachments` ADD CONSTRAINT `project_attachments_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_attachments` ADD CONSTRAINT `project_attachments_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `daily_workers` ADD CONSTRAINT `daily_workers_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_daily_labour` ADD CONSTRAINT `project_daily_labour_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_daily_labour` ADD CONSTRAINT `project_daily_labour_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_daily_labour` ADD CONSTRAINT `project_daily_labour_workerId_fkey` FOREIGN KEY (`workerId`) REFERENCES `daily_workers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_daily_labour` ADD CONSTRAINT `project_daily_labour_supervisorId_fkey` FOREIGN KEY (`supervisorId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_daily_labour` ADD CONSTRAINT `project_daily_labour_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `journal_entries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_contractor_work_orders` ADD CONSTRAINT `project_contractor_work_orders_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_contractor_work_orders` ADD CONSTRAINT `project_contractor_work_orders_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_contractor_work_orders` ADD CONSTRAINT `project_contractor_work_orders_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_profiles` ADD CONSTRAINT `business_profiles_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_activity_logs` ADD CONSTRAINT `user_activity_logs_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
