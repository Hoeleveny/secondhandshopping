/* ==========================================================================
   M03 搜索与筛选（数据交叉筛选）
   多条件 AND 叠加：关键词 + 分类 + 小类 + 价格区间 + 成色 + 排序 + 分页
   ========================================================================== */
import { api, qs } from '../api.js';
import { ensureCategories, ensureMeta } from '../data.js';
import { bindProductCards, productCardHtml } from '../components.js';
import { emptyHtml, esc, renderPagination, skeletonHtml } from '../ui.js';

const PRICE_RANGES = [
  { value: '', label: '不限价格', min: '', max: '' },
  { value: '0-20', label: '¥0 - 20', min: 0, max: 20 },
  { value: '20-50', label: '¥20 - 50', min: 20, max: 50 },
  { value: '50-100', label: '¥50 - 100', min: 50, max: 100 },
  { value: '100-200', label: '¥100 - 200', min: 100, max: 200 },
  { value: '200-', label: '¥200 以上', min: 200, max: '' },
];

const SORTS = [
  { value: 'newest', label: '最新发布' },
  { value: 'price_asc', label: '价格从低到高' },
  { value: 'price_desc', label: '价格从高到低' },
  { value: 'views', label: '最多浏览' },
];

export default {
  async render(root, ctx) {
    const [categories, meta] = await Promise.all([ensureCategories(), ensureMeta()]);

    // 初始条件来自地址栏（顶栏搜索框、首页分类卡都会带参数进来）
    const state = {
      keyword: ctx.query.keyword || '',
      category_id: ctx.query.category_id || '',
      subcategory_id: ctx.query.subcategory_id || '',
      price: ctx.query.price || '',
      condition: ctx.query.condition || '',
      sort: ctx.query.sort || 'newest',
      page: Number(ctx.query.page) || 1,
      page_size: 12,
    };

    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>搜索与筛选</h2>
          <span class="muted small">多个条件会叠加生效，结果只包含「在售」商品</span>
        </div>
        <div class="form-grid">
          <div class="form-row">
            <label>关键词</label>
            <input class="input" id="f-keyword" placeholder="商品名 / 描述 / 分类词" value="${esc(state.keyword)}">
          </div>
          <div class="form-row">
            <label>分类</label>
            <select class="select" id="f-category">
              <option value="">全部分类</option>
              ${categories.map(c => `<option value="${c.id}" ${String(state.category_id) === String(c.id) ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>小类</label>
            <select class="select" id="f-subcategory"><option value="">全部小类</option></select>
          </div>
          <div class="form-row">
            <label>价格区间</label>
            <select class="select" id="f-price">
              ${PRICE_RANGES.map(r => `<option value="${r.value}" ${state.price === r.value ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>成色</label>
            <select class="select" id="f-condition">
              <option value="">不限成色</option>
              ${meta.conditions.map(c => `<option value="${esc(c)}" ${state.condition === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>排序</label>
            <select class="select" id="f-sort">
              ${SORTS.map(s => `<option value="${s.value}" ${state.sort === s.value ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="row-between mt-8">
          <span class="muted small" id="result-count">正在查询…</span>
          <div class="row">
            <button class="btn" id="btn-reset">清除条件</button>
            <button class="btn btn-primary" id="btn-search">🔍 搜索</button>
          </div>
        </div>
      </div>

      <div id="result-area">${skeletonHtml(4)}</div>
      <div class="pagination" id="pager"></div>`;

    const $ = (id) => root.querySelector(id);
    const resultArea = $('#result-area');
    const pager = $('#pager');
    const countLabel = $('#result-count');

    /* ---------- 分类 → 小类联动 ---------- */
    function fillSubcategories() {
      const cat = categories.find(c => String(c.id) === String(state.category_id));
      const select = $('#f-subcategory');
      const subs = cat ? (cat.subcategories || []) : [];
      select.innerHTML = `<option value="">全部小类</option>` +
        subs.map(s => `<option value="${s.id}" ${String(state.subcategory_id) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
      select.disabled = subs.length === 0;
      if (!subs.some(s => String(s.id) === String(state.subcategory_id))) state.subcategory_id = '';
    }

    /* ---------- 拉数据 ---------- */
    async function load(page = 1) {
      state.page = page;
      resultArea.innerHTML = skeletonHtml(4);
      pager.innerHTML = '';
      countLabel.textContent = '正在查询…';

      const range = PRICE_RANGES.find(r => r.value === state.price) || PRICE_RANGES[0];
      const query = {
        keyword: state.keyword,
        category_id: state.category_id,
        subcategory_id: state.subcategory_id,
        min_price: range.min,
        max_price: range.max,
        condition: state.condition,
        sort: state.sort,
        page: state.page,
        page_size: state.page_size,
      };

      // 把条件同步到地址栏，方便刷新与分享（replaceState 不会触发 hashchange）
      const visible = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== null && v !== undefined));
      history.replaceState(null, '', `#/search${qs(visible)}`);

      let data;
      try {
        data = await api.get(`/api/products${qs(query)}`);
      } catch (err) {
        resultArea.innerHTML = emptyHtml(`查询失败：${err.message}`, '😵');
        return;
      }

      countLabel.textContent = `符合条件的在售商品：共 ${data.total} 件`;
      resultArea.innerHTML = data.list.length
        ? `<div class="grid-cards">${data.list.map(productCardHtml).join('')}</div>`
        : emptyHtml('没有找到符合条件的商品，试试放宽条件', '🔍');
      bindProductCards(resultArea);

      renderPagination(pager, {
        page: data.page, pages: data.pages, total: data.total,
        onGo: (target) => { load(target); window.scrollTo({ top: 0, behavior: 'smooth' }); },
      });
    }

    /* ---------- 事件 ---------- */
    function applyAndLoad() {
      state.keyword = $('#f-keyword').value.trim();
      state.category_id = $('#f-category').value;
      state.subcategory_id = $('#f-subcategory').value;
      state.price = $('#f-price').value;
      state.condition = $('#f-condition').value;
      state.sort = $('#f-sort').value;
      load(1);
    }

    $('#f-category').addEventListener('change', () => {
      state.category_id = $('#f-category').value;
      state.subcategory_id = '';
      fillSubcategories();
      applyAndLoad();
    });
    $('#f-subcategory').addEventListener('change', applyAndLoad);
    $('#f-price').addEventListener('change', applyAndLoad);
    $('#f-condition').addEventListener('change', applyAndLoad);
    $('#f-sort').addEventListener('change', applyAndLoad);
    $('#btn-search').addEventListener('click', applyAndLoad);
    $('#f-keyword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyAndLoad(); }
    });
    $('#btn-reset').addEventListener('click', () => {
      state.keyword = ''; state.category_id = ''; state.subcategory_id = '';
      state.price = ''; state.condition = ''; state.sort = 'newest';
      $('#f-keyword').value = ''; $('#f-category').value = '';
      $('#f-price').value = ''; $('#f-condition').value = ''; $('#f-sort').value = 'newest';
      fillSubcategories();
      load(1);
    });

    fillSubcategories();
    await load(state.page);
  },
};
