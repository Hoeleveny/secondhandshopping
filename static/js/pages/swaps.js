/* ==========================================================================
   M12 以物换物
   流程：发布换物（自己的在售商品 + 估价）→ 系统列出估价 ±20% 的换物 →
        点「发起交换」即达成，双方换物互标 matched、双方商品变「已售」
   ========================================================================== */
import { api, qs } from '../api.js';
import {
  confirmDialog, emptyHtml, esc, fmtPrice, fmtTime, imgUrl, loadingHtml, openModal, toast,
} from '../ui.js';

export default {
  async render(root, ctx) {
    let tab = ctx.query.tab === 'mine' ? 'mine' : 'square';

    root.innerHTML = `
      <div class="page-head">
        <h1>以物换物</h1>
        <button class="btn btn-primary" id="btn-publish">➕ 发布换物</button>
      </div>
      <div class="tabs" id="tabs">
        <button class="tab ${tab === 'square' ? 'active' : ''}" data-tab="square">换物广场</button>
        <button class="tab ${tab === 'mine' ? 'active' : ''}" data-tab="mine">我的换物</button>
      </div>
      <div class="card" style="background:var(--green-soft);border-color:var(--green-line)">
        <b>怎么换？</b>
        <span class="muted">发布时给物品填一个估价，系统会按 <b>±20%</b> 帮你找出估价相近的换物；
        对方向你发起交换或你向对方发起，一旦发起即视为达成，双方商品会自动标记为「已售」。</span>
      </div>
      <div id="list-area"></div>`;

    const listArea = root.querySelector('#list-area');
    const tabsEl = root.querySelector('#tabs');

    tabsEl.querySelectorAll('[data-tab]').forEach(btn =>
      btn.addEventListener('click', () => {
        tab = btn.dataset.tab;
        tabsEl.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        history.replaceState(null, '', `#/swaps${qs({ tab })}`);
        load();
      }));

    root.querySelector('#btn-publish').addEventListener('click', () => openPublishModal(load));

    async function load() {
      listArea.innerHTML = loadingHtml();
      if (tab === 'mine') return loadMine();
      return loadSquare();
    }

    async function loadSquare() {
      let data;
      try {
        data = await api.get('/api/swaps?status=open&page_size=50');
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }
      if (!data.list.length) {
        listArea.innerHTML = emptyHtml('换物广场还空着，发布一条试试', '🔄');
        return;
      }
      listArea.innerHTML = `<div class="grid grid-2">${data.list.map(offerCard).join('')}</div>`;
      bindCards();
    }

    async function loadMine() {
      let offers;
      try {
        offers = await api.get('/api/swaps/mine');
      } catch (err) {
        listArea.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
        return;
      }
      if (!offers.length) {
        listArea.innerHTML = emptyHtml('你还没有发布过换物', '🔄');
        return;
      }
      listArea.innerHTML = `<div class="grid grid-2">${offers.map(offerCard).join('')}</div>`;
      bindCards();
    }

    function offerCard(offer) {
      const product = offer.product || {};
      const cover = product.cover
        ? `<img src="${esc(imgUrl(product.cover))}" alt="">`
        : `<span style="font-size:34px">${esc(product.category_icon || '📦')}</span>`;
      const range = offer.match_range || [];
      const statusText = { open: '进行中', matched: '已匹配', closed: '已关闭' }[offer.status] || offer.status;
      return `
        <div class="card" data-offer="${offer.id}" style="margin:0">
          <div class="row" style="align-items:flex-start;gap:12px">
            <div class="pc-cover" style="width:78px;height:78px;border-radius:10px;flex:0 0 78px">${cover}</div>
            <div style="flex:1;min-width:0">
              <div class="row-between">
                <span class="strong">${esc(offer.title)}</span>
                <span class="badge ${offer.status === 'open' ? '' : 'badge-gray'}">${esc(statusText)}</span>
              </div>
              <div class="muted small">物品：${esc(product.name || '（商品已删除）')}</div>
              <div class="row mt-8" style="gap:10px">
                <span class="price">${fmtPrice(offer.estimate_price)}</span>
                ${range.length === 2 ? `<span class="badge badge-info">匹配区间 ${fmtPrice(range[0])} ~ ${fmtPrice(range[1])}</span>` : ''}
              </div>
              <div class="pc-foot mt-8">
                <span>👤 ${esc(offer.user_nickname || '')}</span>
                <span>🕒 ${esc(fmtTime(offer.created_at))}</span>
              </div>
            </div>
          </div>
          <div class="divider"></div>
          <div class="row" style="justify-content:flex-end;gap:8px">
            ${offer.is_mine && offer.status === 'open'
              ? `<button class="btn btn-primary btn-sm" data-match="${offer.id}">🔍 查看匹配 / 发起交换</button>
                 <button class="btn btn-sm" data-close-offer="${offer.id}">关闭</button>`
              : offer.matched_offer_id
                ? `<span class="badge">已与换物 #${offer.matched_offer_id} 达成交换</span>`
                : ''}
            ${product.id ? `<button class="btn btn-ghost btn-sm" data-product="${product.id}">查看商品</button>` : ''}
          </div>
        </div>`;
    }

    function bindCards() {
      listArea.querySelectorAll('[data-product]').forEach(btn =>
        btn.addEventListener('click', (e) => { e.stopPropagation(); location.hash = `#/product/${btn.dataset.product}`; }));
      listArea.querySelectorAll('[data-match]').forEach(btn =>
        btn.addEventListener('click', () => openMatchModal(btn.dataset.match, load)));
      listArea.querySelectorAll('[data-close-offer]').forEach(btn =>
        btn.addEventListener('click', async () => {
          const sure = await confirmDialog({ title: '关闭这条换物？', okText: '关闭', message: '关闭后它不再出现在换物广场。' });
          if (!sure) return;
          try { await api.post(`/api/swaps/${btn.dataset.closeOffer}/close`); toast('已关闭'); load(); }
          catch (err) { toast(err.message, 'error'); }
        }));
    }

    await load();
  },
};

