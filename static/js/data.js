/* ==========================================================================
   数据缓存：全局枚举、分类、校园地点
   ========================================================================== */
import { api } from './api.js';
import { store } from './store.js';

export async function ensureMeta() {
  if (!store.meta) store.meta = await api.get('/api/meta');
  return store.meta;
}

export async function ensureCategories(force = false) {
  if (force || !store.categories) {
    store.categories = await api.get('/api/categories?with_subs=1');
  }
  return store.categories;
}

export async function ensurePlaces(force = false) {
  if (force || !store.places) store.places = await api.get('/api/places');
  return store.places;
}

/** 清掉缓存（管理员改过基础数据后调用） */
export function invalidateCatalog() {
  store.categories = null;
  store.places = null;
}
