/* ==========================================================================
   M03 搜索与筛选（数据交叉筛选）
   多条件 AND 叠加：关键词 + 分类 + 小类 + 价格区间 + 成色 + 排序 + 分页

   功能②：价格区间既可用下拉里的快捷区间，也可以直接手填最低价 / 最高价。
   ========================================================================== */
import { api, qs } from '../api.js';
import { ensureCategories, ensureMeta } from '../data.js';
import { bindProductCards, productCardHtml } from '../components.js';
import { emptyHtml, esc, renderPagination, skeletonHtml, toast } from '../ui.js';

const PRICE_RANGES = [
  { value: '', label: '不限价格', min: '', max: '' },
  { value: '0-20', label: '¥0 - 20', min: '0', max: '20' },
  { value: '20-50', label: '¥20 - 50', min: '20', max: '50' },
  { value: '50-100', label: '¥50 - 100', min: '50', max: '100' },
  { value: '100-200', label: '¥100 - 200', min: '100', max: '200' },
  { value: '200-', label: '¥200 以上', min: '200', max: '' },
  { value: 'custom', label: '自定义…', min: null, max: null },
];

const SORTS = [
  { value: 'newest', label: '最新发布' },
  { value: 'price_asc', label: '价格从低到高' },
  { value: 'price_desc', label: '价格从高到低' },
  { value: 'views', label: '最多浏览' },
];

/** 判断当前手填的区间命中哪个快捷区间；没命中就是「自定义」 */
function matchPreset(min, max) {
  const hit = PRICE_RANGES.find(r => r.min !== null && String(r.min) === String(min) && String(r.max) === String(max));
  return hit ? hit.value : 'custom';
}

export default {
  async render(root, ctx) {
    const [categories, meta] = await Promise.all([ensureCategories(), ensureMeta()]);

    // 初始条件来自地址栏（顶栏搜索框、首页分类卡都会带参数进来）
    let initialMin = ctx.query.min_price ?? '';
    let initialMax = ctx.query.max_price ?? '';
    if (initialMin === '' && initialMax === '' && ctx.query.price) {
      const preset = PRICE_RANGES.find(r => r.value === ctx.query.price);
      if (preset && preset.min !== null) { initialMin = preset.min; initialMax = preset.max; }
    }

    const state = {
      keyword: ctx.query.keyword || '',
      category_id: ctx.query.category_id || '',
      subcategory_id: ctx.query.subcategory_id || '',
      min_price: String(initialMin),
      max_price: String(initialMax),
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
            <label>价格区间（快捷）</label>
            <select class="select" id="f-price">
              ${PRICE_RANGES.map(r => `<option value="${r.value}">${esc(r.label)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>价格区间（自定义）</label>
            <div class="price-range-row">
              <input class="input" id="f-min-price" type="number" min="0" step="0.01"
                     placeholder="最低价" value="${esc(state.min_price)}">
              <span class="muted">—</span>
              <input class="input" id="f-max-price" type="number" min="0" step="0.01"
                     placeholder="最高价" value="${esc(state.max_price)}">
            </div>
            <div class="hint">两个都可以只填一个；留空表示不限</div>
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
    const minInput = $('#f-min-price');
    const maxInput = $('#f-max-price');
    const presetSelect = $('#f-price');

    /* ---------- 输入框错误提示 ---------- */
    function clearError(input) {
      input.classList.remove('invalid');
      const tip = input.parentElement.querySelector('.form-error');
      if (tip) tip.remove();
    }
    function setError(input, message) {
      input.classList.add('invalid');
      let tip = input.parentElement.querySelector('.form-error');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'form-error';
        input.parentElement.appendChild(tip);
      }
      tip.textContent = message;
    }

    /**
     * 读取并校验手填的价格区间。
     * 返回 {min, max} 或 null（校验不通过）。
     */
    function readPrice() {
      clearError(minInput);
      clearError(maxInput);
      const rawMin = minInput.value.trim();
      const rawMax = maxInput.value.trim();

      const parse = (raw, input, label) => {
        if (raw === '') return '';
        const value = Number(raw);
        if (Number.isNaN(value)) { setError(input, `${label}必须是数字`); return null; }
        if (value < 0) { setError(input, `${label}不能为负数`); return null; }
        return String(value);
      };

      const min = parse(rawMin, minInput, '最低价');
      const max = parse(rawMax, maxInput, '最高价');
      if (min === null || max === null) return null;
      if (min !== '' && max !== '' && Number(min) > Number(max)) {
        setError(minInput, '最低价不能大于最高价');
        setError(maxInput, '最高价不能小于最低价');
        return null;
      }
      return { min, max };
    }

    /** 输入框内容变化后，让快捷下拉跟随（命中某个区间就选中它，否则显示「自定义」） */
    function syncPreset() {
      presetSelect.value = matchPreset(minInput.value.trim(), maxInput.value.trim());
    }

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
      const price = readPrice();
      if (price === null) {
        toast('价格区间填写不正确，请检查标红的地方', 'warn');
        return;
      }
      state.min_price = price.min;
      state.max_price = price.max;
      state.page = page;

      resultArea.innerHTML = skeletonHtml(4);
      pager.innerHTML = '';
      countLabel.textContent = '正在查询…';

      const query = {
        keyword: state.keyword,
        category_id: state.category_id,
        subcategory_id: state.subcategory_id,
        min_price: state.min_price,
        max_price: state.max_price,
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
    function collectOtherFilters() {
      state.keyword = $('#f-keyword').value.trim();
      state.category_id = $('#f-category').value;
      state.subcategory_id = $('#f-subcategory').value;
      state.condition = $('#f-condition').value;
      state.sort = $('#f-sort').value;
    }

    function applyAndLoad() {
      collectOtherFilters();
      syncPreset();
      load(1);
    }

    // 快捷区间：选中后把值填进输入框
    presetSelect.addEventListener('change', () => {
      const preset = PRICE_RANGES.find(r => r.value === presetSelect.value);
      if (!preset || preset.min === null) {
        // 选到「自定义…」：只把焦点给最低价，等用户输入
        minInput.focus();
        return;
      }
      minInput.value = preset.min;
      maxInput.value = preset.max;
      clearError(minInput);
      clearError(maxInput);
      applyAndLoad();
    });

    // 手填价格：回车或失焦时查询
    [minInput, maxInput].forEach(input => {
      input.addEventListener('input', () => {
        clearError(input);
        syncPreset();
      });
      input.addEventListener('change', applyAndLoad);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); applyAndLoad(); }
      });
    });

    $('#f-category').addEventListener('change', () => {
      state.category_id = $('#f-category').value;
      state.subcategory_id = '';
      fillSubcategories();
      applyAndLoad();
    });
    $('#f-subcategory').addEventListener('change', applyAndLoad);
    $('#f-condition').addEventListener('change', applyAndLoad);
    $('#f-sort').addEventListener('change', applyAndLoad);
    $('#btn-search').addEventListener('click', applyAndLoad);
    $('#f-keyword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyAndLoad(); }
    });
    $('#btn-reset').addEventListener('click', () => {
      state.keyword = ''; state.category_id = ''; state.subcategory_id = '';
      state.condition = ''; state.sort = 'newest';
      state.min_price = ''; state.max_price = '';
      $('#f-keyword').value = ''; $('#f-category').value = '';
      $('#f-condition').value = ''; $('#f-sort').value = 'newest';
      minInput.value = ''; maxInput.value = '';
      clearError(minInput); clearError(maxInput);
      presetSelect.value = '';
      fillSubcategories();
      load(1);
    });

    fillSubcategories();
    syncPreset();
    await load(state.page);
  },
};
