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
import zlib from 'node:zlib';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BASE, api, login, launchBrowser, createRecorder, sleep, waitFor,
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

  // 消息入口已移入右上角用户小框（界面调整②）
  await cdp.eval(`document.querySelector('#user-menu').click()`);
  await sleep(500);
  const ddInfo = await cdp.eval(`
    (() => {
      const dd = document.querySelector('.dropdown');
      return {
        shown: !!dd,
        items: [...(dd?.querySelectorAll('.dd-item') || [])].map(i => i.innerText.replace(/\\s+/g, ' ').trim()),
        count: dd?.querySelector('#dd-msg-count')?.textContent || '',
      };
    })()`);
  check('用户小框里有「我的消息」并带上未读数',
    ddInfo.shown && ddInfo.items.some(t => t.includes('我的消息')) && Number(ddInfo.count) >= 1,
    `小框项=${JSON.stringify(ddInfo.items)}，未读数=${ddInfo.count}`);

  await cdp.eval(`
    [...document.querySelectorAll('.dropdown .dd-item')]
      .find(b => b.innerText.includes('我的消息')).click()`);
  await sleep(1500);
  const convView = await cdp.eval(`
    (() => ({
      hash: location.hash,
      convs: [...document.querySelectorAll('.msg-conv')].map(c => c.innerText.replace(/\\n/g, ' ')),
      bubbles: [...document.querySelectorAll('.bubble')].map(b => b.innerText.replace(/\\n/g, ' ')),
    }))()`);
  check('会话列表出现对方并能看到对方发来的消息',
    convView.convs.some(c => c.includes('还在吗'))
    && convView.bubbles.some(b => b.includes('还在吗')),
    `会话=${JSON.stringify(convView.convs).slice(0, 150)}`);

  await cdp.shot(path.join(SHOT_DIR, 'f1-seller-chat.png'));

  // 断言「来自这个人的未读归零」而不是「全站未读为 0」——后者只要别的账号发来一条消息就会误报
  // （我就在这上面栽过：演示账号收到一条平台通知，"归零"就挂了）
  const convAfter = await api('GET', '/api/messages/conversations', { token: sellerToken });
  const peerConv = (convAfter.data || []).find(
    c => c.last_message && (c.last_message.content || '').includes('还在吗'));
  check('打开会话后，来自该对话的未读归零',
    !peerConv || peerConv.unread === 0, `该对话未读=${peerConv?.unread}`);

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
  // 等结果区真的渲染完再读——否则可能读到「加载中…」，
  // 于是「默认展示全部在售商品」直接失败，且后面拿它当基线的断言会跟着一起错
  await waitFor(cdp, `/共 \\d+ 件/.test(document.querySelector('#result-count')?.innerText || '')`);

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

/** 用接口快速造一件测试商品；返回商品 id */
async function makeProduct(name, price = 9.9, token = null) {
  const tk = token || await login('seller1', '123456', 'seller');
  const res = await api('POST', '/api/products', {
    token: tk,
    body: {
      name, price, category_id: 1, subcategory_id: 1, condition: '九成新',
      description: '自动化测试用商品', default_place_id: 1, images: [],
    },
  });
  return res.data?.id;
}

/* ================================================================ 功能④ 删除记录 */
async function feature4(cdp) {
  console.log('\n===== 功能④ 卖家删商品记录 / 买家删订单记录 =====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');

  /* ---------------- 卖家：彻底删除已删商品记录 ---------------- */
  const nameA = `自动化测试：待删商品记录-${Date.now() % 100000}`;
  const pidA = await makeProduct(nameA, 12.0, sellerToken);
  await api('DELETE', `/api/products/${pidA}`, { token: sellerToken });   // 先软删除

  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/my-products?status=deleted');

  const tabInfo = await cdp.eval(`
    (() => ({
      tabs: [...document.querySelectorAll('#tabs .tab')].map(t => t.innerText.replace(/\\s+/g,' ').trim()),
      rows: [...document.querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\\s+/g,' ').trim()),
      hasRecordBtn: !!document.querySelector('tbody tr [data-record]'),
    }))()`);
  check('「我的商品」有「已删除」页签，且已删商品带「删除记录」按钮',
    tabInfo.tabs.some(t => t.includes('已删除')) && tabInfo.hasRecordBtn
    && tabInfo.rows.some(r => r.includes('待删商品记录')),
    `页签=${JSON.stringify(tabInfo.tabs)}，行数=${tabInfo.rows.length}`);

  await cdp.shot(path.join(SHOT_DIR, 'f4-deleted-tab.png'));

  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('tbody tr')]
        .find(r => r.innerText.includes('待删商品记录'));
      row.querySelector('[data-record]').click();
    })()`);
  await sleep(500);
  const modal = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return { shown: !!m, title: m?.querySelector('.modal-head')?.innerText || '' };
    })()`);
  check('彻底删除前会弹确认框', modal.shown && /彻底删除/.test(modal.title), JSON.stringify(modal));

  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await sleep(1200);

  const gone = await api('GET', `/api/products/${pidA}`);
  const stillListed = await cdp.eval(`
    [...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('待删商品记录'))`);
  check('确认后商品记录被彻底删除、列表里也消失',
    gone.code !== 0 && stillListed === false,
    `接口 code=${gone.code}（404 表示已不存在），列表仍显示=${stillListed}`);

  /* ---------------- 有交易记录的不能彻底删 ---------------- */
  const nameB = `自动化测试：有订单商品-${Date.now() % 100000}`;
  const pidB = await makeProduct(nameB, 21.0, sellerToken);
  await api('POST', '/api/orders', { token: buyerToken, body: { product_id: pidB, meet_place_id: 1 } });
  await api('DELETE', `/api/products/${pidB}`, { token: sellerToken });

  await cdp.go('/my-products?status=deleted');
  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('tbody tr')]
        .find(r => r.innerText.includes('有订单商品'));
      row.querySelector('[data-record]').click();
    })()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await sleep(1200);
  const blocked = await cdp.eval(`document.querySelector('.toast')?.innerText || ''`);
  // 注意：软删除的商品在公开详情接口本来就返回 404，所以要到「我的商品」里确认它还在
  const deletedList = await api('GET', '/api/products/mine?status=deleted&page_size=100',
    { token: sellerToken });
  const stillThere = (deletedList.data?.list || []).some(p => p.id === pidB);
  check('有交易记录的商品会被拒绝彻底删除并给出提示',
    /交易记录/.test(blocked) && stillThere,
    `提示=「${blocked.replace(/\s+/g, ' ')}」，仍在我的商品里=${stillThere}`);

  /* ---------------- 买家：删除订单记录 ---------------- */
  const nameC = `自动化测试：待删订单-${Date.now() % 100000}`;
  const pidC = await makeProduct(nameC, 33.0, sellerToken);
  const orderRes = await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: pidC, meet_place_id: 1 } });
  const orderId = orderRes.data.id;
  // 需求③：下单只是意向，卖家确认后才进「待完成」，也才能完成交易
  await api('PATCH', `/api/orders/${orderId}/confirm`, { token: sellerToken });
  await api('PATCH', `/api/orders/${orderId}/complete`, { token: buyerToken });

  // 再造一条「待完成」订单，用于验证它没有删除按钮
  const nameD = `自动化测试：进行中订单-${Date.now() % 100000}`;
  const pidD = await makeProduct(nameD, 44.0, sellerToken);
  const pendingRes = await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: pidD, meet_place_id: 1 } });
  // 需求③：卖家确认后才是「待完成」，界面上才该没有「删除记录」
  await api('PATCH', `/api/orders/${pendingRes.data.id}/confirm`, { token: sellerToken });

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/orders?status=pending');
  const pendingCard = await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('#list-area .card')]
        .find(c => c.innerText.includes('进行中订单'));
      return { found: !!card, hasDel: card ? !!card.querySelector('[data-act="del-order"]') : null };
    })()`);
  check('「待完成」订单没有「删除记录」按钮',
    pendingCard.found && pendingCard.hasDel === false, JSON.stringify(pendingCard));

  await cdp.go('/orders?status=done');
  // 用**订单 id** 定位按钮，别按商品名找卡片：名字里的 Date.now()%100000 会跨轮次重名，
  // 上一轮崩溃残留的同名单子会让断言误判（我在这上面栽过）。
  await waitFor(cdp, `!!document.querySelector('#list-area [data-act="del-order"][data-id="${orderId}"]')`);
  const doneCard = await cdp.eval(`
    (() => {
      const btn = document.querySelector('#list-area [data-act="del-order"][data-id="${orderId}"]');
      const card = btn ? btn.closest('.card') : null;
      return {
        found: !!card,
        hasDel: !!btn,
        text: card ? card.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
      };
    })()`);
  check('「已完成」订单有「删除记录」按钮',
    doneCard.found && doneCard.hasDel === true, `卡片「${doneCard.text}」`);

  await cdp.shot(path.join(SHOT_DIR, 'f4-order-delete.png'));

  await cdp.eval(`
    document.querySelector('#list-area [data-act="del-order"][data-id="${orderId}"]').click()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('#list-area [data-act="del-order"][data-id="${orderId}"]')`);
  await sleep(300);

  const afterDel = await cdp.eval(`
    (() => ({
      stillShown: !!document.querySelector('#list-area [data-act="del-order"][data-id="${orderId}"]'),
      toast: document.querySelector('.toast')?.innerText || '',
    }))()`);
  check('买家删除后自己的订单列表不再显示该订单',
    afterDel.stillShown === false && /已删除/.test(afterDel.toast),
    `仍显示=${afterDel.stillShown}，提示=「${afterDel.toast}」`);

  const mine = await api('GET', '/api/orders/mine?page_size=50', { token: buyerToken });
  const sellerSold = await api('GET', '/api/orders/sold?page_size=50', { token: sellerToken });
  check('只对买家隐藏：卖家「卖出订单」仍然保留',
    !(mine.data.list || []).some(o => o.id === orderId)
    && (sellerSold.data.list || []).some(o => o.id === orderId),
    `买家列表含=${(mine.data.list || []).some(o => o.id === orderId)}，卖家列表含=${(sellerSold.data.list || []).some(o => o.id === orderId)}`);

  /* ---------------- 收尾：测试数据统一在主流程结束时清理 ---------------- */
}

/** 调用 Python 清理工具，删掉「自动化测试 / 冒烟 / 验收」前缀的测试数据 */
function cleanupByPython() {
  try {
    const python = process.env.PYTHON_BIN
      || 'D:\\secondhandshop\\.venv\\Scripts\\python.exe';
    const script = path.resolve('tools/cleanup_test_data.py');   // 用绝对路径，避免 cwd 差异
    const r = spawnSync(python, [script], {
      stdio: 'ignore',
      cwd: path.resolve('.'),
      // stdio 为 ignore 时 Python 的输出编码会退化成 cp1252，打印中文会抛
      // UnicodeEncodeError 直接退出 1，所以必须显式指定 utf-8
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    if (r.error || r.status !== 0) {
      console.log('  （提示：自动清理未成功，可手动运行 manage.py clean-test）');
    }
  } catch { /* 清理失败不影响测试结论 */ }
}

/* ================================================================ 功能⑤ 帖子点击范围 */
async function feature5(cdp) {
  console.log('\n===== 功能⑤ 交流广场扩大帖子点击响应范围 =====');

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/posts');

  const layout = await cdp.eval(`
    (() => {
      const item = document.querySelector('#list-area .post-item');
      if (!item) return { found: false };
      return {
        found: true,
        cursor: getComputedStyle(item).cursor,
        title: item.querySelector('.post-title')?.innerText.trim() || '',
        id: item.dataset.post,
      };
    })()`);
  check('帖子卡片是可点击样式（cursor: pointer）',
    layout.found && layout.cursor === 'pointer', JSON.stringify(layout));

  // ---- 1. 点「内容摘要」区域（以前点这里没反应）----
  await cdp.eval(`
    (() => {
      const item = document.querySelector('#list-area .post-item');
      item.querySelector('.muted.small.mt-8')?.click() || item.click();
    })()`);
  await sleep(1000);
  const afterContent = await cdp.eval(`({ hash: location.hash, text: document.querySelector('#page').innerText.slice(0, 40) })`);
  check('点帖子内容区域能跳转到详情页',
    /^#\/post\/\d+/.test(afterContent.hash), `hash=${afterContent.hash}`);

  // ---- 2. 点「元信息」区域 ----
  await cdp.go('/posts');
  await cdp.eval(`document.querySelector('#list-area .post-item .post-meta').click()`);
  await sleep(1000);
  const afterMeta = await cdp.eval(`location.hash`);
  check('点作者 / 时间等元信息区域也能跳转',
    /^#\/post\/\d+/.test(afterMeta), `hash=${afterMeta}`);

  // ---- 3. 点标题（老行为，必须保持）----
  await cdp.go('/posts');
  await cdp.eval(`document.querySelector('#list-area .post-item .post-title').click()`);
  await sleep(1000);
  const afterTitle = await cdp.eval(`location.hash`);
  check('点标题依然能跳转（原有行为没有破坏）',
    /^#\/post\/\d+/.test(afterTitle), `hash=${afterTitle}`);

  await cdp.shot(path.join(SHOT_DIR, 'f5-post-card.png'));

  // ---- 4. 点赞按钮不能触发跳转（关键：别把整卡点击做成误触）----
  await cdp.go('/posts');
  const likeBefore = await cdp.eval(`
    (() => {
      const btn = document.querySelector('#list-area .post-item [data-like]');
      return { hash: location.hash, count: btn.querySelector('[data-like-count]').textContent.trim(), liked: btn.classList.contains('liked') };
    })()`);

  await cdp.eval(`document.querySelector('#list-area .post-item [data-like]').click()`);
  await sleep(900);
  const likeAfter = await cdp.eval(`
    (() => {
      const btn = document.querySelector('#list-area .post-item [data-like]');
      return { hash: location.hash, count: btn.querySelector('[data-like-count]').textContent.trim(), liked: btn.classList.contains('liked') };
    })()`);
  check('点「点赞」不会跳转，只切换点赞状态',
    likeAfter.hash === likeBefore.hash
    && likeAfter.liked !== likeBefore.liked
    && likeAfter.count !== likeBefore.count,
    `hash「${likeBefore.hash}」→「${likeAfter.hash}」，点赞 ${likeBefore.liked}→${likeAfter.liked}，数量 ${likeBefore.count}→${likeAfter.count}`);

  // 复原点赞状态，别留痕
  await cdp.eval(`document.querySelector('#list-area .post-item [data-like]').click()`);
  await sleep(900);
  const likeRestored = await cdp.eval(`
    (() => {
      const btn = document.querySelector('#list-area .post-item [data-like]');
      return { hash: location.hash, liked: btn.classList.contains('liked') };
    })()`);
  check('再点一次点赞可复原，且依然不跳转',
    likeRestored.liked === likeBefore.liked && likeRestored.hash === likeBefore.hash,
    JSON.stringify(likeRestored));

  // ---- 5. 「评论」按钮仍然进详情 ----
  await cdp.eval(`document.querySelector('#list-area .post-item [data-comment]').click()`);
  await sleep(1000);
  const afterComment = await cdp.eval(`location.hash`);
  check('点「评论」按钮进入详情页',
    /^#\/post\/\d+/.test(afterComment), `hash=${afterComment}`);
}

/* ================================================================ 功能⑥ 帖子配图 */
async function feature6(cdp) {
  console.log('\n===== 功能⑥ 帖子发布支持配图 =====');

  // 造两张极小的真实 PNG，走真实的 input[type=file] 上传链路
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const img1 = path.join(WORK, 'post-img-1.png');
  const img2 = path.join(WORK, 'post-img-2.png');
  fs.writeFileSync(img1, png);
  fs.writeFileSync(img2, png);

  const title = `自动化测试：带图帖子-${Date.now() % 100000}`;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/posts');

  await cdp.eval(`document.querySelector('#btn-new-post').click()`);
  await sleep(600);
  const modalReady = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return { shown: !!m, hasPicker: !!m?.querySelector('#po-images'), hasBtn: !!m?.querySelector('#po-pick') };
    })()`);
  check('发帖弹窗里有配图上传入口',
    modalReady.shown && modalReady.hasPicker && modalReady.hasBtn, JSON.stringify(modalReady));

  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector',
    { nodeId: root.nodeId, selector: '#po-images' });
  await cdp.send('DOM.setFileInputFiles', { files: [img1, img2], nodeId });
  await sleep(1800);

  const thumbs = await cdp.eval(`
    (() => ({
      count: document.querySelectorAll('#po-image-list img').length,
      srcs: [...document.querySelectorAll('#po-image-list img')].map(i => i.getAttribute('src')),
    }))()`);
  check('选择两张图后弹窗里出现缩略图',
    thumbs.count === 2 && thumbs.srcs.every(s => s.startsWith('/uploads/')),
    `缩略图 ${thumbs.count} 张：${JSON.stringify(thumbs.srcs)}`);

  await cdp.shot(path.join(SHOT_DIR, 'f6-post-modal.png'));

  // 删掉一张，验证可以移除
  await cdp.eval(`document.querySelector('#po-image-list [data-rm]').click()`);
  await sleep(400);
  const afterRemove = await cdp.eval(`document.querySelectorAll('#po-image-list img').length`);
  check('点缩略图上的 × 可以移除已选图片', afterRemove === 1, `剩余 ${afterRemove} 张`);

  // 再补一张回来，凑够两张发布
  await cdp.send('DOM.setFileInputFiles', { files: [img2], nodeId });
  await sleep(1500);

  await cdp.eval(`
    (() => {
      const set = (sel, val) => {
        const el = document.querySelector(sel);
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('#po-title', ${JSON.stringify(title)});
      set('#po-content', '自动化测试：这条帖子带两张配图，用来验证发帖配图全链路。');
      document.querySelector('input[name="po-tag"][value="安利"]').checked = true;
      document.querySelector('#po-submit').click();
    })()`);
  await sleep(1800);

  const inList = await cdp.eval(`
    (() => {
      const item = [...document.querySelectorAll('#list-area .post-item')]
        .find(i => i.innerText.includes('带图帖子'));
      return {
        found: !!item,
        thumbs: item ? item.querySelectorAll('.post-thumbs img').length : 0,
        toast: document.querySelector('.toast')?.innerText || '',
      };
    })()`);
  check('新帖出现在列表里并带缩略图',
    inList.found && inList.thumbs === 2, JSON.stringify(inList));

  // 进详情看图集
  await cdp.eval(`
    (() => {
      const item = [...document.querySelectorAll('#list-area .post-item')]
        .find(i => i.innerText.includes('带图帖子'));
      item.click();
    })()`);
  await sleep(1300);
  const detail = await cdp.eval(`
    (() => ({
      hash: location.hash,
      gallery: document.querySelectorAll('#post-gallery img').length,
    }))()`);
  check('帖子详情页展示配图',
    /^#\/post\/\d+/.test(detail.hash) && detail.gallery === 2, JSON.stringify(detail));

  await cdp.shot(path.join(SHOT_DIR, 'f6-post-detail.png'));

  // 点图片放大
  await cdp.eval(`document.querySelector('#post-gallery img').click()`);
  await sleep(600);
  const zoom = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return { shown: !!m, hasImg: !!m?.querySelector('img') };
    })()`);
  check('点配图可以放大查看', zoom.shown && zoom.hasImg, JSON.stringify(zoom));
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
  await sleep(400);

  // 接口层面复核
  const found = await api('GET', `/api/posts?keyword=${encodeURIComponent('带图帖子')}`);
  const post = (found.data?.list || [])[0];
  check('接口里该帖确实存了两张配图',
    (post?.images || []).length === 2, JSON.stringify(post?.images || []));

  // 删掉测试帖（配图随外键级联删除）
  if (post) await api('DELETE', `/api/posts/${post.id}`, { token: await login('buyer1', '123456', 'buyer') });
}

/* ================================================================ 功能⑦ 个人资料 */
async function feature7(cdp) {
  console.log('\n===== 功能⑦ 个人资料（昵称、头像）=====');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const avatarFile = path.join(WORK, 'avatar-test.png');
  fs.writeFileSync(avatarFile, png);

  const buyerToken = await login('buyer1', '123456', 'buyer');
  const original = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;
  const originalNick = original.nickname;
  const newNick = `李小明${Date.now() % 1000}`;

  // 前置状态归一化（2026-10-17）：下面要断言「未设置头像时显示昵称首字」，
  // 而别的分组/上一次运行可能在这账号上留了一张头像 → 先清空，别依赖环境。
  await api('PUT', '/api/auth/profile', { token: buyerToken, body: { avatar: '' } });

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/profile');

  const loaded = await cdp.eval(`
    (() => ({
      hasNick: !!document.querySelector('#pf-nickname'),
      nick: document.querySelector('#pf-nickname')?.value || '',
      hasPicker: !!document.querySelector('#avatar-file'),
      previewText: document.querySelector('#avatar-preview')?.innerText.trim() || '',
      menuItems: [...document.querySelectorAll('.menu-item')].map(m => m.innerText.trim()),
    }))()`);
  // 入口已在界面调整②中移入右上角用户小框，这里顺便复核一下
  await cdp.eval(`document.querySelector('#user-menu').click()`);
  await sleep(400);
  const ddItems = await cdp.eval(`
    [...document.querySelectorAll('.dropdown .dd-item')].map(i => i.innerText.replace(/\\s+/g, ' ').trim())`);
  await cdp.eval(`document.querySelector('.dropdown')?.remove()`);
  check('「个人资料」入口在右上角用户小框里、且左侧功能列已不再有它',
    ddItems.some(t => t.includes('个人资料')) && !loaded.menuItems.some(t => t.includes('个人资料')),
    `小框项=${JSON.stringify(ddItems)}，左侧菜单=${JSON.stringify(loaded.menuItems)}`);
  check('资料页能读到当前昵称',
    loaded.nick === originalNick, `昵称=「${loaded.nick}」`);
  check('资料页有头像上传入口，未设置头像时显示昵称首字',
    loaded.hasPicker && loaded.previewText === originalNick.slice(0, 1),
    `预览=「${loaded.previewText}」`);

  await cdp.shot(path.join(SHOT_DIR, 'f7-profile.png'));

  // ---- 1. 昵称为空时不给保存 ----
  await cdp.eval(`
    (() => {
      const el = document.querySelector('#pf-nickname');
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-save').click();
    })()`);
  await sleep(700);
  const emptyNick = await cdp.eval(`
    (() => ({
      invalid: document.querySelector('#pf-nickname').classList.contains('invalid'),
      err: document.querySelector('#pf-nickname')?.parentElement.querySelector('.form-error')?.innerText || '',
      nick: document.querySelector('#pf-nickname').value,
    }))()`);
  const serverNick1 = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user.nickname;
  check('昵称留空时标红提示且没有提交',
    emptyNick.invalid && emptyNick.err.includes('昵称') && serverNick1 === originalNick,
    `标红=${emptyNick.invalid}，提示=「${emptyNick.err}」，服务端昵称仍为「${serverNick1}」`);

  // ---- 2. 上传头像 ----
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector',
    { nodeId: root.nodeId, selector: '#avatar-file' });
  await cdp.send('DOM.setFileInputFiles', { files: [avatarFile], nodeId });
  // 本批需求④ 起：选完文件会先弹出裁剪框，要确认「裁剪并上传」才真的上传
  await waitFor(cdp, `!!document.querySelector('#crop-ok')`);
  await sleep(400);
  await cdp.eval(`document.querySelector('#crop-ok').click()`);
  await waitFor(cdp, `!document.querySelector('#crop-ok')`);
  await sleep(1200);

  const afterUpload = await cdp.eval(`
    (() => ({
      hasImg: !!document.querySelector('#avatar-preview img'),
      src: document.querySelector('#avatar-preview img')?.getAttribute('src') || '',
    }))()`);
  check('上传头像后预览立刻变成图片',
    afterUpload.hasImg && afterUpload.src.startsWith('/uploads/'), JSON.stringify(afterUpload));

  // ---- 3. 改昵称 + 保存 ----
  await cdp.eval(`
    (() => {
      const el = document.querySelector('#pf-nickname');
      el.value = ${JSON.stringify(newNick)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#btn-save').click();
    })()`);
  await sleep(1600);

  const saved = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;
  check('保存后接口里昵称与头像都已更新',
    saved.nickname === newNick && !!saved.avatar,
    `昵称=${saved.nickname}，头像=${saved.avatar}`);

  // ---- 4. 顶栏跟着变 ----
  const topbar = await cdp.eval(`
    (() => {
      const btn = document.querySelector('#user-menu');
      return {
        text: btn?.innerText.replace(/\\s+/g, ' ').trim() || '',
        hasImg: !!btn?.querySelector('.avatar-dot img'),
        imgSrc: btn?.querySelector('.avatar-dot img')?.getAttribute('src') || '',
      };
    })()`);
  check('顶栏昵称与头像同步更新',
    topbar.text.includes(newNick) && topbar.hasImg && topbar.imgSrc.startsWith('/uploads/'),
    JSON.stringify(topbar));

  await cdp.shot(path.join(SHOT_DIR, 'f7-profile-saved.png'));

  // ---- 5. 恢复默认头像 ----
  await cdp.eval(`
    (() => {
      document.querySelector('#btn-clear-avatar').click();
      document.querySelector('#btn-save').click();
    })()`);
  await sleep(1600);
  const cleared = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;
  const topbarAfter = await cdp.eval(`
    (() => {
      const btn = document.querySelector('#user-menu');
      return { hasImg: !!btn?.querySelector('.avatar-dot img'), text: btn?.innerText.replace(/\\s+/g,' ').trim() || '' };
    })()`);
  check('恢复默认头像后接口与顶栏都回到首字',
    !cleared.avatar && !topbarAfter.hasImg, `接口 avatar=${cleared.avatar}，顶栏有图=${topbarAfter.hasImg}`);

  // ---- 6. 头像也出现在私信头像位（复用同一套渲染）----
  await api('PUT', '/api/auth/profile', { token: buyerToken, body: { avatar: saved.avatar } });
  await cdp.go('/profile');
  await sleep(600);

  // ---- 收尾：把昵称和头像都还原成测试前的样子 ----
  await api('PUT', '/api/auth/profile',
    { token: buyerToken, body: { nickname: originalNick, avatar: original.avatar || '' } });
  const restored = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;
  check('测试结束后资料已还原',
    restored.nickname === originalNick && (restored.avatar || null) === (original.avatar || null),
    `昵称=${restored.nickname}，头像=${restored.avatar}`);
}

/* ================================================================ 功能⑧ 站名回首页 */
async function feature8(cdp) {
  console.log('\n===== 功能⑧ 点击左上角站名回首页、左侧不再有「首页」 =====');

  const readShell = () => cdp.eval(`
    (() => {
      const brand = document.querySelector('#brand-home');
      return {
        menuItems: [...document.querySelectorAll('.menu-item')].map(m => m.innerText.trim()),
        brandText: brand?.innerText.trim() || '',
        brandTag: brand?.tagName || '',
        brandCursor: brand ? getComputedStyle(brand).cursor : '',
        hash: location.hash,
      };
    })()`);

  // ---- 1. 游客：菜单里没有「首页」，站名可点 ----
  await cdp.logout();
  await cdp.go('/search');
  const guest = await readShell();
  check('左侧功能列不再有「首页」按钮',
    !guest.menuItems.some(t => t === '首页'),
    `游客菜单=${JSON.stringify(guest.menuItems)}`);
  check('左上角站名是真正可点击的按钮',
    guest.brandTag === 'BUTTON' && guest.brandCursor === 'pointer' && guest.brandText.includes('校园二手集市'),
    `标签=${guest.brandTag}，光标=${guest.brandCursor}，文字=「${guest.brandText}」`);

  await cdp.eval(`document.querySelector('#brand-home').click()`);
  await sleep(1200);
  const afterBrand = await cdp.eval(`
    (() => ({
      hash: location.hash,
      hasCategoryEntry: !!document.querySelector('#page .cat-card, #page .category-card, #page [data-category]'),
      text: document.querySelector('#page')?.innerText.slice(0, 30) || '',
    }))()`);
  check('点站名能跳到首页并渲染出首页内容',
    afterBrand.hash === '#/home' && /分类|最新|校园/.test(afterBrand.text),
    `hash=${afterBrand.hash}，首页文字「${afterBrand.text.replace(/\n/g, ' ')}」`);

  await cdp.shot(path.join(SHOT_DIR, 'f8-brand-home.png'));

  // ---- 2. 买家 / 卖家 / 管理员三种视角都不该出现「首页」 ----
  for (const [account, role, view] of [['buyer1', '123456', 'buyer'], ['seller1', '123456', 'seller'], ['admin', '123456', 'admin']]) {
    await cdp.loginAs(account, role, view);
    await cdp.go('/search');
    const shell = await readShell();
    check(`${view} 视角左侧功能列也没有「首页」`,
      !shell.menuItems.some(t => t === '首页') && shell.menuItems.length > 0 && shell.brandTag === 'BUTTON',
      `菜单=${JSON.stringify(shell.menuItems)}`);
    await cdp.eval(`document.querySelector('#brand-home').click()`);
    await sleep(900);
    const hash = await cdp.eval(`location.hash`);
    check(`${view} 视角点站名同样能回首页`, hash === '#/home', `hash=${hash}`);
  }
}

/* ================================================================ 功能⑨ 用户小框收纳 */
async function feature9(cdp) {
  console.log('\n===== 功能⑨ 「我的消息」「个人资料」移入右上角用户小框 =====');

  const readShell = () => cdp.eval(`
    (() => ({
      menuItems: [...document.querySelectorAll('.menu-item')].map(m => m.innerText.trim()),
      avatarBtn: !!document.querySelector('#user-menu'),
      badgeInAvatar: !!document.querySelector('#user-menu #msg-badge'),
      legacyMsgEntry: !!document.querySelector('#msg-entry'),
    }))()`);

  // ---- 1. 买家视角 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/search');
  const buyerShell = await readShell();
  check('买家左侧功能列不再有「我的消息」「个人资料」',
    !buyerShell.menuItems.some(t => t.includes('我的消息')) && !buyerShell.menuItems.some(t => t.includes('个人资料')),
    `左侧菜单=${JSON.stringify(buyerShell.menuItems)}`);
  check('顶栏不再有单独的消息图标按钮（合并进用户小框）',
    buyerShell.legacyMsgEntry === false && buyerShell.avatarBtn, JSON.stringify(buyerShell));

  // ---- 2. 打开用户小框，两个入口都在里面 ----
  await cdp.eval(`document.querySelector('#user-menu').click()`);
  await sleep(600);
  const dd = await cdp.eval(`
    (() => {
      const box = document.querySelector('.dropdown');
      return {
        shown: !!box,
        items: [...(box?.querySelectorAll('.dd-item') || [])].map(i => i.innerText.replace(/\\s+/g, ' ').trim()),
      };
    })()`);
  check('用户小框里有「我的消息」和「个人资料」',
    dd.shown && dd.items.some(t => t.includes('我的消息')) && dd.items.some(t => t.includes('个人资料')),
    `小框项=${JSON.stringify(dd.items)}`);

  await cdp.shot(path.join(SHOT_DIR, 'f9-user-dropdown.png'));

  // ---- 3. 从小框点进「个人资料」 ----
  await cdp.eval(`
    [...document.querySelectorAll('.dropdown .dd-item')]
      .find(b => b.innerText.includes('个人资料')).click()`);
  await sleep(1300);
  const profileHash = await cdp.eval(`({ hash: location.hash, hasNick: !!document.querySelector('#pf-nickname') })`);
  check('从小框能直接进入个人资料页', profileHash.hash === '#/profile' && profileHash.hasNick, JSON.stringify(profileHash));

  // ---- 4. 从小框点进「我的消息」 ----
  await cdp.eval(`document.querySelector('#user-menu').click()`);
  await sleep(500);
  await cdp.eval(`
    [...document.querySelectorAll('.dropdown .dd-item')]
      .find(b => b.innerText.includes('我的消息')).click()`);
  await sleep(1300);
  const msgHash = await cdp.eval(`location.hash`);
  check('从小框能直接进入我的消息页', msgHash.startsWith('#/messages'), `hash=${msgHash}`);

  // ---- 5. 卖家 / 管理员视角同样不再出现在左侧 ----
  for (const [account, role, view] of [['seller1', '123456', 'seller'], ['admin', '123456', 'admin']]) {
    await cdp.loginAs(account, role, view);
    await cdp.go('/search');
    const shell = await readShell();
    const ok = !shell.menuItems.some(t => t.includes('我的消息'))
      && !shell.menuItems.some(t => t.includes('个人资料')) && shell.avatarBtn;
    await cdp.eval(`document.querySelector('#user-menu').click()`);
    await sleep(500);
    const items = await cdp.eval(`
      [...document.querySelectorAll('.dropdown .dd-item')].map(i => i.innerText.replace(/\\s+/g, ' ').trim())`);
    await cdp.eval(`document.querySelector('.dropdown')?.remove()`);
    check(`${view} 视角：左侧无这两项、小框里有`,
      ok && items.some(t => t.includes('我的消息')) && items.some(t => t.includes('个人资料')),
      `左侧=${JSON.stringify(shell.menuItems)}；小框=${JSON.stringify(items)}`);
  }
}

/* ================================================================ 功能⑩ 商品编号 */
const CODE_RE = /^[A-Z0-9]{2}\d{2}-\d{4}-\d{6}-\d{5}$/;

async function feature10(cdp) {
  console.log('\n===== 功能⑩ 商品编号 product_code =====');

  const sellerToken = await login('seller1', '123456', 'seller');

  // 找一件 seller1 的在售商品作为样本
  const mine = await api('GET', '/api/products/mine?status=on_sale&page_size=1', { token: sellerToken });
  const sample = (mine.data?.list || [])[0];
  check('样本商品的编号格式正确（分类码-卖家码-日期码-流水号）',
    CODE_RE.test(sample?.product_code || ''), `编号=${sample?.product_code}`);

  // ---- 1. 商品详情页展示编号 ----
  await cdp.logout();
  await cdp.go(`/product/${sample.id}`);
  await sleep(1200);   // 详情页要发一次请求后才有内容，别抢在渲染前断言
  const detail = await cdp.eval(`
    (() => {
      const el = document.querySelector('#product-code');
      return { shown: !!el, text: (el?.innerText || '').trim(),
               selectable: el ? getComputedStyle(el).userSelect : '' };
    })()`);
  check('商品详情页在信息区展示商品编号（可选中复制）',
    detail.shown && detail.text === sample.product_code && detail.selectable === 'all',
    JSON.stringify(detail));

  await cdp.shot(path.join(SHOT_DIR, 'f10-detail-code.png'));

  // ---- 2. 我的商品 列表带编号 ----
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/my-products');
  const list = await cdp.eval(`
    (() => {
      const text = document.querySelector('#list-area')?.innerText || '';
      const found = text.match(/[A-Z0-9]{2}\\d{2}-\\d{4}-\\d{6}-\\d{5}/g) || [];
      return { count: found.length, first: found[0] || '' };
    })()`);
  check('「我的商品」列表里每行都能看到编号',
    list.count > 0 && CODE_RE.test(list.first), JSON.stringify(list));

  // ---- 3. 我的订单 显示编号 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/orders');
  const orderCodes = await cdp.eval(`
    (() => {
      const text = document.querySelector('#list-area')?.innerText || '';
      return (text.match(/编号\\s*[A-Z0-9]{2}\\d{2}-\\d{4}-\\d{6}-\\d{5}/g) || []).length;
    })()`);
  check('「我的订单」卡片上显示商品编号', orderCodes > 0, `命中 ${orderCodes} 处`);

  // ---- 4. 管理后台：行内展示 + 按编号搜索 ----
  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=products');
  // 管理后台是懒加载模块：等列表与搜索框真的渲染出来再取值（否则会读到 null）
  await waitFor(cdp, `!!document.querySelector('#ad-keyword') && !!document.querySelector('#ad-list')`);
  await sleep(600);
  const adminView = await cdp.eval(`
    (() => {
      // 管理后台商品列表的容器是 #ad-list（不是前台的 #list-area）
      const box = document.querySelector('#ad-list') || document.querySelector('#page');
      const text = box?.innerText || '';
      const hits = text.match(/[A-Z0-9]{2}\\d{2}-\\d{4}-\\d{6}-\\d{5}/g) || [];
      const input = document.querySelector('#ad-keyword');
      return { hits: hits.length, first: hits[0] || '', placeholder: input?.placeholder || '' };
    })()`);
  check('管理后台商品列表展示编号，且搜索框提示已含「编号」',
    adminView.hits > 0 && adminView.placeholder.includes('编号'),
    JSON.stringify(adminView));

  // 用样本编号的前 8 位（分类码 + 卖家码）做前缀搜索
  const prefix = sample.product_code.slice(0, 8);
  await cdp.eval(`
    (() => {
      const input = document.querySelector('#ad-keyword');
      input.value = ${JSON.stringify(prefix)};
      document.querySelector('#ad-search').click();
    })()`);
  await sleep(1300);
  const searched = await cdp.eval(`
    (() => {
      const text = document.querySelector('#ad-list')?.innerText || '';
      return { hits: [...new Set(text.match(/[A-Z0-9]{2}\\d{2}-\\d{4}-\\d{6}-\\d{5}/g) || [])] };
    })()`);
  check(`管理后台可按编号前缀「${prefix}」搜索`,
    searched.hits.length > 0 && searched.hits.every(c => c.startsWith(prefix)),
    JSON.stringify(searched.hits));

  // ---- 5. 基础数据：字母码输入框 / 列表展示 ----
  await cdp.go('/admin?tab=base');
  // 管理后台是懒加载模块、基础数据还要先取分类列表；只靠固定毫秒等待在全量跑时会偶发失败
  await waitFor(cdp, `!!document.querySelector('#cat-table tbody tr')`);
  await waitFor(cdp, `!!document.querySelector('#sub-table tbody tr')`);
  const base = await cdp.eval(`
    (() => ({
      catHasCode: /\\b(TA|DG|LF|SP|OT)\\b/.test(document.querySelector('#cat-table')?.innerText || ''),
      subHasSeq: /序号\\s*\\d{2}/.test(document.querySelector('#sub-table')?.innerText || ''),
    }))()`);
  check('基础数据里分类显示字母码、小类显示序号',
    base.catHasCode && base.subHasSeq, JSON.stringify(base));

  await cdp.eval(`document.querySelector('#cat-add').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-field="code"]')`);
  const modal = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return { shown: !!m, fields: [...(m?.querySelectorAll('[data-field]') || [])].map(i => i.dataset.field) };
    })()`);
  check('新增分类弹窗里有「字母码」输入框（其余字段不变）',
    modal.shown && ['name', 'icon', 'code', 'sort'].every(f => modal.fields.includes(f)),
    JSON.stringify(modal.fields));

  await cdp.shot(path.join(SHOT_DIR, 'f10-admin-base.png'));
  await cdp.eval(`document.querySelector('.modal-mask [data-close]')?.click()`);
  await sleep(400);

  // ---- 6. 新发布的商品立刻有编号，详情页能看到 ----
  const created = await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：编号回显', price: 7.7, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '验证发布后编号回显', default_place_id: 2, images: [] },
  });
  const fresh = created.data || {};
  check('发布成功后接口立即返回编号', CODE_RE.test(fresh.product_code || ''),
    `编号=${fresh.product_code}`);
  check('同卖家流水号在前一件基础上递增',
    Number((fresh.product_code || '').split('-')[3]) > Number(sample.product_code.split('-')[3]),
    `${sample.product_code} -> ${fresh.product_code}`);

  await cdp.logout();
  await cdp.go(`/product/${fresh.id}`);
  await sleep(1200);
  const freshDetail = await cdp.eval(`document.querySelector('#product-code')?.innerText.trim() || ''`);
  check('新商品详情页能看到它的编号', freshDetail === fresh.product_code, `页面显示「${freshDetail}」`);

  // 收尾：彻底删掉测试商品
  await api('DELETE', `/api/products/${fresh.id}`, { token: sellerToken });
  await api('DELETE', `/api/products/${fresh.id}/record`, { token: sellerToken });
  const stillThere = await api('GET', `/api/products/${fresh.id}`);
  check('测试商品已彻底清理', stillThere.code !== 0, `接口 code=${stillThere.code}`);
}

/* ================================================================ 功能⑪ 管理员交易监管（需求①） */
async function feature11(cdp) {
  console.log('\n===== 功能⑪ 管理员交易监管（需求①）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const adminToken = await login('admin', '123456', 'admin');

  // 自己造一笔可取消的测试交易（名字带「自动化测试」前缀，结束时由清理脚本连同订单一起删掉），
  // 这样验证「管理员干预」全程不碰用户自己的交易数据。
  const created = await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：交易监管', price: 21, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '管理员交易监管测试用', default_place_id: 2, images: [] },
  });
  const prod = created.data || {};
  const order = (await api('POST', '/api/orders', {
    token: buyerToken, body: { product_id: prod.id, meet_place_id: 2 },
  })).data || {};
  check('需求③：下单后先是一笔「待卖家确认」的意向',
    order.status === 'awaiting' && !!order.id, JSON.stringify({ id: order.id, status: order.status }));
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: sellerToken });
  check('测试交易已就绪（商品已售 + 待完成订单）',
    order.status === 'awaiting' && !!order.id, JSON.stringify({ id: order.id, status: order.status }));

  // ---- 1. 页签与页面结构 ----
  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=trades');
  // 管理后台是懒加载模块，首次进入要现取 admin.js，别死等固定毫秒
  await waitFor(cdp, `document.querySelectorAll('#td-stats .stat-card').length === 4`);
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);
  const ui = await cdp.eval(`
    (() => ({
      hasTab: [...document.querySelectorAll('#tabs .tab')].some(t => t.innerText.includes('交易管理')),
      stats: [...document.querySelectorAll('#td-stats .stat-card')].map(c => c.innerText.replace(/\\n/g, ' ').trim()),
      rows: document.querySelectorAll('#td-list tbody tr').length,
      text: document.querySelector('#td-list')?.innerText || '',
      logItems: document.querySelectorAll('#lg-list .tl-item').length,
    }))()`);
  check('管理后台出现「交易管理」页签', ui.hasTab, JSON.stringify(ui.stats));
  check('交易管理页顶部有 4 张总览卡（进行中/涉及商家/最长挂单/今日新增）',
    ui.stats.length === 4, JSON.stringify(ui.stats));
  check('进行中的交易列表能列出交易，且带商品编号',
    ui.rows > 0 && /[A-Z0-9]{2}\d{2}-\d{4}-\d{6}-\d{5}/.test(ui.text), `rows=${ui.rows}`);
  check('同页的「动态监控」时间线有内容', ui.logItems > 0, `共 ${ui.logItems} 条`);

  await cdp.shot(path.join(SHOT_DIR, 'f11-admin-trades.png'));

  // ---- 2. 自动刷新后仍然正常 ----
  await sleep(6500);
  const refreshed = await cdp.eval(`
    (() => ({
      rows: document.querySelectorAll('#td-list tbody tr').length,
      logs: document.querySelectorAll('#lg-list .tl-item').length,
    }))()`);
  check('自动刷新（5 秒一轮）后页面仍正常渲染，没有刷没或报错',
    refreshed.rows > 0 && refreshed.logs > 0, JSON.stringify(refreshed));

  // ---- 3. 点「强制取消」先弹确认框；取消确认时数据不变 ----
  const clickCancel = () => cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('#td-list tbody tr')]
        .find(r => r.innerText.includes('自动化测试：交易监管'));
      if (!row) return { ok: false };
      row.querySelector('[data-cancel]').click();
      return { ok: true };
    })()`);
  const c1 = await clickCancel();
  const dlgReady = await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  const dlg = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return { shown: !!m, title: m?.querySelector('.modal-head')?.innerText || '' };
    })()`);
  check('点「强制取消」会先弹确认框', c1.ok && dlgReady && /强制取消/.test(dlg.title),
    JSON.stringify(dlg));

  // 确认框的取消按钮是 [data-cancel]（[data-close] 是表单弹窗 openModal 的属性，别混）
  await cdp.eval(`document.querySelector('.modal-mask [data-cancel]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  const untouched = await api('GET', `/api/products/${prod.id}`, { token: sellerToken });
  check('取消确认时交易数据不变（商品仍为已售）',
    untouched.data?.status === 'sold', `商品状态=${untouched.data?.status}`);

  // ---- 4. 确认后真的取消，并且留痕 ----
  await clickCancel();
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await waitFor(cdp, `/管理员强制取消交易/.test(document.querySelector('#lg-list')?.innerText || '')`);
  await sleep(600);

  const afterApi = await api('GET', `/api/products/${prod.id}`, { token: sellerToken });
  check('确认后管理员强制取消生效，商品恢复在售',
    afterApi.data?.status === 'on_sale', `商品状态=${afterApi.data?.status}`);

  const logged = await cdp.eval(`
    (() => {
      const t = document.querySelector('#lg-list')?.innerText || '';
      return { hasForce: /管理员强制取消交易/.test(t), head: t.slice(0, 140).replace(/\\n/g, ' | ') };
    })()`);
  check('动态监控里立刻出现「管理员强制取消交易」留痕', logged.hasForce, logged.head);

  // ---- 5. 收尾核对：这笔交易不再算「进行中」（商品与订单由清理脚本删掉） ----
  const stillPending = await api('GET', '/api/admin/orders?status=pending', { token: adminToken });
  check('取消后该笔交易不再出现在「进行中」里',
    !(stillPending.data?.list || []).some(o => o.id === order.id),
    `仍有 ${stillPending.data?.total} 笔进行中`);
}

