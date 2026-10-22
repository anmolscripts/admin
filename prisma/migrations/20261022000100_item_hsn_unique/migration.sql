-- Existing duplicate HSN/SAC values must be reviewed before applying this constraint.
CREATE UNIQUE INDEX `items_businessId_hsnSac_key` ON `items`(`businessId`, `hsnSac`);
