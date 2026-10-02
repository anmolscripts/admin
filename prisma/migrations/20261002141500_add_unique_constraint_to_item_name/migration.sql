-- DropIndex
DROP INDEX `items_name_idx` ON `items`;

-- CreateIndex
CREATE UNIQUE INDEX `items_name_key` ON `items`(`name`);
