// 纯重试辅助函数。来源：i2v_extension/background.js:195
// 2026-04-06 为 M3 单测抽出。background.js 里的生产副本仍是权威实现，
// 这是回归网。
//
// 用法: withRetry(asyncFn, { retries: 3, delays: [3000,8000,15000], isTransient: msg => bool, onRetry: (i,msg)=>{} })

export async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    delays = [3000, 8000, 15000],
    isTransient = (msg) => /timeout|not found|could not establish/i.test(msg),
    onRetry = () => {},
    sleepImpl = (ms) => new Promise(r => setTimeout(r, ms)),
  } = opts;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e.message || '';
      const transient = isTransient(msg);
      if (!transient || i === retries) throw e;
      onRetry(i + 1, msg);
      await sleepImpl(delays[i] || 5000);
    }
  }
}
