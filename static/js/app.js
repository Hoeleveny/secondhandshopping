/* ==========================================================================
   应用外壳与前端路由
   - 三段式布局：顶栏 + 左侧菜单（随身份变化）+ 内容区
   - hash 路由，页面切换不整页刷新
   ========================================================================== */
import { api } from './api.js';
import { store } from './store.js';
import { ensureMeta } from './data.js';
import { emptyHtml, esc, initials, loadingHtml, toast } from './ui.js';
import { initTheme, mountThemeSwitcher } from './theme.js';

// 尽早贴主题，减少首屏闪一下默认配色
initTheme();

/* ---------------------------------------------------------------- 菜单 */
const M = {
  home: { key: 'home', hash: '#/home', icon: '🏠', label: '首页' },
  search: { key: 'search', hash: '#/search', icon: '🔍', label: '搜索与筛选' },
  compare: { key: 'compare', hash: '#/compare', icon: '📊', label: '比价' },
  orders: { key: 'orders', hash: '#/orders', icon: '📦', label: '我的订单' },
  favorites: { key: 'favorites', hash: '#/favorites', icon: '⭐', label: '我的收藏' },
  swaps: { key: 'swaps', hash: '#/swaps', icon: '🔄', label: '以物换物' },
  posts: { key: 'posts', hash: '#/posts', icon: '💬', label: '交流广场' },
  messages: { key: 'messages', hash: '#/messages', icon: '✉️', label: '我的消息' },
  publish: { key: 'publish', hash: '#/publish', icon: '➕', label: '发布商品' },
  myProducts: { key: 'my-products', hash: '#/my-products', icon: '🗂️', label: '我的商品' },
  sold: { key: 'sold', hash: '#/sold', icon: '📤', label: '卖出订单' },
  admin: { key: 'admin', hash: '#/admin', icon: '⚙️', label: '管理后台' },
  dashboard: { key: 'dashboard', hash: '#/dashboard', icon: '📈', label: '数据看板' },
  profile: { key: 'profile', hash: '#/profile', icon: '👤', label: '个人资料' },
};

const MENUS = {
  guest: [M.search, M.compare, M.posts],
  // 需求④：买家 / 卖家菜单合并成一套——同一个账号既能买也能卖，
  // 所以「发布商品 / 我的商品 / 我的订单」同时出现，订单页内部再分「我买到的 / 我卖出的」。
  user: [M.search, M.compare, M.orders, M.myProducts, M.publish, M.favorites, M.swaps, M.posts],
  admin: [M.admin, M.dashboard],
};
MENUS.buyer = MENUS.user;      // 兼容旧引用（老 localStorage 里的 view / 旧测试）
MENUS.seller = MENUS.user;

/* ---------------------------------------------------------------- 路由表 */
// auth: 'any' 公开 | 'required' 需登录 | 'admin' 仅管理员
const ROUTES = [
  { path: '/', auth: 'any', menu: 'home', load: () => import('./pages/home.js') },
  { path: '/home', auth: 'any', menu: 'home', load: () => import('./pages/home.js') },
  { path: '/search', auth: 'any', menu: 'search', load: () => import('./pages/search.js') },
  { path: '/compare', auth: 'any', menu: 'compare', load: () => import('./pages/compare.js') },
  { path: '/product/:id', auth: 'any', menu: 'search', load: () => import('./pages/detail.js') },
  { path: '/product/:id/edit', auth: 'required', menu: 'my-products', load: () => import('./pages/productForm.js') },
  { path: '/seller/:id', auth: 'any', menu: 'search', load: () => import('./pages/seller.js') },
  { path: '/publish', auth: 'required', menu: 'publish', load: () => import('./pages/productForm.js') },
  { path: '/my-products', auth: 'required', menu: 'my-products', load: () => import('./pages/myProducts.js') },
  { path: '/orders', auth: 'required', menu: 'orders', load: () => import('./pages/orders.js') },
  { path: '/sold', auth: 'required', menu: 'sold', load: () => import('./pages/orders.js') },
  { path: '/favorites', auth: 'required', menu: 'favorites', load: () => import('./pages/favorites.js') },
  { path: '/order/:id/map', auth: 'required', menu: 'orders', load: () => import('./pages/orderMap.js') },
  { path: '/swaps', auth: 'required', menu: 'swaps', load: () => import('./pages/swaps.js') },
  { path: '/posts', auth: 'any', menu: 'posts', load: () => import('./pages/posts.js') },
  { path: '/post/:id', auth: 'any', menu: 'posts', load: () => import('./pages/postDetail.js') },
  { path: '/messages', auth: 'required', menu: 'messages', load: () => import('./pages/messages.js') },
  { path: '/profile', auth: 'required', menu: 'profile', load: () => import('./pages/profile.js') },
  { path: '/admin', auth: 'admin', menu: 'admin', load: () => import('./pages/admin.js') },
  { path: '/dashboard', auth: 'admin', menu: 'dashboard', load: () => import('./pages/dashboard.js') },
];

