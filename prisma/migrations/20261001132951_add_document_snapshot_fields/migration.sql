-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `billingAddress` TEXT NULL,
    ADD COLUMN `clientEmail` VARCHAR(255) NULL,
    ADD COLUMN `clientPhone` VARCHAR(50) NULL,
    ADD COLUMN `remarks` TEXT NULL,
    ADD COLUMN `shippingAddress` TEXT NULL,
    ADD COLUMN `termsAndConditions` TEXT NULL;
