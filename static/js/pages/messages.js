/* ==========================================================================
   功能① 我的消息：左侧会话列表 + 右侧聊天窗口
   可从商品详情页「私信卖家」带 to / product 参数进来
   ========================================================================== */
import { api } from '../api.js';
import { store } from '../store.js';
import { emptyHtml, esc, fmtTime, loadingHtml, toast } from '../ui.js';

let conversationsCache = [];
let unreadTimer = null;

function avatarHtml(user, size = 36) {
  const name = user?.nickname || '?';
  if (user?.avatar) {
    return `<span class="msg-avatar" style="width:${size}px;height:${size}px;flex:0 0 ${size}px">
              <img src="/uploads/${encodeURIComponent(user.avatar)}" alt="">
            </span>`;
  }
  return `<span class="msg-avatar" style="width:${size}px;height:${size}px;flex:0 0 ${size}px">
            ${esc(name.slice(0, 1))}
          </span>`;
}

async function renderMessages(root, ctx) {
  const startTo = ctx.query.to ? Number(ctx.query.to) : null;
  let productId = ctx.query.product ? Number(ctx.query.product) : null;

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
            <div class="mc-name">${esc(user.nickname || '（用户已注销）')}</div>
            <div class="mc-last">${esc(last.content || '')}</div>
          </div>
          ${item.unread > 0 ? `<span class="badge badge-danger">${item.unread}</span>` : ''}
        </div>`;
    }).join('');
    convBox.querySelectorAll('[data-uid]').forEach(el =>
      el.addEventListener('click', () => openChat(Number(el.dataset.uid))));
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
    history.replaceState(null, '', `#/messages?to=${uid}`);
    paintChat();
    paintConversations();
    refreshTopbarUnread();
  }

  function paintChat() {
    chatBox.innerHTML = `
      <div class="chat-box">
        <div class="chat-head">
          <div class="row" style="gap:10px">
            ${avatarHtml(currentUser, 32)}
            <b>${esc(currentUser?.nickname || '')}</b>
            <span class="muted small">信用分 ${esc(String(currentUser?.credit ?? '-'))}</span>
            <button class="btn btn-ghost btn-sm" data-go-product="${currentUser?.id || ''}"></button>
          </div>
          ${productId ? `<div class="hint">正在咨询商品 #${productId}</div>` : ''}
        </div>
        <div class="chat-body" id="chat-body">
          ${messages.length
            ? messages.map(m => {
                const mine = m.sender_id === store.user?.id;
                return `<div class="bubble ${mine ? 'mine' : 'other'}">
                          ${esc(m.content)}
                          <span class="b-time">${esc(fmtTime(m.created_at))}</span>
                        </div>`;
              }).join('')
            : emptyHtml('还没有消息，打个招呼吧', '👋')}
        </div>
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
    const goProduct = chatBox.querySelector('[data-go-product]');
    if (goProduct) {
      goProduct.textContent = '查看 TA 的商品';
      goProduct.addEventListener('click', () => { location.hash = '#/search'; });
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
}

export default { render: renderMessages };
