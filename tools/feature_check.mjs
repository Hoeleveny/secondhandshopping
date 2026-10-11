/* ==========================================================================
   新功能验收测试（无头浏览器 + 接口）
   每实现一项功能就加一个分组，可单独运行：

     node tools/feature_check.mjs 1        # 只测功能①
     node tools/feature_check.mjs all      # 测全部已实现的功能

   分组编号与用户需求编号一致：
     1 私信消息   2 价格区间自定义   3 我想要   4 删除记录
     5 帖子点击范围   6 帖子配图   7 用户资料页
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BASE, api, login, launchBrowser, createRecorder, sleep,
} from './cdp_client.mjs';

const WORK = path.resolve('_build_tmp');
const SHOT_DIR = path.join(WORK, 'feature-shots');

const { check, summary, results } = createRecorder();

/* ================================================================ 功能① 私信消息 */
async function feature1(cdp) {
  console.log('\n===== 功能① 私信消息 =====');

  const buyerToken = await login('buyer1', '123456', 'buyer');
  const sellerToken = await login('seller1', '123456', 'seller');
  const meId = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user.id;
  const sellerId = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user.id;
  const productId = 1;

  // 清掉历史未读，保证断言可重复
  await api('GET', `/api/messages/with/${sellerId}`, { token: buyerToken });
  await api('GET', `/api/messages/with/${meId}`, { token: sellerToken });

  // ---- 从商品详情页发起私信 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/product/${productId}`);

  const hasMsgBtn = await cdp.eval(`
    [...document.querySelectorAll('#action-bar button')].some(b => b.innerText.includes('私信卖家'))`);
  check('商品详情页有「私信卖家」按钮', hasMsgBtn === true, `结果=${hasMsgBtn}`);

  await cdp.eval(`
    [...document.querySelectorAll('#action-bar button')]
      .find(b => b.innerText.includes('私信卖家')).click()`);
  await sleep(1200);

  const hash = await cdp.eval('location.hash');
  const pageText = await cdp.eval(`document.querySelector('#page').innerText`);
  check('点击后进入消息页并带上收信人与商品',
    /^#\/messages\?to=\d+/.test(hash) && /我的消息/.test(pageText),
    `hash=${hash}`);

  const bubbleBefore = await cdp.eval(`document.querySelectorAll('.bubble').length`);

  // 发一条消息
  await cdp.eval(`
    (() => {
      const box = document.querySelector('#msg-input');
      box.value = '自动化测试：你好，这件还在吗？';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#msg-send').click();
    })()`);
  await sleep(1400);

  const afterSend = await cdp.eval(`
    (() => ({
      bubbles: document.querySelectorAll('.bubble').length,
      mine: document.querySelectorAll('.bubble.mine').length,
      last: document.querySelector('.bubble:last-of-type')?.innerText || '',
    }))()`);
  check('发送后自己的消息以气泡显示在右侧',
    afterSend.mine >= 1 && afterSend.bubbles > bubbleBefore && afterSend.last.includes('还在吗'),
    `气泡数 ${bubbleBefore} → ${afterSend.bubbles}，我方气泡 ${afterSend.mine}`);

  await cdp.shot(path.join(SHOT_DIR, 'f1-buyer-chat.png'));

  // ---- 收信人侧：未读红点 + 会话列表 ----
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/home');
  const badge = await cdp.eval(`
    (() => {
      const b = document.querySelector('#msg-badge');
      return { exists: !!b, text: b?.textContent || '', visible: b ? getComputedStyle(b).display !== 'none' : false };
    })()`);
  check('收信人顶栏未读红点出现',
    badge.exists && badge.visible && Number(badge.text) >= 1,
    `红点=${JSON.stringify(badge)}`);

  await cdp.eval(`document.querySelector('#msg-entry').click()`);
  await sleep(1500);
  const convView = await cdp.eval(`
    (() => ({
      hash: location.hash,
      convs: [...document.querySelectorAll('.msg-conv')].map(c => c.innerText.replace(/\\n/g, ' ')),
      bubbles: [...document.querySelectorAll('.bubble')].map(b => b.innerText.replace(/\\n/g, ' ')),
    }))()`);
  check('会话列表出现对方并能看到对方发来的消息',
    convView.convs.some(c => c.includes('李小明'))
    && convView.bubbles.some(b => b.includes('还在吗')),
    `会话=${JSON.stringify(convView.convs).slice(0, 150)}`);

  await cdp.shot(path.join(SHOT_DIR, 'f1-seller-chat.png'));

  const unreadAfter = await api('GET', '/api/messages/unread', { token: sellerToken });
  check('打开会话后未读数归零',
    unreadAfter.data.count === 0, `未读=${unreadAfter.data.count}`);

  // ---- 回一条，双方都能看到 ----
  await cdp.eval(`
    (() => {
      const box = document.querySelector('#msg-input');
      box.value = '自动化测试：还在的，随时可看';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#msg-send').click();
    })()`);
  await sleep(1400);

  // 注意顺序：/with/<uid> 会把对方的来信标记为已读，
  // 所以必须先查未读数，再拉聊天记录，否则未读永远读到 0。
  const buyerUnread = await api('GET', '/api/messages/unread', { token: buyerToken });
  check('回复后买家侧产生未读',
    buyerUnread.data.count >= 1, `未读=${buyerUnread.data.count}`);

  const thread = await api('GET', `/api/messages/with/${sellerId}`, { token: buyerToken });
  const contents = (thread.data.list || []).map(m => m.content);
  check('双方消息在同一会话里互通',
    contents.some(c => c.includes('还在吗')) && contents.some(c => c.includes('随时可看')),
    `共 ${contents.length} 条`);

  // ---- 清理本次测试产生的消息，保持演示数据干净 ----
  cleanupMessages([meId, sellerId]);
}

