/* ==========================================================================
   可复用片段：商品卡、订单卡、帖子条目
   ========================================================================== */
import { esc, fmtPrice, fmtTime, coverHtml, statusFlagHtml, statusBadgeHtml, starsHtml } from './ui.js';

/* ---------------------------------------------------------------- 商品卡 */
export function productCardHtml(product) {
  const price = Number(product.price || 0);
  return `
  <article class="product-card" data-product="${product.id}">
    <div class="pc-cover">
      ${statusFlagHtml(product.status)}
      ${coverHtml(product)}
    </div>
    <div class="pc-body">
      <div class="pc-name" title="${esc(product.name)}">${esc(product.name)}</div>
      <div class="pc-meta">
        <span class="price"><small>¥</small>${price.toFixed(2)}</span>
        <span class="badge badge-gray">${esc(product.condition || '')}</span>
      </div>
      <div class="pc-foot">
        <span>${esc(product.category_icon || '')} ${esc(product.category_name || '')}</span>
        <span title="浏览 / 想要人数">👁 ${product.views ?? 0} · ❤️ ${product.want_count ?? 0}</span>
      </div>
    </div>
  </article>`;
}

export function bindProductCards(root) {
  root.querySelectorAll('[data-product]').forEach(card => {
    card.addEventListener('click', () => { location.hash = `#/product/${card.dataset.product}`; });
  });
}

/* ---------------------------------------------------------------- 订单卡 */
const ORDER_STATUS = {
  awaiting: '待卖家确认', pending: '待完成', done: '已完成', canceled: '已取消',
};

export function orderCardHtml(order, side = 'buyer') {
  const snap = order.product || {};
  const icon = snap.category_icon || '📦';
  const cover = snap.cover
    ? `<img src="/uploads/${encodeURIComponent(snap.cover)}" alt="">`
    : `<span style="font-size:34px">${esc(icon)}</span>`;
  // 需求④/⑦：一个账号既可能买也可能卖，所以以「这张单里我的身份」为准，
  // 而不是调用方传进来的默认值——我的订单页把两侧合成一页后，这个区别很关键
  // （取消订单只有买家有、删除记录各删各的）。
  const myRole = order.my_role || side;
  // 本批需求⑤：这里的「买家 / 卖家」用户名可以点，点了直接进与 TA 的私信
  const otherId = myRole === 'buyer' ? order.seller_id : order.buyer_id;
  const otherNick = myRole === 'buyer' ? order.seller_nickname : order.buyer_nickname;
  const otherLabel = myRole === 'buyer' ? '卖家' : '买家';
  const other = `${esc(otherLabel)}：<span class="user-link" data-msg-user="${otherId}"
    title="点这里给 TA 发私信">${esc(otherNick || '')}</span>`;
  const roleBadge = myRole === 'buyer'
    ? '<span class="badge badge-info role-flag">我是买家</span>'
    : '<span class="badge badge-warn role-flag">我是卖家</span>';
  const ops = [];
  // 新批需求③：下单只是「购买意向」，要等卖家确认才锁定商品
  if (order.status === 'awaiting') {
    if (myRole === 'seller') {
      ops.push(`<button class="btn btn-primary btn-sm" data-act="confirm" data-id="${order.id}">✅ 确认交易</button>`);
      ops.push(`<button class="btn btn-danger btn-sm" data-act="reject" data-id="${order.id}">✖ 拒绝</button>`);
    } else {
      ops.push(`<button class="btn btn-sm" data-act="cancel" data-id="${order.id}">撤回意向</button>`);
    }
  }
  if (order.status === 'pending') {
    if (myRole === 'buyer') {
      ops.push(`<button class="btn btn-primary btn-sm" data-act="complete" data-id="${order.id}">确认完成</button>`);
      ops.push(`<button class="btn btn-danger btn-sm" data-act="cancel" data-id="${order.id}">取消订单</button>`);
    } else {
      // 需求⑥：卖家也能确认完成（线下交付后任一方确认都合理；取消仍只给买家）
      ops.push(`<button class="btn btn-primary btn-sm" data-act="complete" data-id="${order.id}">确认完成</button>`);
    }
    ops.push(`<button class="btn btn-sm" data-act="map" data-id="${order.id}">📍 查看自提位置</button>`);
  }
  if (order.status === 'done') {
    ops.push(`<button class="btn btn-sm" data-act="review" data-id="${order.id}">⭐ 评价</button>`);
  }
  // 功能④ / 需求⑥：买卖双方各自可以删掉自己那一侧的订单记录（进行中的不行）
  if (!['awaiting', 'pending'].includes(order.status)) {
    ops.push(`<button class="btn btn-danger btn-sm" data-act="del-order" data-id="${order.id}">删除记录</button>`);
  }
  ops.push(`<button class="btn btn-ghost btn-sm" data-act="product" data-id="${order.product_id}">查看商品</button>`);

  // 进行中的单子给一句状态说明，免得用户不知道在等谁
  const waitingHint = order.status === 'awaiting'
    ? (myRole === 'seller'
      ? '<div class="small muted mt-8">⏳ 买家已提交购买意向，确认后商品才会锁定给对方</div>'
      : '<div class="small muted mt-8">⏳ 已提交购买意向，等卖家确认；确认前商品仍可能被别人买走</div>')
    : '';

  return `
  <div class="card" style="padding:14px 16px">
    <div class="row-between mb-8">
      <span class="small muted">订单号 ${esc(order.order_no)}　${esc(fmtTime(order.created_at))}</span>
      <span class="row" style="gap:8px;align-items:center">
        ${roleBadge}
        ${statusBadgeHtml(order.status, ORDER_STATUS[order.status] || order.status)}
      </span>
    </div>
    <div class="row" style="align-items:flex-start;gap:14px">
      <div class="pc-cover" style="width:72px;height:72px;border-radius:10px;flex:0 0 72px">${cover}</div>
      <div style="flex:1;min-width:0">
        <div class="strong">${esc(snap.name || '（商品已删除）')}</div>
        ${order.product_code ? `<div class="small muted mt-0" style="letter-spacing:.04em;user-select:all">编号 ${esc(order.product_code)}</div>` : ''}
        <div class="small muted mt-0">${other}　·　${esc(fmtTime(order.created_at))}</div>
        <div class="small muted">自提点：${esc(order.meet_place?.name || '未指定')}</div>
        ${order.trade_note ? `<div class="small muted">交易说明：${esc(order.trade_note)}</div>` : ''}
        ${waitingHint}
      </div>
      <div class="text-right">
        <div class="price">${fmtPrice(order.price)}</div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="row" style="justify-content:flex-end;gap:8px">${ops.join('')}</div>
  </div>`;
}

