/* ==========================================================================
   M05 比价：同一分类下在售商品的价格行情
   ========================================================================== */
import { api } from '../api.js';
import { ensureCategories } from '../data.js';
import { emptyHtml, esc, fmtPrice, loadingHtml } from '../ui.js';

export default {
  async render(root, ctx) {
    const categories = await ensureCategories();
    let categoryId = ctx.query.category_id || (categories[0] ? categories[0].id : '');

    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>比价行情</h2>
          <span class="muted small">同分类「在售」商品的价格分布，帮你判断划不划算</span>
        </div>
        <div class="row">
          <div style="min-width:180px">
            <select class="select" id="cat-select">
              ${categories.map(c => `<option value="${c.id}" ${String(categoryId) === String(c.id) ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <span class="muted small">切换分类即可查看该分类的价格行情</span>
        </div>
      </div>

      <div class="grid grid-4 mb-16" id="stat-area"></div>

      <div class="card">
        <div class="card-head"><h2 id="list-title">商品列表（价格从低到高）</h2></div>
        <div id="list-area">${loadingHtml()}</div>
      </div>`;

    const statArea = root.querySelector('#stat-area');
    const listArea = root.querySelector('#list-area');
    const title = root.querySelector('#list-title');

    async function load() {
      statArea.innerHTML = '';
      listArea.innerHTML = loadingHtml();
      let data;
      try {
        data = await api.get(`/api/compare?category_id=${encodeURIComponent(categoryId)}`);
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }

      const cards = [
        { label: '在售件数', value: data.count, icon: '🧾' },
        { label: '最低价', value: data.min_price === null ? '—' : fmtPrice(data.min_price), icon: '⬇️' },
        { label: '平均价', value: data.avg_price === null ? '—' : fmtPrice(data.avg_price), icon: '📊' },
        { label: '最高价', value: data.max_price === null ? '—' : fmtPrice(data.max_price), icon: '⬆️' },
      ];
      statArea.innerHTML = cards.map(c => `
        <div class="stat-card">
          <span class="sc-icon">${c.icon}</span>
          <div class="sc-label">${esc(c.label)}</div>
          <div class="sc-value">${esc(String(c.value))}</div>
        </div>`).join('');

      title.textContent = `${data.category.icon} ${data.category.name} · 在售商品（价格从低到高）`;

      if (!data.list.length) {
        listArea.innerHTML = emptyHtml('该分类下暂无在售商品', '📭');
        return;
      }

      listArea.innerHTML = `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr><th>#</th><th>商品</th><th>成色</th><th>卖家</th><th>浏览</th><th class="text-right">价格</th></tr>
            </thead>
            <tbody>
              ${data.list.map((p, index) => {
                const lowest = index === 0;
                const style = lowest ? 'background:var(--green-soft);font-weight:700' : '';
                return `
                <tr data-product="${p.id}" style="cursor:pointer;${style}">
                  <td>${index + 1}${lowest ? ' <span class="badge">最低价</span>' : ''}</td>
                  <td>${esc(p.category_icon || '')} ${esc(p.name)}</td>
                  <td>${esc(p.condition)}</td>
                  <td>${esc(p.seller_nickname || '')}</td>
                  <td>👁 ${p.views}</td>
                  <td class="text-right price">${fmtPrice(p.price)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;

      listArea.querySelectorAll('[data-product]').forEach(row =>
        row.addEventListener('click', () => { location.hash = `#/product/${row.dataset.product}`; }));
    }

    root.querySelector('#cat-select').addEventListener('change', (event) => {
      categoryId = event.target.value;
      history.replaceState(null, '', `#/compare?category_id=${encodeURIComponent(categoryId)}`);
      load();
    });

    await load();
  },
};
