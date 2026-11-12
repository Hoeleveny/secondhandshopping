-- ================================================================
-- 022 图片级事件 + 结局动作落图（2026-10-18 第五批 P0 埋点）
--
-- 为什么：现有 product_image_views 只记了"看了第几张 + 停留多久"，缺三样东西：
--   ① **曝光**：列表卡片图 / 详情缩略图被看到但没点 → 分不清"不感兴趣"和"没被看到"；
--   ② **负反馈**：秒退、滑过没有记录 → 排序模型没有负样本；
--   ③ **结局动作落图**：收藏/下单时他停在第几张图 → "成交回推"只能到商品级，不能到图。
--
-- 本迁移：新增 image_events，并给 favorites / orders 各加 image_index（默认 0 = 头图）。
-- 幂等：CREATE TABLE IF NOT EXISTS；加列用 information_schema 判断后再 PREPARE 执行，
-- 反复跑不会报 "Duplicate column"（MySQL 8 不支持 ADD COLUMN IF NOT EXISTS）。
-- ================================================================
CREATE TABLE IF NOT EXISTS image_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  image_index INT NOT NULL DEFAULT 0 COMMENT '第几张图（0 = 头图）',
  event ENUM('exposure', 'view', 'convert') NOT NULL COMMENT '曝光 / 查看 / 结局动作',
  dwell_ms INT NOT NULL DEFAULT 0 COMMENT '停留毫秒（曝光可为 0）',
  source VARCHAR(16) NOT NULL DEFAULT '' COMMENT '来源：list / detail / fav / order',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_image_events_user_time (user_id, created_at),
  KEY idx_image_events_product (product_id, event),
  CONSTRAINT fk_image_events_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_image_events_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='图片级事件：曝光 / 查看 / 结局动作';

SET @sql = (SELECT IF(
  COUNT(*) = 0,
  'ALTER TABLE favorites ADD COLUMN image_index INT NOT NULL DEFAULT 0 COMMENT ''收藏时停留的图片序号''',
  'SELECT 1'
) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'favorites' AND column_name = 'image_index');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(
  COUNT(*) = 0,
  'ALTER TABLE orders ADD COLUMN image_index INT NOT NULL DEFAULT 0 COMMENT ''下单时停留的图片序号''',
  'SELECT 1'
) FROM information_schema.columns
 WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'image_index');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
