/* ==========================================================================
   前端端到端自检（无头 Chrome + CDP）
   用真实浏览器把每个页面都跑一遍，收集 JS 报错、接口失败与空白页，
   并给关键页面截图，避免"代码写完但从没在浏览器里打开过"。

   用法：
     node tools/e2e_check.mjs            # 只跑检查
     node tools/e2e_check.mjs --shots    # 顺便截图到 _build_tmp/shots
   ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.APP_BASE || 'http://127.0.0.1:5000';
const PORT = Number(process.env.CDP_PORT || 9222);
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.resolve('_build_tmp/chrome-e2e');
const SHOT_DIR = path.resolve('_build_tmp/shots');
const WANT_SHOTS = process.argv.includes('--shots');

const USERS = {
  guest: null,
  buyer: { username: 'buyer1', password: '123456', role: 'buyer' },
  seller: { username: 'seller1', password: '123456', role: 'seller' },
  admin: { username: 'admin', password: '123456', role: 'admin' },
};

const PLAN = [
  { as: 'guest', routes: ['/home', '/search', '/compare', '/posts', '/post/1', '/product/1', '/seller/4', '/login'] },
  { as: 'buyer', routes: ['/home', '/orders', '/favorites', '/swaps', '/order/2/map'] },
  { as: 'seller', routes: ['/my-products', '/publish', '/sold'] },
  { as: 'admin', routes: ['/admin?tab=products', '/admin?tab=trades', '/admin?tab=reports', '/admin?tab=base', '/admin?tab=data', '/dashboard'] },
];

const SHOTS = ['/home', '/search', '/product/1', '/seller/4', '/dashboard', '/admin?tab=products', '/admin?tab=trades', '/login'];

const problems = [];
let checks = 0;

/* ------------------------------------------------------------------ CDP 客户端 */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        (this.handlers.get(message.method) || []).forEach(fn => fn(message.params));
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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面脚本异常');
    }
    return result.result.value;
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (err) { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时`);
}

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  if (WANT_SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--window-size=1500,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let exitCode = 0;
  try {
    await waitForHttp(`http://127.0.0.1:${PORT}/json/version`);
    const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('无法连接调试端口')));
    });

    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    const consoleErrors = [];
    const httpFailures = [];
    cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description
        || params.exceptionDetails?.text || '未知异常');
    });
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        consoleErrors.push(params.args.map(a => a.value ?? a.description ?? '').join(' '));
      }
    });
    cdp.on('Log.entryAdded', (params) => {
      if (params.entry.level === 'error') consoleErrors.push(params.entry.text);
    });
    cdp.on('Network.responseReceived', (params) => {
      if (params.response.status >= 400) {
        httpFailures.push(`${params.response.status} ${params.response.url}`);
      }
    });
    await cdp.send('Network.enable');

    let currentUser = 'guest';
    for (const step of PLAN) {
      if (step.as !== currentUser) {
        await login(cdp, USERS[step.as]);
        currentUser = step.as;
      }
      for (const route of step.routes) {
        await visit(cdp, route, step.as, consoleErrors, httpFailures);
      }
    }

    if (WANT_SHOTS) {
      await login(cdp, USERS.buyer);
      await visit(cdp, '/home', 'buyer', [], []);
      for (const route of SHOTS) {
        const as = ['/dashboard', '/admin?tab=products'].includes(route) ? USERS.admin
          : route === '/login' ? null : USERS.buyer;
        await login(cdp, as);
        await visit(cdp, route, route === '/login' ? 'guest' : 'user', [], []);
        await shot(cdp, route);
      }
    }

    await cdp.eval('1');
    ws.close();
  } catch (err) {
    problems.push(`运行失败：${err.message}`);
    exitCode = 1;
  } finally {
    chrome.kill();
  }

  console.log(`\n共检查 ${checks} 个页面，问题 ${problems.length} 条`);
  if (problems.length) {
    console.log('\n问题清单：');
    problems.forEach(p => console.log(`  ✗ ${p}`));
  } else {
    console.log('✅ 所有页面均正常渲染，无 JS 报错、无接口失败、无空白页');
  }
  process.exit(exitCode || (problems.length ? 1 : 0));
}

/* ------------------------------------------------------------------ 步骤 */
async function login(cdp, user) {
  if (!user) {
    await cdp.eval(`(() => { localStorage.clear(); return 1; })()`);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(900);
    return;
  }
  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await sleep(700);
  const result = await cdp.eval(`
    (async () => {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(${JSON.stringify(user)}),
      });
      const payload = await res.json();
      if (payload.code !== 0) return { ok: false, msg: payload.msg };
      localStorage.setItem('cm_token', payload.data.token);
      localStorage.setItem('cm_view', payload.data.view);
      return { ok: true, view: payload.data.view, nickname: payload.data.user.nickname };
    })()
  `);
  if (!result?.ok) throw new Error(`登录失败（${user.username}）：${result?.msg}`);
  // 关键：localStorage 改了但页面里的 store 还是旧的，必须整页重载让应用重新初始化
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(900);
}

async function visit(cdp, route, who, consoleErrors, httpFailures) {
  checks += 1;
  const errorBefore = consoleErrors.length;
  const failureBefore = httpFailures.length;

  await cdp.send('Page.navigate', { url: `${BASE}/#${route}` });
  // 首屏是 fetch 之后才渲染的，轮询等它稳定下来
  let text = '';
  for (let i = 0; i < 25; i += 1) {
    await sleep(220);
    try {
      text = await cdp.eval(`
        (() => {
          const page = document.querySelector('#page');
          if (!page) return '（没有 #page 容器）';
          if (page.querySelector('.loading')) return '';
          return (page.innerText || '').trim().slice(0, 300);
        })()
      `);
    } catch (err) { text = `（取值失败：${err.message}）`; }
    if (text) break;
  }

  const label = `[${who}] #${route}`;
  if (!text) {
    problems.push(`${label}：页面一直停在加载态`);
    return;
  }
  if (/页面加载失败|加载失败：|打不开|服务器内部错误/.test(text)) {
    problems.push(`${label}：${text.split('\n')[0]}`);
  }
  if (/Failed to fetch dynamically imported module|Cannot find module/.test(text)) {
    problems.push(`${label}：模块加载失败 ${text.split('\n')[0]}`);
  }
  const newErrors = consoleErrors.slice(errorBefore);
  if (newErrors.length) {
    problems.push(`${label}：控制台报错 ${newErrors[0].split('\n')[0].slice(0, 160)}`);
  }
  const newFailures = httpFailures.slice(failureBefore)
    .filter(u => !/\/api\/products\/\d+$/.test(u) || !u.includes('404'));
  if (newFailures.length) {
    problems.push(`${label}：接口失败 ${newFailures[0]}`);
  }
  console.log(`  · ${label} → ${text.split('\n')[0].slice(0, 60) || '(空)'}`);
}

async function shot(cdp, route) {
  const name = (route.replace(/[^a-z0-9]/gi, '_') || 'root').replace(/^_+/, '');
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(data, 'base64'));
}

main();
