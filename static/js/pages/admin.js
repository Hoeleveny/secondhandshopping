/* ==========================================================================
   M10 管理后台
   六个页签：商品管理 / 用户管理 / 交易管理 / 举报审核 / 基础数据 / 数据管理
   ========================================================================== */
import { api, qs } from '../api.js';
import { ensureCategories, ensureMeta, ensurePlaces, invalidateCatalog } from '../data.js';
import {
  avatarHtml, confirmDialog, emptyHtml, esc, fmtPrice, fmtTime, loadingHtml,
  openModal, ratingBadgeHtml, renderPagination, toast,
} from '../ui.js';

const TABS = [
  { key: 'products', label: '商品管理', icon: '📦' },
  { key: 'users', label: '用户管理', icon: '👥' },
  { key: 'trades', label: '交易管理', icon: '🧾' },
  { key: 'reports', label: '举报审核', icon: '🚩' },
  { key: 'base', label: '基础数据', icon: '🗂️' },
  { key: 'data', label: '数据管理', icon: '💾' },
];

/* 交易管理的自动刷新定时器：切入其它页签或离开本页时必须停掉，否则会一直打接口 */
let tradesTimer = null;

function stopTradesTimer() {
  if (tradesTimer) {
    clearInterval(tradesTimer);
    tradesTimer = null;
  }
}

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
      stopTradesTimer();   // 切页签先停掉上一个页面的自动刷新
      if (tab === 'products') return renderProducts(panel);
      if (tab === 'users') return renderUsers(panel);
      if (tab === 'trades') return renderTrades(panel);
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
          <input class="input" id="ad-keyword" placeholder="商品名 / 描述 / 编号">
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
                <td><span class="strong" data-open="${p.id}" style="cursor:pointer">${esc(p.name)}</span>
                  ${p.product_code ? `<div class="muted small" style="letter-spacing:.04em">${esc(p.product_code)}</div>` : ''}</td>
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

/* ================================================================ 交易管理（需求①）
   实时监管「多项交易并发」：进行中的交易按「挂得最久」排前面，每 5 秒自动刷新；
   管理员可强制取消 / 标记完成（复用订单接口，动作会记进操作日志）。
   下方「动态监控」是操作日志时间线——只靠 products.updated_at 看不出
   "改了什么、是不是多人在同时改"，所以关键动作都留了痕。                */
