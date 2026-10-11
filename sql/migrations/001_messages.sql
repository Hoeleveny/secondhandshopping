-- =============================================================
--  迁移 001：私信消息（功能①）
--  幂等脚本：重复执行安全（CREATE TABLE IF NOT EXISTS）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

CREATE TABLE IF NOT EXISTS `messages` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sender_id`   BIGINT UNSIGNED NOT NULL                COMMENT '发信人',
  `receiver_id` BIGINT UNSIGNED NOT NULL                COMMENT '收信人',
  `product_id`  BIGINT UNSIGNED NULL                    COMMENT '针对哪件商品聊的，可空',
  `content`     VARCHAR(1000)   NOT NULL                COMMENT '消息内容',
  `is_read`     TINYINT(1)      NOT NULL DEFAULT 0      COMMENT '收信人是否已读',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_messages_receiver` (`receiver_id`, `is_read`, `created_at`),
  KEY `idx_messages_sender`   (`sender_id`, `created_at`),
  KEY `idx_messages_pair`     (`sender_id`, `receiver_id`, `created_at`),
  KEY `idx_messages_product`  (`product_id`),
  CONSTRAINT `fk_messages_sender`   FOREIGN KEY (`sender_id`)   REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_receiver` FOREIGN KEY (`receiver_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_product`  FOREIGN KEY (`product_id`)  REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='私信消息';
