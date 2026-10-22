-- Widen catalog and copied line-item names; preserve existing values and indexes.
ALTER TABLE `items` MODIFY COLUMN `name` VARCHAR(500) NOT NULL;
ALTER TABLE `invoice_items` MODIFY COLUMN `name` VARCHAR(500) NOT NULL;
ALTER TABLE `purchase_order_items` MODIFY COLUMN `name` VARCHAR(500) NOT NULL;
ALTER TABLE `supplier_bill_items` MODIFY COLUMN `name` VARCHAR(500) NOT NULL;
ALTER TABLE `credit_debit_note_items` MODIFY COLUMN `name` VARCHAR(500) NOT NULL;
ALTER TABLE `goods_receipt_items` MODIFY COLUMN `name` VARCHAR(500) NOT NULL;
