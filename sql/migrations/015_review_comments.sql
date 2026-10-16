-- =============================================================
--  迁移 015：评价下的评论 + 举报对象扩展（新批需求⑤）
--  口径（用户拍板）：
--   - 交流广场的帖子评论、以及**商品评价下面的评论**，都可以「引用(@用户名)」与「举报」；
--   - 评价下**新增一层评论**（新表 review_comments）；
--   - 「引用(@用户名)」＝内容里带 `@昵称 `（点「回复」自动填），不需要额外字段；
--   - 举报对象在「商品 / 帖子」之外扩展为「评价 / 帖子评论 / 评价评论」。
--  幂等脚本
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

CREATE TABLE IF NOT EXISTS `review_comments` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_id`  BIGINT UNSIGNED NOT NULL            COMMENT '所属评价',
  `author_id`  BIGINT UNSIGNED NOT NULL            COMMENT '评论人',
  `content`    TEXT            NOT NULL            COMMENT '评论内容（可含 @昵称 引用）',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_review_comments_review` (`review_id`, `created_at`),
  CONSTRAINT `fk_review_comments_review` FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_comments_author` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='评价下的评论（需求⑤）';

SET @db := DATABASE();

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = @db AND table_name = 'reports' AND column_name = 'review_id') = 0,
  'ALTER TABLE `reports` ADD COLUMN `review_id` BIGINT UNSIGNED NULL COMMENT ''被举报的评价（需求⑤）'', ADD CONSTRAINT `fk_reports_review` FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = @db AND table_name = 'reports' AND column_name = 'comment_id') = 0,
  'ALTER TABLE `reports` ADD COLUMN `comment_id` BIGINT UNSIGNED NULL COMMENT ''被举报的帖子评论（需求⑤）'', ADD CONSTRAINT `fk_reports_comment` FOREIGN KEY (`comment_id`) REFERENCES `post_comments` (`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = @db AND table_name = 'reports' AND column_name = 'review_comment_id') = 0,
  'ALTER TABLE `reports` ADD COLUMN `review_comment_id` BIGINT UNSIGNED NULL COMMENT ''被举报的评价评论（需求⑤）'', ADD CONSTRAINT `fk_reports_review_comment` FOREIGN KEY (`review_comment_id`) REFERENCES `review_comments` (`id`) ON DELETE SET NULL',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ⚠️ 老的 CHECK 约束只认「商品 / 帖子」两个对象，不对它动手的话，
-- 举报评价或评论会因为违反约束直接插不进去。
-- 但**不能重建**它：MySQL 不允许「CHECK 里用到的列」同时出现在带
-- `ON DELETE SET NULL` 的外键里（报 3823），而那几个 SET NULL 才是有用的
-- （评论被删掉时举报记录不该被外键挡住）。所以这里直接去掉 CHECK，
-- 目标合法性交给接口层校验。
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.table_constraints
    WHERE table_schema = @db AND table_name = 'reports'
      AND constraint_name = 'ck_reports_target') > 0,
  'ALTER TABLE `reports` DROP CHECK `ck_reports_target`',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
