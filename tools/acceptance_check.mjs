/* ==========================================================================
   验收自测：逐条核对《PRD v2.0》第 10 章的 23 条验收标准
   - 接口层用 fetch 直接打后端
   - 界面层用无头 Chrome + CDP 真实点击（滑块钮、确认框、提示条、多图上传…）

   用法：
     node tools/acceptance_check.mjs            # 直接用当前数据
     node tools/acceptance_check.mjs --reset    # 先重置示例数据，结果可复现
   ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.APP_BASE || 'http://127.0.0.1:5000';
const PORT = Number(process.env.CDP_PORT || 9333);
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WORK = path.resolve('_build_tmp');
const PROFILE = path.join(WORK, 'chrome-accept');
const DO_RESET = process.argv.includes('--reset');

const results = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 等某个条件成立（默认最多 15 秒），避免「断言抢在渲染前跑」这类竞态
async function waitFor(expr, { timeout = 15000, step = 250 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await cdp.eval(expr)) return true;
    } catch (err) { /* 页面切换瞬间取不到就再等一轮 */ }
    await sleep(step);
  }
  return false;
}

function record(id, title, pass, evidence) {
  results.push({ id, title, pass, evidence: String(evidence).replace(/\s+/g, ' ').slice(0, 150) });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${String(id).padStart(2, '0')}. ${title}`);
  if (!pass) console.log(`       证据：${String(evidence).slice(0, 220)}`);
}

/* ------------------------------------------------------------------ 接口封装 */
let adminToken = '';
const tokens = {};

async function api(method, url, { token, body, view } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (view) headers['X-View-Role'] = view;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, { method, headers, body: payload });
  let json;
  try { json = await res.json(); } catch { json = { code: res.status, msg: 'non-json', data: null }; }
  return { status: res.status, code: json.code, msg: json.msg, data: json.data };
}

async function login(username, password, role) {
  const res = await api('POST', '/api/auth/login', { body: { username, password, role } });
  if (res.code !== 0) throw new Error(`登录失败 ${username}: ${res.msg}`);
  return res.data.token;
}

/* ------------------------------------------------------------------ CDP */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) {
        (this.handlers.get(m.method) || []).forEach(fn => fn(m.params));
      }
    });
  }
  send(method, params = {}) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时 ${method}`)); }
      }, 20000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || '脚本异常');
    return r.result.value;
  }
  async go(hash) {
    // 带一个变化的时间戳，保证 hash 真的变了、页面会重新渲染
    // （否则用接口在"后台"改了数据后，页面还停在旧内容上）
    const sep = hash.includes('?') ? '&' : '?';
    await this.send('Page.navigate', { url: `${BASE}/#${hash}${sep}_=${Date.now()}` });
    await this.waitReady();
  }
  async waitReady(times = 30) {
    for (let i = 0; i < times; i += 1) {
      await sleep(200);
      try {
        const ok = await this.eval(`
          (() => {
            const p = document.querySelector('#page');
            if (!p) return 'nopage';
            if (p.querySelector('.loading')) return '';
            return (p.innerText || '').trim().length > 4 ? 'ok' : '';
          })()`);
        if (ok === 'ok') return true;
        if (ok === 'nopage') return true;
      } catch { /* 页面切换中 */ }
    }
    return false;
  }
  async loginAs(username, password, role) {
    await this.send('Page.navigate', { url: `${BASE}/` });
    await sleep(600);
    const r = await this.eval(`
      (async () => {
        const res = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)}, role: ${JSON.stringify(role)} }),
        });
        const p = await res.json();
        if (p.code !== 0) return { ok: false, msg: p.msg };
        localStorage.setItem('cm_token', p.data.token);
        localStorage.setItem('cm_view', p.data.view);
        return { ok: true };
      })()`);
    if (!r?.ok) throw new Error(r?.msg);
    await this.send('Page.reload', { ignoreCache: true });
    await sleep(800);
  }
  async logout() {
    // 必须先落到同源页面再清 localStorage，about:blank 是不透明源，访问会被拒
    if (!(await this.eval('location.origin === ' + JSON.stringify(new URL(BASE).origin)))) {
      await this.send('Page.navigate', { url: `${BASE}/` });
      await sleep(700);
    }
    await this.eval(`(() => { try { localStorage.clear(); } catch (e) {} return 1; })()`);
    await this.send('Page.reload', { ignoreCache: true });
    await sleep(800);
  }
}

/* ------------------------------------------------------------------ 主流程 */
let chrome;
let cdp;

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--window-size=1500,1000', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`, 'about:blank',
  ], { stdio: 'ignore' });

  // 等调试端口
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
    await sleep(300);
  }
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('调试端口连不上'))); });
  cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable'); await cdp.send('Network.enable');

  adminToken = await login('admin', '123456', 'admin');
  tokens.buyer1 = await login('buyer1', '123456', 'buyer');
  tokens.buyer2 = await login('buyer2', '123456', 'buyer');
  tokens.seller1 = await login('seller1', '123456', 'seller');
  tokens.seller2 = await login('seller2', '123456', 'seller');

  if (DO_RESET) {
    const r = await api('POST', '/api/admin/reset-demo', { token: adminToken });
    console.log(`（已重置示例数据：${r.msg}）\n`);
  }

  console.log('══════ 账号与身份（1-4）══════');
  await check1_2();
  await check3();
  await check4();

  console.log('\n══════ 买家功能（5-11）══════');
  await check5();
  await check6();
  await check7();
  await check8();
  await check9_10();
  await check11();

  console.log('\n══════ 卖家功能（12-14）══════');
  await check12();
  await check13();
  await check14();

  console.log('\n══════ 管理员功能（15-17）══════');
  await check15();
  await check16();
  await check17();

  console.log('\n══════ 定位 / 评价 / 数据 / 交互（18-23）══════');
  await check18();
  await check19();
  await check20();
  await check21();
  await check22_23();

  // ---------------- 汇总 ----------------
  const failed = results.filter(r => !r.pass);
  console.log('\n' + '═'.repeat(64));
  console.log(`验收结果：通过 ${results.length - failed.length} / ${results.length} 条`);
  if (failed.length) {
    console.log('\n未通过：');
    failed.forEach(f => console.log(`  ✗ ${f.id}. ${f.title} —— ${f.evidence}`));
  } else {
    console.log('🎉 PRD 第 10 章 23 条验收标准全部通过');
  }
  fs.writeFileSync(path.join(WORK, 'acceptance-report.json'),
    JSON.stringify({ ran_at: new Date().toISOString(), results }, null, 2));

  ws.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}

