/* ==========================================================================
   帖子详情 + 评论区
   ========================================================================== */
import { api } from '../api.js';
import { store } from '../store.js';
import { ensureMeta } from '../data.js';
import { confirmDialog, emptyHtml, esc, fmtTime, openModal, toast } from '../ui.js';

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
  // 需求⑤：从「举报审核」点进来的，返回时要回举报审核，而不是交流广场
  const fromAdmin = (ctx.query.from || '').toLowerCase() === 'admin';
  const back = fromAdmin
    ? { hash: '#/admin?tab=reports', label: '‹ 返回举报审核' }
    : { hash: '#/posts', label: '‹ 返回广场' };
  const comments = post.comments || [];

  root.innerHTML = `
    <div class="page-head">
      <button class="btn btn-ghost btn-sm" id="btn-back">${back.label}</button>
      ${canDelete ? '<button class="btn btn-danger btn-sm" id="btn-del">🗑️ 删除帖子</button>' : ''}
      ${canDelete ? '' : '<button class="btn btn-sm" id="btn-report">🚩 举报</button>'}
    </div>

    <div class="card">
      <div class="row-between">
        <h1 style="margin:0">${esc(post.title)}</h1>
        <span class="badge">${esc(post.tag)}</span>
      </div>
      <div class="post-meta mt-8">
        <span class="user-link" data-user="${post.author_id}" title="查看 TA 的主页">👤 ${esc(post.author_nickname || '')}</span>
        <span>🕒 ${esc(fmtTime(post.created_at))}</span>
        <span>❤️ <span id="like-count">${post.like_count}</span> 赞</span>
        <span>💬 ${post.comment_count} 条评论</span>
      </div>
      <div class="divider"></div>
      <div style="white-space:pre-wrap">${esc(post.content)}</div>
      ${(post.images || []).length ? `
        <div class="post-gallery" id="post-gallery">
          ${post.images.map(url => `<img src="/uploads/${encodeURIComponent(url)}" alt="" data-full="/uploads/${encodeURIComponent(url)}">`).join('')}
        </div>` : ''}
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

  root.querySelector('#btn-back').addEventListener('click', () => { location.hash = back.hash; });

  // 需求⑤：帖子详情里点作者也能去 TA 的主页
  root.querySelector('[data-user]')?.addEventListener('click', (event) => {
    location.hash = `#/seller/${event.currentTarget.dataset.user}`;
  });

  /* ------------------------------------------------------------------ 举报帖子
     需求③：交流广场的帖子原来只能被管理员处置、普通用户没有举报入口（商品详情早就有），
     这里补齐，交互与「举报商品」保持一致：预设理由 + 补充说明，举报对象用 post_id。 */
  root.querySelector('#btn-report')?.addEventListener('click', () => {
    if (!store.isLoggedIn) {
      toast('登录后才能举报', 'warn');
      location.hash = '#/login';
      return;
    }
    openReportModal(post);
  });

  // 功能⑥：点配图放大看原图
  const gallery = root.querySelector('#post-gallery');
  if (gallery) {
    gallery.addEventListener('click', (event) => {
      const img = event.target.closest('img[data-full]');
      if (!img) return;
      openModal({
        title: '查看图片',
        wide: true,
        body: `<img src="${esc(img.dataset.full)}" alt=""
                    style="width:100%;border-radius:10px;background:var(--green-soft)">`,
      });
    });
  }

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
        location.hash = back.hash;   // 管理员从举报审核来的，删完回举报审核
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

/* ------------------------------------------------------------------ 举报帖子的弹窗 */
async function openReportModal(post) {
  const meta = await ensureMeta();
  openModal({
    title: '举报帖子',
    body: `
      <div class="form-row">
        <label>举报理由<span class="req">*</span></label>
        <select class="select" id="rp-reason">
          ${meta.report_reasons.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label>补充说明</label>
        <textarea class="textarea" id="rp-detail" placeholder="可以补充具体情况，方便管理员核实"></textarea>
      </div>`,
    footer: `<button class="btn" data-close>取消</button>
             <button class="btn btn-primary" id="rp-submit">提交举报</button>`,
    onMount(modal, close) {
      modal.querySelector('#rp-submit').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api.post('/api/reports', {
            target_type: 'post',
            target_id: post.id,
            reason: modal.querySelector('#rp-reason').value,
            detail: modal.querySelector('#rp-detail').value.trim(),
          });
          close();
          toast('举报已提交，管理员会尽快处理');
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      });
    },
  });
}
