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

  /**
   * 需求④：已取消「买家 / 卖家」身份切换——同一个账号既能买也能卖，
   * 没有可切换的身份。`view` 现在只是「账号角色」（buyer / seller / admin），
   * 仍有几处（如无议）在读它，所以字段保留，但不再有任何切换入口。
   */
  get canSwitchView() { return false; },

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
    // 保留空实现：老代码或旧缓存里的调用不会再造成「视角切换」的假象
    void view;
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
