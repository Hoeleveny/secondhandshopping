-- =============================================================
--  迁移 005：用户头像（功能⑦）
--  users 增加 avatar 列，存上传到 uploads/ 的文件名。
--  幂等脚本：用 information_schema 判断列是否已存在，重复执行安全。
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = 'avatar'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE `users` ADD COLUMN `avatar` VARCHAR(255) NULL COMMENT ''头像文件名（相对 uploads/），功能⑦''',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
