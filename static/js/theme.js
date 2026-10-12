/* ==========================================================================
   主题切换（paper 纸白 / ink 墨黑 / cream 米杏）
   --------------------------------------------------------------------------
   只做一件事：在 <html> 上打 data-theme 属性，并把三胶囊切换器**追加**到
   顶栏末尾。不改动任何既有节点的位置与数量，不碰任何功能逻辑。
   主题取色统一走 CSS 变量，页面里不要写死颜色。
   ========================================================================== */

export const THEMES = [
  { key: 'paper', label: '纸白' },
  { key: 'ink', label: '墨黑' },
  { key: 'cream', label: '米杏' },
];

const STORAGE_KEY = 'cm_theme';
const DEFAULT_THEME = 'paper';

/** 主题变化事件名：canvas 类页面（看板图表、交易地图）监听它来重绘 */
export const THEME_EVENT = 'cm:theme-changed';

export function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return THEMES.some(x => x.key === t) ? t : DEFAULT_THEME;
}

/**
 * 切换主题。只改 <html> 的 data-theme 属性（属性不是 DOM 节点），
 * 并派发事件通知需要重绘的画布。
 */
export function setTheme(key, { persist = true } = {}) {
  const theme = THEMES.some(x => x.key === key) ? key : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (err) { /* 隐私模式下忽略 */ }
  }
  // 同步切换器的高亮状态
  document.querySelectorAll('.theme-switch button').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.theme === theme));
  });
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
  return theme;
}

/** 启动时调用：把上次选的主题贴到 <html> 上 */
export function initTheme() {
  let saved = '';
  try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch (err) { saved = ''; }
  return setTheme(saved || DEFAULT_THEME, { persist: false });
}

/**
 * 把三胶囊切换器追加到容器（顶栏）**末尾**。
 * 注意：这是全站唯一被允许新增的节点，其它 DOM 一律不动。
 */
export function mountThemeSwitcher(container) {
  if (!container || container.querySelector('.theme-switch')) return null;
  const box = document.createElement('div');
  box.className = 'theme-switch';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', '主题外观');
  const active = currentTheme();
  box.innerHTML = THEMES.map(t => `
    <button type="button" data-theme="${t.key}" title="切换到${t.label}"
            aria-pressed="${t.key === active}">${t.label}</button>`).join('');
  box.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-theme]');
    if (btn) setTheme(btn.dataset.theme);
  });
  container.appendChild(box);
  return box;
}

/**
 * 读取当前主题下某个 CSS 变量的**计算值**，给 canvas 用。
 * 只能用于纯色 token（hex / rgba）——别用带 color-mix() 的，canvas 解析不了。
 */
export function cssVar(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 一组给 canvas 用的语义色，随主题变化 */
export function canvasPalette() {
  return {
    text: cssVar('--text', '#1C1B18'),
    subText: cssVar('--text-secondary', '#55524A'),
    muted: cssVar('--text-muted', '#8C8880'),
    line: cssVar('--border', '#E7E4DC'),
    strongLine: cssVar('--border-strong', '#D8D4C8'),
    surface: cssVar('--surface', '#FFFFFF'),
    bg: cssVar('--bg', '#FAF9F6'),
    primary: cssVar('--primary', '#2F4A3B'),
    primarySoft: cssVar('--primary-soft', '#E8EEE9'),
    accent: cssVar('--accent', '#7D9483'),
    danger: cssVar('--danger', '#A33F35'),
    warning: cssVar('--warning', '#8A6420'),
    success: cssVar('--success', '#2F6B45'),
  };
}
