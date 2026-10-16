/* ==========================================================================
   功能⑦ 个人资料：修改昵称 + 上传头像
   头像走 /api/upload 上传拿到文件名，再随昵称一起提交到 PUT /api/auth/profile
   ========================================================================== */
import { api } from '../api.js';
import { store } from '../store.js';
import { avatarHtml, esc, fmtTime, toast } from '../ui.js';

const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

export default {
  async render(root) {
    const data = await api.get('/api/auth/me');
    store.user = data.user;
    const user = data.user;

    // 待提交的头像（null = 没有改动）
    let pendingAvatar = null;

    // 需求③：用「好评率 + 分级」取代信用分显示（credit 字段保留在库里、不参与计算）
    const rating = user.rating || {};
    const ratingText = rating.total
      ? `好评率 ${rating.rate}% · ${rating.level_text}（好评 ${rating.good} / 共 ${rating.total} 条，平均 ${rating.avg} 星）`
      : '暂无评价（完成交易、收到买家评价后显示）';

    root.innerHTML = `
      <div class="page-head">
        <h1>个人资料</h1>
        <span class="muted small">昵称与头像会显示在商品、帖子、订单和私信里</span>
      </div>

      <div class="card">
        <div class="card-head"><h2>头像与昵称</h2>
          <span class="muted small">支持 jpg / png / webp，单张 ≤ 2MB</span></div>

        <div class="profile-row">
          <div id="avatar-preview">${avatarHtml(user, 88, 'profile-avatar')}</div>
          <div class="col" style="gap:8px">
            <input type="file" id="avatar-file" accept="image/jpeg,image/png,image/webp" style="display:none">
            <div class="row">
              <button class="btn" id="btn-pick-avatar">📷 上传头像</button>
              <button class="btn btn-ghost" id="btn-clear-avatar" ${user.avatar ? '' : 'disabled'}>恢复默认头像</button>
            </div>
            <div class="muted small">不设置头像时，会显示昵称的第一个字</div>
          </div>
        </div>

        <div class="divider"></div>

        <div class="form-grid">
          <div class="form-row">
            <label>昵称<span class="req">*</span></label>
            <input class="input" id="pf-nickname" maxlength="20" value="${esc(user.nickname)}"
                   placeholder="2-20 个字符">
            <div class="hint">最多 20 个字符，不能为空</div>
          </div>
          <div class="form-row">
            <label>商家简介</label>
            <input class="input" id="pf-bio" maxlength="100" value="${esc(user.bio || '')}"
                   placeholder="例如：常年在校，出闲置教材，可小刀">
            <div class="hint">
              最多 100 字，会显示在你的
              ${user.role === 'admin' ? '主页' : `<button class="link-btn" id="pf-preview">卖家主页</button>`}
              顶部；留空则不展示
            </div>
          </div>
          <div class="form-row">
            <label>用户名（不可修改）</label>
            <input class="input" value="${esc(user.username)}" disabled>
          </div>
          <div class="form-row">
            <label>账号身份</label>
            <input class="input" value="${user.role === 'admin' ? '管理员' : '普通用户（既能买也能卖）'}" disabled>
          </div>
          <div class="form-row">
            <label>商家好评率</label>
            <input class="input" id="pf-rating" value="${esc(ratingText)}" disabled>
            <div class="hint">
              好评＝4~5 星；<b>只统计买家对你的评价</b>（你给买家的评价不计入商家信誉）。
              分级：≥95% 优秀 / 85% 良好 / 70% 一般 / 低于 70% 待改进
            </div>
          </div>
          <div class="form-row">
            <label>注册时间</label>
            <input class="input" value="${esc(fmtTime(user.created_at))}" disabled>
          </div>
        </div>

        <div class="row-between mt-16">
          <span class="muted small" id="pf-status"></span>
          <div class="row">
            <button class="btn" id="btn-reload">还原</button>
            <button class="btn btn-primary" id="btn-save">保存修改</button>
          </div>
        </div>
      </div>`;

    const $ = (id) => root.querySelector(id);
    const nicknameInput = $('#pf-nickname');
    const bioInput = $('#pf-bio');
    const preview = $('#avatar-preview');
    const fileInput = $('#avatar-file');
    const statusLabel = $('#pf-status');

    // 需求②：从个人资料页直接预览自己的卖家主页
    const previewLink = $('#pf-preview');
    if (previewLink) {
      previewLink.addEventListener('click', () => { location.hash = `#/seller/${user.id}`; });
    }

    function paintPreview(avatar) {
      preview.innerHTML = avatarHtml({ nickname: nicknameInput.value || user.nickname, avatar }, 88, 'profile-avatar');
    }

    function clearError() {
      nicknameInput.classList.remove('invalid');
      const tip = nicknameInput.parentElement.querySelector('.form-error');
      if (tip) tip.remove();
    }

    nicknameInput.addEventListener('input', () => {
      clearError();
      paintPreview(pendingAvatar === null ? user.avatar : pendingAvatar);
    });

    $('#btn-pick-avatar').addEventListener('click', () => fileInput.click());
    $('#btn-clear-avatar').addEventListener('click', () => {
      pendingAvatar = '';
      paintPreview('');
      $('#btn-clear-avatar').disabled = true;
      statusLabel.textContent = '已选择恢复默认头像，记得点「保存修改」';
    });

    fileInput.addEventListener('change', async (event) => {
      const file = (event.target.files || [])[0];
      event.target.value = '';
      if (!file) return;
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
        toast('只支持 jpg / png / webp 格式', 'warn');
        return;
      }
      if (file.size > MAX_AVATAR_SIZE) {
        toast('图片不能超过 2MB', 'warn');
        return;
      }
      try {
        const uploaded = await api.upload(file);
        pendingAvatar = uploaded.url;
        paintPreview(pendingAvatar);
        $('#btn-clear-avatar').disabled = false;
        statusLabel.textContent = '头像已上传，记得点「保存修改」';
      } catch (err) {
        toast(`上传失败：${err.message}`, 'error');
      }
    });

    $('#btn-reload').addEventListener('click', () => {
      nicknameInput.value = user.nickname;
      bioInput.value = user.bio || '';
      pendingAvatar = null;
      clearError();
      paintPreview(user.avatar);
      $('#btn-clear-avatar').disabled = !user.avatar;
      statusLabel.textContent = '';
    });

    $('#btn-save').addEventListener('click', async (event) => {
      const nickname = nicknameInput.value.trim();
      clearError();
      if (!nickname) {
        nicknameInput.classList.add('invalid');
        const tip = document.createElement('div');
        tip.className = 'form-error';
        tip.textContent = '昵称不能为空';
        nicknameInput.parentElement.appendChild(tip);
        toast('请先填写昵称', 'warn');
        return;
      }

      const body = { nickname, bio: bioInput.value.trim() };
      if (pendingAvatar !== null) body.avatar = pendingAvatar;

      const button = event.currentTarget;
      button.disabled = true;
      try {
        const saved = await api.put('/api/auth/profile', body);
        store.setUser(saved);
        pendingAvatar = null;
        $('#btn-clear-avatar').disabled = !saved.avatar;
        statusLabel.textContent = '已保存 ✓';
        toast('资料已更新');
        // 顶栏的昵称/头像需要跟着变
        window.dispatchEvent(new CustomEvent('cm:user-updated'));
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        button.disabled = false;
      }
    });
  },
};
