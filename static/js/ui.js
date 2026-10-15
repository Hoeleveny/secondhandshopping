/* ==========================================================================
   通用 UI 组件与工具：转义、Toast、Modal、分页、空态、格式化
   ========================================================================== */

/** HTML 转义，所有用户输入渲染前都要过一遍，防 XSS */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const imgUrl = (name) => (name ? `/uploads/${encodeURIComponent(name)}` : '');

/** 头像：设置过头像就显示图片，否则显示昵称首字（功能⑦） */
export function avatarHtml(user, size = 36, className = 'msg-avatar') {
  const name = (user && user.nickname) || '?';
  const style = `width:${size}px;height:${size}px;flex:0 0 ${size}px`;
  if (user && user.avatar) {
    return `<span class="${className}" style="${style}"><img src="${esc(imgUrl(user.avatar))}" alt=""></span>`;
  }
  return `<span class="${className}" style="${style}">${esc(name.slice(0, 1))}</span>`;
}

/** 商品封面：没有真实图片时用分类 emoji 占位 */
export function coverHtml(product, size = 52) {
  if (product.cover) {
    return `<img src="${esc(imgUrl(product.cover))}" alt="${esc(product.name)}" loading="lazy">`;
  }
  return `<span style="font-size:${size}px">${esc(product.category_icon || '📦')}</span>`;
}

/* ------------------------------------------------------------------ Toast */
export function toast(message, type = 'ok', timeout = 2500) {
  const root = document.getElementById('toast-root');
  const icons = { ok: '✅', error: '⛔', warn: '⚠️', info: 'ℹ️' };
  const node = document.createElement('div');
  node.className = `toast ${type === 'ok' ? '' : type}`;
  node.innerHTML = `<span class="t-icon">${icons[type] || icons.ok}</span><span>${esc(message)}</span>`;
  root.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, timeout);
}

