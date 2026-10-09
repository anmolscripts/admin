-- CreateTable
CREATE TABLE `credit_debit_notes` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `noteNumber` VARCHAR(50) NOT NULL,
    `noteType` ENUM('CREDIT', 'DEBIT') NOT NULL,
    `invoiceId` INTEGER NOT NULL,
    `clientId` INTEGER NULL,
    `financialYearId` INTEGER NOT NULL,
    `noteDate` DATE NOT NULL,
    `status` ENUM('DRAFT', 'ISSUED', 'VOID') NOT NULL DEFAULT 'ISSUED',
    `reason` TEXT NOT NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'INR',
    `clientName` VARCHAR(255) NOT NULL,
    `clientEmail` VARCHAR(255) NULL,
    `clientPhone` VARCHAR(50) NULL,
    `clientGSTIN` VARCHAR(20) NULL,
    `placeOfSupplyStateCode` VARCHAR(5) NULL,
    `billingAddress` TEXT NULL,
    `shippingAddress` TEXT NULL,
    `sellerName` VARCHAR(191) NOT NULL,
    `sellerGSTIN` VARCHAR(20) NULL,
    `sellerStateCode` VARCHAR(5) NULL,
    `sellerAddress` TEXT NULL,
    `originalInvoiceNumber` VARCHAR(50) NOT NULL,
    `originalInvoiceDate` DATE NOT NULL,
    `originalInvoiceGrandTotal` DECIMAL(12, 2) NOT NULL,
    `gstEnabled` BOOLEAN NOT NULL DEFAULT false,
    `gstRate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `subtotal` DECIMAL(12, 2) NOT NULL,
    `cgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `sgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `igstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `gstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `roundOff` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `grandTotal` DECIMAL(12, 2) NOT NULL,
    `remarks` TEXT NULL,
    `createdById` INTEGER NOT NULL,
    `updatedById` INTEGER NULL,
    `voidedById` INTEGER NULL,
    `voidReason` TEXT NULL,
    `voidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `credit_debit_notes_noteNumber_key`(`noteNumber`),
    INDEX `credit_debit_notes_noteType_idx`(`noteType`),
    INDEX `credit_debit_notes_invoiceId_idx`(`invoiceId`),
    INDEX `credit_debit_notes_clientId_idx`(`clientId`),
    INDEX `credit_debit_notes_financialYearId_idx`(`financialYearId`),
    INDEX `credit_debit_notes_noteDate_idx`(`noteDate`),
    INDEX `credit_debit_notes_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_debit_note_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `noteId` INTEGER NOT NULL,
    `invoiceItemId` INTEGER NULL,
    `lineNumber` INTEGER NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `hsnSac` VARCHAR(20) NULL,
    `quantity` DECIMAL(10, 2) NOT NULL,
    `unit` VARCHAR(30) NOT NULL DEFAULT 'PCS',
    `rate` DECIMAL(12, 2) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `taxRate` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `cgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `sgstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `igstAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `credit_debit_note_items_noteId_idx`(`noteId`),
    INDEX `credit_debit_note_items_invoiceItemId_idx`(`invoiceItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `credit_debit_note_sequences` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `noteType` ENUM('CREDIT', 'DEBIT') NOT NULL,
    `financialYearId` INTEGER NOT NULL,
    `currentNumber` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `credit_debit_note_sequences_noteType_financialYearId_key`(`noteType`, `financialYearId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `credit_debit_notes` ADD CONSTRAINT `credit_debit_notes_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_notes` ADD CONSTRAINT `credit_debit_notes_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_notes` ADD CONSTRAINT `credit_debit_notes_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_notes` ADD CONSTRAINT `credit_debit_notes_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_notes` ADD CONSTRAINT `credit_debit_notes_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_notes` ADD CONSTRAINT `credit_debit_notes_voidedById_fkey` FOREIGN KEY (`voidedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_note_items` ADD CONSTRAINT `credit_debit_note_items_noteId_fkey` FOREIGN KEY (`noteId`) REFERENCES `credit_debit_notes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_note_items` ADD CONSTRAINT `credit_debit_note_items_invoiceItemId_fkey` FOREIGN KEY (`invoiceItemId`) REFERENCES `invoice_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `credit_debit_note_sequences` ADD CONSTRAINT `credit_debit_note_sequences_financialYearId_fkey` FOREIGN KEY (`financialYearId`) REFERENCES `financial_years`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