/* ---------------------------------------------------------------- 工具 */
// 需求④：取消「买家 / 卖家」身份切换后，登录用户只有一种外壳（管理员另算）。
function currentViewKey() {
  if (!store.isLoggedIn) return 'guest';
  if (store.isAdmin) return 'admin';
  return 'user';
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const index = raw.indexOf('?');
  const path = index >= 0 ? raw.slice(0, index) : raw;
  const query = Object.fromEntries(new URLSearchParams(index >= 0 ? raw.slice(index + 1) : ''));
  return { path: path || '/', query };
}

function matchRoute(path) {
  const segments = path.split('/').filter(Boolean);
  for (const route of ROUTES) {
    const pattern = route.path.split('/').filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i += 1) {
      if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = decodeURIComponent(segments[i]);
      else if (pattern[i] !== segments[i]) { matched = false; break; }
    }
    if (matched) return { route, params };
  }
  return null;
}

export function go(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) render();
  else location.hash = target;
}

/* ---------------------------------------------------------------- 顶栏 */
function topbarHtml(viewKey) {
  const rightHtml = store.isLoggedIn ? `
    <button class="avatar-btn" id="user-menu" style="position:relative">
      <span class="avatar-dot">${store.user?.avatar
        ? `<img src="/uploads/${encodeURIComponent(store.user.avatar)}" alt="">`
        : esc(initials(store.nickname))}</span>
      <span>${esc(store.nickname)}</span>
      <span class="muted small">${store.isAdmin ? '管理员' : '用户'}</span>
      <span class="badge badge-danger" id="msg-badge"
            style="display:none;position:absolute;top:-3px;left:-3px">0</span>
    </button>` : `
    <button class="btn btn-primary" id="go-login">登录 / 注册</button>`;

  return `
    <header class="topbar">
      <button class="brand" id="brand-home" title="回到首页">🌿 校园二手集市</button>
      <form class="search-box" id="top-search">
        <input type="text" placeholder="搜索想要的二手物品，回车搜索" id="top-search-input">
        <button type="submit">搜索</button>
      </form>
      <div class="topbar-right">${rightHtml}</div>
    </header>`;
}

function sidebarHtml(viewKey, activeMenu) {
  const items = (MENUS[viewKey] || MENUS.guest).map(item => `
    <button class="menu-item ${item.key === activeMenu ? 'active' : ''}" data-hash="${item.hash}">
      <span class="mi-icon">${item.icon}</span><span>${item.label}</span>
    </button>`).join('');
  const titles = { guest: '游客浏览', user: '我的集市', admin: '管理员' };
  return `<aside class="sidebar">
      <div class="menu-title">${titles[viewKey] || ''}</div>
      ${items}
    </aside>`;
}

