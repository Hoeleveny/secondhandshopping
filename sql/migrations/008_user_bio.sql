-- =============================================================
--  迁移 008：商家简介（需求② 卖家商品主页用）
--  卖家在「个人资料」页自己填写、自己决定展示什么，可留空。
--  幂等脚本：重复执行安全（条件 ALTER）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'bio');
SET @sql := IF(@c = 0,
  'ALTER TABLE `users` ADD COLUMN `bio` VARCHAR(100) NULL COMMENT ''商家简介：卖家在个人资料页自填，最多 100 字，可留空''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
