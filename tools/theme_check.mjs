/* ==========================================================================
   主题视觉验证：paper / ink / cream 三套主题
   --------------------------------------------------------------------------
   1) 从 static/css/theme.css 解析令牌，**实算 WCAG 对比度**并给出判定；
   2) 无头浏览器逐页检查：能否正常渲染、有没有横向溢出、标题是否衬线、
      正文是否无衬线、价格是否衬线、主题是否真的生效；
   3) 校验主题切换器的位置：必须是顶栏**最后一个**子元素，且全站只有它一个新增节点。
   用法： node tools/theme_check.mjs [--shots]
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASE, api, login, launchBrowser, createRecorder, sleep } from './cdp_client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, '_build_tmp');
const SHOT_DIR = path.join(WORK, 'theme-shots');
const WANT_SHOTS = process.argv.includes('--shots');

const { check, summary, results } = createRecorder();

/* ---------------------------------------------------------------- 颜色工具 */
function hexToRgb(value) {
  const v = value.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const r = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (r) {
    const parts = r[1].split(',').map(x => parseFloat(x.trim()));
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
  }
  return null;
}

/** 把可能带透明度的颜色叠到底色上，得到实际显示色 */
function flatten(color, backdrop) {
  const c = hexToRgb(color);
  const b = hexToRgb(backdrop);
  if (!c || !b) return color;
  const a = c[3];
  return `rgb(${Math.round(c[0] * a + b[0] * (1 - a))},${Math.round(c[1] * a + b[1] * (1 - a))},${Math.round(c[2] * a + b[2] * (1 - a))})`;
}