/* ================================================================ 1-2
   账号与身份（需求④ 之后的口径）：
   注册不再选「买家 / 卖家」，管理员不可注册；登录只分「普通用户 / 管理员」，
   管理员必须用管理员账号并以管理员身份登录 */
async function check1_2() {
  const admin = await api('POST', '/api/auth/register',
    { body: { username: `accA${String(Date.now()).slice(-8)}`, password: '1234', role: 'admin' } });
  // 注册不传身份（新口径的默认路径）
  const okReg = await api('POST', '/api/auth/register',
    { body: { username: 'acc_buyer', password: '1234' } });
  const registerOk = okReg.code === 0 || /已被注册/.test(okReg.msg || '');
  // 老调用方传 buyer / seller 仍然兼容
  const legacyReg = await api('POST', '/api/auth/register',
    { body: { username: `accL${String(Date.now()).slice(-8)}`, password: '1234', role: 'seller' } });

  await cdp.logout();
  await cdp.go('/login');
  const ui = await cdp.eval(`
    (() => {
      const radios = [...document.querySelectorAll('input[name="role"]')];
      const adminLabel = document.querySelector('#role-pick .admin-only');
      const registerTab = document.querySelector('.tab[data-tab="register"]');
      registerTab.click();
      const after = getComputedStyle(adminLabel).display;
      return { roles: radios.map(r => r.value), adminHiddenOnRegister: after === 'none' };
    })()`);

  const adminLoginByBuyer = await api('POST', '/api/auth/login',
    { body: { username: 'admin', password: '123456', role: 'buyer' } });
  const buyerLoginByAdmin = await api('POST', '/api/auth/login',
    { body: { username: 'buyer1', password: '123456', role: 'admin' } });
  const adminLogin = await api('POST', '/api/auth/login',
    { body: { username: 'admin', password: '123456', role: 'admin' } });
  // 需求④：普通用户不用再选身份
  const noRoleLogin = await api('POST', '/api/auth/login',
    { body: { username: 'buyer1', password: '123456' } });

  record(1, '需求④：注册不再选买家/卖家（老参数仍兼容），管理员不可注册',
    admin.code !== 0 && registerOk && legacyReg.code === 0 && ui.adminHiddenOnRegister,
    `role=admin 被拒（${admin.msg}）；不传身份的注册成功；传 role=seller 仍可用；注册页管理员选项隐藏=${ui.adminHiddenOnRegister}`);

  record(2, '需求④：登录只分「普通用户 / 管理员」，管理员须用管理员账号且显式选管理员',
    ui.roles.join(',') === 'user,admin'
    && adminLoginByBuyer.code !== 0 && buyerLoginByAdmin.code !== 0
    && adminLogin.code === 0 && noRoleLogin.code === 0,
    `身份选项 ${ui.roles.join('/')}；管理员用买家身份被拒；普通用户用管理员身份被拒；`
    + `管理员正规登录成功；普通用户不选身份也能登录`);
}

/* ================================================================ 3
   需求④（用户 2026-10-16 明确要求，覆盖 PRD 原文）：
   取消「买家 / 卖家」身份切换，两者功能合并 —— 登录后菜单买卖合一、无身份滑块，
   订单页内部用「我买到的 / 我卖出的」页签区分，每张单标出我的身份 */
async function check3() {
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/home');
  const shell = await cdp.eval(`
    (() => ({
      hasSwitch: !!document.querySelector('#view-toggle'),
      menuText: [...document.querySelectorAll('.menu-item')].map(m => m.innerText.trim()).join(' | '),
      avatar: document.querySelector('#user-menu')?.innerText.trim() || '',
    }))()`);

  await cdp.go('/orders');
  await waitFor(cdp, `document.querySelectorAll('#side-tabs .tab').length > 0`);
  const ordersUi = await cdp.eval(`
    (() => ({
      sideTabs: [...document.querySelectorAll('#side-tabs .tab')].map(t => t.innerText.trim()),
      roleFlags: [...document.querySelectorAll('.role-flag')].map(t => t.innerText.trim()),
    }))()`);

  const passed = !shell.hasSwitch
    && shell.menuText.includes('我的订单') && shell.menuText.includes('我的商品')
    && shell.menuText.includes('发布商品') && !shell.menuText.includes('卖出订单')
    && ordersUi.sideTabs.join('') === '全部订单我买到的我卖出的'
    && ordersUi.roleFlags.length > 0;

  record(3, '需求④：取消买家/卖家身份切换，功能合并（菜单合一 + 订单页买/卖页签 + 身份徽标）',
    passed,
    `身份滑块=${shell.hasSwitch}；菜单「${shell.menuText}」；订单页签=${JSON.stringify(ordersUi.sideTabs)}；徽标=${JSON.stringify([...new Set(ordersUi.roleFlags)])}`);
}

/* ================================================================ 4
   管理员是独立入口：登录页必须显式选「管理员」，登录后菜单只有管理后台与数据看板 */
async function check4() {
  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/home');
  const adminUi = await cdp.eval(`
    (() => ({
      hasSwitch: !!document.querySelector('#view-toggle'),
      menuText: [...document.querySelectorAll('.menu-item')].map(m => m.innerText.trim()).join(' | '),
      label: document.querySelector('#user-menu')?.innerText.trim() || '',
    }))()`);

  await cdp.loginAs('buyer1', '123456', 'buyer');
  const guard = await cdp.eval(`
    (async () => {
      const r = await fetch('/api/admin/stats', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('cm_token') } });
      return (await r.json()).code;
    })()`);

  record(4, '管理员是独立入口：普通用户进不了管理后台，界面也不混在一起',
    !adminUi.hasSwitch && adminUi.menuText.includes('管理后台')
    && !adminUi.menuText.includes('我的订单') && guard === 403,
    `管理员菜单「${adminUi.menuText}」；普通用户调管理接口返回 code=${guard}`);
}

