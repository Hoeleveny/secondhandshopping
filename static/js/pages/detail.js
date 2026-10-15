/* ==========================================================================
   M04 商品详情：完整信息 + 浏览量 + 按角色显示操作
   ========================================================================== */
import { api } from '../api.js';
import { store } from '../store.js';
import { ensureMeta, ensurePlaces } from '../data.js';
import { reviewItemHtml } from '../components.js';
import {
  confirmDialog, emptyHtml, esc, fmtPrice, fmtTime, go, imgUrl,
  openModal, statusFlagHtml, toast,
} from '../ui.js';

export default {
  async render(root, ctx) {
    const id = ctx.params.id;
    let product;
    try {
      product = await api.get(`/api/products/${id}`);
    } catch (err) {
      root.innerHTML = emptyHtml(`商品打不开：${err.message}`, '🚫');
      return;
    }

    const images = product.images || [];
    const price = Number(product.price || 0);

    root.innerHTML = `
      <div class="page-head">
        <button class="btn btn-ghost btn-sm" id="btn-back">‹ 返回</button>
        <span class="muted small">本页每打开一次，浏览量 +1（当前 ${product.views}）</span>
      </div>

      <div class="card">
        <div class="detail-wrap">
          <div>
            <div class="gallery-main" id="gallery-main">
              ${images.length ? `<img src="${esc(imgUrl(images[0]))}" alt="${esc(product.name)}">`
                              : `<span>${esc(product.category_icon || '📦')}</span>`}
            </div>
            ${images.length > 1 ? `
              <div class="gallery-thumbs" id="thumbs">
                ${images.map((img, i) => `<img src="${esc(imgUrl(img))}" data-i="${i}" class="${i === 0 ? 'active' : ''}">`).join('')}
              </div>` : ''}
          </div>

          <div>
            <div class="row" style="gap:10px">
              ${statusFlagHtml(product.status)}
              <h1 style="margin:0;flex:1">${esc(product.name)}</h1>
            </div>
            <div class="detail-price mt-8">${fmtPrice(price)}</div>

            <dl class="info-list mt-16">
              <dt>成色</dt><dd>${esc(product.condition)}</dd>
              <dt>分类</dt><dd>${esc(product.category_icon || '')} ${esc(product.category_name || '')}${product.subcategory_name ? ` / ${esc(product.subcategory_name)}` : ''}</dd>
              <dt>卖家</dt><dd><button class="link-btn" data-seller="${product.seller_id}">${esc(product.seller_nickname || '')}</button></dd>
              <dt>默认自提点</dt><dd>${esc(product.default_place?.name || '未指定')}</dd>
              <dt>发布时间</dt><dd>${esc(fmtTime(product.created_at))}</dd>
              <dt>浏览量</dt><dd>👁 ${product.views}</dd>
              <dt>平均评分</dt><dd>${product.avg_rating ? `<span class="stars">★ ${product.avg_rating}</span>（${product.review_count} 条）` : '<span class="muted">暂无评价</span>'}</dd>
              <dt>想要人数</dt><dd id="want-count-line">❤️ <b id="want-count">${product.want_count ?? 0}</b> 人想要</dd>
              ${product.product_code ? `<dt>商品编号</dt><dd class="muted small" id="product-code" style="user-select:all">${esc(product.product_code)}</dd>` : ''}
            </dl>

            <div class="divider"></div>
            <h3>商品描述</h3>
            <p class="muted" style="white-space:pre-wrap">${esc(product.description || '卖家没有填写描述')}</p>

            <div class="action-bar" id="action-bar"></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>交易评价</h2><span class="muted small">共 ${product.review_count} 条</span></div>
        <div id="review-area">
          ${product.reviews.length ? product.reviews.map(reviewItemHtml).join('') : emptyHtml('这件商品还没有评价', '💬')}
        </div>
      </div>`;

    root.querySelector('#btn-back').addEventListener('click', () => history.back());

    // 图片切换
    const thumbs = root.querySelector('#thumbs');
    if (thumbs) {
      thumbs.addEventListener('click', (event) => {
        const img = event.target.closest('img[data-i]');
        if (!img) return;
        const index = Number(img.dataset.i);
        root.querySelector('#gallery-main').innerHTML =
          `<img src="${esc(imgUrl(images[index]))}" alt="">`;
        thumbs.querySelectorAll('img').forEach(el => el.classList.remove('active'));
        img.classList.add('active');
      });
    }

    renderActions(root, product, id);
  },
};