async function renderTrades(panel) {
  let status = 'pending';
  let keyword = '';
  let page = 1;
  let logAction = 'all';
  let logUser = '';
  let logProduct = '';
  let logOrder = '';
  let logFrom = '';
  let logTo = '';
  let logPage = 1;
  let logPagePath = '';          // 2026-10-18：按「浏览的页面」筛（与分页的 page 区分）
  // 2026-10-16 修复「选了几条又自己取消」：这条时间线有 5 秒自动刷新，每次都会整体重绘，
  // 勾选状态必须存在这个**独立集合**里（而不是只依赖 DOM 的 checked），重绘时再按它回填。
  const pickedLogs = new Set();
  // 2026-10-18：动态监控每 5 秒自动刷新会整块重绘，展开状态若只存在 DOM 上就会"自己合上"，
  // 所以和勾选一样存进集合，重绘后按它回填。
  const expandedGroups = new Set();
  // 会话行的删除要带「用户 + 时间范围」，渲染时把 key 对应的信息存起来
  let sessionIndex = new Map();

  panel.innerHTML = `
    <div class="grid grid-4 mb-16" id="td-stats">${loadingHtml()}</div>
    <div class="card">
      <div class="form-grid">
        <div class="form-row">
          <label>交易状态</label>
          <select class="select" id="td-status">
            <option value="pending">进行中（待完成）</option>
            <option value="all">全部</option>
            <option value="done">已完成</option>
            <option value="canceled">已取消</option>
          </select>
        </div>
        <div class="form-row">
          <label>关键词</label>
          <input class="input" id="td-keyword" placeholder="订单号 / 商品名 / 编号 / 买卖家">
        </div>
        <div class="form-row">
          <label>&nbsp;</label>
          <button class="btn btn-primary btn-block" id="td-search">查询</button>
        </div>
      </div>
      <div class="hint">进行中的交易按「挂得最久」排在最前；本页每 5 秒自动刷新一次；点上方任意卡片可看明细</div>
    </div>

    <div class="card mt-16" id="td-list">${loadingHtml()}</div>
    <div class="pagination" id="td-pager"></div>

    <div class="card mt-16">
      <div class="row-between mb-8">
        <h3 style="margin:0">动态监控</h3>
        <span class="muted small">业务动作 + 登录/登出/浏览页面都在这里；点业务动作可看详情</span>
      </div>
      <div class="grid grid-4 mb-8" id="lg-stats">${loadingHtml()}</div>
      <div class="form-grid mb-8">
        <div class="form-row">
          <label>按用户看使用小结</label>
          <input class="input" id="lg-profile-user" placeholder="用户名 / 昵称，回车或点右侧按钮">
        </div>
        <div class="form-row">
          <label>&nbsp;</label>
          <div class="row" style="gap:8px">
            <button class="btn btn-sm" id="lg-profile-go">查看使用小结</button>
            <button class="btn btn-ghost btn-sm" id="lg-profile-clear">收起</button>
          </div>
        </div>
      </div>
      <div id="lg-profile"></div>
      <div class="form-grid mb-8">
        <div class="form-row">
          <label>动作</label>
          <select class="select" id="lg-action"><option value="all">全部动作</option></select>
        </div>
        <div class="form-row">
          <label>动作发起人</label>
          <input class="input" id="lg-user" list="lg-user-list" placeholder="姓名 / 账号 / 编号，可只填一部分">
          <datalist id="lg-user-list"></datalist>
        </div>
        <div class="form-row">
          <label>商品（名称 / 编号）</label>
          <input class="input" id="lg-product" placeholder="如 保温杯 或 LF03-0002-260925-00006">
        </div>
        <div class="form-row">
          <label>订单号</label>
          <input class="input" id="lg-order" placeholder="如 CM20261015224541">
        </div>
        <div class="form-row">
          <label>浏览的页面</label>
          <select class="select" id="lg-page"><option value="">全部页面</option></select>
        </div>
        <div class="form-row">
          <label>动作时间（起）</label>
          <input class="input" type="date" id="lg-from">
        </div>
        <div class="form-row">
          <label>动作时间（止）</label>
          <input class="input" type="date" id="lg-to">
        </div>
        <div class="form-row">
          <label>&nbsp;</label>
          <div class="row" style="gap:8px">
            <button class="btn btn-primary" id="lg-search">筛选</button>
            <button class="btn" id="lg-reset">重置</button>
          </div>
        </div>
      </div>
      <div id="lg-list">${loadingHtml()}</div>
      <div class="pagination" id="lg-pager"></div>
    </div>`;

  const statCard = (label, value, icon) => `
    <div class="stat-card">
      <span class="sc-icon">${icon}</span>
      <div class="sc-label">${esc(label)}</div>
      <div class="sc-value">${value ?? 0}</div>
    </div>`;

  /* ---------------- 动态监控：单条日志详情（需求②）---------------- */
  const ROLE_TEXT = { buyer: '买家', seller: '卖家', admin: '管理员', '': '—' };

  function logDetailBody(d) {
    const log = d.log || {};
    const actor = d.actor || {};
    const order = d.order;
    const product = d.product;
    const extra = d.extra;

    const blocks = [];

    blocks.push(`<h4 class="detail-h">行为</h4>` + kvLines([
      ['动作', `<b>${esc(log.action_text || log.action)}</b>　<span class="muted small">${esc(log.action)}</span>`],
      ['发起人', `${esc(actor.nickname || '')}`
        + (actor.username ? `　<span class="muted small">@${esc(actor.username)}</span>` : '')
        + `　<span class="badge badge-gray">${esc(ROLE_TEXT[actor.role] ?? actor.role ?? '—')}</span>`],
      ['精确时间', `<b>${esc(log.created_at)}</b>`
        + (log.ago_text ? `　<span class="muted small">${esc(log.ago_text)}</span>` : '')],
    ], 2) + kvLines([['摘要', esc(log.summary || '—')]]));

    if (order) {
      blocks.push(`<h4 class="detail-h">相关交易</h4>` + kvLines([
        ['订单号', esc(order.order_no)],
        ['状态', `<span class="badge ${order.status === 'pending' ? 'badge-warn' : 'badge-gray'}">${esc(order.status_text)}</span>`],
        ['买家', esc(order.buyer?.nickname || '')],
        ['卖家', `${esc(order.seller?.nickname || '')}`
          + (order.seller?.seller_code ? `　<span class="muted small">卖家编号 ${esc(order.seller.seller_code)}</span>` : '')],
        ['成交金额', fmtPrice(order.price)],
        ['自提点', esc(order.meet_place || '未指定')],
        ['下单时间', `${esc(order.created_at)}　<span class="muted small">${esc(order.ago_text || '')}</span>`],
        order.finished_at ? ['完成/取消时间', esc(order.finished_at)] : null,
        order.trade_note ? ['交易说明', esc(order.trade_note)] : null,
      ], 2));
    }

    if (product) {
      blocks.push(`<h4 class="detail-h">相关商品</h4>` + kvLines([
        ['商品', `<b>${esc(product.name)}</b>`
          + (product.product_code ? `　<span class="muted small">${esc(product.product_code)}</span>` : '')],
        ['价格', fmtPrice(product.price)],
        ['状态', esc(product.status_text)],
        ['成色 / 分类', `${esc(product.condition || '—')}　·　${esc(product.category_name || '—')}`],
        ['卖家', esc(product.seller_nickname || '')],
        ['浏览量', `👁 ${product.views ?? 0}`],
      ], 2));
    }

    if (extra && extra.kind === 'review') {
      blocks.push(`<h4 class="detail-h">评价内容</h4>` + kvLines([
        ['评分', `${'★'.repeat(extra.rating || 0)}${'☆'.repeat(Math.max(0, 5 - (extra.rating || 0)))}（${extra.rating} 星）`],
        ['评价人', esc(extra.reviewer || '')],
        ['被评人', esc(extra.reviewee || '')],
        ['内容', esc(extra.content || '（未填写）')],
      ], 2));
    }

    if (extra && extra.kind === 'report') {
      blocks.push(`<h4 class="detail-h">举报内容</h4>` + kvLines([
        ['举报对象', esc(extra.target)],
        ['举报人', esc(extra.reporter || '')],
        ['处理状态', esc(extra.status)],
        ['举报理由', esc(extra.reason || '—')],
      ], 2));
    }

    if (extra && extra.kind === 'missing') {
      blocks.push(`<p class="muted small">${esc(extra.message)}</p>`);
    }

    if (d.links && d.links.length) {
      blocks.push(`<div class="row mt-16" style="gap:8px;justify-content:flex-end">`
        + d.links.map(l => `<button class="btn btn-sm" data-goto="${esc(l.hash)}">${esc(l.label)}</button>`).join('')
        + `</div>`);
    }

    return blocks.join('');
  }

  async function openLogDetail(logId) {
    let d;
    try {
      d = await api.get(`/api/admin/logs/${logId}`);
    } catch (err) {
      toast(`加载日志详情失败：${err.message}`, 'error');
      return;
    }
    openModal({
      title: d.log?.action_text || '操作日志',
      size: 'detail',
      body: logDetailBody(d),
      footer: `<button class="btn" data-copy-nick>📋 复制昵称</button>
                 <button class="btn" data-close>关闭</button>`,
      onMount(modal, close) {
        // 2026-10-18 需求②：一键复制昵称，方便拿去「动作发起人」里筛
        modal.querySelector('[data-copy-nick]')?.addEventListener('click',
          () => copyText(d.log?.nickname || d.log?.username, '昵称'));
        modal.querySelectorAll('[data-goto]').forEach(el =>
          el.addEventListener('click', () => {
            close();
            location.hash = el.dataset.goto;
          }));
      },
    });
  }

  /* ---------------- 状态卡下钻（需求①-新）---------------- */
  const CARD_DEFS = [
    { kind: 'pending', label: '进行中交易', icon: '⏳', value: (s) => s.pending },
    { kind: 'sellers', label: '涉及商家', icon: '🏪', value: (s) => s.sellers_in_trade },
    { kind: 'longest', label: '最长挂单', icon: '⏰', value: (s) => elapsedText(s.longest_pending_minutes) },
    { kind: 'today', label: '今日新增订单', icon: '🆕', value: (s) => s.today_orders },
  ];

  function statCardHtml(def, stats) {
    return `
      <div class="stat-card stat-clickable" data-stat="${def.kind}" role="button" tabindex="0"
           title="点击查看明细">
        <span class="sc-icon">${def.icon}</span>
        <div class="sc-label">${esc(def.label)}</div>
        <div class="sc-value">${def.value(stats) ?? 0}</div>
        <div class="sc-more">查看明细 ›</div>
      </div>`;
  }

  function rowsTable(rows) {
    return `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>订单号</th><th>商品</th><th>买家</th><th>卖家</th>
            <th class="text-right">金额</th><th>状态</th><th>已进行</th></tr></thead>
          <tbody>
            ${rows.map(o => `
              <tr class="clickable-row" data-goto="#/product/${o.product_id}">
                <td class="muted small">${esc(o.order_no)}</td>
                <td>
                  <span class="strong">${esc(o.product_name || '（商品已删除）')}</span>
                  ${o.product_code ? `<div class="muted small">${esc(o.product_code)}</div>` : ''}
                </td>
                <td>${esc(o.buyer_nickname || '')}</td>
                <td>${esc(o.seller_nickname || '')}</td>
                <td class="text-right price">${fmtPrice(o.price)}</td>
                <td><span class="badge ${o.status === 'pending' ? 'badge-warn' : 'badge-gray'}">${esc(o.status_text || o.status)}</span></td>
                <td class="small">${o.status === 'pending' ? elapsedText(o.elapsed_minutes) : esc(fmtTime(o.finished_at || o.created_at))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function sellersTable(rows) {
    return `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>商家</th><th>卖家编号</th><th>进行中</th><th>在售</th>
            <th>已售</th><th>好评率</th></tr></thead>
          <tbody>
            ${rows.map(s => `
              <tr class="clickable-row" data-goto="#/seller/${s.seller_id}">
                <td class="strong">${esc(s.nickname || '')}</td>
                <td class="muted small">${esc(s.seller_code || '未分配')}</td>
                <td><b>${s.pending}</b> 笔</td>
                <td>${s.on_sale} 件</td>
                <td>${s.sold} 件</td>
                <td>${s.rating && s.rating.total
                  ? `<span class="badge rating-${esc(s.rating.level)}">${s.rating.rate}% ${esc(s.rating.level_text)}</span>`
                  : '<span class="muted small">暂无评价</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function longestDetail(o) {
    const line = (k, v) => `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${v}</span></div>`;
    return `
      <div class="kv-list cols-2">
        ${line('订单号', esc(o.order_no))}
        ${line('商品', `<span class="strong">${esc(o.product_name || '（商品已删除）')}</span>`
          + (o.product_code ? ` <span class="muted small">${esc(o.product_code)}</span>` : ''))}
        ${line('买家', `${esc(o.buyer_nickname || '')}　<span class="muted small">历史下单 ${o.buyer_order_count} 笔</span>`)}
        ${line('卖家', `${esc(o.seller_nickname || '')}`
          + (o.seller_code ? `　<span class="muted small">卖家编号 ${esc(o.seller_code)}</span>` : '')
          + `　<span class="muted small">该商家还有 ${o.seller_pending_count} 笔进行中</span>`)}
        ${line('成交金额', fmtPrice(o.price))}
        ${line('自提点', esc(o.meet_place?.name || '未指定'))}
        ${line('下单时间', esc(fmtTime(o.created_at)))}
        ${line('已进行', `<b>${elapsedText(o.elapsed_minutes)}</b>`)}
        ${line('商品浏览', o.product_views == null ? '—' : `👁 ${o.product_views}`)}
        ${o.trade_note ? line('交易说明', esc(o.trade_note)) : ''}
      </div>
      <div class="row mt-16" style="gap:8px;justify-content:flex-end">
        <button class="btn btn-sm" data-goto="#/product/${o.product_id}">查看商品</button>
        <button class="btn btn-sm" data-goto="#/seller/${o.seller_id}">查看卖家主页</button>
      </div>`;
  }

  async function openStatDetail(kind) {
    let data;
    try {
      data = await api.get(`/api/admin/orders/detail${qs({ type: kind })}`);
    } catch (err) {
      toast(`加载明细失败：${err.message}`, 'error');
      return;
    }

    // 明细弹窗要「一屏看全、不出滚动条」，所以列表类明细必须有个行数上限——
    // 行数不封顶的话内容高度就无上限，再宽的弹窗也终会溢出。
    // 每行实测约 55px，取 6 行 ⇒ 内容区约 330px，连 1280x700 这种矮窗口也放得下。
    // 这几张卡本来就是概览，完整列表在「交易管理」页签（带搜索与分页）。
    const DETAIL_ROWS = 6;
    let list = data.list || [];
    let hidden = 0;
    if (data.type !== 'longest' && list.length > DETAIL_ROWS) {
      hidden = list.length - DETAIL_ROWS;
      list = list.slice(0, DETAIL_ROWS);
    }

    let body;
    if (data.type === 'longest') {
      body = data.order ? longestDetail(data.order) : emptyHtml('当前没有进行中的交易', '✅');
    } else if (!list.length) {
      body = emptyHtml(data.type === 'today' ? '今天还没有新订单' : '没有符合条件的记录', '📭');
    } else {
      body = (data.type === 'sellers' ? sellersTable(list) : rowsTable(list))
        + (hidden
          ? `<div class="row mt-8 muted small">仅列出前 ${DETAIL_ROWS} 条，另有 ${hidden} 条——`
            + `完整列表请到「交易管理」页签（可搜索）</div>`
          : '');
    }

    openModal({
      title: data.title || '明细',
      size: 'detail',
      body: `<div class="muted small mb-8">${esc(data.subtitle || '')}</div>${body}`,
      footer: '<button class="btn" data-close>关闭</button>',
      onMount(modal, close) {
        modal.querySelectorAll('[data-goto]').forEach(el =>
          el.addEventListener('click', () => {
            close();
            location.hash = el.dataset.goto;
          }));
      },
    });
  }

  const STATUS_BADGE = {
    pending: ['badge badge-warn', '进行中'],
    done: ['badge', '已完成'],
    canceled: ['badge badge-gray', '已取消'],
  };

  function elapsedText(minutes) {
    if (minutes == null) return '—';
    if (minutes < 60) return `${minutes} 分钟`;
    if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
    return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时`;
  }

  /* ---------------- 交易列表 ---------------- */
  async function loadTrades(silent = false) {
    const box = panel.querySelector('#td-list');
    if (!box) return;
    if (!silent) box.innerHTML = loadingHtml();
    let data;
    try {
      data = await api.get(`/api/admin/orders${qs({ status, keyword, page, page_size: 15 })}`);
    } catch (err) {
      box.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
      return;
    }

    const stats = data.stats || {};
    const statsBox = panel.querySelector('#td-stats');
    statsBox.innerHTML = CARD_DEFS.map(def => statCardHtml(def, stats)).join('');
    // 卡片是可点的（下钻明细），每次自动刷新都会重建，所以要重新绑一次
    statsBox.querySelectorAll('[data-stat]').forEach(el => {
      el.addEventListener('click', () => openStatDetail(el.dataset.stat));
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openStatDetail(el.dataset.stat);
        }
      });
    });

    if (!data.list.length) {
      box.innerHTML = emptyHtml(
        status === 'pending' ? '当前没有进行中的交易' : '没有符合条件的交易', '🧾');
      renderPagination(panel.querySelector('#td-pager'), { page: 1, pages: 1, total: 0, onGo: () => {} });
      return;
    }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>订单号</th><th>商品</th><th>买家</th><th>卖家</th>
                <th class="text-right">金额</th><th>自提点</th><th>状态</th>
                <th>已进行</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${data.list.map(o => {
              const [cls, text] = STATUS_BADGE[o.status] || ['badge', o.status_text || o.status];
              return `
              <tr>
                <td class="muted small">${esc(o.order_no)}</td>
                <td>
                  <span class="strong" data-open="${o.product_id}" style="cursor:pointer">${esc(o.product_name || '（商品已删除）')}</span>
                  ${o.product_code ? `<div class="muted small" style="letter-spacing:.04em">${esc(o.product_code)}</div>` : ''}
                </td>
                <td>${esc(o.buyer_nickname || '')}</td>
                <td>${esc(o.seller_nickname || '')}</td>
                <td class="text-right price">${fmtPrice(o.price)}</td>
                <td class="small">${esc(o.meet_place?.name || '未指定')}</td>
                <td><span class="${cls}">${esc(text)}</span></td>
                <td class="small">${o.status === 'pending' ? elapsedText(o.elapsed_minutes) : esc(fmtTime(o.finished_at || o.created_at))}</td>
                <td>
                  <div class="ops">
                    ${o.status === 'pending' ? `
                      <button class="btn btn-sm" data-finish="${o.id}">标记完成</button>
                      <button class="btn btn-danger btn-sm" data-cancel="${o.id}">强制取消</button>` : '—'}
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;

    renderPagination(panel.querySelector('#td-pager'), {
      page: data.page,
      pages: Math.max(1, Math.ceil(data.total / data.page_size)),
      total: data.total,
      onGo: (p) => { page = p; loadTrades(); },
    });

    box.querySelectorAll('[data-open]').forEach(el =>
      el.addEventListener('click', () => { location.hash = `#/product/${el.dataset.open}`; }));

    box.querySelectorAll('[data-finish]').forEach(btn =>
      btn.addEventListener('click', async () => {
        const sure = await confirmDialog({
          title: '确认把这笔交易标记为已完成？', okText: '标记完成',
          message: '用于买卖双方忘记点「确认完成」的情况。标记后商品保持已售，双方仍可评价。',
        });
        if (!sure) return;
        try {
          await api.patch(`/api/orders/${btn.dataset.finish}/complete`);
          toast('已标记交易完成');
          await loadTrades(true);
          await loadLogs(true);
        } catch (err) {
          toast(err.message, 'error');
        }
      }));

    box.querySelectorAll('[data-cancel]').forEach(btn =>
      btn.addEventListener('click', async () => {
        const sure = await confirmDialog({
          title: '确认强制取消这笔交易？', danger: true, okText: '强制取消',
          message: '取消后商品会恢复在售，买卖双方都会看到订单已取消。请先确认双方已协商一致。',
        });
        if (!sure) return;
        try {
          await api.patch(`/api/orders/${btn.dataset.cancel}/cancel`);
          toast('已强制取消，商品恢复在售');
          await loadTrades(true);
          await loadLogs(true);
        } catch (err) {
          toast(err.message, 'error');
        }
      }));
  }

  /* ---------------- 动态监控：今日概览 / 按用户使用小结（2026-10-18 需求①）---------------- */
  async function renderLogSummary() {
    const statsBox = panel.querySelector('#lg-stats');
    if (!statsBox) return;
    let data;
    try {
      data = await api.get('/api/admin/activities/summary');
    } catch (err) {
      statsBox.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
      return;
    }
    const t = data.today || {};
    const card = (icon, label, num, hint) => `
      <div class="stat-card">
        <span class="sc-icon">${icon}</span>
        <div class="sc-label">${esc(label)}</div>
        <div class="sc-value">${esc(String(num ?? 0))}</div>
        <div class="sc-more">${esc(hint || '')}</div>
      </div>`;
    statsBox.innerHTML = [
      card('🔑', '今日登录', t.login, '含管理员'),
      card('👋', '今日登出', t.logout, '主动退出'),
      card('👣', '今日页面浏览', t.page, `累计 ${data.total ?? 0} 条行为`),
      card('🔥', '今日活跃用户', t.users, `近 7 天 ${data.week_active_users ?? 0} 人`),
    ].join('');

    // 「浏览的页面」下拉：用出现过的页面（按访问次数排序）
    const pageSel = panel.querySelector('#lg-page');
    if (pageSel && !pageSel.dataset.filled) {
      let pages = data.top_pages || [];
      try {
        const extra = await api.get('/api/admin/activities?page_size=1');
        if ((extra.pages || []).length) pages = extra.pages;
      } catch (err) { /* 用 summary 的 Top 兜底 */ }
      pageSel.innerHTML = '<option value="">全部页面</option>'
        + pages.map(p => `<option value="${esc(p.page)}">${esc(p.name)}（${p.count}）</option>`).join('');
      pageSel.dataset.filled = '1';
    }
  }

  async function showUserProfile(kw) {
    const box = panel.querySelector('#lg-profile');
    if (!box) return;
    if (!kw) { box.innerHTML = ''; return; }
    box.innerHTML = loadingHtml();
    let data;
    try {
      data = await api.get(`/api/admin/activities/profile${qs({ user: kw })}`);
    } catch (err) {
      box.innerHTML = emptyHtml(`没查到：${err.message}`, '🔍');
      return;
    }
    const u = data.user || {};
    const pages = (data.top_pages || []).map((p, i) =>
      `<li>${i + 1}. ${esc(p.name)} <span class="muted small">${esc(p.page)} · ${p.count} 次</span></li>`).join('');
    const sessions = (data.recent_sessions || []).map(s =>
      `<li>${esc(s.login_at.slice(5))} → ${esc((s.end_at || '').slice(5) || '进行中')} · ${esc(s.duration_text)}${s.closed ? '' : ' · 未正常退出'}</li>`).join('');
    box.innerHTML = `
      <div class="card mb-8">
        <div class="row-between mb-8">
          <div class="row" style="gap:10px;align-items:center">
            ${avatarHtml(u, 36)}
            <div><b>${esc(u.nickname || '')}</b> <span class="muted small">@${esc(u.username || '')}</span>
              <button class="btn btn-ghost btn-sm" id="lg-profile-copy" title="复制昵称">📋</button></div>
          </div>
          <span class="muted small">最近活跃 ${esc(data.last_active || '—')}</span>
        </div>
        <div class="grid grid-4 mb-8">
          <div class="stat-card"><div class="sc-label">登录次数</div><div class="sc-value">${data.login_count}</div><div class="sc-more">登出 ${data.logout_count} 次</div></div>
          <div class="stat-card"><div class="sc-label">累计使用时长</div><div class="sc-value">${esc(data.total_text)}</div><div class="sc-more">平均每次 ${esc(data.avg_text)}</div></div>
          <div class="stat-card"><div class="sc-label">浏览页面数</div><div class="sc-value">${data.page_count}</div><div class="sc-more">按次计</div></div>
          <div class="stat-card"><div class="sc-label">常去页面</div><div class="sc-value">${(data.top_pages || [])[0] ? esc(data.top_pages[0].name) : '—'}</div><div class="sc-more">见右侧清单</div></div>
        </div>
        ${(() => {
          const ut = data.utype || {};
          const bars = (ut.breakdown || []).map(b => `
            <div class="tgi-row">
              <span class="tgi-kind">${esc(b.name)}</span>
              <span class="tgi-title">${b.count} 次 · ${Math.round((b.share || 0) * 100)}%</span>
            </div>`).join('');
          const tags = (ut.post_breakdown || []).map(b => `
            <div class="tgi-row"><span class="tgi-kind tgi-post">${esc(b.name)}</span>
              <span class="tgi-title">${b.count} 次 · ${Math.round((b.share || 0) * 100)}%</span></div>`).join('');
          return `
          <div class="card mb-8" style="box-shadow:none;border:1px solid var(--border)">
            <div class="row wrap mb-8" style="gap:10px;align-items:center">
              <span class="badge badge-info" style="font-size:13px">用户类型：${esc(ut.main || '—')}</span>
              ${ut.focus ? `<span class="badge">${esc(ut.focus)}</span>` : ''}
              <span class="muted small">${esc(ut.reason || '')}</span>
            </div>
            <div class="grid" style="grid-template-columns:1fr 1fr;gap:16px">
              <div><div class="muted small mb-8">商品分类偏好（共 ${ut.product_total || 0} 次浏览）</div>
                ${bars || '<div class="muted small">还没有浏览商品</div>'}</div>
              <div><div class="muted small mb-8">帖子关注点（共 ${ut.post_total || 0} 次浏览）</div>
                ${tags || '<div class="muted small">还没有浏览帖子</div>'}</div>
            </div>
            <div class="muted small" style="margin-top:8px">归类规则：${esc(ut.rule || '')}</div>
          </div>`;
        })()}
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:16px">
          <div><div class="muted small mb-8">最常去的 5 个页面</div>
            ${pages ? `<ul class="plain-list">${pages}</ul>` : '<div class="muted small">暂无浏览记录</div>'}</div>
          <div><div class="muted small mb-8">最近的会话（最长 5 条）</div>
            ${sessions ? `<ul class="plain-list">${sessions}</ul>` : '<div class="muted small">暂无登录记录</div>'}</div>
        </div>
      </div>`;
    box.querySelector('#lg-profile-copy')?.addEventListener('click',
      () => copyText(u.nickname || u.username, '昵称'));
  }

  /* ---------------- 动态监控：行渲染（业务日志 / 登录登出 / 浏览折叠组）---------------- */
  /**
   * 2026-10-18 需求②：浏览记录默认**折叠成一组**（后端按「同一用户、间隔 ≤30 分钟」分好组），
   * 组内突出商品页与帖子页（带真名、可直接点进去），其它页面（首页/搜索等）只给个数。
   */
  function logRowHtml(log) {
    const key = log.key || ('log-' + log.id);
    if (log.source === 'session') {
      const span = `${esc((log.start_at || '').slice(5, 16))} ~ ${esc((log.end_at || '').slice(11, 16))}`;
      const items = (log.items || []).map(it => {
        const label = it.kind === 'product' ? '商品' : (it.kind === 'post' ? '帖子' : '页面');
        return `
          <div class="tgi-row">
            <span class="tgi-kind tgi-${esc(it.kind)}">${label}</span>
            <a class="tgi-title" href="#${esc(it.page)}" title="${esc(it.page)}">${esc(it.title)}</a>
            <span class="muted small">${esc((it.at || '').slice(5, 16))}</span>
          </div>`;
      }).join('');
      sessionIndex.set(key, { user_id: log.user_id, start_at: log.session_start,
                             end_at: log.session_end });
      return `
        <div class="tl-item tl-group" data-source="session" data-group="${esc(key)}" data-key="${esc(key)}"
             data-ses-user="${esc(String(log.user_id))}" data-ses-start="${esc(log.session_start || '')}"
             data-ses-end="${esc(log.session_end || '')}"
             role="button" tabindex="0" title="点开 / 收起这次会话看过的页面">
          <label class="tl-check-box" title="选中后可批量删除这次会话的记录">
            <input type="checkbox" class="tl-check" data-check="${esc(key)}"
                   ${pickedLogs.has(key) ? 'checked' : ''}>
          </label>
          <span class="tl-time muted small">${span}</span>
          <span class="tl-who">${esc(log.nickname || log.username || '')}</span>
          <span class="tl-action">${esc(log.action_text)}</span>
          <span class="tl-summary muted">${esc(log.summary)} <b class="tl-toggle">${expandedGroups.has(key) ? '收起 ▾' : '展开 ▸'}</b></span>
          <button class="btn btn-ghost btn-sm tl-del" data-session-del="${esc(key)}"
                  title="删除这次会话的全部记录">🗑</button>
        </div>
        <div class="tl-group-items" data-for="${esc(key)}" ${expandedGroups.has(key) ? '' : 'hidden'}>
          ${items || '<div class="tgi-row muted small">这一串里没有商品页或帖子页</div>'}
          ${log.other_count ? `<div class="tgi-row muted small">另有 ${log.other_count} 次浏览首页 / 搜索等其它页面</div>` : ''}
        </div>`;
    }
    const isActivity = log.source === 'activity';
    return `
      <div class="tl-item clickable" ${isActivity ? '' : `data-log="${log.id}"`}
           data-source="${log.source || 'log'}" data-key="${esc(key)}" role="button" tabindex="0"
           title="${isActivity ? '用户行为记录（登录 / 登出 / 浏览）' : '点击查看这条动作的详细交易信息'}">
        <label class="tl-check-box" title="选中后可批量删除这条记录">
          <input type="checkbox" class="tl-check" data-check="${esc(key)}"
                 ${pickedLogs.has(key) ? 'checked' : ''}>
        </label>
        <span class="tl-time muted small">${esc(fmtTime(log.created_at))}</span>
        <span class="tl-who">${esc(log.nickname || log.username || '系统')}</span>
        <span class="tl-action">${esc(log.action_text)}</span>
        <span class="tl-summary muted">${esc(log.summary)}</span>
        ${isActivity ? '<span class="tl-del-ph"></span>'
          : `<button class="btn btn-ghost btn-sm tl-del" data-del="${log.id}"
                     title="删除这条操作记录">🗑</button>`}
      </div>`;
  }

  /** 复制文本（局域网 http 访问时 navigator.clipboard 不可用，要有兜底） */
  async function copyText(text, label) {
    const value = String(text || '').trim();
    if (!value) { toast('没有可复制的内容', 'error'); return; }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(`已复制${label || ''}「${value}」`);
    } catch (err) {
      toast(`复制失败：${err.message}`, 'error');
    }
  }

  /* ---------------- 动态监控（操作日志时间线 + 多条件筛选）---------------- */
  async function loadLogs(silent = false) {
    const box = panel.querySelector('#lg-list');

    // 2026-10-18 需求①：会话行末尾的 🗑 用事件委托（容器稳定，赋值型绑定不会重复叠加）
    box.onclick = (event) => {
      const del = event.target.closest('[data-session-del]');
      if (!del) return;
      event.stopPropagation();
      removeLogs([del.dataset.sessionDel]);
    };
    if (!box) return;
    if (!silent) box.innerHTML = loadingHtml();
    let data;
    try {
      data = await api.get(`/api/admin/logs${qs({
        action: logAction, user: logUser, product: logProduct,
        order_no: logOrder, page_path: logPagePath,
        date_from: logFrom, date_to: logTo,
        page: logPage, page_size: 20,
      })}`);
    } catch (err) {
      box.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
      return;
    }

    // 两个下拉的选项来自库里实际出现过的动作与发起人（保留当前选中值）
    const actionSel = panel.querySelector('#lg-action');
    if (data.actions) {
      const current = actionSel.value;
      actionSel.innerHTML = `<option value="all">全部动作</option>`
        + data.actions.map(a => `<option value="${esc(a.action)}">${esc(a.text)}</option>`).join('');
      actionSel.value = current || 'all';
    }
    // 需求②：发起人改成自由输入，这里把库里出现过的发起人塞进候选列表（可点选可手输）
    const userList = panel.querySelector('#lg-user-list');
    if (userList && data.actors) {
      userList.innerHTML = data.actors.map(a => {
        const name = a.nickname || a.username || '';
        const hint = [a.username ? `@${a.username}` : '', a.id ? `编号 ${a.id}` : '']
          .filter(Boolean).join(' · ');
        return `<option value="${esc(name)}">${esc(hint)}</option>`;
      }).join('');
    }

    if (!data.list.length) {
      box.innerHTML = emptyHtml('没有符合条件的操作记录', '📋');
      renderPagination(panel.querySelector('#lg-pager'),
        { page: 1, pages: 1, total: 0, onGo: () => {} });
      return;
    }

    box.innerHTML = `
      <div class="row-between mb-8">
        <label class="row" style="gap:6px;align-items:center;cursor:pointer">
          <input type="checkbox" id="lg-check-all">
          <span class="muted small">全选本页</span>
        </label>
        <button class="btn btn-danger btn-sm" id="lg-del-selected" disabled>🗑 删除选中（0）</button>
      </div>
      <div class="timeline">
        ${data.list.map(logRowHtml).join('')}
      </div>`;

    // 2026-10-18 需求②：浏览记录组的展开 / 收起
    box.querySelectorAll('[data-group]').forEach(el =>
      el.addEventListener('click', () => {
        const key = el.dataset.group;
        const items = box.querySelector(`.tl-group-items[data-for="${key}"]`);
        if (!items) return;
        const open = !expandedGroups.has(key);
        if (open) expandedGroups.add(key); else expandedGroups.delete(key);
        items.hidden = !open;
        const tgl = el.querySelector('.tl-toggle');
        if (tgl) tgl.textContent = open ? '收起 ▾' : '展开 ▸';
      }));
    // 需求②：点条目看详情（发起人、精确时间、相关订单与商品）
    // 注意：勾选区域与删除按钮的点击要**完全避开**详情弹窗，否则勾选时稍微点偏就弹详情
    box.querySelectorAll('[data-log]').forEach(el => {
      if (el.dataset.source === 'activity') return;   // 行为记录没有交易详情
      el.addEventListener('click', (event) => {
        if (event.target.closest('.tl-check-box, .tl-del')) return;
        openLogDetail(el.dataset.log);
      });
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openLogDetail(el.dataset.log);
        }
      });
    });

    // 新批需求②：勾选后可删除选定的操作记录（删除动作本身也会留一条日志）
    // 2026-10-16 修复：勾选状态以 pickedLogs 为准，重绘（5 秒自动刷新）后据此回填，不再被冲掉
    const checkAll = box.querySelector('#lg-check-all');
    const delBtn = box.querySelector('#lg-del-selected');
    const selectedIds = () => [...pickedLogs];
    const syncDel = () => {
      const n = pickedLogs.size;
      const pageChecks = [...box.querySelectorAll('.tl-check')];
      const pageChecked = pageChecks.filter(el => el.checked).length;
      if (delBtn) {
        delBtn.textContent = `🗑 删除选中（${n}）`;
        delBtn.disabled = n === 0;
      }
      if (checkAll) {
        checkAll.checked = pageChecks.length > 0 && pageChecked === pageChecks.length;
        checkAll.indeterminate = pageChecked > 0 && pageChecked < pageChecks.length;
      }
    };
    const removeLogs = async (ids) => {
      if (!ids.length) return;
      const sure = await confirmDialog({
        title: ids.length === 1 ? '删除这条操作记录？' : `删除选中的 ${ids.length} 条操作记录？`,
        danger: true, okText: '删除记录',
        message: '操作日志是审计留痕，删掉之后这些记录就查不回来了；'
          + '删除这个动作本身会留下一条新日志，方便日后追溯。',
      });
      if (!sure) return;
      try {
        // 2026-10-18：时间线里混了「操作日志」与「用户行为」两类，按 key 前缀分流到各自接口
        const logIds = ids.filter(id => String(id).startsWith('log-')).map(id => Number(String(id).slice(4)));
        const actIds = ids.filter(id => String(id).startsWith('act-')).map(id => Number(String(id).slice(4)));
        const sesKeys = ids.filter(id => String(id).startsWith('ses-'));
        let total = 0;
        if (logIds.length) total += (await api.post('/api/admin/logs/delete', { ids: logIds })).deleted || 0;
        if (actIds.length) total += (await api.post('/api/admin/activities/delete', { ids: actIds })).deleted || 0;
        for (const k of sesKeys) {
          // 优先从这一行的 data-ses-* 读（会话行一定在页面上；sessionIndex 只作兜底）
          const row = document.querySelector(`#lg-list .tl-item[data-key="${k}"]`);
          const info = row
            ? { user_id: Number(row.dataset.sesUser), start_at: row.dataset.sesStart,
                end_at: row.dataset.sesEnd }
            : sessionIndex.get(k);
          if (!info || !info.user_id) continue;
          total += (await api.post('/api/admin/activities/delete-session', info)).deleted || 0;
        }
        ids.forEach(id => pickedLogs.delete(id));   // 删掉的从选中集合里去掉
        toast(`已删除 ${total} 条记录`);
        loadLogs();
        renderLogSummary();
      } catch (err) { toast(err.message, 'error'); }
    };
    checkAll?.addEventListener('change', () => {
      box.querySelectorAll('.tl-check').forEach(el => {
        el.checked = checkAll.checked;
        const key = el.dataset.check;      // 2026-10-18：现在是 key（log-xx / act-xx），不能转数字
        if (checkAll.checked) pickedLogs.add(key); else pickedLogs.delete(key);
      });
      syncDel();
    });
    box.querySelectorAll('.tl-check').forEach(el =>
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        const key = el.dataset.check;      // key 形如 log-12 / act-34，不能转数字
        if (el.checked) pickedLogs.add(key); else pickedLogs.delete(key);
        syncDel();
      }));
    delBtn?.addEventListener('click', () => removeLogs(selectedIds()));
    box.querySelectorAll('[data-del]').forEach(btn =>
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        removeLogs([Number(btn.dataset.del)]);
      }));
    syncDel();

    renderPagination(panel.querySelector('#lg-pager'), {
      page: data.page,
      pages: Math.max(1, Math.ceil(data.total / data.page_size)),
      total: data.total,
      onGo: (p) => { logPage = p; loadLogs(); },
      jump: true,
    });
  }

  /* ---------------- 交互绑定 ---------------- */
  panel.querySelector('#td-status').addEventListener('change', (e) => {
    status = e.target.value;
    page = 1;
    loadTrades();
  });
  panel.querySelector('#td-search').addEventListener('click', () => {
    keyword = panel.querySelector('#td-keyword').value.trim();
    page = 1;
    loadTrades();
  });
  panel.querySelector('#td-keyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panel.querySelector('#td-search').click();
  });
  // ---- 动态监控的多条件筛选（需求③）----
  panel.querySelector('#lg-profile-go')?.addEventListener('click', () => {
    showUserProfile(panel.querySelector('#lg-profile-user').value.trim());
  });
  panel.querySelector('#lg-profile-user')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') panel.querySelector('#lg-profile-go').click();
  });
  panel.querySelector('#lg-profile-clear')?.addEventListener('click', () => {
    panel.querySelector('#lg-profile-user').value = '';
    panel.querySelector('#lg-profile').innerHTML = '';
  });

  panel.querySelector('#lg-action').addEventListener('change', (e) => {
    logAction = e.target.value;
    logPage = 1;
    loadLogs();
  });
  const readLogFilters = () => {
    logUser = panel.querySelector('#lg-user').value.trim();
    logPagePath = panel.querySelector('#lg-page') ? panel.querySelector('#lg-page').value : '';
    logProduct = panel.querySelector('#lg-product').value.trim();
    logOrder = panel.querySelector('#lg-order').value.trim();
    logFrom = panel.querySelector('#lg-from').value;
    logTo = panel.querySelector('#lg-to').value;
    logPage = 1;
  };
  panel.querySelector('#lg-search').addEventListener('click', () => {
    readLogFilters();
    loadLogs();
  });
  ['#lg-user', '#lg-product', '#lg-order'].forEach((sel) => {
    const el = panel.querySelector(sel);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        readLogFilters();
        loadLogs();
      }
    });
    // 从候选列表里点选后立即生效，不用再按「筛选」
    el.addEventListener('change', () => {
      readLogFilters();
      loadLogs();
    });
  });
  panel.querySelector('#lg-reset').addEventListener('click', () => {
    ['#lg-product', '#lg-order', '#lg-from', '#lg-to'].forEach((sel) => {
      panel.querySelector(sel).value = '';
    });
    panel.querySelector('#lg-user').value = '';
    panel.querySelector('#lg-action').value = 'all';
    logAction = 'all';
    logUser = '';
    logProduct = '';
    logOrder = '';
    logFrom = '';
    logTo = '';
    logPage = 1;
    loadLogs();
  });

  await loadTrades();
  await Promise.all([loadLogs(), renderLogSummary()]);

  // 每 5 秒刷新一次；离开本页（面板被卸载）就自动停掉
  stopTradesTimer();
  tradesTimer = setInterval(() => {
    if (!panel.isConnected) { stopTradesTimer(); return; }
    loadTrades(true);
    loadLogs(true);
  }, 5000);
}

