-- DropIndex
DROP INDEX `invoice_number_sequences_year_key` ON `invoice_number_sequences`;

-- AlterTable
ALTER TABLE `invoice_number_sequences` ADD COLUMN `documentType` ENUM('QUOTATION', 'INVOICE') NOT NULL DEFAULT 'INVOICE';

-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `deleteReason` TEXT NULL,
    ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `deletedById` INTEGER NULL,
    ADD COLUMN `documentType` ENUM('QUOTATION', 'INVOICE') NOT NULL DEFAULT 'INVOICE',
    ADD COLUMN `previousStatusBeforeDelete` ENUM('ACTIVE', 'INACTIVE', 'VOID', 'DELETED') NULL,
    ADD COLUMN `sourceQuotationId` INTEGER NULL,
    MODIFY `status` ENUM('ACTIVE', 'INACTIVE', 'VOID', 'DELETED') NOT NULL DEFAULT 'ACTIVE';

-- CreateIndex
CREATE UNIQUE INDEX `invoice_number_sequences_documentType_year_key` ON `invoice_number_sequences`(`documentType`, `year`);

-- CreateIndex
CREATE UNIQUE INDEX `invoices_sourceQuotationId_key` ON `invoices`(`sourceQuotationId`);

-- CreateIndex
CREATE INDEX `invoices_documentType_idx` ON `invoices`(`documentType`);

-- CreateIndex
CREATE INDEX `invoices_deletedById_idx` ON `invoices`(`deletedById`);

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_deletedById_fkey` FOREIGN KEY (`deletedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_sourceQuotationId_fkey` FOREIGN KEY (`sourceQuotationId`) REFERENCES `invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
