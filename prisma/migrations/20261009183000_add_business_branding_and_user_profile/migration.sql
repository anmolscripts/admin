-- AlterTable
ALTER TABLE `business_profiles` ADD COLUMN `accountHolder` VARCHAR(191) NULL,
    ADD COLUMN `accountNumber` VARCHAR(50) NULL,
    ADD COLUMN `bankName` VARCHAR(191) NULL,
    ADD COLUMN `branch` VARCHAR(191) NULL,
    ADD COLUMN `currency` VARCHAR(10) NULL DEFAULT 'INR',
    ADD COLUMN `ifsc` VARCHAR(20) NULL,
    ADD COLUMN `invoiceFooter` TEXT NULL,
    ADD COLUMN `logoUrl` VARCHAR(255) NULL,
    ADD COLUMN `paymentInstructions` TEXT NULL,
    ADD COLUMN `timeZone` VARCHAR(50) NULL DEFAULT 'Asia/Kolkata',
    ADD COLUMN `upiId` VARCHAR(100) NULL,
    ADD COLUMN `website` VARCHAR(191) NULL,
    ADD COLUMN `workspaceName` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `avatarUrl` VARCHAR(255) NULL,
    ADD COLUMN `phone` VARCHAR(50) NULL;
