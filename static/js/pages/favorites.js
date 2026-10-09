/* ==========================================================================
   M07 我的收藏
   ========================================================================== */
import { api, qs } from '../api.js';
import { bindProductCards, productCardHtml } from '../components.js';
import { confirmDialog, emptyHtml, esc, renderPagination, toast } from '../ui.js';

export default {
  async render(root, ctx) {
    let page = Number(ctx.query.page) || 1;

    root.innerHTML = `
      <div class="page-head">
        <h1>我的收藏</h1>
        <span class="muted small">收藏只是标记，物品被别人买走后仍会保留在这里</span>
      </div>
      <div id="list-area"></div>
      <div class="pagination" id="pager"></div>`;

    const listArea = root.querySelector('#list-area');
    const pager = root.querySelector('#pager');

    async function load() {
      listArea.innerHTML = `<div class="loading"><div class="spinner"></div>加载中…</div>`;
      let data;
      try {
        data = await api.get(`/api/favorites${qs({ page, page_size: 12 })}`);
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }

      if (!data.list.length) {
        listArea.innerHTML = emptyHtml('还没有收藏任何物品，去逛逛吧', '⭐');
        pager.innerHTML = '';
        root.querySelectorAll('[data-fav]').forEach(el => el.remove());
        return;
      }

      listArea.innerHTML = `<div class="grid-cards">${data.list.map(productCardHtml).join('')}</div>`;
      bindProductCards(listArea);

      // 每张卡片补一个「取消收藏」按钮
      listArea.querySelectorAll('[data-product]').forEach(card => {
        const id = card.dataset.product;
        const item = data.list.find(p => String(p.id) === String(id));
        const bar = document.createElement('div');
        bar.className = 'row';
        bar.style.cssText = 'padding:0 13px 12px;gap:6px';
        bar.innerHTML = `
          <button class="btn btn-sm" data-fav="${id}">取消收藏</button>
          ${item && item.status !== 'on_sale' ? `<span class="badge badge-gray">${esc(item.status_text || '')}</span>` : ''}`;
        card.querySelector('.pc-body').appendChild(bar);
        bar.querySelector('[data-fav]').addEventListener('click', async (event) => {
          event.stopPropagation();
          const sure = await confirmDialog({
            title: '取消收藏？', okText: '取消收藏', cancelText: '保留',
            message: '取消后可以随时再收藏回来。',
          });
          if (!sure) return;
          try {
            await api.del(`/api/favorites/${id}`);
            toast('已取消收藏');
            load();
          } catch (err) { toast(err.message, 'error'); }
        });
      });

      renderPagination(pager, {
        page: data.page,
        pages: Math.max(1, Math.ceil(data.total / data.page_size)),
        total: data.total,
        onGo: (target) => { page = target; load(); },
      });
    }

    await load();
  },
};
