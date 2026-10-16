/* ==========================================================================
   M06 我的订单（需求④：买家 / 卖家合并成一个页面）
   ========================================================================== */
import { api, qs } from '../api.js';
import { orderCardHtml } from '../components.js';
import {
  confirmDialog, emptyHtml, go, openModal, renderPagination, starPicker, toast,
} from '../ui.js';

const SIDE_TABS = [
  { key: 'all', label: '全部订单' },
  { key: 'buyer', label: '我买到的' },
  { key: 'seller', label: '我卖出的' },
];

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待完成' },
  { key: 'done', label: '已完成' },
  { key: 'canceled', label: '已取消' },
];

const EMPTY_TEXT = {
  all: '还没有任何订单',
  buyer: '你还没有买过东西',
  seller: '还没有人买你的商品',
};

export default {
  async render(root, ctx) {
    // 需求④：买家订单页与卖出订单页合并。
    // 老路由 #/sold 继续可用，只是默认落在「我卖出的」，老链接/书签不会失效。
    const legacySold = ctx.path === '/sold';
    let side = ctx.query.side || (legacySold ? 'seller' : 'all');
    if (!SIDE_TABS.some(t => t.key === side)) side = 'all';
    let status = ctx.query.status || 'all';
    let page = Number(ctx.query.page) || 1;

    root.innerHTML = `
      <div class="page-head">
        <h1>我的订单</h1>
        <span class="muted small">买卖用的是同一个账号，每张单上都标了「我在这笔交易里是买家还是卖家」</span>
      </div>
      <div class="card order-legend">
        <div class="legend-row">
          <span class="badge badge-info legend-flag">我是买家</span>
          <span class="muted small">这笔单里是我买对方的东西：我能「确认完成」或「取消订单」，完成后可以评价卖家</span>
        </div>
        <div class="legend-row">
          <span class="badge badge-warn legend-flag">我是卖家</span>
          <span class="muted small">这笔单里是对方买了我的东西：我能「确认完成」收尾，但取消订单只有买家能做</span>
        </div>
      </div>
      <div class="tabs" id="side-tabs"></div>
      <div class="tabs mt-8" id="tabs"></div>
      <div id="list-area"></div>
      <div class="pagination" id="pager"></div>`;

    const sideTabsEl = root.querySelector('#side-tabs');
    const tabsEl = root.querySelector('#tabs');
    const listArea = root.querySelector('#list-area');
    const pager = root.querySelector('#pager');

    // 记住这一页拿到的订单，供按钮回调判断「我在这张单里是谁」
    let loaded = [];

    function syncHash() {
      history.replaceState(null, '', `#/orders${qs({ side, status, page })}`);
    }

    async function load() {
      listArea.innerHTML = `<div class="loading"><div class="spinner"></div>加载中…</div>`;
      let data;
      try {
        data = await api.get(`/api/orders/mine${qs({ side, status, page, page_size: 8 })}`);
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }
      loaded = data.list || [];

      sideTabsEl.innerHTML = SIDE_TABS.map(tab => `
        <button class="tab ${tab.key === side ? 'active' : ''}" data-side="${tab.key}">
          ${tab.label}
        </button>`).join('');
      sideTabsEl.querySelectorAll('[data-side]').forEach(btn =>
        btn.addEventListener('click', () => {
          side = btn.dataset.side;
          page = 1;
          syncHash();
          load();
        }));

      tabsEl.innerHTML = STATUS_TABS.map(tab => `
        <button class="tab ${tab.key === status ? 'active' : ''}" data-status="${tab.key}">
          ${tab.label}<span class="cnt">${data.counts?.[tab.key] ?? 0}</span>
        </button>`).join('');
      tabsEl.querySelectorAll('[data-status]').forEach(btn =>
        btn.addEventListener('click', () => {
          status = btn.dataset.status;
          page = 1;
          syncHash();
          load();
        }));

      listArea.innerHTML = loaded.length
        ? loaded.map(order => orderCardHtml(order, order.my_role || (side === 'seller' ? 'seller' : 'buyer'))).join('')
        : emptyHtml(EMPTY_TEXT[side] || EMPTY_TEXT.all, '📦');

      listArea.querySelectorAll('[data-act]').forEach(btn =>
        btn.addEventListener('click', () => handle(btn.dataset.act, btn.dataset.id)));

      renderPagination(pager, {
        page: data.page,
        pages: Math.max(1, Math.ceil(data.total / data.page_size)),
        total: data.total,
        onGo: (target) => { page = target; load(); },
      });
    }

    async function handle(act, id) {
      if (act === 'product') { go(`#/product/${id}`); return; }
      if (act === 'map') { go(`#/order/${id}/map`); return; }
      if (act === 'review') { openReviewModal(id, load); return; }

      const order = loaded.find(o => String(o.id) === String(id));
      const myRole = order?.my_role || side;

      if (act === 'complete') {
        const sure = await confirmDialog({
          title: '确认交易已完成？',
          message: '确认后订单变为「已完成」，就可以评价对方了。线下交付完成后，买卖任一方确认都可以。',
          okText: '确认完成',
        });
        if (!sure) return;
        try {
          await api.patch(`/api/orders/${id}/complete`);
          toast('交易已完成，别忘了评价对方');
          load();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }

      if (act === 'cancel') {
        const sure = await confirmDialog({
          title: '确认取消订单？', danger: true, okText: '取消订单', cancelText: '再想想',
          message: '取消后订单变为「已取消」，商品会自动恢复为「在售」，别人可以再次购买。',
        });
        if (!sure) return;
        try {
          await api.patch(`/api/orders/${id}/cancel`);
          toast('订单已取消，商品已恢复在售');
          load();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }

      // 功能④ / 需求⑥：买卖双方各自可以删掉自己那一侧的订单记录（只对自己隐藏）
      if (act === 'del-order') {
        const sure = await confirmDialog({
          title: '删除这条订单记录？', danger: true, okText: '删除记录',
          message: myRole === 'seller'
            ? '只从你的「我卖出的」里移除，买家那边不受影响；交易与评价数据都保留。'
            : '只从你的「我买到的」里移除，卖家那边的成交记录与评价都保留。',
        });
        if (!sure) return;
        try {
          await api.del(`/api/orders/${id}/record`);
          toast('订单记录已删除');
          load();
        } catch (err) { toast(err.message, 'error'); }
      }
    }

    await load();

    // 需求⑥：进了「我的订单」就把红点清零（游标推到最新），否则红点会一直挂着。
    // 用事件通知外壳去刷新，避免页面反向 import app.js（外壳监听 cm:order-seen）。
    try {
      await api.post('/api/orders/updates/seen');
      window.dispatchEvent(new CustomEvent('cm:order-seen'));
    } catch (err) { /* 红点失败不该影响页面 */ }
  },
};

/* ------------------------------------------------------------------ 评价弹窗 */
export function openReviewModal(orderId, onDone) {
  openModal({
    title: '评价这笔交易',
    body: `
      <div class="form-row">
        <label>星级评分<span class="req">*</span></label>
        <div id="rate-pick"></div>
      </div>
      <div class="form-row">
        <label>评价内容</label>
        <textarea class="textarea" id="rv-content" placeholder="说说这次交易的体验，给其他同学一个参考"></textarea>
      </div>`,
    footer: `<button class="btn" data-close>取消</button>
             <button class="btn btn-primary" id="rv-submit">提交评价</button>`,
    onMount(modal, close) {
      const picker = starPicker(modal.querySelector('#rate-pick'), 5);
      modal.querySelector('#rv-submit').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api.post('/api/reviews', {
            order_id: Number(orderId),
            rating: picker.value,
            content: modal.querySelector('#rv-content').value.trim(),
          });
          close();
          toast('评价已提交，感谢你的反馈');
          if (onDone) onDone();
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      });
    },
  });
}
