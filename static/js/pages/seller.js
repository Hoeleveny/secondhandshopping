/* ==========================================================================
   需求② 卖家商品主页 = 需求⑤的「对外用户主页（用户空间）」
   入口：商品详情页点卖家昵称、交流广场点发帖人、私信页点对方
   内容：对方愿意公开的信息（头像/昵称/商家简介/在售件数/加入时间/卖家编号）
        + TA 发布的商品（默认在售，可切已售；支持关键词与分类筛选）
   需求⑤：这里可以直接私信 TA 发起会话。
   已下架、已删除的商品不展示。
   ========================================================================== */
import { api, qs } from '../api.js';
import { ensureCategories } from '../data.js';
import { bindProductCards, postItemHtml, productCardHtml } from '../components.js';
import {
  avatarHtml, confirmDialog, emptyHtml, esc, loadingHtml, ratingBadgeHtml,
  renderPagination, toast,
} from '../ui.js';
import { store } from '../store.js';

export default {
  async render(root, ctx) {
    const uid = Number(ctx.params.id);
    let status = ctx.query.status === 'sold' ? 'sold' : 'on_sale';
    let keyword = ctx.query.keyword || '';
    let categoryId = ctx.query.category_id || '';
    let page = 1;

    const categories = await ensureCategories();

    root.innerHTML = `
      <div class="page-head">
        <h1>TA 的主页</h1>
        <span class="muted small">这里只展示对方愿意公开的信息；可以直接私信 TA</span>
      </div>

      <div class="card" id="seller-head">${loadingHtml()}</div>

      <div class="card mt-16">
        <div class="form-grid">
          <div class="form-row">
            <label>关键词</label>
            <input class="input" id="sk-keyword" placeholder="商品名 / 描述"
                   value="${esc(keyword)}">
          </div>
          <div class="form-row">
            <label>分类</label>
            <select class="select" id="sk-category">
              <option value="">全部分类</option>
              ${categories.map(c => `<option value="${c.id}" ${String(c.id) === String(categoryId) ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="form-row">
            <label>&nbsp;</label>
            <button class="btn btn-primary btn-block" id="sk-search">查询</button>
          </div>
        </div>
      </div>

      <div id="list-area" class="mt-16"></div>
      <div class="pagination" id="pager"></div>`;

    const head = root.querySelector('#seller-head');
    const listArea = root.querySelector('#list-area');
    const pager = root.querySelector('#pager');
    let blockedByMe = false;      // 我是否拉黑了这位用户（拉黑了就不展示 TA 的商品与帖子）

    function paintHead(seller, counts, social = {}, blockedByMe = false) {
      const isSelf = String(seller.id) === String(store.user?.id);
      const bio = seller.bio
        ? `<div class="seller-bio">${esc(seller.bio)}</div>`
        : `<div class="seller-bio muted">这位卖家还没有填写商家简介</div>`;
      // 新批需求⑦：关注 / 拉黑（单向；拉黑后我这边看不到 TA 的商品与评论，TA 不能给我发私信）
      const socialBtns = (!store.isLoggedIn || isSelf) ? '' : `
        <button class="btn btn-sm ${social.is_following ? '' : 'btn-primary'}" data-follow="${seller.id}">
          ${social.is_following ? '已关注（点一下取消）' : '＋ 关注'}
        </button>
        <button class="btn btn-sm ${social.is_blocked ? 'btn-primary' : ''}" data-block="${seller.id}">
          ${social.is_blocked ? '已拉黑（点一下解除）' : '🚫 拉黑'}
        </button>`;
      head.innerHTML = `
        <div class="seller-head">
          <div class="seller-avatar">${avatarHtml(seller, 72, 'seller-avatar')}</div>
          <div class="seller-main">
            <div class="seller-name"><span class="seller-nick">${esc(seller.nickname)}</span>${ratingBadgeHtml(seller.rating)}</div>
            ${bio}
            <div class="seller-stats muted small">
              <span>在售 <b>${counts.on_sale ?? 0}</b> 件</span>
              <span>已售 <b>${counts.sold ?? 0}</b> 件</span>
              <span>关注 <b>${social.following_count ?? 0}</b></span>
              <span>粉丝 <b>${social.follower_count ?? 0}</b></span>
              <span>加入时间 ${esc(seller.joined_at || '未知')}</span>
              <span>卖家编号 ${esc(seller.seller_code || '未分配')}</span>
            </div>
          </div>
          <div class="seller-switch" id="sk-status">
            ${store.isLoggedIn
              ? (isSelf
                  ? '<span class="badge badge-info">这是你自己的主页</span>'
                  : `<button class="btn btn-primary btn-sm" data-msg="${seller.id}">✉️ 私信 TA</button>`)
              : '<button class="btn btn-sm" data-msg-login="1">✉️ 私信 TA</button>'}
            ${socialBtns}
            <button class="btn btn-sm ${status === 'on_sale' ? 'btn-primary' : ''}"
                    data-status="on_sale">在售 ${counts.on_sale ?? 0}</button>
            <button class="btn btn-sm ${status === 'sold' ? 'btn-primary' : ''}"
                    data-status="sold">已售 ${counts.sold ?? 0}</button>
            <button class="btn btn-sm ${status === 'posts' ? 'btn-primary' : ''}"
                    data-status="posts">帖子 ${counts.post_count ?? 0}</button>
          </div>
        </div>
        ${blockedByMe ? `<div class="hint">🚫 你已拉黑 TA：这里看不到 TA 的任何商品与评论，双方也无法互发私信。想恢复请点上面的「已拉黑」。</div>` : ''}`;

      head.querySelectorAll('[data-status]').forEach(btn =>
        btn.addEventListener('click', () => {
          if (status === btn.dataset.status) return;
          status = btn.dataset.status;
          page = 1;
          load();
        }));

      // 需求⑤：一键发起私信（未登录先引导登录）
      head.querySelector('[data-msg]')?.addEventListener('click', (event) => {
        location.hash = `#/messages?to=${event.currentTarget.dataset.msg}`;
      });
      head.querySelector('[data-msg-login]')?.addEventListener('click', () => {
        toast('登录后才能私信', 'warn');
        location.hash = '#/login';
      });

      // 需求⑦：关注 / 拉黑（拉黑要确认一次，说清后果）
      head.querySelector('[data-follow]')?.addEventListener('click', async (event) => {
        const uid2 = event.currentTarget.dataset.follow;
        try {
          if (social.is_following) {
            await api.del(`/api/follows/${uid2}`);
            toast('已取消关注');
          } else {
            await api.post(`/api/follows/${uid2}`, {});
            toast('已关注，对方会收到通知');
          }
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
      head.querySelector('[data-block]')?.addEventListener('click', async (event) => {
        const uid2 = event.currentTarget.dataset.block;
        if (social.is_blocked) {
          try {
            await api.del(`/api/blocks/${uid2}`);
            toast('已解除拉黑');
            load();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        const sure = await confirmDialog({
          title: `拉黑「${seller.nickname}」？`, danger: true, okText: '拉黑',
          message: '拉黑后：你这边看不到 TA 的商品与评论，**你们双方也都不能互发私信**；'
            + '但 TA 仍能看到你的商品、也能下单（交易不受影响）。随时可以解除。',
        });
        if (!sure) return;
        try {
          await api.post(`/api/blocks/${uid2}`, {});
          toast('已拉黑');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
    }

    async function load() {
      listArea.innerHTML = loadingHtml();
      let data;
      try {
        data = await api.get(`/api/sellers/${uid}${qs({
          // 卖家资料接口只认「在售 / 已售」；切到「帖子」页签时按在售取一份资料（只为拿头部与计数）
          status: status === 'posts' ? 'on_sale' : status,
          keyword, category_id: categoryId, page, page_size: 12,
        })}`);
      } catch (err) {
        head.innerHTML = '';
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        pager.innerHTML = '';
        return;
      }

      blockedByMe = data.blocked_by_me === true;
      paintHead(data.seller || {}, data.counts || {}, data.social || {}, blockedByMe);

      // 用户空间也展示 TA 的帖子（用户 2026-10-16 提出）
      if (status === 'posts') return loadPosts();

      if (!data.list.length) {
        listArea.innerHTML = status === 'on_sale'
          ? emptyHtml('这位卖家当前没有在售的商品', '📦')
          : emptyHtml('这位卖家还没有已售出的商品', '🧾');
        pager.innerHTML = '';
        return;
      }

      listArea.innerHTML = `<div class="grid-cards">${data.list.map(productCardHtml).join('')}</div>`;
      bindProductCards(listArea);
      renderPagination(pager, {
        page: data.page,
        pages: Math.max(1, Math.ceil(data.total / data.page_size)),
        total: data.total,
        onGo: (target) => { page = target; load(); },
      });
    }

    /* 用户空间也展示 TA 的帖子（用户 2026-10-16 提出）；关键词筛选同样生效 */
    async function loadPosts() {
      let data;
      try {
        data = await api.get(`/api/posts${qs({ author_id: uid, keyword, page, page_size: 8 })}`);
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        pager.innerHTML = '';
        return;
      }
      if (blockedByMe) {
        listArea.innerHTML = emptyHtml('你已拉黑 TA，看不到 TA 的任何内容', '🚫');
        pager.innerHTML = '';
        return;
      }
      if (!data.list.length) {
        listArea.innerHTML = emptyHtml(keyword ? '没有匹配的帖子' : '这位用户还没有发过帖子', '💬');
        pager.innerHTML = '';
        return;
      }
      listArea.innerHTML = data.list.map(p => postItemHtml(p, { actions: false })).join('');
      // 帖子卡整张可点进详情；点赞/评论这些操作按钮在这里不渲染（避免出现点了没反应的按钮）
      listArea.querySelectorAll('.post-item[data-post]').forEach(el =>
        el.addEventListener('click', () => { location.hash = `#/post/${el.dataset.post}`; }));
      listArea.querySelectorAll('.post-item [data-user]').forEach(el =>
        el.addEventListener('click', (event) => {
          event.stopPropagation();
          location.hash = `#/seller/${el.dataset.user}`;
        }));
      renderPagination(pager, {
        page: data.page,
        pages: Math.max(1, Math.ceil(data.total / data.page_size)),
        total: data.total,
        onGo: (target) => { page = target; load(); },
      });
    }

    root.querySelector('#sk-search').addEventListener('click', () => {
      keyword = root.querySelector('#sk-keyword').value.trim();
      categoryId = root.querySelector('#sk-category').value;
      page = 1;
      load();
    });
    root.querySelector('#sk-keyword').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') root.querySelector('#sk-search').click();
    });

    await load();
  },
};
