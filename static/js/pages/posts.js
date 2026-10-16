/* ==========================================================================
   M13 交流广场：发帖、标签页签筛选、点赞、评论、删帖
   ========================================================================== */
import { api, qs } from '../api.js';
import { store } from '../store.js';
import { postItemHtml } from '../components.js';
import {
  confirmDialog, emptyHtml, esc, loadingHtml, openModal, renderPagination, toast,
} from '../ui.js';

export default {
  async render(root, ctx) {
    let tag = ctx.query.tag || '';
    let page = Number(ctx.query.page) || 1;
    let keyword = ctx.query.keyword || '';

    root.innerHTML = `
      <div class="page-head">
        <h1>交流广场</h1>
        <div class="row">
          <div class="search-box" style="max-width:280px">
            <input type="text" id="post-keyword" placeholder="搜索帖子" value="${esc(keyword)}">
            <button type="button" id="post-search">搜索</button>
          </div>
          <button class="btn btn-primary" id="btn-new-post">✍️ 发帖</button>
        </div>
      </div>
      <div class="tabs" id="tabs"></div>
      <div class="card" id="list-area"></div>
      <div class="pagination" id="pager"></div>`;

    const tabsEl = root.querySelector('#tabs');
    const listArea = root.querySelector('#list-area');
    const pager = root.querySelector('#pager');

    root.querySelector('#btn-new-post').addEventListener('click', () => {
      if (!store.isLoggedIn) { location.hash = '#/login?next=%23/posts'; return; }
      openPostModal(load);
    });
    root.querySelector('#post-search').addEventListener('click', () => {
      keyword = root.querySelector('#post-keyword').value.trim();
      page = 1; load();
    });
    root.querySelector('#post-keyword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { keyword = e.target.value.trim(); page = 1; load(); }
    });

    async function load() {
      listArea.innerHTML = loadingHtml();
      let data;
      try {
        data = await api.get(`/api/posts${qs({ tag, keyword, page, page_size: 8 })}`);
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }

      const counts = data.tag_counts || {};
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      tabsEl.innerHTML = `
        <button class="tab ${tag === '' ? 'active' : ''}" data-tag="">全部<span class="cnt">${total}</span></button>
        ${(data.tags || []).map(t => `
          <button class="tab ${tag === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}<span class="cnt">${counts[t] ?? 0}</span></button>`).join('')}`;
      tabsEl.querySelectorAll('[data-tag]').forEach(btn =>
        btn.addEventListener('click', () => {
          tag = btn.dataset.tag;
          page = 1;
          history.replaceState(null, '', `#/posts${qs({ tag, keyword, page })}`);
          load();
        }));

      listArea.innerHTML = data.list.length
        ? data.list.map(post => postItemHtml(post, {
            canDelete: store.isLoggedIn && (post.author_id === store.user?.id || store.isAdmin),
          })).join('')
        : emptyHtml('还没有帖子，来发第一条吧', '💬');

      // 功能⑤：整张帖子卡片都可点击进入详情
      listArea.querySelectorAll('.post-item[data-post]').forEach(item =>
        item.addEventListener('click', () => { location.hash = `#/post/${item.dataset.post}`; }));

      // 需求⑤：点发帖人昵称去 TA 的主页（必须 stopPropagation，否则会先触发整卡跳详情）
      listArea.querySelectorAll('.post-item [data-user]').forEach(el =>
        el.addEventListener('click', (event) => {
          event.stopPropagation();
          location.hash = `#/seller/${el.dataset.user}`;
        }));

      listArea.querySelectorAll('[data-like]').forEach(btn =>
        btn.addEventListener('click', async (event) => {
          event.stopPropagation();   // 点赞不要触发整卡跳转
          if (!store.isLoggedIn) { toast('登录后才能点赞', 'warn'); location.hash = '#/login'; return; }
          try {
            const result = await api.post(`/api/posts/${btn.dataset.like}/like`);
            const countSpan = listArea.querySelector(`[data-like-count="${btn.dataset.like}"]`);
            if (countSpan) countSpan.textContent = result.like_count;
            btn.classList.toggle('liked', result.liked);
            btn.firstChild.textContent = result.liked ? '❤️ ' : '🤍 ';
          } catch (err) { toast(err.message, 'error'); }
        }));

      // 「评论」按钮本身就是去详情页，交给整卡点击处理即可
      listArea.querySelectorAll('[data-comment]').forEach(btn =>
        btn.addEventListener('click', () => { location.hash = `#/post/${btn.dataset.comment}`; }));

      listArea.querySelectorAll('[data-delete]').forEach(btn =>
        btn.addEventListener('click', async (event) => {
          event.stopPropagation();   // 删除不要触发整卡跳转
          const sure = await confirmDialog({
            title: '确认删除这条帖子？', danger: true, okText: '删除',
            message: '删除后其他同学将看不到这条帖子。',
          });
          if (!sure) return;
          try { await api.del(`/api/posts/${btn.dataset.delete}`); toast('帖子已删除'); load(); }
          catch (err) { toast(err.message, 'error'); }
        }));

      renderPagination(pager, {
        page: data.page,
        pages: Math.max(1, Math.ceil(data.total / data.page_size)),
        total: data.total,
        onGo: (target) => { page = target; load(); },
      });
    }

    await load();
  },
};

