/* ==========================================================================
   需求⑧ 页面状态自动更新（轻量轮询）

   为什么用轮询而不是 WebSocket/SSE：本项目是原生前端 + Flask 开发服务器，
   没有推送基础设施；顶栏红点（30s）、私信未读（20s）、管理后台交易管理（5s）
   本来也都是轮询，这里沿用同一套做法，只是把「多久一次」按页面重要程度来定。

   两个防护：
   - 锚点元素不在页面上就**自动停**（SPA 换页后不会留一串后台请求）；
   - 标签页不可见时跳过本次（切回来会立刻补一次），别在后台空转。
   ========================================================================== */

const timers = new Map();

/**
 * 让某个页面的状态自动更新。
 * @param {string} key      同一页面重复调用会替换旧的定时器
 * @param {string} anchor   该页面常驻的选择器；它消失（=已切走）就停止轮询
 * @param {Function} fn     每次执行的回调（内部自己决定要不要动 DOM）
 * @param {number} interval 间隔毫秒
 */
export function liveUpdate(key, anchor, fn, interval = 10000) {
  stopLive(key);
  const tick = async () => {
    if (!document.querySelector(anchor)) {
      stopLive(key);            // 已经切到别的页面了
      return;
    }
    if (document.hidden) return; // 标签在后台，别空转
    try {
      await fn();
    } catch (err) {
      /* 轮询失败静默：不能因为一次网络抖动就弹提示打扰用户 */
    }
  };
  timers.set(key, setInterval(tick, interval));
  return tick;
}

export function stopLive(key) {
  const id = timers.get(key);
  if (id) {
    clearInterval(id);
    timers.delete(key);
  }
}

export function stopAllLive() {
  timers.forEach((id) => clearInterval(id));
  timers.clear();
}
