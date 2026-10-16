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
    convView.convs.some(c => c.includes('李小明'))
    && convView.bubbles.some(b => b.includes('还在吗')),
    `会话=${JSON.stringify(convView.convs).slice(0, 150)}`);

  await cdp.shot(path.join(SHOT_DIR, 'f1-seller-chat.png'));

  // 断言「来自这个人的未读归零」而不是「全站未读为 0」——后者只要别的账号发来一条消息就会误报
  // （我就在这上面栽过：演示账号收到一条平台通知，"归零"就挂了）
  const convAfter = await api('GET', '/api/messages/conversations', { token: sellerToken });
  const peerConv = (convAfter.data || []).find(c => (c.user || {}).nickname === '李小明');
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
  await api('PATCH', `/api/orders/${orderId}/complete`, { token: buyerToken });

  // 再造一条「待完成」订单，用于验证它没有删除按钮
  const nameD = `自动化测试：进行中订单-${Date.now() % 100000}`;
  const pidD = await makeProduct(nameD, 44.0, sellerToken);
  await api('POST', '/api/orders', { token: buyerToken, body: { product_id: pidD, meet_place_id: 1 } });

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
  const doneCard = await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('#list-area .card')]
        .find(c => c.innerText.includes('待删订单'));
      return {
        found: !!card,
        hasDel: card ? !!card.querySelector('[data-act="del-order"]') : null,
        text: card ? card.innerText.replace(/\\s+/g, ' ').trim().slice(0, 80) : '',
      };
    })()`);
  check('「已完成」订单有「删除记录」按钮',
    doneCard.found && doneCard.hasDel === true, `卡片「${doneCard.text}」`);

  await cdp.shot(path.join(SHOT_DIR, 'f4-order-delete.png'));

  await cdp.eval(`
    (() => {
      const card = [...document.querySelectorAll('#list-area .card')]
        .find(c => c.innerText.includes('待删订单'));
      card.querySelector('[data-act="del-order"]').click();
    })()`);
  await sleep(500);
  await cdp.eval(`document.querySelector('.modal-mask [data-ok]').click()`);
  await sleep(1200);

  const afterDel = await cdp.eval(`
    (() => ({
      stillShown: [...document.querySelectorAll('#list-area .card')]
        .some(c => c.innerText.includes('待删订单')),
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
  await sleep(1600);

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
  check('测试交易已就绪（商品已售 + 待完成订单）',
    order.status === 'pending' && !!order.id, JSON.stringify({ id: order.id, status: order.status }));

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
  await waitFor(cdp, `document.querySelectorAll('#conv-list [data-uid]').length === 0`);
  await sleep(500);
  const afterDel = await cdp.eval(`
    (() => ({
      convItems: document.querySelectorAll('#conv-list [data-uid]').length,
      chatEmpty: /从左侧选择一个会话/.test(document.querySelector('#chat-area')?.innerText || ''),
    }))()`);
  check('确认删除后会话从列表消失、聊天区回到空态',
    afterDel.convItems === 0 && afterDel.chatEmpty, JSON.stringify(afterDel));

  await cdp.go('/messages');
  await waitFor(cdp, `!!document.querySelector('#conv-list')`);
  await sleep(700);
  const afterReload = await cdp.eval(`document.querySelectorAll('#conv-list [data-uid]').length`);
  check('刷新后仍是已删除状态（后端记住了，不是只改前端）', afterReload === 0, `列表 ${afterReload} 项`);

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
  await waitFor(cdp, `document.querySelectorAll('#conv-list [data-uid]').length > 0`);
  const revived = await cdp.eval(`document.querySelectorAll('#conv-list [data-uid]').length`);
  check('对方再发消息后会话重新出现在我的列表', revived > 0, `列表 ${revived} 项`);
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
  check('已备好一笔进行中的交易', order.status === 'pending', JSON.stringify(order.id));

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