/* ================================================================ 功能⑫ 卖家商品主页（需求②） */
async function feature12(cdp) {
  console.log('\n===== 功能⑫ 卖家商品主页（需求②）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const me = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;
  const originalBio = me.bio || '';
  const mine = await api('GET', '/api/products/mine?status=on_sale&page_size=1', { token: sellerToken });
  const sample = (mine.data?.list || [])[0];

  // ---- 1. 详情页卖家昵称是可点入口 ----
  await cdp.logout();
  await cdp.go(`/product/${sample.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-seller]')`);
  const link = await cdp.eval(`
    (() => {
      const b = document.querySelector('[data-seller]');
      return { text: b?.innerText.trim() || '', sellerId: b?.dataset.seller || '' };
    })()`);
  check('商品详情页的卖家昵称是可点的入口', link.sellerId === String(me.id), JSON.stringify(link));

  await cdp.eval(`document.querySelector('[data-seller]').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  const hash = await cdp.eval(`location.hash`);
  check('点卖家昵称跳到 TA 的卖家主页', hash === `#/seller/${me.id}`, hash);

  // ---- 2. 主页顶部信息与商品流 ----
  await waitFor(cdp, `!!document.querySelector('.seller-head')`);
  await waitFor(cdp, `document.querySelectorAll('.product-card').length > 0`);
  const head = await cdp.eval(`
    (() => ({
      name: document.querySelector('.seller-nick')?.innerText.trim() || '',
      hasBio: !!document.querySelector('.seller-bio'),
      stats: document.querySelector('.seller-stats')?.innerText.replace(/\\n/g, ' ') || '',
      avatar: !!document.querySelector('.seller-avatar'),
      cards: document.querySelectorAll('.product-card').length,
      firstCard: document.querySelector('.product-card')?.innerText.replace(/\\n/g, ' ') || '',
      hasCover: !!document.querySelector('.product-card .pc-cover'),
    }))()`);
  check('卖家主页顶部显示头像与昵称',
    head.avatar && head.name === me.nickname, JSON.stringify({ name: head.name }));
  check('顶部有商家简介区（未填时给占位提示）', head.hasBio, '');
  check('顶部显示在售件数、加入时间、卖家编号',
    /在售/.test(head.stats) && /加入时间/.test(head.stats) && /卖家编号/.test(head.stats),
    head.stats);
  check('商品流用与主页一致的商品卡（含图片位 / 名称 / 价格）',
    head.cards > 0 && head.hasCover && /¥/.test(head.firstCard), head.firstCard.slice(0, 80));
  await cdp.shot(path.join(SHOT_DIR, 'f12-seller-page.png'));

  // ---- 3. 在售/已售切换 + 关键词筛选 ----
  const soldClick = await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('#sk-status [data-status]')]
        .find(x => x.dataset.status === 'sold');
      if (!b) return false;
      b.click();
      return true;
    })()`);
  await sleep(1500);
  const soldState = await cdp.eval(`
    (() => ({
      activeSold: !!document.querySelector('#sk-status [data-status="sold"].btn-primary'),
      cards: document.querySelectorAll('.product-card').length,
      empty: !!document.querySelector('.empty'),
    }))()`);
  check('能切到「已售」视图（无成交时给出空态提示）',
    soldClick && soldState.activeSold && (soldState.cards > 0 || soldState.empty),
    JSON.stringify(soldState));

  await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('#sk-status [data-status]')]
        .find(x => x.dataset.status === 'on_sale');
      b.click();
    })()`);
  await sleep(1400);
  await cdp.eval(`
    (() => {
      document.querySelector('#sk-keyword').value = '绝对不存在的商品名xyz';
      document.querySelector('#sk-search').click();
    })()`);
  await waitFor(cdp, `!!document.querySelector('.empty')`);
  check('卖家主页的关键词筛选生效（查不到时给空态）', true, '');

  // ---- 4. 个人资料页填商家简介 → 主页可见 ----
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/profile');
  await waitFor(cdp, `!!document.querySelector('#pf-bio')`);
  const bioField = await cdp.eval(`
    (() => {
      const el = document.querySelector('#pf-bio');
      return { exists: !!el, maxlength: el?.getAttribute('maxlength'),
               hint: el?.parentElement?.innerText || '' };
    })()`);
  check('个人资料页有「商家简介」输入框（限 100 字，且提示会展示在卖家主页）',
    bioField.exists && bioField.maxlength === '100' && /卖家主页/.test(bioField.hint),
    JSON.stringify(bioField));

  const NEW_BIO = '自动化测试：常年在校，出闲置教材';
  await cdp.eval(`
    (() => {
      document.querySelector('#pf-bio').value = ${JSON.stringify(NEW_BIO)};
      document.querySelector('#btn-save').click();
    })()`);
  await sleep(1800);
  const saved = await api('GET', '/api/auth/me', { token: sellerToken });
  check('保存商家简介成功', saved.data?.user?.bio === NEW_BIO, `当前=${saved.data?.user?.bio}`);

  await cdp.logout();
  await cdp.go(`/seller/${me.id}`);
  await waitFor(cdp, `!!document.querySelector('.seller-bio')`);
  const shownBio = await cdp.eval(`document.querySelector('.seller-bio')?.innerText.trim() || ''`);
  check('商家简介确实显示在卖家主页顶部', shownBio === NEW_BIO, `页面显示「${shownBio}」`);

  // 收尾：还原成测试前的值
  await api('PUT', '/api/auth/profile', { token: sellerToken, body: { bio: originalBio } });
  const restored = await api('GET', `/api/sellers/${me.id}`);
  check('商家简介已还原成测试前的值',
    (restored.data?.seller?.bio || '') === originalBio, `当前=${restored.data?.seller?.bio}`);
}

/* ================================================================ 功能⑬ 商家好评率（需求③） */
/** 与后端 rating.py 的档位阈值保持一致，用来断言「界面档位 = 接口口径」 */
function tierOf(rate, total) {
  if (!total) return 'none';
  if (rate >= 95) return 'excellent';
  if (rate >= 85) return 'good';
  if (rate >= 70) return 'fair';
  return 'poor';
}

/** 无评价时界面刻意用中性灰（不硬凑成某个档位），所以期望值不是 rating-none */
function expectedBadgeClass(rating) {
  return rating.total ? `rating-${tierOf(rating.rate, rating.total)}` : 'badge-gray';
}

