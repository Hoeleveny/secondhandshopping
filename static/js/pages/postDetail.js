/* ==========================================================================
   帖子详情 + 评论区
   ========================================================================== */
import { api } from '../api.js';
import { store } from '../store.js';
import { confirmDialog, emptyHtml, esc, fmtTime, toast } from '../ui.js';

async function renderPost(root, ctx) {
  const id = ctx.params.id;
  let post;
  try {
    post = await api.get(`/api/posts/${id}`);
  } catch (err) {
    root.innerHTML = emptyHtml(`帖子打不开：${err.message}`, '🚫');
    return;
  }

  const canDelete = store.isLoggedIn && (post.author_id === store.user?.id || store.isAdmin);
  const comments = post.comments || [];

  root.innerHTML = `
    <div class="page-head">
      <button class="btn btn-ghost btn-sm" id="btn-back">‹ 返回广场</button>
      ${canDelete ? '<button class="btn btn-danger btn-sm" id="btn-del">🗑️ 删除帖子</button>' : ''}
    </div>

    <div class="card">
      <div class="row-between">
        <h1 style="margin:0">${esc(post.title)}</h1>
        <span class="badge">${esc(post.tag)}</span>
      </div>
      <div class="post-meta mt-8">
        <span>👤 ${esc(post.author_nickname || '')}</span>
        <span>🕒 ${esc(fmtTime(post.created_at))}</span>
        <span>❤️ <span id="like-count">${post.like_count}</span> 赞</span>
        <span>💬 ${post.comment_count} 条评论</span>
      </div>
      <div class="divider"></div>
      <div style="white-space:pre-wrap">${esc(post.content)}</div>
      <div class="divider"></div>
      <button class="btn ${post.liked ? 'btn-primary' : ''}" id="btn-like">
        ${post.liked ? '❤️ 已点赞' : '🤍 点赞'}
      </button>
    </div>

    <div class="card">
      <div class="card-head"><h2>评论（${comments.length}）</h2></div>
      <div id="comment-list">
        ${comments.length
          ? comments.map(c => `
            <div class="comment-item">
              <div class="cm-head"><b>${esc(c.author_nickname || '')}</b><span>${esc(fmtTime(c.created_at))}</span></div>
              <div>${esc(c.content)}</div>
            </div>`).join('')
          : emptyHtml('还没有评论，来说两句', '💬')}
      </div>
      <div class="divider"></div>
      <div class="row" style="align-items:flex-start">
        <textarea class="textarea" id="comment-input" style="min-height:64px"
                  placeholder="${store.isLoggedIn ? '写下你的评论…' : '登录后才能评论'}"></textarea>
        <button class="btn btn-primary" id="btn-comment">发表评论</button>
      </div>
    </div>`;

  root.querySelector('#btn-back').addEventListener('click', () => { location.hash = '#/posts'; });

  const deleteBtn = root.querySelector('#btn-del');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async () => {
      const sure = await confirmDialog({
        title: '确认删除这条帖子？', danger: true, okText: '删除',
        message: '删除后其他同学将看不到这条帖子。',
      });
      if (!sure) return;
      try {
        await api.del(`/api/posts/${id}`);
        toast('帖子已删除');
        location.hash = '#/posts';
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  const likeBtn = root.querySelector('#btn-like');
  likeBtn.addEventListener('click', async () => {
    if (!store.isLoggedIn) { toast('登录后才能点赞', 'warn'); location.hash = '#/login'; return; }
    try {
      const result = await api.post(`/api/posts/${id}/like`);
      root.querySelector('#like-count').textContent = result.like_count;
      likeBtn.classList.toggle('btn-primary', result.liked);
      likeBtn.textContent = result.liked ? '❤️ 已点赞' : '🤍 点赞';
    } catch (err) { toast(err.message, 'error'); }
  });

  const commentBtn = root.querySelector('#btn-comment');
  const commentInput = root.querySelector('#comment-input');
  const submitComment = async () => {
    if (!store.isLoggedIn) { toast('登录后才能评论', 'warn'); location.hash = '#/login'; return; }
    const content = commentInput.value.trim();
    if (!content) { toast('评论内容不能为空', 'warn'); return; }
    try {
      await api.post(`/api/posts/${id}/comments`, { content });
      toast('评论成功');
      // 只刷新评论区，避免整页重绘
      const fresh = await api.get(`/api/posts/${id}`);
      const list = root.querySelector('#comment-list');
      const items = fresh.comments || [];
      list.innerHTML = items.length
        ? items.map(c => `
            <div class="comment-item">
              <div class="cm-head"><b>${esc(c.author_nickname || '')}</b><span>${esc(fmtTime(c.created_at))}</span></div>
              <div>${esc(c.content)}</div>
            </div>`).join('')
        : emptyHtml('还没有评论，来说两句', '💬');
      root.querySelector('.card-head h2').textContent = `评论（${items.length}）`;
      commentInput.value = '';
    } catch (err) { toast(err.message, 'error'); }
  };
  commentBtn.addEventListener('click', submitComment);
  commentInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submitComment();
  });
}

export default { render: renderPost };
