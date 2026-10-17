-- =============================================================
--  迁移 018：私信支持「单条消息」删除（只对我隐藏）+ 标记已读/未读（用户 2026-10-17 提出）
--  覆盖 22 → 23 张表
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @db := DATABASE();

-- 1) 我对某条消息的隐藏（删掉这条只影响我自己，对方完全不受影响——与「删除会话」同一口径）
CREATE TABLE IF NOT EXISTS `message_hides` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL COMMENT '谁把它删掉的（只有这个人看不到）',
  `message_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_message_hides` (`user_id`, `message_id`),
  KEY `idx_message_hides_user` (`user_id`),
  CONSTRAINT `fk_message_hides_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_message_hides_message`
    FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='我对单条私信的隐藏（只对我隐藏）';

-- 2) 手动「标为未读」的消息，进聊天框时不要被自动置回已读
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = @db AND table_name = 'messages' AND column_name = 'keep_unread') = 0,
  'ALTER TABLE `messages` ADD COLUMN `keep_unread` TINYINT(1) NOT NULL DEFAULT 0 COMMENT ''手动标为未读：进聊天框的自动置已读会跳过它''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