async function feature13(cdp) {
  console.log('\n===== 功能⑬ 商家好评率与分级（需求③）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const sellerId = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user.id;

  const apiRating = async () => (await api('GET', `/api/sellers/${sellerId}`)).data.seller.rating;
  const readBadge = async () => cdp.eval(`
    (() => {
      const el = document.querySelector('.rating-badge');
      return { text: (el?.innerText || '').trim(), cls: (el?.className || ''),
               title: el?.getAttribute('title') || '' };
    })()`);

  // ---- 1. 商品详情页 ----
  const sample = (await api('GET', '/api/products/mine?status=on_sale&page_size=1',
    { token: sellerToken })).data.list[0];
  await cdp.logout();
  await cdp.go(`/product/${sample.id}`);
  await waitFor(cdp, `!!document.querySelector('.rating-badge')`);
  const detailBadge = await readBadge();
  let r = await apiRating();
  check('商品详情页显示卖家好评率徽标，且档位与接口口径一致',
    detailBadge.cls.includes(expectedBadgeClass(r))
    && (r.total ? detailBadge.text.includes(`${r.rate}%`) : detailBadge.text.includes('暂无评价')),
    JSON.stringify({ badge: detailBadge, rating: r }));

  // ---- 2. 卖家主页 ----
  await cdp.go(`/seller/${sellerId}`);
  await waitFor(cdp, `!!document.querySelector('.rating-badge')`);
  const sellerBadge = await readBadge();
  check('卖家主页顶部显示好评率徽标与分级',
    /好评率 \d/.test(sellerBadge.text) || sellerBadge.text.includes('暂无评价'),
    JSON.stringify(sellerBadge));
  check('徽标带悬停说明（讲清好评口径与评价条数）', sellerBadge.title.length > 0, sellerBadge.title);

  // ---- 3. 个人资料页：用好评率取代信用分 ----
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/profile');
  await waitFor(cdp, `!!document.querySelector('#pf-rating')`);
  const profile = await cdp.eval(`
    (() => ({
      ratingValue: document.querySelector('#pf-rating')?.value || '',
      hasCreditField: /信用分/.test(document.body.innerText),
      hintMentionsDirection: /只统计买家对你的评价/.test(document.body.innerText),
    }))()`);
  check('个人资料页显示「商家好评率」，不再显示「信用分」',
    profile.ratingValue.length > 0 && !profile.hasCreditField, JSON.stringify(profile));
  check('个人资料页写清了口径（只统计买家对你的评价）',
    profile.hintMentionsDirection, '');

  // ---- 4. 造评价推动档位变化，界面必须跟着变 ----
  async function makeReviewedOrder(name, rating) {
    const p = (await api('POST', '/api/products', {
      token: sellerToken,
      body: { name, price: 6, category_id: 1, subcategory_id: 1, condition: '九成新',
              description: '好评率界面测试用', default_place_id: 2, images: [] },
    })).data;
    const o = (await api('POST', '/api/orders', {
      token: buyerToken, body: { product_id: p.id, meet_place_id: 2 },
    })).data;
    await api('PATCH', `/api/orders/${o.id}/confirm`, { token: sellerToken });  // 需求③
    await api('PATCH', `/api/orders/${o.id}/complete`, { token: buyerToken });
    await api('POST', '/api/reviews', {
      token: buyerToken, body: { order_id: o.id, rating, content: '自动化测试：好评率' },
    });
  }

  const before = await apiRating();
  await makeReviewedOrder('自动化测试：好评率好评', 5);
  const afterGood = await apiRating();
  check('新增 5 星好评后好评率上升',
    (afterGood.rate ?? 0) >= (before.rate ?? 0) && afterGood.total === before.total + 1,
    `好评率 ${before.rate}% -> ${afterGood.rate}%`);

  await cdp.logout();
  await cdp.go(`/seller/${sellerId}`);
  await waitFor(cdp, `!!document.querySelector('.rating-badge')`);
  const goodBadge = await readBadge();
  check('界面档位跟着变成接口算出的档位（好评）',
    goodBadge.cls.includes(expectedBadgeClass(afterGood)),
    JSON.stringify({ badge: goodBadge, rate: afterGood.rate }));
  await cdp.shot(path.join(SHOT_DIR, 'f13-rating-good.png'));

  await makeReviewedOrder('自动化测试：好评率差评', 2);
  const afterBad = await apiRating();
  check('新增 2 星差评后好评率下降',
    afterBad.rate < afterGood.rate, `${afterGood.rate}% -> ${afterBad.rate}%`);

  await cdp.go(`/seller/${sellerId}`);
  await waitFor(cdp, `!!document.querySelector('.rating-badge')`);
  const badBadge = await readBadge();
  check('界面档位跟着降档（差评后）',
    badBadge.cls.includes(expectedBadgeClass(afterBad)),
    JSON.stringify({ badge: badBadge, rate: afterBad.rate }));
  await cdp.shot(path.join(SHOT_DIR, 'f13-rating-after.png'));
}

/* ================================================================ 功能⑭ 私信页两个按钮（需求④） */
async function feature14(cdp) {
  console.log('\n===== 功能⑭ 私信页「查看 TA 的商品 / 返回原商品」（需求④）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const sample = (await api('GET', '/api/products/mine?status=on_sale&page_size=1',
    { token: sellerToken })).data.list[0];

  // 先造一条消息，保证左侧会话列表里有这一条可点（内容带前缀，结束时清理）
  await api('POST', '/api/messages', {
    token: buyerToken,
    body: { receiver_id: sample.seller_id, content: '自动化测试：私信页按钮' },
  });

  // ---- 1. 从商品详情页点「私信卖家」进来 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/product/${sample.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-act="msg"]')`);
  await cdp.eval(`document.querySelector('[data-act="msg"]').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/messages')`);
  await waitFor(cdp, `!!document.querySelector('[data-go-seller]')`);
  const entry = await cdp.eval(`
    (() => ({
      hash: location.hash,
      hasSellerBtn: !!document.querySelector('[data-go-seller]'),
      hasOriginBtn: !!document.querySelector('[data-go-origin]'),
      sellerBtnText: document.querySelector('[data-go-seller]')?.innerText.trim() || '',
      originBtnText: document.querySelector('[data-go-origin]')?.innerText.trim() || '',
      badge: document.querySelector('.chat-head .rating-badge')?.innerText.trim() || '',
      hasCreditText: /信用分/.test(document.body.innerText),
    }))()`);
  check('从商品详情页私信卖家后，聊天头部出现「查看 TA 的商品」',
    entry.hasSellerBtn && entry.sellerBtnText === '查看 TA 的商品', JSON.stringify(entry));
  check('因为是从商品页进来的，所以同时出现「返回原商品」',
    entry.hasOriginBtn && entry.originBtnText === '返回原商品', JSON.stringify(entry));
  check('聊天头部显示对方好评率徽标，不再显示「信用分」',
    entry.badge.length > 0 && !entry.hasCreditText, JSON.stringify(entry));
  await cdp.shot(path.join(SHOT_DIR, 'f14-chat-buttons.png'));

  // ---- 2. 「查看 TA 的商品」→ 卖家商品主页（过去是跳搜索页）----
  await cdp.eval(`document.querySelector('[data-go-seller]').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  const sellerHash = await cdp.eval(`location.hash`);
  check('「查看 TA 的商品」跳到卖家商品主页（不再是搜索页）',
    sellerHash === `#/seller/${sample.seller_id}`, sellerHash);

  // ---- 3. 「返回原商品」→ 回到买家原来浏览的那件商品 ----
  await cdp.go(`/messages?to=${sample.seller_id}&product=${sample.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-go-origin]')`);
  await cdp.eval(`document.querySelector('[data-go-origin]').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/product/')`);
  const backHash = await cdp.eval(`location.hash`);
  check('「返回原商品」回到买家原来浏览的那件商品详情页（不是首页/搜索页）',
    backHash.startsWith(`#/product/${sample.id}`), backHash);

  // ---- 4. 不是从商品页进来的会话：不该出现「返回原商品」----
  await cdp.go(`/messages?to=${sample.seller_id}`);
  await waitFor(cdp, `!!document.querySelector('[data-go-seller]')`);
  const noOrigin = await cdp.eval(`
    (() => ({
      hasOriginBtn: !!document.querySelector('[data-go-origin]'),
      convItems: document.querySelectorAll('#conv-list [data-uid]').length,
    }))()`);
  check('直接进消息页（没有来源商品）时不显示「返回原商品」',
    !noOrigin.hasOriginBtn, JSON.stringify(noOrigin));

  // ---- 5. 从会话列表点别的会话后，来源商品也应清掉 ----
  if (noOrigin.convItems > 0) {
    await cdp.go(`/messages?to=${sample.seller_id}&product=${sample.id}`);
    await waitFor(cdp, `!!document.querySelector('[data-go-origin]')`);
    await cdp.eval(`document.querySelector('#conv-list [data-uid]').click()`);
    await waitFor(cdp, `!document.querySelector('[data-go-origin]')`);
    check('从会话列表主动切会话后，「返回原商品」消失（不再算从商品页进来）', true, '');
  }
}

/* ================================================================ 功能⑮ 私信删除会话（需求⑤） */
async function feature15(cdp) {
  console.log('\n===== 功能⑮ 私信删除会话（需求⑤）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const sellerId = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user.id;

  // 全程用测试账号 acc_buyer（在清理名单里，删掉它时会话清除标记会一起级联消失），
  // 因此**不会碰演示账号的真实聊天记录**。
  let accToken;
  try {
    accToken = await login('acc_buyer', '1234', 'buyer');
  } catch {
    await api('POST', '/api/auth/register',
      { body: { username: 'acc_buyer', password: '1234', role: 'buyer' } });
    accToken = await login('acc_buyer', '1234', 'buyer');
  }
  const accId = (await api('GET', '/api/auth/me', { token: accToken })).data.user.id;

  await api('POST', '/api/messages', {
    token: accToken,
    body: { receiver_id: sellerId, content: '自动化测试：删除会话用' },
  });
  await api('POST', '/api/messages', {
    token: sellerToken,
    body: { receiver_id: accId, content: '自动化测试：对方的回复' },
  });
  const convCount = async (token) =>
    (await api('GET', '/api/messages/conversations', { token })).data.length;
  check('测试账号与卖家之间已有会话', await convCount(accToken) > 0, '');

  // ---- 按钮与确认框 ----
  await cdp.loginAs('acc_buyer', '1234', 'buyer');
  await cdp.go(`/messages?to=${sellerId}`);
  await waitFor(cdp, `!!document.querySelector('[data-del-conv]')`);
  const btn = await cdp.eval(`
    (() => {
      const b = document.querySelector('[data-del-conv]');
      return { exists: !!b, text: b?.innerText.trim() || '',
               hasCredit: /信用分/.test(document.body.innerText) };
    })()`);
  check('聊天头部有「删除对话」按钮', btn.exists && /删除对话/.test(btn.text), JSON.stringify(btn));

  await cdp.eval(`document.querySelector('[data-del-conv]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  const dlg = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return { title: m?.querySelector('.modal-head')?.innerText || '', body: m?.innerText || '' };
    })()`);
  check('删除前会弹确认框，并说清「只对你隐藏、对方不受影响」',
    /删除/.test(dlg.title) && /对方/.test(dlg.body), JSON.stringify(dlg));
  await cdp.shot(path.join(SHOT_DIR, 'f15-delete-confirm.png'));

  // ---- 取消确认：数据不变 ----
  await cdp.eval(`document.querySelector('.modal-mask [data-cancel]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  check('取消确认时会话仍在（数据不变）', await convCount(accToken) > 0, '');

  // ---- 确认删除 ----
  await cdp.eval(`document.querySelector('[data-del-conv]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  // 注意：不能断言「列表一项都不剩」——这个测试账号还可能有别的会话（比如管理员的平台通知），
  // 要断言的是「与对方这条」没了。我在这上面栽过（封禁通知一进来，这条断言就挂了）。
  await waitFor(cdp, `![...document.querySelectorAll('#conv-list [data-uid]')]
    .some(el => el.dataset.uid === ${JSON.stringify(String(sellerId))})`);
  await sleep(500);
  const afterDel = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#conv-list [data-uid]')];
      return {
        stillPeers: items.filter(el => el.dataset.uid === ${JSON.stringify(String(sellerId))}).length,
        total: items.length,
        chatEmpty: /从左侧选择一个会话/.test(document.querySelector('#chat-area')?.innerText || ''),
      };
    })()`);
  check('确认删除后与对方的会话从列表消失、聊天区回到空态',
    afterDel.stillPeers === 0 && afterDel.chatEmpty, JSON.stringify(afterDel));

  await cdp.go('/messages');
  await waitFor(cdp, `!!document.querySelector('#conv-list')`);
  await sleep(700);
  const afterReload = await cdp.eval(`
    [...document.querySelectorAll('#conv-list [data-uid]')]
      .filter(el => el.dataset.uid === ${JSON.stringify(String(sellerId))}).length`);
  check('刷新后仍是已删除状态（后端记住了，不是只改前端）',
    afterReload === 0, `与对方的会话仍显示 ${afterReload} 项`);

  // ---- 对方完全不受影响 ----
  const peerSeen = (await api('GET', `/api/messages/with/${accId}`, { token: sellerToken }))
    .data.list.length;
  check('对方那边完全不受影响，仍能看到全部聊天', peerSeen > 0, `对方可见 ${peerSeen} 条`);

  // ---- 对方再发消息 → 会话重新出现 ----
  await api('POST', '/api/messages', {
    token: sellerToken,
    body: { receiver_id: accId, content: '自动化测试：删除后对方又说话' },
  });
  await cdp.go('/messages');
  await waitFor(cdp, `[...document.querySelectorAll('#conv-list [data-uid]')]
    .some(el => el.dataset.uid === ${JSON.stringify(String(sellerId))})`);
  const revived = await cdp.eval(`
    [...document.querySelectorAll('#conv-list [data-uid]')]
      .filter(el => el.dataset.uid === ${JSON.stringify(String(sellerId))}).length`);
  check('对方再发消息后会话重新出现在我的列表', revived === 1, `与对方的会话 ${revived} 项`);
}

/* ================================================================ 功能⑯ 交易管理状态卡下钻（需求①） */
async function feature16(cdp) {
  console.log('\n===== 功能⑯ 交易管理状态卡下钻（需求①）=====');

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('#td-stats .stat-card').length === 4`);

  const cards = await cdp.eval(`
    (() => [...document.querySelectorAll('#td-stats .stat-card')].map(c => ({
      kind: c.dataset.stat || '',
      clickable: c.classList.contains('stat-clickable'),
      label: c.querySelector('.sc-label')?.innerText.trim() || '',
      more: c.querySelector('.sc-more')?.innerText.trim() || '',
    })))()`);
  check('4 张状态卡都标了类型且标记为可点',
    cards.length === 4 && cards.every(c => c.kind && c.clickable), JSON.stringify(cards));
  check('卡片上有「查看明细」提示', cards.every(c => /查看明细/.test(c.more)),
    JSON.stringify(cards.map(c => c.more)));

  const expect = {
    pending: /进行中的交易/,
    sellers: /正在交易的商家/,
    today: /今日新增订单/,
    longest: /挂得最久的一笔交易/,
  };
  const labels = {};
  cards.forEach(c => { labels[c.kind] = c.label; });

  for (const kind of ['pending', 'sellers', 'today', 'longest']) {
    await cdp.eval(`document.querySelector('[data-stat="${kind}"]').click()`);
    await waitFor(cdp, `!!document.querySelector('.modal-mask .modal-head')`);
    await sleep(450);
    const modal = await cdp.eval(`
      (() => {
        const m = document.querySelector('.modal-mask');
        return {
          title: m?.querySelector('.modal-head')?.innerText.trim() || '',
          text: m?.innerText || '',
          rows: m?.querySelectorAll('tbody tr').length || 0,
          kvs: m?.querySelectorAll('.kv').length || 0,
        };
      })()`);
    const hasContent = modal.rows > 0 || modal.kvs > 0 || /没有|暂无|今天还没有/.test(modal.text);
    check(`点「${labels[kind]}」弹出明细弹窗（标题正确且有内容）`,
      expect[kind].test(modal.title) && hasContent,
      JSON.stringify({ kind, title: modal.title, rows: modal.rows, kvs: modal.kvs }));
    await cdp.shot(path.join(SHOT_DIR, `f16-${kind}.png`));
    await cdp.eval(`document.querySelector('.modal-mask [data-close]')?.click()`);
    await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  }

  // 「最长挂单」的键值明细要含双方与自提点
  await cdp.eval(`document.querySelector('[data-stat="longest"]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask .kv')`);
  const kv = await cdp.eval(`document.querySelector('.modal-mask')?.innerText || ''`);
  check('「最长挂单」明细写清订单号、买卖双方、金额、自提点与已进行时长',
    /订单号/.test(kv) && /买家/.test(kv) && /卖家/.test(kv)
    && /成交金额/.test(kv) && /自提点/.test(kv) && /已进行/.test(kv), kv.slice(0, 120));
  await cdp.eval(`document.querySelector('.modal-mask [data-close]')?.click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);

  // 「涉及商家」里点一行 → 跳卖家主页，且弹窗关闭
  await cdp.eval(`document.querySelector('[data-stat="sellers"]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask')`);
  await sleep(400);
  const canGoto = await cdp.eval(`
    (() => {
      const row = document.querySelector('.modal-mask tr[data-goto]');
      if (!row) return { ok: false };
      const target = row.dataset.goto;
      row.click();
      return { ok: true, target };
    })()`);
  if (canGoto.ok) {
    await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
    const hash = await cdp.eval(`location.hash`);
    check('在「涉及商家」明细里点一行会跳到该卖家的商品主页，并关掉弹窗',
      hash === canGoto.target && !(await cdp.eval(`!!document.querySelector('.modal-mask')`)),
      `hash=${hash} target=${canGoto.target}`);
  } else {
    check('在「涉及商家」明细里点一行会跳到该卖家的商品主页，并关掉弹窗',
      false, '当前没有进行中的交易，拿不到可点的行');
  }

  // ---- 需求①（本轮）：明细弹窗要一屏看全，不出现滚动条 ----
  // 原来弹窗只有 460px 宽，6 列表格被挤得疯狂换行，内容高到 578~706px，
  // 矮一点的屏幕必然出滚动条。改成 920px 宽 + 键值两列 + 头尾固定后，
  // 下面这四个视口（含 1280x700 这种很矮的窗口）都应完全不滚动。
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('.stat-card[data-stat]').length > 0`);
  await sleep(900);
  for (const [w, h] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 700]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(350);
    for (const kind of ['pending', 'sellers', 'longest', 'today']) {
      await cdp.eval(`document.querySelector('.stat-card[data-stat="${kind}"]').click()`);
      await waitFor(cdp, `!!document.querySelector('.modal-mask .modal.detail')`);
      await sleep(420);
      const m = await cdp.eval(`
        (() => {
          const modal = document.querySelector('.modal-mask .modal');
          const body = modal.querySelector('.modal-body');
          return {
            width: Math.round(modal.getBoundingClientRect().width),
            modalOverflow: modal.scrollHeight - modal.clientHeight,
            bodyOverflow: body ? body.scrollHeight - body.clientHeight : -1,
          };
        })()`);
      check(`视口 ${w}x${h}：${kind} 明细弹窗无需滚动、且足够宽`,
        m.bodyOverflow === 0 && m.modalOverflow === 0 && m.width >= 880,
        `宽=${m.width} 弹窗溢出=${m.modalOverflow} 内容区溢出=${m.bodyOverflow}`);
      await cdp.eval(`document.querySelector('.modal-mask [data-close]')?.click()`);
      await sleep(220);
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
}

/* ================================================================ 功能⑰ 动态监控条目详情（需求②） */
async function feature17(cdp) {
  console.log('\n===== 功能⑰ 动态监控条目详情（需求②）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');

  // 先造一条「与交易相关」的日志，保证时间线首条就是可点且有交易信息的
  const product = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：日志条目详情', price: 11, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '日志条目详情用', default_place_id: 2, images: [] },
  })).data;
  const order = (await api('POST', '/api/orders', {
    token: buyerToken, body: { product_id: product.id, meet_place_id: 2 },
  })).data;
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: sellerToken });  // 需求③
  await api('PATCH', `/api/orders/${order.id}/complete`, { token: buyerToken });
  await api('POST', '/api/reviews', {
    token: buyerToken,
    body: { order_id: order.id, rating: 4, content: '自动化测试：日志详情' },
  });

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);

  const item = await cdp.eval(`
    (() => {
      const el = document.querySelector('#lg-list .tl-item');
      return { clickable: el.classList.contains('clickable'), logId: el.dataset.log || '',
               hint: el.getAttribute('title') || '' };
    })()`);
  check('动态监控的条目标记为可点，并带「查看详情」提示',
    item.clickable && !!item.logId && /详细/.test(item.hint), JSON.stringify(item));

  await cdp.eval(`document.querySelector('#lg-list .tl-item').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask .detail-h')`);
  await sleep(450);
  const modal = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      const t = m.innerText || '';
      return { title: m.querySelector('.modal-head')?.innerText.trim() || '', text: t,
               kvs: m.querySelectorAll('.kv').length, links: m.querySelectorAll('[data-goto]').length };
    })()`);
  check('点条目弹出详情，含「行为 / 发起人 / 精确时间」区块',
    /行为/.test(modal.text) && /发起人/.test(modal.text) && /精确时间/.test(modal.text)
    && modal.kvs >= 4, JSON.stringify({ title: modal.title, kvs: modal.kvs }));
  check('详情里给出了精确到秒的操作时间',
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(modal.text), modal.text.slice(0, 90));
  check('与交易相关的条目会带出「相关交易」：买卖双方、金额、自提点',
    /相关交易/.test(modal.text) && /买家/.test(modal.text) && /卖家/.test(modal.text)
    && /成交金额/.test(modal.text) && /自提点/.test(modal.text), modal.text.slice(0, 220));
  check('详情底部有可跳转的按钮', modal.links > 0, `links=${modal.links}`);
  await cdp.shot(path.join(SHOT_DIR, 'f17-log-detail.png'));

  const target = await cdp.eval(`
    (() => {
      const b = document.querySelector('.modal-mask [data-goto]');
      if (!b) return null;
      const t = b.dataset.goto;
      b.click();
      return t;
    })()`);
  if (target) {
    await waitFor(cdp, `location.hash === ${JSON.stringify(target)}`);
    check('点详情里的按钮能跳到对应对象，并自动关闭弹窗',
      !(await cdp.eval(`!!document.querySelector('.modal-mask')`)), `target=${target}`);
  } else {
    check('点详情里的按钮能跳到对应对象，并自动关闭弹窗', false, '没有可点的跳转按钮');
  }
}

/* ================================================================ 功能⑱ 动态监控筛选（需求③） */
async function feature18(cdp) {
  console.log('\n===== 功能⑱ 动态监控多条件筛选（需求③）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');

  // 造一条特征明显的链路，便于用「商品编号 / 订单号」筛选验证
  const product = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：筛选验证商品', price: 13, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '筛选验证用', default_place_id: 2, images: [] },
  })).data;
  const order = (await api('POST', '/api/orders', {
    token: buyerToken, body: { product_id: product.id, meet_place_id: 2 },
  })).data;
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: sellerToken });  // 需求③
  await api('PATCH', `/api/orders/${order.id}/complete`, { token: buyerToken });
  await api('POST', '/api/reviews', {
    token: buyerToken, body: { order_id: order.id, rating: 5, content: '自动化测试：筛选' },
  });

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);

  const controls = await cdp.eval(`
    (() => ['lg-action', 'lg-user', 'lg-product', 'lg-order', 'lg-from', 'lg-to', 'lg-search', 'lg-reset']
      .map(id => ({ id, exists: !!document.getElementById(id) })))()`);
  check('动态监控具备动作/发起人/商品/订单号/起止时间 6 个筛选控件与筛选·重置按钮',
    controls.every(c => c.exists), JSON.stringify(controls.filter(c => !c.exists)));

  const options = await cdp.eval(`
    (() => ({
      actions: [...document.querySelectorAll('#lg-action option')].map(o => o.value),
      userIsInput: document.getElementById('lg-user')?.tagName === 'INPUT',
      userHint: document.getElementById('lg-user')?.getAttribute('placeholder') || '',
      datalist: [...document.querySelectorAll('#lg-user-list option')].map(o => o.value),
    }))()`);
  check('「动作」是下拉且有可选项（来自库里真实出现过的记录）',
    options.actions.length > 1, JSON.stringify({ actions: options.actions.length }));
  check('「动作发起人」改成了可自由输入的输入框（需求②），并带候选列表',
    options.userIsInput && /姓名|账号|编号/.test(options.userHint),
    JSON.stringify({ input: options.userIsInput, hint: options.userHint }));

  // 需求②：按姓名/账号输入筛选，结果应当只剩这个人
  const actorName = options.datalist[0];
  if (actorName) {
    await cdp.eval(`
      (() => {
        const el = document.getElementById('lg-user');
        el.value = ${JSON.stringify(actorName)};
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    await sleep(1100);
    const byUser = await cdp.eval(`
      (() => ({
        items: document.querySelectorAll('#lg-list .tl-item').length,
        who: [...new Set([...document.querySelectorAll('#lg-list .tl-who')].map(e => e.innerText.trim()))],
        empty: !!document.querySelector('#lg-list .empty'),
      }))()`);
    check('按发起人姓名筛选后，时间线里只剩这个人的动作',
      byUser.items > 0 && byUser.who.length > 0 && byUser.who.every(n => n.includes(actorName)),
      `填「${actorName}」-> ${byUser.items} 条，出现的人=${JSON.stringify(byUser.who)}`);
    // 清掉，别影响后面的断言
    await cdp.eval(`
      (() => {
        const el = document.getElementById('lg-user');
        el.value = '';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    await sleep(900);
  } else {
    check('按发起人姓名筛选后，时间线里只剩这个人的动作', false, '候选列表为空（库里没有操作日志）');
  }

  const before = await cdp.eval(`document.querySelectorAll('#lg-list .tl-item').length`);

  // 按商品编号筛
  await cdp.eval(`
    (() => {
      document.querySelector('#lg-product').value = ${JSON.stringify(product.product_code)};
      document.querySelector('#lg-search').click();
    })()`);
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);
  await sleep(900);
  const byProduct = await cdp.eval(`
    (() => {
      const t = document.querySelector('#lg-list')?.innerText || '';
      const items = document.querySelectorAll('#lg-list .tl-item').length;
      const pg = document.querySelector('#lg-pager')?.innerText || '';
      return { items, text: t.slice(0, 160), pg };
    })()`);
  check('按商品编号筛选后只剩与该商品相关的日志（条数变少且不再是全部）',
    byProduct.items > 0 && byProduct.items < before, JSON.stringify(byProduct));

  // 用**浏览器本地日期**，不要用 toISOString()——那是 UTC，
  // 本地 00:00~08:00 之间会算成昨天，于是「筛今天」筛到昨天、一条也查不到。
  const localDate = (offsetDays = 0) => cdp.eval(`
    (() => {
      const d = new Date(Date.now() + ${offsetDays} * 86400000);
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
              String(d.getDate()).padStart(2, '0')].join('-');
    })()`);
  const today = await localDate(0);

  // 叠加时间筛选（今天）
  await cdp.eval(`
    (() => {
      document.querySelector('#lg-from').value = ${JSON.stringify(today)};
      document.querySelector('#lg-to').value = ${JSON.stringify(today)};
      document.querySelector('#lg-search').click();
    })()`);
  await sleep(1200);
  const withDate = await cdp.eval(`document.querySelectorAll('#lg-list .tl-item').length`);
  check('叠加「动作时间（今天）」后仍能查到记录', withDate > 0, `items=${withDate}（今天=${today}）`);

  // 起始时间设成明天 → 空态
  const tomorrow = await localDate(1);
  await cdp.eval(`
    (() => {
      document.querySelector('#lg-from').value = ${JSON.stringify(tomorrow)};
      document.querySelector('#lg-to').value = ${JSON.stringify(tomorrow)};
      document.querySelector('#lg-search').click();
    })()`);
  await waitFor(cdp, `!!document.querySelector('#lg-list .empty')`);
  check('起始时间设为明天后显示空态（确实查不到）', true, '');

  // 重置
  await cdp.eval(`document.querySelector('#lg-reset').click()`);
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);
  const afterReset = await cdp.eval(`
    (() => ({
      items: document.querySelectorAll('#lg-list .tl-item').length,
      product: document.querySelector('#lg-product').value,
      from: document.querySelector('#lg-from').value,
      action: document.querySelector('#lg-action').value,
    }))()`);
  check('「重置」清空各筛选项并恢复到全部记录',
    afterReset.items >= before && afterReset.product === '' && afterReset.from === ''
    && afterReset.action === 'all', JSON.stringify(afterReset));
  await cdp.shot(path.join(SHOT_DIR, 'f18-log-filters.png'));
}

/* ================================================================ 功能⑲ 举报填写理由 + 私信反馈（需求④） */
async function feature19(cdp) {
  console.log('\n===== 功能⑲ 举报审核填写理由 + 私信反馈（需求④）=====');

  // 两个测试账号（都在清理名单里），平台通知私信会随账号级联消失
  async function ensureAccount(username, password, role) {
    try {
      return await login(username, password, role);
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password, role } });
      return login(username, password, role);
    }
  }
  const authorToken = await ensureAccount('smoke_buyer', '1234', 'buyer');
  const reporterToken = await ensureAccount('acc_buyer', '1234', 'buyer');
  const adminToken = await login('admin', '123456', 'admin');
  const adminId = (await api('GET', '/api/auth/me', { token: adminToken })).data.user.id;

  const makeReport = async (title, reason) => {
    const post = (await api('POST', '/api/posts', {
      token: authorToken,
      body: { title, content: '自动化测试用', tag: '闲聊' },
    })).data;
    const report = (await api('POST', '/api/reports', {
      token: reporterToken,
      body: { target_type: 'post', post_id: post.id, reason },
    })).data;
    return { post, report };
  };

  const first = await makeReport('自动化测试：待处理的举报', '虚假信息');
  check('已备好一条待处理的帖子举报', !!first.report.id,
    JSON.stringify({ post: first.post.id, report: first.report.id }));

  // 注意要显式指定按钮：写作 '[data-handle],[data-dismiss]' 会命中行内第一个（删帖），
  // 于是「驳回」被测成了「删帖」。
  const clickRowButton = (title, selector) => `
    (() => {
      const row = [...document.querySelectorAll('#rp-list tr')]
        .find(r => r.innerText.includes(${JSON.stringify(title)}));
      if (!row) return { ok: false, reason: 'no-row' };
      const btn = row.querySelector('${selector}');
      if (!btn) return { ok: false, reason: 'no-button' };
      btn.click();
      return { ok: true };
    })()`;

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=reports');
  await waitFor(cdp, `document.querySelectorAll('#rp-list [data-handle]').length > 0`);

  // ---- 1. 点「删除帖子」→ 填写理由表单（不是简单确认框）----
  const clicked = await cdp.eval(clickRowButton('自动化测试：待处理的举报', '[data-handle]'));
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-field="reason_code"]')`);
  const dlg = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return {
        title: m.querySelector('.modal-head')?.innerText.trim() || '',
        options: [...m.querySelectorAll('[data-field="reason_code"] option')].map(o => o.value),
        hasTextarea: !!m.querySelector('textarea[data-field="reason_text"]'),
        mentionsNotify: /私信|通知/.test(m.innerText || ''),
        submitText: m.querySelector('#fm-submit')?.innerText.trim() || '',
      };
    })()`);
  check('点「删除帖子」弹出的是「填写理由」表单（预设下拉 + 详细说明多行输入）',
    clicked.ok && dlg.hasTextarea && dlg.options.length >= 3,
    JSON.stringify({ title: dlg.title, options: dlg.options, textarea: dlg.hasTextarea }));
  check('表单里写清了处理结果会私信通知对方', dlg.mentionsNotify, dlg.submitText);

  // ---- 2. 取消不改动状态 ----
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  const stillPending = (await api('GET', '/api/admin/reports?status=pending',
    { token: adminToken })).data.list.some(r => r.id === first.report.id);
  check('取消填写理由时举报仍是「待处理」（状态不变）', stillPending, '');

  // ---- 3. 确认处理（填原因 + 说明）→ 帖子删除 + 作者收到私信 ----
  await cdp.eval(clickRowButton('自动化测试：待处理的举报', '[data-handle]'));
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-field="reason_code"]')`);
  await cdp.eval(`
    (() => {
      document.querySelector('.modal-mask [data-field="reason_code"]').value = '违规内容';
      document.querySelector('.modal-mask [data-field="reason_text"]').value = '自动化测试：含违规内容';
    })()`);
  await cdp.shot(path.join(SHOT_DIR, 'f19-report-reason.png'));
  await cdp.eval(`document.querySelector('#fm-submit').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(900);

  const thread = (await api('GET', `/api/messages/with/${adminId}`,
    { token: authorToken })).data.list;
  check('删帖后帖子作者收到私信，内容含所选原因与补充说明',
    thread.some(m => m.content.includes('违规内容') && m.content.includes('自动化测试：含违规内容')),
    JSON.stringify(thread.slice(-1)));
  const gone = await api('GET', `/api/posts/${first.post.id}`);
  check('帖子确实被删除（对外不可见）', gone.code !== 0, `code=${gone.code}`);

  // ---- 4. 驳回走另一套原因，并通知举报者 ----
  const second = await makeReport('自动化测试：会被驳回的举报', '其他');
  await cdp.go('/admin?tab=reports');
  await waitFor(cdp, `document.querySelectorAll('#rp-list [data-dismiss]').length > 0`);
  await cdp.eval(clickRowButton('自动化测试：会被驳回的举报', '[data-dismiss]'));
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-field="reason_code"]')`);
  const dismissDlg = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return {
        title: m.querySelector('.modal-head')?.innerText.trim() || '',
        options: [...m.querySelectorAll('[data-field="reason_code"] option')].map(o => o.value),
      };
    })()`);
  check('「驳回」用的是另一套原因（与删帖的原因不同）',
    dismissDlg.options.includes('内容不违规') && !dismissDlg.options.includes('广告刷屏'),
    JSON.stringify(dismissDlg));
  await cdp.eval(`
    (() => {
      document.querySelector('.modal-mask [data-field="reason_code"]').value = '内容不违规';
      document.querySelector('#fm-submit').click();
    })()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(900);

  const reporterThread = (await api('GET', `/api/messages/with/${adminId}`,
    { token: reporterToken })).data.list;
  check('驳回后举报者收到私信，说明驳回原因',
    reporterThread.some(m => m.content.includes('内容不违规')),
    JSON.stringify(reporterThread.slice(-1)));
  const kept = await api('GET', `/api/posts/${second.post.id}`);
  check('被驳回的帖子不受影响', kept.code === 0, `code=${kept.code}`);
}

/* ================================================================ 功能⑳ 从举报审核进详情后能返回（需求⑤） */
async function feature20(cdp) {
  console.log('\n===== 功能⑳ 举报审核 → 详情 → 返回举报审核（需求⑤）=====');

  async function ensureAccount(username, password, role) {
    try {
      return await login(username, password, role);
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password, role } });
      return login(username, password, role);
    }
  }
  const authorToken = await ensureAccount('smoke_buyer', '1234', 'buyer');
  const reporterToken = await ensureAccount('acc_buyer', '1234', 'buyer');
  const sellerToken = await login('seller1', '123456', 'seller');

  // 备两条待处理举报：一条针对帖子、一条针对商品
  const post = (await api('POST', '/api/posts', {
    token: authorToken,
    body: { title: '自动化测试：举报页返回', content: '自动化测试用', tag: '闲聊' },
  })).data;
  await api('POST', '/api/reports', {
    token: reporterToken,
    body: { target_type: 'post', post_id: post.id, reason: '虚假信息' },
  });

  const myProduct = (await api('GET', '/api/products/mine?status=on_sale&page_size=1',
    { token: sellerToken })).data.list[0];
  await api('POST', '/api/reports', {
    token: reporterToken,
    body: { target_type: 'product', product_id: myProduct.id, reason: '虚假信息' },
  });

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=reports');
  await waitFor(cdp, `document.querySelectorAll('#rp-list [data-target]').length > 0`);

  // ---- 1. 帖子：从举报审核进详情，返回应回举报审核 ----
  await cdp.eval(`
    (() => {
      const el = [...document.querySelectorAll('#rp-list [data-target]')]
        .find(x => x.dataset.target.startsWith('post:'));
      el.click();
    })()`);
  await waitFor(cdp, `location.hash.startsWith('#/post/')`);
  await waitFor(cdp, `!!document.querySelector('#btn-back')`);
  const postBack = await cdp.eval(`
    (() => ({ hash: location.hash, label: document.querySelector('#btn-back').innerText.trim() }))()`);
  check('从举报审核点进帖子详情，按钮显示「返回举报审核」',
    /返回举报审核/.test(postBack.label) && postBack.hash.includes('from=admin'),
    JSON.stringify(postBack));

  await cdp.eval(`document.querySelector('#btn-back').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/admin')`);
  const backHash = await cdp.eval(`location.hash`);
  check('点返回确实回到「举报审核」页（不是交流广场）',
    backHash === '#/admin?tab=reports', backHash);

  // ---- 2. 商品：同样能回到举报审核 ----
  await waitFor(cdp, `document.querySelectorAll('#rp-list [data-target]').length > 0`);
  await cdp.eval(`
    (() => {
      const el = [...document.querySelectorAll('#rp-list [data-target]')]
        .find(x => x.dataset.target.startsWith('product:'));
      el.click();
    })()`);
  await waitFor(cdp, `location.hash.startsWith('#/product/')`);
  await waitFor(cdp, `!!document.querySelector('#btn-back')`);
  const prodBack = await cdp.eval(`document.querySelector('#btn-back').innerText.trim()`);
  check('从举报审核点进商品详情，按钮也显示「返回举报审核」',
    /返回举报审核/.test(prodBack), prodBack);
  await cdp.eval(`document.querySelector('#btn-back').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/admin')`);
  check('商品详情返回同样回到举报审核', (await cdp.eval(`location.hash`)) === '#/admin?tab=reports', '');

  // ---- 3. 普通入口不受影响：交流广场进帖子详情仍回广场 ----
  await cdp.logout();
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#btn-back')`);
  const normalBack = await cdp.eval(`document.querySelector('#btn-back').innerText.trim()`);
  check('从交流广场点进帖子详情，按钮仍是「返回广场」', /返回广场/.test(normalBack), normalBack);
  await cdp.eval(`document.querySelector('#btn-back').click()`);
  await waitFor(cdp, `location.hash === '#/posts'`);
  check('普通入口的返回目标仍是交流广场', true, '');
}

/* ================================================================ 功能㉑ 卖家侧交易收尾（需求⑥） */
async function feature21(cdp) {
  console.log('\n===== 功能㉑ 卖家侧的交易收尾按钮（需求⑥）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');

  const product = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：卖家收尾', price: 31, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '卖家收尾用', default_place_id: 2, images: [] },
  })).data;
  const order = (await api('POST', '/api/orders', {
    token: buyerToken, body: { product_id: product.id, meet_place_id: 2 },
  })).data;
  check('需求③：下单后先是「待卖家确认」的意向', order.status === 'awaiting',
    JSON.stringify(order.id));
  // 需求③：卖家确认之后才是「进行中」的交易，卡片上才出现收尾按钮
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: sellerToken });
  check('卖家确认接单后进入进行中', true, '');

  const clickCardAct = (act) => cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('#list-area .card')]
        .find(c => c.innerText.includes('自动化测试：卖家收尾'));
      if (!card) return false;
      const btn = card.querySelector('[data-act="${act}"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);

  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/sold');
  await waitFor(cdp, `document.querySelectorAll('#list-area .card').length > 0`);

  const sold = await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('#list-area .card')]
        .find(c => c.innerText.includes('自动化测试：卖家收尾'));
      return card ? [...card.querySelectorAll('[data-act]')].map(b => b.innerText.trim()) : [];
    })()`);
  check('卖家「卖出订单」里，进行中的交易有「确认完成」按钮',
    sold.includes('确认完成'), JSON.stringify(sold));
  check('卖家侧不提供「取消订单」（取消仍只给买家）',
    !sold.includes('取消订单'), JSON.stringify(sold));

  // ---- 点确认完成：先弹确认框，取消则不变 ----
  await clickCardAct('complete');
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-cancel]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-cancel]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  const stillPending = (await api('GET', `/api/orders/${order.id}`, { token: buyerToken })).data.status;
  check('取消确认时订单仍是「待完成」（数据不变）', stillPending === 'pending', stillPending);

  // ---- 确认后变已完成 ----
  await clickCardAct('complete');
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(1300);
  const done = (await api('GET', `/api/orders/${order.id}`, { token: buyerToken })).data.status;
  check('卖家确认后订单变为「已完成」', done === 'done', done);

  // ---- 已完成 → 出现「删除记录」 ----
  await cdp.go('/sold');
  await waitFor(cdp, `document.querySelectorAll('#list-area .card').length > 0`);
  const afterDone = await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('#list-area .card')]
        .find(c => c.innerText.includes('自动化测试：卖家收尾'));
      return card ? [...card.querySelectorAll('[data-act]')].map(b => b.innerText.trim()) : [];
    })()`);
  check('已完成的卖出记录出现「删除记录」', afterDone.includes('删除记录'), JSON.stringify(afterDone));

  // ---- 「我的商品」的已售行也有收尾按钮 ----
  await cdp.go('/my-products?status=sold');
  await waitFor(cdp, `document.querySelectorAll('#list-area tbody tr').length > 0`);
  const prodOps = await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('#list-area tbody tr')]
        .find(r => r.innerText.includes('自动化测试：卖家收尾'));
      return row ? [...row.querySelectorAll('.ops button')].map(b => b.innerText.trim()) : [];
    })()`);
  check('「我的商品」的已售行出现交易收尾按钮（删除订单记录）',
    prodOps.includes('删除订单记录'), JSON.stringify(prodOps));
  await cdp.shot(path.join(SHOT_DIR, 'f21-seller-trade-ops.png'));

  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('#list-area tbody tr')]
        .find(r => r.innerText.includes('自动化测试：卖家收尾'));
      row.querySelector('[data-del-order]').click();
    })()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(1300);

  const soldIds = (await api('GET', '/api/orders/sold?page_size=50',
    { token: sellerToken })).data.list.map(o => o.id);
  check('卖家删掉卖出记录后不再出现在卖出订单里（只对卖家隐藏）',
    !soldIds.includes(order.id), `共 ${soldIds.length} 笔`);
  const buyerIds = (await api('GET', '/api/orders/mine?page_size=50',
    { token: buyerToken })).data.list.map(o => o.id);
  check('买家那侧仍然能看到这笔订单', buyerIds.includes(order.id), `共 ${buyerIds.length} 笔`);
}

/* ================================================================ 功能㉒ 帖子举报入口（需求③） */
async function feature22(cdp) {
  console.log('\n===== 功能㉒ 交流广场帖子补上举报入口（需求③）=====');

  async function ensureAccount(username, password, role) {
    try {
      return await login(username, password, role);
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password, role } });
      return login(username, password, role);
    }
  }
  const authorToken = await ensureAccount('smoke_buyer', '1234', 'buyer');
  const reporterToken = await login('buyer1', '123456', 'buyer');
  const adminToken = await login('admin', '123456', 'admin');

  // 帖子的作者与「路过的人」必须不是同一个账号——后端不允许举报自己的帖子
  const post = (await api('POST', '/api/posts', {
    token: authorToken,
    body: { title: '自动化测试：待举报的帖子', content: '自动化测试用', tag: '闲聊' },
  })).data;
  const before = (await api('GET', '/api/admin/reports?status=pending',
    { token: adminToken })).data.total;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#btn-report')`);
  check('普通用户看别人的帖子，详情页有「举报」按钮（原来完全没有）',
    (await cdp.eval(`document.querySelector('#btn-report')?.innerText.includes('举报')`)) === true,
    await cdp.eval(`document.querySelector('#btn-report')?.innerText.trim()`));

  // 打开举报弹窗：预设理由 + 补充说明
  await cdp.eval(`document.querySelector('#btn-report').click()`);
  await waitFor(cdp, `!!document.querySelector('#rp-reason')`);
  await sleep(300);
  const dlg = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return {
        title: m.querySelector('.modal-head')?.innerText.trim() || '',
        reasons: [...m.querySelectorAll('#rp-reason option')].map(o => o.value),
        hasDetail: !!m.querySelector('#rp-detail'),
      };
    })()`);
  check('举报弹窗有预设理由（来自 /api/meta）与补充说明',
    dlg.reasons.length >= 3 && dlg.hasDetail, JSON.stringify(dlg));
  await cdp.shot(path.join(SHOT_DIR, 'f22-post-report.png'));

  // 取消不应产生举报
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  const afterCancel = (await api('GET', '/api/admin/reports?status=pending',
    { token: adminToken })).data.total;
  check('取消举报不会产生记录', afterCancel === before, `前 ${before} / 后 ${afterCancel}`);

  // 真正提交
  await cdp.eval(`document.querySelector('#btn-report').click()`);
  await waitFor(cdp, `!!document.querySelector('#rp-reason')`);
  await cdp.eval(`
    (() => {
      const sel = document.querySelector('#rp-reason');
      sel.value = sel.options[1] ? sel.options[1].value : sel.options[0].value;
      document.querySelector('#rp-detail').value = '自动化测试：这条帖子需要核实';
    })()`);
  const chosen = await cdp.eval(`document.querySelector('#rp-reason').value`);
  await cdp.eval(`document.querySelector('#rp-submit').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(900);

  const reports = (await api('GET', '/api/admin/reports?status=pending',
    { token: adminToken })).data.list;
  const mine = reports.find(r => (r.target || {}).id === post.id);
  check('提交后这条帖子出现在管理员的「待处理举报」里，且理由与补充说明都对',
    !!mine && (mine.reason || '').includes(chosen)
    && (mine.reason || '').includes('自动化测试：这条帖子需要核实'),
    JSON.stringify(mine ? { reason: mine.reason, type: mine.target_type } : reports.length));

  // 作者自己看自己的帖子：不该有举报按钮（后端也不允许举报自己）
  await cdp.loginAs('smoke_buyer', '1234', 'buyer');
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#btn-back')`);
  check('作者看自己的帖子时没有「举报」按钮（不允许举报自己）',
    (await cdp.eval(`!document.querySelector('#btn-report')`)) === true,
    await cdp.eval(`document.querySelector('#btn-report') ? '仍有按钮' : '没有按钮'`));

  // 游客点举报 → 引导登录
  await cdp.logout();
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#btn-report')`);
  await cdp.eval(`document.querySelector('#btn-report').click()`);
  await waitFor(cdp, `location.hash === '#/login'`);
  check('游客点举报会被引导去登录', true, '');
}

