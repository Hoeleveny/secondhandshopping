/* ==========================================================================
   新批需求⑧：我的关注 / 我的拉黑
   两个入口共用这一页：看 hash 决定是哪种列表，列表里可以直接取消。
   ========================================================================== */
import { api } from '../api.js';
import { avatarHtml, confirmDialog, emptyHtml, esc, loadingHtml, toast } from '../ui.js';

export default {
  async render(root, ctx) {
    const isBlock = String(ctx.query?.mode || '').startsWith('block')
      || location.hash.startsWith('#/blocks');
    const mode = isBlock ? 'blocks' : 'follows';
    const cfg = isBlock
      ? {
        title: '我的拉黑',
        hint: '被你拉黑的人：你看不到 TA 的商品与评论，**你们双方也都不能互发私信**；'
              + '但 TA 仍能看到你的商品、也能下单（交易不受影响）。',
        api: '/api/blocks/mine',
        cancel: (id) => api.del(`/api/blocks/${id}`),
        cancelText: '解除拉黑',
        timeLabel: '拉黑时间',
        timeKey: 'blocked_at',
        empty: ['还没有拉黑任何人', '🚫'],
      }
      : {
        title: '我的关注',
        hint: '你关注的人（单向关注，只是为了方便找 TA）。',
        api: '/api/follows/mine',
        cancel: (id) => api.del(`/api/follows/${id}`),
        cancelText: '取消关注',
        timeLabel: '关注时间',
        timeKey: 'followed_at',
        empty: ['还没有关注任何人，去商品详情或用户主页点「关注」试试', '⭐'],
      };

    root.innerHTML = `
      <div class="page-head">
        <h1>${cfg.title}</h1>
        <span class="muted small">${cfg.hint}</span>
      </div>
      <div class="card" id="social-list">${loadingHtml()}</div>`;

    const box = root.querySelector('#social-list');

    async function load() {
      box.innerHTML = loadingHtml();
      let data;
      try {
        data = await api.get(cfg.api);
      } catch (err) {
        box.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }
      const list = data.list || [];
      if (!list.length) {
        box.innerHTML = emptyHtml(cfg.empty[0], cfg.empty[1]);
        return;
      }
      box.innerHTML = `
        <div class="social-list">
          ${list.map(u => `
            <div class="social-item" data-uid="${u.id}">
              <span class="user-link row" style="gap:10px;align-items:center" data-go-user="${u.id}"
                    title="查看 TA 的主页">
                ${avatarHtml(u, 44)}
                <span>
                  <b>${esc(u.nickname)}</b>
                  <span class="muted small">　${esc(cfg.timeLabel)} ${esc(u[cfg.timeKey] || '')}</span>
                  <div class="muted small">${esc(u.bio || 'TA 还没填写简介')}</div>
                </span>
              </span>
              <span class="row" style="gap:8px">
                <button class="btn btn-sm" data-go-user="${u.id}">查看主页</button>
                <button class="btn btn-danger btn-sm" data-cancel="${u.id}"
                        data-name="${esc(u.nickname)}">${cfg.cancelText}</button>
              </span>
            </div>`).join('')}
        </div>`;

      box.querySelectorAll('[data-go-user]').forEach(el =>
        el.addEventListener('click', () => { location.hash = `#/seller/${el.dataset.goUser}`; }));
      box.querySelectorAll('[data-cancel]').forEach(btn =>
        btn.addEventListener('click', async (event) => {
          event.stopPropagation();
          const sure = await confirmDialog({
            title: `${cfg.cancelText}「${btn.dataset.name}」？`,
            okText: cfg.cancelText,
            danger: isBlock,
            message: isBlock
              ? '解除后你又能看到 TA 的商品与评论，TA 也能给你发私信了。'
              : '取消关注后，TA 的粉丝数会减一（不会通知对方）。',
          });
          if (!sure) return;
          try {
            await cfg.cancel(btn.dataset.cancel);
            toast(`已${cfg.cancelText}`);
            load();
          } catch (err) { toast(err.message, 'error'); }
        }));
    }

    await load();
  },
};