/** 删掉本脚本产生的测试消息（直接连库；失败也不影响结论） */
function cleanupMessages(userIds) {
  try {
    const ids = userIds.join(',');
    const sql = "DELETE FROM messages WHERE content LIKE '自动化测试：%' "
      + `AND sender_id IN (${ids}) AND receiver_id IN (${ids});`;
    spawnSync(process.env.MYSQL_BIN || 'D:\\mysql\\bin\\mysql.exe',
      ['-u', 'campus', '--password=Campus@2026', 'campus_market', '-e', sql],
      { stdio: 'ignore' });
  } catch { /* 清理失败不影响测试结论 */ }
}

/** 读出结果区里所有商品卡的价格（数字） */
async function shownPrices(cdp) {
  return cdp.eval(`
    [...document.querySelectorAll('#result-area .price')]
      .map(e => Number(String(e.innerText).replace(/[^0-9.]/g, '')))
      .filter(n => !Number.isNaN(n))`);
}

/* ================================================================ 功能② 价格区间自定义 */
async function feature2(cdp) {
  console.log('\n===== 功能② 价格区间可自行输入 =====');

  await cdp.logout();
  await cdp.go('/search');

  const total = await cdp.eval(`document.querySelector('#result-count').innerText`);
  check('默认展示全部在售商品', /共 \d+ 件/.test(total), total);

  // ---- 1. 快捷区间仍然可用，并会回填到输入框 ----
  await cdp.eval(`
    (() => {
      const s = document.querySelector('#f-price');
      s.value = '20-50';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  await sleep(1100);
  const preset = await cdp.eval(`
    (() => ({
      min: document.querySelector('#f-min-price').value,
      max: document.querySelector('#f-max-price').value,
      select: document.querySelector('#f-price').value,
      count: document.querySelector('#result-count').innerText,
    }))()`);
  const presetPrices = await shownPrices(cdp);
  check('选快捷区间会自动填进最低价 / 最高价输入框',
    preset.min === '20' && preset.max === '50' && preset.select === '20-50',
    JSON.stringify(preset));
  check('快捷区间的结果都落在 20~50',
    presetPrices.length > 0 && presetPrices.every(p => p >= 20 && p <= 50),
    `价格=${JSON.stringify(presetPrices)}`);

  // ---- 2. 手填自定义区间 ----
  await cdp.eval(`
    (() => {
      const mn = document.querySelector('#f-min-price');
      const mx = document.querySelector('#f-max-price');
      const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
      mn.value = '80'; fire(mn, 'input');
      mx.value = '130'; fire(mx, 'input');
      fire(mx, 'change');
    })()`);
  await sleep(1100);
  const customPrices = await shownPrices(cdp);
  const customState = await cdp.eval(`
    (() => ({
      select: document.querySelector('#f-price').value,
      count: document.querySelector('#result-count').innerText,
      hash: location.hash,
    }))()`);
  check('手填 80~130 后结果全部落在区间内',
    customPrices.length > 0 && customPrices.every(p => p >= 80 && p <= 130),
    `价格=${JSON.stringify(customPrices)}，${customState.count}`);
  check('手填后快捷下拉自动变成「自定义」',
    customState.select === 'custom', `select=${customState.select}`);
  check('筛选条件同步到地址栏（可刷新/分享）',
    /min_price=80/.test(customState.hash) && /max_price=130/.test(customState.hash),
    customState.hash);

  await cdp.shot(path.join(SHOT_DIR, 'f2-price-custom.png'));

  // ---- 3. 只填一边 ----
  await cdp.eval(`
    (() => {
      const mn = document.querySelector('#f-min-price');
      const mx = document.querySelector('#f-max-price');
      const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
      mn.value = ''; fire(mn, 'input');
      mx.value = '20'; fire(mx, 'input');
      fire(mx, 'change');
    })()`);
  await sleep(1100);
  const onlyMax = await shownPrices(cdp);
  check('只填最高价 20：不报错且结果都 ≤ 20',
    onlyMax.length > 0 && onlyMax.every(p => p <= 20), `价格=${JSON.stringify(onlyMax)}`);

  // ---- 4. 填错（最低价 > 最高价）应标红且不查询 ----
  const countBefore = await cdp.eval(`document.querySelector('#result-count').innerText`);
  await cdp.eval(`
    (() => {
      const mn = document.querySelector('#f-min-price');
      const mx = document.querySelector('#f-max-price');
      const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
      mn.value = '200'; fire(mn, 'input');
      mx.value = '100'; fire(mx, 'input');
      fire(mx, 'change');
    })()`);
  await sleep(900);
  const invalid = await cdp.eval(`
    (() => ({
      invalidCount: document.querySelectorAll('#f-min-price.invalid, #f-max-price.invalid').length,
      errorText: [...document.querySelectorAll('.form-error')].map(e => e.innerText).join(' / '),
      count: document.querySelector('#result-count').innerText,
      toast: document.querySelector('.toast')?.innerText || '',
    }))()`);
  check('最低价 > 最高价时输入框标红并给出提示',
    invalid.invalidCount === 2 && invalid.errorText.includes('最低价'),
    `标红=${invalid.invalidCount}，提示=「${invalid.errorText}」`);
  check('校验不通过时不发起查询（结果保持不变）',
    invalid.count === countBefore, `之前「${countBefore}」→ 现在「${invalid.count}」`);

  // ---- 5. 清除条件 ----
  await cdp.eval(`document.querySelector('#btn-reset').click()`);
  await sleep(1100);
  const afterReset = await cdp.eval(`
    (() => ({
      min: document.querySelector('#f-min-price').value,
      max: document.querySelector('#f-max-price').value,
      select: document.querySelector('#f-price').value,
      count: document.querySelector('#result-count').innerText,
      invalidCount: document.querySelectorAll('.invalid').length,
    }))()`);
  check('「清除条件」会把自定义价格一起清掉并恢复全部商品',
    afterReset.min === '' && afterReset.max === '' && afterReset.select === ''
    && afterReset.invalidCount === 0 && afterReset.count === total,
    JSON.stringify(afterReset));
}

/* ================================================================ 功能③ 我想要 */
async function feature3(cdp) {
  console.log('\n===== 功能③ 我想要 =====');

  const buyerToken = await login('buyer1', '123456', 'buyer');
  const pid = 1;   // 种子里的一件在售商品，卖家是 seller1

  // 先归一化：如果买家之前已经想要过，先取消，保证断言可重复
  const initial = (await api('GET', `/api/products/${pid}`, { token: buyerToken })).data;
  if (initial.wanted) await api('POST', `/api/products/${pid}/want`, { token: buyerToken });
  const base = (await api('GET', `/api/products/${pid}`, { token: buyerToken })).data.want_count;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/product/${pid}`);

  const dom0 = await cdp.eval(`
    (() => {
      const btn = document.querySelector('[data-act="want"]');
      return {
        hasBtn: !!btn,
        text: btn ? btn.innerText.replace(/\\s+/g, ' ').trim() : '',
        line: (document.querySelector('#want-count-line')?.innerText || '').trim(),
        count: document.querySelector('#want-count')?.textContent || '',
      };
    })()`);
  check('详情页有「我想要」按钮且显示想要人数',
    dom0.hasBtn && dom0.text.includes('我想要') && /人想要/.test(dom0.line),
    `按钮「${dom0.text}」，人数行「${dom0.line}」`);

  // ---- 点一次 ----
  await cdp.eval(`document.querySelector('[data-act="want"]').click()`);
  await sleep(900);
  const dom1 = await cdp.eval(`
    (() => {
      const btn = document.querySelector('[data-act="want"]');
      return {
        text: btn.innerText.replace(/\\s+/g, ' ').trim(),
        primary: btn.classList.contains('btn-primary'),
        count: document.querySelector('#want-count').textContent,
        toast: document.querySelector('.toast')?.innerText || '',
      };
    })()`);
  const api1 = (await api('GET', `/api/products/${pid}`, { token: buyerToken })).data;
  check('点一次后按钮变为「已想要」且人数 +1',
    dom1.text.includes('已想要') && dom1.primary
    && Number(dom1.count) === base + 1 && api1.want_count === base + 1,
    `按钮「${dom1.text}」，人数 ${base} → ${api1.want_count}，接口 wanted=${api1.wanted}`);

  await cdp.shot(path.join(SHOT_DIR, 'f3-want-on.png'));

  // ---- 再点一次取消 ----
  await cdp.eval(`document.querySelector('[data-act="want"]').click()`);
  await sleep(900);
  const dom2 = await cdp.eval(`
    (() => {
      const btn = document.querySelector('[data-act="want"]');
      return {
        text: btn.innerText.replace(/\\s+/g, ' ').trim(),
        primary: btn.classList.contains('btn-primary'),
        count: document.querySelector('#want-count').textContent,
      };
    })()`);
  const api2 = (await api('GET', `/api/products/${pid}`, { token: buyerToken })).data;
  check('再点一次取消，按钮与人数都恢复',
    dom2.text.includes('我想要') && !dom2.text.includes('已想要') && !dom2.primary
    && Number(dom2.count) === base && api2.wanted === false && api2.want_count === base,
    `按钮「${dom2.text}」，人数回到 ${api2.want_count}，接口 wanted=${api2.wanted}`);

  // ---- 卖家看自己的商品：能看到人数，但没有按钮 ----
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go(`/product/${pid}`);
  const ownerView = await cdp.eval(`
    (() => ({
      hasWantBtn: !!document.querySelector('[data-act="want"]'),
      line: (document.querySelector('#want-count-line')?.innerText || '').trim(),
    }))()`);
  check('卖家看自己的商品：有想要人数、但没有「我想要」按钮',
    !ownerView.hasWantBtn && /人想要/.test(ownerView.line), JSON.stringify(ownerView));

  // ---- 游客：按钮引导登录 ----
  await cdp.logout();
  await cdp.go(`/product/${pid}`);
  const guestView = await cdp.eval(`
    (() => ({
      hasWantBtn: !!document.querySelector('[data-act="want"]'),
      loginBtn: [...document.querySelectorAll('#action-bar button')]
        .some(b => b.dataset.act === 'login' && b.innerText.includes('我想要')),
    }))()`);
  check('游客看到「我想要」按钮，点击会引导登录',
    !guestView.hasWantBtn && guestView.loginBtn === true, JSON.stringify(guestView));

  // ---- 商品卡上也展示想要人数 ----
  await cdp.go('/search');
  const cardFoot = await cdp.eval(`
    document.querySelector('#result-area .pc-foot')?.innerText.replace(/\\s+/g, ' ').trim() || ''`);
  check('商品卡上展示「浏览 · 想要」人数', /❤️/.test(cardFoot), cardFoot);
}