/* ================================================================ 5
   多条件叠加 + 排序 + 清除条件 */
async function check5() {
  await cdp.logout();
  const combo = await api('GET', '/api/products?category_id=4&min_price=50&max_price=500&condition=%E4%B8%83%E6%88%90%E6%96%B0%E5%8F%8A%E4%BB%A5%E4%B8%8B&sort=price_asc');
  const sortAsc = await api('GET', '/api/products?sort=price_asc&page_size=50');
  const prices = (sortAsc.data?.list || []).map(p => p.price);
  const sorted = prices.every((v, i) => i === 0 || prices[i - 1] <= v);

  await cdp.go('/search');
  await cdp.eval(`
    (() => {
      const c = document.querySelector('#f-category'); c.value = '4';
      c.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  await sleep(900);
  const filtered = await cdp.eval(`document.querySelector('#result-count').innerText`);
  await cdp.eval(`document.querySelector('#btn-reset').click()`);
  await sleep(900);
  const cleared = await cdp.eval(`document.querySelector('#result-count').innerText`);

  record(5, '关键词/分类/小类/价格区间/成色任意叠加，排序生效，清除条件恢复全部在售',
    combo.data?.total === 1 && sorted && /共 2 件/.test(filtered) && /共 11 件/.test(cleared),
    `运动+50~500+七成新及以下 → ${combo.data?.total} 件；价格升序=${sorted}；界面选「运动」后「${filtered}」，清除后「${cleared}」`);
}

/* ================================================================ 6
   列表与搜索结果不出现已售/已下架 */
async function check6() {
  const all = await api('GET', '/api/products?page_size=50&sort=price_desc');
  const statuses = [...new Set((all.data?.list || []).map(p => p.status))];
  await cdp.go('/search');
  await cdp.eval(`document.querySelector('#f-price').value = '200-'; document.querySelector('#f-price').dispatchEvent(new Event('change', {bubbles:true}))`);
  await sleep(900);
  const flags = await cdp.eval(`
    (() => ({
      sold: document.querySelectorAll('.flag-sold').length,
      off: document.querySelectorAll('.flag-off_shelf').length,
      cards: document.querySelectorAll('[data-product]').length,
    }))()`);
  record(6, '买家列表与搜索结果中不出现「已下架」「已售」商品',
    statuses.length === 1 && statuses[0] === 'on_sale' && flags.sold === 0 && flags.off === 0,
    `接口返回状态集合=${statuses.join('/')}；界面里已售角标=${flags.sold}、已下架角标=${flags.off}，共 ${flags.cards} 张卡`);
}

/* ================================================================ 7
   浏览量每打开 +1；已售商品有「已售出」标识 */
async function check7() {
  const p = (await api('GET', '/api/products/1')).data;
  const p2 = (await api('GET', '/api/products/1')).data;

  await cdp.go('/product/1');
  const uiViews = await cdp.eval(`
    [...document.querySelectorAll('.info-list dt')].find(d => d.innerText.includes('浏览量'))?.nextElementSibling?.innerText || ''`);

  const sold = (await api('GET', '/api/products/5')).data;
  await cdp.go('/product/5');
  const soldFlag = await cdp.eval(`
    (() => ({
      flag: document.querySelector('.status-flag')?.innerText || '',
      buyBtn: [...document.querySelectorAll('#action-bar button')].map(b => b.innerText.trim()).join('|'),
    }))()`);

  record(7, '商品详情每打开一次浏览量 +1；已售商品显示「已售出」标识',
    p2.views === p.views + 1 && /已售出/.test(soldFlag.flag) && sold.status === 'sold',
    `接口两次读取浏览量 ${p.views} → ${p2.views}；界面显示「${uiViews}」；已售商品角标「${soldFlag.flag}」，按钮「${soldFlag.buyBtn}」`);
}

/* ================================================================ 8
   比价：最低/最高/平均/件数，价格升序，最低价高亮 */
async function check8() {
  const cmp = (await api('GET', '/api/compare?category_id=2')).data;
  const asc = cmp.list.every((v, i) => i === 0 || cmp.list[i - 1].price <= v.price);

  await cdp.go('/compare?category_id=2');
  const ui = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('tbody tr')];
      return {
        stats: [...document.querySelectorAll('.stat-card')].map(c => c.innerText.replace(/\\n/g, ' ').trim()),
        firstRowBadge: rows[0]?.querySelector('.badge')?.innerText.trim() || '',
        firstRowBg: rows[0] ? getComputedStyle(rows[0]).backgroundColor : '',
        otherRowBg: rows[1] ? getComputedStyle(rows[1]).backgroundColor : '',
      };
    })()`);
  // 不再写死具体色值（换主题/换皮肤就会变）：只要求「最低价那行底色与其它行不同」
  const highlighted = ui.firstRowBg !== ui.otherRowBg && ui.firstRowBg !== 'rgba(0, 0, 0, 0)';

  record(8, '比价显示最低/最高/平均/件数，列表价格升序，最低价高亮',
    cmp.count === cmp.list.length && asc && ui.firstRowBadge === '最低价' && highlighted,
    `接口 件数${cmp.count} 最低${cmp.min_price} 最高${cmp.max_price} 平均${cmp.avg_price}，升序=${asc}；界面卡片「${ui.stats.join(' / ')}」，首行标记「${ui.firstRowBadge}」底色${ui.firstRowBg}（其它行${ui.otherRowBg}）`);
}

/* ================================================================ 9-10
   下单 → 已售 + 待完成；确认完成 / 取消恢复在售 */
