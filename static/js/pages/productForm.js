/* ==========================================================================
   M09 发布 / 编辑商品：表单 + 右侧实时预览 + 多图上传 + 表单校验
   ========================================================================== */
import { api } from '../api.js';
import { invalidateCatalog, ensureCategories, ensureMeta, ensurePlaces } from '../data.js';
import { emptyHtml, esc, go, imgUrl, toast } from '../ui.js';

export default {
  async render(root, ctx) {
    const editing = Boolean(ctx.params.id);
    const [categories, places, meta] = await Promise.all([
      ensureCategories(), ensurePlaces(), ensureMeta(),
    ]);

    let product = {
      name: '', price: '', category_id: '', subcategory_id: '',
      condition: meta.conditions[0], description: '', default_place_id: '', images: [],
    };

    if (editing) {
      try {
        const loaded = await api.get(`/api/products/${ctx.params.id}`);
        if (!loaded.is_owner && !loaded.is_admin) {
          root.innerHTML = emptyHtml('只能编辑自己发布的商品', '🔒');
          return;
        }
        product = { ...product, ...loaded, images: loaded.images || [] };
      } catch (err) {
        root.innerHTML = emptyHtml(`商品打不开：${err.message}`, '🚫');
        return;
      }
    }

    const images = [...(product.images || [])];
    const maxImages = meta.max_images || 6;

    root.innerHTML = `
      <div class="page-head">
        <h1>${editing ? '编辑商品' : '发布商品'}</h1>
        <span class="muted small">带 <span style="color:var(--danger)">*</span> 的是必填项</span>
      </div>

      <div class="grid grid-2" style="align-items:start">
        <div class="card">
          <form id="product-form" novalidate>
            <div class="form-row">
              <label>商品名称<span class="req">*</span></label>
              <input class="input" id="f-name" maxlength="100" value="${esc(product.name)}" placeholder="例如：高等数学（同济第七版）上下册">
            </div>

            <div class="form-row">
              <label>价格（元）<span class="req">*</span></label>
              <input class="input" id="f-price" type="number" min="0.01" step="0.01" value="${esc(product.price)}" placeholder="必须大于 0">
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>分类<span class="req">*</span></label>
                <select class="select" id="f-category">
                  <option value="">请选择</option>
                  ${categories.map(c => `<option value="${c.id}" ${String(product.category_id) === String(c.id) ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}
                </select>
              </div>
              <div class="form-row">
                <label>小类</label>
                <select class="select" id="f-subcategory"></select>
              </div>
            </div>

            <div class="form-grid">
              <div class="form-row">
                <label>成色<span class="req">*</span></label>
                <select class="select" id="f-condition">
                  ${meta.conditions.map(c => `<option value="${esc(c)}" ${product.condition === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
                </select>
              </div>
              <div class="form-row">
                <label>默认自提点</label>
                <select class="select" id="f-place">
                  <option value="">不指定</option>
                  ${places.map(p => `<option value="${p.id}" ${String(product.default_place_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}（${esc(p.type)}）</option>`).join('')}
                </select>
              </div>
            </div>

            <div class="form-row">
              <label>商品描述</label>
              <textarea class="textarea" id="f-desc" placeholder="成色细节、使用时长、有无磕碰、附赠配件…">${esc(product.description || '')}</textarea>
            </div>

            <div class="form-row">
              <label>商品图片（最多 ${maxImages} 张，jpg / png / webp，单张 ≤ 2MB）</label>
              <input type="file" id="f-images" accept="image/jpeg,image/png,image/webp" multiple style="display:none">
              <button type="button" class="btn" id="btn-pick-images">📎 选择图片</button>
              <div class="gallery-thumbs" id="image-list"></div>
            </div>

            <div class="divider"></div>
            <div class="row" style="justify-content:flex-end">
              <button type="button" class="btn" id="btn-cancel">取消</button>
              <button type="submit" class="btn btn-primary btn-lg" id="btn-submit">${editing ? '保存修改' : '发布商品'}</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-head"><h3>实时预览</h3><span class="muted small">买家看到的样子</span></div>
          <div id="preview"></div>
        </div>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    const nameInput = $('#f-name');
    const priceInput = $('#f-price');

    /* ---------- 分类 → 小类联动 ---------- */
    function fillSubcategories() {
      const catId = $('#f-category').value;
      const cat = categories.find(c => String(c.id) === String(catId));
      const subs = cat ? (cat.subcategories || []) : [];
      const select = $('#f-subcategory');
      select.innerHTML = `<option value="">不选小类</option>` +
        subs.map(s => `<option value="${s.id}" ${String(product.subcategory_id) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
      select.disabled = subs.length === 0;
    }

    /* ---------- 图片 ---------- */
    function renderImages() {
      $('#image-list').innerHTML = images.map((file, index) => `
        <span style="position:relative;display:inline-block">
          <img src="${esc(imgUrl(file))}" alt="">
          <button type="button" data-remove="${index}"
                  style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;
                         border:none;background:var(--danger);color:#fff;cursor:pointer;line-height:1;font-size:12px">×</button>
        </span>`).join('');
      $('#image-list').querySelectorAll('[data-remove]').forEach(btn =>
        btn.addEventListener('click', () => {
          images.splice(Number(btn.dataset.remove), 1);
          renderImages();
        }));
    }

    $('#btn-pick-images').addEventListener('click', () => $('#f-images').click());
    $('#f-images').addEventListener('change', async (event) => {
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

    /* ---------- 实时预览 ---------- */
    function renderPreview() {
      const catId = $('#f-category').value;
      const cat = categories.find(c => String(c.id) === String(catId));
      const cover = images.length
        ? `<img src="${esc(imgUrl(images[0]))}" alt="">`
        : `<span style="font-size:52px">${esc(cat ? cat.icon : '📦')}</span>`;
      const price = Number(priceInput.value || 0);
      $('#preview').innerHTML = `
        <div style="max-width:236px">
          <div class="product-card" style="cursor:default">
            <div class="pc-cover">${cover}</div>
            <div class="pc-body">
              <div class="pc-name">${esc(nameInput.value || '商品名称')}</div>
              <div class="pc-meta">
                <span class="price"><small>¥</small>${price.toFixed(2)}</span>
                <span class="badge badge-gray">${esc($('#f-condition').value)}</span>
              </div>
              <div class="pc-foot">
                <span>${esc(cat ? `${cat.icon} ${cat.name}` : '未选择分类')}</span>
                <span>👁 0</span>
              </div>
            </div>
          </div>
        </div>`;
    }

    ['#f-name', '#f-price', '#f-category', '#f-condition'].forEach(sel =>
      root.querySelector(sel).addEventListener('input', renderPreview));
    $('#f-condition').addEventListener('change', renderPreview);
    $('#f-category').addEventListener('change', () => { fillSubcategories(); renderPreview(); });

    /* ---------- 校验与提交 ---------- */
    function clearError(input) {
      input.classList.remove('invalid');
      const tip = input.parentElement.querySelector('.form-error');
      if (tip) tip.remove();
    }
    function setError(input, message) {
      input.classList.add('invalid');
      let tip = input.parentElement.querySelector('.form-error');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'form-error';
        input.parentElement.appendChild(tip);
      }
      tip.textContent = message;
    }

    function validate() {
      let ok = true;
      clearError(nameInput); clearError(priceInput); clearError($('#f-category'));
      if (!nameInput.value.trim()) { setError(nameInput, '请填写商品名称'); ok = false; }
      const price = Number(priceInput.value);
      if (!priceInput.value || Number.isNaN(price) || price <= 0) {
        setError(priceInput, '价格必须大于 0'); ok = false;
      }
      if (!$('#f-category').value) { setError($('#f-category'), '请选择分类'); ok = false; }
      return ok;
    }

    $('#btn-cancel').addEventListener('click', () => history.back());

    $('#product-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!validate()) { toast('请先修正标红的字段', 'warn'); return; }

      const submit = $('#btn-submit');
      submit.disabled = true;
      const payload = {
        name: nameInput.value.trim(),
        price: Number(priceInput.value),
        category_id: Number($('#f-category').value),
        subcategory_id: $('#f-subcategory').value ? Number($('#f-subcategory').value) : null,
        condition: $('#f-condition').value,
        description: $('#f-desc').value.trim(),
        default_place_id: $('#f-place').value ? Number($('#f-place').value) : null,
        images,
      };

      try {
        if (editing) {
          await api.put(`/api/products/${ctx.params.id}`, payload);
          toast('保存成功');
          go(`#/product/${ctx.params.id}`);
        } else {
          const created = await api.post('/api/products', payload);
          invalidateCatalog();
          toast('发布成功，已经出现在首页「最新上架」');
          go(`#/product/${created.id}`);
        }
      } catch (err) {
        toast(err.message, 'error');
        submit.disabled = false;
      }
    });

    fillSubcategories();
    renderImages();
    renderPreview();
  },
};
