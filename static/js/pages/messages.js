/* ==========================================================================
   功能① 我的消息：左侧会话列表 + 右侧聊天窗口
   可从商品详情页「私信卖家」带 to / product 参数进来
   ========================================================================== */
import { api } from '../api.js';
import { store } from '../store.js';
import { liveUpdate } from '../live.js';
import { avatarHtml, confirmDialog, emptyHtml, esc, fmtPrice, fmtTime, loadingHtml, ratingBadgeHtml, toast } from '../ui.js';

let conversationsCache = [];
let unreadTimer = null;

async function renderMessages(root, ctx) {
  const startTo = ctx.query.to ? Number(ctx.query.to) : null;
  // productId：「这条消息针对哪件商品」，发出去就清空（原有语义）
  let productId = ctx.query.product ? Number(ctx.query.product) : null;
  // originProductId：需求④「返回原商品」用——买家是从哪个商品详情页点进来的。
  // 从会话列表主动切到别的会话时清掉，避免对着不相干的会话显示"返回原商品"。
  let originProductId = productId;

  // 新批需求④：把「现在在咨询哪件商品」显示清楚（发卡片前先让用户确认是这一件）
  let ctxProductHint = '';
  async function loadCtxProduct() {
    if (!originProductId) { ctxProductHint = ''; return; }
    try {
      const p = await api.get(`/api/products/${originProductId}`);
      ctxProductHint = `<div class="hint">正在咨询：<b>${esc(p.name)}</b> · ${fmtPrice(p.price)}${
        p.product_code ? ` · 编号 ${esc(p.product_code)}` : ''}</div>`;
    } catch {
      ctxProductHint = '<div class="hint">正在咨询的那件商品已经不在了</div>';
    }
  }

  let currentUid = null;
  let currentUser = null;
  let messages = [];

  root.innerHTML = `
    <div class="page-head">
      <h1>我的消息</h1>
      <span class="muted small">与卖家 / 买家一对一沟通，未读消息会在顶栏显示红点</span>
    </div>
    <div class="msg-layout">
      <aside class="card msg-side" id="conv-list">${loadingHtml('加载会话…')}</aside>
      <section class="card" id="chat-area">${emptyHtml('从左侧选择一个会话开始聊天', '✉️')}</section>
    </div>`;

  const convBox = root.querySelector('#conv-list');
  const chatBox = root.querySelector('#chat-area');

  /* ---------------- 会话列表 ---------------- */
  async function loadConversations() {
    try {
      conversationsCache = await api.get('/api/messages/conversations');
    } catch (err) {
      convBox.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
      return;
    }
    paintConversations();
  }

  function paintConversations() {
    if (!conversationsCache.length) {
      convBox.innerHTML = emptyHtml('还没有会话，去商品详情页点「私信卖家」试试', '✉️');
      return;
    }
    convBox.innerHTML = conversationsCache.map(item => {
      const user = item.user || {};
      const last = item.last_message || {};
      const active = String(user.id) === String(currentUid);
      return `
        <div class="msg-conv ${active ? 'active' : ''}" data-uid="${user.id}">
          ${avatarHtml(user)}
          <div class="mc-body">
            <div class="mc-name user-link" data-user="${user.id}" title="查看 TA 的主页">${esc(user.nickname || '（用户已注销）')}</div>
            <div class="mc-last">${esc(last.content || '')}</div>
          </div>
          ${item.unread > 0 ? `<span class="badge badge-danger">${item.unread}</span>` : ''}
        </div>`;
    }).join('');
    convBox.querySelectorAll('[data-uid]').forEach(el =>
      el.addEventListener('click', () => {
        // 主动切会话：不再算「从某个商品详情页点进来的」
        originProductId = null;
        ctxProductHint = '';
        openChat(Number(el.dataset.uid));
      }));
    // 需求⑤：点对方昵称去 TA 的主页（stopPropagation，别顺手把会话也切了）
    convBox.querySelectorAll('[data-user]').forEach(el =>
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        location.hash = `#/seller/${el.dataset.user}`;
      }));
  }

  /* ---------------- 聊天窗口 ---------------- */
  async function openChat(uid) {
    let data;
    try {
      data = await api.get(`/api/messages/with/${uid}`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    currentUid = uid;
    currentUser = data.user;
    messages = data.list || [];
    productId = productId && messages.length === 0 ? productId : null;
    await loadCtxProduct();
    // 地址里保留 product，刷新/回退后「返回原商品」还在
    history.replaceState(null, '', `#/messages?to=${uid}`
      + (originProductId ? `&product=${originProductId}` : ''));
    paintChat();
    paintConversations();
    refreshTopbarUnread();
  }

  // 新批需求④：带商品的消息渲染成一张可点的小卡片（参考拼多多客服那种商品卡）
  const productCardHtml = (card) => {
    if (!card) return '';
    const cover = card.cover
      ? `<img src="/uploads/${encodeURIComponent(card.cover)}" alt="">`
      : `<span style="font-size:22px">${esc(card.category_icon || '📦')}</span>`;
    const gone = card.available === false;
    return `<div class="msg-product ${gone ? 'gone' : ''}" data-product="${card.id}"
                 role="button" tabindex="0"
                 title="${gone ? '这件商品已经不在了' : '查看商品详情'}">
              <div class="mp-cover">${cover}</div>
              <div class="mp-info">
                <div class="mp-name">${esc(card.name || '（商品已删除）')}</div>
                <div class="mp-meta">${card.price != null ? fmtPrice(card.price) : ''}${
                  card.product_code ? ` · 编号 ${esc(card.product_code)}` : ''}</div>
                <div class="mp-hint">${gone ? '商品已不在 ›' : '点击查看商品详情 ›'}</div>
              </div>
            </div>`;
  };

  // 气泡渲染抽出来：初次绘制与需求⑧的自动更新共用（只换气泡，输入框里的字不会被清掉）
  const bubblesHtml = (list) => (list.length
    ? list.map(m => {
        const mine = m.sender_id === store.user?.id;
        // 只有「商品卡片」消息才把内容换成卡片——带商品上下文的**文字消息**里
        // 有用户自己打的字，绝不能被卡片顶掉
        const card = m.kind === 'product' ? m.product_card : null;
        const ref = (!card && m.product_id)
          ? `<div class="mp-ref">关于：${esc(m.product_name || '商品')}</div>` : '';
        return `<div class="bubble ${mine ? 'mine' : 'other'} ${card ? 'has-card' : ''}">
                  ${card ? productCardHtml(card) : esc(m.content)}
                  ${ref}
                  <span class="b-time">${esc(fmtTime(m.created_at))}</span>
                </div>`;
      }).join('')
    : emptyHtml('还没有消息，打个招呼吧', '👋'));

  // 卡片点击：跳到商品详情（商品已不在就提示一下，别跳到空页面）
  function bindProductCards(scope) {
    scope.querySelectorAll('.msg-product').forEach(el => {
      const go2 = () => {
        if (el.classList.contains('gone')) { toast('这件商品已经不在了', 'warn'); return; }
        location.hash = `#/product/${el.dataset.product}`;
      };
      el.addEventListener('click', go2);
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go2(); }
      });
    });
  }

  function paintChat() {
    chatBox.innerHTML = `
      <div class="chat-box">
        <div class="chat-head">
          <div class="row" style="gap:10px">
            <span class="user-link row" style="gap:8px;align-items:center"
                  data-user="${currentUser?.id || ''}" title="查看 TA 的主页">
              ${avatarHtml(currentUser, 32)}
              <b>${esc(currentUser?.nickname || '')}</b>
            </span>
            ${ratingBadgeHtml(currentUser?.rating)}
            <button class="btn btn-ghost btn-sm" data-go-seller="${currentUser?.id || ''}">查看 TA 的商品</button>
            ${originProductId
              ? `<button class="btn btn-sm" data-send-card="${originProductId}"
                   title="把这件商品以卡片形式发给对方">📦 发送商品详情</button>`
              : ''}
            ${originProductId
              ? `<button class="btn btn-ghost btn-sm" data-go-origin="${originProductId}">返回原商品</button>`
              : ''}
            <button class="btn btn-ghost btn-sm" data-del-conv="${currentUser?.id || ''}">🗑 删除对话</button>
          </div>
          ${ctxProductHint}        </div>
        <div class="chat-body" id="chat-body">${bubblesHtml(messages)}</div>
        <div class="chat-input">
          <textarea class="textarea" id="msg-input" style="min-height:56px"
                    placeholder="按 Enter 发送，Shift + Enter 换行"></textarea>
          <button class="btn btn-primary" id="msg-send">发送</button>
        </div>
      </div>`;

    const body = chatBox.querySelector('#chat-body');
    body.scrollTop = body.scrollHeight;

    const input = chatBox.querySelector('#msg-input');
    chatBox.querySelector('#msg-send').addEventListener('click', send);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    // 新批需求④：发送商品详情卡片
    const sendCard = chatBox.querySelector('[data-send-card]');
    if (sendCard) {
      sendCard.addEventListener('click', () => sendProductCard(sendCard.dataset.sendCard));
    }
    bindProductCards(chatBox);
    // 需求④：「查看 TA 的商品」→ 卖家商品主页；「返回原商品」→ 买家原来浏览的那件商品
    const goSeller = chatBox.querySelector('[data-go-seller]');
    if (goSeller) {
      goSeller.addEventListener('click', () => {
        location.hash = `#/seller/${goSeller.dataset.goSeller}`;
      });
    }
    // 需求⑤：聊天头部点对方头像/昵称 → TA 的主页
    const headUser = chatBox.querySelector('.chat-head [data-user]');
    if (headUser) {
      headUser.addEventListener('click', () => {
        location.hash = `#/seller/${headUser.dataset.user}`;
      });
    }
    const goOrigin = chatBox.querySelector('[data-go-origin]');
    if (goOrigin) {
      goOrigin.addEventListener('click', () => {
        location.hash = `#/product/${goOrigin.dataset.goOrigin}`;
      });
    }
    // 需求⑤：删除对话——只对我隐藏，对方那边不受影响
    const delConv = chatBox.querySelector('[data-del-conv]');
    if (delConv) {
      delConv.addEventListener('click', async () => {
        const sure = await confirmDialog({
          title: '删除这个对话？', danger: true, okText: '删除对话', cancelText: '再想想',
          message: '只从你的列表移除，对方那边完全不受影响；'
            + '对方之后再发消息，这个对话会重新出现在你的列表里。',
        });
        if (!sure) return;
        try {
          await api.del(`/api/messages/conversations/${currentUid}`);
          toast('对话已删除');
          currentUid = null;
          currentUser = null;
          messages = [];
          productId = null;
          originProductId = null;
          chatBox.innerHTML = emptyHtml('从左侧选择一个会话开始聊天', '✉️');
          history.replaceState(null, '', '#/messages');
          await loadConversations();
          refreshTopbarUnread();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  }

  async function send() {
    const input = chatBox.querySelector('#msg-input');
    const content = input.value.trim();
    if (!content) { toast('消息内容不能为空', 'warn'); return; }
    if (!currentUid) return;
    try {
      const created = await api.post('/api/messages', {
        receiver_id: currentUid,
        content,
        product_id: productId || undefined,
      });
      messages.push(created);
      productId = null;
      input.value = '';
      paintChat();
      loadConversations();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // 新批需求④：把商品详情以卡片发给对方（不改输入框里的字，也不消耗商品上下文）
  async function sendProductCard(pid) {
    if (!currentUid || !pid) return;
    try {
      const created = await api.post('/api/messages', {
        receiver_id: currentUid,
        product_id: Number(pid),
        kind: 'product',
      });
      messages.push(created);
      paintChat();
      loadConversations();
      toast('已发送商品详情');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function refreshTopbarUnread() {
    const badge = document.getElementById('msg-badge');
    if (!badge) return;
    try {
      const data = await api.get('/api/messages/unread');
      badge.textContent = data.count;
      badge.style.display = data.count > 0 ? '' : 'none';
    } catch (err) { /* 忽略 */ }
  }

  await loadConversations();
  if (startTo) {
    await openChat(startTo);
  } else if (conversationsCache.length) {
    await openChat(conversationsCache[0].user.id);
  }

  clearInterval(unreadTimer);
  unreadTimer = setInterval(refreshTopbarUnread, 20000);

  // 需求⑧：会话打开着的时候，每 6 秒看对方有没有发新消息。
  // 只重绘气泡区（不碰输入框），并且「本来就在底部」时才自动滚到底——
  // 正在往上翻旧消息的人不该被拽下来。
  liveUpdate('chat', '#chat-area', async () => {
    if (!currentUid) return;
    const data = await api.get(`/api/messages/with/${currentUid}`);
    const list = data.list || [];
    if (list.length === messages.length) return;
    messages = list;
    const body = document.getElementById('chat-body');
    if (!body) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    body.innerHTML = bubblesHtml(messages);
    bindProductCards(body);
    if (atBottom) body.scrollTop = body.scrollHeight;
    await loadConversations();   // 左侧列表的最后一条 / 未读数也跟上
    refreshTopbarUnread();
  }, 6000);
}

export default { render: renderMessages };
