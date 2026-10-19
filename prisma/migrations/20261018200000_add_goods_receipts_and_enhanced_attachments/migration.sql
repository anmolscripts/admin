-- AlterTable
ALTER TABLE `purchase_order_items` ADD COLUMN `projectId` INTEGER NULL;

-- AlterTable
ALTER TABLE `stock_movements` ADD COLUMN `storeLocation` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `project_attachments` ADD COLUMN `title` VARCHAR(255) NULL,
    ADD COLUMN `category` VARCHAR(50) NOT NULL DEFAULT 'OTHER',
    ADD COLUMN `description` TEXT NULL,
    ADD COLUMN `referenceNumber` VARCHAR(100) NULL,
    ADD COLUMN `issueDate` DATE NULL,
    ADD COLUMN `expiryDate` DATE NULL;

-- CreateTable
CREATE TABLE `goods_receipts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `receiptNumber` VARCHAR(50) NOT NULL,
    `businessId` INTEGER NOT NULL,
    `purchaseOrderId` INTEGER NULL,
    `supplierId` INTEGER NULL,
    `supplierName` VARCHAR(255) NOT NULL,
    `deliveryChallanNumber` VARCHAR(100) NULL,
    `receiptDate` DATE NOT NULL,
    `storeLocation` VARCHAR(100) NOT NULL DEFAULT 'Main Warehouse',
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACCEPTED',
    `notes` TEXT NULL,
    `projectId` INTEGER NULL,
    `receivedById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `goods_receipts_businessId_idx`(`businessId`),
    INDEX `goods_receipts_purchaseOrderId_idx`(`purchaseOrderId`),
    INDEX `goods_receipts_supplierId_idx`(`supplierId`),
    INDEX `goods_receipts_projectId_idx`(`projectId`),
    INDEX `goods_receipts_receiptDate_idx`(`receiptDate`),
    INDEX `goods_receipts_status_idx`(`status`),
    UNIQUE INDEX `goods_receipts_businessId_receiptNumber_key`(`businessId`, `receiptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipt_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `goodsReceiptId` INTEGER NOT NULL,
    `purchaseOrderItemId` INTEGER NULL,
    `itemId` INTEGER NULL,
    `name` VARCHAR(255) NOT NULL,
    `unit` VARCHAR(30) NOT NULL DEFAULT 'PCS',
    `orderedQuantity` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `receivedQuantity` DECIMAL(10, 2) NOT NULL,
    `acceptedQuantity` DECIMAL(10, 2) NOT NULL,
    `rejectedQuantity` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `unitCost` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `totalCost` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `stockMovementId` INTEGER NULL,

    INDEX `goods_receipt_items_goodsReceiptId_idx`(`goodsReceiptId`),
    INDEX `goods_receipt_items_purchaseOrderItemId_idx`(`purchaseOrderItemId`),
    INDEX `goods_receipt_items_itemId_idx`(`itemId`),
    INDEX `goods_receipt_items_stockMovementId_idx`(`stockMovementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `project_attachments_category_idx` ON `project_attachments`(`category`);

-- CreateIndex
CREATE INDEX `purchase_order_items_projectId_idx` ON `purchase_order_items`(`projectId`);

-- CreateIndex
CREATE INDEX `stock_movements_storeLocation_idx` ON `stock_movements`(`storeLocation`);

-- AddForeignKey
ALTER TABLE `purchase_order_items` ADD CONSTRAINT `purchase_order_items_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_businessId_fkey` FOREIGN KEY (`businessId`) REFERENCES `businesses`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_purchaseOrderId_fkey` FOREIGN KEY (`purchaseOrderId`) REFERENCES `purchase_orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_receivedById_fkey` FOREIGN KEY (`receivedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_items` ADD CONSTRAINT `goods_receipt_items_goodsReceiptId_fkey` FOREIGN KEY (`goodsReceiptId`) REFERENCES `goods_receipts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_items` ADD CONSTRAINT `goods_receipt_items_purchaseOrderItemId_fkey` FOREIGN KEY (`purchaseOrderItemId`) REFERENCES `purchase_order_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_items` ADD CONSTRAINT `goods_receipt_items_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_items` ADD CONSTRAINT `goods_receipt_items_stockMovementId_fkey` FOREIGN KEY (`stockMovementId`) REFERENCES `stock_movements`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
