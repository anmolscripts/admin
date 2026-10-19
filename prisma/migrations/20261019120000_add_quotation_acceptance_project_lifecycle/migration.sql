-- Additive lifecycle fields. Do not apply this migration to a protected database.
ALTER TABLE `invoices`
  ADD COLUMN `acceptedAt` DATETIME(3) NULL,
  ADD COLUMN `acceptedById` INTEGER NULL,
  ADD COLUMN `acceptanceNote` TEXT NULL;

ALTER TABLE `projects`
  ADD COLUMN `sourceQuotationId` INTEGER NULL,
  ADD COLUMN `sourceQuotationNumber` VARCHAR(50) NULL,
  ADD COLUMN `sourceQuotationSnapshot` JSON NULL,
  ADD COLUMN `closedAt` DATETIME(3) NULL,
  ADD COLUMN `closedById` INTEGER NULL,
  ADD COLUMN `closureOverrideReason` TEXT NULL;

CREATE INDEX `invoices_acceptedById_idx` ON `invoices`(`acceptedById`);
CREATE UNIQUE INDEX `projects_sourceQuotationId_key` ON `projects`(`sourceQuotationId`);
CREATE INDEX `projects_closedById_idx` ON `projects`(`closedById`);

ALTER TABLE `invoices` ADD CONSTRAINT `invoices_acceptedById_fkey`
  FOREIGN KEY (`acceptedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `projects` ADD CONSTRAINT `projects_sourceQuotationId_fkey`
  FOREIGN KEY (`sourceQuotationId`) REFERENCES `invoices`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `projects` ADD CONSTRAINT `projects_closedById_fkey`
  FOREIGN KEY (`closedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
