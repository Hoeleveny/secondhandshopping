/* ==========================================================================
   M10 管理后台
   四个页签：商品管理 / 举报审核 / 基础数据 / 数据管理（备份·恢复·重置）
   ========================================================================== */
import { api, qs } from '../api.js';
import { ensureCategories, ensureMeta, ensurePlaces, invalidateCatalog } from '../data.js';
import {
  confirmDialog, emptyHtml, esc, fmtPrice, fmtTime, loadingHtml,
  openModal, renderPagination, toast,
} from '../ui.js';

const TABS = [
  { key: 'products', label: '商品管理', icon: '📦' },
  { key: 'reports', label: '举报审核', icon: '🚩' },
  { key: 'base', label: '基础数据', icon: '🗂️' },
  { key: 'data', label: '数据管理', icon: '💾' },
];

export default {
  async render(root, ctx) {
    let tab = TABS.some(t => t.key === ctx.query.tab) ? ctx.query.tab : 'products';

    root.innerHTML = `
      <div class="page-head">
        <h1>管理后台</h1>
        <span class="muted small">管理员可见全部商品与数据，基础数据也在这里维护</span>
      </div>
      <div class="tabs" id="tabs">
        ${TABS.map(t => `<button class="tab ${t.key === tab ? 'active' : ''}" data-tab="${t.key}">${t.icon} ${t.label}</button>`).join('')}
      </div>
      <div id="panel"></div>`;

    const panel = root.querySelector('#panel');
    const tabsEl = root.querySelector('#tabs');

    tabsEl.querySelectorAll('[data-tab]').forEach(btn =>
      btn.addEventListener('click', () => {
        tab = btn.dataset.tab;
        tabsEl.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        history.replaceState(null, '', `#/admin?tab=${tab}`);
        renderTab();
      }));

    function renderTab() {
      if (tab === 'products') return renderProducts(panel);
      if (tab === 'reports') return renderReports(panel);
      if (tab === 'base') return renderBaseData(panel);
      return renderDataManager(panel);
    }

    await renderTab();
  },
};