/* ------------------------------------------------------------------ Modal */
export function openModal({ title, body, footer, wide = false, onMount }) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}">
      <div class="modal-head">${esc(title || '')}</div>
      <div class="modal-body">${body || ''}</div>
      <div class="modal-foot">${footer || '<button class="btn" data-close>关闭</button>'}</div>
    </div>`;
  root.appendChild(mask);

  const close = () => { if (mask.parentNode) mask.remove(); };
  mask.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', close));
  mask.addEventListener('click', (event) => { if (event.target === mask) close(); });
  document.addEventListener('keydown', function onEsc(event) {
    if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
  });
  if (onMount) onMount(mask.querySelector('.modal'), close);
  return { close, el: mask };
}

/** 确认框，返回 Promise<boolean> */
export function confirmDialog({ title = '请确认', message = '', okText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    const { close, el } = openModal({
      title,
      body: `<p style="margin:6px 0 2px;color:var(--text-sub)">${esc(message)}</p>`,
      footer: `<button class="btn" data-cancel>${esc(cancelText)}</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button>`,
      onMount(modal, closeFn) {
        modal.querySelector('[data-ok]').addEventListener('click', () => { closeFn(); done(true); });
        modal.querySelector('[data-cancel]').addEventListener('click', () => { closeFn(); done(false); });
      },
    });
    // 点遮罩或 ESC 关闭也视为取消
    el.addEventListener('click', (e) => { if (e.target === el) done(false); });
    const observer = new MutationObserver(() => {
      if (!document.body.contains(el)) { done(false); observer.disconnect(); }
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
    void close;
  });
}

/* ------------------------------------------------------------------ 好评率徽标（需求③） */
/**
 * 商家好评率与分级徽标。rating 来自后端：{rate,total,level,level_text,level_hint}。
 * 没有评价时给中性提示，不硬凑成「100% 优秀」误导买家。
 */
export function ratingBadgeHtml(rating) {
  if (!rating || !rating.total) {
    return `<span class="badge badge-gray rating-badge" title="这位卖家还没有收到评价">暂无评价</span>`;
  }
  const level = rating.level || 'fair';
  const hint = `${rating.level_hint || ''}（好评 ${rating.good} / 共 ${rating.total} 条，平均 ${rating.avg} 星）`;
  return `<span class="badge rating-badge rating-${esc(level)}" title="${esc(hint)}">`
    + `好评率 ${rating.rate}% · ${esc(rating.level_text)}</span>`;
}

/* ------------------------------------------------------------------ 状态块 */
export const loadingHtml = (text = '加载中…') =>
  `<div class="loading"><div class="spinner"></div>${esc(text)}</div>`;

export const emptyHtml = (text = '暂无数据', icon = '🍃') =>
  `<div class="empty"><span class="em-icon">${icon}</span>${esc(text)}</div>`;

export const skeletonHtml = (count = 4) =>
  `<div class="grid-cards">${'<div class="skeleton"></div>'.repeat(count)}</div>`;

/* ------------------------------------------------------------------ 分页 */
export function renderPagination(container, { page, pages, total, onGo }) {
  if (!container) return;
  if (!total || pages <= 1) {
    container.innerHTML = total ? `<span class="pg-info">共 ${total} 条</span>` : '';
    return;
  }
  const buttons = [];
  const push = (label, target, active = false, disabled = false) => {
    buttons.push(`<button data-page="${target}" class="${active ? 'active' : ''}" ${disabled ? 'disabled' : ''}>${label}</button>`);
  };
  push('‹', page - 1, false, page <= 1);
  const windowSize = 2;
  let start = Math.max(1, page - windowSize);
  let end = Math.min(pages, page + windowSize);
  if (start > 1) { push('1', 1, page === 1); if (start > 2) buttons.push('<span class="muted">…</span>'); }
  for (let i = start; i <= end; i += 1) push(String(i), i, i === page);
  if (end < pages) { if (end < pages - 1) buttons.push('<span class="muted">…</span>'); push(String(pages), pages, page === pages); }
  push('›', page + 1, false, page >= pages);

  container.innerHTML = buttons.join('') + `<span class="pg-info">共 ${total} 条 / ${pages} 页</span>`;
  container.querySelectorAll('button[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = Number(btn.dataset.page);
      if (target >= 1 && target <= pages && target !== page) onGo(target);
    });
  });
}

/* ------------------------------------------------------------------ 格式化 */
export function fmtPrice(value) {
  const n = Number(value || 0);
  return `¥${n.toFixed(2)}`;
}

export function fmtTime(text) {
  if (!text) return '';
  const time = new Date(String(text).replace(' ', 'T'));
  if (Number.isNaN(time.getTime())) return String(text);
  const diff = (Date.now() - time.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;
}

export function fmtDate(text) {
  if (!text) return '';
  return String(text).slice(0, 16);
}

export function starsHtml(rating, size = 14) {
  const n = Math.round(Number(rating) || 0);
  return `<span class="stars" style="font-size:${size}px">${'★'.repeat(n)}${'☆'.repeat(Math.max(0, 5 - n))}</span>`;
}

export function initials(name) {
  const text = String(name || '?').trim();
  return text ? text.slice(0, 1) : '?';
}

/** 商品状态角标 */
export function statusFlagHtml(status) {
  const map = { sold: '已售出', off_shelf: '已下架', deleted: '已删除' };
  if (!map[status]) return '';
  return `<span class="status-flag flag-${esc(status)}">${map[status]}</span>`;
}

export function statusBadgeHtml(status, text) {
  const cls = { sold: 'badge-gray', off_shelf: 'badge-warn', deleted: 'badge-danger', pending: 'badge-warn', done: '', canceled: 'badge-gray' }[status] || '';
  return `<span class="badge ${cls}">${esc(text || status)}</span>`;
}

/* ------------------------------------------------------------------ 星级选择 */
export function starPicker(container, initial = 5, onChange) {
  let value = initial;
  const paint = () => {
    container.innerHTML = [1, 2, 3, 4, 5]
      .map(i => `<span class="${i <= value ? 'on' : ''}" data-v="${i}">★</span>`).join('');
  };
  container.className = 'rate-pick';
  paint();
  container.addEventListener('click', (event) => {
    const target = event.target.closest('[data-v]');
    if (!target) return;
    value = Number(target.dataset.v);
    paint();
    if (onChange) onChange(value);
  });
  return { get value() { return value; } };
}

/* ------------------------------------------------------------------ 其他 */
export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 表单校验：把错误显示在字段下方 */
export function markInvalid(input, message) {
  if (!input) return;
  input.classList.add('invalid');
  let tip = input.parentElement.querySelector('.form-error');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'form-error';
    input.parentElement.appendChild(tip);
  }
  tip.textContent = message;
}

export function clearInvalid(scope) {
  scope.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  scope.querySelectorAll('.form-error').forEach(el => el.remove());
}

/** 跳转（供各页面使用） */
export function go(hash) {
  location.hash = hash.startsWith('#') ? hash : `#${hash}`;
}
