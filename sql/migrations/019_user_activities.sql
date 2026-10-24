-- =============================================================
--  迁移 019：user_activities（用户行为监测）—— 用户 2026-10-18 提出
--  记录「谁 · 何时 · 登录 / 登出 / 浏览了哪个页面 · 从哪来」，供使用习惯画像分析
--  22 → 23 张表
--  幂等脚本
-- =============================================================

SET @db := DATABASE();

CREATE TABLE IF NOT EXISTS `user_activities` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL                COMMENT '行为主体',
  `kind`       ENUM('login','logout','page') NOT NULL  COMMENT '登录 / 登出 / 页面浏览',
  `page`       VARCHAR(60)     NOT NULL DEFAULT ''     COMMENT '路由路径，如 /search、/product/12',
  `page_name`  VARCHAR(40)     NOT NULL DEFAULT ''     COMMENT '页面中文名，如「搜索与筛选」',
  `ip`         VARCHAR(45)     NOT NULL DEFAULT ''     COMMENT '客户端 IP（IPv6 最长 45）',
  `user_agent` VARCHAR(200)    NOT NULL DEFAULT ''     COMMENT '浏览器 UA（截断到 200 字）',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_activities_user` (`user_id`, `created_at`),
  KEY `idx_activities_kind` (`kind`, `created_at`),
  KEY `idx_activities_page` (`page`, `created_at`),
  CONSTRAINT `fk_activities_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='用户行为监测（登录/登出/页面浏览）';