/* ------------------------------------------------------------------ 发帖弹窗 */
export function openPostModal(onDone) {
  const tags = ['安利', '避雷', '闲聊', '求助'];
  const maxImages = 6;
  const images = [];     // 已上传成功的文件名

  openModal({
    title: '发帖',
    body: `
      <div class="form-row">
        <label>标题<span class="req">*</span></label>
        <input class="input" id="po-title" maxlength="100" placeholder="一句话说清楚你想说什么">
      </div>
      <div class="form-row">
        <label>标签<span class="req">*</span></label>
        <div class="pill-check" id="po-tags">
          ${tags.map((t, i) => `<label><input type="radio" name="po-tag" value="${esc(t)}" ${i === 2 ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('')}
        </div>
      </div>
      <div class="form-row">
        <label>内容<span class="req">*</span></label>
        <textarea class="textarea" id="po-content" style="min-height:140px" placeholder="安利 / 避雷 / 闲聊 / 求助 都可以写"></textarea>
      </div>
      <div class="form-row">
        <label>配图（最多 ${maxImages} 张，jpg / png / webp，单张 ≤ 2MB）</label>
        <input type="file" id="po-images" accept="image/jpeg,image/png,image/webp" multiple style="display:none">
        <button type="button" class="btn" id="po-pick">📎 选择图片</button>
        <div class="gallery-thumbs" id="po-image-list"></div>
      </div>`,
    footer: `<button class="btn" data-close>取消</button>
             <button class="btn btn-primary" id="po-submit">发布</button>`,
    onMount(modal, close) {
      const list = modal.querySelector('#po-image-list');
      const fileInput = modal.querySelector('#po-images');

      function renderImages() {
        list.innerHTML = images.map((file, index) => `
          <span style="position:relative;display:inline-block">
            <img src="/uploads/${encodeURIComponent(file)}" alt="">
            <button type="button" data-rm="${index}"
                    style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;
                           border:none;background:var(--danger);color:#fff;cursor:pointer;line-height:1;font-size:12px">×</button>
          </span>`).join('');
        list.querySelectorAll('[data-rm]').forEach(btn =>
          btn.addEventListener('click', () => {
            images.splice(Number(btn.dataset.rm), 1);
            renderImages();
          }));
      }

      modal.querySelector('#po-pick').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        for (const file of files) {
          if (images.length >= maxImages) { toast(`最多上传 ${maxImages} 张图片`, 'warn'); break; }
          if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast(`${file.name}：只支持 jpg / png / webp`, 'warn'); continue; }
          if (file.size > 2 * 1024 * 1024) { toast(`${file.name}：超过 2MB`, 'warn'); continue; }
          try {
            const data = await api.upload(file);
            images.push(data.url);
            renderImages();
          } catch (err) {
            toast(`上传失败：${err.message}`, 'error');
          }
        }
      });

      modal.querySelector('#po-submit').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api.post('/api/posts', {
            title: modal.querySelector('#po-title').value.trim(),
            content: modal.querySelector('#po-content').value.trim(),
            tag: modal.querySelector('input[name="po-tag"]:checked').value,
            images,
          });
          close();
          toast(`发布成功${images.length ? `（含 ${images.length} 张配图）` : ''}`);
          if (onDone) onDone();
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      });
    },
  });
}
