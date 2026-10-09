/* ==========================================================================
   接口调用封装：统一带 JWT 与身份视角，统一处理 {code, msg, data}
   ========================================================================== */
import { store } from './store.js';

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request(method, path, options = {}) {
  const headers = {};
  if (store.token) headers['Authorization'] = `Bearer ${store.token}`;
  if (store.view) headers['X-View-Role'] = store.view;

  let body;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }

  let response;
  try {
    response = await fetch(path, { method, headers, body });
  } catch (err) {
    throw new ApiError('网络连接失败，请确认服务已启动', 0, -1);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new ApiError(`服务器返回异常（HTTP ${response.status}）`, response.status, -1);
  }

  if (!response.ok || payload.code !== 0) {
    const message = payload.msg || `请求失败（HTTP ${response.status}）`;
    // 登录态失效：清掉本地凭证，由 app.js 统一跳回登录页
    if (response.status === 401) store.clearAuth();
    throw new ApiError(message, response.status, payload.code);
  }
  return payload.data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, json) => request('POST', path, { json }),
  put: (path, json) => request('PUT', path, { json }),
  patch: (path, json) => request('PATCH', path, { json }),
  del: (path) => request('DELETE', path),
  upload: (file) => {
    const form = new FormData();
    form.append('file', file);
    return request('POST', '/api/upload', { form });
  },
};

/** 把对象拼成查询串（自动跳过空值） */
export function qs(params = {}) {
  const parts = [];
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '' ) return;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  });
  return parts.length ? `?${parts.join('&')}` : '';
}

export { ApiError };