/* ================================================================ 商品管理 */
async function renderProducts(panel) {
  const categories = await ensureCategories();
  let keyword = '';
  let categoryId = '';
  let status = 'all';
  let page = 1;

  panel.innerHTML = `
    <div class="card">
      <div class="form-grid">
        <div class="form-row">
          <label>关键词</label>
          <input class="input" id="ad-keyword" placeholder="商品名 / 描述">
        </div>
        <div class="form-row">
          <label>分类</label>
          <select class="select" id="ad-category">
            <option value="">全部分类</option>
            ${categories.map(c => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>状态</label>
          <select class="select" id="ad-status">
            <option value="all">全部（不含已删除）</option>
            <option value="on_sale">在售</option>
            <option value="sold">已售</option>
            <option value="off_shelf">已下架</option>
            <option value="deleted">已删除</option>
          </select>
        </div>
        <div class="form-row">
          <label>&nbsp;</label>
          <button class="btn btn-primary btn-block" id="ad-search">查询</button>
        </div>
      </div>
    </div>
    <div class="card" id="ad-list">${loadingHtml()}</div>
    <div class="pagination" id="ad-pager"></div>`;

  const listBox = panel.querySelector('#ad-list');
  const pager = panel.querySelector('#ad-pager');

  async function load() {
    listBox.innerHTML = loadingHtml();
    let data;
    try {
      data = await api.get(`/api/admin/products${qs({ keyword, category_id: categoryId, status, page, page_size: 15 })}`);
    } catch (err) {
      listBox.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
      return;
    }

    if (!data.list.length) {
      listBox.innerHTML = emptyHtml('没有符合条件的商品', '📦');
      pager.innerHTML = '';
      return;
    }

    const badge = (p) => {
      const map = { on_sale: 'badge', sold: 'badge badge-gray', off_shelf: 'badge badge-warn', deleted: 'badge badge-danger' };
      return `<span class="${map[p.status] || 'badge'}">${esc(p.status_text || p.status)}</span>`;
    };

    listBox.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>商品</th><th>分类</th><th>卖家</th><th class="text-right">价格</th>
                <th>状态</th><th>浏览</th><th>发布时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${data.list.map(p => `
              <tr>
                <td><span class="strong" data-open="${p.id}" style="cursor:pointer">${esc(p.name)}</span></td>
                <td>${esc(p.category_icon || '')} ${esc(p.category_name || '')}</td>
                <td>${esc(p.seller_nickname || '')}</td>
                <td class="text-right price">${fmtPrice(p.price)}</td>
                <td>${badge(p)}</td>
                <td>👁 ${p.views}</td>
                <td class="muted small">${esc(fmtTime(p.created_at))}</td>
                <td>
                  <div class="ops">
                    ${p.status === 'on_sale' ? `<button class="btn btn-sm" data-off="${p.id}">下架</button>` : ''}
                    ${p.status === 'off_shelf' ? `<button class="btn btn-sm" data-on="${p.id}">重新上架</button>` : ''}
                    ${p.status !== 'deleted' ? `<button class="btn btn-danger btn-sm" data-del="${p.id}">删除</button>` : ''}
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    listBox.querySelectorAll('[data-open]').forEach(el =>
      el.addEventListener('click', () => { location.hash = `#/product/${el.dataset.open}`; }));
    listBox.querySelectorAll('[data-off]').forEach(el =>
      el.addEventListener('click', () => changeStatus(el.dataset.off, 'off_shelf')));
    listBox.querySelectorAll('[data-on]').forEach(el =>
      el.addEventListener('click', () => changeStatus(el.dataset.on, 'on_sale')));
    listBox.querySelectorAll('[data-del]').forEach(el =>
      el.addEventListener('click', () => removeProduct(el.dataset.del)));

    renderPagination(pager, {
      page: data.page,
      pages: Math.max(1, Math.ceil(data.total / data.page_size)),
      total: data.total,
      onGo: (target) => { page = target; load(); },
    });
  }

  async function changeStatus(id, target) {
    try {
      await api.patch(`/api/admin/products/${id}/status`, { status: target });
      toast(target === 'on_sale' ? '已重新上架' : '已下架');
      load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function removeProduct(id) {
    const sure = await confirmDialog({
      title: '确认删除该商品？', danger: true, okText: '删除',
      message: '删除后所有买家都看不到它；历史订单仍保留商品快照。',
    });
    if (!sure) return;
    try { await api.del(`/api/admin/products/${id}`); toast('商品已删除'); load(); }
    catch (err) { toast(err.message, 'error'); }
  }

  panel.querySelector('#ad-search').addEventListener('click', () => {
    keyword = panel.querySelector('#ad-keyword').value.trim();
    categoryId = panel.querySelector('#ad-category').value;
    status = panel.querySelector('#ad-status').value;
    page = 1;
    load();
  });
  panel.querySelector('#ad-keyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panel.querySelector('#ad-search').click();
  });

  await load();
}

/* ================================================================ 举报审核 */
async function renderReports(panel) {
  let status = 'pending';
  let page = 1;

  panel.innerHTML = `
    <div class="tabs" id="rp-tabs"></div>
    <div class="card" id="rp-list">${loadingHtml()}</div>
    <div class="pagination" id="rp-pager"></div>`;

  const tabsEl = panel.querySelector('#rp-tabs');
  const listBox = panel.querySelector('#rp-list');
  const pager = panel.querySelector('#rp-pager');

  async function load() {
    listBox.innerHTML = loadingHtml();
    let data;
    try {
      data = await api.get(`/api/admin/reports${qs({ status, page, page_size: 10 })}`);
    } catch (err) {
      listBox.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
      return;
    }

    const counts = data.counts || {};
    tabsEl.innerHTML = `
      <button class="tab ${status === 'pending' ? 'active' : ''}" data-s="pending">待处理<span class="cnt">${counts.pending ?? 0}</span></button>
      <button class="tab ${status === 'handled' ? 'active' : ''}" data-s="handled">已处理<span class="cnt">${counts.handled ?? 0}</span></button>
      <button class="tab ${status === 'dismissed' ? 'active' : ''}" data-s="dismissed">已驳回<span class="cnt">${counts.dismissed ?? 0}</span></button>
      <button class="tab ${status === 'all' ? 'active' : ''}" data-s="all">全部</button>`;
    tabsEl.querySelectorAll('[data-s]').forEach(btn =>
      btn.addEventListener('click', () => { status = btn.dataset.s; page = 1; load(); }));

    if (!data.list.length) {
      listBox.innerHTML = emptyHtml(status === 'pending' ? '没有待处理的举报，很好' : '暂无记录', '✅');
      pager.innerHTML = '';
      return;
    }

    listBox.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>对象</th><th>类型</th><th>举报人</th><th>理由</th><th>状态</th><th>时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${data.list.map(r => {
              const target = r.target || {};
              const isProduct = r.target_type === 'product';
              const canHandle = r.status === 'pending';
              return `
              <tr>
                <td>${target.id ? `<span class="strong" data-target="${isProduct ? 'product' : 'post'}:${target.id}" style="cursor:pointer">${esc(target.title || '')}</span>` : '<span class="muted">对象已删除</span>'}</td>
                <td><span class="badge ${isProduct ? '' : 'badge-info'}">${isProduct ? '商品' : '帖子'}</span></td>
                <td>${esc(r.reporter_nickname || '')}</td>
                <td style="max-width:260px">${esc(r.reason)}</td>
                <td>${r.status === 'pending' ? '<span class="badge badge-warn">待处理</span>'
                     : r.status === 'handled' ? '<span class="badge">已处理</span>'
                     : '<span class="badge badge-gray">驳回</span>'}</td>
                <td class="muted small">${esc(fmtTime(r.created_at))}</td>
                <td>
                  <div class="ops">
                    ${canHandle ? `
                      <button class="btn btn-danger btn-sm" data-handle="${r.id}" data-type="${r.target_type}">
                        ${isProduct ? '下架商品' : '删除帖子'}
                      </button>
                      <button class="btn btn-sm" data-dismiss="${r.id}">驳回</button>` : '<span class="muted small">已处理</span>'}
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    listBox.querySelectorAll('[data-target]').forEach(el =>
      el.addEventListener('click', () => {
        const [type, id] = el.dataset.target.split(':');
        location.hash = type === 'product' ? `#/product/${id}` : `#/post/${id}`;
      }));

    listBox.querySelectorAll('[data-handle]').forEach(el =>
      el.addEventListener('click', async () => {
        const isProduct = el.dataset.type === 'product';
        const sure = await confirmDialog({
          title: isProduct ? '确认下架该商品？' : '确认删除该帖子？',
          danger: true, okText: isProduct ? '下架商品' : '删除帖子',
          message: '核实无误后执行，该举报会标记为「已处理」。',
        });
        if (!sure) return;
        try {
          await api.patch(`/api/admin/reports/${el.dataset.handle}`, { action: 'handle' });
          toast(isProduct ? '已下架被举报商品' : '已删除被举报帖子');
          load();
        } catch (err) { toast(err.message, 'error'); }
      }));

    listBox.querySelectorAll('[data-dismiss]').forEach(el =>
      el.addEventListener('click', async () => {
        const sure = await confirmDialog({ title: '驳回该举报？', okText: '驳回', message: '驳回后不会对商品或帖子做任何改动。' });
        if (!sure) return;
        try {
          await api.patch(`/api/admin/reports/${el.dataset.dismiss}`, { action: 'dismiss' });
          toast('已驳回该举报');
          load();
        } catch (err) { toast(err.message, 'error'); }
      }));

    renderPagination(pager, {
      page: data.page,
      pages: Math.max(1, Math.ceil(data.total / data.page_size)),
      total: data.total,
      onGo: (target) => { page = target; load(); },
    });
  }

  await load();
}

/* ================================================================ 基础数据 */
async function renderBaseData(panel) {
  const meta = await ensureMeta();
  panel.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>📚 分类</h2>
        <button class="btn btn-primary btn-sm" id="cat-add">➕ 新增分类</button>
      </div>
      <div class="table-wrap"><table class="table" id="cat-table"></table></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>🏷️ 小类</h2>
        <button class="btn btn-primary btn-sm" id="sub-add">➕ 新增小类</button>
      </div>
      <div class="table-wrap"><table class="table" id="sub-table"></table></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>📍 校园地点</h2>
        <button class="btn btn-primary btn-sm" id="place-add">➕ 新增地点</button>
      </div>
      <div class="table-wrap"><table class="table" id="place-table"></table></div>
    </div>`;

  const categories = await ensureCategories(true);
  const places = await ensurePlaces(true);

  /* ---------- 分类 ---------- */
  panel.querySelector('#cat-table').innerHTML = `
    <thead><tr><th>ID</th><th>图标</th><th>名称</th><th>排序</th><th>小类数</th><th>操作</th></tr></thead>
    <tbody>
      ${categories.map(c => `
        <tr>
          <td>${c.id}</td><td style="font-size:18px">${esc(c.icon)}</td><td>${esc(c.name)}</td>
          <td>${c.sort}</td><td>${(c.subcategories || []).length}</td>
          <td><div class="ops">
            <button class="btn btn-sm" data-edit-cat="${c.id}">编辑</button>
            <button class="btn btn-danger btn-sm" data-del-cat="${c.id}">删除</button>
          </div></td>
        </tr>`).join('')}
    </tbody>`;

  /* ---------- 小类 ---------- */
  panel.querySelector('#sub-table').innerHTML = `
    <thead><tr><th>ID</th><th>所属分类</th><th>名称</th><th>操作</th></tr></thead>
    <tbody>
      ${categories.flatMap(c => (c.subcategories || []).map(s => `
        <tr>
          <td>${s.id}</td><td>${esc(c.icon)} ${esc(c.name)}</td><td>${esc(s.name)}</td>
          <td><div class="ops">
            <button class="btn btn-sm" data-edit-sub="${s.id}" data-cat="${c.id}" data-name="${esc(s.name)}">编辑</button>
            <button class="btn btn-danger btn-sm" data-del-sub="${s.id}">删除</button>
          </div></td>
        </tr>`)).join('') || '<tr><td colspan="4" class="muted">还没有小类</td></tr>'}
    </tbody>`;

  /* ---------- 校园地点 ---------- */
  panel.querySelector('#place-table').innerHTML = `
    <thead><tr><th>ID</th><th>名称</th><th>类型</th><th>经度</th><th>纬度</th><th>排序</th><th>操作</th></tr></thead>
    <tbody>
      ${places.map(p => `
        <tr>
          <td>${p.id}</td><td>${esc(p.name)}</td><td>${esc(p.type)}</td>
          <td>${p.lng.toFixed(6)}</td><td>${p.lat.toFixed(6)}</td><td>${p.sort}</td>
          <td><div class="ops">
            <button class="btn btn-sm" data-edit-place="${p.id}">编辑</button>
            <button class="btn btn-danger btn-sm" data-del-place="${p.id}">删除</button>
          </div></td>
        </tr>`).join('')}
    </tbody>`;

  const refresh = async () => {
    invalidateCatalog();
    await renderBaseData(panel);
  };

  const categoryOptions = () => categories.map(c => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join('');

  /* ---------- 分类操作 ---------- */
  panel.querySelector('#cat-add').addEventListener('click', () => {
    openFormModal({
      title: '新增分类',
      fields: [
        { key: 'name', label: '分类名', required: true, placeholder: '例如：教材' },
        { key: 'icon', label: 'emoji 图标', placeholder: '例如：📚' },
        { key: 'sort', label: '排序（小的在前）', type: 'number', value: '0' },
      ],
      submit: (values) => api.post('/api/admin/categories', values),
      done: refresh,
    });
  });
  panel.querySelectorAll('[data-edit-cat]').forEach(btn =>
    btn.addEventListener('click', () => {
      const cat = categories.find(c => String(c.id) === btn.dataset.editCat);
      openFormModal({
        title: `编辑分类 #${cat.id}`,
        fields: [
          { key: 'name', label: '分类名', required: true, value: cat.name },
          { key: 'icon', label: 'emoji 图标', value: cat.icon },
          { key: 'sort', label: '排序', type: 'number', value: String(cat.sort) },
        ],
        submit: (values) => api.put(`/api/admin/categories/${cat.id}`, values),
        done: refresh,
      });
    }));
  panel.querySelectorAll('[data-del-cat]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const sure = await confirmDialog({ title: '确认删除该分类？', danger: true, okText: '删除', message: '分类下还有商品时无法删除。' });
      if (!sure) return;
      try { await api.del(`/api/admin/categories/${btn.dataset.delCat}`); toast('分类已删除'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));

  /* ---------- 小类操作 ---------- */
  panel.querySelector('#sub-add').addEventListener('click', () => {
    openFormModal({
      title: '新增小类',
      fields: [
        { key: 'category_id', label: '所属分类', type: 'select', options: categoryOptions(), required: true },
        { key: 'name', label: '小类名', required: true, placeholder: '例如：公共课教材' },
      ],
      submit: (values) => api.post('/api/admin/subcategories', values),
      done: refresh,
    });
  });
  panel.querySelectorAll('[data-edit-sub]').forEach(btn =>
    btn.addEventListener('click', () => {
      openFormModal({
        title: '编辑小类',
        fields: [
          { key: 'category_id', label: '所属分类', type: 'select', options: categoryOptions(), value: btn.dataset.cat },
          { key: 'name', label: '小类名', required: true, value: btn.dataset.name },
        ],
        submit: (values) => api.put(`/api/admin/subcategories/${btn.dataset.editSub}`, values),
        done: refresh,
      });
    }));
  panel.querySelectorAll('[data-del-sub]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const sure = await confirmDialog({ title: '确认删除该小类？', danger: true, okText: '删除' });
      if (!sure) return;
      try { await api.del(`/api/admin/subcategories/${btn.dataset.delSub}`); toast('小类已删除'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));

  /* ---------- 校园地点操作 ---------- */
  panel.querySelector('#place-add').addEventListener('click', () => {
    openFormModal({
      title: '新增校园地点',
      fields: [
        { key: 'name', label: '地点名', required: true, placeholder: '例如：图书馆南门' },
        { key: 'type', label: '类型', type: 'select', options: meta.place_types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('') },
        { key: 'lng', label: '经度（GCJ-02）', required: true, placeholder: '114.4140000' },
        { key: 'lat', label: '纬度（GCJ-02）', required: true, placeholder: '30.5110000' },
        { key: 'sort', label: '排序', type: 'number', value: '0' },
      ],
      submit: (values) => api.post('/api/admin/places', values),
      done: refresh,
    });
  });
  panel.querySelectorAll('[data-edit-place]').forEach(btn =>
    btn.addEventListener('click', () => {
      const place = places.find(p => String(p.id) === btn.dataset.editPlace);
      openFormModal({
        title: `编辑校园地点 #${place.id}`,
        fields: [
          { key: 'name', label: '地点名', required: true, value: place.name },
          { key: 'type', label: '类型', type: 'select',
            options: meta.place_types.map(t => `<option value="${esc(t)}" ${t === place.type ? 'selected' : ''}>${esc(t)}</option>`).join('') },
          { key: 'lng', label: '经度', required: true, value: String(place.lng) },
          { key: 'lat', label: '纬度', required: true, value: String(place.lat) },
          { key: 'sort', label: '排序', type: 'number', value: String(place.sort) },
        ],
        submit: (values) => api.put(`/api/admin/places/${place.id}`, values),
        done: refresh,
      });
    }));
  panel.querySelectorAll('[data-del-place]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const sure = await confirmDialog({
        title: '确认删除该校园地点？', danger: true, okText: '删除',
        message: '使用了该地点的商品与订单会变成「未指定自提点」。',
      });
      if (!sure) return;
      try { await api.del(`/api/admin/places/${btn.dataset.delPlace}`); toast('校园地点已删除'); refresh(); }
      catch (err) { toast(err.message, 'error'); }
    }));
}

