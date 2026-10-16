-- =============================================================
--  迁移 011：订单红点的「已读游标」（新批需求⑥）
--  需求：订单出现新状态（买家下单、卖家确认/取消等）时，
--        「我的订单」入口处显示数字小红点；打开订单页后清零。
--  实现：每个用户记住「已经看到哪一条订单操作日志」，
--        之后 != 自己的、发生在自己订单上的新日志即为未读数。
--  幂等脚本：重复执行安全（条件 ALTER）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'users'
             AND column_name = 'orders_seen_log_id');
SET @sql := IF(@c = 0,
  'ALTER TABLE `users` ADD COLUMN `orders_seen_log_id` BIGINT NULL COMMENT ''订单红点已读游标：已看到的最大订单操作日志 id（需求⑥）''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
