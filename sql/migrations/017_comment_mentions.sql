-- =============================================================
--  迁移 017：评论里的 @昵称 落库（用户 2026-10-16 提出）
--  目的：把评论内容里出现的 `@某人` 解析成「被 @ 到的用户 id + 当时的昵称」存起来，
--  前端就能把这段文字渲染成**可点的链接**（点一下进 TA 的主页）。
--  覆盖两种评论：帖子评论 post_comments、评价下的评论 review_comments。
--  幂等脚本
--  执行方式： .venv\Scripts\python.exe manage.py migrate
-- =============================================================

SET @db := DATABASE();

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = @db AND table_name = 'post_comments' AND column_name = 'mentions') = 0,
  'ALTER TABLE `post_comments` ADD COLUMN `mentions` JSON NULL COMMENT ''被 @ 到的人：[{id,nickname}]''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = @db AND table_name = 'review_comments' AND column_name = 'mentions') = 0,
  'ALTER TABLE `review_comments` ADD COLUMN `mentions` JSON NULL COMMENT ''被 @ 到的人：[{id,nickname}]''',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