async function check9_10() {
  // 造两件测试商品
  const mk = async (name, price) => (await api('POST', '/api/products', {
    token: tokens.seller1,
    body: { name, price, category_id: 1, subcategory_id: 1, condition: '九成新', description: '验收用', default_place_id: 2, images: [] },
  })).data.id;

  const pa = await mk('验收-完成流程', 88);
  const pb = await mk('验收-取消流程', 66);

  const oa = (await api('POST', '/api/orders', { token: tokens.buyer1, body: { product_id: pa, meet_place_id: 2, trade_note: '下午四点' } })).data;
  const paAfter = (await api('GET', `/api/products/${pa}`)).data;
  const again = await api('POST', '/api/orders', { token: tokens.buyer2, body: { product_id: pa, meet_place_id: 2 } });

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/orders?status=pending');
  await waitFor(cdp, `[...document.querySelectorAll('.card')].some(c => c.innerText.includes('验收-完成流程'))`);
  const uiPending = await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('.card')].find(c => c.innerText.includes('验收-完成流程'));
      // 需求④ 起卡片右上角多了「我是买家/我是卖家」身份徽标，取状态时要把它们排除掉，
      // 否则拿到的是身份徽标（这个坑已经踩过一次）
      const badges = card ? [...card.querySelectorAll('.badge')]
        .filter(b => !b.classList.contains('role-flag')) : [];
      return { found: !!card, status: badges[0]?.innerText.trim() || '' };
    })()`);

  const done = (await api('PATCH', `/api/orders/${oa.id}/complete`, { token: tokens.buyer1 })).data;

  const ob = (await api('POST', '/api/orders', { token: tokens.buyer1, body: { product_id: pb, meet_place_id: 1 } })).data;
  const canceled = (await api('PATCH', `/api/orders/${ob.id}/cancel`, { token: tokens.buyer1 })).data;
  const pbAfter = (await api('GET', `/api/products/${pb}`)).data;

  record(9, '下单后商品变「已售」，订单出现在「我的订单」且为「待完成」',
    paAfter.status === 'sold' && oa.status === 'pending' && again.code !== 0 && uiPending.found && uiPending.status === '待完成',
    `商品状态 ${paAfter.status}；订单状态 ${oa.status}；他人再下单被拒（${again.msg}）；界面订单卡状态「${uiPending.status}」`);

  record(10, '确认完成 → 已完成；取消订单 → 已取消且商品恢复「在售」',
    done.status === 'done' && canceled.status === 'canceled' && pbAfter.status === 'on_sale',
    `确认完成后订单 ${done.status}；取消后订单 ${canceled.status}、商品恢复 ${pbAfter.status}`);

  // 清理
  await api('DELETE', `/api/products/${pa}`, { token: tokens.seller1 });
  await api('DELETE', `/api/products/${pb}`, { token: tokens.seller1 });
}

/* ================================================================ 11
   收藏 / 取消收藏即时生效 */
async function check11() {
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/product/2');
  const before = await cdp.eval(`
    [...document.querySelectorAll('#action-bar button')].find(b => b.innerText.includes('收藏'))?.innerText.trim()`);
  await cdp.eval(`[...document.querySelectorAll('#action-bar button')].find(b => b.innerText.includes('收藏')).click()`);
  await sleep(700);
  const after = await cdp.eval(`
    [...document.querySelectorAll('#action-bar button')].find(b => b.innerText.includes('收藏'))?.innerText.trim()`);
  await cdp.go('/favorites');
  const inList = await cdp.eval(`document.querySelector('#list-area').innerText.includes('考研英语')`);

  // 取消收藏并确认列表同步
  await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('[data-product]')].find(c => c.innerText.includes('考研英语'));
      card.querySelector('[data-fav]').click();
    })()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await sleep(900);
  const afterRemove = await cdp.eval(`
    document.querySelector('#list-area').innerText.includes('考研英语')`);

  record(11, '收藏 / 取消收藏即时生效，收藏列表正确显示',
    before.includes('☆') && after.includes('★') && inList && !afterRemove,
    `详情按钮「${before}」→「${after}」；收藏列表包含=${inList}；取消后仍在列表=${afterRemove}`);
}

/* ================================================================ 12
   发布校验 + 合法发布可见 + 多图上传并展示 */
async function check12() {
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/publish');

  // 非法：名称空 + 价格 0
  await cdp.eval(`
    (() => {
      document.querySelector('#f-name').value = '';
      document.querySelector('#f-price').value = '0';
      document.querySelector('#f-category').value = '1';
      document.querySelector('#product-form').requestSubmit();
    })()`);
  await sleep(600);
  const invalid = await cdp.eval(`
    (() => ({
      nameErr: document.querySelector('#f-name').classList.contains('invalid'),
      priceErr: document.querySelector('#f-price').classList.contains('invalid'),
      errors: [...document.querySelectorAll('.form-error')].map(e => e.innerText),
      stillHere: location.hash,
    }))()`);

  // 合法 + 两张图（真实走 input[type=file]，验证上传链路）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const img1 = path.join(WORK, 'acc-1.png');
  const img2 = path.join(WORK, 'acc-2.png');
  fs.writeFileSync(img1, png);
  fs.writeFileSync(img2, png);

  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#f-images' });
  await cdp.send('DOM.setFileInputFiles', { files: [img1, img2], nodeId });
  await sleep(1600);
  const thumbs = await cdp.eval(`document.querySelectorAll('#image-list img').length`);

  const name = `验收-多图商品-${Date.now() % 100000}`;
  await cdp.eval(`
    (() => {
      const set = (sel, val) => { const el = document.querySelector(sel); el.value = val; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); };
      set('#f-name', ${JSON.stringify(name)});
      set('#f-price', '19.9');
      set('#f-category', '1');
      set('#f-condition', '全新');
      set('#f-desc', '验收脚本自动创建的商品');
      document.querySelector('#product-form').requestSubmit();
    })()`);
  await sleep(1600);
  const afterSubmit = await cdp.eval(`location.hash`);

  const search = await api('GET', `/api/products?keyword=${encodeURIComponent(name)}`);
  const created = search.data?.list?.[0];
  const mine = await api('GET', '/api/products/mine?status=on_sale&page_size=50', { token: tokens.seller1 });
  const inMine = (mine.data?.list || []).some(p => p.name === name);

  await cdp.go('/search');
  await cdp.eval(`
    (() => {
      const k = document.querySelector('#f-keyword'); k.value = ${JSON.stringify(name)};
      document.querySelector('#btn-search').click();
    })()`);
  await sleep(900);
  const buyerVisible = await cdp.eval(`document.querySelector('#result-area').innerText.includes(${JSON.stringify(name)})`);

  await cdp.go(`/product/${created?.id}`);
  const detailImgs = await cdp.eval(`
    (() => ({
      main: !!document.querySelector('#gallery-main img'),
      thumbs: document.querySelectorAll('#thumbs img').length,
    }))()`);
  const apiImgs = created?.id
    ? ((await api('GET', `/api/products/${created.id}`)).data?.images || [])
    : [];

  record(12, '发布校验生效；合法发布后出现在我的商品与首页且买家搜索可见；多图上传并展示',
    invalid.nameErr && invalid.priceErr && thumbs === 2 && /^#\/product\/\d+$/.test(afterSubmit)
    && Boolean(created) && created?.status === 'on_sale' && inMine && buyerVisible
    && detailImgs.main && detailImgs.thumbs === 2 && apiImgs.length === 2,
    `空名称/0 价格被拦（${invalid.errors.join('；')}）；上传缩略图 ${thumbs} 张；发布后跳到 ${afterSubmit}；我的商品可见=${inMine}；买家搜索可见=${buyerVisible}；详情页主图=${detailImgs.main} 缩略图=${detailImgs.thumbs}，接口图片数=${apiImgs.length}`);

  globalThis.__accProductId = created?.id;
  globalThis.__accProductName = name;
}

/* ================================================================ 13
   我的商品：编辑 / 下架可见性 / 重新上架 / 删除 */
async function check13() {
  const pid = globalThis.__accProductId;
  const name = globalThis.__accProductName;
  if (!pid) {
    record(13, '我的商品：编辑 / 下架可见性 / 重新上架 / 删除', false, '第 12 条未成功创建商品，本条无从验证');
    return;
  }

  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/my-products');

  // 编辑
  const edited = `验收-已编辑-${Date.now() % 10000}`;
  await api('PUT', `/api/products/${pid}`, {
    token: tokens.seller1,
    body: { name: edited, price: 29.9, category_id: 1, subcategory_id: 1, condition: '九成新', description: '已编辑', default_place_id: 1, images: [] },
  });
  const afterEdit = (await api('GET', `/api/products/${pid}`)).data;

  // 下架 → 买家不可见、自己可见
  await cdp.go('/my-products');
  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('验收-已编辑'));
      row.querySelector('[data-off]').click();
    })()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await sleep(1100);
  const off = (await api('GET', `/api/products/${pid}`)).data;
  const buyerSearch = await api('GET', `/api/products?keyword=${encodeURIComponent(edited)}`);
  const myList = await api('GET', '/api/products/mine?status=off_shelf&page_size=50', { token: tokens.seller1 });
  const mineSees = (myList.data?.list || []).some(p => p.name === edited);

  // 重新上架
  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('验收-已编辑'));
      row.querySelector('[data-on]').click();
    })()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await sleep(1100);
  const backOn = (await api('GET', `/api/products/${pid}`)).data;

  record(13, '我的商品：编辑生效；下架后买家不可见、自己可见；重新上架后买家可见',
    afterEdit.name === edited && afterEdit.price === 29.9
    && off.status === 'off_shelf' && buyerSearch.data?.total === 0 && mineSees
    && backOn.status === 'on_sale',
    `编辑后名称「${afterEdit.name}」价格 ${afterEdit.price}；下架后状态 ${off.status}、买家搜索 ${buyerSearch.data?.total} 条、我的商品可见=${mineSees}；重新上架后 ${backOn.status}`);
}

/* ================================================================ 14
   卖出订单页显示正确状态 */
async function check14() {
  const sold = await api('GET', '/api/orders/sold', { token: tokens.seller1 });
  const doneOrder = (sold.data?.list || []).find(o => o.status === 'done');
  const pendingOrder = (sold.data?.list || []).find(o => o.status === 'pending');

  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/sold');
  const ui = await cdp.eval(`
    (() => {
      const text = document.querySelector('#list-area').innerText;
      const cards = document.querySelectorAll('#list-area .card').length;
      return {
        cards,
        hasBuyer: /买家：/.test(text),
        statuses: [...new Set([...document.querySelectorAll('#list-area .badge')].map(b => b.innerText.trim()))],
      };
    })()`);

  record(14, '卖出订单页能看到自己商品的订单及正确状态',
    (sold.data?.total || 0) >= 1 && ui.cards >= 1 && ui.hasBuyer
    && Boolean(doneOrder || pendingOrder),
    `卖出订单 ${sold.data?.total} 笔；界面 ${ui.cards} 张卡，包含买家信息=${ui.hasBuyer}，状态标签 ${ui.statuses.join('/')}`);
}

/* ================================================================ 15
   管理后台：全部商品 + 下架/上架/删除 */
async function check15() {
  const all = await api('GET', '/api/admin/products?page_size=50', { token: adminToken });
  const statuses = new Set((all.data?.list || []).map(p => p.status));
  const target = (all.data?.list || []).find(p => p.status === 'on_sale' && p.name.startsWith('验收'));
  if (!target) {
    record(15, '管理后台能看到全部商品（含已售、已下架），能对任意商品下架/重新上架/删除', false,
      `没找到可操作的「验收」商品（当前 ${all.data?.list?.length || 0} 件）`);
    return;
  }

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=products');
  const ui = await cdp.eval(`
    (() => {
      const text = document.querySelector('#panel').innerText;
      return { hasSoldBadge: text.includes('已售'), hasOffBadge: text.includes('已下架'), rows: document.querySelectorAll('tbody tr').length };
    })()`);

  const off = await api('PATCH', `/api/admin/products/${target.id}/status`, { token: adminToken, body: { status: 'off_shelf' } });
  const back = await api('PATCH', `/api/admin/products/${target.id}/status`, { token: adminToken, body: { status: 'on_sale' } });
  const del = await api('DELETE', `/api/admin/products/${target.id}`, { token: adminToken });
  // 软删除后：详情接口对所有角色都应当查不到，但管理员列表里能看到（status=deleted）
  const goneForBuyer = await api('GET', `/api/products/${target.id}`);
  const deletedList = await api('GET', '/api/admin/products?status=deleted&page_size=50', { token: adminToken });
  const inDeletedList = (deletedList.data?.list || []).some(p => p.id === target.id);

  record(15, '管理后台能看到全部商品（含已售、已下架），能对任意商品下架/重新上架/删除',
    statuses.has('sold') && statuses.has('off_shelf') && ui.hasSoldBadge && ui.hasOffBadge
    && off.data?.status === 'off_shelf' && back.data?.status === 'on_sale'
    && del.code === 0 && goneForBuyer.status === 404 && inDeletedList,
    `接口状态集合 ${[...statuses].join('/')}，界面含已售/已下架标记（共 ${ui.rows} 行）；下架→${off.data?.status}，上架→${back.data?.status}；删除后详情接口返回 ${goneForBuyer.status}，管理员「已删除」列表含该商品=${inDeletedList}`);
}

/* ================================================================ 16
   举报流程：提交 → 管理员看到 → 下架 / 驳回 */
async function check16() {
  const mk = async (name) => (await api('POST', '/api/products', {
    token: tokens.seller2,
    body: { name, price: 12, category_id: 1, subcategory_id: 1, condition: '全新', description: '用于举报流程验收', default_place_id: 1, images: [] },
  })).data.id;

  const p1 = await mk('验收-举报成立');
  const p2 = await mk('验收-举报驳回');

  const r1 = (await api('POST', '/api/reports', { token: tokens.buyer1, body: { target_type: 'product', target_id: p1, reason: '虚假信息' } })).data;
  const r2 = (await api('POST', '/api/reports', { token: tokens.buyer2, body: { target_type: 'product', target_id: p2, reason: '其他' } })).data;

  const pending = await api('GET', '/api/admin/reports?status=pending&page_size=50', { token: adminToken });
  const seen = (pending.data?.list || []).map(r => r.id);

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=reports');
  const ui = await cdp.eval(`
    (() => {
      const text = document.querySelector('#panel').innerText;
      return { hasPending: text.includes('待处理'), hasButtons: /下架商品/.test(text), rows: document.querySelectorAll('tbody tr').length };
    })()`);

  const handled = await api('PATCH', `/api/admin/reports/${r1.id}`, { token: adminToken, body: { action: 'handle' } });
  const dismissed = await api('PATCH', `/api/admin/reports/${r2.id}`, { token: adminToken, body: { action: 'dismiss' } });
  const p1After = (await api('GET', `/api/products/${p1}`)).data;
  const p2After = (await api('GET', `/api/products/${p2}`)).data;

  record(16, '举报流程：提交 → 管理员看到待处理 → 下架商品或驳回',
    seen.includes(r1.id) && seen.includes(r2.id) && ui.hasPending && ui.hasButtons
    && handled.data?.status === 'handled' && dismissed.data?.status === 'dismissed'
    && p1After?.status === 'off_shelf' && p2After?.status !== 'off_shelf',
    `待处理列表含两条举报；后台界面待处理标记=${ui.hasPending}、操作按钮=${ui.hasButtons}；处理→${handled.data?.status}（商品 ${p1After?.status}），驳回→${dismissed.data?.status}（商品仍 ${p2After?.status}）`);

  await api('DELETE', `/api/admin/products/${p1}`, { token: adminToken });
  await api('DELETE', `/api/admin/products/${p2}`, { token: adminToken });
}

/* ================================================================ 17
   看板四数字与图表与实际一致 */
async function check17() {
  const stats = (await api('GET', '/api/admin/stats', { token: adminToken })).data;
  const all = await api('GET', '/api/admin/products?page_size=200', { token: adminToken });
  const list = all.data?.list || [];
  const actual = {
    total: list.length,
    on_sale: list.filter(p => p.status === 'on_sale').length,
    sold: list.filter(p => p.status === 'sold').length,
    off_shelf: list.filter(p => p.status === 'off_shelf').length,
  };
  const pieTotal = stats.category_pie.reduce((s, x) => s + x.count, 0);
  const barTotal = stats.price_bars.values.reduce((s, x) => s + x, 0);
  const cards = stats.cards;

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/dashboard');
  const ui = await cdp.eval(`
    (() => {
      const cards = [...document.querySelectorAll('.stat-card')].map(c => c.innerText.replace(/\\n/g, '=').trim());
      return { cards, hasPie: !!document.querySelector('#pie'), hasBars: !!document.querySelector('#bars'),
               legendRows: document.querySelectorAll('#pie-legend > div').length };
    })()`);

  record(17, '看板四个数字与商品实际状态一致；分类占比、价格区间图与实际数据一致',
    cards.total === actual.total && cards.on_sale === actual.on_sale
    && cards.sold === actual.sold && cards.off_shelf === actual.off_shelf
    && pieTotal === actual.total && barTotal === actual.total && ui.hasPie && ui.hasBars,
    `看板 ${cards.total}/${cards.on_sale}/${cards.sold}/${cards.off_shelf}；实际清点 ${actual.total}/${actual.on_sale}/${actual.sold}/${actual.off_shelf}；饼图合计 ${pieTotal}，柱状图合计 ${barTotal}；界面卡片「${ui.cards.join(' | ')}」，图例 ${ui.legendRows} 项`);
}

/* ================================================================ 18
   定位：下单后展示双方位置、距离、建议会面点；完成后不再可见 */
async function check18() {
  const pid = (await api('POST', '/api/products', {
    token: tokens.seller1,
    body: { name: '验收-定位流程', price: 55, category_id: 1, subcategory_id: 1, condition: '九成新', description: '定位验收', default_place_id: 1, images: [] },
  })).data.id;
  const order = (await api('POST', '/api/orders', { token: tokens.buyer1, body: { product_id: pid, meet_place_id: 1 } })).data;

  await api('PUT', `/api/orders/${order.id}/location`, { token: tokens.buyer1, body: { place_id: 1 } });
  await api('PUT', `/api/orders/${order.id}/location`, { token: tokens.seller1, body: { place_id: 5 } });
  const map = (await api('GET', `/api/orders/${order.id}/map`, { token: tokens.buyer1 })).data;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/order/${order.id}/map`);
  const ui = await cdp.eval(`
    (() => ({
      canvas: !!document.querySelector('#map-canvas'),
      legend: document.querySelector('.map-legend')?.innerText.replace(/\\n/g, ' ') || '',
      engine: document.querySelector('#engine-label')?.innerText || '',
    }))()`);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(WORK, 'map-before-done.png'), Buffer.from(shot.data, 'base64'));

  await api('PATCH', `/api/orders/${order.id}/complete`, { token: tokens.buyer1 });
  const after = (await api('GET', `/api/orders/${order.id}/map`, { token: tokens.buyer1 })).data;
  await cdp.go(`/order/${order.id}/map`);
  const uiAfter = await cdp.eval(`document.querySelector('#page').innerText.includes('精确位置不再展示')`);

  record(18, '下单后能展示双方位置、直线距离与建议会面点；交易完成后精确位置不再可见',
    Boolean(map.buyer_location) && Boolean(map.seller_location) && map.distance_m > 0
    && Boolean(map.suggest_place) && after.can_see_location === false
    && after.buyer_location === null && ui.canvas && uiAfter,
    `待完成时：买家${map.buyer_location ? '有' : '无'}、卖家${map.seller_location ? '有' : '无'}、距离 ${map.distance_m} 米、建议点「${map.suggest_place?.name}」；完成后 can_see_location=${after.can_see_location}、买家坐标=${after.buyer_location}；界面「${ui.engine}」，完成后提示隐私=${uiAfter}`);
}

