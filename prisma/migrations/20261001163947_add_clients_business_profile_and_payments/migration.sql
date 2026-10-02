-- AlterTable
ALTER TABLE `invoice_items` ADD COLUMN `hsnSac` VARCHAR(20) NULL;

-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `cgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `clientGSTIN` VARCHAR(20) NULL,
    ADD COLUMN `clientId` INTEGER NULL,
    ADD COLUMN `igstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `outstandingAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `paidAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN `placeOfSupplyStateCode` VARCHAR(5) NULL,
    ADD COLUMN `sellerAddress` TEXT NULL,
    ADD COLUMN `sellerEmail` VARCHAR(191) NULL,
    ADD COLUMN `sellerGSTIN` VARCHAR(20) NULL,
    ADD COLUMN `sellerName` VARCHAR(191) NULL,
    ADD COLUMN `sellerPhone` VARCHAR(50) NULL,
    ADD COLUMN `sellerStateCode` VARCHAR(5) NULL,
    ADD COLUMN `sgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00;

-- CreateTable
CREATE TABLE `clients` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(50) NULL,
    `gstin` VARCHAR(20) NULL,
    `stateCode` VARCHAR(5) NULL,
    `billingAddress` TEXT NULL,
    `shippingAddress` TEXT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `createdById` INTEGER NULL,

    INDEX `clients_name_idx`(`name`),
    INDEX `clients_email_idx`(`email`),
    INDEX `clients_active_idx`(`active`),
    INDEX `clients_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_profiles` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `legalName` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NULL,
    `gstin` VARCHAR(20) NULL,
    `stateCode` VARCHAR(5) NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(50) NULL,
    `address` TEXT NULL,
    `defaultTerms` TEXT NULL,
    `defaultRemarks` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `invoiceId` INTEGER NOT NULL,
    `paymentDate` DATE NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `method` VARCHAR(50) NOT NULL DEFAULT 'BANK_TRANSFER',
    `reference` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'POSTED',
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payments_invoiceId_idx`(`invoiceId`),
    INDEX `payments_status_idx`(`status`),
    INDEX `payments_paymentDate_idx`(`paymentDate`),
    INDEX `payments_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `invoices_clientId_idx` ON `invoices`(`clientId`);

-- AddForeignKey
ALTER TABLE `clients` ADD CONSTRAINT `clients_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