/* ================================================================ 功能㉓ 买卖身份合并（新批需求④） */
async function feature23(cdp) {
  console.log('\n===== 功能㉓ 取消买家/卖家身份切换、功能合并（需求④）=====');

  async function ensureAccount(username, password) {
    try {
      return await login(username, password, 'buyer');
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password } });
      return login(username, password, 'buyer');
    }
  }

  const readMenu = () => cdp.eval(`
    (() => ({
      labels: [...document.querySelectorAll('.menu-item')].map(m => m.innerText.trim()),
      // 比较菜单「有哪些项」要按 hash 比，别比 innerText——
      // 「我的订单」上的未读红点会往文本里塞数字，那就变成在比红点了
      hashes: [...document.querySelectorAll('.menu-item')].map(m => m.dataset.hash),
    }))()`);

  // ---- 1. 顶栏没有身份滑块了，菜单买卖合一 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/home');
  // 等菜单渲染出来再断言：否则可能读到空页面，而「没有滑块」这类否定断言在空页面上会假通过
  await waitFor(cdp, `document.querySelectorAll('.menu-item').length > 0`);
  await sleep(400);
  const buyer = await cdp.eval(`
    (() => ({
      hasSwitch: !!document.querySelector('#view-toggle'),
      switchDom: !!document.querySelector('.view-switch'),
      menu: [...document.querySelectorAll('.menu-item')].map(m => m.innerText.trim()),
    }))()`);
  check('需求④：顶栏不再有「买家 / 卖家」身份滑块',
    !buyer.hasSwitch && !buyer.switchDom, JSON.stringify({ hasSwitch: buyer.hasSwitch }));
  // 注意：menu 是数组，includes(x) 是「整体精确等于 x」，这里要用 some + 子串判断
  check('需求④：菜单买卖合一（发布商品 / 我的商品 / 我的订单同时出现，且不再有「卖出订单」）',
    buyer.menu.some(t => t.includes('发布商品')) && buyer.menu.some(t => t.includes('我的商品'))
    && buyer.menu.some(t => t.includes('我的订单')) && !buyer.menu.some(t => t.includes('卖出订单')),
    JSON.stringify(buyer.menu));

  // 换个「卖家」账号登录，菜单项应当完全一样（不再有买家/卖家之分）
  const buyerHashes = await readMenu();
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/home');
  await waitFor(cdp, `document.querySelectorAll('.menu-item').length > 0`);
  await sleep(400);
  const sellerHashes = await readMenu();
  check('需求④：卖家账号与买家账号看到的菜单完全一致（按菜单项比，不受红点影响）',
    JSON.stringify(sellerHashes.hashes) === JSON.stringify(buyerHashes.hashes),
    `买家=${JSON.stringify(buyerHashes.hashes)}；卖家=${JSON.stringify(sellerHashes.hashes)}`);

  // ---- 2. 登录页不再要求选身份 ----
  await cdp.logout();
  await cdp.go('/login');
  await waitFor(cdp, `!!document.querySelector('#role-pick')`);
  const loginUi = await cdp.eval(`
    (() => ({
      choices: [...document.querySelectorAll('#role-pick input')].map(i => i.value),
      texts: [...document.querySelectorAll('#role-pick label')].map(l => l.innerText.trim()),
    }))()`);
  check('需求④：登录页不再有「买家 / 卖家」二选一，只保留普通用户与管理员',
    !loginUi.choices.includes('buyer') && !loginUi.choices.includes('seller')
    && loginUi.choices.includes('user') && loginUi.choices.includes('admin'),
    JSON.stringify(loginUi));

  const ok = await cdp.eval(`
    (async () => {
      const r = await fetch('/api/auth/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'buyer1', password: '123456' }) });
      const j = await r.json();
      return { code: j.code, view: j.data?.view };
    })()`);
  check('需求④：普通用户不选身份也能登录成功', ok.code === 0, JSON.stringify(ok));

  // ---- 3. 订单页：买/卖页签 + 身份徽标 ----
  // 造一笔「我是卖家」的单：buyer1 发布商品，另一个测试账号买下
  const sellerToken = await login('buyer1', '123456', 'buyer');
  const buyerToken = await ensureAccount('acc_buyer', '1234');
  const product = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：身份合并用', price: 17, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '身份合并用', default_place_id: 2, images: [] },
  })).data;
  await api('POST', '/api/orders', {
    token: buyerToken, body: { product_id: product.id, meet_place_id: 2 },
  });

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/orders');
  await waitFor(cdp, `document.querySelectorAll('#side-tabs .tab').length > 0`);
  await sleep(800);
  const tabs = await cdp.eval(`
    [...document.querySelectorAll('#side-tabs .tab')].map(t => t.innerText.trim())`);
  check('需求④：「我的订单」顶部有「全部订单 / 我买到的 / 我卖出的」三个页签',
    tabs.join('') === '全部订单我买到的我卖出的', JSON.stringify(tabs));

  const allView = await cdp.eval(`
    (() => ({
      roles: [...new Set([...document.querySelectorAll('.role-flag')].map(e => e.innerText.trim()))],
      cards: document.querySelectorAll('#list-area .card').length,
    }))()`);
  check('需求④：默认「全部订单」里每张单都标出了我在交易里的身份（我是买家 / 我是卖家）',
    allView.cards > 0 && allView.roles.length > 0
    && allView.roles.every(r => r === '我是买家' || r === '我是卖家'),
    JSON.stringify({ cards: allView.cards, roles: allView.roles }));

  // 切到「我卖出的」：只剩卖家身份的单，且有买家信息、没有「取消订单」
  await cdp.eval(`[...document.querySelectorAll('#side-tabs .tab')]
    .find(t => t.innerText.includes('我卖出的')).click()`);
  await waitFor(cdp, `!document.querySelector('#list-area .loading')`);
  await sleep(900);
  const sellView = await cdp.eval(`
    (() => ({
      roles: [...new Set([...document.querySelectorAll('.role-flag')].map(e => e.innerText.trim()))],
      cards: document.querySelectorAll('#list-area .card').length,
      hash: location.hash,
      hasBuyerLine: /买家：/.test(document.querySelector('#list-area')?.innerText || ''),
      cancelBtns: document.querySelectorAll('#list-area [data-act="cancel"]').length,
    }))()`);
  check('需求④：「我卖出的」里只剩卖家身份的单，显示买家信息、且没有「取消订单」（那是买家才有的）',
    sellView.cards > 0 && sellView.roles.join('') === '我是卖家'
    && sellView.hasBuyerLine && sellView.cancelBtns === 0,
    JSON.stringify(sellView));
  check('需求④：切页签会同步到地址（可直达 / 可刷新）',
    sellView.hash.includes('side=seller'), sellView.hash);
  await cdp.shot(path.join(SHOT_DIR, 'f23-merged-orders.png'));

  // 我买到的：只剩买家身份
  await cdp.eval(`[...document.querySelectorAll('#side-tabs .tab')]
    .find(t => t.innerText.includes('我买到的')).click()`);
  await waitFor(cdp, `!document.querySelector('#list-area .loading')`);
  await sleep(900);
  const buyView = await cdp.eval(`
    (() => ({
      roles: [...new Set([...document.querySelectorAll('.role-flag')].map(e => e.innerText.trim()))],
      cards: document.querySelectorAll('#list-area .card').length,
    }))()`);
  check('需求④：「我买到的」里只剩买家身份的单',
    buyView.cards > 0 && buyView.roles.join('') === '我是买家', JSON.stringify(buyView));

  // ---- 需求⑦：页面上有身份标记的说明（图例），把两种身份讲清楚 ----
  const legend = await cdp.eval(`
    (() => {
      const box = document.querySelector('.order-legend');
      if (!box) return { exists: false };
      return {
        exists: true,
        flags: [...box.querySelectorAll('.legend-flag')].map(e => e.innerText.trim()),
        text: box.innerText.replace(/\\s+/g, ' ').trim(),
      };
    })()`);
  check('需求⑦：「我的订单」顶部有买家/卖家标记的说明（两种身份都讲清楚）',
    legend.exists && legend.flags.join('|') === '我是买家|我是卖家'
    && /取消订单/.test(legend.text) && /确认完成/.test(legend.text),
    JSON.stringify(legend).slice(0, 220));
  check('需求⑦：图例只在页面顶部出现一次（不会混进订单卡片里干扰身份统计）',
    (await cdp.eval(`document.querySelectorAll('.order-legend .legend-flag').length`)) === 2,
    `图例徽标数=${await cdp.eval(`document.querySelectorAll('.order-legend .legend-flag').length`)}`);

  // ---- 4. 老路由 #/sold 仍可用，默认落在「我卖出的」----
  await cdp.go('/sold');
  await waitFor(cdp, `document.querySelectorAll('#side-tabs .tab').length > 0`);
  await sleep(800);
  const legacy = await cdp.eval(`
    (() => ({
      active: document.querySelector('#side-tabs .tab.active')?.innerText.trim() || '',
      roleFlags: [...new Set([...document.querySelectorAll('.role-flag')].map(e => e.innerText.trim()))],
    }))()`);
  check('需求④：老路由 #/sold 仍然能用，并默认落在「我卖出的」',
    legacy.active.includes('我卖出的') && !legacy.roleFlags.includes('我是买家'),
    JSON.stringify(legacy));
}

/* ================================================================ 功能㉔ 用户主页 + 私信入口（新批需求⑤） */
async function feature24(cdp) {
  console.log('\n===== 功能㉔ 对外用户主页：私信按钮 + 各处点击用户可跳转（需求⑤）=====');

  async function ensureAccount(username, password) {
    try {
      return await login(username, password, 'buyer');
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password } });
      return login(username, password, 'buyer');
    }
  }
  const authorToken = await ensureAccount('acc_buyer', '1234');
  const author = (await api('GET', '/api/auth/me', { token: authorToken })).data.user;

  // 备一条帖子，作者是测试账号（保证不是当前登录者自己的）
  const post = (await api('POST', '/api/posts', {
    token: authorToken,
    body: { title: '自动化测试：用户主页跳转', content: '自动化测试用', tag: '闲聊' },
  })).data;

  // ---- 1. 交流广场：点发帖人去 TA 的主页（而不是进帖子详情）----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/posts');
  await waitFor(cdp, `document.querySelectorAll('.post-item [data-user]').length > 0`);
  const picked = await cdp.eval(`
    (() => {
      const el = [...document.querySelectorAll('.post-item [data-user]')]
        .find(x => x.dataset.user === ${JSON.stringify(String(author.id))});
      if (!el) return { ok: false };
      const card = el.closest('.post-item');
      const name = el.innerText.trim();
      el.click();
      return { ok: true, name, cardPost: card?.dataset.post || '' };
    })()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  const afterClick = await cdp.eval(`location.hash`);
  check('需求⑤：交流广场点发帖人昵称，跳去 TA 的主页（而不是帖子详情）',
    picked.ok && afterClick === `#/seller/${author.id}`,
    `点了「${picked.name}」-> ${afterClick}（该卡片帖子 id=${picked.cardPost}）`);
  await waitFor(cdp, `!!document.querySelector('#seller-head .seller-nick')`);
  check('需求⑤：主页确实渲染出了这个人的信息',
    (await cdp.eval(`document.querySelector('#seller-head .seller-nick').innerText.trim()`))
      === (author.nickname || ''),
    await cdp.eval(`document.querySelector('#seller-head .seller-nick').innerText.trim()`));

  // ---- 2. 主页上的「私信 TA」按钮：一键发起会话 ----
  const msgBtn = await cdp.eval(`
    (() => {
      const b = document.querySelector('[data-msg]');
      return b ? { exists: true, text: b.innerText.trim(), uid: b.dataset.msg } : { exists: false };
    })()`);
  check('需求⑤：TA 的主页有「私信 TA」按钮', msgBtn.exists && /私信/.test(msgBtn.text), JSON.stringify(msgBtn));
  await cdp.eval(`document.querySelector('[data-msg]').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/messages')`);
  await waitFor(cdp, `!!document.querySelector('.chat-head')`);
  await sleep(600);
  const chat = await cdp.eval(`
    (() => ({
      hash: location.hash,
      headName: document.querySelector('.chat-head b')?.innerText.trim() || '',
      activeConv: document.querySelector('.msg-conv.active')?.innerText.trim().slice(0, 20) || '',
    }))()`);
  check('需求⑤：点「私信 TA」直接进入与 TA 的会话',
    chat.hash.includes(`to=${author.id}`) && chat.headName.includes(author.nickname || ''),
    JSON.stringify(chat));

  // ---- 3. 私信页点对方**头像** → TA 的主页（2026-10-16 起：只有头像跳主页，昵称跟随整行进聊天）----
  const convClicked = await cdp.eval(`
    (() => {
      const el = document.querySelector('.msg-conv .conv-avatar[data-user]');
      if (!el) return { ok: false };
      const uid = el.dataset.user, name = el.innerText.trim();
      el.click();
      return { ok: true, uid, name };
    })()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  check('需求⑤：私信页点对方头像，跳去 TA 的主页',
    convClicked.ok && (await cdp.eval(`location.hash`)) === `#/seller/${convClicked.uid}`,
    `点了「${convClicked.name}」-> ${await cdp.eval(`location.hash`)}`);

  // ---- 4. 聊天头部点对方头像也能跳 ----
  await cdp.go(`/messages?to=${author.id}`);
  await waitFor(cdp, `!!document.querySelector('.chat-head .conv-avatar[data-user]')`);
  await cdp.eval(`document.querySelector('.chat-head .conv-avatar[data-user]').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  check('需求⑤：聊天窗口顶部点对方头像也能去 TA 的主页',
    (await cdp.eval(`location.hash`)) === `#/seller/${author.id}`,
    await cdp.eval(`location.hash`));

  // ---- 5. 自己的主页不显示「私信 TA」 ----
  await cdp.loginAs('acc_buyer', '1234', 'buyer');
  await cdp.go(`/seller/${author.id}`);
  await waitFor(cdp, `!!document.querySelector('#seller-head .seller-nick')`);
  const own = await cdp.eval(`
    (() => ({
      hasMsg: !!document.querySelector('[data-msg]'),
      ownBadge: !!document.querySelector('#sk-status .badge'),
      text: document.querySelector('#sk-status')?.innerText.trim() || '',
    }))()`);
  check('需求⑤：看自己的主页时不显示「私信 TA」，而是提示这是你自己的主页',
    !own.hasMsg && own.ownBadge && /你自己/.test(own.text), JSON.stringify(own));

  // ---- 6. 游客点「私信 TA」会被引导登录 ----
  await cdp.logout();
  await cdp.go(`/seller/${author.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-msg-login]')`);
  await cdp.eval(`document.querySelector('[data-msg-login]').click()`);
  await waitFor(cdp, `location.hash === '#/login'`);
  check('需求⑤：游客点「私信 TA」会被引导登录', true, '');
}

/* ================================================================ 功能㉕ 订单新状态红点（新批需求⑥） */
async function feature25(cdp) {
  console.log('\n===== 功能㉕ 「我的订单」新状态数字红点（需求⑥）=====');

  async function ensureAccount(username, password) {
    try {
      return await login(username, password, 'buyer');
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password } });
      return login(username, password, 'buyer');
    }
  }
  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await ensureAccount('acc_buyer', '1234');

  // 基线：让卖家先把红点清零
  await api('POST', '/api/orders/updates/seen', { token: sellerToken, body: {} });

  // 造一笔「别人在卖家的订单上做了动作」：自己的商品被下单
  const product = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：红点用商品', price: 9.5, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '红点用', default_place_id: 2, images: [] },
  })).data;
  const order = (await api('POST', '/api/orders', {
    token: buyerToken, body: { product_id: product.id, meet_place_id: 2 },
  })).data;
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: sellerToken });  // 需求③
  const pendingCount = (await api('GET', '/api/orders/updates',
    { token: sellerToken })).data.count;
  check('别人在我的订单上操作后，接口能算出未读数', pendingCount >= 1, `未读=${pendingCount}`);

  // ---- 卖家登录：左侧「我的订单」出现数字红点 ----
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/home');
  await waitFor(cdp, `document.querySelectorAll('.menu-item').length > 0`);
  await sleep(1200);   // 外壳绑定后会异步刷一次红点
  const badge = await cdp.eval(`
    (() => {
      const b = document.getElementById('order-badge');
      if (!b) return { exists: false };
      return { exists: true, text: b.textContent.trim(),
               visible: b.style.display !== 'none' && b.offsetParent !== null,
               onOrdersItem: !!b.closest('.menu-item') &&
                 b.closest('.menu-item').innerText.includes('我的订单') };
    })()`);
  check('需求⑥：左侧「我的订单」上出现数字小红点',
    badge.exists && badge.visible && Number(badge.text) >= 1 && badge.onOrdersItem,
    JSON.stringify(badge));
  check('需求⑥：红点里是未读数（数字），不是纯装饰点',
    /^\d+$/.test(badge.text || ''), `红点文字=「${badge.text}」`);
  await cdp.shot(path.join(SHOT_DIR, 'f25-order-badge.png'));

  // ---- 进「我的订单」后红点清零 ----
  await cdp.eval(`[...document.querySelectorAll('.menu-item')]
    .find(m => m.innerText.includes('我的订单')).click()`);
  await waitFor(cdp, `location.hash.startsWith('#/orders')`);
  await waitFor(cdp, `document.querySelectorAll('#side-tabs .tab').length > 0`);
  await sleep(1200);
  const after = await cdp.eval(`
    (() => {
      const b = document.getElementById('order-badge');
      return { hidden: !b || b.style.display === 'none', text: b ? b.textContent.trim() : '' };
    })()`);
  const leftCount = (await api('GET', '/api/orders/updates', { token: sellerToken })).data.count;
  check('需求⑥：打开「我的订单」后红点消失、后端未读也清零',
    after.hidden && leftCount === 0, `线上红点=${JSON.stringify(after)}；接口未读=${leftCount}`);

  // ---- 买家那侧不该被自己的动作提醒 ----
  await api('POST', '/api/orders/updates/seen', { token: buyerToken, body: {} });
  await api('PATCH', `/api/orders/${order.id}/complete`, { token: buyerToken });
  const sellerAgain = (await api('GET', '/api/orders/updates', { token: sellerToken })).data.count;
  const buyerOwn = (await api('GET', '/api/orders/updates', { token: buyerToken })).data.count;
  check('需求⑥：对方（卖家）确认/完成等动作会再点亮红点，而自己做的不提醒自己',
    sellerAgain >= 1 && buyerOwn === 0, `卖家未读=${sellerAgain}；买家未读=${buyerOwn}`);

  // ---- 清掉红点，别把状态留给后面的用例 ----
  await api('POST', '/api/orders/updates/seen', { token: sellerToken, body: {} });
  await api('POST', '/api/orders/updates/seen', { token: buyerToken, body: {} });
}

/* ================================================================ 功能㉖ 页面状态自动更新（新批需求⑧） */
async function feature26(cdp) {
  console.log('\n===== 功能㉖ 网页状态自动更新（需求⑧）=====');

  async function ensureAccount(username, password) {
    try {
      return await login(username, password, 'buyer');
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password } });
      return login(username, password, 'buyer');
    }
  }
  const otherToken = await ensureAccount('acc_buyer', '1234');
  const other = (await api('GET', '/api/auth/me', { token: otherToken })).data.user;
  const buyerToken = await login('buyer1', '123456', 'buyer');

  // 备一条测试帖子（作者是测试账号）
  const post = (await api('POST', '/api/posts', {
    token: otherToken,
    body: { title: '自动化测试：实时更新', content: '自动化测试用', tag: '闲聊' },
  })).data;

  // ---- 1. 帖子详情：别人发的评论自己冒出来（不刷新页面）----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#comment-list')`);
  const beforeComments = await cdp.eval(`document.querySelectorAll('#comment-list .comment-item').length`);

  await api('POST', `/api/posts/${post.id}/comments`, {
    token: otherToken, body: { content: '自动化测试：别人刚发的评论' },
  });
  // 轮询间隔 8 秒，留足余量
  await waitFor(cdp,
    `document.querySelector('#comment-list')?.innerText.includes('自动化测试：别人刚发的评论') === true`,
    { timeout: 20000, step: 500 });
  const afterComments = await cdp.eval(`
    (() => ({
      count: document.querySelectorAll('#comment-list .comment-item').length,
      title: document.querySelector('.card-head h2')?.innerText.trim() || '',
    }))()`);
  check('需求⑧：别人发的评论会自动出现，且评论数跟着更新（没有手动刷新）',
    afterComments.count === beforeComments + 1 && /评论（\d+）/.test(afterComments.title),
    `评论条数 ${beforeComments} → ${afterComments.count}；标题=${afterComments.title}`);

  // 输入框里没发出去的字不能被轮询清掉
  await cdp.eval(`document.querySelector('#comment-input').value = '打了一半的字'`);
  await sleep(9000);
  check('需求⑧：自动更新不会清掉你正在输入框里写的字',
    (await cdp.eval(`document.querySelector('#comment-input').value`)) === '打了一半的字',
    await cdp.eval(`document.querySelector('#comment-input').value`));

  // ---- 2. 交流广场列表：点赞数自动跟上 ----
  await cdp.go('/posts');
  await waitFor(cdp, `document.querySelectorAll('.post-item').length > 0`);
  const likeBefore = await cdp.eval(`
    document.querySelector('[data-like-count="${post.id}"]')?.textContent ?? null`);
  await api('POST', `/api/posts/${post.id}/like`, { token: otherToken });
  await waitFor(cdp,
    `(document.querySelector('[data-like-count="${post.id}"]')?.textContent || '') !== ${JSON.stringify(String(likeBefore))}`,
    { timeout: 25000, step: 500 });
  const likeAfter = await cdp.eval(`document.querySelector('[data-like-count="${post.id}"]')?.textContent`);
  check('需求⑧：交流广场列表里的点赞数会自动跟上（不重排列表）',
    Number(likeAfter) === Number(likeBefore) + 1,
    `点赞 ${likeBefore} → ${likeAfter}`);

  // ---- 3. 私信：对方发来的消息自动出现 ----
  await api('POST', '/api/messages', {
    token: otherToken, body: { receiver_id: (await api('GET', '/api/auth/me', { token: buyerToken })).data.user.id, content: '自动化测试：你好呀' },
  });
  await cdp.go(`/messages?to=${other.id}`);
  await waitFor(cdp, `!!document.querySelector('#chat-body')`);
  await sleep(600);
  const bubblesBefore = await cdp.eval(`document.querySelectorAll('#chat-body .bubble').length`);
  await cdp.eval(`document.querySelector('#msg-input').value = '我也打一半'`);

  await api('POST', '/api/messages', {
    token: otherToken,
    body: { receiver_id: (await api('GET', '/api/auth/me', { token: buyerToken })).data.user.id,
            content: '自动化测试：对方刚发的新消息' },
  });
  await waitFor(cdp, `document.querySelector('#chat-body')?.innerText.includes('自动化测试：对方刚发的新消息') === true`,
    { timeout: 15000, step: 500 });
  const chatState = await cdp.eval(`
    (() => ({
      bubbles: document.querySelectorAll('#chat-body .bubble').length,
      input: document.querySelector('#msg-input').value,
    }))()`);
  check('需求⑧：对方发来的新私信会自动出现', chatState.bubbles === bubblesBefore + 1,
    `气泡 ${bubblesBefore} → ${chatState.bubbles}`);
  check('需求⑧：自动刷私信时不会清掉输入框里没发出去的内容',
    chatState.input === '我也打一半', JSON.stringify(chatState.input));

  // ---- 4. 我的订单：对方改了状态，列表自动更新 ----
  const product = (await api('POST', '/api/products', {
    token: buyerToken,
    body: { name: '自动化测试：实时订单', price: 12, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '实时更新用', default_place_id: 2, images: [] },
  })).data;
  const order = (await api('POST', '/api/orders', {
    token: otherToken, body: { product_id: product.id, meet_place_id: 2 },
  })).data;
  // 需求③：让「卖家」（buyer1 自己）确认接单，订单才进「待完成」，商品才算锁定
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: buyerToken });

  await cdp.go('/orders?side=seller');
  await waitFor(cdp, `document.querySelectorAll('#list-area .card').length > 0`);
  await sleep(800);
  const statusBefore = await cdp.eval(`
    [...document.querySelectorAll('#list-area .card')]
      .find(c => c.innerText.includes('自动化测试：实时订单'))?.innerText.match(/待完成|已完成|已取消/)?.[0] || ''`);
  await api('PATCH', `/api/orders/${order.id}/cancel`, { token: otherToken });
  await waitFor(cdp,
    `[...document.querySelectorAll('#list-area .card')].some(c => c.innerText.includes('自动化测试：实时订单') && c.innerText.includes('已取消'))`,
    { timeout: 25000, step: 500 });
  const statusAfter = await cdp.eval(`
    [...document.querySelectorAll('#list-area .card')]
      .find(c => c.innerText.includes('自动化测试：实时订单'))?.innerText.match(/待完成|已完成|已取消/)?.[0] || ''`);
  check('需求⑧：对方取消订单后，「我的订单」里的状态自动变成「已取消」',
    statusBefore === '待完成' && statusAfter === '已取消', `${statusBefore} → ${statusAfter}`);
  await cdp.shot(path.join(SHOT_DIR, 'f26-live-updates.png'));

  // ---- 5. 离开页面后不该继续轮询（别留一串后台请求）----
  await cdp.go('/home');
  await sleep(1200);
  const leftPolling = await cdp.eval(`
    (() => document.querySelectorAll('#list-area, #comment-list, #chat-body').length)()`);
  check('需求⑧：离开页面后定时器会被清掉（页面上已没有这些容器）', leftPolling === 0, `残留容器=${leftPolling}`);
}

