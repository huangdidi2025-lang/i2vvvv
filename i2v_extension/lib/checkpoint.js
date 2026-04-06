// 纯 checkpoint 序列化器。剥离重字段（image_base64）让 checkpoint 不超过
// chrome.storage 限制。background.js 里的生产 saveCheckpoint 把这段
// 内联了；这里抽出一份纯版本用于测试。

const HEAVY_FIELDS = ['image_base64', 'image_data_url'];

export function serializeCheckpoint(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('checkpoint state must be an object');
  }
  const clean = { ...state };
  if (Array.isArray(state.rows)) {
    clean.rows = state.rows.map(r => {
      const c = { ...r };
      for (const k of HEAVY_FIELDS) delete c[k];
      return c;
    });
  }
  clean.savedAt = clean.savedAt || new Date().toISOString();
  return clean;
}

export function deserializeCheckpoint(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

export function isExpired(checkpoint, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!checkpoint?.savedAt) return true;
  const t = Date.parse(checkpoint.savedAt);
  if (isNaN(t)) return true;
  return Date.now() - t > maxAgeMs;
}
