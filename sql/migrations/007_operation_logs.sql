-- =============================================================
--  迁移 007：操作日志（管理员「交易管理 / 动态监控」的数据来源）
--  目的：记录「谁 · 何时 · 对哪个对象 · 做了什么」，让管理员看得到
--        多商家同时编辑、多项交易并发等实时动态（这些信息无法只靠
--        products.updated_at 反推——那只能看出"最后一次被改的时间"）。
--  幂等脚本：重复执行安全（CREATE TABLE IF NOT EXISTS）
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

CREATE TABLE IF NOT EXISTS `operation_logs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NULL                    COMMENT '操作人（用户注销后置空，日志保留）',
  `username`    VARCHAR(50)     NOT NULL DEFAULT ''     COMMENT '操作人用户名快照（便于日志独立可读）',
  `role`        VARCHAR(20)     NOT NULL DEFAULT ''     COMMENT '操作时的身份：buyer/seller/admin',
  `action`      VARCHAR(30)     NOT NULL                COMMENT '动作码，如 product_create / order_cancel',
  `target_type` VARCHAR(20)     NOT NULL DEFAULT ''     COMMENT '对象类型：product/order/report/review',
  `target_id`   BIGINT UNSIGNED NULL                    COMMENT '对象 id',
  `summary`     VARCHAR(255)    NOT NULL DEFAULT ''     COMMENT '人话摘要，供时间线直接展示',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_oplogs_created` (`created_at`),
  KEY `idx_oplogs_action`  (`action`, `created_at`),
  KEY `idx_oplogs_user`    (`user_id`, `created_at`),
  KEY `idx_oplogs_target`  (`target_type`, `target_id`),
  CONSTRAINT `fk_oplogs_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='操作日志（管理后台动态监控用）';
