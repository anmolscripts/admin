-- AlterTable
ALTER TABLE `invoice_revisions` ADD COLUMN `ipAddress` VARCHAR(45) NULL,
    ADD COLUMN `userAgent` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `unit` VARCHAR(30) NOT NULL DEFAULT 'PCS',
    `rate` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `hsnSac` VARCHAR(20) NULL,
    `gstRate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `createdById` INTEGER NULL,

    INDEX `items_name_idx`(`name`),
    INDEX `items_active_idx`(`active`),
    INDEX `items_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
