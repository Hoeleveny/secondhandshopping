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
const ORDER_STATUS = { pending: '待完成', done: '已完成', canceled: '已取消' };

export function orderCardHtml(order, side = 'buyer') {
  const snap = order.product || {};
  const icon = snap.category_icon || '📦';
  const cover = snap.cover
    ? `<img src="/uploads/${encodeURIComponent(snap.cover)}" alt="">`
    : `<span style="font-size:34px">${esc(icon)}</span>`;
  const other = side === 'buyer'
    ? `卖家：${esc(order.seller_nickname || '')}`
    : `买家：${esc(order.buyer_nickname || '')}`;
  const ops = [];
  if (order.status === 'pending') {
    if (side === 'buyer') {
      ops.push(`<button class="btn btn-primary btn-sm" data-act="complete" data-id="${order.id}">确认完成</button>`);
      ops.push(`<button class="btn btn-danger btn-sm" data-act="cancel" data-id="${order.id}">取消订单</button>`);
    }
    ops.push(`<button class="btn btn-sm" data-act="map" data-id="${order.id}">📍 查看自提位置</button>`);
  }
  if (order.status === 'done') {
    ops.push(`<button class="btn btn-sm" data-act="review" data-id="${order.id}">⭐ 评价</button>`);
  }
  ops.push(`<button class="btn btn-ghost btn-sm" data-act="product" data-id="${order.product_id}">查看商品</button>`);

  return `
  <div class="card" style="padding:14px 16px">
    <div class="row-between mb-8">
      <span class="small muted">订单号 ${esc(order.order_no)}　${esc(fmtTime(order.created_at))}</span>
      ${statusBadgeHtml(order.status, ORDER_STATUS[order.status] || order.status)}
    </div>
    <div class="row" style="align-items:flex-start;gap:14px">
      <div class="pc-cover" style="width:72px;height:72px;border-radius:10px;flex:0 0 72px">${cover}</div>
      <div style="flex:1;min-width:0">
        <div class="strong">${esc(snap.name || '（商品已删除）')}</div>
        <div class="small muted mt-0">${esc(other)}　·　${esc(fmtTime(order.created_at))}</div>
        <div class="small muted">自提点：${esc(order.meet_place?.name || '未指定')}</div>
        ${order.trade_note ? `<div class="small muted">交易说明：${esc(order.trade_note)}</div>` : ''}
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
  const tags = ['安利', '避雷', '闲聊', '求助'];
  const tagClass = { 安利: '', 避雷: 'badge-danger', 闲聊: 'badge-gray', 求助: 'badge-info' };
  return `
  <div class="post-item" data-post="${post.id}">
    <div class="row-between">
      <div class="post-title" data-open="${post.id}">${esc(post.title)}</div>
      <span class="badge ${tagClass[post.tag] || 'badge-gray'}">${esc(post.tag)}</span>
    </div>
    ${options.preview === false ? '' : `<div class="muted small mt-8" style="overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(post.content)}</div>`}
    <div class="post-meta">
      <span>👤 ${esc(post.author_nickname || '')}</span>
      <span>🕒 ${esc(fmtTime(post.created_at))}</span>
      <span>💬 ${post.comment_count} 条评论</span>
    </div>
    <div class="post-actions">
      <button data-like="${post.id}" class="${post.liked ? 'liked' : ''}">
        ${post.liked ? '❤️' : '🤍'} <span data-like-count="${post.id}">${post.like_count}</span>
      </button>
      <button data-open="${post.id}">💬 评论</button>
      ${options.canDelete ? `<button data-delete="${post.id}">🗑️ 删除</button>` : ''}
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- 评价条目 */
export function reviewItemHtml(review) {
  return `
  <div class="review-item">
    <div class="review-head">
      <span class="rh-name">${esc(review.reviewer_nickname || '匿名')}</span>
      ${starsHtml(review.rating)}
      <span class="badge badge-gray">${esc(review.direction || '')}</span>
      <span class="rh-time">${esc(fmtTime(review.created_at))}</span>
    </div>
    ${review.content ? `<div class="review-body">${esc(review.content)}</div>` : '<div class="review-body muted">（没有填写文字评价）</div>'}
  </div>`;
}

export { ORDER_STATUS };