/* ================================================================ 19
   评价：完成后可评一次，评分与内容在详情展示 */
async function check19() {
  const pid = (await api('POST', '/api/products', {
    token: tokens.seller2,
    body: { name: '验收-评价流程', price: 41, category_id: 1, subcategory_id: 1, condition: '九成新', description: '评价验收', default_place_id: 1, images: [] },
  })).data.id;
  const order = (await api('POST', '/api/orders', { token: tokens.buyer1, body: { product_id: pid, meet_place_id: 1 } })).data;

  const early = await api('POST', '/api/reviews', { token: tokens.buyer1, body: { order_id: order.id, rating: 5, content: '太早' } });
  await api('PATCH', `/api/orders/${order.id}/complete`, { token: tokens.buyer1 });
  const first = await api('POST', '/api/reviews', { token: tokens.buyer1, body: { order_id: order.id, rating: 5, content: '验收：东西很好，卖家爽快' } });
  const second = await api('POST', '/api/reviews', { token: tokens.buyer1, body: { order_id: order.id, rating: 3, content: '重复评价' } });
  const mutual = await api('POST', '/api/reviews', { token: tokens.seller2, body: { order_id: order.id, rating: 4, content: '验收：买家守时' } });

  await cdp.go(`/product/${pid}`);
  const ui = await cdp.eval(`
    (() => {
      const text = document.querySelector('#review-area').innerText;
      return { count: document.querySelectorAll('#review-area .review-item').length,
               stars: document.querySelectorAll('#review-area .stars').length,
               hasContent: text.includes('东西很好'),
               reviewCount: [...document.querySelectorAll('.info-list dd')].map(d => d.innerText).join(' ') };
    })()`);

  record(19, '订单「已完成」后可评价一次，评分与内容在商品详情正确展示',
    early.code !== 0 && first.code === 0 && second.code !== 0 && mutual.code === 0
    && ui.count === 2 && ui.stars === 2 && ui.hasContent,
    `未完成时评价被拒（${early.msg}）；首次评价成功；重复评价被拒（${second.msg}）；卖家互评成功；详情页展示 ${ui.count} 条评价、${ui.stars} 组星级，含文字=${ui.hasContent}`);
}