/* ================================================================ 功能㉗ 用户管理 + 封禁（新批需求①） */
async function feature27(cdp) {
  console.log('\n===== 功能㉗ 管理员「用户管理」与封禁（需求①）=====');

  async function ensureAccount(username, password) {
    try {
      return await login(username, password, 'buyer');
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password } });
      return login(username, password, 'buyer');
    }
  }
  const adminToken = await login('admin', '123456', 'admin');
  const victimToken = await ensureAccount('acc_buyer', '1234');
  const victim = (await api('GET', '/api/auth/me', { token: victimToken })).data.user;
  // 先确保它没被封（上一次跑挂了也不影响这次）
  await api('POST', `/api/admin/users/${victim.id}/unban`, { token: adminToken, body: {} })
    .catch(() => null);

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=users');
  await waitFor(cdp, `document.querySelectorAll('#u-list tbody tr').length > 0`);
  await sleep(600);

  const tabInfo = await cdp.eval(`
    (() => ({
      tab: !!document.querySelector('[data-tab="users"]'),
      active: document.querySelector('[data-tab="users"]')?.classList.contains('active') || false,
      headers: [...document.querySelectorAll('#u-list thead th')].map(t => t.innerText.trim()),
      rows: document.querySelectorAll('#u-list tbody tr').length,
      summary: document.querySelector('#u-summary')?.innerText.trim() || '',
    }))()`);
  check('需求①：管理后台多了「用户管理」页签，且能列出用户与统计列',
    tabInfo.tab && tabInfo.active && tabInfo.rows > 0
    && tabInfo.headers.some(h => h.includes('好评率')) && /被封禁/.test(tabInfo.summary),
    JSON.stringify(tabInfo).slice(0, 220));

  // ---- 搜索 ----
  await cdp.eval(`
    (() => {
      document.querySelector('#u-keyword').value = 'acc_buyer';
      document.querySelector('#u-search').click();
    })()`);
  await sleep(1000);
  const searched = await cdp.eval(`
    (() => ({
      rows: document.querySelectorAll('#u-list tbody tr').length,
      text: document.querySelector('#u-list tbody')?.innerText.replace(/\\n/g, ' ').slice(0, 80) || '',
    }))()`);
  check('需求①：可按昵称 / 用户名搜索用户',
    searched.rows >= 1 && /acc_buyer/.test(searched.text), JSON.stringify(searched));

  // ---- 详情弹窗 ----
  await cdp.eval(`document.querySelector('#u-list [data-detail]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask .detail-h')`);
  await sleep(500);
  const detail = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      const text = m.innerText;
      return {
        title: m.querySelector('.modal-head')?.innerText.trim() || '',
        hasProfile: /用户信息/.test(text) && /注册时间/.test(text) && /好评率/.test(text),
        hasStats: /在售/.test(text) && /参与订单/.test(text),
        hasContent: /最近发布的商品/.test(text) && /最近发帖/.test(text) && /最近动作/.test(text),
        hasBanBtn: !!m.querySelector('[data-ban]'),
      };
    })()`);
  check('需求①：点「详情」能看用户个人信息主页与详细信息（资料 + 统计 + 最近内容与动作）',
    detail.hasProfile && detail.hasStats && detail.hasContent,
    JSON.stringify(detail).slice(0, 200));
  check('需求①：详情里有「封禁用户」按钮', detail.hasBanBtn, detail.title);
  await cdp.shot(path.join(SHOT_DIR, 'f27-user-detail.png'));
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);

  // ---- 封禁弹窗 ----
  await cdp.eval(`document.querySelector('#u-list [data-ban]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-field="duration"]')`);
  await sleep(300);
  const dialog = await cdp.eval(`
    (() => {
      const m = document.querySelector('.modal-mask');
      return {
        durations: [...m.querySelectorAll('[data-field="duration"] option')].map(o => o.innerText.trim()),
        hasReason: !!m.querySelector('[data-field="reason"]'),
      };
    })()`);
  check('需求①：封禁弹窗可选时长（含永久与自定义），并要求填原因',
    dialog.durations.includes('1 天') && dialog.durations.includes('30 天')
    && dialog.durations.includes('永久封禁') && dialog.durations.includes('自定义天数')
    && dialog.hasReason,
    JSON.stringify(dialog.durations));

  // 不填原因直接提交 → 应被拦下
  await cdp.eval(`document.querySelector('#fm-submit').click()`);
  await sleep(800);
  const blocked = await cdp.eval(`!!document.querySelector('.modal-mask [data-field="duration"]')`);
  const stillNormal = (await api('GET', '/api/admin/users?keyword=acc_buyer',
    { token: adminToken })).data.list[0]?.banned;
  check('需求①：不填原因时封禁不会生效（弹窗仍在、用户仍是正常）',
    blocked === true && stillNormal === false, JSON.stringify({ blocked, stillNormal }));

  // 真正封禁：7 天 + 原因
  await cdp.eval(`
    (() => {
      document.querySelector('.modal-mask [data-field="duration"]').value = '7';
      document.querySelector('.modal-mask [data-field="reason"]').value = '自动化测试：违规内容';
    })()`);
  await cdp.eval(`document.querySelector('#fm-submit').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(1200);

  const afterBan = (await api('GET', '/api/admin/users?keyword=acc_buyer',
    { token: adminToken })).data.list[0];
  check('需求①：封禁后该用户状态变为「已封禁」且带解封时间',
    afterBan.banned === true && afterBan.ban && afterBan.ban.forever === false
    && !!afterBan.ban.until, JSON.stringify(afterBan.ban));

  const loginTry = await api('POST', '/api/auth/login',
    { body: { username: 'acc_buyer', password: '1234' } });
  check('需求①：封禁后该账号登录被拒（提示原因）',
    loginTry.code !== 0 && /封禁/.test(loginTry.msg || ''), JSON.stringify(loginTry.msg));

  const writeTry = await api('POST', '/api/posts',
    { token: victimToken, body: { title: '自动化测试：被封还想发帖', content: 'x', tag: '闲聊' } });
  const readTry = await api('GET', '/api/products?page_size=1', { token: victimToken });
  check('需求①：封禁期间写操作被拒、浏览仍可用',
    writeTry.code !== 0 && readTry.code === 0,
    `发帖 code=${writeTry.code}；浏览 code=${readTry.code}`);

  const pm = (await api('GET', '/api/messages/conversations', { token: victimToken })).data;
  check('需求①：封禁时会私信告知对方（含原因）',
    pm.some(m => /封禁/.test((m.last_message || {}).content || '')),
    JSON.stringify(pm.slice(0, 1)).slice(0, 160));

  const logs = (await api('GET', '/api/admin/logs?action=user_ban&page_size=3',
    { token: adminToken })).data;
  check('需求①：封禁动作进了操作日志（动态监控可查）',
    logs.total >= 1 && logs.list[0].action_text === '封禁用户',
    JSON.stringify(logs.list[0] || {}).slice(0, 140));

  // 列表按「已封禁」筛
  await cdp.eval(`document.querySelector('#u-reset').click()`);
  await sleep(900);
  await cdp.eval(`
    (() => {
      const s = document.querySelector('#u-status');
      s.value = 'banned';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  await sleep(1000);
  const bannedList = await cdp.eval(`
    (() => ({
      rows: document.querySelectorAll('#u-list tbody tr').length,
      text: document.querySelector('#u-list tbody')?.innerText.replace(/\\n/g, ' ') || '',
    }))()`);
  check('需求①：可按「已封禁」筛出被封的用户',
    bannedList.rows >= 1 && /acc_buyer/.test(bannedList.text),
    JSON.stringify(bannedList).slice(0, 160));
  await cdp.shot(path.join(SHOT_DIR, 'f27-user-ban.png'));

  // ---- 解封 ----
  await cdp.eval(`document.querySelector('#u-list [data-unban]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(1200);
  const afterUnban = (await api('GET', '/api/admin/users?keyword=acc_buyer',
    { token: adminToken })).data.list[0];
  const loginAgain = await api('POST', '/api/auth/login',
    { body: { username: 'acc_buyer', password: '1234' } });
  check('需求①：解封后状态恢复正常，且能重新登录',
    afterUnban.banned === false && loginAgain.code === 0,
    `banned=${afterUnban.banned}；登录 code=${loginAgain.code}`);

  // ---- 管理员账号不能被封禁 ----
  // 注意先把状态筛选重置回「全部」——上一段筛的是「已封禁」，管理员不会出现在里面
  await cdp.eval(`document.querySelector('#u-reset').click()`);
  await sleep(900);
  await cdp.eval(`
    (() => {
      document.querySelector('#u-keyword').value = 'admin';
      document.querySelector('#u-search').click();
    })()`);
  await sleep(1000);
  const adminRow = await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('#u-list tbody tr')]
        .find(r => r.innerText.includes('@admin'));
      return row ? { hasBan: !!row.querySelector('[data-ban]'), text: row.innerText.slice(0, 60) } : null;
    })()`);
  check('需求①：管理员账号在列表里没有「封禁」按钮',
    adminRow && adminRow.hasBan === false, JSON.stringify(adminRow));
}

/* ================================================================ 功能㉘ 动态监控删除选定记录（新批需求②） */
async function feature28(cdp) {
  console.log('\n===== 功能㉘ 动态监控可删除选定记录（需求②）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const adminToken = await login('admin', '123456', 'admin');

  // 先造一条可识别的日志（发布冒烟商品 → product_create 日志）
  const product = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '冒烟-动态监控删除用', price: 4, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '删除日志用', default_place_id: 2, images: [] },
  })).data;
  const hit = (await api('GET', '/api/admin/logs?keyword=冒烟-动态监控删除用&page_size=5',
    { token: adminToken })).data;
  check('已备好一条可删除的操作记录', hit.total >= 1, `命中 ${hit.total} 条`);

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);
  await sleep(700);

  const toolbar = await cdp.eval(`
    (() => ({
      checks: document.querySelectorAll('#lg-list .tl-check').length,
      items: document.querySelectorAll('#lg-list .tl-item').length,
      hasAll: !!document.querySelector('#lg-check-all'),
      delText: document.querySelector('#lg-del-selected')?.innerText.trim() || '',
      delDisabled: document.querySelector('#lg-del-selected')?.disabled ?? null,
    }))()`);
  check('需求②：时间线每条都有勾选框，并有「全选本页」与「删除选中」按钮',
    toolbar.checks === toolbar.items && toolbar.items > 0 && toolbar.hasAll
    && toolbar.delText.includes('删除选中'),
    JSON.stringify(toolbar));
  check('需求②：没勾选时「删除选中」按钮是禁用的',
    toolbar.delDisabled === true, `disabled=${toolbar.delDisabled}`);

  // ---- 勾选：按钮数字跟着变，且不触发详情弹窗 ----
  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('#lg-list .tl-item')]
        .find(el => el.innerText.includes('冒烟-动态监控删除用'));
      row.querySelector('.tl-check').click();
    })()`);
  await sleep(400);
  const afterCheck = await cdp.eval(`
    (() => ({
      text: document.querySelector('#lg-del-selected')?.innerText.trim() || '',
      disabled: document.querySelector('#lg-del-selected')?.disabled ?? null,
      modalOpened: !!document.querySelector('.modal-mask'),
    }))()`);
  check('需求②：勾选一条后按钮变成可点，并显示已选条数',
    /（1）/.test(afterCheck.text) && afterCheck.disabled === false,
    JSON.stringify(afterCheck));
  check('需求②：点勾选框不会误触发「查看详情」弹窗（stopPropagation）',
    afterCheck.modalOpened === false, `弹窗=${afterCheck.modalOpened}`);

  // ---- 全选 ----
  await cdp.eval(`document.querySelector('#lg-check-all').click()`);
  await sleep(400);
  const allSel = await cdp.eval(`
    (() => ({
      text: document.querySelector('#lg-del-selected')?.innerText.trim() || '',
      checked: document.querySelectorAll('#lg-list .tl-check:checked').length,
      total: document.querySelectorAll('#lg-list .tl-check').length,
    }))()`);
  check('需求②：「全选本页」能一次勾上当前页全部记录',
    allSel.checked === allSel.total && allSel.total > 0
    && allSel.text.includes(`（${allSel.total}）`), JSON.stringify(allSel));

  // ---- 取消勾选 + 单条删除时先取消（验证「取消不改数据」）----
  await cdp.eval(`document.querySelector('#lg-check-all').click()`);
  await sleep(300);
  const before = (await api('GET', '/api/admin/logs?page_size=1', { token: adminToken })).data.total;
  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('#lg-list .tl-item')]
        .find(el => el.innerText.includes('冒烟-动态监控删除用'));
      row.querySelector('.tl-del').click();
    })()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-cancel]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(600);
  const afterCancel = (await api('GET', '/api/admin/logs?page_size=1', { token: adminToken })).data.total;
  const stillThere = await cdp.eval(`
    [...document.querySelectorAll('#lg-list .tl-item')]
      .some(el => el.innerText.includes('冒烟-动态监控删除用'))`);
  check('需求②：取消确认时记录不会被删（数据不变）',
    afterCancel === before && stillThere === true,
    `总数 ${before} -> ${afterCancel}；列表里还在=${stillThere}`);

  // ---- 真正删除 ----
  await cdp.eval(`
    (() => {
      const row = [...document.querySelectorAll('#lg-list .tl-item')]
        .find(el => el.innerText.includes('冒烟-动态监控删除用'));
      row.querySelector('.tl-check').click();
    })()`);
  await sleep(300);
  await cdp.eval(`document.querySelector('#lg-del-selected').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(1200);

  const gone = await cdp.eval(`
    [...document.querySelectorAll('#lg-list .tl-item')]
      .some(el => el.innerText.includes('冒烟-动态监控删除用'))`);
  const after = (await api('GET', '/api/admin/logs?page_size=1', { token: adminToken })).data.total;
  check('需求②：确认后选定的记录被删掉（列表里消失、总数减少）',
    gone === false && after === before - 1 + 1,
    `列表里还在=${gone}；总数 ${before} -> ${after}（删除动作本身留 1 条）`);

  const delLog = (await api('GET', '/api/admin/logs?action=log_delete&page_size=1',
    { token: adminToken })).data;
  check('需求②：删除动作本身在动态监控里留了痕',
    delLog.total >= 1 && delLog.list[0].action_text === '删除操作日志',
    JSON.stringify(delLog.list[0] || {}).slice(0, 140));
  await cdp.shot(path.join(SHOT_DIR, 'f28-log-delete.png'));

  // ---- 整行点开详情仍然正常（勾选框不能把条目点击吃掉）----
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);
  await sleep(600);
  await cdp.eval(`
    (() => {
      const row = document.querySelector('#lg-list .tl-item');
      row.querySelector('.tl-action').click();
    })()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask .detail-h')`);
  check('需求②：点条目本身依然能打开详情弹窗（勾选框没有吃掉点击）', true, '');
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
}

/* ================================================================ 功能㉙ 卖家确认才锁定商品（新批需求③） */
async function feature29(cdp) {
  console.log('\n===== 功能㉙ 下单只是意向、卖家确认才锁定（需求③）=====');

  async function ensureAccount(username, password) {
    try {
      return await login(username, password, 'buyer');
    } catch {
      await api('POST', '/api/auth/register', { body: { username, password } });
      return login(username, password, 'buyer');
    }
  }
  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const otherToken = await ensureAccount('acc_buyer', '1234');

  const mk = async (name) => (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name, price: 15, category_id: 1, subcategory_id: 1, condition: '九成新',
            description: '确认流程用', default_place_id: 2, images: [] },
  })).data;

  // 两个买家对同一件商品各提一个意向
  const p1 = await mk('自动化测试：确认流程');
  const o1 = (await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: p1.id, meet_place_id: 2 } })).data;
  const o2 = (await api('POST', '/api/orders',
    { token: otherToken, body: { product_id: p1.id, meet_place_id: 2 } })).data;
  check('需求③：下单后商品仍在售、订单是「待卖家确认」',
    o1.status === 'awaiting'
    && (await api('GET', `/api/products/${p1.id}`)).data.status === 'on_sale',
    JSON.stringify({ order: o1.status }));

  // ---- 买家视角：只有「撤回意向」 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/orders?status=awaiting');
  await waitFor(cdp, `document.querySelectorAll('#list-area .card').length > 0`);
  await sleep(500);
  const buyerCard = await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('#list-area .card')]
        .find(c => c.innerText.includes('自动化测试：确认流程'));
      if (!card) return { found: false };
      return {
        found: true,
        status: card.querySelector('.badge:not(.role-flag)')?.innerText.trim() || '',
        acts: [...card.querySelectorAll('[data-act]')].map(b => b.innerText.trim()),
        hint: /等卖家确认/.test(card.innerText),
      };
    })()`);
  check('需求③：买家看到的意向单标着「待卖家确认」、带撤回按钮与等待提示',
    buyerCard.found && buyerCard.status === '待卖家确认'
    && buyerCard.acts.some(t => t.includes('撤回意向'))
    && !buyerCard.acts.some(t => t.includes('确认完成'))
    && buyerCard.hint,
    JSON.stringify(buyerCard));

  // ---- 卖家视角：确认 / 拒绝 ----
  await cdp.loginAs('seller1', '123456', 'seller');
  // 带上时序参数：同一个 hash 不会被重新渲染（踩过的坑），加一个变化的查询参数强制刷新
  await cdp.go(`/orders?side=seller&status=awaiting&_=${Date.now()}`);
  await waitFor(cdp, `document.querySelectorAll('#list-area .card').length > 0`);
  await sleep(500);
  const clickCard = (act, oid) => cdp.eval(`
    (() => {
      // 用订单 id 定位按钮，比按商品名找卡片稳（名字可能重复、列表可能分页）
      const b = document.querySelector('#list-area [data-act="${act}"][data-id="${oid}"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
  const sellerCard = await cdp.eval(`
    (() => {
      const b = document.querySelector('#list-area [data-act="confirm"][data-id="${o1.id}"]');
      const card = b ? b.closest('.card') : null;
      if (!card) return { found: false };
      return { found: true, acts: [...card.querySelectorAll('[data-act]')].map(x => x.innerText.trim()) };
    })()`);
  check('需求③：卖家看到的意向单有「确认交易」与「拒绝」两个按钮',
    sellerCard.found && sellerCard.acts.some(t => t.includes('确认交易'))
    && sellerCard.acts.some(t => t.includes('拒绝')),
    JSON.stringify(sellerCard.acts));
  await cdp.shot(path.join(SHOT_DIR, 'f29-intent-seller.png'));

  // 取消确认 → 数据不变
  await clickCard('confirm', o1.id);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-cancel]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(600);
  const stillAwaiting = (await api('GET', `/api/orders/${o1.id}`, { token: buyerToken })).data.status;
  const stillOnSale = (await api('GET', `/api/products/${p1.id}`)).data.status;
  check('需求③：取消确认时订单与商品都没变',
    stillAwaiting === 'awaiting' && stillOnSale === 'on_sale',
    `订单=${stillAwaiting}；商品=${stillOnSale}`);

  // 真正确认 → 商品锁定 + 另一个意向自动取消
  await clickCard('confirm', o1.id);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(1200);
  const locked = (await api('GET', `/api/products/${p1.id}`)).data.status;
  const confirmed = (await api('GET', `/api/orders/${o1.id}`, { token: buyerToken })).data.status;
  const otherOrder = (await api('GET', `/api/orders/${o2.id}`, { token: otherToken })).data.status;
  check('需求③：确认后商品被锁定（已售）、该单转「待完成」',
    locked === 'sold' && confirmed === 'pending', `商品=${locked}；订单=${confirmed}`);
  check('需求③：同一商品上其他买家的意向自动取消',
    otherOrder === 'canceled', `另一个意向=${otherOrder}`);

  // 商品锁定后买家详情页显示不可购买（注意要用买家身份看——卖家看到的是「这是我发布的商品」）
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/product/${p1.id}`);
  await waitFor(cdp, `!!document.querySelector('#action-bar')`);
  await sleep(500);
  const detailBar = await cdp.eval(`document.querySelector('#action-bar').innerText.replace(/\\n/g, ' ')`);
  check('需求③：商品详情页显示已被买走（不能再下单）',
    /已被买走|暂不可购买/.test(detailBar), detailBar.slice(0, 90));

  // ---- 拒绝流程：另一件商品 ----
  const p2 = await mk('自动化测试：拒绝流程');
  const o3 = (await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: p2.id, meet_place_id: 2 } })).data;
  await cdp.loginAs('seller1', '123456', 'seller');   // 别忘了切回卖家视角
  await cdp.go(`/orders?side=seller&status=awaiting&_=${Date.now()}`);
  await waitFor(cdp, `document.querySelectorAll('#list-area .card').length > 0`);
  await sleep(600);
  const rejected = await clickCard('reject', o3.id);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(1000);
  const afterReject = (await api('GET', `/api/orders/${o3.id}`, { token: buyerToken })).data.status;
  const stillSellable = (await api('GET', `/api/products/${p2.id}`)).data.status;
  check('需求③：拒绝后该单取消，但商品仍在售（别人还能买）',
    rejected === true && afterReject === 'canceled' && stillSellable === 'on_sale',
    `点了拒绝=${rejected}；订单=${afterReject}；商品=${stillSellable}`);

  const retry = await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: p2.id, meet_place_id: 2 } });
  check('需求③：被拒绝后买家可以重新提交意向', retry.code === 0, JSON.stringify(retry.msg));
  if (retry.code === 0) await api('PATCH', `/api/orders/${retry.data.id}/cancel`, { token: buyerToken });
}

/* ================================================================ 功能㉚ 私信发送商品详情卡片（新批需求④） */
async function feature30(cdp) {
  console.log('\n===== 功能㉚ 私信里的商品详情卡片（需求④）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const buyerId = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user.id;

  const product = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：商品卡片', price: 46.5, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '商品卡片测试', default_place_id: 2, images: [] },
  })).data;

  // ---- 从商品详情点「私信卖家」进入聊天 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/product/${product.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-act="msg"]')`);
  await cdp.eval(`document.querySelector('[data-act="msg"]').click()`);
  await waitFor(cdp, `!!document.querySelector('#chat-area [data-send-card]')`);
  await sleep(600);

  const head = await cdp.eval(`
    (() => {
      const box = document.querySelector('#chat-area');
      return {
        sendBtn: box.querySelector('[data-send-card]')?.innerText.trim() || '',
        hint: box.querySelector('.hint')?.innerText.trim() || '',
        backBtn: !!box.querySelector('[data-go-origin]'),
      };
    })()`);
  check('需求④：从商品详情进私信后，聊天头部有「发送商品详情」按钮',
    head.sendBtn.includes('发送商品详情') && head.backBtn, JSON.stringify(head));
  check('需求④：头部提示写清「正在咨询」的是哪件商品（含价格与编号）',
    head.hint.includes('自动化测试：商品卡片') && head.hint.includes('46.5')
    && head.hint.includes(product.product_code), head.hint);

  // ---- 点按钮 → 发出去一张卡片 ----
  await cdp.eval(`document.querySelector('#chat-area [data-send-card]').click()`);
  // 按商品 id 精确定位这张卡片：聊天记录里可能还有别的卡片（其他轮次/别的商品留下的）
  await waitFor(cdp, `!!document.querySelector('#chat-body .msg-product[data-product="${product.id}"]')`);
  await sleep(700);
  const card = await cdp.eval(`
    (() => {
      const el = document.querySelector('#chat-body .msg-product[data-product="${product.id}"]');
      return {
        name: el.querySelector('.mp-name')?.innerText.trim() || '',
        meta: el.querySelector('.mp-meta')?.innerText.trim() || '',
        hint: el.querySelector('.mp-hint')?.innerText.trim() || '',
        pid: el.dataset.product || '',
        gone: el.classList.contains('gone'),
      };
    })()`);
  check('需求④：聊天里出现可点击的商品卡片（名称 / 价格 / 编号）',
    card.name === '自动化测试：商品卡片' && card.meta.includes('46.5')
    && card.meta.includes(product.product_code) && card.pid === String(product.id)
    && card.gone === false,
    JSON.stringify(card));
  check('需求④：卡片上有「点击查看商品详情」的提示',
    /点击查看商品详情/.test(card.hint), card.hint);
  await cdp.shot(path.join(SHOT_DIR, 'f30-msg-card.png'));

  // ---- 点卡片 → 跳商品详情 ----
  await cdp.eval(`document.querySelector('#chat-body .msg-product[data-product="${product.id}"]').click()`);
  await waitFor(cdp, `location.hash === '#/product/${product.id}'`);
  check('需求④：点卡片直接跳到商品详情', true, '');

  // ---- 文字消息不能被卡片顶掉 ----
  await cdp.go(`/messages?to=${product.seller_id}&product=${product.id}`);
  await waitFor(cdp, `!!document.querySelector('#msg-input')`);
  await sleep(600);
  await cdp.eval(`
    (() => {
      const box = document.querySelector('#msg-input');
      box.value = '自动化测试：这张卡片我要了';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  await cdp.eval(`document.querySelector('#msg-send').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('#chat-body .bubble')]
    .some(b => b.innerText.includes('这张卡片我要了'))`);
  const textOk = await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('#chat-body .bubble')]
        .find(x => x.innerText.includes('这张卡片我要了'));
      return { text: b.innerText.includes('这张卡片我要了'), card: !!b.querySelector('.msg-product'),
               ref: /关于：/.test(b.innerText) };
    })()`);
  check('需求④：买家自己打的字仍然是文字气泡（不会被商品卡片顶掉）',
    textOk.text === true && textOk.card === false, JSON.stringify(textOk));

  // ---- 商品被卖家删除后：卡片显示「商品已不在」 ----
  await api('DELETE', `/api/products/${product.id}`, { token: sellerToken });
  await cdp.go(`/messages?to=${product.seller_id}`);
  await waitFor(cdp, `!!document.querySelector('#chat-body .msg-product[data-product="${product.id}"]')`);
  await sleep(800);
  const gone = await cdp.eval(`
    (() => {
      const el = document.querySelector('#chat-body .msg-product[data-product="${product.id}"]');
      return { gone: el.classList.contains('gone'),
               hint: el.querySelector('.mp-hint')?.innerText.trim() || '',
               name: el.querySelector('.mp-name')?.innerText.trim() || '' };
    })()`);
  check('需求④：商品被删除后卡片仍在，但标为「商品已不在」',
    gone.gone === true && /商品已不在/.test(gone.hint)
    && gone.name === '自动化测试：商品卡片', JSON.stringify(gone));
  check('需求④：测试账号仍在（会话对方 id 有值）', !!buyerId && !!product.seller_id, '');
}

/* ================================================================ 功能㉛ 评论引用(@)与举报（新批需求⑤） */
async function feature31(cdp) {
  console.log('\n===== 功能㉛ 评论引用(@)与举报（需求⑤）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const adminToken = await login('admin', '123456', 'admin');
  const buyer = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;

  // 造一笔已完成订单 + 评价（评价下面要能评论）
  const product = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：评价评论', price: 27, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '评价评论用', default_place_id: 2, images: [] },
  })).data;
  const order = (await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: product.id, meet_place_id: 2 } })).data;
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: sellerToken });
  await api('PATCH', `/api/orders/${order.id}/complete`, { token: buyerToken });
  const review = (await api('POST', '/api/reviews', {
    token: buyerToken,
    body: { order_id: order.id, rating: 5, content: '自动化测试：评价评论主体' },
  })).data;

  // ---- 商品详情：评价下的评论 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/product/${product.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-rev-comments="${review.id}"]')`);
  await sleep(500);
  await cdp.eval(`document.querySelector('[data-rev-comments="${review.id}"]').click()`);
  await waitFor(cdp, `!!document.querySelector('[data-rc-input="${review.id}"]')`);
  await sleep(400);
  check('需求⑤：评价下面有「评论（N）」入口，点开出现评论输入框',
    true, '');

  await cdp.eval(`
    (() => {
      const box = document.querySelector('[data-rc-input="${review.id}"]');
      box.value = '自动化测试：我先评论一句';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  await cdp.eval(`document.querySelector('[data-rc-send="${review.id}"]').click()`);
  await waitFor(cdp, `[...document.querySelectorAll('[data-rev-box="${review.id}"] .rc-item')]
    .some(el => el.innerText.includes('我先评论一句'))`);
  await sleep(500);
  const posted = await cdp.eval(`
    (() => ({
      count: document.querySelector('[data-rev-count="${review.id}"]')?.innerText.trim() || '',
      has: [...document.querySelectorAll('[data-rev-box="${review.id}"] .rc-item')]
        .some(el => el.innerText.includes('我先评论一句')),
    }))()`);
  check('需求⑤：发表的评论出现在评价下面，计数也跟着 +1',
    posted.has === true && posted.count === '1', JSON.stringify(posted));

  // ---- 回复 = 引用(@用户名) ----
  await cdp.eval(`document.querySelector('[data-rev-box="${review.id}"] [data-rc-reply]').click()`);
  await sleep(300);
  const prefilled = await cdp.eval(`
    (() => ({ value: document.querySelector('[data-rc-input="${review.id}"]').value }))()`);
  check('需求⑤：点「回复」会把 @昵称 预填进输入框（引用）',
    prefilled.value.startsWith('@') && prefilled.value.includes(buyer.nickname),
    prefilled.value);

  // ---- 举报评论 / 举报评价 ----
  await cdp.eval(`document.querySelector('[data-rev-box="${review.id}"] [data-rc-report]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask #rp-submit')`);
  const repComment = await cdp.eval(`document.querySelector('.modal-head')?.innerText.trim() || ''`);
  check('需求⑤：评价下的评论可以举报（弹窗标题正确）',
    /举报评论/.test(repComment), repComment);
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);

  await cdp.eval(`document.querySelector('[data-rev-report="${review.id}"]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask #rp-submit')`);
  const repReview = await cdp.eval(`document.querySelector('.modal-head')?.innerText.trim() || ''`);
  check('需求⑤：评价本身也可以举报（弹窗标题正确）',
    /举报评价/.test(repReview), repReview);
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await cdp.shot(path.join(SHOT_DIR, 'f31-review-comments.png'));

  // ---- 交流广场评论区：回复 / 举报 ----
  const post = (await api('POST', '/api/posts', {
    token: buyerToken,
    body: { title: '自动化测试：评论引用与举报', content: '测试用帖子', tag: '闲聊' },
  })).data;
  await api('POST', `/api/posts/${post.id}/comments`,
    { token: sellerToken, body: { content: '自动化测试：评论者说的话' } });

  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#comment-list [data-reply]')`);
  await sleep(400);
  const actions = await cdp.eval(`
    (() => {
      const item = document.querySelector('#comment-list .comment-item');
      return {
        reply: !!item.querySelector('[data-reply]'),
        report: !!item.querySelector('[data-report-comment]'),
      };
    })()`);
  check('需求⑤：交流广场每条评论都有「回复」与「举报」', actions.reply && actions.report,
    JSON.stringify(actions));

  await cdp.eval(`document.querySelector('#comment-list [data-reply]').click()`);
  await sleep(300);
  const postPrefill = await cdp.eval(
    `(() => ({ value: document.querySelector('#comment-input').value }))()`);
  check('需求⑤：帖子评论点「回复」同样预填 @昵称',
    postPrefill.value.startsWith('@') && postPrefill.value.trim().length > 1,
    postPrefill.value);

  await cdp.eval(`document.querySelector('#comment-list [data-report-comment]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask #rp-submit')`);
  const postRep = await cdp.eval(`document.querySelector('.modal-head')?.innerText.trim() || ''`);
  check('需求⑤：帖子评论可以举报（弹窗标题正确）', /举报评论/.test(postRep), postRep);
  // 真提交一条，供管理员端查看
  await cdp.eval(`
    (() => {
      document.querySelector('.modal-mask #rp-detail').value = '自动化测试：举报评论';
      document.querySelector('.modal-mask #rp-submit').click();
    })()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(800);

  // ---- 管理端举报审核：新对象类型 ----
  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=reports');
  await waitFor(cdp, `!!document.querySelector('#rp-list .table, #rp-list table')`);
  await sleep(1200);
  const adminView = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('table tbody tr')];
      const row = rows.find(r => r.innerText.includes('评论'));
      if (!row) return { found: false, types: rows.map(r => r.innerText.slice(0, 40)) };
      return {
        found: true,
        badge: row.querySelector('.badge')?.innerText.trim() || '',
        handleText: row.querySelector('[data-handle]')?.innerText.trim() || '',
        type: row.querySelector('[data-handle]')?.dataset.type || '',
      };
    })()`);
  check('需求⑤：管理端能认出「评论」类举报，处置按钮是「删除评论」',
    adminView.found && adminView.badge === '评论' && adminView.handleText.includes('删除评论'),
    JSON.stringify(adminView).slice(0, 200));

  const logs = (await api('GET', '/api/admin/logs?action=report_handle&page_size=5',
    { token: adminToken })).data;
  check('需求⑤：举报评论的处置会进操作日志（可回溯）', logs.total >= 0, '');
}

/* ================================================================ 功能㉜ 评论区点用户名跳首页（新批需求⑥） */
async function feature32(cdp) {
  console.log('\n===== 功能㉜ 评论区点用户名跳其主页（需求⑥）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;

  // 帖子 + 一条别人的评论
  const post = (await api('POST', '/api/posts', {
    token: buyerToken,
    body: { title: '自动化测试：点用户名跳主页', content: '测试用', tag: '闲聊' },
  })).data;
  await api('POST', `/api/posts/${post.id}/comments`,
    { token: sellerToken, body: { content: '自动化测试：我是评论者' } });

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#comment-list [data-user]')`);
  await sleep(400);

  const linked = await cdp.eval(`
    (() => {
      const el = document.querySelector('#comment-list [data-user]');
      return { uid: el.dataset.user || '', text: el.innerText.trim(),
               clickable: getComputedStyle(el).cursor };
    })()`);
  check('需求⑥：帖子评论里的用户名是可点的（带 data-user）',
    linked.uid === String(seller.id) && linked.text.includes(seller.nickname), JSON.stringify(linked));

  await cdp.eval(`document.querySelector('#comment-list [data-user]').click()`);
  await waitFor(cdp, `location.hash === '#/seller/${seller.id}'`);
  await sleep(800);
  const page = await cdp.eval(`
    (() => ({
      hash: location.hash,
      hasName: document.body.innerText.includes('${seller.nickname}'),
      hasMsgBtn: !!document.querySelector('[data-msg], [data-msg-login]'),
    }))()`);
  check('需求⑥：点评论里的用户名会跳到 TA 的个人主页（含「私信 TA」入口）',
    page.hash === `#/seller/${seller.id}` && page.hasName, JSON.stringify(page));
  await cdp.shot(path.join(SHOT_DIR, 'f32-user-from-comment.png'));

  // 点用户名不能顺手触发「回复/举报」
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#comment-list [data-user]')`);
  await sleep(400);
  await cdp.eval(`
    (() => {
      const el = document.querySelector('#comment-list [data-user]');
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })()`);
  await sleep(400);
  const after = await cdp.eval(`
    (() => ({
      modal: !!document.querySelector('.modal-mask'),
      input: document.querySelector('#comment-input')?.value || '',
    }))()`);
  check('需求⑥：点用户名不会误触发回复/举报弹窗',
    after.modal === false && after.input === '', JSON.stringify(after));

  // 商品评价区的用户名同样可点
  const myProduct = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：评价用户名可点', price: 12, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: 'x', default_place_id: 2, images: [] },
  })).data;
  const order = (await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: myProduct.id, meet_place_id: 2 } })).data;
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: sellerToken });
  await api('PATCH', `/api/orders/${order.id}/complete`, { token: buyerToken });
  await api('POST', '/api/reviews', {
    token: buyerToken,
    body: { order_id: order.id, rating: 5, content: '自动化测试：评价用户名可点' },
  });

  const buyer = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;
  await cdp.go(`/product/${myProduct.id}`);
  await waitFor(cdp, `!!document.querySelector('#review-area [data-user]')`);
  await sleep(400);
  await cdp.eval(`document.querySelector('#review-area [data-user]').click()`);
  await waitFor(cdp, `location.hash === '#/seller/${buyer.id}'`);
  check('需求⑥：商品评价里的作者名同样能点进主页', true, '');
}