/* ------------------------------------------------------------------ 操作区 */
async function renderActions(root, product, id) {
  const bar = root.querySelector('#action-bar');
  const loggedIn = store.isLoggedIn;
  const buttons = [];

  if (!loggedIn) {
    buttons.push(`<button class="btn btn-primary btn-lg" data-act="login">登录后购买</button>`);
    buttons.push(`<button class="btn" data-act="login">🤍 我想要</button>`);
    buttons.push(`<button class="btn" data-act="login">⭐ 收藏</button>`);
    buttons.push(`<button class="btn" data-act="login">🚩 举报</button>`);
  } else if (product.is_admin && !product.is_owner) {
    buttons.push(`<button class="btn btn-primary" data-act="buy" ${product.can_buy ? '' : 'disabled'}>立即购买</button>`);
    if (product.status === 'on_sale') buttons.push(`<button class="btn" data-act="admin-off">下架商品</button>`);
    if (product.status === 'off_shelf') buttons.push(`<button class="btn" data-act="admin-on">重新上架</button>`);
    buttons.push(`<button class="btn btn-danger" data-act="admin-del">删除商品</button>`);
  } else if (product.is_owner) {
    buttons.push(`<button class="btn btn-primary" data-act="edit">✏️ 编辑</button>`);
    if (product.status === 'on_sale') buttons.push(`<button class="btn" data-act="off">下架</button>`);
    if (product.status === 'off_shelf') buttons.push(`<button class="btn" data-act="on">重新上架</button>`);
    buttons.push(`<span class="badge badge-info">这是我发布的商品</span>`);
  } else {
    buttons.push(`<button class="btn btn-primary btn-lg" data-act="buy" ${product.can_buy ? '' : 'disabled'}>
        ${product.can_buy ? '立即购买' : (product.status === 'sold' ? '已被买走' : '暂不可购买')}
      </button>`);
    buttons.push(`<button class="btn ${product.wanted ? 'btn-primary' : ''}" data-act="want">${product.wanted ? '❤️ 已想要' : '🤍 我想要'} <span id="want-btn-count">${product.want_count ?? 0}</span></button>`);
    buttons.push(`<button class="btn" data-act="compare">📊 比一比</button>`);
    buttons.push(`<button class="btn" data-act="fav">${product.favorited ? '★ 已收藏' : '☆ 收藏'}</button>`);
    buttons.push(`<button class="btn" data-act="msg">✉️ 私信卖家</button>`);
    buttons.push(`<button class="btn" data-act="report">🚩 举报</button>`);
  }

  bar.innerHTML = buttons.join('');

  // 需求②：卖家昵称（信息区与下方「卖家：xxx」两处）都可点进卖家主页。
  // 直接绑元素而不是绑 root——root 是常驻容器，绑它会在翻页时不断累积监听器。
  root.querySelectorAll('[data-seller]').forEach(el =>
    el.addEventListener('click', () => go(`#/seller/${el.dataset.seller}`)));

  bar.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'login') { go('#/login?next=' + encodeURIComponent(`#/product/${id}`)); return; }
    if (act === 'compare') { go(`#/compare?category_id=${product.category_id}`); return; }
    if (act === 'edit') { go(`#/product/${id}/edit`); return; }
    if (act === 'msg') { go(`#/messages?to=${product.seller_id}&product=${id}`); return; }

    // 功能③：点一次标记「我想要」，再点取消
    if (act === 'want') {
      try {
        const data = await api.post(`/api/products/${id}/want`);
        product.wanted = data.wanted;
        product.want_count = data.want_count;
        const wantBtn = bar.querySelector('[data-act="want"]');
        wantBtn.classList.toggle('btn-primary', data.wanted);
        wantBtn.innerHTML = `${data.wanted ? '❤️ 已想要' : '🤍 我想要'} <span id="want-btn-count">${data.want_count}</span>`;
        const line = root.querySelector('#want-count');
        if (line) line.textContent = data.want_count;
        toast(data.wanted ? '已标记「我想要」' : '已取消「我想要」');
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }

    try {
      if (act === 'fav') {
        if (product.favorited) {
          await api.del(`/api/favorites/${id}`);
          product.favorited = false;
          toast('已取消收藏');
        } else {
          await api.post('/api/favorites', { product_id: Number(id) });
          product.favorited = true;
          toast('收藏成功');
        }
        btn.textContent = product.favorited ? '★ 已收藏' : '☆ 收藏';
        return;
      }

      if (act === 'buy') { await openBuyModal(product); return; }
      if (act === 'report') { await openReportModal(product); return; }

      if (act === 'off' || act === 'on') {
        const target = act === 'off' ? 'off_shelf' : 'on_sale';
        const okToGo = await confirmDialog({
          title: act === 'off' ? '确认下架？' : '确认重新上架？',
          message: act === 'off' ? '下架后买家将看不到这件商品，你自己仍可在「我的商品」里看到。'
                                 : '重新上架后买家可以再次搜索到并购买。',
          okText: act === 'off' ? '下架' : '重新上架',
        });
        if (!okToGo) return;
        await api.patch(`/api/products/${id}/status`, { status: target });
        toast(act === 'off' ? '已下架' : '已重新上架');
        location.reload();
        return;
      }

      if (act === 'admin-off' || act === 'admin-on') {
        const target = act === 'admin-off' ? 'off_shelf' : 'on_sale';
        await api.patch(`/api/admin/products/${id}/status`, { status: target });
        toast(target === 'on_sale' ? '已重新上架' : '已下架');
        location.reload();
        return;
      }

      if (act === 'admin-del') {
        const sure = await confirmDialog({
          title: '确认删除商品？', danger: true, okText: '删除',
          message: '删除后所有买家都看不到该商品；历史订单仍会保留商品快照。',
        });
        if (!sure) return;
        await api.del(`/api/admin/products/${id}`);
        toast('商品已删除');
        go('#/search');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ------------------------------------------------------------------ 下单 */
async function openBuyModal(product) {
  const places = await ensurePlaces();
  const options = places.map(p =>
    `<option value="${p.id}" ${p.id === product.default_place_id ? 'selected' : ''}>${esc(p.name)}（${esc(p.type)}）</option>`).join('');

  openModal({
    title: '确认下单',
    body: `
      <div class="row" style="gap:12px;align-items:flex-start">
        <div class="pc-cover" style="width:70px;height:70px;border-radius:10px;flex:0 0 70px">
          ${product.cover ? `<img src="${esc(imgUrl(product.cover))}" alt="">` : `<span style="font-size:32px">${esc(product.category_icon || '📦')}</span>`}
        </div>
        <div style="flex:1">
          <div class="strong">${esc(product.name)}</div>
          <div class="price mt-8">${fmtPrice(product.price)}</div>
          <div class="muted small">卖家：<button class="link-btn" data-seller="${product.seller_id}">${esc(product.seller_nickname || '')}</button></div>
        </div>
      </div>
      <div class="divider"></div>
      <div class="form-row">
        <label>约定自提点<span class="req">*</span></label>
        <select class="select" id="buy-place">${options}</select>
        <div class="hint">线下当面交易，请选择双方都方便见面的校园地点</div>
      </div>
      <div class="form-row">
        <label>交易说明</label>
        <textarea class="textarea" id="buy-note" placeholder="例如：今天下午 4 点后都行，到了联系我"></textarea>
      </div>
      <div class="hint">下单后商品会立即变为「已售出」，其他人无法再购买。</div>`,
    footer: `<button class="btn" data-close>取消</button>
             <button class="btn btn-primary" id="buy-confirm">确认下单</button>`,
    onMount(modal, close) {
      modal.querySelector('#buy-confirm').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const order = await api.post('/api/orders', {
            product_id: product.id,
            meet_place_id: Number(modal.querySelector('#buy-place').value),
            trade_note: modal.querySelector('#buy-note').value.trim(),
          });
          close();
          toast('下单成功，请与卖家约定自提时间');
          go(`#/order/${order.id}/map`);
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      });
    },
  });
}

/* ------------------------------------------------------------------ 举报 */
async function openReportModal(product) {
  const meta = await ensureMeta();
  openModal({
    title: '举报商品',
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
            target_type: 'product',
            target_id: product.id,
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
