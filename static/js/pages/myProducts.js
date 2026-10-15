/* ==========================================================================
   M09 我的商品：按状态筛选 + 编辑 / 上下架 / 删除
   ========================================================================== */
import { api, qs } from '../api.js';
import {
  confirmDialog, coverHtml, emptyHtml, esc, fmtPrice, fmtTime, go,
  renderPagination, toast,
} from '../ui.js';

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'on_sale', label: '在售' },
  { key: 'sold', label: '已售' },
  { key: 'off_shelf', label: '已下架' },
  { key: 'deleted', label: '已删除' },
];

export default {
  async render(root, ctx) {
    let status = ctx.query.status || 'all';
    let page = Number(ctx.query.page) || 1;

    root.innerHTML = `
      <div class="page-head">
        <h1>我的商品</h1>
        <button class="btn btn-primary" data-go="#/publish">➕ 发布新商品</button>
      </div>
      <div class="tabs" id="tabs"></div>
      <div class="card" id="list-area"></div>
      <div class="pagination" id="pager"></div>`;

    const tabsEl = root.querySelector('#tabs');
    const listArea = root.querySelector('#list-area');
    const pager = root.querySelector('#pager');

    root.querySelector('[data-go]').addEventListener('click', (e) => go(e.currentTarget.dataset.go));

    async function load() {
      listArea.innerHTML = `<div class="loading"><div class="spinner"></div>加载中…</div>`;
      let data;
      try {
        data = await api.get(`/api/products/mine${qs({ status, page, page_size: 10 })}`);
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }

      tabsEl.innerHTML = TABS.map(tab => `
        <button class="tab ${tab.key === status ? 'active' : ''}" data-status="${tab.key}">
          ${tab.label}<span class="cnt">${data.counts?.[tab.key] ?? '-'}</span>
        </button>`).join('');
      tabsEl.querySelectorAll('[data-status]').forEach(btn =>
        btn.addEventListener('click', () => {
          status = btn.dataset.status;
          page = 1;
          history.replaceState(null, '', `#/my-products${qs({ status, page })}`);
          load();
        }));

      if (!data.list.length) {
        listArea.innerHTML = emptyHtml(status === 'all' ? '你还没有发布过商品' : '这个状态下没有商品', '🗂️');
        pager.innerHTML = '';
        return;
      }

      listArea.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>商品</th><th>分类</th><th>成色</th><th class="text-right">价格</th>
                  <th>状态</th><th>浏览</th><th>发布时间</th><th>操作</th></tr>
            </thead>
            <tbody>
              ${data.list.map(p => `
                <tr>
                  <td>
                    <div class="row" style="gap:10px">
                      <div class="pc-cover" style="width:46px;height:46px;border-radius:8px;flex:0 0 46px;font-size:22px">
                        ${coverHtml(p, 22)}
                      </div>
                      <span class="strong" data-open="${p.id}" style="cursor:pointer">${esc(p.name)}</span>
                      ${p.product_code ? `<div class="muted small" style="letter-spacing:.04em;user-select:all">${esc(p.product_code)}</div>` : ''}
                    </div>
                  </td>
                  <td>${esc(p.category_icon || '')} ${esc(p.category_name || '')}${p.subcategory_name ? ` / ${esc(p.subcategory_name)}` : ''}</td>
                  <td>${esc(p.condition)}</td>
                  <td class="text-right price">${fmtPrice(p.price)}</td>
                  <td>${statusBadge(p)}</td>
                  <td>👁 ${p.views}</td>
                  <td class="muted small">${esc(fmtTime(p.created_at))}</td>
                  <td>
                    <div class="ops">
                      <button class="btn btn-sm" data-edit="${p.id}">编辑</button>
                      ${p.status === 'on_sale' ? `<button class="btn btn-sm" data-off="${p.id}">下架</button>` : ''}
                      ${p.status === 'off_shelf' ? `<button class="btn btn-sm" data-on="${p.id}">重新上架</button>` : ''}
                      ${p.status === 'sold' && p.order_id ? (
                        p.order_status === 'pending'
                          ? `<button class="btn btn-primary btn-sm" data-finish="${p.order_id}">确认完成</button>`
                          : (p.order_seller_deleted
                              ? `<span class="muted small">卖出记录已删除</span>`
                              : `<button class="btn btn-sm" data-del-order="${p.order_id}">删除订单记录</button>`)
                      ) : ''}
                      ${p.status !== 'deleted' ? `<button class="btn btn-danger btn-sm" data-del="${p.id}">删除</button>` : ''}
                      ${p.status === 'deleted' ? `<button class="btn btn-danger btn-sm" data-record="${p.id}">删除记录</button>` : ''}
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>`;

      listArea.querySelectorAll('[data-open]').forEach(el =>
        el.addEventListener('click', () => go(`#/product/${el.dataset.open}`)));
      listArea.querySelectorAll('[data-edit]').forEach(el =>
        el.addEventListener('click', () => go(`#/product/${el.dataset.edit}/edit`)));
      listArea.querySelectorAll('[data-off]').forEach(el =>
        el.addEventListener('click', () => changeStatus(el.dataset.off, 'off_shelf')));
      listArea.querySelectorAll('[data-on]').forEach(el =>
        el.addEventListener('click', () => changeStatus(el.dataset.on, 'on_sale')));
      listArea.querySelectorAll('[data-del]').forEach(el =>
        el.addEventListener('click', () => removeProduct(el.dataset.del)));
      listArea.querySelectorAll('[data-record]').forEach(el =>
        el.addEventListener('click', () => removeRecord(el.dataset.record)));
      // 需求⑥：已售商品也能直接收尾交易
      listArea.querySelectorAll('[data-finish]').forEach(el =>
        el.addEventListener('click', () => finishOrder(el.dataset.finish)));
      listArea.querySelectorAll('[data-del-order]').forEach(el =>
        el.addEventListener('click', () => deleteOrderRecord(el.dataset.delOrder)));

      renderPagination(pager, {
        page: data.page,
        pages: Math.max(1, Math.ceil(data.total / data.page_size)),
        total: data.total,
        onGo: (target) => { page = target; load(); },
      });
    }

    // 需求⑥：卖家在「我的商品」里直接收尾交易
    async function finishOrder(orderId) {
      const sure = await confirmDialog({
        title: '确认这笔交易已完成？',
        message: '确认后订单变为「已完成」，双方都可以评价。线下交付完成后，买卖任一方确认都可以。',
        okText: '确认完成',
      });
      if (!sure) return;
      try {
        await api.patch(`/api/orders/${orderId}/complete`);
        toast('交易已完成，别忘了评价买家');
        load();
      } catch (err) { toast(err.message, 'error'); }
    }

    async function deleteOrderRecord(orderId) {
      const sure = await confirmDialog({
        title: '删除这条卖出记录？', danger: true, okText: '删除记录',
        message: '只从你的「卖出订单」里移除，买家那边不受影响；交易与评价数据都保留。',
      });
      if (!sure) return;
      try {
        await api.del(`/api/orders/${orderId}/record`);
        toast('卖出记录已删除（买家侧不受影响）');
        load();
      } catch (err) { toast(err.message, 'error'); }
    }

    async function changeStatus(id, target) {      const isOff = target === 'off_shelf';
      const sure = await confirmDialog({
        title: isOff ? '确认下架这件商品？' : '确认重新上架？',
        message: isOff ? '下架后买家搜索不到，你自己仍然可见。' : '重新上架后买家可以再次购买。',
        okText: isOff ? '下架' : '重新上架',
      });
      if (!sure) return;
      try {
        await api.patch(`/api/products/${id}/status`, { status: target });
        toast(isOff ? '已下架' : '已重新上架');
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function removeProduct(id) {
      const sure = await confirmDialog({
        title: '确认删除这件商品？', danger: true, okText: '删除',
        message: '删除后买家再也看不到它；历史订单仍保留商品快照，不影响已成交记录。',
      });
      if (!sure) return;
      try {
        await api.del(`/api/products/${id}`);
        toast('商品已删除');
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    /** 功能④：把「已删除」的商品记录彻底清掉 */
    async function removeRecord(id) {
      const sure = await confirmDialog({
        title: '彻底删除这条商品记录？', danger: true, okText: '彻底删除',
        message: '这条记录会从数据库里永久移除，无法恢复。'
          + '如果这件商品有成交订单，系统会拒绝删除（历史订单需要保留商品信息）。',
      });
      if (!sure) return;
      try {
        await api.del(`/api/products/${id}/record`);
        toast('商品记录已彻底删除');
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    function statusBadge(p) {
      const map = { on_sale: 'badge', sold: 'badge badge-gray', off_shelf: 'badge badge-warn', deleted: 'badge badge-danger' };
      return `<span class="${map[p.status] || 'badge'}">${esc(p.status_text || p.status)}</span>`;
    }

    await load();
  },
};
