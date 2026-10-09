/* ==========================================================================
   M14 交易定位与自提小地图
   - 配了腾讯地图 key 就用腾讯地图（GCJ-02）
   - 没配 key 或脚本加载失败，自动降级为 canvas 自绘校园示意图
   - 隐私：只有「待完成」订单的买卖双方能看到精确坐标
   ========================================================================== */
import { api } from '../api.js';
import { ensureMeta, ensurePlaces } from '../data.js';
import { emptyHtml, esc, toast } from '../ui.js';

export default {
  async render(root, ctx) {
    const orderId = ctx.params.id;
    let map;
    try {
      map = await api.get(`/api/orders/${orderId}/map`);
    } catch (err) {
      root.innerHTML = emptyHtml(`打不开这张订单：${err.message}`, '🚫');
      return;
    }

    const [places, meta] = await Promise.all([ensurePlaces(), ensureMeta()]);
    const canEdit = map.status === 'pending';

    root.innerHTML = `
      <div class="page-head">
        <h1>📍 自提小地图</h1>
        <button class="btn btn-ghost btn-sm" onclick="history.back()">‹ 返回</button>
      </div>

      <div class="card">
        <div class="row-between mb-8">
          <div>
            <div class="strong">订单号 ${esc(map.order_no)}</div>
            <div class="muted small">约定自提点：${esc(map.meet_place?.name || '未指定')}</div>
          </div>
          <span class="badge ${map.status === 'pending' ? 'badge-warn' : 'badge-gray'}">
            ${map.status === 'pending' ? '待完成' : (map.status === 'done' ? '已完成' : '已取消')}
          </span>
        </div>

        <div class="map-box"><canvas id="map-canvas"></canvas></div>

        <div class="map-legend">
          <span><i class="legend-dot dot-buyer"></i>买家位置</span>
          <span><i class="legend-dot dot-seller"></i>卖家位置</span>
          <span><i class="legend-dot dot-meet"></i>建议会面点</span>
          <span class="muted" id="distance-label"></span>
          <span class="muted small" id="engine-label"></span>
        </div>
      </div>

      ${canEdit ? `
      <div class="card">
        <div class="card-head"><h2>更新我的位置</h2><span class="muted small">选校园地标，或使用浏览器定位</span></div>
        <div class="row">
          <div style="min-width:220px">
            <select class="select" id="place-select">
              <option value="">选择校园地点…</option>
              ${places.map(p => `<option value="${p.id}">${esc(p.name)}（${esc(p.type)}）</option>`).join('')}
            </select>
          </div>
          <button class="btn btn-primary" id="btn-set-place">设为我的位置</button>
          <button class="btn" id="btn-geo">🛰️ 使用浏览器定位</button>
          <button class="btn" id="btn-meet">把自提点也设为我这里</button>
        </div>
        <div class="hint">
          定位属于敏感信息：只有这笔订单的买卖双方、且订单处于「待完成」时才能看到精确坐标；
          交易完成后只保留自提点名称。
        </div>
      </div>` : `
      <div class="card">
        <div class="hint">订单已结束，精确位置不再展示，只保留自提点名称。</div>
      </div>`}

      <div class="card">
        <div class="card-head"><h2>校园地点库</h2><span class="muted small">共 ${places.length} 个</span></div>
        <div class="grid grid-4">
          ${places.map(p => `
            <div class="stat-card" style="padding:12px 14px">
              <div class="sc-label">${esc(p.type)}</div>
              <div class="strong">${esc(p.name)}</div>
              <div class="muted small">${p.lng.toFixed(5)}, ${p.lat.toFixed(5)}</div>
            </div>`).join('')}
        </div>
      </div>`;

    /* ---------- 绘制 ---------- */
    const canvas = root.querySelector('#map-canvas');
    const engineLabel = root.querySelector('#engine-label');
    const distanceLabel = root.querySelector('#distance-label');
    if (map.distance_m !== null && map.distance_m !== undefined) {
      distanceLabel.textContent = `双方直线距离约 ${map.distance_m} 米`;
    }

    const points = [];
    if (map.buyer_location) points.push({ ...map.buyer_location, color: '#2e9e63', label: '买家' });
    if (map.seller_location) points.push({ ...map.seller_location, color: '#3f7fd0', label: '卖家' });
    if (map.suggest_place) points.push({ lng: map.suggest_place.lng, lat: map.suggest_place.lat, color: '#e2503f', label: '建议' });
    if (map.meet_place) points.push({ lng: map.meet_place.lng, lat: map.meet_place.lat, color: '#e0a03a', label: '自提点' });

    const key = String(meta.tencent_map_key || map.map_key || '').trim();
    if (key) {
      engineLabel.textContent = '地图引擎：腾讯地图';
      try {
        await renderTencentMap(root, map, key);
      } catch (err) {
        engineLabel.textContent = '腾讯地图加载失败，已降级为自绘示意图';
        drawCanvas(canvas, points);
      }
    } else {
      engineLabel.textContent = '未配置腾讯地图 key，使用自绘校园示意图';
      drawCanvas(canvas, points);
    }

    /* ---------- 位置更新 ---------- */
    if (canEdit) {
      const setLocation = async (payload) => {
        try {
          await api.put(`/api/orders/${orderId}/location`, payload);
          toast('位置已更新');
          const fresh = await api.get(`/api/orders/${orderId}/map`);
          Object.assign(map, fresh);
          if (key) { try { await renderTencentMap(root, map, key); } catch (e) { drawCanvas(canvas, points); } }
          else { drawCanvas(canvas, points); }
          if (map.distance_m != null) distanceLabel.textContent = `双方直线距离约 ${map.distance_m} 米`;
        } catch (err) { toast(err.message, 'error'); }
      };

      root.querySelector('#btn-set-place').addEventListener('click', () => {
        const value = root.querySelector('#place-select').value;
        if (!value) { toast('请先选择一个校园地点', 'warn'); return; }
        setLocation({ place_id: Number(value) });
      });

      root.querySelector('#btn-geo').addEventListener('click', () => {
        if (!navigator.geolocation) { toast('当前浏览器不支持定位', 'warn'); return; }
        toast('正在获取定位…', 'info');
        navigator.geolocation.getCurrentPosition(
          (position) => setLocation({
            lng: position.coords.longitude,
            lat: position.coords.latitude,
          }),
          () => toast('定位失败或被拒绝，请改用手动选择校园地点', 'error'),
          { timeout: 8000 },
        );
      });

      root.querySelector('#btn-meet').addEventListener('click', () => {
        if (!map.meet_place) { toast('这张订单还没有约定自提点', 'warn'); return; }
        setLocation({ place_id: map.meet_place.id });
      });
    }
  },
};