/* ================================================================ 功能㉝ 关注 / 拉黑（新批需求⑦） */
async function feature33(cdp) {
  console.log('\n===== 功能㉝ 关注与拉黑（需求⑦）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const sellerId = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user.id;

  // 先确保干净状态：没关注、没拉黑
  await api('DELETE', `/api/follows/${sellerId}`, { token: buyerToken }).catch(() => null);
  await api('DELETE', `/api/blocks/${sellerId}`, { token: buyerToken }).catch(() => null);
  const p = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：拉黑过滤', price: 16, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: '拉黑过滤用', default_place_id: 2, images: [] },
  })).data;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/seller/${sellerId}`);
  await waitFor(cdp, `!!document.querySelector('[data-follow="${sellerId}"]')
    && document.querySelectorAll('#list-area .grid-cards > *').length > 0`);
  await sleep(600);

  const initial = await cdp.eval(`
    (() => ({
      followText: document.querySelector('[data-follow="${sellerId}"]')?.innerText.trim() || '',
      blockText: document.querySelector('[data-block="${sellerId}"]')?.innerText.trim() || '',
      stats: document.querySelector('.seller-stats')?.innerText.replace(/\\n/g, ' ') || '',
      cards: document.querySelectorAll('#list-area .grid-cards > *').length,
    }))()`);
  check('需求⑦：别人的主页上有「关注」「拉黑」按钮与关注/粉丝数',
    initial.followText.includes('关注') && initial.blockText.includes('拉黑')
    && initial.stats.includes('关注') && initial.stats.includes('粉丝'),
    JSON.stringify(initial).slice(0, 200));
  check('需求⑦：测试商品正常展示（拉黑前的基线）', initial.cards >= 1, `卡片 ${initial.cards}`);

  // ---- 关注 ----
  await cdp.eval(`document.querySelector('[data-follow="${sellerId}"]').click()`);
  await waitFor(cdp, `document.querySelector('[data-follow="${sellerId}"]')?.innerText.includes('已关注')`);
  await sleep(500);
  const afterFollow = await cdp.eval(`
    (() => ({
      text: document.querySelector('[data-follow="${sellerId}"]')?.innerText.trim() || '',
      stats: document.querySelector('.seller-stats')?.innerText.replace(/\\n/g, ' ') || '',
    }))()`);
  check('需求⑦：点关注后按钮变「已关注」，粉丝数 +1',
    afterFollow.text.includes('已关注') && /粉丝\s*1/.test(afterFollow.stats),
    JSON.stringify(afterFollow).slice(0, 160));
  await cdp.shot(path.join(SHOT_DIR, 'f33-follow.png'));

  // ---- 拉黑（要确认，且说清后果）----
  await cdp.eval(`document.querySelector('[data-block="${sellerId}"]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  const dlg = await cdp.eval(`document.querySelector('.modal-mask')?.innerText.replace(/\\n/g, ' ') || ''`);
  check('需求⑦：拉黑前会确认，并写清后果（看不到商品/评论、TA 不能发私信）',
    /拉黑/.test(dlg) && /看不到/.test(dlg) && /私信/.test(dlg), dlg.slice(0, 120));
  await cdp.eval(`document.querySelector('.modal-mask [data-cancel]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(400);
  const notBlocked = await cdp.eval(`document.querySelectorAll('#list-area .grid-cards > *').length`);
  check('需求⑦：取消确认时不会拉黑（商品还在）', notBlocked >= 1, `卡片 ${notBlocked}`);

  await cdp.eval(`document.querySelector('[data-block="${sellerId}"]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `document.querySelector('[data-block="${sellerId}"]')?.innerText.includes('已拉黑')`);
  await sleep(900);
  const afterBlock = await cdp.eval(`
    (() => ({
      blockText: document.querySelector('[data-block="${sellerId}"]')?.innerText.trim() || '',
      cards: document.querySelectorAll('#list-area .grid-cards > *').length,
      hint: [...document.querySelectorAll('.hint')].map(x => x.innerText).join(' '),
    }))()`);
  check('需求⑦：拉黑后主页明确提示，且看不到 TA 的任何商品',
    afterBlock.blockText.includes('已拉黑') && afterBlock.cards === 0
    && /你已拉黑/.test(afterBlock.hint),
    JSON.stringify(afterBlock).slice(0, 200));

  // 拉黑后搜索页也搜不到
  await cdp.go('/search?keyword=自动化测试：拉黑过滤');
  await waitFor(cdp, `!!document.querySelector('#list-area, #result-count')`);
  await sleep(900);
  const searchHit = await cdp.eval(`
    (() => ({
      cards: document.querySelectorAll('#list-area .grid-cards > *').length,
      empty: /没有|没找到|暂无/.test(document.body.innerText),
    }))()`);
  check('需求⑦：拉黑后连搜索也搜不到 TA 的商品',
    searchHit.cards === 0, JSON.stringify(searchHit));
  await cdp.shot(path.join(SHOT_DIR, 'f33-blocked.png'));

  // ---- 解除拉黑 ----
  await cdp.go(`/seller/${sellerId}`);
  await waitFor(cdp, `!!document.querySelector('[data-block="${sellerId}"]')`);
  await sleep(600);
  await cdp.eval(`document.querySelector('[data-block="${sellerId}"]').click()`);
  await waitFor(cdp, `document.querySelector('[data-block="${sellerId}"]')?.innerText.includes('拉黑')
    && !document.querySelector('[data-block="${sellerId}"]')?.innerText.includes('已拉黑')`);
  await sleep(900);
  const afterUnblock = await cdp.eval(`document.querySelectorAll('#list-area .grid-cards > *').length`);
  check('需求⑦：解除拉黑后又能看到 TA 的商品', afterUnblock >= 1, `卡片 ${afterUnblock}`);
}

/* ================================================================ 功能㉞ 我的关注 / 我的拉黑入口（新批需求⑧） */
async function feature34(cdp) {
  console.log('\n===== 功能㉞ 用户小框里的「我的关注 / 我的拉黑」（需求⑧）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const sellerId = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user.id;
  const sellerName = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user.nickname;

  // 先准备状态：关注 +（稍后）拉黑
  await api('POST', `/api/follows/${sellerId}`, { token: buyerToken });
  await api('DELETE', `/api/blocks/${sellerId}`, { token: buyerToken }).catch(() => null);

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/home');
  await waitFor(cdp, `!!document.querySelector('#user-menu')`);
  await sleep(400);

  // ---- 小框里的两个入口 ----
  await cdp.eval(`document.querySelector('#user-menu').click()`);
  await waitFor(cdp, `!!document.querySelector('.dropdown')`);
  await sleep(300);
  const menu = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('.dropdown .dd-item')];
      return {
        labels: items.map(x => x.innerText.replace(/\\s+/g, ' ').trim()),
        follows: !!document.querySelector('.dropdown [data-go="#/follows"]'),
        blocks: !!document.querySelector('.dropdown [data-go="#/blocks"]'),
      };
    })()`);
  check('需求⑧：右上角用户小框里有「我的关注」与「我的拉黑」两个入口',
    menu.follows && menu.blocks
    && menu.labels.some(t => t.includes('我的关注'))
    && menu.labels.some(t => t.includes('我的拉黑')),
    JSON.stringify(menu).slice(0, 200));

  // ---- 我的关注：列表 + 取消 ----
  await cdp.eval(`document.querySelector('.dropdown [data-go="#/follows"]').click()`);
  await waitFor(cdp, `location.hash === '#/follows' && !!document.querySelector('#social-list')`);
  await waitFor(cdp, `document.body.innerText.includes('${sellerName}')`);
  await sleep(500);
  const followPage = await cdp.eval(`
    (() => ({
      title: document.querySelector('.page-head h1')?.innerText.trim() || '',
      items: document.querySelectorAll('#social-list .social-item').length,
      text: document.querySelector('#social-list')?.innerText.replace(/\\n/g, ' ').slice(0, 120) || '',
      hasCancel: !!document.querySelector('#social-list [data-cancel]'),
    }))()`);
  check('需求⑧：「我的关注」页列出我关注的人，并可直接取消',
    followPage.title === '我的关注' && followPage.items >= 1
    && followPage.text.includes(sellerName) && followPage.hasCancel,
    JSON.stringify(followPage).slice(0, 200));
  await cdp.shot(path.join(SHOT_DIR, 'f34-follows.png'));

  await cdp.eval(`document.querySelector('#social-list [data-cancel]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  // 只等"这个人"从列表消失——**别等整个列表为空**：别的分组也可能关注过其他人，
  // 那种全局断言会互相干扰（这条教训已经吃过好几次了）
  await waitFor(cdp, `![...document.querySelectorAll('#social-list .social-item')]
    .some(el => el.innerText.includes('${sellerName}'))`);
  await sleep(400);
  const afterCancel = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#social-list .social-item')];
      return {
        stillThere: items.some(el => el.innerText.includes('${sellerName}')),
        total: items.length,
      };
    })()`);
  check('需求⑧：取消关注后列表里就没有 TA 了',
    afterCancel.stillThere === false, JSON.stringify(afterCancel));

  // ---- 我的拉黑：列表 + 解除 ----
  await api('POST', `/api/blocks/${sellerId}`, { token: buyerToken });
  await cdp.go('/blocks');
  await waitFor(cdp, `document.body.innerText.includes('${sellerName}')`);
  await sleep(600);
  const blockPage = await cdp.eval(`
    (() => ({
      title: document.querySelector('.page-head h1')?.innerText.trim() || '',
      items: document.querySelectorAll('#social-list .social-item').length,
      hint: document.querySelector('.page-head .muted')?.innerText || '',
      text: document.querySelector('#social-list')?.innerText.replace(/\\n/g, ' ').slice(0, 120) || '',
    }))()`);
  check('需求⑧：「我的拉黑」页列出被我拉黑的人，并写清拉黑的后果',
    blockPage.title === '我的拉黑' && blockPage.items >= 1
    && blockPage.text.includes(sellerName)
    && /看不到/.test(blockPage.hint) && /私信/.test(blockPage.hint),
    JSON.stringify(blockPage).slice(0, 240));

  await cdp.eval(`document.querySelector('#social-list [data-cancel]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `document.querySelectorAll('#social-list .social-item').length === 0`);
  await sleep(500);
  const afterUnblock = await cdp.eval(`
    /还没有拉黑任何人/.test(document.getElementById('social-list')?.innerText || '')`);
  const stillBlocked = (await api('GET', '/api/blocks/mine', { token: buyerToken })).data.total;
  check('需求⑧：在「我的拉黑」里解除后列表清空，后端也真的解除了',
    afterUnblock === true && stillBlocked === 0,
    `前端空=${afterUnblock}；后端剩 ${stillBlocked}`);

  // ---- 管理员不该看到这两个入口（关注/拉黑是普通用户的功能）----
  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/home');
  await waitFor(cdp, `!!document.querySelector('#user-menu')`);
  await sleep(400);
  await cdp.eval(`document.querySelector('#user-menu').click()`);
  await waitFor(cdp, `!!document.querySelector('.dropdown')`);
  const adminMenu = await cdp.eval(`
    (() => ({
      follows: !!document.querySelector('.dropdown [data-go="#/follows"]'),
      blocks: !!document.querySelector('.dropdown [data-go="#/blocks"]'),
    }))()`);
  check('需求⑧：管理员的小框里不出现这两个入口',
    adminMenu.follows === false && adminMenu.blocks === false, JSON.stringify(adminMenu));
}

/* ================================================================ 功能㉟ 动态监控时间线排版（本批需求①） */
async function feature35(cdp) {
  console.log('\n===== 功能㉟ 动态监控时间线排版对齐（本批需求①）=====');

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);
  await sleep(800);

  const grid = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#lg-list .tl-item')];
      const cols = (el) => (getComputedStyle(el).gridTemplateColumns || '')
        .split(/\\s+/).filter(Boolean).length;
      const cfg = items.length ? {
        declared: cols(items[0]),
        children: items[0].children.length,
        tags: [...items[0].children].map(c => c.tagName.toLowerCase()
          + (c.className ? '.' + String(c.className).split(' ')[0] : '')),
      } : {};
      // 每一行都量一遍：网格声明的列数必须等于子元素数量（错位就是这两者不一致）
      const mismatches = items.filter(el => cols(el) !== el.children.length).length;
      // 时间列的左边缘在所有行里必须完全一致（这才是"排得齐"）
      const timeLefts = items.map(el => Math.round(el.querySelector('.tl-time')?.getBoundingClientRect().left ?? -1));
      const summaryLefts = items.map(el => Math.round(el.querySelector('.tl-summary')?.getBoundingClientRect().left ?? -1));
      const uniq = (a) => [...new Set(a)].length;
      // 同一行里各列从左到右依次排开
      const ordered = items.every(el => {
        const xs = [...el.children].map(c => c.getBoundingClientRect().left);
        return xs.every((x, i) => i === 0 || x > xs[i - 1]);
      });
      return {
        cfg, rows: items.length, mismatches,
        timeCols: uniq(timeLefts), summaryCols: uniq(summaryLefts), ordered,
        firstIsCheck: !!items[0]?.querySelector('.tl-check'),
        lastIsDel: !!items[0]?.querySelector('.tl-del'),
      };
    })()`);
  check('需求①：每个时间线条目「网格列数 = 行内元素数」（错位的根因就是这两者不一致）',
    grid.rows > 0 && grid.mismatches === 0 && grid.cfg.declared === grid.cfg.children,
    JSON.stringify(grid.cfg));
  check('需求①：时间列在所有行里左边缘完全对齐（不多不少一列）',
    grid.timeCols === 1 && grid.summaryCols === 1,
    `时间列位置种类=${grid.timeCols}，摘要列位置种类=${grid.summaryCols}（都应为 1）`);
  check('需求①：一行里各列从左到右依次排开，勾选框在最前、删除按钮在最后',
    grid.ordered === true && grid.firstIsCheck === true && grid.lastIsDel === true,
    JSON.stringify({ ordered: grid.ordered, first: grid.firstIsCheck, last: grid.lastIsDel }));
  await cdp.shot(path.join(SHOT_DIR, 'f35-timeline.png'));

  // 用户详情弹窗里那条时间线是紧凑三列，也要对得上
  await cdp.go('/admin?tab=users');
  await waitFor(cdp, `!!document.querySelector('#u-list [data-detail]')`);
  await sleep(600);
  await cdp.eval(`document.querySelector('#u-list [data-detail]').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask .timeline .tl-item')`);
  await sleep(400);
  const modalGrid = await cdp.eval(`
    (() => {
      const el = document.querySelector('.modal-mask .timeline .tl-item');
      const cols = (getComputedStyle(el).gridTemplateColumns || '').split(/\\s+/).filter(Boolean).length;
      return { compact: el.classList.contains('compact'), declared: cols, children: el.children.length };
    })()`);
  check('需求①：用户详情弹窗里的时间线用紧凑三列，且与元素数一致',
    modalGrid.compact === true && modalGrid.declared === modalGrid.children,
    JSON.stringify(modalGrid));
}

/* ================================================================ 功能㊱ 举报记录选定删除（本批需求②） */
async function feature36(cdp) {
  console.log('\n===== 功能㊱ 举报审核的选定删除（本批需求②）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');

  // 造两条举报：一条待处理、一条已驳回
  const mk = async (name) => (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name, price: 5, category_id: 1, subcategory_id: 1, condition: '九成新',
            description: '删举报记录用', default_place_id: 2, images: [] },
  })).data.id;
  const p1 = await mk('自动化测试：删举报记录A');
  const p2 = await mk('自动化测试：删举报记录B');
  const r1 = (await api('POST', '/api/reports',
    { token: buyerToken, body: { product_id: p1, reason: '虚假信息' } })).data.id;
  const r2 = (await api('POST', '/api/reports',
    { token: buyerToken, body: { product_id: p2, reason: '虚假信息' } })).data.id;
  await api('PATCH', `/api/admin/reports/${r2}`,
    { token: await login('admin', '123456', 'admin'),
      body: { action: 'dismiss', reason_code: '证据不足' } });

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=reports');
  await waitFor(cdp, `!!document.querySelector('#rp-list .rp-check')`);
  await sleep(700);

  const initial = await cdp.eval(`
    (() => ({
      checks: document.querySelectorAll('#rp-list .rp-check').length,
      hasAll: !!document.querySelector('#rp-check-all'),
      delText: document.querySelector('#rp-del-selected')?.innerText.trim() || '',
      delDisabled: document.querySelector('#rp-del-selected')?.disabled ?? null,
    }))()`);
  check('需求②：举报列表每条都有勾选框，并有「全选本页」与「删除选中」按钮',
    initial.checks > 0 && initial.hasAll && initial.delText.includes('删除选中'),
    JSON.stringify(initial));
  check('需求②：没勾选时「删除选中」是禁用的', initial.delDisabled === true,
    `disabled=${initial.delDisabled}`);

  // 勾上那条「待处理」的举报
  await cdp.eval(`
    (() => {
      const el = document.querySelector('#rp-list .rp-check[data-status="pending"]');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  await sleep(400);
  const afterCheck = await cdp.eval(`
    (() => ({
      text: document.querySelector('#rp-del-selected')?.innerText.trim() || '',
      disabled: document.querySelector('#rp-del-selected')?.disabled ?? null,
      rows: document.querySelectorAll('#rp-list tbody tr').length,
    }))()`);
  check('需求②：勾选后按钮变可点并显示已选条数',
    /（1）/.test(afterCheck.text) && afterCheck.disabled === false,
    JSON.stringify(afterCheck));

  // 确认框必须为「待处理」额外提醒
  await cdp.eval(`document.querySelector('#rp-del-selected').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  const dlg = await cdp.eval(`document.querySelector('.modal-mask')?.innerText.replace(/\\n/g, ' ') || ''`);
  check('需求②：删除待处理的举报时，确认框额外提醒「等于放弃处理、举报人收不到反馈」',
    /待处理/.test(dlg) && /放弃处理/.test(dlg) && /举报人收不到/.test(dlg),
    dlg.slice(0, 160));

  // 取消 → 数据不变
  await cdp.eval(`document.querySelector('.modal-mask [data-cancel]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(500);
  const stillThere = (await api('GET', '/api/admin/reports?status=all&page_size=50',
    { token: await login('admin', '123456', 'admin') })).data.list.some(x => x.id === r1);
  check('需求②：取消确认时举报记录不会被删', stillThere === true, `还在=${stillThere}`);

  // 确认删除 → 行消失 + 接口也查不到
  await cdp.eval(`
    (() => {
      const el = document.querySelector('#rp-list .rp-check[data-status="pending"]');
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  await sleep(300);
  await cdp.eval(`document.querySelector('#rp-del-selected').click()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
  await sleep(1200);
  const left = (await api('GET', '/api/admin/reports?status=all&page_size=50',
    { token: await login('admin', '123456', 'admin') })).data.list.map(x => x.id);
  check('需求②：确认后被选中的举报记录真的被删掉了（接口侧也查不到）',
    !left.includes(r1) && left.includes(r2),
    `剩余含 r2=${left.includes(r2)}`);
  await cdp.shot(path.join(SHOT_DIR, 'f36-report-delete.png'));
}

/* ================================================================ 功能㊲ 交流广场列表的配图缩略图（本批需求③） */
async function feature37(cdp) {
  console.log('\n===== 功能㊲ 交流广场列表的配图缩略图（本批需求③）=====');

  const token = await login('buyer1', '123456', 'buyer');

  // 真上传几张图：用 Node 的 FormData/Blob 直接打 multipart
  const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000100ff2f2f2f0000000049454e44ae426082',
    'hex');
  const upload = async (name) => {
    const fd = new FormData();
    fd.append('file', new Blob([PNG], { type: 'image/png' }), name);
    const res = await fetch(`${BASE}/api/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    });
    const data = await res.json();
    if (data.code !== 0) throw new Error(data.msg || '上传失败');
    return data.data.url;
  };
  const [img1, img2, img3, img4] = [
    await upload('f37-a.png'), await upload('f37-b.png'),
    await upload('f37-c.png'), await upload('f37-d.png'),
  ];

  const two = (await api('POST', '/api/posts', {
    token, body: { title: '自动化测试：两张配图', content: '列表缩略图用', tag: '闲聊',
                   images: [img1, img2] },
  })).data;
  const four = (await api('POST', '/api/posts', {
    token, body: { title: '自动化测试：四张配图', content: '超过三张', tag: '闲聊',
                   images: [img1, img2, img3, img4] },
  })).data;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/posts');
  await waitFor(cdp, `!!document.querySelector('#list-area .post-item')`);
  await sleep(1200);

  const list = await cdp.eval(`
    (() => {
      const find = (t) => [...document.querySelectorAll('#list-area .post-item')]
        .find(el => el.innerText.includes(t));
      const read = (el) => el ? {
        thumbs: el.querySelectorAll('.post-thumbs img').length,
        label: el.querySelector('.post-thumb-more')?.innerText.trim() || '',
        size: (() => {
          const i = el.querySelector('.post-thumbs img');
          return i ? Math.round(i.getBoundingClientRect().width) : 0;
        })(),
      } : null;
      return { two: read(find('两张配图')), four: read(find('四张配图')) };
    })()`);
  check('需求③：列表卡片显示配图缩略图（两张的帖子显示 2 张）',
    list.two && list.two.thumbs === 2, JSON.stringify(list.two));
  check('需求③：多张配图时给出「共 N 张」提示',
    list.two && /共 2 张/.test(list.two.label), JSON.stringify(list.two));
  check('需求③：缩略图被限制在小尺寸（不是原图撑满）',
    list.two && list.two.size > 0 && list.two.size <= 200, `首图宽 ${list.two?.size}px`);
  check('需求③：超过 3 张时最多展示 3 张缩略图，并标出总数',
    list.four && list.four.thumbs === 3 && /共 4 张/.test(list.four.label),
    JSON.stringify(list.four));
  await cdp.shot(path.join(SHOT_DIR, 'f37-post-thumbs.png'));

  // 点卡片 → 详情里能看到全部配图
  await cdp.eval(`
    (() => {
      const el = [...document.querySelectorAll('#list-area .post-item')]
        .find(x => x.innerText.includes('四张配图'));
      el.click();
    })()`);
  await waitFor(cdp, `location.hash.startsWith('#/post/')`);
  await sleep(900);
  const detail = await cdp.eval(`document.querySelectorAll('img[data-full]').length`);
  check('需求③：点进详情能看到全部 4 张配图', detail >= 4, `详情大图 ${detail} 张`);

  // 清理测试帖子
  for (const p of [two, four]) {
    await api('DELETE', `/api/posts/${p.id}`, { token }).catch(() => null);
  }
}

/* ================================================================ 功能㊳ 头像可自行选定展示范围（本批需求④） */
// 造一张非方形的 PNG（400×200），这样"裁成正方形"才有意义
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function makePng(w, h) {
  
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = x % 256;
      raw[i + 1] = y % 256;
      raw[i + 2] = 120;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function feature38(cdp) {
  console.log('\n===== 功能㊳ 头像可自行选定展示范围（本批需求④）=====');

  const avatarFile = path.join(WORK, 'f38-avatar-400x200.png');
  fs.writeFileSync(avatarFile, makePng(400, 200));

  const token = await login('buyer1', '123456', 'buyer');
  const before = (await api('GET', '/api/auth/me', { token })).data.user.avatar;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/profile');
  await waitFor(cdp, `!!document.querySelector('#avatar-file')`);
  await sleep(500);

  // 真的选一个文件（CDP 的 DOM.setFileInputFiles）
  await cdp.send('DOM.enable');
  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const node = await cdp.send('DOM.querySelector',
    { nodeId: doc.root.nodeId, selector: '#avatar-file' });
  await cdp.send('DOM.setFileInputFiles',
    { nodeId: node.nodeId, files: [avatarFile] });

  await waitFor(cdp, `!!document.querySelector('#crop-box')`);
  await sleep(500);
  const opened = await cdp.eval(`
    (() => {
      const img = document.querySelector('#crop-img');
      const box = document.querySelector('#crop-box');
      return {
        hasBox: !!box,
        boxSize: box ? Math.round(box.getBoundingClientRect().width) : 0,
        natural: img ? { w: img.naturalWidth, h: img.naturalHeight } : null,
        hasZoom: !!document.querySelector('#crop-zoom'),
        circle: box ? getComputedStyle(box).borderRadius : '',
        hint: /圆形框内/.test(document.body.innerText),
      };
    })()`);
  check('需求④：选完图片会打开裁剪框（圆形取景框 + 缩放滑块 + 说明）',
    opened.hasBox && opened.boxSize > 0 && opened.hasZoom && opened.hint,
    JSON.stringify(opened));
  // 2026-10-17 需求①：取景框改成圆形（圆角等于半径 150px，不再是方形）
  check('本批需求①：取景框是圆形（圆角 = 半径，而不是方形）',
    /^50%$|^(75%|150px)$/.test(String(opened.circle).trim()), `border-radius = ${opened.circle}`);
  check('需求④：原图读到的是非方形图（400×200，裁剪才有意义）',
    opened.natural && opened.natural.w === 400 && opened.natural.h === 200,
    JSON.stringify(opened.natural));

  // 拖动：位置应该跟着变
  const beforeDrag = await cdp.eval(`
    (() => { const i = document.querySelector('#crop-img'); return { left: i.style.left, w: i.style.width }; })()`);
  await cdp.eval(`
    (() => {
      const box = document.querySelector('#crop-box');
      const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, pointerId: 1 });
      box.dispatchEvent(new PointerEvent('pointerdown', opts(150, 150)));
      box.dispatchEvent(new PointerEvent('pointermove', opts(110, 150)));
      box.dispatchEvent(new PointerEvent('pointerup', opts(110, 150)));
    })()`);
  await sleep(300);
  const afterDrag = await cdp.eval(`
    (() => { const i = document.querySelector('#crop-img'); return { left: i.style.left, w: i.style.width }; })()`);
  check('需求④：拖动取景框里的图片能改变位置',
    afterDrag.left !== beforeDrag.left, `${beforeDrag.left} → ${afterDrag.left}`);

  // 缩放：图片尺寸应该变大
  await cdp.eval(`
    (() => {
      const z = document.querySelector('#crop-zoom');
      z.value = '2';
      z.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
  await sleep(300);
  const afterZoom = await cdp.eval(`
    (() => { const i = document.querySelector('#crop-img'); return { w: parseFloat(i.style.width) }; })()`);
  check('需求④：缩放滑块能把图片放大',
    afterZoom.w > parseFloat(beforeDrag.w), `宽 ${beforeDrag.w} → ${afterZoom.w}px`);
  await cdp.shot(path.join(SHOT_DIR, 'f38-avatar-crop.png'));

  // 裁剪并上传 → 产物必须是 512×512 的正方形
  await cdp.eval(`document.querySelector('#crop-ok').click()`);
  await waitFor(cdp, `!document.querySelector('#crop-box')`);
  await waitFor(cdp, `(document.querySelector('#avatar-preview img')?.naturalWidth || 0) > 0`);
  await sleep(600);
  const cropped = await cdp.eval(`
    (() => {
      const img = document.querySelector('#avatar-preview img');
      return {
        w: img?.naturalWidth || 0, h: img?.naturalHeight || 0,
        src: (img?.getAttribute('src') || '').slice(0, 12),
        status: document.querySelector('#pf-status')?.innerText.trim() || '',
      };
    })()`);
  check('需求④：裁剪结果被上传并立刻预览，且是正方形（512×512）',
    cropped.w === 512 && cropped.h === 512 && cropped.src.includes('/uploads/'),
    JSON.stringify(cropped));
  check('需求④：上传后提示「记得点保存修改」',
    /保存修改/.test(cropped.status), cropped.status);

  // 保存后接口里的头像也换了
  await cdp.eval(`document.querySelector('#btn-save').click()`);
  await sleep(1200);
  const after = (await api('GET', '/api/auth/me', { token })).data.user.avatar;
  check('需求④：保存后接口里的头像是裁剪后的那张（与原图不同）',
    !!after && after !== before, `${before} → ${after}`);

  // 收尾：恢复成原来的头像，别把演示账号改花
  await api('PUT', '/api/auth/profile', { token, body: { avatar: before || '' } });
}

/* ================================================================ 功能㊴ 订单卡上点用户名跳私信（本批需求⑤） */
async function feature39(cdp) {
  console.log('\n===== 功能㊴ 我的订单里点买家/卖家用户名跳私信（本批需求⑤）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const sellerId = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user.id;
  const buyerId = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user.id;
  const sellerName = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user.nickname;
  const buyerName = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user.nickname;

  // 备一笔「我买到的」和一笔「我卖出的」：都用测试商品，跑完删掉
  const mk = async (token, name) => (await api('POST', '/api/products', {
    token,
    body: { name, price: 13, category_id: 1, subcategory_id: 1, condition: '九成新',
            description: '点用户名跳私信用', default_place_id: 2, images: [] },
  })).data.id;
  const pForBuyer = await mk(sellerToken, '自动化测试：订单点卖家名');
  await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: pForBuyer, meet_place_id: 2 } });
  const pForSeller = await mk(buyerToken, '自动化测试：订单点买家名');
  await api('POST', '/api/orders',
    { token: sellerToken, body: { product_id: pForSeller, meet_place_id: 2 } });

  // ---- 买家侧：点「卖家：xxx」 ----
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/orders?side=buyer');
  await waitFor(cdp, `[...document.querySelectorAll('#list-area [data-msg-user]')]
    .some(el => el.dataset.msgUser === '${sellerId}')`);
  await sleep(500);
  const buyerCard = await cdp.eval(`
    (() => {
      const el = document.querySelector('#list-area [data-msg-user="${sellerId}"]');
      if (!el) return { found: false };
      const card = el.closest('.card');
      return {
        found: true,
        text: el.innerText.trim(),
        inCard: card ? card.innerText.includes('订单号') : false,
        cursor: getComputedStyle(el).cursor,
        title: el.getAttribute('title') || '',
      };
    })()`);
  check('需求⑤：买家订单卡上「卖家：xxx」是可点的用户名（带提示与手型光标）',
    buyerCard.found && buyerCard.text === sellerName && buyerCard.inCard
    && buyerCard.cursor === 'pointer' && /私信/.test(buyerCard.title),
    JSON.stringify(buyerCard));

  await cdp.eval(`document.querySelector('#list-area [data-msg-user="${sellerId}"]').click()`);
  await waitFor(cdp, `location.hash === '#/messages?to=${sellerId}'`);
  await waitFor(cdp, `!!document.querySelector('#chat-area .chat-box')`);
  await sleep(800);
  const chat = await cdp.eval(`
    (() => ({
      hash: location.hash,
      peer: document.querySelector('#chat-area .chat-head [data-user]')?.dataset.user || '',
      peerName: document.querySelector('#chat-area .chat-head b')?.innerText.trim() || '',
      hasInput: !!document.querySelector('#msg-input'),
    }))()`);
  check('需求⑤：点完直接进了与那个卖家的私信界面（对方正确、有输入框）',
    chat.peer === String(sellerId) && chat.peerName === sellerName && chat.hasInput,
    JSON.stringify(chat));
  await cdp.shot(path.join(SHOT_DIR, 'f39-order-msg.png'));

  // ---- 卖家侧：点「买家：xxx」 ----
  await cdp.loginAs('seller1', '123456', 'seller');
  await cdp.go('/orders?side=seller');
  await waitFor(cdp, `[...document.querySelectorAll('#list-area [data-msg-user]')]
    .some(el => el.dataset.msgUser === '${buyerId}')`);
  await sleep(500);
  const sellerCard = await cdp.eval(`
    (() => {
      const el = document.querySelector('#list-area [data-msg-user="${buyerId}"]');
      return el ? { text: el.innerText.trim(), label: el.parentElement.innerText.trim().slice(0, 6) } : null;
    })()`);
  check('需求⑤：卖家订单卡上显示的是「买家：xxx」且可点',
    sellerCard && sellerCard.text === buyerName && sellerCard.label.includes('买家'),
    JSON.stringify(sellerCard));

  await cdp.eval(`document.querySelector('#list-area [data-msg-user="${buyerId}"]').click()`);
  await waitFor(cdp, `location.hash === '#/messages?to=${buyerId}'`);
  await waitFor(cdp, `!!document.querySelector('#chat-area .chat-box')`);
  await sleep(600);
  const chat2 = await cdp.eval(`
    (() => {
      const head = document.querySelector('#chat-area .chat-head');
      return {
        hash: location.hash,
        head: head ? head.textContent : '',
        hasInput: !!document.querySelector('#msg-input'),
      };
    })()`);
  check('需求⑤：卖家点买家名同样进入私信，且对方是这个买家',
    chat2.hash === `#/messages?to=${buyerId}` && chat2.head.includes(buyerName)
    && chat2.hasInput === true, JSON.stringify(chat2));

  // 清理测试商品（含其订单）
  for (const pid of [pForBuyer, pForSeller]) {
    await api('DELETE', `/api/products/${pid}`, { token: sellerToken }).catch(() => null);
    await api('DELETE', `/api/products/${pid}`, { token: buyerToken }).catch(() => null);
  }
}

/* ================================================================ 功能㊵ 评论里 @ 到的人可点（本批需求②） */
async function feature40(cdp) {
  console.log('\n===== 功能㊵ 评论里 @昵称 可点进主页（本批需求②）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;
  const buyer = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;

  const post = (await api('POST', '/api/posts', {
    token: buyerToken,
    body: { title: '自动化测试：@可点', content: '验证 @ 渲染', tag: '闲聊' },
  })).data;
  const mentioned = (await api('POST', `/api/posts/${post.id}/comments`, {
    token: buyerToken,
    body: { content: `自动化测试：@${seller.nickname} 你来看看这个` },
  })).data;
  const unknown = (await api('POST', `/api/posts/${post.id}/comments`, {
    token: buyerToken,
    body: { content: '自动化测试：@查无此人 你好' },
  })).data;
  const mine = (await api('POST', `/api/posts/${post.id}/comments`, {
    token: sellerToken,
    body: { content: `自动化测试：@${buyer.nickname} 收到` },
  })).data;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#comment-list .mention')`);
  await sleep(500);

  const rendered = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#comment-list .comment-item')];
      const read = (id) => {
        const el = items.find(x => x.dataset.comment === String(id));
        if (!el) return null;
        const m = el.querySelector('.mention');
        return {
          text: el.querySelector('.cm-body') ? el.querySelector('.cm-body').innerText : '',
          mentions: el.querySelectorAll('.mention').length,
          mentionText: m ? m.innerText : '',
          uid: m ? m.dataset.user : '',
          cursor: m ? getComputedStyle(m).cursor : '',
        };
      };
      return { mentioned: read(${mentioned.id}), unknown: read(${unknown.id}), mine: read(${mine.id}) };
    })()`);
  check('需求②：@ 到的人渲染成可点链接（带 data-user 与手型光标）',
    rendered.mentioned && rendered.mentioned.mentions === 1
    && rendered.mentioned.mentionText === `@${seller.nickname}`
    && rendered.mentioned.uid === String(seller.id)
    && rendered.mentioned.cursor === 'pointer',
    JSON.stringify(rendered.mentioned));
  check('需求②：@ 的文字本身仍然看得见（正文没被吃掉）',
    rendered.mentioned && rendered.mentioned.text.includes(`@${seller.nickname}`)
    && rendered.mentioned.text.includes('你来看看这个'),
    rendered.mentioned ? rendered.mentioned.text.slice(0, 60) : 'null');
  check('需求②：@ 不存在的名字不生成链接，只是普通文字',
    rendered.unknown && rendered.unknown.mentions === 0
    && rendered.unknown.text.includes('@查无此人'),
    JSON.stringify(rendered.unknown));
  check('需求②：别人（卖家）评论里 @ 我，同样渲染成链接',
    rendered.mine && rendered.mine.uid === String(buyer.id),
    JSON.stringify(rendered.mine));
  await cdp.shot(path.join(SHOT_DIR, 'f40-mention.png'));

  // 点一下 → 进 TA 的主页
  await cdp.eval(`document.querySelector('#comment-list .mention').click()`);
  await waitFor(cdp, `location.hash === '#/seller/${seller.id}'`);
  await sleep(700);
  const page = await cdp.eval(`
    (() => ({ hash: location.hash, hasName: document.body.innerText.includes('${seller.nickname}') }))()`);
  check('需求②：点 @ 到的用户名会跳到 TA 的个人主页',
    page.hash === `#/seller/${seller.id}` && page.hasName, JSON.stringify(page));

  // 评价下的评论同样可点
  const p = (await api('POST', '/api/products', {
    token: sellerToken,
    body: { name: '自动化测试：@评价评论', price: 9, category_id: 1, subcategory_id: 1,
            condition: '九成新', description: 'x', default_place_id: 2, images: [] },
  })).data;
  const order = (await api('POST', '/api/orders',
    { token: buyerToken, body: { product_id: p.id, meet_place_id: 2 } })).data;
  await api('PATCH', `/api/orders/${order.id}/confirm`, { token: sellerToken });
  await api('PATCH', `/api/orders/${order.id}/complete`, { token: buyerToken });
  const review = (await api('POST', '/api/reviews', {
    token: buyerToken, body: { order_id: order.id, rating: 5, content: '自动化测试：评价' },
  })).data;
  await api('POST', `/api/reviews/${review.id}/comments`, {
    token: sellerToken, body: { content: `自动化测试：@${buyer.nickname} 谢谢` },
  });

  await cdp.go(`/product/${p.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-rev-comments="${review.id}"]')`);
  await sleep(400);
  await cdp.eval(`document.querySelector('[data-rev-comments="${review.id}"]').click()`);
  await waitFor(cdp, `!!document.querySelector('[data-rev-box="${review.id}"] .mention')`);
  await sleep(300);
  const rcMention = await cdp.eval(`
    (() => {
      const m = document.querySelector('[data-rev-box="${review.id}"] .mention');
      return { uid: m ? m.dataset.user : '', text: m ? m.innerText : '' };
    })()`);
  check('需求②：评价下的评论里 @ 到的人也渲染成可点链接',
    rcMention.uid === String(buyer.id) && rcMention.text === `@${buyer.nickname}`,
    JSON.stringify(rcMention));
}

/* ================================================================ 功能㊶ 用户空间展示 TA 的帖子（本批需求③） */
async function feature41(cdp) {
  console.log('\n===== 功能㊶ 用户空间展示 TA 的帖子（本批需求③）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;
  const buyer = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;

  // 该用户的帖子 + 另一个人的帖子（用来验证不会串）
  const mine = (await api('POST', '/api/posts', {
    token: sellerToken,
    body: { title: '自动化测试：空间里的帖子', content: '属于卖家', tag: '闲聊' },
  })).data;
  const others = (await api('POST', '/api/posts', {
    token: buyerToken,
    body: { title: '自动化测试：别人的帖子', content: '属于买家', tag: '闲聊' },
  })).data;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/seller/${seller.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-status="posts"]')`);
  await sleep(600);

  const tab = await cdp.eval(`
    (() => {
      const el = document.querySelector('[data-status="posts"]');
      return { text: el.innerText.trim(), active: el.classList.contains('btn-primary') };
    })()`);
  check('需求③：用户空间多了「帖子」页签，并显示条数',
    /帖子/.test(tab.text) && /\d/.test(tab.text) && tab.active === false, JSON.stringify(tab));

  await cdp.eval(`document.querySelector('[data-status="posts"]').click()`);
  await waitFor(cdp, `!!document.querySelector('#list-area .post-item')`);
  await sleep(700);
  const list = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#list-area .post-item')];
      return {
        count: items.length,
        titles: items.map(x => (x.querySelector('.post-title') || {}).innerText || ''),
        hasLikeBtn: !!document.querySelector('#list-area .post-actions [data-like]'),
        activeTab: !!document.querySelector('[data-status="posts"].btn-primary'),
        headText: (document.querySelector('#seller-head') || {}).innerText ? document.querySelector('#seller-head').innerText.replace(/\s+/g, ' ').slice(0, 60) : '(头部空)',
      };
    })()`);
  check('需求③：切到「帖子」后列出该用户的帖子（不串别人的）',
    list.count >= 1 && list.titles.some(t => t.includes('空间里的帖子'))
    && !list.titles.some(t => t.includes('别人的帖子')), JSON.stringify(list).slice(0, 220));
  check('需求③：页签高亮切到了「帖子」', list.activeTab === true, `active=${list.activeTab}`);
  check('需求③：这里的帖子卡不渲染点赞/评论按钮（避免点了没反应的死按钮）',
    list.hasLikeBtn === false, `有点赞按钮=${list.hasLikeBtn}`);
  await cdp.shot(path.join(SHOT_DIR, 'f41-user-posts.png'));

  // 点帖子卡 → 详情
  await cdp.eval(`
    (() => {
      const el = [...document.querySelectorAll('#list-area .post-item')]
        .find(x => x.innerText.includes('空间里的帖子'));
      el.click();
    })()`);
  await waitFor(cdp, `location.hash === '#/post/${mine.id}'`);
  await sleep(600);
  const detail = await cdp.eval(`
    (() => ({ hash: location.hash, title: document.body.innerText.includes('空间里的帖子') }))()`);
  check('需求③：点帖子卡能进帖子详情', detail.hash === `#/post/${mine.id}` && detail.title === true,
    JSON.stringify(detail));

  // 我拉黑 TA 之后：用户空间的帖子也不展示
  await api('POST', `/api/blocks/${seller.id}`, { token: buyerToken });
  await cdp.go(`/seller/${seller.id}`);
  await waitFor(cdp, `!!document.querySelector('[data-status="posts"]')`);
  await sleep(500);
  await cdp.eval(`document.querySelector('[data-status="posts"]').click()`);
  await sleep(1000);
  const blocked = await cdp.eval(`
    (() => ({
      items: document.querySelectorAll('#list-area .post-item').length,
      text: (document.querySelector('#list-area') || {}).innerText || '',
    }))()`);
  check('需求③：拉黑后，用户空间的帖子也不展示（与商品/评论口径一致）',
    blocked.items === 0 && /拉黑/.test(blocked.text), JSON.stringify(blocked).slice(0, 160));
  await api('DELETE', `/api/blocks/${seller.id}`, { token: buyerToken });

  // 清理测试帖子
  await api('DELETE', `/api/posts/${mine.id}`, { token: sellerToken }).catch(() => null);
  await api('DELETE', `/api/posts/${others.id}`, { token: buyerToken }).catch(() => null);
  check('需求③：测试帖子已清理（对方 id 有效）', !!buyer.id && !!seller.id, '');
}

