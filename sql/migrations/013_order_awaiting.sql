-- =============================================================
--  迁移 013：订单状态新增「待卖家确认」（新批需求③）
--  口径（用户拍板）：买家下单只是「购买意向」，商品**仍在售、别人也能下单**；
--  卖家确认其中一个后，那一单才转「待完成」并锁定商品（变已售），
--  同一商品上其余意向自动取消并私信告知买家。
--  orders.status 是 ENUM，所以必须改枚举定义。
--  幂等脚本：直接 MODIFY（重复执行结果一致）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

ALTER TABLE `orders`
  MODIFY COLUMN `status` ENUM('awaiting','pending','done','canceled')
  NOT NULL DEFAULT 'awaiting' COMMENT 'awaiting=待卖家确认（意向）/ pending=待完成 / done=已完成 / canceled=已取消';