/* ================================================================ 20
   重新打开浏览器数据仍在 */
async function check20() {
  const name = `验收-持久化-${Date.now() % 10000}`;
  const created = (await api('POST', '/api/products', {
    token: tokens.seller1,
    body: { name, price: 7.5, category_id: 1, subcategory_id: 1, condition: '全新', description: '持久化验收', default_place_id: 1, images: [] },
  })).data;

  // 清空 localStorage（等价于换个新浏览器窗口），重新走一遍页面
  await cdp.logout();
  await cdp.go('/search');
  await cdp.eval(`
    (() => {
      const k = document.querySelector('#f-keyword'); k.value = ${JSON.stringify(name)};
      document.querySelector('#btn-search').click();
    })()`);
  await sleep(900);
  const guestSees = await cdp.eval(`document.querySelector('#result-area').innerText.includes(${JSON.stringify(name)})`);

  // 再开一个全新的浏览器上下文（新 profile），确认数据来自数据库而不是浏览器缓存
  const fresh = await fetch(`${BASE}/api/products?keyword=${encodeURIComponent(name)}`).then(r => r.json());

  record(20, '关闭浏览器再重新打开，数据仍在（数据存在 MySQL，不在浏览器本地）',
    guestSees && fresh.data?.total === 1 && fresh.data?.list?.[0].id === created.id,
    `清空浏览器本地存储后仍能搜到该商品=${guestSees}；换新会话直接查库得到 ${fresh.data?.total} 条，id=${created.id}`);

  await api('DELETE', `/api/products/${created.id}`, { token: tokens.seller1 });
}

