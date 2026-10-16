-- =============================================================
--  迁移 016：关注 / 拉黑（新批需求⑦）
--  口径（用户拍板）：
--   - 拉黑是**单向**的：我拉黑 TA 之后，**我这边看不到 TA 的商品与评论**，
--     并且 **TA 不能给我发私信**；但 TA 仍能看到我、也能下单（交易不受影响）。
--   - 关注是**单向**的，主页显示「关注 / 粉丝」数，关注时给对方发一条平台私信通知。
--  幂等脚本
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

CREATE TABLE IF NOT EXISTS `follows` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `follower_id` BIGINT UNSIGNED NOT NULL COMMENT '关注发起人',
  `followee_id` BIGINT UNSIGNED NOT NULL COMMENT '被关注的人',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_follows_pair` (`follower_id`, `followee_id`),
  KEY `idx_follows_followee` (`followee_id`),
  CONSTRAINT `fk_follows_follower` FOREIGN KEY (`follower_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_follows_followee` FOREIGN KEY (`followee_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='关注（单向，需求⑦）';

CREATE TABLE IF NOT EXISTS `blocks` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `blocker_id` BIGINT UNSIGNED NOT NULL COMMENT '拉黑别人的人',
  `blocked_id` BIGINT UNSIGNED NOT NULL COMMENT '被拉黑的人',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_blocks_pair` (`blocker_id`, `blocked_id`),
  KEY `idx_blocks_blocked` (`blocked_id`),
  CONSTRAINT `fk_blocks_blocker` FOREIGN KEY (`blocker_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_blocks_blocked` FOREIGN KEY (`blocked_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='拉黑（单向，需求⑦）';
