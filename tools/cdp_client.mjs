/* ==========================================================================
   无头浏览器测试的公共部分（Node 内置 WebSocket 直连 CDP，无需 puppeteer）
   被 feature_check.mjs / acceptance_check.mjs 这类脚本复用。
   ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const BASE = process.env.APP_BASE || 'http://127.0.0.1:5000';
export const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ 接口 */
export async function api(method, url, { token, body, view } = {}) {
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

export async function login(username, password, role) {
  const res = await api('POST', '/api/auth/login', { body: { username, password, role } });
  if (res.code !== 0) throw new Error(`登录失败 ${username}: ${res.msg}`);
  return res.data.token;
}

/* ------------------------------------------------------------------ CDP */
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
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
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || '页面脚本异常');
    }
    return r.result.value;
  }

  /** 带时间戳跳转，保证 hash 真的变化、页面一定重新渲染 */
  async go(hash) {
    const sep = hash.includes('?') ? '&' : '?';
    await this.send('Page.navigate', { url: `${BASE}/#${hash}${sep}_=${Date.now()}` });
    return this.waitReady();
  }

  /** 等页面从「加载中」进入有内容的状态 */
  async waitReady(times = 30) {
    for (let i = 0; i < times; i += 1) {
      await sleep(200);
      try {
        const state = await this.eval(`
          (() => {
            const p = document.querySelector('#page');
            if (!p) return 'nopage';
            if (p.querySelector('.loading')) return '';
            return (p.innerText || '').trim().length > 4 ? 'ok' : '';
          })()`);
        if (state === 'ok' || state === 'nopage') return state;
      } catch { /* 页面切换中 */ }
    }
    return '';
  }

  async loginAs(username, password, role) {
    await this.send('Page.navigate', { url: `${BASE}/` });
    await sleep(600);
    const r = await this.eval(`
      (async () => {
        const res = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: ${JSON.stringify(username)},
                                 password: ${JSON.stringify(password)},
                                 role: ${JSON.stringify(role)} }),
        });
        const p = await res.json();
        if (p.code !== 0) return { ok: false, msg: p.msg };
        localStorage.setItem('cm_token', p.data.token);
        localStorage.setItem('cm_view', p.data.view);
        return { ok: true };
      })()`);
    if (!r?.ok) throw new Error(r?.msg);
    await this.send('Page.reload', { ignoreCache: true });
    await sleep(900);
  }

  async logout() {
    const origin = new URL(BASE).origin;
    const here = await this.eval('location.origin').catch(() => '');
    if (here !== origin) {
      await this.send('Page.navigate', { url: `${BASE}/` });
      await sleep(700);
    }
    await this.eval(`(() => { try { localStorage.clear(); } catch (e) {} return 1; })()`);
    await this.send('Page.reload', { ignoreCache: true });
    await sleep(800);
  }

  async shot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }
}

/* ------------------------------------------------------------------ 启动浏览器 */
export async function launchBrowser({ port = 9333, workDir = '_build_tmp' } = {}) {
  const profile = path.resolve(path.join(workDir, `chrome-${port}`));
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--window-size=1500,1000', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {}
    await sleep(300);
  }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,
    { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('调试端口连不上')));
  });

  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Network.enable');

  return {
    cdp,
    close() { try { ws.close(); } catch {} chrome.kill(); },
  };
}

/* ------------------------------------------------------------------ 断言 */
export function createRecorder() {
  const results = [];
  const passed = [];
  const failed = [];

  function check(label, ok, evidence = '') {
    results.push({ label, ok, evidence: String(evidence).replace(/\s+/g, ' ').slice(0, 160) });
    if (ok) { passed.push(label); console.log(`  [PASS] ${label}`); }
    else { failed.push(label); console.log(`  [FAIL] ${label}   ${String(evidence).slice(0, 200)}`); }
    return ok;
  }

  function summary() {
    console.log(`\n结果：通过 ${passed.length} / ${passed.length + failed.length}`);
    if (failed.length) {
      console.log('失败项：');
      failed.forEach(f => console.log('  -', f));
    }
    return failed.length ? 1 : 0;
  }

  return { check, summary, results, passed, failed };
}
