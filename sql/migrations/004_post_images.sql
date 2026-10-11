-- =============================================================
--  迁移 004：帖子配图（功能⑥）
--  一篇帖子可以带多张图片，顺序由 sort 控制。
--  幂等脚本：重复执行安全（CREATE TABLE IF NOT EXISTS）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

CREATE TABLE IF NOT EXISTS `post_images` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `post_id`    BIGINT UNSIGNED NOT NULL,
  `url`        VARCHAR(255)    NOT NULL                COMMENT '相对于 uploads/ 的文件名',
  `sort`       INT             NOT NULL DEFAULT 0      COMMENT '展示顺序',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_post_images_post` (`post_id`, `sort`),
  CONSTRAINT `fk_post_images_post` FOREIGN KEY (`post_id`) REFERENCES `posts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='帖子配图';
