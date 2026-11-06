-- ================================================================
-- 021 图片特征表（2026-10-18 需求② 用户「图像感知偏好」）
-- 一张图一行：上传时用 Pillow 统计一次入库，画像展示时直接读。
-- 色彩（warm/light/sat/colorfulness）是按像素**真实统计**；
-- skin / edges 是**启发式近似**（肤色像素占比、边缘密度），界面上要标注"算法近似"。
-- ================================================================
CREATE TABLE IF NOT EXISTS image_features (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  path VARCHAR(255) NOT NULL COMMENT '上传后的文件名（唯一）',
  width INT NOT NULL DEFAULT 0,
  height INT NOT NULL DEFAULT 0,
  aspect FLOAT NOT NULL DEFAULT 0 COMMENT '宽高比',
  warm FLOAT NOT NULL DEFAULT 0 COMMENT '彩色像素里暖色占比 0~1',
  grey FLOAT NOT NULL DEFAULT 0 COMMENT '近灰/黑白像素占比',
  light FLOAT NOT NULL DEFAULT 0 COMMENT '平均明度 0~1',
  sat FLOAT NOT NULL DEFAULT 0 COMMENT '平均饱和度 0~1',
  colorfulness FLOAT NOT NULL DEFAULT 0 COMMENT 'Hasler-Süsstrunk 鲜艳度',
  edges FLOAT NOT NULL DEFAULT 0 COMMENT '边缘密度 0~1（画面简洁/繁复）',
  skin FLOAT NOT NULL DEFAULT 0 COMMENT '肤色像素占比（疑似人像，近似）',
  dominant VARCHAR(32) NOT NULL DEFAULT '' COMMENT '主色名',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_image_features_path (path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='图片特征（画像用）';
