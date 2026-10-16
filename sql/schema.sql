-- =============================================================
--  校园二手交易平台 —— 数据库建表脚本
--  数据库：campus_market（MySQL 8 / InnoDB / utf8mb4）
--  共 14 张表
--
--  说明：本脚本与《功能文档 v1.0》第 7.3 节一致，并已落实以下确认修正：
--    1) products.status 增加 'deleted'（软删除，功能文档 7.7 要求）
--    2) reviews 的唯一约束由 UNIQUE(order_id) 改为 UNIQUE(order_id, reviewer_id)
--       （改为买卖双方互评）
--    3) swap_offers 增加 matched_offer_id / matched_at（记录"换给了谁"）
--    4) 注意：condition 是 MySQL 8 保留字，所有语句中必须用反引号包裹
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- 表 1：users（用户）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username`      VARCHAR(50)     NOT NULL                COMMENT '登录名，唯一',
  `nickname`      VARCHAR(50)     NOT NULL                COMMENT '昵称，默认取用户名',
  `password_hash` VARCHAR(255)    NOT NULL                COMMENT 'bcrypt 加密后的密码',
  `role`          ENUM('buyer','seller','admin') NOT NULL DEFAULT 'buyer'
                                                          COMMENT '注册时的初始身份；admin 为管理员，不可切换',
  `credit`        DECIMAL(3,1)    NOT NULL DEFAULT 5.0    COMMENT '信用分（展示用，默认 5.0）',
  `avatar`        VARCHAR(255)    NULL                    COMMENT '头像文件名（相对 uploads/），功能⑦',
  `seller_seq`    INT             NULL                    COMMENT '商品编号的卖家码来源：首次发布商品时惰性分配（迁移 006）',
  `bio`           VARCHAR(100)    NULL                    COMMENT '商家简介：卖家自填、展示在卖家商品主页（需求②，迁移 008）',
  `orders_seen_log_id` BIGINT     NULL                    COMMENT '订单红点已读游标：已看到的最大订单操作日志 id（需求⑥，迁移 011）',
  `banned_until`  DATETIME        NULL                    COMMENT '封禁到什么时候（NULL=未封禁；永久看 ban_forever）（新批需求①，迁移 012）',
  `ban_forever`   TINYINT(1)      NOT NULL DEFAULT 0      COMMENT '是否永久封禁',
  `ban_reason`    VARCHAR(200)    NULL                    COMMENT '封禁原因（会私信告知用户）',
  `banned_at`     DATETIME        NULL                    COMMENT '封禁时间',
  `banned_by`     BIGINT          NULL                    COMMENT '执行封禁的管理员 id',
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`),
  UNIQUE KEY `uk_users_seller_seq` (`seller_seq`),
  KEY `idx_users_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户（买家/卖家/管理员）';

-- -------------------------------------------------------------
-- 表 2：categories（商品大类）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `categories`;
CREATE TABLE `categories` (
  `id`   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50)  NOT NULL          COMMENT '分类名',
  `icon` VARCHAR(10)  NOT NULL DEFAULT '' COMMENT 'emoji 图标',
  `sort` INT          NOT NULL DEFAULT 0  COMMENT '排序，小的在前',
  `code` VARCHAR(2)   NULL                COMMENT '商品编号的大类字母码：TA/DG/LF/SP/OT…（迁移 006，管理员维护）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_categories_name` (`name`),
  UNIQUE KEY `uk_categories_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='商品大类';

-- -------------------------------------------------------------
-- 表 3：subcategories（小类）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `subcategories`;
CREATE TABLE `subcategories` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `category_id` INT UNSIGNED NOT NULL,
  `name`        VARCHAR(50)  NOT NULL,
  `seq_in_category` INT      NULL     COMMENT '商品编号小类段：在大类内的稳定序号（迁移 006）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_subcategories_category_name` (`category_id`, `name`),
  UNIQUE KEY `uk_subcategories_seq` (`category_id`, `seq_in_category`),
  KEY `idx_subcategories_category` (`category_id`),
  CONSTRAINT `fk_subcategories_category` FOREIGN KEY (`category_id`)
      REFERENCES `categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='分类下的细分小类';

-- -------------------------------------------------------------
-- 表 14：campus_places（校园地点库）—— 被 products / orders 引用，故提前创建
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `campus_places`;
CREATE TABLE `campus_places` (
  `id`   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(50)     NOT NULL,
  `type` ENUM('教学楼','图书馆','食堂','宿舍','运动场','其他') NOT NULL DEFAULT '其他',
  `lng`  DECIMAL(10,7)   NOT NULL          COMMENT 'GCJ-02 经度',
  `lat`  DECIMAL(10,7)   NOT NULL          COMMENT 'GCJ-02 纬度',
  `sort` INT             NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_campus_places_name` (`name`),
  KEY `idx_campus_places_type` (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='校园地标库（自提点）';

-- -------------------------------------------------------------
-- 表 4：products（商品）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `products`;
CREATE TABLE `products` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `seller_id`        BIGINT UNSIGNED NOT NULL,
  `category_id`      INT UNSIGNED    NOT NULL,
  `subcategory_id`   INT UNSIGNED    NULL,
  `name`             VARCHAR(100)    NOT NULL,
  `price`            DECIMAL(10,2)   NOT NULL             COMMENT '必须 > 0',
  `condition`        VARCHAR(20)     NOT NULL             COMMENT '成色：全新/九成新/八成新/七成新及以下（保留字，须加反引号）',
  `description`      TEXT            NULL,
  `status`           ENUM('on_sale','sold','off_shelf','deleted') NOT NULL DEFAULT 'on_sale'
                                                          COMMENT '在售/已售/已下架/已删除(deleted=软删除，所有角色不可见)',
  `views`            INT UNSIGNED    NOT NULL DEFAULT 0   COMMENT '浏览量',
  `default_place_id` BIGINT UNSIGNED NULL                 COMMENT '默认自提点',
  `product_code`     VARCHAR(32)     NOT NULL             COMMENT '商品编号：分类码4-卖家码4-日期码6-流水号5，系统生成、永不改变（迁移 006）',
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_code` (`product_code`),
  KEY `idx_products_status_category_price` (`status`, `category_id`, `price`),
  KEY `idx_products_seller` (`seller_id`, `status`),
  KEY `idx_products_subcategory` (`subcategory_id`),
  KEY `idx_products_created` (`created_at`),
  CONSTRAINT `fk_products_seller`      FOREIGN KEY (`seller_id`)        REFERENCES `users` (`id`),
  CONSTRAINT `fk_products_category`    FOREIGN KEY (`category_id`)      REFERENCES `categories` (`id`),
  CONSTRAINT `fk_products_subcategory` FOREIGN KEY (`subcategory_id`)   REFERENCES `subcategories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_place`       FOREIGN KEY (`default_place_id`) REFERENCES `campus_places` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='二手商品';

-- -------------------------------------------------------------
-- 表 5：product_images（商品图片）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `product_images`;
CREATE TABLE `product_images` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `url`        VARCHAR(255)    NOT NULL COMMENT '相对于 uploads/ 的文件名',
  `sort`       INT             NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_product_images_product` (`product_id`, `sort`),
  CONSTRAINT `fk_product_images_product` FOREIGN KEY (`product_id`)
      REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='商品多图';

-- -------------------------------------------------------------
-- 表 11：posts（交流广场帖子）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `posts`;
CREATE TABLE `posts` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `author_id`  BIGINT UNSIGNED NOT NULL,
  `title`      VARCHAR(100)    NOT NULL,
  `content`    TEXT            NOT NULL,
  `tag`        ENUM('安利','避雷','闲聊','求助') NOT NULL DEFAULT '闲聊',
  `status`     ENUM('normal','deleted') NOT NULL DEFAULT 'normal' COMMENT '软删除',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_posts_tag_created` (`tag`, `created_at`),
  KEY `idx_posts_author` (`author_id`),
  CONSTRAINT `fk_posts_author` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='交流广场帖子';

-- -------------------------------------------------------------
-- 表 12：post_comments（帖子评论）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `post_comments`;
CREATE TABLE `post_comments` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `post_id`    BIGINT UNSIGNED NOT NULL,
  `author_id`  BIGINT UNSIGNED NOT NULL,
  `content`    TEXT            NOT NULL,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_post_comments_post` (`post_id`, `created_at`),
  CONSTRAINT `fk_post_comments_post`   FOREIGN KEY (`post_id`)   REFERENCES `posts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_post_comments_author` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='帖子评论';

-- -------------------------------------------------------------
-- 表 13：post_likes（帖子点赞）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `post_likes`;
CREATE TABLE `post_likes` (
  `id`      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `post_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_post_likes_post_user` (`post_id`, `user_id`),
  KEY `idx_post_likes_user` (`user_id`),
  CONSTRAINT `fk_post_likes_post` FOREIGN KEY (`post_id`) REFERENCES `posts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_post_likes_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='帖子点赞';

-- -------------------------------------------------------------
-- 表 6：orders（订单）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `orders`;
CREATE TABLE `orders` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_no`         VARCHAR(32)     NOT NULL COMMENT '唯一订单号',
  `product_id`       BIGINT UNSIGNED NOT NULL,
  `buyer_id`         BIGINT UNSIGNED NOT NULL,
  `seller_id`        BIGINT UNSIGNED NOT NULL COMMENT '冗余，便于查卖出订单',
  `price`            DECIMAL(10,2)   NOT NULL COMMENT '成交价',
  `product_snapshot` JSON            NOT NULL COMMENT '商品快照（名称/图/分类/成色），商品删除后仍可显示',
  `status`           ENUM('awaiting','pending','done','canceled') NOT NULL DEFAULT 'awaiting'
                                     COMMENT '待卖家确认(意向)/待完成/已完成/已取消（迁移 013）',
  `trade_note`       VARCHAR(255)    NULL COMMENT '交易说明',
  `meet_place_id`    BIGINT UNSIGNED NULL COMMENT '约定自提点',
  `buyer_lng`        DECIMAL(10,7)   NULL COMMENT '买家位置 GCJ-02',
  `buyer_lat`        DECIMAL(10,7)   NULL,
  `seller_lng`       DECIMAL(10,7)   NULL COMMENT '卖家位置 GCJ-02',
  `seller_lat`       DECIMAL(10,7)   NULL,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at`      DATETIME        NULL COMMENT '完成时间',
  `buyer_deleted`    TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '买家是否已删除该订单记录（仅买家侧隐藏，功能④）',
  `seller_deleted`   TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '卖家是否已删除该订单记录（仅卖家侧隐藏，需求⑥，迁移 010）',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_orders_order_no` (`order_no`),
  KEY `idx_orders_buyer` (`buyer_id`, `status`),
  KEY `idx_orders_buyer_visible` (`buyer_id`, `buyer_deleted`, `status`),
  KEY `idx_orders_seller` (`seller_id`, `status`),
  KEY `idx_orders_status` (`status`),
  KEY `idx_orders_product` (`product_id`),
  CONSTRAINT `fk_orders_product`   FOREIGN KEY (`product_id`)    REFERENCES `products` (`id`),
  CONSTRAINT `fk_orders_buyer`     FOREIGN KEY (`buyer_id`)      REFERENCES `users` (`id`),
  CONSTRAINT `fk_orders_seller`    FOREIGN KEY (`seller_id`)     REFERENCES `users` (`id`),
  CONSTRAINT `fk_orders_place`     FOREIGN KEY (`meet_place_id`) REFERENCES `campus_places` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单';

-- -------------------------------------------------------------
-- 表 7：favorites（收藏）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `favorites`;
CREATE TABLE `favorites` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_favorites_user_product` (`user_id`, `product_id`),
  KEY `idx_favorites_product` (`product_id`),
  CONSTRAINT `fk_favorites_user`    FOREIGN KEY (`user_id`)    REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_favorites_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='收藏（多对多）';

-- -------------------------------------------------------------
-- 表 8：reviews（评价）—— 双向互评
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `reviews`;
CREATE TABLE `reviews` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`    BIGINT UNSIGNED NOT NULL,
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `reviewer_id` BIGINT UNSIGNED NOT NULL COMMENT '评价人（买家或卖家）',
  `reviewee_id` BIGINT UNSIGNED NOT NULL COMMENT '被评价人（交易对方）',
  `rating`      TINYINT UNSIGNED NOT NULL COMMENT '1-5 星',
  `content`     TEXT            NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_reviews_order_reviewer` (`order_id`, `reviewer_id`) COMMENT '每方对一笔订单只能评价一次',
  KEY `idx_reviews_product` (`product_id`),
  KEY `idx_reviews_reviewee` (`reviewee_id`),
  CONSTRAINT `fk_reviews_order`    FOREIGN KEY (`order_id`)    REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reviews_product`  FOREIGN KEY (`product_id`)  REFERENCES `products` (`id`),
  CONSTRAINT `fk_reviews_reviewer` FOREIGN KEY (`reviewer_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_reviews_reviewee` FOREIGN KEY (`reviewee_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='交易评价（双向互评）';

-- -------------------------------------------------------------
-- 表 9：reports（举报）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `reports`;
CREATE TABLE `reports` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`  BIGINT UNSIGNED NULL COMMENT '举报商品时非空',
  `post_id`     BIGINT UNSIGNED NULL COMMENT '举报帖子时非空',
  `review_id`   BIGINT UNSIGNED NULL COMMENT '举报评价时非空（迁移 015）',
  `comment_id`  BIGINT UNSIGNED NULL COMMENT '举报帖子评论时非空（迁移 015）',
  `review_comment_id` BIGINT UNSIGNED NULL COMMENT '举报评价评论时非空（迁移 015）',
  `reporter_id` BIGINT UNSIGNED NOT NULL,
  `reason`      VARCHAR(200)    NOT NULL,
  `status`      ENUM('pending','handled','dismissed') NOT NULL DEFAULT 'pending'
                                COMMENT '待处理/已处理/驳回',
  `handled_by`  BIGINT UNSIGNED NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `handled_at`  DATETIME        NULL,
  PRIMARY KEY (`id`),
  KEY `idx_reports_status_created` (`status`, `created_at`),
  KEY `idx_reports_product` (`product_id`),
  KEY `idx_reports_post` (`post_id`),
  KEY `idx_reports_review` (`review_id`),
  KEY `idx_reports_comment` (`comment_id`),
  KEY `idx_reports_review_comment` (`review_comment_id`),
  CONSTRAINT `fk_reports_product`  FOREIGN KEY (`product_id`)  REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reports_post`     FOREIGN KEY (`post_id`)     REFERENCES `posts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reports_review`   FOREIGN KEY (`review_id`)   REFERENCES `reviews` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_comment`  FOREIGN KEY (`comment_id`)  REFERENCES `post_comments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_review_comment` FOREIGN KEY (`review_comment_id`) REFERENCES `review_comments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reports_reporter` FOREIGN KEY (`reporter_id`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_reports_handler`  FOREIGN KEY (`handled_by`)  REFERENCES `users` (`id`) ON DELETE SET NULL
  -- 注意：这里原本有一条 ck_reports_target CHECK，迁移 015 已把它去掉——
  -- MySQL 不允许 CHECK 里引用的列同时带 ON DELETE SET NULL 的外键动作（3823），
  -- 而 SET NULL 才是必需的（评论被删时不能让外键挡住）。目标合法性由接口层校验。
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='违规举报';

-- -------------------------------------------------------------
-- 表 9b：review_comments（评价下的评论 · 新批需求⑤）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `review_comments`;
CREATE TABLE `review_comments` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_id`  BIGINT UNSIGNED NOT NULL            COMMENT '所属评价',
  `author_id`  BIGINT UNSIGNED NOT NULL            COMMENT '评论人',
  `content`    TEXT            NOT NULL            COMMENT '评论内容（可含 @昵称 引用）',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_review_comments_review` (`review_id`, `created_at`),
  CONSTRAINT `fk_review_comments_review` FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_comments_author` FOREIGN KEY (`author_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评价下的评论（需求⑤）';

-- -------------------------------------------------------------
-- 表 10：swap_offers（以物换物）
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `swap_offers`;
CREATE TABLE `swap_offers` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`          BIGINT UNSIGNED NOT NULL COMMENT '发起者',
  `product_id`       BIGINT UNSIGNED NOT NULL COMMENT '用自己的哪件商品来换',
  `title`            VARCHAR(100)    NOT NULL,
  `estimate_price`   DECIMAL(10,2)   NOT NULL COMMENT '估价，用于 ±20% 匹配',
  `status`           ENUM('open','matched','closed') NOT NULL DEFAULT 'open'
                                     COMMENT '进行中/已匹配/已关闭',
  `matched_offer_id` BIGINT UNSIGNED NULL COMMENT '换给了谁：对方的 swap_offers.id（发起交换即双向标记）',
  `matched_at`       DATETIME        NULL,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_swap_offers_status_price` (`status`, `estimate_price`),
  KEY `idx_swap_offers_user` (`user_id`),
  KEY `idx_swap_offers_product` (`product_id`),
  KEY `idx_swap_offers_matched` (`matched_offer_id`),
  CONSTRAINT `fk_swap_offers_user`    FOREIGN KEY (`user_id`)          REFERENCES `users` (`id`),
  CONSTRAINT `fk_swap_offers_product` FOREIGN KEY (`product_id`)       REFERENCES `products` (`id`),
  CONSTRAINT `fk_swap_offers_matched` FOREIGN KEY (`matched_offer_id`) REFERENCES `swap_offers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='以物换物';

-- -------------------------------------------------------------
-- 表 15：messages（私信消息）—— 功能①，新增于迁移 001
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `messages`;
CREATE TABLE `messages` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sender_id`   BIGINT UNSIGNED NOT NULL                COMMENT '发信人',
  `receiver_id` BIGINT UNSIGNED NOT NULL                COMMENT '收信人',
  `product_id`  BIGINT UNSIGNED NULL                    COMMENT '针对哪件商品聊的，可空',
  `kind`        VARCHAR(10)     NOT NULL DEFAULT 'text' COMMENT 'text=普通文字 / product=商品卡片（迁移 014）',
  `product_snapshot` JSON       NULL                    COMMENT '商品卡片快照，商品删了卡片仍能显示（迁移 014）',
  `content`     VARCHAR(1000)   NOT NULL                COMMENT '消息内容',
  `is_read`     TINYINT(1)      NOT NULL DEFAULT 0      COMMENT '收信人是否已读',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_messages_receiver` (`receiver_id`, `is_read`, `created_at`),
  KEY `idx_messages_sender`   (`sender_id`, `created_at`),
  KEY `idx_messages_pair`     (`sender_id`, `receiver_id`, `created_at`),
  KEY `idx_messages_product`  (`product_id`),
  CONSTRAINT `fk_messages_sender`   FOREIGN KEY (`sender_id`)   REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_receiver` FOREIGN KEY (`receiver_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_product`  FOREIGN KEY (`product_id`)  REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='私信消息';

-- -------------------------------------------------------------
-- 表 16：product_wants（我想要）—— 功能③，新增于迁移 002
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `product_wants`;
CREATE TABLE `product_wants` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT UNSIGNED NOT NULL                COMMENT '点「我想要」的用户',
  `product_id` BIGINT UNSIGNED NOT NULL                COMMENT '被想要的商品',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_product_wants_user_product` (`user_id`, `product_id`),
  KEY `idx_product_wants_product` (`product_id`),
  CONSTRAINT `fk_product_wants_user`    FOREIGN KEY (`user_id`)    REFERENCES `users` (`id`)    ON DELETE CASCADE,
  CONSTRAINT `fk_product_wants_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='我想要（商品收藏意愿）';

-- -------------------------------------------------------------
-- 表 17：post_images（帖子配图）—— 功能⑥，新增于迁移 004
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `post_images`;
CREATE TABLE `post_images` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `post_id`    BIGINT UNSIGNED NOT NULL,
  `url`        VARCHAR(255)    NOT NULL                COMMENT '相对于 uploads/ 的文件名',
  `sort`       INT             NOT NULL DEFAULT 0      COMMENT '展示顺序',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_post_images_post` (`post_id`, `sort`),
  CONSTRAINT `fk_post_images_post` FOREIGN KEY (`post_id`) REFERENCES `posts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='帖子配图';

-- -------------------------------------------------------------
-- 表 18：operation_logs（操作日志）—— 需求①，新增于迁移 007
-- 记录「谁 · 何时 · 对哪个对象 · 做了什么」，供管理后台动态监控
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `operation_logs`;
CREATE TABLE `operation_logs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`     BIGINT UNSIGNED NULL                    COMMENT '操作人（用户注销后置空，日志保留）',
  `username`    VARCHAR(50)     NOT NULL DEFAULT ''     COMMENT '操作人用户名快照',
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

-- -------------------------------------------------------------
-- 表 19：message_clears（会话清除标记）—— 需求⑤，新增于迁移 009
-- 「删除对话」只对我隐藏：id <= last_message_id 的消息对 user_id 隐藏
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `message_clears`;
CREATE TABLE `message_clears` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id`         BIGINT UNSIGNED NOT NULL COMMENT '谁清空了这段对话',
  `peer_id`         BIGINT UNSIGNED NOT NULL COMMENT '跟谁的对话',
  `last_message_id` BIGINT UNSIGNED NOT NULL COMMENT '清空到这条为止：id <= 它的消息对 user_id 隐藏',
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_message_clears_pair` (`user_id`, `peer_id`),
  KEY `idx_message_clears_peer` (`peer_id`),
  CONSTRAINT `fk_message_clears_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_message_clears_peer` FOREIGN KEY (`peer_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='会话清除标记（只对清空者自己隐藏）';

-- -------------------------------------------------------------
-- 表 20/21：follows / blocks（关注与拉黑）—— 新批需求⑦，新增于迁移 016
-- 都是单向关系；拉黑后「我这边看不到对方的商品与评论」且「对方不能给我发私信」
-- -------------------------------------------------------------
DROP TABLE IF EXISTS `follows`;
CREATE TABLE `follows` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `follower_id` BIGINT UNSIGNED NOT NULL COMMENT '关注发起人',
  `followee_id` BIGINT UNSIGNED NOT NULL COMMENT '被关注的人',
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_follows_pair` (`follower_id`, `followee_id`),
  KEY `idx_follows_followee` (`followee_id`),
  CONSTRAINT `fk_follows_follower` FOREIGN KEY (`follower_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_follows_followee` FOREIGN KEY (`followee_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='关注（单向，需求⑦）';

DROP TABLE IF EXISTS `blocks`;
CREATE TABLE `blocks` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `blocker_id` BIGINT UNSIGNED NOT NULL COMMENT '拉黑别人的人',
  `blocked_id` BIGINT UNSIGNED NOT NULL COMMENT '被拉黑的人',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_blocks_pair` (`blocker_id`, `blocked_id`),
  KEY `idx_blocks_blocked` (`blocked_id`),
  CONSTRAINT `fk_blocks_blocker` FOREIGN KEY (`blocker_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_blocks_blocked` FOREIGN KEY (`blocked_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='拉黑（单向，需求⑦）';

SET FOREIGN_KEY_CHECKS = 1;
