-- =============================================================
--  迁移 014：私信里的「商品详情卡片」（新批需求④）
--  口径（用户拍板）：发出去的是**可点击的商品卡片**，点一下跳商品详情。
--  做法：
--   - `kind`：区分「商品卡片」与「普通文字」（带商品上下文的文字消息不能被卡片顶掉，
--     否则用户自己打的那句话会消失）；
--   - `product_snapshot`：发卡片那一刻冻结一份商品信息，
--     商品之后被下架、软删、乃至彻底删除，卡片都还显示得出来（沿用订单快照的思路）。
--  幂等脚本：columns 里已有该列就跳过
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @db := DATABASE();

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = @db AND table_name = 'messages' AND column_name = 'kind') = 0,
  'ALTER TABLE `messages` ADD COLUMN `kind` VARCHAR(10) NOT NULL DEFAULT ''text'' COMMENT ''text=普通文字 / product=商品卡片（需求④）''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = @db AND table_name = 'messages' AND column_name = 'product_snapshot') = 0,
  'ALTER TABLE `messages` ADD COLUMN `product_snapshot` JSON NULL COMMENT ''商品卡片快照（需求④）''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
