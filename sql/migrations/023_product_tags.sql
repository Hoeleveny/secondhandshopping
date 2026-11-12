-- ================================================================
-- 023 商品标签（2026-10-18 第七批，设计文档 §3.2 的二期改造）
--
-- 为什么：分类/小类/成色是有限枚举，表达不了「毕业出」「宿舍必备」「可小刀」这类语义；
-- 而有标签才能回答「他对哪类标签最感兴趣」，也让召回与搜索更有区分度。
-- 一个商品最多 5 个标签、每个 ≤8 字（接口层校验），这里靠唯一约束兜住重复。
-- 幂等：CREATE TABLE IF NOT EXISTS，可反复执行。
-- ================================================================
CREATE TABLE IF NOT EXISTS product_tags (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  tag VARCHAR(16) NOT NULL COMMENT '标签文本（≤8 字，接口校验）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_tags_product_tag (product_id, tag),
  KEY idx_product_tags_tag (tag),
  CONSTRAINT fk_product_tags_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品标签（自由词，一期先用预设+自定义）';
