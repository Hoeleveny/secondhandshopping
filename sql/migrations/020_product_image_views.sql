-- =============================================================
--  迁移 020：product_image_views（商品图片级浏览行为）
--  2026-10-18 需求：用户画像要做多维度综合分析，其中一维是「对特定商品图片的偏好」
--  记录：看了哪个商品的第几张图、主图停留多久 → 汇总成"头图党 / 细节党"
--  23 → 24 张表
--  幂等脚本
-- =============================================================

CREATE TABLE IF NOT EXISTS `product_image_views` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL              COMMENT '浏览者',
  `product_id` BIGINT UNSIGNED NOT NULL              COMMENT '商品',
  `image_index` INT UNSIGNED   NOT NULL DEFAULT 0    COMMENT '第几张图（0=头图）',
  `dwell_ms`   INT UNSIGNED   NOT NULL DEFAULT 0     COMMENT '这张图停留毫秒（前端计时）',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_imgviews_user` (`user_id`, `created_at`),
  KEY `idx_imgviews_product` (`product_id`),
  CONSTRAINT `fk_imgviews_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_imgviews_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='商品图片级浏览行为（画像：图片偏好维度）';
