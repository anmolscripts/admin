-- Migration: 20261011120000_multi_business_and_central_numbering
-- Purpose: Introduce canonical Business entity, BusinessMembership, NumberingSequence,
--          BusinessPrefixConfig, businessId tenant ownership, and business-scoped uniqueness.

-- 1. Create canonical Business table
CREATE TABLE IF NOT EXISTS `businesses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `legalName` VARCHAR(255) NULL,
    `gstin` VARCHAR(20) NULL,
    `stateCode` VARCHAR(5) NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'INR',
    `timeZone` VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(50) NULL,
    `address` TEXT NULL,
    `website` VARCHAR(191) NULL,
    `logoUrl` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `businesses_code_key`(`code`),
    INDEX `businesses_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. Create BusinessMembership table
CREATE TABLE IF NOT EXISTS `business_memberships` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `businessId` INTEGER NOT NULL,
    `role` VARCHAR(30) NOT NULL DEFAULT 'MEMBER',
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `business_memberships_userId_businessId_key`(`userId`, `businessId`),
    INDEX `business_memberships_businessId_idx`(`businessId`),
    INDEX `business_memberships_userId_idx`(`userId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `business_memberships_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `business_memberships_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 3. Create centralized NumberingSequence table (14-digit safe with BIGINT, keyed by businessId + entityType + year + month)
CREATE TABLE IF NOT EXISTS `numbering_sequences` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `businessId` INTEGER NOT NULL,
    `entityType` VARCHAR(50) NOT NULL,
    `year` INTEGER NOT NULL,
    `month` INTEGER NOT NULL,
    `currentNumber` BIGINT NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `numbering_sequences_businessId_entityType_year_month_key`(`businessId`, `entityType`, `year`, `month`),
    INDEX `numbering_sequences_businessId_entityType_idx`(`businessId`, `entityType`),
    PRIMARY KEY (`id`),
    CONSTRAINT `numbering_sequences_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 4. Create BusinessPrefixConfig table
CREATE TABLE IF NOT EXISTS `business_prefix_configs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `businessId` INTEGER NOT NULL,
    `entityType` VARCHAR(50) NOT NULL,
    `prefix` VARCHAR(20) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `business_prefix_configs_businessId_entityType_key`(`businessId`, `entityType`),
    INDEX `business_prefix_configs_businessId_idx`(`businessId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `business_prefix_configs_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 5. Add businessId and internal references to business-owned tables
ALTER TABLE `business_profiles` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `clients` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `suppliers` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `purchase_orders` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `supplier_bills` ADD COLUMN `businessId` INTEGER NULL, ADD COLUMN `internalNumber` VARCHAR(50) NULL;
ALTER TABLE `expenses` ADD COLUMN `businessId` INTEGER NULL, ADD COLUMN `expenseNumber` VARCHAR(50) NULL;
ALTER TABLE `other_incomes` ADD COLUMN `businessId` INTEGER NULL, ADD COLUMN `incomeNumber` VARCHAR(50) NULL;
ALTER TABLE `invoices` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `items` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `units` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `payments` ADD COLUMN `businessId` INTEGER NULL, ADD COLUMN `receiptNumber` VARCHAR(50) NULL;
ALTER TABLE `financial_years` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `chart_of_accounts` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `journal_entries` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `credit_debit_notes` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `supplier_payments` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `stock_movements` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `employees` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `salary_structures` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `payroll_periods` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `employee_reimbursements` ADD COLUMN `businessId` INTEGER NULL, ADD COLUMN `claimNumber` VARCHAR(50) NULL;
ALTER TABLE `projects` ADD COLUMN `businessId` INTEGER NULL;
ALTER TABLE `user_activity_logs` ADD COLUMN `businessId` INTEGER NULL;

-- 6. Seed / backfill initial default Business (id: 1)
INSERT INTO `businesses` (`id`, `code`, `name`, `legalName`, `gstin`, `stateCode`, `currency`, `timeZone`, `status`, `createdAt`, `updatedAt`)
SELECT 1, 'DEFAULT', COALESCE(displayName, legalName, 'Spark Technologies'), COALESCE(legalName, 'Spark Admin Technologies Pvt Ltd'), gstin, stateCode, COALESCE(currency, 'INR'), COALESCE(timeZone, 'Asia/Kolkata'), 'ACTIVE', NOW(), NOW()
FROM (SELECT 1 as dummy) d
LEFT JOIN `business_profiles` bp ON bp.id = 1
ON DUPLICATE KEY UPDATE `code` = `code`;

INSERT IGNORE INTO `businesses` (`id`, `code`, `name`, `legalName`, `currency`, `timeZone`, `status`, `createdAt`, `updatedAt`)
VALUES (1, 'DEFAULT', 'Spark Technologies', 'Spark Admin Technologies Pvt Ltd', 'INR', 'Asia/Kolkata', 'ACTIVE', NOW(), NOW());

-- Backfill businessId = 1 on all existing rows
UPDATE `business_profiles` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `clients` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `suppliers` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `purchase_orders` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `supplier_bills` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `expenses` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `other_incomes` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `invoices` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `items` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `units` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `payments` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `financial_years` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `chart_of_accounts` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `journal_entries` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `credit_debit_notes` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `supplier_payments` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `stock_movements` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `employees` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `salary_structures` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `payroll_periods` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `employee_reimbursements` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `projects` SET `businessId` = 1 WHERE `businessId` IS NULL;
UPDATE `user_activity_logs` SET `businessId` = 1 WHERE `businessId` IS NULL;

-- Ensure all existing users have membership in business 1
INSERT IGNORE INTO `business_memberships` (`userId`, `businessId`, `role`, `status`, `isDefault`, `createdAt`, `updatedAt`)
SELECT `id`, 1, IF(`role` = 'ADMIN', 'OWNER', 'MEMBER'), 'ACTIVE', true, NOW(), NOW()
FROM `users`;

-- 7. Add foreign keys and indexes
ALTER TABLE `clients` ADD INDEX `clients_businessId_idx`(`businessId`);
ALTER TABLE `suppliers` ADD INDEX `suppliers_businessId_idx`(`businessId`);
ALTER TABLE `purchase_orders` ADD INDEX `purchase_orders_businessId_idx`(`businessId`);
ALTER TABLE `supplier_bills` ADD INDEX `supplier_bills_businessId_idx`(`businessId`);
ALTER TABLE `expenses` ADD INDEX `expenses_businessId_idx`(`businessId`);
ALTER TABLE `other_incomes` ADD INDEX `other_incomes_businessId_idx`(`businessId`);
ALTER TABLE `invoices` ADD INDEX `invoices_businessId_idx`(`businessId`);
ALTER TABLE `items` ADD INDEX `items_businessId_idx`(`businessId`);
ALTER TABLE `units` ADD INDEX `units_businessId_idx`(`businessId`);
ALTER TABLE `payments` ADD INDEX `payments_businessId_idx`(`businessId`);
ALTER TABLE `financial_years` ADD INDEX `financial_years_businessId_idx`(`businessId`);
ALTER TABLE `chart_of_accounts` ADD INDEX `chart_of_accounts_businessId_idx`(`businessId`);
ALTER TABLE `journal_entries` ADD INDEX `journal_entries_businessId_idx`(`businessId`);
ALTER TABLE `credit_debit_notes` ADD INDEX `credit_debit_notes_businessId_idx`(`businessId`);
ALTER TABLE `supplier_payments` ADD INDEX `supplier_payments_businessId_idx`(`businessId`);
ALTER TABLE `stock_movements` ADD INDEX `stock_movements_businessId_idx`(`businessId`);
ALTER TABLE `employees` ADD INDEX `employees_businessId_idx`(`businessId`);
ALTER TABLE `salary_structures` ADD INDEX `salary_structures_businessId_idx`(`businessId`);
ALTER TABLE `payroll_periods` ADD INDEX `payroll_periods_businessId_idx`(`businessId`);
ALTER TABLE `employee_reimbursements` ADD INDEX `employee_reimbursements_businessId_idx`(`businessId`);
ALTER TABLE `projects` ADD INDEX `projects_businessId_idx`(`businessId`);
ALTER TABLE `user_activity_logs` ADD INDEX `user_activity_logs_businessId_idx`(`businessId`);

ALTER TABLE `clients` ADD CONSTRAINT `clients_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `suppliers` ADD CONSTRAINT `suppliers_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `supplier_bills` ADD CONSTRAINT `supplier_bills_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `other_incomes` ADD CONSTRAINT `other_incomes_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `items` ADD CONSTRAINT `items_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `units` ADD CONSTRAINT `units_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `financial_years` ADD CONSTRAINT `financial_years_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `chart_of_accounts` ADD CONSTRAINT `chart_of_accounts_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `credit_debit_notes` ADD CONSTRAINT `credit_debit_notes_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `supplier_payments` ADD CONSTRAINT `supplier_payments_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `employees` ADD CONSTRAINT `employees_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `salary_structures` ADD CONSTRAINT `salary_structures_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `payroll_periods` ADD CONSTRAINT `payroll_periods_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `employee_reimbursements` ADD CONSTRAINT `employee_reimbursements_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `projects` ADD CONSTRAINT `projects_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- 8. Replace global unique indexes with business-scoped composite unique indexes
DROP INDEX `invoices_invoiceNumber_key` ON `invoices`;
CREATE UNIQUE INDEX `invoices_businessId_invoiceNumber_key` ON `invoices`(`businessId`, `invoiceNumber`);

DROP INDEX `purchase_orders_orderNumber_key` ON `purchase_orders`;
CREATE UNIQUE INDEX `purchase_orders_businessId_orderNumber_key` ON `purchase_orders`(`businessId`, `orderNumber`);

DROP INDEX `credit_debit_notes_noteNumber_key` ON `credit_debit_notes`;
CREATE UNIQUE INDEX `credit_debit_notes_businessId_noteNumber_key` ON `credit_debit_notes`(`businessId`, `noteNumber`);

DROP INDEX `journal_entries_entryNumber_key` ON `journal_entries`;
CREATE UNIQUE INDEX `journal_entries_businessId_entryNumber_key` ON `journal_entries`(`businessId`, `entryNumber`);

DROP INDEX `supplier_bills_billNumber_key` ON `supplier_bills`;
CREATE UNIQUE INDEX `supplier_bills_businessId_billNumber_key` ON `supplier_bills`(`businessId`, `billNumber`);
CREATE UNIQUE INDEX `supplier_bills_businessId_internalNumber_key` ON `supplier_bills`(`businessId`, `internalNumber`);

DROP INDEX `supplier_payments_paymentNumber_key` ON `supplier_payments`;
CREATE UNIQUE INDEX `supplier_payments_businessId_paymentNumber_key` ON `supplier_payments`(`businessId`, `paymentNumber`);

DROP INDEX `stock_movements_movementNumber_key` ON `stock_movements`;
CREATE UNIQUE INDEX `stock_movements_businessId_movementNumber_key` ON `stock_movements`(`businessId`, `movementNumber`);

DROP INDEX `employees_employeeCode_key` ON `employees`;
CREATE UNIQUE INDEX `employees_businessId_employeeCode_key` ON `employees`(`businessId`, `employeeCode`);

DROP INDEX `projects_code_key` ON `projects`;
CREATE UNIQUE INDEX `projects_businessId_code_key` ON `projects`(`businessId`, `code`);

DROP INDEX `items_name_key` ON `items`;
CREATE UNIQUE INDEX `items_businessId_name_key` ON `items`(`businessId`, `name`);

DROP INDEX `financial_years_code_key` ON `financial_years`;
CREATE UNIQUE INDEX `financial_years_businessId_code_key` ON `financial_years`(`businessId`, `code`);

DROP INDEX `chart_of_accounts_code_key` ON `chart_of_accounts`;
DROP INDEX `chart_of_accounts_systemAccountKey_key` ON `chart_of_accounts`;
CREATE UNIQUE INDEX `chart_of_accounts_businessId_code_key` ON `chart_of_accounts`(`businessId`, `code`);
CREATE UNIQUE INDEX `chart_of_accounts_businessId_systemAccountKey_key` ON `chart_of_accounts`(`businessId`, `systemAccountKey`);
