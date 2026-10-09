/* ==========================================================================
   全局状态：登录凭证、当前身份视角、全局枚举缓存
   ========================================================================== */

const TOKEN_KEY = 'cm_token';
const VIEW_KEY = 'cm_view';

const listeners = new Set();

export const store = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  view: localStorage.getItem(VIEW_KEY) || '',   // buyer / seller / admin
  user: null,
  meta: null,          // /api/meta 的缓存
  categories: null,    // 分类（含小类）缓存
  places: null,        // 校园地点缓存

  get isLoggedIn() { return Boolean(this.token); },
  get isAdmin() { return this.user?.role === 'admin'; },
  get nickname() { return this.user?.nickname || ''; },

  /** 普通用户可以在买家 / 卖家两个视角之间切换；管理员不行 */
  get canSwitchView() {
    return Boolean(this.user) && this.user.role !== 'admin';
  },

  setAuth(token, user, view) {
    this.token = token || '';
    this.user = user || null;
    this.view = view || (user ? user.role : '');
    localStorage.setItem(TOKEN_KEY, this.token);
    if (this.view) localStorage.setItem(VIEW_KEY, this.view);
    this.emit();
  },

  setUser(user) {
    this.user = user;
    this.emit();
  },

  switchView(view) {
    if (!this.canSwitchView) return;
    this.view = view;
    localStorage.setItem(VIEW_KEY, view);
    this.emit();
  },

  clearAuth() {
    this.token = '';
    this.user = null;
    this.view = '';
    this.categories = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(VIEW_KEY);
    this.emit();
  },

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { listeners.forEach(fn => fn()); },
};
