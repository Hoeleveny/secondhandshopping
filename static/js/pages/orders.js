/* ==========================================================================
   M06 我的订单（买家）/ 卖出订单（卖家）
   ========================================================================== */
import { api, qs } from '../api.js';
import { orderCardHtml } from '../components.js';
import {
  confirmDialog, emptyHtml, go, openModal, renderPagination, starPicker, toast,
} from '../ui.js';

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '待完成' },
  { key: 'done', label: '已完成' },
  { key: 'canceled', label: '已取消' },
];

export default {
  async render(root, ctx) {
    const isSellerSide = ctx.path === '/sold';
    const side = isSellerSide ? 'seller' : 'buyer';
    const endpoint = isSellerSide ? '/api/orders/sold' : '/api/orders/mine';
    const baseHash = isSellerSide ? '#/sold' : '#/orders';

    let status = ctx.query.status || 'all';
    let page = Number(ctx.query.page) || 1;

    root.innerHTML = `
      <div class="page-head">
        <h1>${isSellerSide ? '卖出订单' : '我的订单'}</h1>
        <span class="muted small">${isSellerSide
          ? '别人买了你的商品后，订单会出现在这里'
          : '下单后与卖家当面交易，完成后记得确认并评价'}</span>
      </div>
      <div class="tabs" id="tabs"></div>
      <div id="list-area"></div>
      <div class="pagination" id="pager"></div>`;

    const tabsEl = root.querySelector('#tabs');
    const listArea = root.querySelector('#list-area');
    const pager = root.querySelector('#pager');

    async function load() {
      listArea.innerHTML = `<div class="loading"><div class="spinner"></div>加载中…</div>`;
      let data;
      try {
        data = await api.get(`${endpoint}${qs({ status, page, page_size: 8 })}`);
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }

      tabsEl.innerHTML = STATUS_TABS.map(tab => `
        <button class="tab ${tab.key === status ? 'active' : ''}" data-status="${tab.key}">
          ${tab.label}<span class="cnt">${data.counts?.[tab.key] ?? 0}</span>
        </button>`).join('');
      tabsEl.querySelectorAll('[data-status]').forEach(btn =>
        btn.addEventListener('click', () => {
          status = btn.dataset.status;
          page = 1;
          history.replaceState(null, '', `${baseHash}${qs({ status, page })}`);
          load();
        }));

      listArea.innerHTML = data.list.length
        ? data.list.map(order => orderCardHtml(order, side)).join('')
        : emptyHtml(isSellerSide ? '还没有卖出记录' : '你还没有下过单', '📦');

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

      if (act === 'complete') {
        const sure = await confirmDialog({
          title: '确认交易已完成？',
          message: '确认后订单变为「已完成」，就可以评价对方了。',
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

      // 功能④：买家删除自己的订单记录
      if (act === 'del-order') {
        const sure = await confirmDialog({
          title: '删除这条订单记录？', danger: true, okText: '删除记录',
          message: '删掉后你自己的订单列表里不再显示它；卖家那边的成交记录与评价都保留。',
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
