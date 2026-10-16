-- AlterTable: Add master record identifiers and business-scoped unique keys
-- 1. Clients: Add clientCode
ALTER TABLE `clients` ADD COLUMN `clientCode` VARCHAR(50) NULL;
UPDATE `clients` SET `clientCode` = CONCAT('CUST/', YEAR(`createdAt`), '/', LPAD(MONTH(`createdAt`), 2, '0'), '/', `id`) WHERE `clientCode` IS NULL;
ALTER TABLE `clients` ADD UNIQUE INDEX `clients_businessId_clientCode_key`(`businessId`, `clientCode`);
ALTER TABLE `clients` ADD INDEX `clients_clientCode_idx`(`clientCode`);

-- 2. Suppliers: Add supplierCode
ALTER TABLE `suppliers` ADD COLUMN `supplierCode` VARCHAR(50) NULL;
UPDATE `suppliers` SET `supplierCode` = CONCAT('SUPP/', YEAR(`createdAt`), '/', LPAD(MONTH(`createdAt`), 2, '0'), '/', `id`) WHERE `supplierCode` IS NULL;
ALTER TABLE `suppliers` ADD UNIQUE INDEX `suppliers_businessId_supplierCode_key`(`businessId`, `supplierCode`);
ALTER TABLE `suppliers` ADD INDEX `suppliers_supplierCode_idx`(`supplierCode`);

-- 3. Items: Add itemCode
ALTER TABLE `items` ADD COLUMN `itemCode` VARCHAR(50) NULL;
UPDATE `items` SET `itemCode` = CONCAT('ITEM/', YEAR(`createdAt`), '/', LPAD(MONTH(`createdAt`), 2, '0'), '/', `id`) WHERE `itemCode` IS NULL;
ALTER TABLE `items` ADD UNIQUE INDEX `items_businessId_itemCode_key`(`businessId`, `itemCode`);
ALTER TABLE `items` ADD INDEX `items_itemCode_idx`(`itemCode`);

-- 4. Units: Add unitCode and scope symbol uniqueness per business
ALTER TABLE `units` ADD COLUMN `unitCode` VARCHAR(50) NULL;
UPDATE `units` SET `unitCode` = CONCAT('UNIT/', YEAR(`createdAt`), '/', LPAD(MONTH(`createdAt`), 2, '0'), '/', `id`) WHERE `unitCode` IS NULL;
DROP INDEX `units_symbol_key` ON `units`;
ALTER TABLE `units` ADD UNIQUE INDEX `units_businessId_symbol_key`(`businessId`, `symbol`);
ALTER TABLE `units` ADD UNIQUE INDEX `units_businessId_unitCode_key`(`businessId`, `unitCode`);
ALTER TABLE `units` ADD INDEX `units_symbol_idx`(`symbol`);
ALTER TABLE `units` ADD INDEX `units_unitCode_idx`(`unitCode`);

-- 5. Persistent sessions table for production durablity
CREATE TABLE `sessions` (
    `id` VARCHAR(128) NOT NULL,
    `sid` VARCHAR(128) NOT NULL,
    `data` MEDIUMTEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sessions_sid_key`(`sid`),
    INDEX `sessions_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