/* 键值明细渲染（模块级：管理后台里多处复用，包括用户详情弹窗） */
function kvLines(pairs, cols = 1) {
  return `<div class="kv-list${cols > 1 ? ' cols-2' : ''}">${pairs.filter(Boolean).map(([k, v]) =>
    `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${v}</span></div>`).join('')}</div>`;
}

/* ================================================================ 用户管理（新批需求①） */
async function renderUsers(panel) {
  let page = 1;
  let keyword = '';
  let status = 'all';

  panel.innerHTML = `
    <div class="card mb-8">
      <div class="row-between mb-8">
        <h3 style="margin:0">用户管理</h3>
        <span class="muted small">可查看用户主页与详细信息，并封禁 / 解封账号（到期自动解封）</span>
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label>搜索用户</label>
          <input class="input" id="u-keyword" placeholder="昵称 / 用户名，可只填一部分">
        </div>
        <div class="form-row">
          <label>状态</label>
          <select class="select" id="u-status">
            <option value="all">全部</option>
            <option value="normal">正常</option>
            <option value="banned">已封禁</option>
          </select>
        </div>
        <div class="form-row">
          <label>&nbsp;</label>
          <div class="row" style="gap:8px">
            <button class="btn btn-primary" id="u-search">搜索</button>
            <button class="btn" id="u-reset">重置</button>
          </div>
        </div>
      </div>
      <div class="muted small" id="u-summary"></div>
    </div>
    <div class="card" id="u-list">${loadingHtml()}</div>
    <div class="pagination" id="u-pager"></div>`;

  async function load() {
    const box = panel.querySelector('#u-list');
    box.innerHTML = loadingHtml();
    let data;
    try {
      data = await api.get(`/api/admin/users${qs({ keyword, status, page, page_size: 15 })}`);
    } catch (err) {
      box.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
      return;
    }
    panel.querySelector('#u-summary').textContent =
      `共 ${data.counts.all} 位用户，其中被封禁 ${data.counts.banned} 位`;

    if (!data.list.length) {
      box.innerHTML = emptyHtml(keyword ? '没有匹配的用户' : '暂无用户', '👥');
      renderPagination(panel.querySelector('#u-pager'),
        { page: 1, pages: 1, total: 0, onGo: () => {} });
      return;
    }

    box.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>
            <th>用户</th><th>注册时间</th><th>商品</th><th>订单</th><th>帖子</th>
            <th>收到评价</th><th>好评率</th><th>状态</th><th>操作</th>
          </tr></thead>
          <tbody>
            ${data.list.map(u => `
              <tr class="clickable-row" data-uid="${u.id}" title="点击查看这位用户的详细信息">
                <td>
                  <div class="row" style="gap:8px;align-items:center">
                    ${avatarHtml(u, 30)}
                    <span class="strong">${esc(u.nickname)}</span>
                    <span class="muted small">@${esc(u.username)}</span>
                    ${u.role === 'admin' ? '<span class="badge badge-gray">管理员</span>' : ''}
                  </div>
                </td>
                <td class="muted small">${esc(fmtTime(u.created_at))}</td>
                <td>${u.on_sale} 在售 / ${u.product_count} 总</td>
                <td>${u.order_count} 笔</td>
                <td>${u.post_count} 篇</td>
                <td>${u.review_count} 条</td>
                <td>${ratingBadgeHtml(u.rating)}</td>
                <td>${u.banned
                  ? `<span class="badge badge-danger">${u.ban.forever
                      ? '永久封禁' : `封禁至 ${esc((u.ban.until || '').slice(5, 16))}`}</span>`
                  : '<span class="badge badge-info">正常</span>'}</td>
                <td>
                  <div class="ops">
                    <button class="btn btn-sm" data-detail="${u.id}">详情</button>
                    ${u.role === 'admin' ? ''
                      : (u.banned
                        ? `<button class="btn btn-sm" data-unban="${u.id}"
                             data-name="${esc(u.nickname)}">解封</button>`
                        : `<button class="btn btn-danger btn-sm" data-ban="${u.id}"
                             data-name="${esc(u.nickname)}">封禁</button>`)}
                  </div>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    // 整行可点看详情；行内按钮自己处理（stopPropagation）
    box.querySelectorAll('tr[data-uid]').forEach(tr =>
      tr.addEventListener('click', (event) => {
        if (event.target.closest('[data-detail],[data-ban],[data-unban]')) return;
        openUserDetail(tr.dataset.uid, load);
      }));
    box.querySelectorAll('[data-detail]').forEach(btn =>
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        openUserDetail(btn.dataset.detail, load);
      }));
    box.querySelectorAll('[data-ban]').forEach(btn =>
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        openBanDialog(btn.dataset.ban, btn.dataset.name, load);
      }));
    box.querySelectorAll('[data-unban]').forEach(btn =>
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const sure = await confirmDialog({
          title: `解封「${btn.dataset.name}」？`, okText: '解封',
          message: '解封后对方可以立即登录并使用，平台会私信告知对方。',
        });
        if (!sure) return;
        try {
          await api.post(`/api/admin/users/${btn.dataset.unban}/unban`);
          toast('已解封');
          load();
        } catch (err) { toast(err.message, 'error'); }
      }));

    renderPagination(panel.querySelector('#u-pager'), {
      page: data.page,
      pages: Math.max(1, Math.ceil(data.total / data.page_size)),
      total: data.total,
      onGo: (target) => { page = target; load(); },
    });
  }

  const readFilters = () => {
    keyword = panel.querySelector('#u-keyword').value.trim();
    status = panel.querySelector('#u-status').value;
    page = 1;
  };
  panel.querySelector('#u-search').addEventListener('click', () => { readFilters(); load(); });
  panel.querySelector('#u-status').addEventListener('change', () => { readFilters(); load(); });
  panel.querySelector('#u-keyword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { readFilters(); load(); }
  });
  panel.querySelector('#u-reset').addEventListener('click', () => {
    panel.querySelector('#u-keyword').value = '';
    panel.querySelector('#u-status').value = 'all';
    keyword = '';
    status = 'all';
    page = 1;
    load();
  });

  await load();
}

async function openUserDetail(uid, refresh) {
  let d;
  try {
    d = await api.get(`/api/admin/users/${uid}`);
  } catch (err) {
    toast(`加载用户详情失败：${err.message}`, 'error');
    return;
  }

  const ban = d.ban;
  const blocks = [];
  blocks.push(`<h4 class="detail-h">用户信息</h4>
    <div class="row" style="gap:12px;align-items:center;margin-bottom:8px">
      ${avatarHtml(d, 52)}
      <div>
        <div class="strong" style="font-size:16px">${esc(d.nickname)}
          ${d.role === 'admin' ? '<span class="badge badge-gray">管理员</span>' : ''}
          ${d.banned ? '<span class="badge badge-danger">已封禁</span>' : ''}</div>
        <div class="muted small">@${esc(d.username)}　${esc(d.bio || '未填写简介')}</div>
      </div>
    </div>
    <div class="kv-list cols-2">
      ${kvLines([
        ['用户编号', String(d.id)],
        ['卖家编号', esc(d.seller_code || '未分配')],
        ['注册时间', esc(fmtTime(d.created_at))],
        ['好评率', ratingBadgeHtml(d.rating)],
        ['在售 / 商品总数', `${d.on_sale} / ${d.product_count}`],
        ['参与订单', `${d.order_count} 笔`],
        ['发帖', `${d.post_count} 篇`],
        ['收到评价', `${d.review_count} 条`],
        ['被举报次数', String(d.reports_against)],
        ['发起举报', `${d.reports_by} 次`],
      ])}
    </div>`);

  if (ban) {
    blocks.push(`<h4 class="detail-h">封禁信息</h4>` + kvLines([
      ['封禁时间', esc(ban.banned_at || '—')],
      ['封禁时长', ban.forever ? '<b>永久封禁</b>'
        : `解封时间 ${esc(ban.until || '—')}（剩余约 ${Math.ceil((ban.left_minutes || 0) / 60)} 小时）`],
      ['封禁原因', esc(ban.reason || '—')],
    ]));
  }

  blocks.push(`<h4 class="detail-h">最近发布的商品（${d.products.length}）</h4>`
    + (d.products.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>商品</th><th>编号</th><th>价格</th><th>状态</th><th>浏览</th></tr></thead>
        <tbody>${d.products.map(p => `<tr class="clickable-row" data-goto="#/product/${p.id}">
          <td>${esc(p.name)}</td><td class="muted small">${esc(p.product_code || '—')}</td>
          <td>${fmtPrice(p.price)}</td><td>${esc(p.status_text)}</td><td>👁 ${p.views}</td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="muted small">还没有发布商品</div>'));

  blocks.push(`<h4 class="detail-h">最近发帖（${d.posts.length}）</h4>`
    + (d.posts.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>标题</th><th>标签</th><th>赞 / 评</th><th>时间</th></tr></thead>
        <tbody>${d.posts.map(p => `<tr class="clickable-row" data-goto="#/post/${p.id}">
          <td>${esc(p.title)}</td><td>${esc(p.tag)}</td>
          <td>${p.like_count} / ${p.comment_count}</td>
          <td class="muted small">${esc(fmtTime(p.created_at))}</td>
        </tr>`).join('')}</tbody></table></div>`
      : '<div class="muted small">还没有发帖</div>'));

  blocks.push(`<h4 class="detail-h">最近动作（${d.logs.length}）</h4>`
    + (d.logs.length ? `<div class="timeline">${d.logs.map(l => `
        <div class="tl-item compact">
          <span class="tl-time muted small">${esc(fmtTime(l.created_at))}</span>
          <span class="tl-action">${esc(l.action_text)}</span>
          <span class="tl-summary muted">${esc(l.summary)}</span>
        </div>`).join('')}</div>`
      : '<div class="muted small">没有操作记录</div>'));

  openModal({
    title: `用户详情：${d.nickname}`,
    size: 'detail',
    body: blocks.join(''),
    footer: `${d.role === 'admin' ? '' : (ban
      ? `<button class="btn btn-primary" data-unban="${d.id}">解封</button>`
      : `<button class="btn btn-danger" data-ban="${d.id}">封禁用户</button>`)}
      <button class="btn" data-close>关闭</button>`,
    onMount(modal, close) {
      modal.querySelectorAll('[data-goto]').forEach(el =>
        el.addEventListener('click', () => { close(); location.hash = el.dataset.goto; }));
      modal.querySelector('[data-ban]')?.addEventListener('click', () => {
        close();
        openBanDialog(d.id, d.nickname, refresh);
      });
      modal.querySelector('[data-unban]')?.addEventListener('click', async () => {
        close();
        const sure = await confirmDialog({
          title: `解封「${d.nickname}」？`, okText: '解封',
          message: '解封后对方可以立即登录并使用，平台会私信告知对方。',
        });
        if (!sure) return;
        try {
          await api.post(`/api/admin/users/${d.id}/unban`);
          toast('已解封');
          if (refresh) refresh();
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

function openBanDialog(uid, nickname, refresh) {
  openFormModal({
    title: `封禁「${nickname}」`,
    submitText: '确认封禁',
    successMsg: '已封禁，并私信告知对方',
    fields: [
      { key: 'duration', label: '封禁时长', type: 'select', required: true,
        options: [['1', '1 天'], ['3', '3 天'], ['7', '7 天'], ['30', '30 天'],
                  ['forever', '永久封禁'], ['custom', '自定义天数']]
          .map(([v, t]) => `<option value="${v}">${t}</option>`).join('') },
      { key: 'days', label: '自定义天数（选了「自定义天数」才需要填）', type: 'number',
        placeholder: '例如 15' },
      { key: 'reason', label: '封禁原因（会私信告知对方）', type: 'textarea', required: true,
        maxlength: 200, placeholder: '例如：多次发布虚假商品信息' },
    ],
    submit: (values) => {
      const body = { reason: values.reason };
      if (values.duration === 'forever') body.forever = true;
      else if (values.duration === 'custom') body.days = Number(values.days || 0);
      else body.days = Number(values.duration);
      if (!body.forever && (!body.days || body.days <= 0)) {
        return Promise.reject(new Error('请填写自定义天数，或改选固定时长 / 永久封禁'));
      }
      return api.post(`/api/admin/users/${uid}/ban`, body);
    },
    done: refresh,
  });
}

/* 新批需求⑤：举报对象扩展到评价与评论 */
const TARGET_META = {
  product: { text: '商品', badge: '', handle: '下架商品', link: 'product' },
  post: { text: '帖子', badge: 'badge-info', handle: '删除帖子', link: 'post' },
  review: { text: '评价', badge: 'badge-warn', handle: '删除评价', link: '' },
  comment: { text: '评论', badge: 'badge-warn', handle: '删除评论', link: '' },
  review_comment: { text: '评价评论', badge: 'badge-warn', handle: '删除评论', link: '' },
};

/* ================================================================ 举报审核 */
/* ================================================================ 行为监测（2026-10-18 需求①） */
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
      <div class="row-between mb-8">
        <label class="row" style="gap:6px;align-items:center;cursor:pointer">
          <input type="checkbox" id="rp-check-all">
          <span class="muted small">全选本页</span>
        </label>
        <button class="btn btn-danger btn-sm" id="rp-del-selected" disabled>🗑 删除选中（0）</button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th style="width:34px"></th><th>对象</th><th>类型</th><th>举报人</th><th>理由</th><th>状态</th><th>时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            ${data.list.map(r => {
              const target = r.target || {};
              const meta = TARGET_META[r.target_type]
                || { text: '对象', badge: 'badge-gray', handle: '删除', link: '' };
              const canHandle = r.status === 'pending';
              return `
              <tr>
                <td><input type="checkbox" class="rp-check" data-check="${r.id}"
                           data-status="${r.status}" title="选中后可批量删除这条举报记录"></td>
                <td>${target.id ? (meta.link
                  ? `<span class="strong" data-target="${meta.link}:${target.id}" style="cursor:pointer">${esc(target.title || '')}</span>`
                  : `<span class="strong">${esc(target.title || '')}</span>`)
                  : '<span class="muted">对象已删除</span>'}</td>
                <td><span class="badge ${meta.badge}">${meta.text}</span></td>
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
                        ${meta.handle}
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
        // 需求⑤：带上来源，帖子详情页的「返回」才会回到举报审核而不是交流广场
        location.hash = type === 'product'
          ? `#/product/${id}?from=admin`
          : `#/post/${id}?from=admin`;
      }));

    // 本批需求②：勾选后可删除选定的举报记录（口径：待处理的也能删，但要额外提醒）
    const checkAll = listBox.querySelector('#rp-check-all');
    const delBtn = listBox.querySelector('#rp-del-selected');
    const picked = () => [...listBox.querySelectorAll('.rp-check:checked')]
      .map(el => ({ id: Number(el.dataset.check), status: el.dataset.status }));
    const syncDel = () => {
      const n = picked().length;
      const total = listBox.querySelectorAll('.rp-check').length;
      if (delBtn) {
        delBtn.textContent = `🗑 删除选中（${n}）`;
        delBtn.disabled = n === 0;
      }
      if (checkAll) {
        checkAll.checked = n > 0 && n === total;
        checkAll.indeterminate = n > 0 && n < total;
      }
    };
    checkAll?.addEventListener('change', () => {
      listBox.querySelectorAll('.rp-check').forEach(el => { el.checked = checkAll.checked; });
      syncDel();
    });
    listBox.querySelectorAll('.rp-check').forEach(el => el.addEventListener('change', syncDel));
    delBtn?.addEventListener('click', async () => {
      const list = picked();
      if (!list.length) return;
      const pendingCount = list.filter(x => x.status === 'pending').length;
      const sure = await confirmDialog({
        title: `删除选中的 ${list.length} 条举报记录？`, danger: true, okText: '删除记录',
        message: (pendingCount
          ? `其中 ${pendingCount} 条还是「待处理」——删掉等于放弃处理这些举报，举报人收不到任何反馈。`
          : '')
          + '删除后这些记录就查不回来了；删除动作本身会留下一条操作日志。',
      });
      if (!sure) return;
      try {
        const res = await api.post('/api/admin/reports/delete',
          { ids: list.map(x => x.id) });
        toast(`已删除 ${res.deleted} 条举报记录`);
        load();
      } catch (err) { toast(err.message, 'error'); }
    });
    syncDel();

    // 需求④：处理举报时可填「大致原因 + 详细说明」，处理结果会以私信反馈给对方
    const reasonOptions = data.reason_options || { handle: ['其他'], dismiss: ['其他'] };

    listBox.querySelectorAll('[data-handle]').forEach(el =>
      el.addEventListener('click', () => {
        const meta = TARGET_META[el.dataset.type] || { handle: '处理' };
        openFormModal({
          title: meta.handle + '（举报处理）',
          submitText: '处理并通知对方',
          successMsg: `已处理：${meta.handle}，并私信告知相关的人`,
          fields: [
            { key: 'reason_code', label: '大致原因', type: 'select', required: true,
              options: (reasonOptions.handle || [])
                .map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('') },
            { key: 'reason_text', label: '详细说明（可选，会一并私信）', type: 'textarea',
              maxlength: 200, placeholder: '例如：帖子含外部广告链接，已多次提醒' },
          ],
          submit: (values) => api.patch(`/api/admin/reports/${el.dataset.handle}`,
                                        { action: 'handle', ...values }),
          done: load,
        });
      }));

    listBox.querySelectorAll('[data-dismiss]').forEach(el =>
      el.addEventListener('click', () => {
        openFormModal({
          title: '驳回该举报',
          submitText: '驳回并通知举报者',
          successMsg: '已驳回，并私信告知举报者',
          fields: [
            { key: 'reason_code', label: '驳回原因', type: 'select', required: true,
              options: (reasonOptions.dismiss || [])
                .map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('') },
            { key: 'reason_text', label: '详细说明（可选，会一并私信）', type: 'textarea',
              maxlength: 200, placeholder: '例如：经核实内容属实，未违反社区规范' },
          ],
          submit: (values) => api.patch(`/api/admin/reports/${el.dataset.dismiss}`,
                                        { action: 'dismiss', ...values }),
          done: load,
        });
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
          <td>${c.id}</td><td style="font-size:18px">${esc(c.icon)}</td>
          <td>${esc(c.name)}${c.code ? ` <span class="muted small">${esc(c.code)}</span>` : ''}</td>
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
          <td>${s.id}</td><td>${esc(c.icon)} ${esc(c.name)}</td>
          <td>${esc(s.name)}${s.seq_in_category ? ` <span class="muted small">序号 ${String(s.seq_in_category).padStart(2, '0')}</span>` : ''}</td>
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
        { key: 'code', label: '字母码（商品编号用）', placeholder: '2 位，如 TA / DG / LF / SP / OT' },
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
          { key: 'code', label: '字母码（商品编号用）', value: cat.code || '', placeholder: '留空则编号回退用分类 ID' },
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
function openFormModal({ title, fields, submit, done, successMsg = '保存成功', submitText = '保存' }) {
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
      if (field.type === 'textarea') {
        return `
          <div class="form-row">
            <label>${esc(field.label)}${field.required ? '<span class="req">*</span>' : ''}</label>
            <textarea class="textarea" data-field="${field.key}"
                      maxlength="${field.maxlength || 200}"
                      placeholder="${esc(field.placeholder || '')}">${esc(field.value ?? '')}</textarea>
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
             <button class="btn btn-primary" id="fm-submit">${esc(submitText)}</button>`,
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
          toast(successMsg);
          if (done) done();
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      });
    },
  });
}
