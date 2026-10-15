-- =============================================================
--  迁移 010：订单的「卖家侧隐藏」标记（需求⑥）
--  原来只有 orders.buyer_deleted（买家删记录只对自己隐藏）。
--  需求⑥ 要求卖家侧也能收尾交易：卖家删除自己的卖出记录时，
--  同样只对卖家隐藏，买家那头不受影响。故加一个对称的字段。
--  幂等脚本：重复执行安全（条件 ALTER）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'orders'
             AND column_name = 'seller_deleted');
SET @sql := IF(@c = 0,
  'ALTER TABLE `orders` ADD COLUMN `seller_deleted` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''卖家侧隐藏该订单记录（与 buyer_deleted 对称）''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
