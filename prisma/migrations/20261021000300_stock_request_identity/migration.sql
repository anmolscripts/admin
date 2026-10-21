ALTER TABLE `stock_movements`
    ADD COLUMN `requestKey` VARCHAR(100) NULL,
    ADD COLUMN `requestHash` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `stock_movements_businessId_requestKey_key`
    ON `stock_movements` (`businessId`, `requestKey`);