/* ================================================================ 主流程 */
const GROUPS = {
  1: { title: '私信消息', fn: feature1 },
  2: { title: '价格区间可自行输入', fn: feature2 },
  3: { title: '我想要', fn: feature3 },
};

async function main() {
  const which = process.argv[2] || 'all';
  const selected = Object.entries(GROUPS)
    .filter(([id]) => which === 'all' || which === id);

  if (!selected.length) {
    console.log(`没有匹配的功能分组：${which}`);
    console.log(`可用：${Object.keys(GROUPS).join(', ')} 或 all`);
    process.exit(2);
  }

  // 先确认服务在跑
  try {
    await api('GET', '/api/health');
  } catch {
    console.error(`服务没起来：${BASE}  （先运行 start.bat 或 manage.py run）`);
    process.exit(2);
  }

  const { cdp, close } = await launchBrowser({ port: 9341 });
  try {
    for (const [id, group] of selected) {
      console.log(`\n########## 功能${id}：${group.title} ##########`);
      await group.fn(cdp);
    }
  } finally {
    close();
  }

  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, 'feature-report.json'),
    JSON.stringify({ ran_at: new Date().toISOString(), feature: which, results }, null, 2));

  process.exit(summary());
}

main().catch((err) => {
  console.error('测试脚本异常：', err);
  process.exit(2);
});
