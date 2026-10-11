-- =============================================================
--  迁移 003：买家侧删除订单记录（功能④）
--  订单不真删，只做「买家侧隐藏」：卖家卖出订单与交易数据都保留。
--  幂等脚本：用 information_schema 判断列是否已存在，重复执行安全。
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'buyer_deleted'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `orders` ADD COLUMN `buyer_deleted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''买家是否已删除该订单记录（仅买家侧隐藏）''',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @exists_idx := (
  SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND index_name = 'idx_orders_buyer_visible'
);
SET @sql_idx := IF(@exists_idx = 0,
  'ALTER TABLE `orders` ADD INDEX `idx_orders_buyer_visible` (`buyer_id`, `buyer_deleted`, `status`)',
  'SELECT 1');
PREPARE stmt2 FROM @sql_idx;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