/* ------------------------------------------------------------------ 腾讯地图 */
async function renderTencentMap(root, map, key) {
  const TMap = await loadTencentScript(key);
  const box = root.querySelector('.map-box');
  const center = map.suggest_place
    || map.meet_place
    || map.buyer_location
    || map.seller_location
    || { lng: 114.414, lat: 30.511 };

  box.innerHTML = '';   // 移除 canvas，换成腾讯地图容器
  const div = document.createElement('div');
  div.style.cssText = 'width:100%;height:100%';
  box.appendChild(div);

  const tmap = new TMap.Map(div, { center: new TMap.LatLng(center.lat, center.lng), zoom: 16 });
  const geometries = [];
  if (map.buyer_location) geometries.push({ id: 'buyer', styleId: 'buyer', position: new TMap.LatLng(map.buyer_location.lat, map.buyer_location.lng) });
  if (map.seller_location) geometries.push({ id: 'seller', styleId: 'seller', position: new TMap.LatLng(map.seller_location.lat, map.seller_location.lng) });
  if (map.suggest_place) geometries.push({ id: 'meet', styleId: 'meet', position: new TMap.LatLng(map.suggest_place.lat, map.suggest_place.lng) });

  new TMap.MultiMarker({
    map: tmap,
    styles: {
      buyer: new TMap.MarkerStyle({ width: 26, height: 32, anchor: { x: 13, y: 32 } }),
      seller: new TMap.MarkerStyle({ width: 26, height: 32, anchor: { x: 13, y: 32 } }),
      meet: new TMap.MarkerStyle({ width: 26, height: 32, anchor: { x: 13, y: 32 } }),
    },
    geometries,
  });

  if (map.buyer_location && map.seller_location) {
    new TMap.MultiPolyline({
      map: tmap,
      styles: { line: new TMap.PolylineStyle({ color: '#2e9e63', width: 3, borderWidth: 1, borderColor: '#ffffff' }) },
      geometries: [{
        id: 'link', styleId: 'line',
        paths: [
          new TMap.LatLng(map.buyer_location.lat, map.buyer_location.lng),
          new TMap.LatLng(map.seller_location.lat, map.seller_location.lng),
        ],
      }],
    });
  }
}

