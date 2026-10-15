-- =============================================================
--  迁移 009：会话清除标记（需求⑤ 私信删除会话）
--  口径：**只对我隐藏**——我从会话列表移除、我这边历史自删除时刻重新计，
--        对方完全不受影响、仍能看到全部聊天；对方再发新消息时会话重新出现。
--  用「最后一条消息 id」而不是时间戳：消息 id 单调递增，
--  不会出现「对方的新消息恰好和删除同一秒、被一起隐藏」的边界问题。
--  幂等脚本：重复执行安全（CREATE TABLE IF NOT EXISTS）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

CREATE TABLE IF NOT EXISTS `message_clears` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`         BIGINT UNSIGNED NOT NULL COMMENT '谁清空了这段对话',
  `peer_id`         BIGINT UNSIGNED NOT NULL COMMENT '跟谁的对话',
  `last_message_id` BIGINT UNSIGNED NOT NULL COMMENT '清空到这条为止：id <= 它的消息对 user_id 隐藏',
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_message_clears_pair` (`user_id`, `peer_id`),
  KEY `idx_message_clears_peer` (`peer_id`),
  CONSTRAINT `fk_message_clears_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_message_clears_peer` FOREIGN KEY (`peer_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话清除标记（只对清空者自己隐藏）';
