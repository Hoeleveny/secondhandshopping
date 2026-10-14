-- =============================================================
--  迁移 006：商品编号 product_code（含支撑字段）
--  规则：[分类码4]-[卖家码4]-[日期码6]-[流水号5]，如 LF03-0287-261014-00035
--  幂等脚本：每步先查 information_schema 再决定是否执行，重复运行安全。
--  执行方式： .venv\Scripts\python.exe manage.py migrate
--
--  注意：product_code 先允许 NULL（便于回填），唯一索引可以立刻建
--        （MySQL 的 UNIQUE 允许多个 NULL）。
--        回填由 `manage.py backfill-codes` 完成，它会在最后把该列收紧为 NOT NULL。
-- =============================================================

-- 1) products.product_code -------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'products' AND column_name = 'product_code');
SET @sql := IF(@c = 0,
  'ALTER TABLE `products` ADD COLUMN `product_code` VARCHAR(32) NULL COMMENT ''商品编号：分类码-卖家码-日期码-流水号，系统生成、永不改变''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @i := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'products' AND index_name = 'uk_product_code');
SET @sql := IF(@i = 0,
  'ALTER TABLE `products` ADD UNIQUE KEY `uk_product_code` (`product_code`)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 2) users.seller_seq（卖家脱敏序号，惰性分配：首次发布商品时才给值）------
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'seller_seq');
SET @sql := IF(@c = 0,
  'ALTER TABLE `users` ADD COLUMN `seller_seq` INT NULL COMMENT ''卖家码来源：首次发布商品时惰性分配，不透出真实用户 id''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @i := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'uk_users_seller_seq');
SET @sql := IF(@i = 0,
  'ALTER TABLE `users` ADD UNIQUE KEY `uk_users_seller_seq` (`seller_seq`)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 3) categories.code（大类 2 位字母助记码，管理员维护）---------------------
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'categories' AND column_name = 'code');
SET @sql := IF(@c = 0,
  'ALTER TABLE `categories` ADD COLUMN `code` VARCHAR(2) NULL COMMENT ''大类字母助记码：TA/DG/LF/SP/OT…，管理员维护''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @i := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'categories' AND index_name = 'uk_categories_code');
SET @sql := IF(@i = 0,
  'ALTER TABLE `categories` ADD UNIQUE KEY `uk_categories_code` (`code`)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 4) subcategories.seq_in_category（大类内稳定序号，编号小类段的取值依据）---
--    提示词原文只列了 products/users/categories 三张表，漏了这张——
--    小类段必须用"稳定"的序号：若按当时顺序临时排名，删掉一个小类后，
--    同一个小类的商品前后会拿到不同的段值，编号就不一致了。
SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'subcategories' AND column_name = 'seq_in_category');
SET @sql := IF(@c = 0,
  'ALTER TABLE `subcategories` ADD COLUMN `seq_in_category` INT NULL COMMENT ''在大类内的稳定序号（迁移时按 id 顺序固化，之后不变）''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @i := (SELECT COUNT(*) FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'subcategories' AND index_name = 'uk_subcategories_seq');
SET @sql := IF(@i = 0,
  'ALTER TABLE `subcategories` ADD UNIQUE KEY `uk_subcategories_seq` (`category_id`, `seq_in_category`)',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