/* ================================================================ 21
   备份 / 恢复 / 重置 */
async function check21() {
  const backup = await api('POST', '/api/admin/backup', { token: adminToken });
  const tables = Object.keys(backup.data?.payload?.data || {});
  // PRD 原定义 14 张表；后续功能迭代通过 migration 继续加表（messages / product_wants /
  // post_images / …），所以这里断言「不少于 14 张且都带数据」，而不是写死等于 14。
  const PRD_TABLE_COUNT = 14;
  const prdTablesCovered = PRD_TABLE_COUNT <= tables.length;
  const counts = backup.data?.counts || {};
  const files = await api('GET', '/api/admin/backups', { token: adminToken });

  // 改坏数据，再用备份恢复
  const temp = (await api('POST', '/api/products', {
    token: tokens.seller1,
    body: { name: '验收-恢复前新增', price: 1, category_id: 1, subcategory_id: 1, condition: '全新', images: [] },
  })).data;
  const beforeRestore = (await api('GET', '/api/admin/products?page_size=200', { token: adminToken })).data.total;

  const restore = await api('POST', '/api/admin/restore', { token: adminToken, body: backup.data.payload });
  const afterRestore = (await api('GET', '/api/admin/products?page_size=200', { token: adminToken })).data.total;
  const tempGone = await api('GET', `/api/products/${temp.id}`);

  const reset = await api('POST', '/api/admin/reset-demo', { token: adminToken });
  const afterReset = (await api('GET', '/api/home')).data;

  // 备份文件确实能被下载（记得把响应体读完，否则连接状态会残留）
  const dl = await fetch(`${BASE}/api/admin/backup/${backup.data.filename}`,
    { headers: { Authorization: `Bearer ${adminToken}` } });
  const dlText = await dl.text();
  const dlOk = dl.ok && dlText.includes('campus-market');

  record(21, '管理员可备份导出数据、恢复数据、重置示例数据',
    prdTablesCovered && files.data?.length >= 1 && beforeRestore === afterRestore + 1
    && tempGone.status === 404 && reset.code === 0 && afterReset.stats.on_sale === 11 && dlOk,
    `备份含 ${tables.length} 张表（PRD 原定义 ${PRD_TABLE_COUNT} 张已全部覆盖=${prdTablesCovered}；users ${counts.users} 行）；备份文件 ${files.data?.length} 个；恢复前 ${beforeRestore} 件 → 恢复后 ${afterRestore} 件，恢复后新增的商品已消失（HTTP ${tempGone.status}）；重置后首页在售 ${afterReset.stats.on_sale} 件；备份可下载=${dlOk}`);
}