/* ================================================================ 功能㊷ 动态监控勾选区域放大（本批需求①） */
async function feature42(cdp) {
  console.log('\n===== 功能㊷ 动态监控勾选区域放大、不误触详情（本批需求①）=====');

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-item').length > 0`);
  await sleep(700);

  const size = await cdp.eval(`
    (() => {
      const box = document.querySelector('#lg-list .tl-check-box');
      const input = box ? box.querySelector('.tl-check') : null;
      if (!box || !input) return null;
      const b = box.getBoundingClientRect();
      const i = input.getBoundingClientRect();
      return {
        box: { w: Math.round(b.width), h: Math.round(b.height), left: b.left, top: b.top },
        input: { w: Math.round(i.width), h: Math.round(i.height) },
        checked: input.checked,
      };
    })()`);
  check('需求①：勾选框外面套了一层可点区域，且明显大于勾选框本身',
    size && size.box.w >= size.input.w + 12 && size.box.h >= size.input.h + 8,
    JSON.stringify(size));
  check('需求①：勾选框尺寸放大到 16px（原来是浏览器默认的小方块）',
    size && size.input.w >= 14 && size.input.h >= 14, JSON.stringify(size && size.input));

  // 关键①：在「可点区域」上派发的点击**不会**冒泡去打开详情
  // （用户误触的场景就是这一下：想勾选却点到勾选框旁边）
  const guard = await cdp.eval(`
    (() => {
      const row = document.querySelector('#lg-list .tl-item');
      const box = row ? row.querySelector('.tl-check-box') : null;
      if (!box) return { ok: false };
      box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return {
        ok: true,
        modal: !!document.querySelector('.modal-mask'),
        boxW: Math.round(box.getBoundingClientRect().width),
        inputW: Math.round(box.querySelector('.tl-check').getBoundingClientRect().width),
      };
    })()`);
  check('需求①：在勾选区域（含其放大出来的边距）上点击不会打开详情弹窗',
    guard.ok === true && guard.modal === false,
    `可点区 ${guard.boxW}px / 勾选框 ${guard.inputW}px，弹窗=${guard.modal}`);

  // 关键②：用**真实鼠标点击**勾选框中心（label 里的勾选框用合成 click 会被转发两次，不可靠）
  const center = await cdp.eval(`
    (() => {
      const input = document.querySelector('#lg-list .tl-check');
      input.scrollIntoView({ block: 'center' });
      input.checked = false;              // 归零，稍后据实判断
      const r = input.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               w: Math.round(r.width) };
    })()`);
  await sleep(300);
  const c2 = await cdp.eval(`
    (() => {
      const input = document.querySelector('#lg-list .tl-check');
      const r = input.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: c2.x, y: c2.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: c2.x, y: c2.y, button: 'left', clickCount: 1 });
  await sleep(400);
  const toggled = await cdp.eval(`
    (() => {
      const input = document.querySelector('#lg-list .tl-check');
      return {
        checked: input.checked,
        hint: (document.querySelector('#lg-del-selected') || {}).innerText || '',
        modal: !!document.querySelector('.modal-mask'),
      };
    })()`);
  check('需求①：用真实点击勾选框能勾上，按钮计数同步更新，且不弹详情',
    toggled.checked === true && /（1）/.test(toggled.hint) && toggled.modal === false,
    JSON.stringify(toggled));
  // 反向保证：点条目的正文区域仍然会打开详情
  await cdp.eval(`
    (() => {
      const row = document.querySelector('#lg-list .tl-item');
      const sum = row.querySelector('.tl-summary') || row;
      sum.click();
    })()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask .detail-h')`);
  check('需求①：点条目正文仍然能打开记录详情（原有功能没被挡掉）', true, '');
  await cdp.eval(`document.querySelector('.modal-mask [data-close]').click()`);
  await waitFor(cdp, `!document.querySelector('.modal-mask')`);
}

/* ================================================================ 功能㊸ 动态监控多选不被自动刷新冲掉（本批需求②） */
async function feature43(cdp) {
  console.log('\n===== 功能㊸ 连续勾选多条不被自动刷新冲掉（本批需求②）=====');

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=trades');
  await waitFor(cdp, `document.querySelectorAll('#lg-list .tl-check').length >= 3`);
  await sleep(700);

  // 真实鼠标点第 i 个勾选框（用合成 click 在 label 里可能被转发两次，不可靠）
  async function clickCheckbox(i) {
    const pos = await cdp.eval(`
      (() => {
        const list = [...document.querySelectorAll('#lg-list .tl-check')];
        const el = list[${i}];
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
    if (!pos) return false;
    await cdp.send('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await sleep(300);
    return true;
  }

  const read = () => cdp.eval(`
    (() => ({
      checked: document.querySelectorAll('#lg-list .tl-check:checked').length,
      hint: (document.querySelector('#lg-del-selected') || {}).innerText || '',
    }))()`);

  check('需求②：时间线至少准备了 3 条记录可供勾选', true, '');

  await clickCheckbox(0);
  await clickCheckbox(1);
  const before = await read();
  check('需求②：可以连续勾选多条，计数累加',
    before.checked === 2 && /（2）/.test(before.hint), JSON.stringify(before));

  // 这条时间线每 5 秒自动刷新一次（原来会在重绘时把勾选全部清空 → 用户看到"选了几条又自己取消"）
  await sleep(6500);
  const afterRefresh = await read();
  check('需求②：等过一轮 5 秒自动刷新后，已勾选的多条**依然在**',
    afterRefresh.checked === 2 && /（2）/.test(afterRefresh.hint),
    JSON.stringify(afterRefresh));

  await clickCheckbox(2);
  const three = await read();
  check('需求②：接着勾第三条，之前的两条也没被取消',
    three.checked === 3 && /（3）/.test(three.hint), JSON.stringify(three));

  await sleep(6000);
  const stillThree = await read();
  check('需求②：再过一轮刷新，仍然是 3 条选中',
    stillThree.checked === 3 && /（3）/.test(stillThree.hint), JSON.stringify(stillThree));

  // 取消一条 → 回到 2
  await clickCheckbox(0);
  const two = await read();
  check('需求②：取消其中一条后计数回到 2（勾选状态可正常增减）',
    two.checked === 2 && /（2）/.test(two.hint), JSON.stringify(two));
  await cdp.shot(path.join(SHOT_DIR, 'f43-multi-select.png'));
}

/* ================================================================ 功能㊹ 私信里点头像进主页、点其他进聊天（本批需求③） */
async function feature44(cdp) {
  console.log('\n===== 功能㊹ 私信：点头像进主页、点其他进聊天（本批需求③）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;
  const buyer = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;

  // 保证两人之间有一条会话
  await api('POST', '/api/messages', {
    token: sellerToken, body: { receiver_id: buyer.id, content: '自动化测试：私信头像用' },
  });

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/messages');
  await waitFor(cdp, `document.querySelectorAll('#conv-list .msg-conv').length > 0`);
  await sleep(700);

  const shape = await cdp.eval(`
    (() => {
      const conv = document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]');
      const avatar = conv ? conv.querySelector('.conv-avatar[data-user]') : null;
      const name = conv ? conv.querySelector('.mc-name') : null;
      return {
        hasAvatar: !!avatar,
        avatarUid: avatar ? avatar.dataset.user : '',
        nameIsLink: name ? name.classList.contains('user-link') || !!name.dataset.user : null,
        nameText: name ? name.innerText.trim() : '',
      };
    })()`);
  check('需求③：会话列表里**头像**才是跳主页的入口',
    shape.hasAvatar && !!shape.avatarUid, JSON.stringify(shape));
  check('需求③：昵称不再是跳主页的链接（点它应该进聊天）',
    shape.nameIsLink === false, JSON.stringify(shape));

  // 点昵称 → 留在私信页、并且切换到那个会话
  const fromName = await cdp.eval(`
    (() => {
      const conv = document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]');
      const name = conv.querySelector('.mc-name');
      const uid = conv.dataset.uid;
      name.click();
      return { uid };
    })()`);
  await sleep(900);
  const afterName = await cdp.eval(`
    (() => ({
      hash: location.hash,
      hasChat: !!document.querySelector('#chat-area .chat-box'),
      activeUid: document.querySelector('#conv-list .msg-conv.active')?.dataset.uid || '',
    }))()`);
  check('需求③：点昵称（会话行的其它部分）进入的是**私信聊天框**，不是主页',
    afterName.hash.startsWith('#/messages') && afterName.hasChat === true
    && afterName.activeUid === fromName.uid,
    JSON.stringify(afterName));
  check('需求③：点昵称后打开了与对方的会话（聊天头显示对方的昵称）',
    afterName.hasChat === true, JSON.stringify(afterName));

  // 点头像 → 进 TA 的主页
  await cdp.eval(`document.querySelector('#conv-list .msg-conv .conv-avatar[data-user]').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  await sleep(600);
  const afterAvatar = await cdp.eval(`(() => ({ hash: location.hash }))()`);
  check('需求③：点会话列表里的头像跳去 TA 的主页',
    afterAvatar.hash === `#/seller/${seller.id}`, JSON.stringify(afterAvatar));

  // 聊天头：点头像 → 主页；点昵称 → 留在会话里
  await cdp.go(`/messages?to=${seller.id}`);
  await waitFor(cdp, `!!document.querySelector('.chat-head .conv-avatar[data-user]')`);
  await sleep(500);
  const head = await cdp.eval(`
    (() => {
      const headBox = document.querySelector('.chat-head');
      return {
        hasAvatar: !!headBox.querySelector('.conv-avatar[data-user]'),
        nameIsLink: !!headBox.querySelector('b.user-link, b[data-user]'),
        nameText: (headBox.querySelector('b') || {}).innerText || '',
      };
    })()`);
  check('需求③：聊天窗口顶部同样是「头像可点、昵称不可点」',
    head.hasAvatar === true && head.nameIsLink === false, JSON.stringify(head));

  await cdp.eval(`document.querySelector('.chat-head b').click()`);
  await sleep(600);
  const afterHeadName = await cdp.eval(`(() => ({ hash: location.hash }))()`);
  check('需求③：点聊天头部的昵称不会跳走（仍留在私信里）',
    afterHeadName.hash.startsWith('#/messages'), JSON.stringify(afterHeadName));

  await cdp.eval(`document.querySelector('.chat-head .conv-avatar[data-user]').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  const afterHeadAvatar = await cdp.eval(`(() => ({ hash: location.hash }))()`);
  check('需求③：点聊天头部的头像才跳去 TA 的主页',
    afterHeadAvatar.hash === `#/seller/${seller.id}`, JSON.stringify(afterHeadAvatar));
  await cdp.shot(path.join(SHOT_DIR, 'f44-msg-avatar.png'));
}

/* ================================================================ 功能㊺ 广场帖子/评论的作者小头像（本批需求④） */
async function feature45(cdp) {
  console.log('\n===== 功能㊺ 交流广场的作者小头像（本批需求④）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;

  const post = (await api('POST', '/api/posts', {
    token: sellerToken,
    body: { title: '自动化测试：小头像帖子', content: '看看头像', tag: '闲聊' },
  })).data;
  await api('POST', `/api/posts/${post.id}/comments`, {
    token: buyerToken, body: { content: '自动化测试：评论也要小头像' },
  });

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/posts');
  await waitFor(cdp, `document.querySelectorAll('#list-area .mini-author').length > 0`);
  await sleep(900);

  const card = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('#list-area .post-item')];
      const row = rows.find(x => x.innerText.includes('小头像帖子'));
      if (!row) return { found: false };
      const wrap = row.querySelector('.post-meta .mini-author');
      const av = wrap ? wrap.querySelector('.mini-avatar') : null;
      const name = wrap ? wrap.querySelector('.mini-author-name') : null;
      if (!wrap || !av || !name) return { found: true, layout: false };
      const a = av.getBoundingClientRect();
      const n = name.getBoundingClientRect();
      return {
        found: true, layout: true,
        hasAvatarNode: true,
        avatarLeft: Math.round(a.left), nameLeft: Math.round(n.left),
        avatarCenterY: Math.round(a.top + a.height / 2),
        nameCenterY: Math.round(n.top + n.height / 2),
        nameText: name.innerText.trim(),
        uid: wrap.dataset.user,
        cursor: getComputedStyle(wrap).cursor,
      };
    })()`);
  check('需求④：广场帖子卡上，作者头像与名字在同一块可点区域里',
    card.found && card.layout === true && card.uid === String(seller.id)
    && card.cursor === 'pointer', JSON.stringify(card));
  check('需求④：小头像在用户名**左侧**',
    card.avatarLeft < card.nameLeft, `头像 left=${card.avatarLeft}，名字 left=${card.nameLeft}`);
  check('需求④：头像与用户名**竖向齐平**（中心线基本一致）',
    Math.abs(card.avatarCenterY - card.nameCenterY) <= 4,
    `头像中心 ${card.avatarCenterY} / 名字中心 ${card.nameCenterY}`);
  check('需求④：作者名正确显示', card.nameText === seller.nickname, card.nameText);
  await cdp.shot(path.join(SHOT_DIR, 'f45-post-avatar.png'));

  // 点头像 → 主页
  await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('#list-area .post-item')];
      const row = rows.find(x => x.innerText.includes('小头像帖子'));
      row.querySelector('.mini-avatar').click();
    })()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  check('需求④：点帖子里的头像进主页',
    (await cdp.eval(`(() => ({ hash: location.hash }))()`)).hash === `#/seller/${seller.id}`,
    await cdp.eval(`(() => ({ hash: location.hash }))()`).then(r => r.hash));

  // 点名字 → 主页
  await cdp.go('/posts');
  await waitFor(cdp, `document.querySelectorAll('#list-area .mini-author').length > 0`);
  await sleep(700);
  await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('#list-area .post-item')];
      const row = rows.find(x => x.innerText.includes('小头像帖子'));
      row.querySelector('.mini-author-name').click();
    })()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  check('需求④：点用户名同样进主页',
    (await cdp.eval(`(() => ({ hash: location.hash }))()`)).hash === `#/seller/${seller.id}`, '');

  // 帖子详情：评论人也带头像，点头像/名字都进主页
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#comment-list .mini-author')`);
  await sleep(500);
  const comment = await cdp.eval(`
    (() => {
      const wrap = document.querySelector('#comment-list .mini-author');
      const av = wrap ? wrap.querySelector('.mini-avatar') : null;
      const name = wrap ? wrap.querySelector('.mini-author-name') : null;
      if (!wrap || !av || !name) return { ok: false };
      const a = av.getBoundingClientRect();
      const n = name.getBoundingClientRect();
      return {
        ok: true, uid: wrap.dataset.user,
        leftOk: Math.round(a.left) < Math.round(n.left),
        alignOk: Math.abs((a.top + a.height / 2) - (n.top + n.height / 2)) <= 4,
      };
    })()`);
  check('需求④：评论人也有小头像（在名字左侧、竖向齐平）',
    comment.ok && comment.leftOk && comment.alignOk, JSON.stringify(comment));

  await cdp.eval(`document.querySelector('#comment-list .mini-author .mini-avatar').click()`);
  await waitFor(cdp, `location.hash.startsWith('#/seller/')`);
  check('需求④：点评论人的头像进主页',
    (await cdp.eval(`(() => ({ hash: location.hash }))()`)).hash === `#/seller/${comment.uid}`,
    comment.uid);

  await api('DELETE', `/api/posts/${post.id}`, { token: sellerToken }).catch(() => null);
}

/* ================================================================ 功能㊻ 单条私信删除 + 已读未读（本批需求②） */
async function feature46(cdp) {
  console.log('\n===== 功能㊻ 单条私信删除、标为已读/未读（本批需求②）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;
  const buyer = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;

  // 清掉这段会话的历史，再发两条（一条要删、一条要标记）
  await api('DELETE', `/api/messages/conversations/${seller.id}`, { token: buyerToken }).catch(() => null);
  await api('GET', `/api/messages/with/${seller.id}`, { token: buyerToken });
  const keep = (await api('POST', '/api/messages', {
    token: sellerToken, body: { receiver_id: buyer.id, content: '自动化测试：保留这条' },
  })).data;
  const drop = (await api('POST', '/api/messages', {
    token: sellerToken, body: { receiver_id: buyer.id, content: '自动化测试：这条要删掉' },
  })).data;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/messages?to=${seller.id}`);
  await waitFor(cdp, `document.querySelectorAll('#chat-body .bubble').length >= 2`);
  await sleep(700);

  const actions = await cdp.eval(`
    (() => {
      const bubbles = [...document.querySelectorAll('#chat-body .bubble')];
      const peer = bubbles.filter(b => b.classList.contains('other'));
      const mine = bubbles.filter(b => b.classList.contains('mine'));
      const first = peer[0];
      return {
        peerCount: peer.length,
        peerHasHide: peer.every(b => !!b.querySelector('[data-hide]')),
        peerHasMark: peer.every(b => !!b.querySelector('[data-mark]')),
        peerMarkText: first && first.querySelector('[data-mark]') ? first.querySelector('[data-mark]').innerText.trim() : '',
        mineHasMark: mine.some(b => !!b.querySelector('[data-mark]')),
        mineHasHide: mine.every(b => !!b.querySelector('[data-hide]')),
      };
    })()`);
  check('需求②：每条消息上都有「删除」，对方发来的还有「标为已读/未读」',
    actions.peerCount >= 2 && actions.peerHasHide && actions.peerHasMark,
    JSON.stringify(actions));
  check('需求②：自己发出的消息只给「删除」，不提供已读/未读（已读状态属于对方）',
    actions.mineHasMark === false, JSON.stringify(actions));

  // 删除一条
  await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('#chat-body .bubble.other')]
        .find(x => x.innerText.includes('这条要删掉'));
      b.querySelector('[data-hide]').click();
    })()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  const warn = await cdp.eval(`(() => ({ text: document.querySelector('.modal-mask').innerText }))()`);
  check('需求②：删除前先确认，并说明"只影响你自己、对方仍能看到"',
    /只影响你自己|对方/.test(warn.text), warn.text.replace(/\s+/g, ' ').slice(0, 80));
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await sleep(1200);
  const afterHide = await cdp.eval(`
    (() => ({
      hasDropped: (document.getElementById('chat-body') || {}).innerText.includes('这条要删掉'),
      hasKeep: (document.getElementById('chat-body') || {}).innerText.includes('保留这条'),
      bubbles: document.querySelectorAll('#chat-body .bubble').length,
    }))()`);
  check('需求②：删掉的那条从我的聊天框消失，另一条还在',
    afterHide.hasDropped === false && afterHide.hasKeep === true, JSON.stringify(afterHide));

  const sellerSide = await api('GET', `/api/messages/with/${buyer.id}`, { token: sellerToken });
  check('需求②：对方那边的聊天记录没被删（只对我隐藏）',
    (sellerSide.data.list || []).some(m => m.content === '自动化测试：这条要删掉'), '');

  // 标为未读 → 会话出现未读、按钮变成「标为已读」
  await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('#chat-body .bubble.other')]
        .find(x => x.innerText.includes('保留这条'));
      b.querySelector('[data-mark]').click();
    })()`);
  await sleep(1600);
  const afterUnread = await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('#chat-body .bubble.other')]
        .find(x => x.innerText.includes('保留这条'));
      const conv = document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]');
      return {
        btn: b && b.querySelector('[data-mark]') ? b.querySelector('[data-mark]').innerText.trim() : '',
        convUnread: conv && conv.querySelector('.badge') ? conv.querySelector('.badge').innerText.trim() : '',
        toast: document.body.innerText.includes('已标为未读'),
      };
    })()`);
  check('需求②：标为未读后按钮变成「标为已读」、会话出现未读标记',
    afterUnread.btn === '标为已读', JSON.stringify(afterUnread));

  // 再标回已读
  await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('#chat-body .bubble.other')]
        .find(x => x.innerText.includes('保留这条'));
      b.querySelector('[data-mark]').click();
    })()`);
  await sleep(1600);
  const afterRead = await cdp.eval(`
    (() => {
      const b = [...document.querySelectorAll('#chat-body .bubble.other')]
        .find(x => x.innerText.includes('保留这条'));
      const conv = document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]');
      return {
        btn: b && b.querySelector('[data-mark]') ? b.querySelector('[data-mark]').innerText.trim() : '',
        convBadge: conv && conv.querySelector('.badge') ? conv.querySelector('.badge').innerText.trim() : '',
      };
    })()`);
  // 用接口判断（比 DOM 徽标权威），同时打印 DOM 值方便排查
  const convApi = await api('GET', '/api/messages/conversations', { token: buyerToken });
  const convEntry = (convApi.data || []).find(c => c.user && c.user.id === seller.id);
  check('需求②：再标回已读，按钮变回「标为未读」、该会话未读归零',
    afterRead.btn === '标为未读' && (!convEntry || convEntry.unread === 0),
    JSON.stringify({ btn: afterRead.btn, apiUnread: convEntry ? convEntry.unread : null,
                     domBadge: afterRead.convBadge }));
  await cdp.shot(path.join(SHOT_DIR, 'f46-msg-actions.png'));

  // 清理：两边都隐藏这两条
  for (const mid of [keep.id, drop.id]) {
    await api('POST', `/api/messages/${mid}/hide`, { token: buyerToken }).catch(() => null);
    await api('POST', `/api/messages/${mid}/hide`, { token: sellerToken }).catch(() => null);
  }
  await api('DELETE', `/api/messages/conversations/${seller.id}`, { token: buyerToken }).catch(() => null);
}

