-- CreateTable
CREATE TABLE `financial_years` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(20) NOT NULL,
    `startDate` DATETIME(3) NOT NULL,
    `endDate` DATETIME(3) NOT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    `isCurrent` BOOLEAN NOT NULL DEFAULT false,
    `closedAt` DATETIME(3) NULL,
    `closedById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `financial_years_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `financial_years` ADD CONSTRAINT `financial_years_closedById_fkey` FOREIGN KEY (`closedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Add financialYearId to invoices
ALTER TABLE `invoices` ADD COLUMN `financialYearId` INTEGER NULL;
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX `invoices_financialYearId_index` ON `invoices`(`financialYearId`);

-- Add financialYearId to payments
ALTER TABLE `payments` ADD COLUMN `financialYearId` INTEGER NULL;
ALTER TABLE `payments` ADD CONSTRAINT `payments_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX `payments_financialYearId_index` ON `payments`(`financialYearId`);