/* ---------------------------------------------------------------- 登录页 */
function renderLoginPage(query) {
  const next = query.next ? decodeURIComponent(query.next) : '';
  const root = document.getElementById('root');
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand">🌿</div>
        <div class="auth-title">校园二手集市</div>
        <div class="tabs" style="justify-content:center">
          <button class="tab active" data-tab="login">登录</button>
          <button class="tab" data-tab="register">注册</button>
        </div>
        <form id="auth-form">
          <div class="form-row">
            <label>用户名<span class="req">*</span></label>
            <input class="input" name="username" id="f-username" autocomplete="username" placeholder="2-20 位，中英文 / 数字 / 下划线">
          </div>
          <div class="form-row">
            <label>密码<span class="req">*</span></label>
            <input class="input" type="password" name="password" id="f-password"
                   autocomplete="current-password" placeholder="至少 4 位">
          </div>
          <div class="form-row" id="role-row">
            <label>账号类型</label>
            <div class="role-pick" id="role-pick">
              <label><input type="radio" name="role" value="user" checked><span>🧑‍🎓 普通用户</span></label>
              <label class="admin-only" style="display:none"><input type="radio" name="role" value="admin"><span>🛡️ 管理员</span></label>
            </div>
            <div class="muted small" style="margin-top:6px">
              普通用户不再区分「买家 / 卖家」——同一个账号既能买也能卖。
            </div>
          </div>
          <button class="btn btn-primary btn-lg btn-block" type="submit" id="auth-submit">登 录</button>
        </form>
        <div class="auth-tip">
          演示账号（密码均为 <b>123456</b>）：<br>
          buyer1 / buyer2 / seller1 / seller2 / seller3（都是普通用户）<br>
          管理员 admin（需把「账号类型」切到「管理员」）
        </div>
      </div>
    </div>`;

  let mode = 'login';

  function setMode(nextMode) {
    mode = nextMode;
    root.querySelectorAll('.tab').forEach(tab =>
      tab.classList.toggle('active', tab.dataset.tab === mode));
    // 注册不允许选管理员
    root.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = mode === 'login' ? '' : 'none';
    });
    if (mode === 'register') {
      // 注册不允许选管理员
      const adminRadio = root.querySelector('input[value="admin"]');
      if (adminRadio && adminRadio.checked) root.querySelector('input[value="user"]').checked = true;
    }
    root.querySelector('#auth-submit').textContent = mode === 'login' ? '登 录' : '注 册';
    root.querySelector('#f-password').setAttribute(
      'autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    paintRolePick();
  }

  root.querySelectorAll('.tab').forEach(tab =>
    tab.addEventListener('click', () => setMode(tab.dataset.tab)));

  // 身份选中态（不依赖 :has()，保证老浏览器也能高亮）
  function paintRolePick() {
    root.querySelectorAll('#role-pick label').forEach(label => {
      label.classList.toggle('sel', Boolean(label.querySelector('input:checked')));
    });
  }
  root.querySelector('#role-pick').addEventListener('change', paintRolePick);
  paintRolePick();

  root.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = root.querySelector('#auth-submit');
    const username = root.querySelector('#f-username').value.trim();
    const password = root.querySelector('#f-password').value;
    // 需求④：只有「管理员」需要显式声明；普通用户不带 role，后端按账号自身角色进
    const picked = root.querySelector('input[name="role"]:checked').value;

    if (!username) { toast('请输入用户名', 'warn'); return; }
    if (password.length < 4) { toast('密码至少 4 位', 'warn'); return; }

    submit.disabled = true;
    try {
      const body = { username, password };
      if (picked === 'admin') body.role = 'admin';
      const data = await api.post(`/api/auth/${mode}`, body);
      store.setAuth(data.token, data.user, data.view);
      toast(mode === 'login' ? '登录成功' : '注册成功，已自动登录');
      go(next || (data.user.role === 'admin' ? '#/admin' : '#/home'));
      if (!next) render();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });
}

/* ---------------------------------------------------------------- 外壳 */
function buildShell(viewKey, activeMenu) {
  const root = document.getElementById('root');
  root.innerHTML = `
    ${topbarHtml(viewKey)}
    <div class="layout">
      ${sidebarHtml(viewKey, activeMenu)}
      <main class="content" id="page"></main>
    </div>`;
  // 主题切换器是全站唯一「追加」的节点，只放在顶栏末尾，不移动任何原有元素
  mountThemeSwitcher(root.querySelector('.topbar'));
  bindShellEvents();
}

function bindShellEvents() {
  const root = document.getElementById('root');

  root.querySelectorAll('.menu-item').forEach(btn =>
    btn.addEventListener('click', () => go(btn.dataset.hash)));

  // 左上角站名即「回首页」入口（左侧功能列不再单独放「首页」按钮）
  root.querySelector('#brand-home')?.addEventListener('click', () => go('#/home'));

  // 需求④：原来的「买家 ⇄ 卖家」身份滑块与标签点击都去掉了——
  // 同一个账号既能买也能卖，没有需要切换的「身份」。

  const loginBtn = root.querySelector('#go-login');
  if (loginBtn) loginBtn.addEventListener('click', () => go('#/login'));

  // 未读私信红点（登录后每 30 秒刷一次；入口在右上角用户小框里）
  if (root.querySelector('#user-menu')) {
    refreshUnreadBadge();
    clearInterval(window.__unreadTimer);
    window.__unreadTimer = setInterval(refreshUnreadBadge, 30000);
  } else {
    clearInterval(window.__unreadTimer);
  }

  const userMenu = root.querySelector('#user-menu');
  if (userMenu) userMenu.addEventListener('click', (event) => {
    event.stopPropagation();
    const existing = document.querySelector('.dropdown');
    if (existing) { existing.remove(); return; }
    const dd = document.createElement('div');
    dd.className = 'dropdown';
    const unread = document.getElementById('msg-badge')?.textContent || '0';
    dd.innerHTML = `
      <div class="dd-head"><b>${esc(store.nickname)}</b>
        <span>${store.isAdmin ? '管理员' : (viewKeyLabel())}　信用分 ${esc(store.user?.credit ?? '-')}</span></div>
      <button class="dd-item" data-go="#/messages">✉️ 我的消息
        <span class="badge badge-danger" id="dd-msg-count" style="${unread === '0' ? 'display:none' : ''}">${esc(unread)}</span>
      </button>
      <button class="dd-item" data-go="#/profile">👤 个人资料</button>
      <div class="dd-sep"></div>
      ${store.isAdmin ? '' : '<button class="dd-item" data-go="#/orders">📦 我的订单</button>'}
      ${store.isAdmin ? '' : '<button class="dd-item" data-go="#/favorites">⭐ 我的收藏</button>'}
      <button class="dd-item" data-logout>🚪 退出登录</button>`;
    document.body.appendChild(dd);

    // 小框打开后顺手把未读数刷成最新（同时更新头像上的红点）
    api.get('/api/messages/unread').then((data) => {
      const count = data?.count ?? 0;
      const ddCount = dd.querySelector('#dd-msg-count');
      if (ddCount) { ddCount.textContent = count; ddCount.style.display = count > 0 ? '' : 'none'; }
      const badge = document.getElementById('msg-badge');
      if (badge) { badge.textContent = count; badge.style.display = count > 0 ? '' : 'none'; }
    }).catch(() => { /* 静默 */ });

    dd.querySelectorAll('[data-go]').forEach(btn =>
      btn.addEventListener('click', () => { dd.remove(); go(btn.dataset.go); }));
    dd.querySelector('[data-logout]').addEventListener('click', async () => {
      dd.remove();
      try { await api.post('/api/auth/logout'); } catch (err) { /* 忽略 */ }
      store.clearAuth();
      toast('已退出登录');
      go('#/login');
      render();
    });
    setTimeout(() => document.addEventListener('click', function off() {
      dd.remove(); document.removeEventListener('click', off);
    }), 0);
  });

  root.querySelector('#top-search').addEventListener('submit', (event) => {
    event.preventDefault();
    const keyword = root.querySelector('#top-search-input').value.trim();
    go(`#/search${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`);
  });
}

