-- CreateTable
CREATE TABLE `supplier_bills` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `billNumber` VARCHAR(50) NOT NULL,
    `supplierId` INTEGER NULL,
    `supplierName` VARCHAR(255) NOT NULL,
    `supplierGSTIN` VARCHAR(20) NULL,
    `billDate` DATE NOT NULL,
    `dueDate` DATE NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `totalAmount` DECIMAL(12, 2) NOT NULL,
    `financialYearId` INTEGER NULL,
    `createdById` INTEGER NOT NULL,
    `updatedById` INTEGER NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    UNIQUE INDEX `supplier_bills_billNumber_key`(`billNumber`),
    INDEX `supplier_bills_supplierId_idx`(`supplierId`),
    INDEX `supplier_bills_billDate_idx`(`billDate`),
    INDEX `supplier_bills_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `supplier_bill_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `supplierBillId` INTEGER NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `hsnSac` VARCHAR(20) NULL,
    `quantity` DECIMAL(10, 2) NOT NULL,
    `unit` VARCHAR(30) NOT NULL DEFAULT 'PCS',
    `rate` DECIMAL(12, 2) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,

    INDEX `supplier_bill_items_supplierBillId_idx`(`supplierBillId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `expenseDate` DATE NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `description` TEXT NULL,
    `category` VARCHAR(100) NULL,
    `financialYearId` INTEGER NULL,
    `createdById` INTEGER NOT NULL,
    `updatedById` INTEGER NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `expenses_expenseDate_idx`(`expenseDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `other_incomes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `incomeDate` DATE NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `description` TEXT NULL,
    `source` VARCHAR(100) NULL,
    `financialYearId` INTEGER NULL,
    `createdById` INTEGER NOT NULL,
    `updatedById` INTEGER NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,

    INDEX `other_incomes_incomeDate_idx`(`incomeDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `supplier_bills` ADD CONSTRAINT `supplier_bills_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `supplier_bills` ADD CONSTRAINT `supplier_bills_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `supplier_bills` ADD CONSTRAINT `supplier_bills_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `supplier_bills` ADD CONSTRAINT `supplier_bills_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `supplier_bill_items` ADD CONSTRAINT `supplier_bill_items_supplierBillId_fkey` FOREIGN KEY (`supplierBillId`) REFERENCES `supplier_bills`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `expenses` ADD CONSTRAINT `expenses_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `other_incomes` ADD CONSTRAINT `other_incomes_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `other_incomes` ADD CONSTRAINT `other_incomes_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `other_incomes` ADD CONSTRAINT `other_incomes_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
