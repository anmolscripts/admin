-- Safe forward migration: Require explicit businessId on payroll_periods without defaults

-- 1. Ensure any historic payroll periods are assigned to default business 1 if null
UPDATE `payroll_periods` SET `businessId` = 1 WHERE `businessId` IS NULL;

-- 2. Modify businessId column to be NOT NULL without default value
ALTER TABLE `payroll_periods` MODIFY `businessId` INTEGER NOT NULL;