/* ---------------------------------------------------------------- 帖子条目 */
export function postItemHtml(post, options = {}) {
  const tagClass = { 安利: '', 避雷: 'badge-danger', 闲聊: 'badge-gray', 求助: 'badge-info' };
  // 功能⑤：整张帖子卡片都可点击进详情（不再只能点标题）；
  // 点赞 / 删除这类按钮由 pages/posts.js 里 stopPropagation 拦下来，不触发跳转。
  return `
  <div class="post-item" data-post="${post.id}" title="点击查看帖子详情">
    <div class="row-between">
      <div class="post-title">${esc(post.title)}</div>
      <span class="badge ${tagClass[post.tag] || 'badge-gray'}">${esc(post.tag)}</span>
    </div>
    ${options.preview === false ? '' : `<div class="muted small mt-8" style="overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(post.content)}</div>`}
    ${(post.images || []).length ? `
      <div class="post-thumbs">
        ${post.images.slice(0, 3).map(url => `<img src="/uploads/${encodeURIComponent(url)}" alt="" loading="lazy">`).join('')}
        ${post.images.length > 1 ? `<span class="post-thumb-more">共 ${post.images.length} 张</span>` : ''}
      </div>` : ''}
    <div class="post-meta">
      <span class="user-link" data-user="${post.author_id}" title="查看 TA 的主页">👤 ${esc(post.author_nickname || '')}</span>
      <span>🕒 ${esc(fmtTime(post.created_at))}</span>
      <span>💬 <span data-comment-count="${post.id}">${post.comment_count}</span> 条评论</span>
    </div>
    <div class="post-actions">
      <button data-like="${post.id}" class="${post.liked ? 'liked' : ''}">
        ${post.liked ? '❤️' : '🤍'} <span data-like-count="${post.id}">${post.like_count}</span>
      </button>
      <button data-comment="${post.id}">💬 评论</button>
      ${options.canDelete ? `<button data-delete="${post.id}">🗑️ 删除</button>` : ''}
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- 评价条目 */
export function reviewItemHtml(review) {
  // 新批需求⑤：评价下面多一层评论，并且评价本身可以举报
  const count = review.comment_count || 0;
  return `
  <div class="review-item" data-review="${review.id}">
    <div class="review-head">
      <span class="rh-name user-link" data-user="${review.reviewer_id}"
            title="查看 TA 的主页">${esc(review.reviewer_nickname || '匿名')}</span>
      ${starsHtml(review.rating)}
      <span class="badge badge-gray">${esc(review.direction || '')}</span>
      <span class="rh-time">${esc(fmtTime(review.created_at))}</span>
    </div>
    ${review.content ? `<div class="review-body">${esc(review.content)}</div>` : '<div class="review-body muted">（没有填写文字评价）</div>'}
    <div class="review-ops">
      <button class="btn btn-ghost btn-sm" data-rev-comments="${review.id}">
        💬 评论（<span data-rev-count="${review.id}">${count}</span>）
      </button>
      <button class="btn btn-ghost btn-sm" data-rev-report="${review.id}">🚩 举报评价</button>
    </div>
    <div class="review-comments" data-rev-box="${review.id}" hidden></div>
  </div>`;
}

export { ORDER_STATUS };
