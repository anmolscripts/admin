CREATE TABLE `letters` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `businessId` INTEGER NOT NULL,
  `letterNumber` VARCHAR(80) NOT NULL,
  `subject` VARCHAR(255) NOT NULL,
  `recipientName` VARCHAR(255) NOT NULL,
  `recipientAddress` TEXT NULL,
  `letterDate` DATE NOT NULL,
  `bodyHtml` LONGTEXT NOT NULL,
  `templateId` VARCHAR(100) NOT NULL,
  `status` ENUM('ACTIVE','INACTIVE','VOID','DELETED') NOT NULL DEFAULT 'ACTIVE',
  `version` INTEGER NOT NULL DEFAULT 1,
  `createdById` INTEGER NOT NULL,
  `updatedById` INTEGER NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `letters_businessId_letterNumber_key` (`businessId`,`letterNumber`),
  INDEX `letters_businessId_letterDate_idx` (`businessId`,`letterDate`),
  CONSTRAINT `letters_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `letter_revisions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `letterId` INTEGER NOT NULL,
  `version` INTEGER NOT NULL,
  `action` VARCHAR(30) NOT NULL,
  `reason` TEXT NULL,
  `changedById` INTEGER NOT NULL,
  `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `snapshot` JSON NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `letter_revisions_letterId_version_key` (`letterId`,`version`),
  CONSTRAINT `letter_revisions_letterId_fkey` FOREIGN KEY (`letterId`) REFERENCES `letters`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
