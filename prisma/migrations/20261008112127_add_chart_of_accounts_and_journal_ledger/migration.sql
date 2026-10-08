-- CreateTable
CREATE TABLE `chart_of_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE') NOT NULL,
    `subtype` VARCHAR(100) NULL,
    `parentId` INTEGER NULL,
    `level` INTEGER NOT NULL DEFAULT 1,
    `isGroup` BOOLEAN NOT NULL DEFAULT false,
    `isControlAccount` BOOLEAN NOT NULL DEFAULT false,
    `allowPosting` BOOLEAN NOT NULL DEFAULT true,
    `openingBalance` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `openingBalanceType` VARCHAR(10) NOT NULL DEFAULT 'DEBIT',
    `currentBalance` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `systemAccount` BOOLEAN NOT NULL DEFAULT false,
    `systemAccountKey` VARCHAR(50) NULL,
    `description` TEXT NULL,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `chart_of_accounts_code_key`(`code`),
    UNIQUE INDEX `chart_of_accounts_systemAccountKey_key`(`systemAccountKey`),
    INDEX `chart_of_accounts_type_idx`(`type`),
    INDEX `chart_of_accounts_parentId_idx`(`parentId`),
    INDEX `chart_of_accounts_isGroup_idx`(`isGroup`),
    INDEX `chart_of_accounts_active_idx`(`active`),
    INDEX `chart_of_accounts_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `journal_entries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `entryNumber` VARCHAR(50) NOT NULL,
    `entryDate` DATE NOT NULL,
    `financialYearId` INTEGER NOT NULL,
    `sourceType` VARCHAR(50) NOT NULL DEFAULT 'MANUAL',
    `sourceId` INTEGER NULL,
    `narration` TEXT NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'POSTED',
    `idempotencyKey` VARCHAR(100) NULL,
    `postedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `postedById` INTEGER NULL,
    `reversedEntryId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `journal_entries_entryNumber_key`(`entryNumber`),
    UNIQUE INDEX `journal_entries_reversedEntryId_key`(`reversedEntryId`),
    UNIQUE INDEX `journal_entries_idempotencyKey_key`(`idempotencyKey`),
    INDEX `journal_entries_entryDate_idx`(`entryDate`),
    INDEX `journal_entries_financialYearId_idx`(`financialYearId`),
    INDEX `journal_entries_sourceType_sourceId_idx`(`sourceType`, `sourceId`),
    INDEX `journal_entries_status_idx`(`status`),
    INDEX `journal_entries_postedById_idx`(`postedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `journal_number_sequences` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `financialYearId` INTEGER NOT NULL,
    `currentNumber` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `journal_number_sequences_financialYearId_key`(`financialYearId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `journal_entry_lines` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `journalEntryId` INTEGER NOT NULL,
    `accountId` INTEGER NOT NULL,
    `lineNumber` INTEGER NOT NULL,
    `debit` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `credit` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `description` TEXT NULL,
    `clientId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `journal_entry_lines_journalEntryId_idx`(`journalEntryId`),
    INDEX `journal_entry_lines_accountId_idx`(`accountId`),
    INDEX `journal_entry_lines_clientId_idx`(`clientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `chart_of_accounts` ADD CONSTRAINT `chart_of_accounts_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `chart_of_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chart_of_accounts` ADD CONSTRAINT `chart_of_accounts_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_postedById_fkey` FOREIGN KEY (`postedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_reversedEntryId_fkey` FOREIGN KEY (`reversedEntryId`) REFERENCES `journal_entries`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entry_lines` ADD CONSTRAINT `journal_entry_lines_journalEntryId_fkey` FOREIGN KEY (`journalEntryId`) REFERENCES `journal_entries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entry_lines` ADD CONSTRAINT `journal_entry_lines_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `chart_of_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entry_lines` ADD CONSTRAINT `journal_entry_lines_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_number_sequences` ADD CONSTRAINT `journal_number_sequences_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `financial_years` RENAME INDEX `financial_years_closedById_fkey` TO `financial_years_closedById_idx`;

-- RenameIndex
ALTER TABLE `invoices` RENAME INDEX `invoices_financialYearId_index` TO `invoices_financialYearId_idx`;

-- RenameIndex
ALTER TABLE `payments` RENAME INDEX `payments_financialYearId_index` TO `payments_financialYearId_idx`;
