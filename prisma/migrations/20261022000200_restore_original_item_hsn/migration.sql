-- Undo the HSN uniqueness requirement without rewriting any item or document values.
DROP INDEX `items_businessId_hsnSac_key` ON `items`;
