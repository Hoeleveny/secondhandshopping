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

/* ================================================================ 主流程 */
const GROUPS = {
  1: { title: '私信消息', fn: feature1 },
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