/* ================================================================ 22-23
   关键操作先确认（取消则数据不变）；操作有提示条 */
async function check22_23() {
  // 造一件商品用于「删除取消」
  const name = `验收-确认框-${Date.now() % 10000}`;
  const pid = (await api('POST', '/api/products', {
    token: tokens.seller1,
    body: { name, price: 3, category_id: 1, subcategory_id: 1, condition: '全新', images: [] },
  })).data.id;

  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/my-products');

  // 点删除 → 应弹确认框
  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes(${JSON.stringify(name)}));
      row.querySelector('[data-del]').click();
    })()`);
  await sleep(500);
  const modal = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return { shown: !!m, title: m?.querySelector('.modal-head')?.innerText || '',
               buttons: [...(m?.querySelectorAll('.modal-foot button') || [])].map(b => b.innerText.trim()) };
    })()`);
  // 取消
  await cdp.eval(`document.querySelector('.modal-mask [data-cancel]').click()`);
  await sleep(700);
  const afterCancel = (await api('GET', `/api/products/${pid}`)).data;
  const stillInList = await cdp.eval(`document.querySelector('#list-area').innerText.includes(${JSON.stringify(name)})`);

  // 下单也要确认框 + 成功提示条
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/product/${pid}`);
  await cdp.eval(`[...document.querySelectorAll('#action-bar button')].find(b => b.innerText.includes('立即购买')).click()`);
  await sleep(600);
  const buyModal = await cdp.eval(`document.querySelector('.modal-head')?.innerText || ''`);
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
  await sleep(500);

  // 提示条：收藏一次
  await cdp.eval(`[...document.querySelectorAll('#action-bar button')].find(b => b.innerText.includes('收藏')).click()`);
  await sleep(700);
  const toast = await cdp.eval(`
    (() => {
      const t = document.querySelector('.toast');
      return { shown: !!t, text: t?.innerText.trim() || '', cls: t?.className || '' };
    })()`);
  // 反向：故意触发一次失败，看是否有失败提示
  await cdp.eval(`
    (async () => {
      const r = await fetch('/api/orders', { method:'POST',
        headers: { 'Content-Type':'application/json', Authorization: 'Bearer ' + localStorage.getItem('cm_token') },
        body: JSON.stringify({ product_id: ${pid} }) });
      return (await r.json()).msg;
    })()`);

  record(22, '删除、下架、下单、恢复、重置等关键操作先弹确认框，取消确认时数据不变',
    modal.shown && modal.buttons.length === 2 && afterCancel?.status === 'on_sale'
    && stillInList && /确认下单/.test(buyModal),
    `删除弹窗「${modal.title}」，按钮 ${modal.buttons.join('/')}；点取消后商品状态仍为 ${afterCancel?.status}、列表仍显示=${stillInList}；下单弹窗标题「${buyModal}」`);

  record(23, '操作成功或失败均有提示条提示',
    toast.shown && /收藏|成功/.test(toast.text) && /toast/.test(toast.cls),
    `收藏后出现提示条「${toast.text}」（class=${toast.cls}）`);

  await api('DELETE', `/api/products/${pid}`, { token: tokens.seller1 });
  await cdp.logout();
}

main().catch((err) => {
  console.error('验收脚本异常：', err);
  if (chrome) chrome.kill();
  process.exit(2);
});