function viewKeyLabel() {
  return store.isAdmin ? '管理员' : '用户';
}

/** 顶栏未读私信红点 */
async function refreshUnreadBadge() {
  const badge = document.getElementById('msg-badge');
  if (!badge || !store.isLoggedIn) return;
  try {
    const data = await api.get('/api/messages/unread');
    badge.textContent = data.count;
    badge.style.display = data.count > 0 ? '' : 'none';
  } catch (err) { /* 未登录或网络异常时静默 */ }
}

/* ---------------------------------------------------------------- 路由渲染 */
let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const { path, query } = parseHash();

  if (path === '/login') {
    if (store.isLoggedIn) { go('#/home'); return; }
    document.querySelector('.dropdown')?.remove();
    renderLoginPage(query);
    return;
  }

  const matched = matchRoute(path);
  const viewKey = currentViewKey();

  if (!matched) {
    buildShell(viewKey, '');
    document.getElementById('page').innerHTML =
      emptyHtml('页面不存在，请从左侧菜单进入', '🧭');
    return;
  }

  const { route, params } = matched;

  if (route.auth === 'required' && !store.isLoggedIn) {
    const back = `#${path}`;
    toast('该功能需要先登录', 'warn');
    go(`#/login?next=${encodeURIComponent(back)}`);
    return;
  }

  buildShell(viewKey, route.menu);
  const page = document.getElementById('page');

  if (route.auth === 'admin' && !store.isAdmin) {
    page.innerHTML = emptyHtml('需要管理员身份。请退出后，在登录页选择「管理员」身份登录。', '🔒');
    return;
  }

  page.innerHTML = loadingHtml();
  try {
    const module = await route.load();
    if (token !== renderToken) return;   // 期间又切换了路由，放弃本次渲染
    await module.default.render(page, { params, query, view: viewKey, path, go });
  } catch (err) {
    if (token !== renderToken) return;
    console.error(err);
    page.innerHTML = emptyHtml(`页面加载失败：${err.message}`, '😵');
  }
}

/* ---------------------------------------------------------------- 启动 */
async function boot() {
  window.addEventListener('hashchange', render);
  // 功能⑦：资料页改完昵称/头像后，通知外壳重画顶栏
  window.addEventListener('cm:user-updated', () => render());

  if (store.token) {
    try {
      const data = await api.get('/api/auth/me');
      store.user = data.user;
      store.view = data.view;
      await ensureMeta().catch(() => {});
    } catch (err) {
      store.clearAuth();
    }
  }

  if (!location.hash) {
    // 用 replaceState 设初值不会触发 hashchange，避免启动时渲染两次
    history.replaceState(null, '', '#/home');
  }
  await render();
}

boot();
