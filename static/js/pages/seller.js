/* ==========================================================================
   需求② 卖家商品主页
   入口：商品详情页点卖家昵称 → #/seller/<uid>
   内容：卖家自己愿意公开的信息（头像/昵称/商家简介/在售件数/加入时间/卖家编号）
        + TA 发布的商品（默认在售，可切已售；支持关键词与分类筛选）
   已下架、已删除的商品不展示。
   ========================================================================== */
import { api, qs } from '../api.js';
import { ensureCategories } from '../data.js';
import { bindProductCards, productCardHtml } from '../components.js';
import { avatarHtml, emptyHtml, esc, loadingHtml, renderPagination } from '../ui.js';

export default {
  async render(root, ctx) {
    const uid = Number(ctx.params.id);
    let status = ctx.query.status === 'sold' ? 'sold' : 'on_sale';
    let keyword = ctx.query.keyword || '';
    let categoryId = ctx.query.category_id || '';
    let page = 1;

    const categories = await ensureCategories();

    root.innerHTML = `
      <div class="page-head">
        <h1>卖家主页</h1>
        <span class="muted small">这里只展示卖家愿意公开的信息</span>
      </div>

      <div class="card" id="seller-head">${loadingHtml()}</div>

      <div class="card mt-16">
        <div class="form-grid">
          <div class="form-row">
            <label>关键词</label>
            <input class="input" id="sk-keyword" placeholder="商品名 / 描述"
                   value="${esc(keyword)}">
          </div>
          <div class="form-row">
            <label>分类</label>
            <select class="select" id="sk-category">
              <option value="">全部分类</option>
              ${categories.map(c => `<option value="${c.id}" ${String(c.id) === String(categoryId) ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>&nbsp;</label>
            <button class="btn btn-primary btn-block" id="sk-search">查询</button>
          </div>
        </div>
      </div>

      <div id="list-area" class="mt-16"></div>
      <div class="pagination" id="pager"></div>`;

    const head = root.querySelector('#seller-head');
    const listArea = root.querySelector('#list-area');
    const pager = root.querySelector('#pager');

    function paintHead(seller, counts) {
      const bio = seller.bio
        ? `<div class="seller-bio">${esc(seller.bio)}</div>`
        : `<div class="seller-bio muted">这位卖家还没有填写商家简介</div>`;
      head.innerHTML = `
        <div class="seller-head">
          <div class="seller-avatar">${avatarHtml(seller, 72, 'seller-avatar')}</div>
          <div class="seller-main">
            <div class="seller-name">${esc(seller.nickname)}</div>
            ${bio}
            <div class="seller-stats muted small">
              <span>在售 <b>${counts.on_sale ?? 0}</b> 件</span>
              <span>已售 <b>${counts.sold ?? 0}</b> 件</span>
              <span>加入时间 ${esc(seller.joined_at || '未知')}</span>
              <span>卖家编号 ${esc(seller.seller_code || '未分配')}</span>
            </div>
          </div>
          <div class="seller-switch" id="sk-status">
            <button class="btn btn-sm ${status === 'on_sale' ? 'btn-primary' : ''}"
                    data-status="on_sale">在售 ${counts.on_sale ?? 0}</button>
            <button class="btn btn-sm ${status === 'sold' ? 'btn-primary' : ''}"
                    data-status="sold">已售 ${counts.sold ?? 0}</button>
          </div>
        </div>`;

      head.querySelectorAll('[data-status]').forEach(btn =>
        btn.addEventListener('click', () => {
          if (status === btn.dataset.status) return;
          status = btn.dataset.status;
          page = 1;
          load();
        }));
    }

    async function load() {
      listArea.innerHTML = loadingHtml();
      let data;
      try {
        data = await api.get(`/api/sellers/${uid}${qs({
          status, keyword, category_id: categoryId, page, page_size: 12,
        })}`);
      } catch (err) {
        head.innerHTML = '';
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        pager.innerHTML = '';
        return;
      }

      paintHead(data.seller || {}, data.counts || {});

      if (!data.list.length) {
        listArea.innerHTML = status === 'on_sale'
          ? emptyHtml('这位卖家当前没有在售的商品', '📦')
          : emptyHtml('这位卖家还没有已售出的商品', '🧾');
        pager.innerHTML = '';
        return;
      }

      listArea.innerHTML = `<div class="grid-cards">${data.list.map(productCardHtml).join('')}</div>`;
      bindProductCards(listArea);
      renderPagination(pager, {
        page: data.page,
        pages: Math.max(1, Math.ceil(data.total / data.page_size)),
        total: data.total,
        onGo: (target) => { page = target; load(); },
      });
    }

    root.querySelector('#sk-search').addEventListener('click', () => {
      keyword = root.querySelector('#sk-keyword').value.trim();
      categoryId = root.querySelector('#sk-category').value;
      page = 1;
      load();
    });
    root.querySelector('#sk-keyword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('#sk-search').click();
    });

    await load();
  },
};
