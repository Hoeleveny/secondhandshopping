/* ==========================================================================
   M10 管理后台
   五个页签：商品管理 / 交易管理 / 举报审核 / 基础数据 / 数据管理（备份·恢复·重置）
   ========================================================================== */
import { api, qs } from '../api.js';
import { ensureCategories, ensureMeta, ensurePlaces, invalidateCatalog } from '../data.js';
import {
  confirmDialog, emptyHtml, esc, fmtPrice, fmtTime, loadingHtml,
  openModal, renderPagination, toast,
} from '../ui.js';

const TABS = [
  { key: 'products', label: '商品管理', icon: '📦' },
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
        <span class="muted small">点任意一条可看详细交易信息</span>
      </div>
      <div class="form-grid mb-8">
        <div class="form-row">
          <label>动作</label>
          <select class="select" id="lg-action"><option value="all">全部动作</option></select>
        </div>
        <div class="form-row">
          <label>动作发起人</label>
          <select class="select" id="lg-user"><option value="">全部发起人</option></select>
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

  function kvLines(pairs) {
    return `<div class="kv-list">${pairs.filter(Boolean).map(([k, v]) =>
      `<div class="kv"><span class="kv-k">${esc(k)}</span><span class="kv-v">${v}</span></div>`).join('')}</div>`;
  }

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
      ['摘要', esc(log.summary || '—')],
    ]));

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
      ]));
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
      ]));
    }

    if (extra && extra.kind === 'review') {
      blocks.push(`<h4 class="detail-h">评价内容</h4>` + kvLines([
        ['评分', `${'★'.repeat(extra.rating || 0)}${'☆'.repeat(Math.max(0, 5 - (extra.rating || 0)))}（${extra.rating} 星）`],
        ['评价人', esc(extra.reviewer || '')],
        ['被评人', esc(extra.reviewee || '')],
        ['内容', esc(extra.content || '（未填写）')],
      ]));
    }

    if (extra && extra.kind === 'report') {
      blocks.push(`<h4 class="detail-h">举报内容</h4>` + kvLines([
        ['举报对象', esc(extra.target)],
        ['举报人', esc(extra.reporter || '')],
        ['处理状态', esc(extra.status)],
        ['举报理由', esc(extra.reason || '—')],
      ]));
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
      body: logDetailBody(d),
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
      <div class="kv-list">
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

    let body;
    if (data.type === 'longest') {
      body = data.order ? longestDetail(data.order) : emptyHtml('当前没有进行中的交易', '✅');
    } else if (!data.list.length) {
      body = emptyHtml(data.type === 'today' ? '今天还没有新订单' : '没有符合条件的记录', '📭');
    } else {
      body = data.type === 'sellers' ? sellersTable(data.list) : rowsTable(data.list);
    }

    openModal({
      title: data.title || '明细',
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

  /* ---------------- 动态监控（操作日志时间线 + 多条件筛选）---------------- */
  async function loadLogs(silent = false) {
    const box = panel.querySelector('#lg-list');
    if (!box) return;
    if (!silent) box.innerHTML = loadingHtml();
    let data;
    try {
      data = await api.get(`/api/admin/logs${qs({
        action: logAction, user_id: logUser, product: logProduct,
        order_no: logOrder, date_from: logFrom, date_to: logTo,
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
    const userSel = panel.querySelector('#lg-user');
    if (data.actors) {
      const current = userSel.value;
      userSel.innerHTML = `<option value="">全部发起人</option>`
        + data.actors.map(a =>
            `<option value="${a.id}">${esc(a.nickname || a.username || '')}</option>`).join('');
      userSel.value = current;
    }

    if (!data.list.length) {
      box.innerHTML = emptyHtml('没有符合条件的操作记录', '📋');
      renderPagination(panel.querySelector('#lg-pager'),
        { page: 1, pages: 1, total: 0, onGo: () => {} });
      return;
    }

    box.innerHTML = `
      <div class="timeline">
        ${data.list.map(log => `
          <div class="tl-item clickable" data-log="${log.id}" role="button" tabindex="0"
               title="点击查看这条动作的详细交易信息">
            <span class="tl-time muted small">${esc(fmtTime(log.created_at))}</span>
            <span class="tl-who">${esc(log.nickname || log.username || '系统')}</span>
            <span class="tl-action">${esc(log.action_text)}</span>
            <span class="tl-summary muted">${esc(log.summary)}</span>
          </div>`).join('')}
      </div>`;

    // 需求②：点条目看详情（发起人、精确时间、相关订单与商品）
    box.querySelectorAll('[data-log]').forEach(el => {
      el.addEventListener('click', () => openLogDetail(el.dataset.log));
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openLogDetail(el.dataset.log);
        }
      });
    });

    renderPagination(panel.querySelector('#lg-pager'), {
      page: data.page,
      pages: Math.max(1, Math.ceil(data.total / data.page_size)),
      total: data.total,
      onGo: (p) => { logPage = p; loadLogs(); },
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
  panel.querySelector('#lg-action').addEventListener('change', (e) => {
    logAction = e.target.value;
    logPage = 1;
    loadLogs();
  });
  panel.querySelector('#lg-user').addEventListener('change', (e) => {
    logUser = e.target.value;
    logPage = 1;
    loadLogs();
  });
  const readLogFilters = () => {
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
  ['#lg-product', '#lg-order'].forEach((sel) =>
    panel.querySelector(sel).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        readLogFilters();
        loadLogs();
      }
    }));
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
  await loadLogs();

  // 每 5 秒刷新一次；离开本页（面板被卸载）就自动停掉
  stopTradesTimer();
  tradesTimer = setInterval(() => {
    if (!panel.isConnected) { stopTradesTimer(); return; }
    loadTrades(true);
    loadLogs(true);
  }, 5000);
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
        // 需求⑤：带上来源，帖子详情页的「返回」才会回到举报审核而不是交流广场
        location.hash = type === 'product'
          ? `#/product/${id}?from=admin`
          : `#/post/${id}?from=admin`;
      }));

    // 需求④：处理举报时可填「大致原因 + 详细说明」，处理结果会以私信反馈给对方
    const reasonOptions = data.reason_options || { handle: ['其他'], dismiss: ['其他'] };

    listBox.querySelectorAll('[data-handle]').forEach(el =>
      el.addEventListener('click', () => {
        const isProduct = el.dataset.type === 'product';
        openFormModal({
          title: isProduct ? '下架被举报的商品' : '删除被举报的帖子',
          submitText: isProduct ? '下架并通知卖家' : '删帖并通知作者',
          successMsg: isProduct
            ? '已下架商品，并私信告知卖家'
            : '已删除帖子，并私信告知作者',
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
