-- AlterTable: Scope payroll period code uniqueness per business
-- 1. Backfill businessId for any historical payroll periods
UPDATE `payroll_periods` SET `businessId` = 1 WHERE `businessId` IS NULL;

-- 2. Drop the global unique index on periodCode
DROP INDEX `payroll_periods_periodCode_key` ON `payroll_periods`;

-- 3. Add composite unique index on (businessId, periodCode)
ALTER TABLE `payroll_periods` ADD UNIQUE INDEX `payroll_periods_businessId_periodCode_key`(`businessId`, `periodCode`);

-- 4. Add index on periodCode for lookup performance
ALTER TABLE `payroll_periods` ADD INDEX `payroll_periods_periodCode_idx`(`periodCode`);
