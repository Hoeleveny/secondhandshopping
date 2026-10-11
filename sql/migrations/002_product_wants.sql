-- =============================================================
--  迁移 002：我想要（功能③）
--  记录谁对哪件商品点了「我想要」；一个用户对同一件商品只有一条记录。
--  幂等脚本：重复执行安全（CREATE TABLE IF NOT EXISTS）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

CREATE TABLE IF NOT EXISTS `product_wants` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL                COMMENT '点「我想要」的用户',
  `product_id` BIGINT UNSIGNED NOT NULL                COMMENT '被想要的商品',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_wants_user_product` (`user_id`, `product_id`),
  KEY `idx_product_wants_product` (`product_id`),
  CONSTRAINT `fk_product_wants_user`    FOREIGN KEY (`user_id`)    REFERENCES `users` (`id`)    ON DELETE CASCADE,
  CONSTRAINT `fk_product_wants_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='我想要（商品收藏意愿）';
