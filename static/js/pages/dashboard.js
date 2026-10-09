/* ==========================================================================
   M11 数据看板：4 个数字卡 + 分类占比饼图 + 价格区间柱状图
   图表用 canvas 手绘，不引第三方库（全原生、断网也能跑）
   所有数字与图表口径一致：全部「未删除」商品
   ========================================================================== */
import { api } from '../api.js';
import { emptyHtml, esc, loadingHtml } from '../ui.js';

const PALETTE = ['#2e9e63', '#4a8fdc', '#e0a03a', '#e2503f', '#8a6bd1', '#39a9a0', '#c96fa8'];

export default {
  async render(root) {
    root.innerHTML = `
      <div class="page-head">
        <h1>数据看板</h1>
        <span class="muted small">统计口径：全部「未删除」商品；图表由 SQL 聚合接口提供</span>
      </div>
      <div id="dash-body">${loadingHtml()}</div>`;

    const body = root.querySelector('#dash-body');
    let stats;
    try {
      stats = await api.get('/api/admin/stats');
    } catch (err) {
      body.innerHTML = emptyHtml(`加载失败：${err.message}`, '😵');
      return;
    }

    const cards = stats.cards || {};
    body.innerHTML = `
      <div class="grid grid-4 mb-16">
        ${statCard('商品总数', cards.total, '📦')}
        ${statCard('在售', cards.on_sale, '🟢')}
        ${statCard('已售', cards.sold, '🤝')}
        ${statCard('已下架', cards.off_shelf, '🚫')}
      </div>

      <div class="grid grid-2 mb-16">
        <div class="card">
          <div class="card-head">
            <h2>分类占比</h2>
            <span class="muted small">合计 ${(stats.category_pie || []).reduce((s, x) => s + x.count, 0)} 件</span>
          </div>
          <div class="row" style="align-items:flex-start;gap:20px">
            <canvas id="pie" width="240" height="240" style="flex:0 0 240px"></canvas>
            <div id="pie-legend" style="flex:1;min-width:150px"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2>价格区间分布</h2>
            <span class="muted small">合计 ${(stats.price_bars?.values || []).reduce((s, x) => s + x, 0)} 件</span>
          </div>
          <canvas id="bars" height="260" style="width:100%;height:260px"></canvas>
        </div>
      </div>

      <div class="grid grid-4">
        ${statCard('注册用户', stats.users, '👥')}
        ${statCard('订单总数', stats.orders?.total ?? 0, '🧾')}
        ${statCard('待处理举报', stats.reports_pending, '🚩')}
        ${statCard('广场帖子', stats.posts, '💬')}
      </div>`;

    function statCard(label, value, icon) {
      return `
        <div class="stat-card">
          <span class="sc-icon">${icon}</span>
          <div class="sc-label">${esc(label)}</div>
          <div class="sc-value">${value ?? 0}</div>
        </div>`;
    }

    drawPie(body.querySelector('#pie'), stats.category_pie || [], body.querySelector('#pie-legend'));
    drawBars(body.querySelector('#bars'), stats.price_bars || { labels: [], values: [] });
  },
};

/* ------------------------------------------------------------------ 饼图 */
function drawPie(canvas, data, legendBox) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const center = size / 2;
  const radius = center - 12;
  const total = data.reduce((sum, item) => sum + item.count, 0);

  ctx.clearRect(0, 0, size, size);

  if (!total) {
    ctx.fillStyle = '#93a29b';
    ctx.font = '14px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', center, center);
    legendBox.innerHTML = '';
    return;
  }

  let start = -Math.PI / 2;
  data.forEach((item, index) => {
    const angle = (item.count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(center, center);
    ctx.arc(center, center, radius, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = PALETTE[index % PALETTE.length];
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    start += angle;
  });

  // 中心挖空，做成环形，中间写总数
  ctx.beginPath();
  ctx.arc(center, center, radius * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.fillStyle = '#21372c';
  ctx.font = 'bold 22px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(total), center, center + 2);
  ctx.font = '11px "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#93a29b';
  ctx.fillText('件商品', center, center + 18);

  legendBox.innerHTML = data.map((item, index) => `
    <div class="row" style="gap:8px;margin-bottom:7px">
      <span style="width:11px;height:11px;border-radius:3px;background:${PALETTE[index % PALETTE.length]};display:inline-block"></span>
      <span style="flex:1">${esc(item.icon || '')} ${esc(item.name)}</span>
      <span class="strong">${item.count}</span>
      <span class="muted small">${(item.count / total * 100).toFixed(1)}%</span>
    </div>`).join('');
}

/* ------------------------------------------------------------------ 柱状图 */
function drawBars(canvas, data) {
  const parent = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = parent.clientWidth - 40;
  const height = 260;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const labels = data.labels || [];
  const values = data.values || [];
  const max = Math.max(1, ...values);

  const padLeft = 34;
  const padBottom = 30;
  const padTop = 16;
  const chartW = width - padLeft - 12;
  const chartH = height - padBottom - padTop;

  // 横向网格与刻度
  ctx.strokeStyle = '#eef2f0';
  ctx.fillStyle = '#93a29b';
  ctx.font = '11px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + (chartH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - 12, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(max - (max / 4) * i)), padLeft - 6, y + 4);
  }

  if (!labels.length) return;

  const slot = chartW / labels.length;
  const barW = Math.min(54, slot * 0.55);

  labels.forEach((label, index) => {
    const value = values[index] ?? 0;
    const barH = (value / max) * chartH;
    const x = padLeft + slot * index + (slot - barW) / 2;
    const y = padTop + chartH - barH;

    // 渐变柱
    const gradient = ctx.createLinearGradient(0, y, 0, padTop + chartH);
    gradient.addColorStop(0, '#48b87c');
    gradient.addColorStop(1, '#2e9e63');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    const radius = Math.min(6, barW / 2);
    ctx.moveTo(x, padTop + chartH);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.lineTo(x + barW - radius, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + radius);
    ctx.lineTo(x + barW, padTop + chartH);
    ctx.closePath();
    ctx.fill();

    // 数值
    ctx.fillStyle = '#21372c';
    ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(value), x + barW / 2, y - 6);

    // 区间标签
    ctx.fillStyle = '#5b6f65';
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillText(label, x + barW / 2, height - 10);
  });
}