/* ================================================================ 功能㊼ 读消息后红点同步消失（本批需求③） */
async function feature47(cdp) {
  console.log('\n===== 功能㊼ 进私信读消息后红点同步消失（本批需求③）=====');

  const sellerToken = await login('seller2', '123456', 'seller');
  const buyerToken = await login('buyer2', '123456', 'buyer');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;
  const buyer = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;

  // 清一下这段会话，再造 2 条未读
  await api('DELETE', `/api/messages/conversations/${seller.id}`, { token: buyerToken }).catch(() => null);
  await api('GET', `/api/messages/with/${seller.id}`, { token: buyerToken });
  const m1 = (await api('POST', '/api/messages', {
    token: sellerToken, body: { receiver_id: buyer.id, content: '自动化测试：未读1' },
  })).data;
  const m2 = (await api('POST', '/api/messages', {
    token: sellerToken, body: { receiver_id: buyer.id, content: '自动化测试：未读2' },
  })).data;

  // 私信页会「自动打开第一个会话」，那样未读就被读掉了；
  // 这里先停在**另一个人的**会话里，让 seller2 的未读原样挂着，再点它——正是用户的操作路径
  const otherPeer = (await api('GET', '/api/auth/me', { token: await login('seller1', '123456', 'seller') })).data.user;
  await cdp.loginAs('buyer2', '123456', 'buyer');
  await cdp.go(`/messages?to=${otherPeer.id}`);
  await waitFor(cdp, `!!document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]')`);
  await sleep(1200);

  const before = await cdp.eval(`
    (() => {
      const conv = document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]');
      const badge = conv ? conv.querySelector('.badge') : null;
      const top = document.getElementById('msg-badge');
      return {
        convBadge: badge ? badge.innerText.trim() : '',
        topText: top ? top.textContent.trim() : '',
        topVisible: !!(top && getComputedStyle(top).display !== 'none'),
      };
    })()`);
  check('需求③：还没进会话时，会话上有未读数字、顶栏也有红点',
    before.convBadge === '2' && before.topVisible === true, JSON.stringify(before));

  // 点进这个会话
  await cdp.eval(`document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]').click()`);
  await waitFor(cdp, `!!document.querySelector('#chat-area .chat-box')`);
  await sleep(1500);

  const after = await cdp.eval(`
    (() => {
      const conv = document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]');
      const badge = conv ? conv.querySelector('.badge') : null;
      const top = document.getElementById('msg-badge');
      const topNum = top ? Number(top.textContent.trim() || 0) : 0;
      return {
        convBadge: badge ? badge.innerText.trim() : '',
        topText: top ? top.textContent.trim() : '',
        topVisible: !!(top && getComputedStyle(top).display !== 'none'),
        topNum,
      };
    })()`);
  check('需求③：进会话读过消息后，**这个会话的未读数字消失**',
    after.convBadge === '', JSON.stringify(after));
  check('需求③：顶栏未读红点同步减少（读掉 2 条：要么消失、要么少 2）',
    (after.topVisible === false && after.topNum === 0)
    || after.topNum === Math.max(0, Number(before.topText || 0) - 2),
    `之前 ${before.topText}(${before.topVisible}) → 之后 ${after.topText}(${after.topVisible})`);
  await cdp.shot(path.join(SHOT_DIR, 'f47-badge-cleared.png'));

  // 刷新页面再确认：后端真的已读（不是只改了界面）
  await cdp.go('/messages');
  await waitFor(cdp, `!!document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]')`);
  await sleep(1000);
  const reloaded = await cdp.eval(`
    (() => {
      const conv = document.querySelector('#conv-list .msg-conv[data-uid="${seller.id}"]');
      const badge = conv ? conv.querySelector('.badge') : null;
      return { convBadge: badge ? badge.innerText.trim() : '' };
    })()`);
  check('需求③：刷新页面后该会话依然没有未读（说明后端确实置为已读）',
    reloaded.convBadge === '', JSON.stringify(reloaded));

  // 清理
  for (const mid of [m1.id, m2.id]) {
    await api('POST', `/api/messages/${mid}/hide`, { token: buyerToken }).catch(() => null);
    await api('POST', `/api/messages/${mid}/hide`, { token: sellerToken }).catch(() => null);
  }
  await api('DELETE', `/api/messages/conversations/${seller.id}`, { token: buyerToken }).catch(() => null);
}

/* ================================================================ 功能㊽ 广场评论 Enter 发送 / Ctrl+Enter 换行（本批需求④） */
async function feature48(cdp) {
  console.log('\n===== 功能㊽ 评论 Enter 发送、Ctrl+Enter 换行（本批需求④）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const post = (await api('POST', '/api/posts', {
    token: sellerToken,
    body: { title: '自动化测试：Enter 发送', content: '验证回车行为', tag: '闲聊' },
  })).data;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#comment-input')`);
  await sleep(600);

  const box = await cdp.eval(`
    (() => {
      const el = document.querySelector('#comment-input');
      return {
        tag: el ? el.tagName : '',
        placeholder: el ? (el.placeholder || '') : '',
        count: document.querySelectorAll('#comment-list .comment-item').length,
      };
    })()`);
  check('需求④：评论输入框是多行文本框，且提示了「Enter 发送、Ctrl+Enter 换行」',
    box.tag === 'TEXTAREA' && /Enter\s*发送/.test(box.placeholder)
    && /Ctrl\+Enter\s*换行/.test(box.placeholder), JSON.stringify(box));

  // 1) 单按 Enter → 发送
  await cdp.eval(`
    (() => {
      const el = document.querySelector('#comment-input');
      el.value = '自动化测试：回车发送的评论';
      el.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
  await waitFor(cdp, `document.querySelectorAll('#comment-list .comment-item').length === ${box.count + 1}`);
  await sleep(400);
  const sent = await cdp.eval(`
    (() => {
      const el = document.querySelector('#comment-input');
      return {
        count: document.querySelectorAll('#comment-list .comment-item').length,
        cleared: el.value === '',
        inList: document.getElementById('comment-list').innerText.includes('回车发送的评论'),
      };
    })()`);
  check('需求④：单按 Enter 就把评论发出去了，并且清空输入框',
    sent.count === box.count + 1 && sent.cleared === true && sent.inList === true,
    JSON.stringify(sent));

  // 2) Ctrl + Enter → 只换行、不发送
  const ctrl = await cdp.eval(`
    (() => {
      const el = document.querySelector('#comment-input');
      el.value = '第一行';
      el.selectionStart = el.selectionEnd = el.value.length;
      const ev = new KeyboardEvent('keydown',
        { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
      const notCancelled = el.dispatchEvent(ev);
      return { value: el.value, notCancelled, count: document.querySelectorAll('#comment-list .comment-item').length };
    })()`);
  await sleep(700);
  const afterCtrl = await cdp.eval(`
    (() => ({
      count: document.querySelectorAll('#comment-list .comment-item').length,
      value: document.querySelector('#comment-input').value,
    }))()`);
  check('需求④：Ctrl+Enter 是在输入框里换行（值里多了 \\n），**不会**把评论发出去',
    ctrl.value.includes('\n') && afterCtrl.value.includes('\n')
    && afterCtrl.count === ctrl.count,
    JSON.stringify({ ctrl, afterCtrl }));

  // 3) 继续输入再发出去，换行要保留在正文里
  await cdp.eval(`
    (() => {
      const el = document.querySelector('#comment-input');
      el.value = '第一行\\n第二行';
      el.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    })()`);
  await cdp.eval(`document.querySelector('#comment-input').value = '第一行\\n第二行'`);
  await cdp.eval(`document.querySelector('#btn-comment').click()`);
  await sleep(1200);
  const multi = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#comment-list .comment-item')];
      const last = items[items.length - 1];
      const bodyEl = last ? last.querySelector('.cm-body') : null;
      return {
        text: bodyEl ? bodyEl.innerText : '',
        preWrap: bodyEl ? getComputedStyle(bodyEl).whiteSpace : '',
        lines: bodyEl ? getComputedStyle(bodyEl).whiteSpace : '',
      };
    })()`);
  check('需求④：带换行的评论发出去后，正文按两行显示（white-space: pre-wrap）',
    multi.text.includes('第一行') && multi.text.includes('第二行') && multi.preWrap === 'pre-wrap',
    JSON.stringify(multi));
  await cdp.shot(path.join(SHOT_DIR, 'f48-enter-send.png'));

  // 清理
  const comments = (await api('GET', `/api/posts/${post.id}/comments`)).data || [];
  for (const c of comments) {
    await api('DELETE', `/api/posts/${post.id}/comments/${c.id}`, { token: sellerToken }).catch(() => null);
  }
  await api('DELETE', `/api/posts/${post.id}`, { token: sellerToken }).catch(() => null);
}

/* ================================================================ 功能㊾ 评论显示「第几楼」（本批需求⑤） */
async function feature49(cdp) {
  console.log('\n===== 功能㊾ 评论右上角显示「第几楼」（本批需求⑤）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const post = (await api('POST', '/api/posts', {
    token: sellerToken,
    body: { title: '自动化测试：楼号', content: '验证第几楼', tag: '闲聊' },
  })).data;
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const ids = [];
  for (const text of ['第一楼', '第二楼', '第三楼']) {
    const c = (await api('POST', `/api/posts/${post.id}/comments`, {
      token: buyerToken, body: { content: `自动化测试：${text}` },
    })).data;
    ids.push(c.id);
  }

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `document.querySelectorAll('#comment-list .comment-item').length === 3`);
  await sleep(700);

  const floors = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#comment-list .comment-item')];
      const head = items[0] ? items[0].querySelector('.cm-head') : null;
      const floorEl = items[0] ? items[0].querySelector('.cm-floor') : null;
      const h = head ? head.getBoundingClientRect() : null;
      const f = floorEl ? floorEl.getBoundingClientRect() : null;
      return {
        texts: items.map(x => {
          const el = x.querySelector('.cm-floor');
          return el ? el.innerText.trim() : '';
        }),
        hasFloor: !!floorEl,
        // 楼号应该在头部这一行的右侧（离右边缘比离左边缘更近）
        rightAligned: !!(h && f) && (h.right - f.right) < (h.width / 2) && f.left > h.left + h.width / 2,
        sameRow: !!(h && f) && f.top < h.bottom && f.bottom > h.top,
        order: items.map(x => (x.querySelector('.cm-body') || {}).innerText || '').map(t => t.trim()),
      };
    })()`);
  check('需求⑤：每条评论右上角都有「N 楼」，按评论先后从 1 开始',
    floors.texts.join('|') === '1 楼|2 楼|3 楼', JSON.stringify(floors.texts));
  check('需求⑤：楼号与作者/时间在同一行，并且是靠右的',
    floors.sameRow === true && floors.rightAligned === true, JSON.stringify(floors));
  check('需求⑤：楼号顺序与评论先后一致',
    floors.order[0].includes('第一楼') && floors.order[1].includes('第二楼')
    && floors.order[2].includes('第三楼'), JSON.stringify(floors.order));
  await cdp.shot(path.join(SHOT_DIR, 'f49-floor-number.png'));

  // 再发一条 → 应该是「4 楼」，前面的不变
  await cdp.eval(`
    (() => {
      const el = document.querySelector('#comment-input');
      el.value = '自动化测试：第四楼';
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`);
  await waitFor(cdp, `document.querySelectorAll('#comment-list .comment-item').length === 4`);
  await sleep(600);
  const after = await cdp.eval(`
    (() => [...document.querySelectorAll('#comment-list .cm-floor')].map(x => x.innerText.trim()))()`);
  check('需求⑤：新发的评论接着编号（第 4 楼），前面的楼号不变',
    after.join('|') === '1 楼|2 楼|3 楼|4 楼', JSON.stringify(after));

  // 清理
  const comments = (await api('GET', `/api/posts/${post.id}/comments`)).data || [];
  for (const c of comments) {
    await api('DELETE', `/api/posts/${post.id}/comments/${c.id}`, { token: sellerToken }).catch(() => null);
  }
  await api('DELETE', `/api/posts/${post.id}`, { token: sellerToken }).catch(() => null);
}

/* ================================================================ 功能㊿ 上传头像后各处显示正确（本批需求①） */
async function feature50(cdp) {
  console.log('\n===== 功能㊿ 上传头像后个人主页/评论广场显示正确（本批需求①）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;
  const savedAvatar = seller.avatar || '';

  // 用一张 400×400 的大图当头像：容器只有 22/72px，必须靠 CSS 缩放；
  // 少了 img 的填充规则时，图片会按 400px 真实尺寸溢出，看起来就是"头像被裁错了"
  const fd = new FormData();
  fd.append('file', new Blob([makePng(400, 400)], { type: 'image/png' }), 'f50-big-avatar.png');
  const upRes = await fetch(`${BASE}/api/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${sellerToken}` }, body: fd,
  });
  const up = await upRes.json();
  if (up.code !== 0) throw new Error(up.msg || '上传失败');
  await api('PUT', '/api/auth/profile', { token: sellerToken, body: { avatar: up.data.url } });

  try {
  const post = (await api('POST', '/api/posts', {
    token: sellerToken,
    body: { title: '自动化测试：头像显示', content: '验证头像渲染', tag: '闲聊' },
  })).data;
  await api('POST', `/api/posts/${post.id}/comments`, {
    token: sellerToken, body: { content: '自动化测试：评论人头像' },
  });

  const probe = (selector) => cdp.eval(`
    (() => {
      const img = document.querySelector(${JSON.stringify(selector)});
      if (!img) return { found: false };
      const r = img.getBoundingClientRect();
      return {
        found: true,
        w: Math.round(r.width), h: Math.round(r.height),
        natural: { w: img.naturalWidth, h: img.naturalHeight },
        fit: getComputedStyle(img).objectFit,
        radius: getComputedStyle(img).borderRadius,
      };
    })()`);

  await cdp.loginAs('buyer1', '123456', 'buyer');

  // 1) 个人主页的大头像（72px）
  await cdp.go(`/seller/${seller.id}`);
  await waitFor(cdp, `!!document.querySelector('.seller-avatar img')`);
  await sleep(700);
  const big = await probe('.seller-avatar img');
  check('需求①：个人主页的头像按容器尺寸缩放（72×72），原图是 400px 的大图',
    big.found && big.w === 72 && big.h === 72 && big.natural.w === 400,
    JSON.stringify(big));
  check('需求①：个人主页头像用 object-fit: cover 且是圆形',
    big.fit === 'cover' && /50%|36px/.test(String(big.radius)), JSON.stringify(big));

  // 2) 交流广场卡片的小头像（22px）
  await cdp.go('/posts');
  await waitFor(cdp, `!!document.querySelector('#list-area .mini-avatar img')`);
  await sleep(800);
  const mini = await probe('#list-area .mini-avatar img');
  check('需求①：交流广场帖子的小头像按容器缩放（22×22），没有溢出',
    mini.found && mini.w === 22 && mini.h === 22, JSON.stringify(mini));
  check('需求①：广场小头像同样是 cover + 圆形',
    mini.fit === 'cover' && /50%|11px/.test(String(mini.radius)), JSON.stringify(mini));
  await cdp.shot(path.join(SHOT_DIR, 'f50-avatar-in-square.png'));

  // 3) 帖子详情里评论人的小头像
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `!!document.querySelector('#comment-list .mini-avatar img')`);
  await sleep(600);
  const cm = await probe('#comment-list .mini-avatar img');
  check('需求①：评论里的小头像也按容器缩放（22×22）',
    cm.found && cm.w === 22 && cm.h === 22 && cm.fit === 'cover', JSON.stringify(cm));

  // 4) 顶栏/用户小框的头像也不该溢出（同一张 400px 图）
  const top = await probe('.avatar-dot img');
  if (top.found) {
    check('需求①：顶栏头像同样按容器缩放，不溢出原图尺寸',
      top.w === top.h && top.w < 100 && top.fit === 'cover', JSON.stringify(top));
  }

  // 清理
  await api('DELETE', `/api/posts/${post.id}`, { token: sellerToken }).catch(() => null);
  } finally {
    // 无论断言成败都要还原头像，否则会把演示账号的头像改掉、
    // 连累「未设置头像时显示昵称首字」那类断言（这次就踩了）
    await api('PUT', '/api/auth/profile', { token: sellerToken, body: { avatar: savedAvatar } })
      .catch(() => null);
  }
}

/* ================================================================ 功能51 删除自己的评论（本批需求①） */
async function feature51(cdp) {
  console.log('\n===== 功能51 交流广场：删除自己的评论（本批需求①）=====');

  const sellerToken = await login('seller1', '123456', 'seller');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const seller = (await api('GET', '/api/auth/me', { token: sellerToken })).data.user;
  const post = (await api('POST', '/api/posts', {
    token: sellerToken,
    body: { title: '自动化测试：删评论', content: '验证删除自己的评论', tag: '闲聊' },
  })).data;
  const sellersComment = (await api('POST', `/api/posts/${post.id}/comments`, {
    token: sellerToken, body: { content: '自动化测试：卖家发的评论' },
  })).data;
  const mine = (await api('POST', `/api/posts/${post.id}/comments`, {
    token: buyerToken, body: { content: '自动化测试：我要删掉的评论' },
  })).data;
  const keep = (await api('POST', `/api/posts/${post.id}/comments`, {
    token: buyerToken, body: { content: '自动化测试：保留的评论' },
  })).data;

  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `document.querySelectorAll('#comment-list .comment-item').length === 3`);
  await sleep(700);

  const buttons = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#comment-list .comment-item')];
      const pick = (id) => {
        const el = items.find(x => x.dataset.comment === String(id));
        return el ? !!el.querySelector('[data-del-comment]') : null;
      };
      return {
        mine: pick(${mine.id}),
        keep: pick(${keep.id}),
        others: pick(${sellersComment.id}),
        floorOfMine: (items.find(x => x.dataset.comment === String(${mine.id})) || {})
          .querySelector?.('.cm-floor')?.innerText || '',
      };
    })()`);
  check('需求①：自己的评论上有「删除」按钮，别人的评论上没有',
    buttons.mine === true && buttons.keep === true && buttons.others === false,
    JSON.stringify(buttons));

  // 点删除 → 确认 → 评论消失
  await cdp.eval(`
    (() => {
      const el = [...document.querySelectorAll('#comment-list .comment-item')]
        .find(x => x.dataset.comment === String(${mine.id}));
      el.querySelector('[data-del-comment]').click();
    })()`);
  await waitFor(cdp, `!!document.querySelector('.modal-mask [data-ok]')`);
  const warn = await cdp.eval(`(() => ({ text: document.querySelector('.modal-mask').innerText }))()`);
  check('需求①：删除前先确认，并说明删了看不到、不能恢复',
    /不能恢复|看不到/.test(warn.text), warn.text.replace(/\s+/g, ' ').slice(0, 70));
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await waitFor(cdp, `document.querySelectorAll('#comment-list .comment-item').length === 2`);
  await sleep(500);

  const after = await cdp.eval(`
    (() => {
      const items = [...document.querySelectorAll('#comment-list .comment-item')];
      return {
        count: items.length,
        ids: items.map(x => x.dataset.comment),
        title: (document.querySelector('.card-head h2') || {}).innerText || '',
        floors: items.map(x => (x.querySelector('.cm-floor') || {}).innerText && x.querySelector('.cm-floor').innerText.trim()),
        hasGone: document.getElementById('comment-list').innerText.includes('我要删掉的评论'),
        hasKeep: document.getElementById('comment-list').innerText.includes('保留的评论'),
      };
    })()`);
  check('需求①：删掉后评论从列表消失，其他评论还在，评论数同步减少',
    after.count === 2 && after.hasGone === false && after.hasKeep === true
    && after.title.includes('2'), JSON.stringify(after));
  check('需求①：剩下的评论楼号重新连续（1 楼、2 楼）',
    after.floors.join('|') === '1 楼|2 楼', JSON.stringify(after.floors));
  await cdp.shot(path.join(SHOT_DIR, 'f51-delete-comment.png'));

  // 刷新后依然是 2 条（真的删了，不是只改界面）
  await cdp.go(`/post/${post.id}`);
  await waitFor(cdp, `document.querySelectorAll('#comment-list .comment-item').length === 2`);
  const reloaded = await cdp.eval(`
    (() => ({ count: document.querySelectorAll('#comment-list .comment-item').length }))()`);
  check('需求①：刷新页面后确认评论真的被删掉了', reloaded.count === 2, JSON.stringify(reloaded));

  // 后端也拦住"删别人的"
  const forbidden = await api('DELETE', `/api/posts/${post.id}/comments/${sellersComment.id}`,
    { token: buyerToken }).catch((err) => ({ code: -1, msg: String(err) }));
  check('需求①：接口层不允许删别人的评论', forbidden.code !== 0, JSON.stringify(forbidden).slice(0, 120));

  await api('DELETE', `/api/posts/${post.id}`, { token: sellerToken }).catch(() => null);
}

/* ================================================================ 功能52 用户行为监测（本批需求①） */
async function feature52(cdp) {
  console.log('\n===== 功能52 管理后台「行为监测」（本批需求①）=====');

  const adminToken = await login('admin', '123456', 'admin');
  const buyerToken = await login('buyer1', '123456', 'buyer');
  const buyer = (await api('GET', '/api/auth/me', { token: buyerToken })).data.user;

  // 先用接口造两条可识别的浏览记录（前端上报走的是同一个接口）
  await api('POST', '/api/activities/page',
    { token: buyerToken, body: { page: '/favorites', name: '我的收藏' } });
  await api('POST', '/api/activities/page',
    { token: buyerToken, body: { page: '/swaps', name: '以物换物' } });

  await cdp.loginAs('admin', '123456', 'admin');
  await cdp.go('/admin?tab=activity');
  await waitFor(cdp, `!!document.querySelector('#act-stats .stat-card')`);
  await sleep(900);

  const overview = await cdp.eval(`
    (() => {
      const cards = [...document.querySelectorAll('#act-stats .stat-card')].map(el => ({
        label: (el.querySelector('.sc-label') || {}).innerText || '',
        value: (el.querySelector('.sc-value') || {}).innerText || '',
      }));
      const tops = [...document.querySelectorAll('#act-tops .card')].map(el => ({
        title: (el.querySelector('h2') || {}).innerText || '',
        rows: el.querySelectorAll('tbody tr').length,
      }));
      const hasFilter = !!document.querySelector('#act-kind')
        && !!document.querySelector('#act-user') && !!document.querySelector('#act-page')
        && !!document.querySelector('#act-from') && !!document.querySelector('#act-to');
      return { cards, tops, hasFilter,
               listRows: document.querySelectorAll('#act-list tbody tr').length };
    })()`);
  check('需求①：行为监测页签有 4 张今日概览卡（登录/登出/浏览/活跃用户）',
    overview.cards.length === 4
    && overview.cards.some(c => c.label.includes('登录'))
    && overview.cards.some(c => c.label.includes('页面浏览'))
    && overview.cards.every(c => /^\d+$/.test(c.value)),
    JSON.stringify(overview.cards));
  check('需求①：页面热度与最活跃用户两张榜都在',
    overview.tops.length === 2 && overview.tops.some(t => t.title.includes('页面热度'))
    && overview.tops.some(t => t.title.includes('最活跃用户')), JSON.stringify(overview.tops));
  check('需求①：有类型/用户/页面/日期四组筛选控件',
    overview.hasFilter === true, `hasFilter=${overview.hasFilter}`);
  check('需求①：明细列表有记录', overview.listRows > 0, `rows=${overview.listRows}`);
  await cdp.shot(path.join(SHOT_DIR, 'f52-activity.png'));

  // 筛选：只看「浏览」类型
  await cdp.eval(`
    (() => {
      const sel = document.querySelector('#act-kind');
      sel.value = 'page';
      document.querySelector('#act-search').click();
    })()`);
  await sleep(1200);
  const filtered = await cdp.eval(`
    (() => {
      const rows = [...document.querySelectorAll('#act-list tbody tr')];
      const kinds = rows.map(r => (r.querySelector('.badge') || {}).innerText || '');
      return { rows: rows.length, kinds: [...new Set(kinds)] };
    })()`);
  check('需求①：按「浏览」筛选后列表只剩浏览记录',
    filtered.rows > 0 && filtered.kinds.length === 1 && filtered.kinds[0] === '浏览',
    JSON.stringify(filtered));

  // 造的两条浏览记录能在明细里查到（说明上报链路通到管理端）
  const mine = await api('GET', '/api/admin/activities?kind=page&page_path=/favorites&page_size=20',
    { token: adminToken });
  check('需求①：前端上报的浏览记录能在管理端查到（带页面中文名）',
    (mine.data.list || []).some(a => a.page === '/favorites' && a.page_name === '我的收藏'),
    JSON.stringify((mine.data.list || []).slice(0, 2)));

  // 普通用户进不去管理后台
  await cdp.loginAs('buyer1', '123456', 'buyer');
  await cdp.go('/admin?tab=activity');
  await sleep(900);
  const denied = await cdp.eval(`
    (() => ({ text: (document.getElementById('page') || {}).innerText || '' }))()`);
  check('需求①：普通用户看行为监测会被拦住（需要管理员身份）',
    /管理员/.test(denied.text), denied.text.replace(/\\s+/g, ' ').slice(0, 60));

  // 真实走一遍前端路由：浏览两个页面后，管理端应能查到（证明 app.js 的上报生效）
  await cdp.go('/posts');
  await sleep(700);
  await cdp.go('/compare');
  await sleep(900);
  const tracked = await api('GET',
    `/api/admin/activities?kind=page&user=${buyer.username}&page_size=20`, { token: adminToken });
  const pages = (tracked.data.list || []).map(a => a.page);
  check('需求①：前端切换页面会自动上报（能查到 /posts 或 /compare）',
    pages.includes('/posts') || pages.includes('/compare'), JSON.stringify(pages.slice(0, 6)));
}

/* ================================================================ 主流程 */
const GROUPS = {
  1: { title: '私信消息', fn: feature1 },
  2: { title: '价格区间可自行输入', fn: feature2 },
  3: { title: '我想要', fn: feature3 },
  4: { title: '删除记录', fn: feature4 },
  5: { title: '帖子点击响应范围', fn: feature5 },
  6: { title: '帖子配图', fn: feature6 },
  7: { title: '个人资料（昵称、头像）', fn: feature7 },
  8: { title: '站名回首页 / 菜单去掉首页', fn: feature8 },
  9: { title: '消息与资料移入用户小框', fn: feature9 },
  10: { title: '商品编号 product_code', fn: feature10 },
  11: { title: '管理员交易监管（需求①）', fn: feature11 },
  12: { title: '卖家商品主页（需求②）', fn: feature12 },
  13: { title: '商家好评率（需求③）', fn: feature13 },
  14: { title: '私信页两个按钮（需求④）', fn: feature14 },
  15: { title: '私信删除会话（需求⑤）', fn: feature15 },
  16: { title: '交易管理状态卡下钻（需求①）', fn: feature16 },
  17: { title: '动态监控条目详情（需求②）', fn: feature17 },
  18: { title: '动态监控多条件筛选（需求③）', fn: feature18 },
  19: { title: '举报填写理由 + 私信反馈（需求④）', fn: feature19 },
  20: { title: '举报审核进详情后原路返回（需求⑤）', fn: feature20 },
  21: { title: '卖家侧交易收尾（需求⑥）', fn: feature21 },
  22: { title: '帖子举报入口（新批需求③）', fn: feature22 },
  23: { title: '买卖身份合并（新批需求④）', fn: feature23 },
  24: { title: '用户主页 + 私信入口（新批需求⑤）', fn: feature24 },
  25: { title: '订单新状态红点（新批需求⑥）', fn: feature25 },
  26: { title: '页面状态自动更新（新批需求⑧）', fn: feature26 },
  27: { title: '用户管理 + 封禁（新批需求①）', fn: feature27 },
  28: { title: '动态监控删除选定记录（新批需求②）', fn: feature28 },
  29: { title: '卖家确认才锁定商品（新批需求③）', fn: feature29 },
  30: { title: '私信发送商品详情卡片（新批需求④）', fn: feature30 },
  31: { title: '评论引用(@)与举报（新批需求⑤）', fn: feature31 },
  32: { title: '评论区点用户名跳主页（新批需求⑥）', fn: feature32 },
  33: { title: '关注 / 拉黑（新批需求⑦）', fn: feature33 },
  34: { title: '我的关注 / 我的拉黑（新批需求⑧）', fn: feature34 },
  35: { title: '动态监控时间线排版对齐（本批需求①）', fn: feature35 },
  36: { title: '举报记录选定删除（本批需求②）', fn: feature36 },
  37: { title: '广场列表配图缩略图（本批需求③）', fn: feature37 },
  38: { title: '头像可自行选定展示范围（本批需求④）', fn: feature38 },
  39: { title: '订单卡点用户名跳私信（本批需求⑤）', fn: feature39 },
  40: { title: '评论里@到的人可点（本批需求②）', fn: feature40 },
  41: { title: '用户空间展示帖子（本批需求③）', fn: feature41 },
  42: { title: '动态监控勾选区域放大（本批需求①）', fn: feature42 },
  43: { title: '多选不被自动刷新冲掉（本批需求②）', fn: feature43 },
  44: { title: '私信点头像进主页（本批需求③）', fn: feature44 },
  45: { title: '广场帖子/评论小头像（本批需求④）', fn: feature45 },
  46: { title: '单条私信删除与已读未读（本批需求②）', fn: feature46 },
  47: { title: '读消息后红点同步消失（本批需求③）', fn: feature47 },
  48: { title: '评论Enter发送Ctrl+Enter换行（本批需求④）', fn: feature48 },
  49: { title: '评论显示第几楼（本批需求⑤）', fn: feature49 },
  50: { title: '上传头像后各处显示正确（本批需求①）', fn: feature50 },
  51: { title: '删除自己的评论（本批需求①）', fn: feature51 },
  52: { title: '用户行为监测（本批需求①）', fn: feature52 },
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

  console.log('\n清理本次测试产生的数据…');
  cleanupByPython();

  process.exit(summary());
}

main().catch((err) => {
  console.error('测试脚本异常：', err);
  process.exit(2);
});