function luminance(color) {
  const rgb = hexToRgb(color);
  if (!rgb) return 0;
  const [r, g, b] = rgb.slice(0, 3).map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const real = flatten(fg, bg);
  const l1 = luminance(real);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------------------------------------------------------- 解析 theme.css */
function parseThemes() {
  const raw = fs.readFileSync(path.join(ROOT, 'static', 'css', 'theme.css'), 'utf8');
  // 必须先剥掉注释：注释里写了「对比度 ≈9.4:1」这种带冒号的文字，
  // 否则按 ; 切分后会把注释后面那条声明一起吞掉。
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  const re = /(?::root,\s*\[data-theme="paper"\]|\[data-theme="(paper|ink|cream)"\])\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const key = m[1] || 'paper';
    out[key] = out[key] || {};
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim();
      const val = decl.slice(i + 1).trim();
      if (prop.startsWith('--')) out[key][prop] = val;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 要检查的页面 */
const PAGES = [
  { hash: '/home', name: '首页商品流' },
  { hash: '/search', name: '搜索与筛选' },
  { hash: '/product/1', name: '商品详情' },
  { hash: '/compare', name: '比价' },
  { hash: '/posts', name: '交流广场' },
  { hash: '/login', name: '登录注册', guest: true },
  { hash: '/publish', name: '发布商品', as: ['seller1', '123456', 'seller'] },
  { hash: '/my-products', name: '我的商品', as: ['seller1', '123456', 'seller'] },
  { hash: '/sold', name: '卖出订单', as: ['seller1', '123456', 'seller'] },
  { hash: '/orders', name: '我的订单', as: ['buyer1', '123456', 'buyer'] },
  { hash: '/favorites', name: '我的收藏', as: ['buyer1', '123456', 'buyer'] },
  { hash: '/swaps', name: '以物换物', as: ['buyer1', '123456', 'buyer'] },
  { hash: '/messages', name: '私信', as: ['buyer1', '123456', 'buyer'] },
  { hash: '/profile', name: '个人资料', as: ['buyer1', '123456', 'buyer'] },
  { hash: '/admin', name: '管理后台', as: ['admin', '123456', 'admin'] },
  { hash: '/dashboard', name: '数据看板', as: ['admin', '123456', 'admin'] },
];

/* ---------------------------------------------------------------- 1. 对比度 */
function checkContrast() {
  const themes = parseThemes();
  const pairs = [
    ['--text', '--bg', 4.5, '正文/页面底'],
    ['--text', '--surface', 4.5, '正文/卡片'],
    ['--text-secondary', '--surface', 4.5, '次级文字/卡片'],
    ['--text-muted', '--surface', 4.5, '辅助信息/卡片'],
    ['--text-muted', '--bg', 4.5, '辅助信息/页面底'],
    ['--on-primary', '--primary', 4.5, '主按钮文字/主色'],
    ['--primary', '--surface', 3.0, '链接主色/卡片'],
    ['--danger', '--surface', 4.5, '危险色文字/卡片'],
    ['--warning', '--surface', 4.5, '警告色文字/卡片'],
    ['--border', '--surface', 1.05, '发丝线可见'],
  ];

  for (const theme of ['paper', 'ink', 'cream']) {
    const t = themes[theme];
    const lines = [];
    let ok = true;
    for (const [fg, bg, min, label] of pairs) {
      const ratio = contrast(t[fg], t[bg]);
      const pass = ratio >= min;
      if (!pass) ok = false;
      lines.push(`${label} ${ratio.toFixed(2)}:1${pass ? '' : ` <${min}`}`);
    }
    check(`${theme} 主题文字对比度达标（WCAG AA）`, ok, lines.join('；'));
  }
}

/* ---------------------------------------------------------------- 2. 顶栏结构 */
async function checkTopbar(cdp) {
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/home');
  const bar = await cdp.eval(`
    (() => {
      const el = document.querySelector('.topbar');
      const kids = [...el.children].map(c => c.className.split(' ')[0] || c.tagName.toLowerCase());
      return {
        kids,
        switcherCount: el.querySelectorAll('.theme-switch').length,
        lastIsSwitcher: el.lastElementChild?.classList.contains('theme-switch') || false,
        pills: [...el.querySelectorAll('.theme-switch button')].map(b => b.textContent.trim()),
      };
    })()`);
  check('主题切换器是顶栏最后一个子元素，且全站只有一个',
    bar.switcherCount === 1 && bar.lastIsSwitcher, JSON.stringify(bar));
  check('顶栏元素顺序（需求④ 去掉了身份滑块：品牌 → 搜索 → 右侧 → 主题切换器）',
    bar.kids.slice(0, 3).join('|') === 'brand|search-box|topbar-right'
    && bar.kids.length === 4,
    `实际子元素=${JSON.stringify(bar.kids)}`);
  check('需求④：顶栏不再有「买家 / 卖家」身份滑块',
    await cdp.eval(`!document.querySelector('#view-toggle') && !document.querySelector('.view-switch')`) === true,
    JSON.stringify(bar.kids));
  check('三胶囊为 纸白 / 墨黑 / 米杏',
    bar.pills.join('') === '纸白墨黑米杏', JSON.stringify(bar.pills));

  // 游客也看一眼（需求④ 之后任何人都不再有身份滑块）
  await cdp.logout();
  await cdp.go('/home');
  const guest = await cdp.eval(`
    (() => {
      const el = document.querySelector('.topbar');
      return {
        kids: [...el.children].map(c => c.className.split(' ')[0] || c.tagName.toLowerCase()),
        lastIsSwitcher: el.lastElementChild?.classList.contains('theme-switch') || false,
      };
    })()`);
  check('游客视角：切换器同样在末尾，其余元素顺序不变',
    guest.lastIsSwitcher && guest.kids.slice(0, 3).join('|') === 'brand|search-box|topbar-right',
    JSON.stringify(guest.kids));
}

/* ---------------------------------------------------------------- 3. 逐页 × 主题 */
async function checkPages(cdp) {
  // 地图页需要一条订单；拿买家待完成订单，没有就跳过
  let mapHash = null;
  try {
    const tk = await login('buyer1', '123456', 'buyer');
    const mine = await api('GET', '/api/orders/mine?status=pending&page_size=1', { token: tk });
    const order = (mine.data?.list || [])[0];
    if (order) mapHash = `/order/${order.id}/map`;
  } catch { /* 忽略 */ }
  const pages = mapHash ? [...PAGES, { hash: mapHash, name: '交易定位地图', as: ['buyer1', '123456', 'buyer'] }] : PAGES;
  if (!mapHash) console.log('  （没有待完成订单，跳过交易定位地图页）');

  for (const theme of ['paper', 'ink', 'cream']) {
    const problems = [];

    // 先在带顶栏的页面上真实点一次三胶囊，确认切换生效
    await cdp.loginAs('buyer1', '123456', 'buyer');
    await cdp.go('/home');
    const switched = await cdp.eval(`
      (() => {
        const btn = [...document.querySelectorAll('.theme-switch button')]
          .find(b => b.dataset.theme === ${JSON.stringify(theme)});
        if (!btn) return null;
        btn.click();
        return document.documentElement.getAttribute('data-theme');
      })()`);
    if (switched !== theme) problems.push(`点切换器后主题未生效（得到 ${switched}）`);

    for (const page of pages) {
      if (page.guest) await cdp.logout();
      else if (page.as) await cdp.loginAs(...page.as);

      await cdp.go(page.hash);
      await sleep(page.as ? 700 : 500);

      // 登录页是独立卡片（没有 #page、也没有顶栏），容器要分开判断
      const container = page.guest ? '.auth-card' : '#page';
      const applied = await cdp.eval(`
        (() => {
          const box = document.querySelector(${JSON.stringify(container)});
          const body = getComputedStyle(document.body);
          const h1 = document.querySelector('#page h1, #page h2, .auth-title');
          const price = document.querySelector('#page .price, #page .detail-price');
          const fam = (el) => el ? getComputedStyle(el).fontFamily : '';
          return {
            theme: document.documentElement.getAttribute('data-theme'),
            bg: body.backgroundColor,
            hasContent: !!box && (box.innerText || '').trim().length > 4,
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
            h1Font: fam(h1),
            priceFont: fam(price),
            bodyFont: body.fontFamily,
          };
        })()`);

      if (applied.theme !== theme) problems.push(`${page.name}: 主题未生效(${applied.theme})`);
      if (!applied.hasContent) problems.push(`${page.name}: 页面空白`);
      if (applied.overflowX > 2) problems.push(`${page.name}: 横向溢出 ${applied.overflowX}px`);
      if (applied.h1Font && !/Georgia|Songti|Serif|SimSun|serif/i.test(applied.h1Font)) {
        problems.push(`${page.name}: 标题不是衬线（${applied.h1Font.slice(0, 40)}）`);
      }
      if (applied.priceFont && !/Georgia|Songti|Serif|SimSun|serif/i.test(applied.priceFont)) {
        problems.push(`${page.name}: 价格不是衬线`);
      }
      if (!/PingFang|YaHei|system-ui|sans-serif/i.test(applied.bodyFont)) {
        problems.push(`${page.name}: 正文不是无衬线`);
      }

      if (WANT_SHOTS && ['首页商品流', '商品详情', '交流广场', '登录注册'].includes(page.name)) {
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await cdp.shot(path.join(SHOT_DIR, `${theme}-${page.hash.replace(/\W+/g, '_')}.png`));
      }
    }

    check(`${theme} 主题：${pages.length} 个页面渲染正常、无横向溢出、字体层级正确`,
      switched === theme && problems.length === 0,
      problems.length ? problems.slice(0, 6).join('；') : `已逐页确认（${pages.length} 页）`);
  }

  // 最后确认切换是可逆的、并落到 localStorage
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/home');
  const cycle = await cdp.eval(`
    (() => {
      const out = [];
      for (const t of ['ink', 'cream', 'paper']) {
        document.querySelector('.theme-switch button[data-theme="' + t + '"]').click();
        out.push(document.documentElement.getAttribute('data-theme') + '/' + localStorage.getItem('cm_theme'));
      }
      return out;
    })()`);
  check('三套主题可来回切换且写入 localStorage', cycle.join(' ') === 'ink/ink cream/cream paper/paper', cycle.join(' '));
}

/* ---------------------------------------------------------------- 4. 宽屏几何 */
/* 之前的验证窗口固定 1500×1000，1500−190=1310 < 内容上限，所以「宽屏下内容偏左、
   右侧一大片空」的问题一直没被发现。这里补一条宽屏断言，防止回归。 */
async function checkWideLayout(cdp) {
  const widths = [1500, 1680, 1920, 2560];
  const pages = [
    { hash: '/home', name: '首页', as: null },
    { hash: '/dashboard', name: '数据看板', as: ['admin', '123456', 'admin'] },
  ];
  const problems = [];

  for (const width of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    for (const page of pages) {
      if (page.as) await cdp.loginAs(...page.as);
      else await cdp.logout();
      await cdp.go(page.hash);
      await sleep(page.as ? 800 : 600);
      const m = await cdp.eval(`
        (() => {
          const de = document.documentElement;
          const content = document.querySelector('.content');
          const side = document.querySelector('.sidebar');
          const cr = content.getBoundingClientRect();
          const sr = side.getBoundingClientRect();
          return {
            viewport: de.clientWidth,
            scrollX: de.scrollWidth - de.clientWidth,
            gapLeft: Math.round(cr.left - sr.right),      // 侧栏与内容之间的空当
            gapRight: Math.round(de.clientWidth - cr.right), // 内容右侧的空当
            contentW: Math.round(cr.width),
          };
        })()`);
      if (m.scrollX > 2) problems.push(`${width}/${page.name}: 出现横向滚动 ${m.scrollX}px`);
      // 只有在没有把可用宽度吃满时才要求左右均分（窄屏时本来就该铺满）
      if (m.gapLeft > 4 || m.gapRight > 4) {
        if (Math.abs(m.gapLeft - m.gapRight) > 4) {
          problems.push(`${width}/${page.name}: 左右留白不均（左 ${m.gapLeft} / 右 ${m.gapRight}）`);
        }
      }
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  check(`宽屏（${widths.join('/')}）下内容居中、无横向滚动`,
    problems.length === 0, problems.join('；') || '四个屏宽 × 两个页面均已确认');
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  try {
    await api('GET', '/api/health');
  } catch {
    console.error(`服务没起来：${BASE}（先运行 start-service.bat）`);
    process.exit(2);
  }

  console.log('===== 一、主题令牌与对比度 =====');
  checkContrast();

  const { cdp, close } = await launchBrowser({ port: 9351 });
  try {
    console.log('\n===== 二、顶栏结构（确认没有多出/挪动节点）=====');
    await checkTopbar(cdp);
    console.log('\n===== 三、逐页 × 三套主题 =====');
    await checkPages(cdp);
    console.log('\n===== 四、宽屏几何（内容居中、无横向滚动）=====');
    await checkWideLayout(cdp);
  } finally {
    close();
  }

  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'theme-report.json'),
    JSON.stringify({ ran_at: new Date().toISOString(), results }, null, 2));
  process.exit(summary());
}

main().catch((err) => {
  console.error('主题验证脚本异常：', err);
  process.exit(2);
});