/* ================================================================ 数据管理 */
async function renderDataManager(panel) {
  panel.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>💾 备份数据</h2></div>
      <p class="muted">把 14 张表的全部数据导出成一个 JSON 文件，同时会在服务器 <code>backups/</code> 目录留一份副本。</p>
      <div class="row">
        <button class="btn btn-primary" id="btn-backup">导出备份</button>
        <button class="btn" id="btn-refresh-backups">刷新列表</button>
      </div>
      <div class="divider"></div>
      <div class="table-wrap"><table class="table" id="backup-table"></table></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>♻️ 恢复数据</h2></div>
      <p class="muted">选择一个此前导出的备份文件，整体覆盖当前数据（<b style="color:var(--danger)">不可撤销</b>，请先确认已备份）。</p>
      <input type="file" id="restore-file" accept="application/json" style="display:none">
      <button class="btn btn-danger" id="btn-restore">选择备份文件并恢复</button>
    </div>

    <div class="card">
      <div class="card-head"><h2>🔄 重置示例数据</h2></div>
      <p class="muted">清空全部业务数据，重新写入课程演示用的示例数据（6 个账号、16 件商品、订单、帖子等）。</p>
      <button class="btn btn-danger" id="btn-reset">重置为示例数据</button>
    </div>`;

  const table = panel.querySelector('#backup-table');

  async function loadBackups() {
    table.innerHTML = '<tbody><tr><td class="muted">加载中…</td></tr></tbody>';
    let files;
    try {
      files = await api.get('/api/admin/backups');
    } catch (err) {
      table.innerHTML = `<tbody><tr><td class="muted">读取失败：${esc(err.message)}</td></tr></tbody>`;
      return;
    }
    table.innerHTML = `
      <thead><tr><th>文件名</th><th>大小</th><th>生成时间</th></tr></thead>
      <tbody>
        ${files.length ? files.map(f => `
          <tr><td>${esc(f.filename)}</td><td>${(f.size / 1024).toFixed(1)} KB</td><td>${esc(f.created_at)}</td></tr>`).join('')
          : '<tr><td colspan="3" class="muted">还没有备份文件</td></tr>'}
      </tbody>`;
  }

  panel.querySelector('#btn-backup').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const data = await api.post('/api/admin/backup');
      // 前端直接下载一份到本机
      const blob = new Blob([JSON.stringify(data.payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = data.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast(`备份完成：${data.filename}`);
      loadBackups();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  panel.querySelector('#btn-refresh-backups').addEventListener('click', loadBackups);

  const fileInput = panel.querySelector('#restore-file');
  panel.querySelector('#btn-restore').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const sure = await confirmDialog({
      title: '确认恢复数据？', danger: true, okText: '恢复',
      message: `将用「${file.name}」整体覆盖当前全部业务数据，此操作不可撤销。`,
    });
    if (!sure) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const result = await api.post('/api/admin/restore', payload);
      const total = Object.values(result.restored || {}).reduce((a, b) => a + b, 0);
      toast(`数据已恢复，共写入 ${total} 行`);
    } catch (err) {
      toast(`恢复失败：${err.message}`, 'error');
    }
  });

  panel.querySelector('#btn-reset').addEventListener('click', async () => {
    const sure = await confirmDialog({
      title: '确认重置为示例数据？', danger: true, okText: '重置',
      message: '当前全部商品、订单、帖子等数据都会被清空并替换为课程演示数据。',
    });
    if (!sure) return;
    try {
      await api.post('/api/admin/reset-demo');
      invalidateCatalog();
      toast('示例数据已重置');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  await loadBackups();
}

/* ================================================================ 通用表单弹窗 */
function openFormModal({ title, fields, submit, done }) {
  openModal({
    title,
    body: fields.map(field => {
      if (field.type === 'select') {
        return `
          <div class="form-row">
            <label>${esc(field.label)}${field.required ? '<span class="req">*</span>' : ''}</label>
            <select class="select" data-field="${field.key}">${field.options}</select>
          </div>`;
      }
      return `
        <div class="form-row">
          <label>${esc(field.label)}${field.required ? '<span class="req">*</span>' : ''}</label>
          <input class="input" data-field="${field.key}" type="${field.type || 'text'}"
                 value="${esc(field.value ?? '')}" placeholder="${esc(field.placeholder || '')}">
        </div>`;
    }).join(''),
    footer: `<button class="btn" data-close>取消</button>
             <button class="btn btn-primary" id="fm-submit">保存</button>`,
    onMount(modal, close) {
      modal.querySelector('#fm-submit').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const values = {};
        let missing = '';
        modal.querySelectorAll('[data-field]').forEach(input => {
          const field = fields.find(f => f.key === input.dataset.field);
          let value = input.value.trim();
          if (field.required && !value) missing = field.label;
          if (field.type === 'number' && value !== '') value = Number(value);
          values[field.key] = value;
        });
        if (missing) { toast(`请填写${missing}`, 'warn'); return; }

        button.disabled = true;
        try {
          await submit(values);
          close();
          toast('保存成功');
          if (done) done();
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      });
    },
  });
}
