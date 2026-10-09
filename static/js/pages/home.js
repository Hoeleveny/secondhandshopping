/* ==========================================================================
   M02 首页：分类快捷入口 + 最新上架 + 身份快捷入口
   ========================================================================== */
import { api } from '../api.js';
import { esc, emptyHtml } from '../ui.js';
import { bindProductCards, productCardHtml } from '../components.js';

const QUICK = {
  guest: [
    { icon: '🔍', label: '搜索与筛选', hash: '#/search', desc: '多条件找物品' },
    { icon: '📊', label: '比价行情', hash: '#/compare', desc: '看同类价格' },
    { icon: '💬', label: '交流广场', hash: '#/posts', desc: '安利 / 避雷 / 求助' },
    { icon: '🔑', label: '登录 / 注册', hash: '#/login', desc: '解锁下单与发布' },
  ],
  buyer: [
    { icon: '📦', label: '我的订单', hash: '#/orders', desc: '查看与确认' },
    { icon: '⭐', label: '我的收藏', hash: '#/favorites', desc: '收藏的物品' },
    { icon: '🔄', label: '以物换物', hash: '#/swaps', desc: '拿闲置换闲置' },
    { icon: '💬', label: '交流广场', hash: '#/posts', desc: '校园讨论' },
  ],
  seller: [
    { icon: '➕', label: '发布商品', hash: '#/publish', desc: '上架闲置' },
    { icon: '🗂️', label: '我的商品', hash: '#/my-products', desc: '编辑 / 上下架' },
    { icon: '📤', label: '卖出订单', hash: '#/sold', desc: '谁买了我的东西' },
    { icon: '🔄', label: '以物换物', hash: '#/swaps', desc: '换物广场' },
  ],
  admin: [
    { icon: '⚙️', label: '管理后台', hash: '#/admin', desc: '商品 / 举报 / 基础数据' },
    { icon: '📈', label: '数据看板', hash: '#/dashboard', desc: '经营统计' },
    { icon: '💬', label: '交流广场', hash: '#/posts', desc: '可删任意帖' },
    { icon: '🔍', label: '搜索与筛选', hash: '#/search', desc: '按条件查商品' },
  ],
};

export default {
  async render(root, ctx) {
    const data = await api.get('/api/home');
    const quick = QUICK[ctx.view] || QUICK.guest;

    const cats = data.categories.map(c => `
      <div class="cat-card" data-cat="${c.id}">
        <span class="cc-icon">${esc(c.icon || '📦')}</span>
        <div class="cc-name">${esc(c.name)}</div>
      </div>`).join('');

    const newest = data.newest.length
      ? data.newest.map(productCardHtml).join('')
      : emptyHtml('还没有在售的商品，去发布一件吧', '🫙');

    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>分类快捷入口</h2>
          <span class="muted small">当前在售 ${data.stats.on_sale} 件 · 已成交 ${data.stats.sold} 件</span>
        </div>
        <div class="cat-strip">${cats}</div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>最新上架</h2>
          <button class="btn btn-sm" data-go="#/search">查看全部 ›</button>
        </div>
        <div class="grid-cards">${newest}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>快捷入口</h2></div>
        <div class="grid grid-4">
          ${quick.map(q => `
            <button class="btn" data-go="${q.hash}"
                    style="flex-direction:column;align-items:flex-start;gap:2px;padding:14px 16px;text-align:left">
              <span style="font-size:20px">${q.icon}</span>
              <span class="strong">${esc(q.label)}</span>
              <span class="muted small">${esc(q.desc)}</span>
            </button>`).join('')}
        </div>
      </div>`;

    bindProductCards(root);
    root.querySelectorAll('[data-go]').forEach(el =>
      el.addEventListener('click', () => { location.hash = el.dataset.go; }));
    root.querySelectorAll('[data-cat]').forEach(el =>
      el.addEventListener('click', () => { location.hash = `#/search?category_id=${el.dataset.cat}`; }));
  },
};