/* ------------------------------------------------------------------ 发布换物 */
async function openPublishModal(onDone) {
  let mine;
  try {
    mine = await api.get('/api/products/mine?status=on_sale&page_size=50');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (!mine.list.length) {
    toast('你还没有「在售」的商品，先发布一件再来换物', 'warn');
    return;
  }

  openModal({
    title: '发布换物',
    body: `
      <div class="form-row">
        <label>用哪件商品来换<span class="req">*</span></label>
        <select class="select" id="sw-product">
          ${mine.list.map(p => `<option value="${p.id}" data-price="${p.price}">${esc(p.name)}（${fmtPrice(p.price)}）</option>`).join('')}
        </select>
      </div>
      <div class="form-row">
        <label>换物标题<span class="req">*</span></label>
        <input class="input" id="sw-title" maxlength="100" placeholder="例如：高数教材换考研资料">
      </div>
      <div class="form-row">
        <label>估价（元）<span class="req">*</span></label>
        <input class="input" id="sw-estimate" type="number" min="0.01" step="0.01" placeholder="用于 ±20% 匹配">
        <div class="hint" id="sw-hint"></div>
      </div>`,
    footer: `<button class="btn" data-close>取消</button>
             <button class="btn btn-primary" id="sw-submit">发布</button>`,
    onMount(modal, close) {
      const productSelect = modal.querySelector('#sw-product');
      const estimateInput = modal.querySelector('#sw-estimate');
      const hint = modal.querySelector('#sw-hint');

      const syncDefaults = () => {
        const option = productSelect.selectedOptions[0];
        const price = Number(option?.dataset.price || 0);
        if (!estimateInput.value) estimateInput.value = price.toFixed(2);
        const estimate = Number(estimateInput.value || 0);
        if (estimate > 0) {
          hint.textContent = `将匹配估价 ${fmtPrice(estimate * 0.8)} ~ ${fmtPrice(estimate * 1.2)} 的物品`;
        }
        const name = option?.textContent || '';
        const titleInput = modal.querySelector('#sw-title');
        if (!titleInput.value) titleInput.value = `用${name.split('（')[0]}换物`;
      };
      productSelect.addEventListener('change', () => { estimateInput.value = ''; syncDefaults(); });
      estimateInput.addEventListener('input', syncDefaults);
      syncDefaults();

      modal.querySelector('#sw-submit').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api.post('/api/swaps', {
            product_id: Number(productSelect.value),
            title: modal.querySelector('#sw-title').value.trim(),
            estimate_price: Number(estimateInput.value),
          });
          close();
          toast('换物已发布');
          if (onDone) onDone();
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      });
    },
  });
}

/* ------------------------------------------------------------------ 匹配与发起交换 */
async function openMatchModal(offerId, onDone) {
  let data;
  try {
    data = await api.get(`/api/swaps/${offerId}/matches`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  const range = data.range || [];
  const matches = data.matches || [];

  openModal({
    title: `匹配结果（估价 ${fmtPrice(range[0])} ~ ${fmtPrice(range[1])}）`,
    wide: true,
    body: matches.length ? `
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>换物</th><th>物品</th><th>发起人</th><th class="text-right">估价</th><th>操作</th></tr></thead>
          <tbody>
            ${matches.map(m => `
              <tr>
                <td>${esc(m.title)}</td>
                <td>${esc(m.product?.name || '')}</td>
                <td>${esc(m.user_nickname || '')}</td>
                <td class="text-right price">${fmtPrice(m.estimate_price)}</td>
                <td>
                  <button class="btn btn-primary btn-sm" data-exchange="${m.id}">发起交换</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="hint mt-8">发起交换后立即达成：双方换物标记为「已匹配」，双方商品变为「已售」。</div>`
      : emptyHtml('暂时没有估价相近的换物，等等看或者调整估价', '🔍'),
    onMount(modal, close) {
      modal.querySelectorAll('[data-exchange]').forEach(btn =>
        btn.addEventListener('click', async () => {
          const sure = await confirmDialog({
            title: '确认发起交换？', okText: '发起交换',
            message: '发起即视为达成：双方这条换物会被标记为已匹配，双方商品都会变成「已售」。',
          });
          if (!sure) return;
          try {
            await api.post(`/api/swaps/${offerId}/exchange`, { target_offer_id: Number(btn.dataset.exchange) });
            close();
            toast('交换达成，双方商品已标记为已售');
            if (onDone) onDone();
          } catch (err) {
            toast(err.message, 'error');
          }
        }));
    },
  });
}