function loadTencentScript(key) {
  return new Promise((resolve, reject) => {
    if (window.TMap) { resolve(window.TMap); return; }
    const script = document.createElement('script');
    script.src = `https://map.qq.com/api/gljs?v=1.exp&key=${encodeURIComponent(key)}`;
    script.async = true;
    script.onload = () => (window.TMap ? resolve(window.TMap) : reject(new Error('脚本未就绪')));
    script.onerror = () => reject(new Error('脚本加载失败'));
    document.head.appendChild(script);
    setTimeout(() => { if (!window.TMap) reject(new Error('加载超时')); }, 8000);
  });
}

/* ------------------------------------------------------------------ canvas 自绘 */
export function drawCanvas(canvas, points) {
  if (!canvas || !canvas.parentElement) return;
  const box = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = box.clientWidth || 600;
  const height = box.clientHeight || 320;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // 背景网格（示意校园平面）
  ctx.fillStyle = '#eef3f0';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#dde6e1';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y < height; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }

  if (points.length === 0) {
    ctx.fillStyle = '#93a29b';
    ctx.font = '14px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('还没有位置信息，请在下方选择校园地点或使用浏览器定位', width / 2, height / 2);
    return;
  }

  // 坐标 → 画布坐标（按点集包围盒加内边距）
  const lngs = points.map(p => Number(p.lng));
  const lats = points.map(p => Number(p.lat));
  let minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  let minLat = Math.min(...lats), maxLat = Math.max(...lats);
  if (maxLng - minLng < 1e-6) { minLng -= 0.0006; maxLng += 0.0006; }
  if (maxLat - minLat < 1e-6) { minLat -= 0.0006; maxLat += 0.0006; }
  const pad = 54;
  const toX = (lng) => pad + ((lng - minLng) / (maxLng - minLng)) * (width - pad * 2);
  const toY = (lat) => height - pad - ((lat - minLat) / (maxLat - minLat)) * (height - pad * 2);

  const buyer = points.find(p => p.label === '买家');
  const seller = points.find(p => p.label === '卖家');
  if (buyer && seller) {
    ctx.strokeStyle = '#2e9e63';
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(toX(buyer.lng), toY(buyer.lat));
    ctx.lineTo(toX(seller.lng), toY(seller.lat));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  points.forEach(point => {
    const x = toX(Number(point.lng));
    const y = toY(Number(point.lat));
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.fillStyle = point.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = '#21372c';
    ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(point.label, x, y - 15);
  });

  ctx.fillStyle = '#93a29b';
  ctx.font = '11px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('示意图（非真实地图，仅表示相对位置）', 10, height - 10);
}
