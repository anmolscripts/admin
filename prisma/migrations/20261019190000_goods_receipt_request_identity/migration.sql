-- Additive: existing receipts keep NULL request identity and are not rewritten.
ALTER TABLE `goods_receipts`
  ADD COLUMN `requestKey` VARCHAR(100) NULL,
  ADD COLUMN `requestHash` CHAR(64) NULL;
CREATE UNIQUE INDEX `goods_receipts_businessId_requestKey_key` ON `goods_receipts` (`businessId`, `requestKey`);
