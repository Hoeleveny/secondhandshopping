-- =============================================================
--  迁移 012：用户封禁（新批需求①）
--  管理员可在「用户管理」里封禁用户：可选时长（1/3/7/30 天或永久）并填原因。
--  口径（用户拍板）：全面封禁——封禁期间**不能登录**，旧的登录态也被接口层拦住
--  写操作（发布/下单/私信/评价/发帖全拒），**浏览仍可**；**到期自动解封**，
--  管理员也可以提前手动解封。
--  幂等脚本：重复执行安全（条件 ALTER）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @c := (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = 'users'
             AND column_name = 'banned_until');
SET @sql := IF(@c = 0,
  'ALTER TABLE `users`
     ADD COLUMN `banned_until` DATETIME NULL COMMENT ''封禁到什么时候（NULL 表示未封禁；永久封禁看 ban_forever）'',
     ADD COLUMN `ban_forever` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''是否永久封禁'',
     ADD COLUMN `ban_reason` VARCHAR(200) NULL COMMENT ''封禁原因（会私信告知用户）'',
     ADD COLUMN `banned_at` DATETIME NULL COMMENT ''封禁时间'',
     ADD COLUMN `banned_by` BIGINT NULL COMMENT ''执行封禁的管理员 id''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
