# M3：命名空间模块化 + 纯函数单测 + Mock 模式 实施计划

> **For Claude:** REQUIRED SUB-SKILL: 用 superpowers:executing-plans 按任务执行此计划。

**目标：** 让扩展的每个功能模块都能从 i2v-cli 单独调用测试（无需触发完整批处理流水线）；为纯逻辑函数加 Node 端的回归保护网；让 Claude 能用 mock 后端跑端到端测试，完全不碰生产 i2v-server。

**架构：** 三个松耦合的追加项，全部 append-only / new-file-only。任何一个都不会改动现有扩展行为——生产代码路径保持字节级一致。

1. **content.js 末尾追加 `window.__i2v_modules` 命名空间** —— 把现有函数包装成 7 个面向任务的模块（upload / prompt / generate / extend / download / cache / navigate）。**纯包装，零重写**。让 `i2v-cli call` 可以调用一整个步骤，而不是 5 个原子函数。

2. **纯函数 lib/ + Node 单测** —— 把 background.js / content.js 里 3-5 个无 Chrome 依赖的纯函数**复制**（不是移动）一份到 `i2v_extension/lib/*.js`，作为 ES module。原文件保持不变继续作为生产代码路径，lib/ 副本是为将来重构用的回归网。

3. **i2v-cli mock 模式** —— 新增 `--mock` flag，通过 CDP 在 Flow 页面注入 fetch 拦截器，把所有发往 `i2v-server.vercel.app` 的请求短路成假响应。让将来的测试能跑通调用后端的代码路径，但**不碰生产**。

4. **i2v-cli test 子命令** —— `i2v-cli test <module>` 跑某个逻辑模块的脚本化场景（比如 `test prompt --text "hi"` 只注入提示词验证落地，不点 generate）。把模块和实测桥接起来。

**技术栈：** 跟 M1/M2 一样 —— Node 18+，chrome-remote-interface，零新依赖。

**总体设计文档：** `docs/plans/2026-04-06-cdp-driven-i2v-design.md`

**硬约束：**
- 不修改 `i2v_extension/content.js` 的任何现有行（只能在 EOF 后追加）
- 不修改 `i2v_extension/background.js`、`popup.js`、`manifest.json`，不动 `i2v-server/` 任何文件
- 不引入构建步骤（不用 esbuild / rollup / webpack）
- 不增加新 Chrome 权限
- Mock 模式默认 OFF；不传 `--mock` 时生产行为零变化
- 每个 commit 都必须保持 `cd i2v-cli && node --test test/` 全绿

---

## 任务 M3.1：window.__i2v_modules 命名空间（content.js 追加）

**文件：**
- 修改：`i2v_extension/content.js`（仅 APPEND，在当前 EOF 之后追加）

**规格：** 在文件末尾追加一个块，定义 `window.__i2v_modules`，里面包含 7 个子命名空间。每个模块里的函数要么 (a) 调用 content.js 顶层已有的函数，要么 (b) 是组合 2-3 个原子查找的薄编排封装。**不引入任何新业务逻辑**。

```js


// ═══════════════════════════════════════════════════════════════════════════
// M3：逻辑模块命名空间
// 2026-04-06 为 M3 追加。把现有函数包装成面向任务的模块组，让 i2v-cli 可以
// 单独驱动某一个关注点，而不需要走 background.js 的完整批处理流水线。
// 纯封装——零新行为。
//
// M1 的 window.__i2v 已经 frozen，所以这个挂在另一个全局上。生产代码
// （background.js / popup.js）完全不引用这个命名空间；它只为开发工具存在。
// ═══════════════════════════════════════════════════════════════════════════
window.__i2v_modules = Object.freeze({
  upload: Object.freeze({
    // 打开上传对话框。返回 true=对话框打开，false=没打开。
    async openDialog() {
      const btn = findOpenDialogBtn();
      if (!btn) return { ok: false, error: 'no open dialog button' };
      simulateClick(btn);
      await sleep(800);
      return { ok: !!findDialog() };
    },
    // 点击对话框里的 "Upload image"
    async clickUploadImage() {
      const btn = findUploadBtnInDialog();
      if (!btn) return { ok: false, error: 'no upload button in dialog' };
      simulateClick(btn);
      await sleep(500);
      return { ok: true };
    },
    // 通过 DataTransfer 把 File 注入到 file input
    // imageBytes: Uint8Array, mime: string, filename: string
    async injectFile(imageBytes, mime, filename) {
      const inp = findFileInput();
      if (!inp) return { ok: false, error: 'no file input' };
      const blob = new Blob([new Uint8Array(imageBytes)], { type: mime });
      const file = new File([blob], filename || 'product.jpg', { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, size: file.size };
    },
    // 高层封装：开对话框 -> 点 upload -> 注入文件 -> 等对话框关闭
    async uploadFromBytes(imageBytes, mime, filename) {
      const r1 = await this.openDialog(); if (!r1.ok) return r1;
      const r2 = await this.clickUploadImage(); if (!r2.ok) return r2;
      const r3 = await this.injectFile(imageBytes, mime, filename); if (!r3.ok) return r3;
      await sleep(3000);
      return { ok: true, dialogClosed: !findDialog() };
    },
  }),

  prompt: Object.freeze({
    // 通过 beforeinput InputEvent 注入文字（兼容 Lexical 编辑器）
    async injectText(text) {
      const tb = findTextbox();
      if (!tb) return { ok: false, error: 'no textbox' };
      tb.focus();
      await sleep(200);
      tb.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
      }));
      await sleep(300);
      return { ok: true, currentText: (tb.textContent || '').slice(0, 200) };
    },
    // 读取当前提示词框内容（不修改）
    read() {
      const tb = findTextbox();
      if (!tb) return { ok: false, error: 'no textbox' };
      return { ok: true, text: tb.textContent || '' };
    },
  }),

  generate: Object.freeze({
    // 等 generate 按钮可用，然后点击。不等待视频生成结果，
    // 一旦点击触发就立即返回。
    async submit({ waitMs = 6000 } = {}) {
      const start = Date.now();
      let btn = null;
      while (Date.now() - start < waitMs) {
        btn = findGenerateBtn();
        if (btn) break;
        await sleep(300);
      }
      if (!btn) return { ok: false, error: 'generate button never enabled' };
      simulateClick(btn);
      return { ok: true, clickedText: btn.textContent.slice(0, 30) };
    },
    isReady() {
      return { ok: true, ready: !!findGenerateBtn() };
    },
  }),

  extend: Object.freeze({
    // 检查并切换到目标模型
    async checkModel() {
      return await ensureModelSelection();
    },
    // 用 segment2 提示词触发延伸
    async run(segment2Prompt) {
      return await extendVideo(segment2Prompt);
    },
    // 检查某 uuid 是否已经延伸过
    async isExtended(uuid) {
      return await checkVideoExtended(uuid);
    },
  }),

  download: Object.freeze({
    // 拿当前 edit 页视频的 <video src> URL
    async getUrl() {
      return await getVideoUrl();
    },
    // 点击页面内的 Download 按钮（生产环境需要 user gesture，
    // 从 CDP 触发会打开保存对话框或下载到默认目录）
    async clickDownload() {
      return await clickDownload();
    },
  }),

  cache: Object.freeze({
    // 强制刷新 React Query 项目缓存（当前 Flow 已经抓不到，留这里
    // 方便将来一处修复）
    async refresh() {
      return await refreshProjectCache();
    },
    // 读项目缓存快照（videos / images / workflowMap / ...）
    read() {
      return getProjectDataFromCache();
    },
  }),

  navigate: Object.freeze({
    // 通过 uuid 点进视频卡（导航到 /edit/<uuid>）
    async toEdit(uuid) {
      return await clickVideoCardByUuid(uuid);
    },
    // 返回 project 页
    back() {
      return navigateBack();
    },
    // 列出当前 project 页所有视频卡 uuid
    listVideoCards() {
      const cards = Array.from(document.querySelectorAll('a[href*="/edit/"]'));
      return cards.map(a => a.href.split('/').pop());
    },
  }),

  meta: Object.freeze({
    __version: 'm3-2026-04-06',
    __keys() { return Object.keys(window.__i2v_modules).sort(); },
  }),
});
console.log('[i2v] window.__i2v_modules exported, modules:', Object.keys(window.__i2v_modules).length);
```

**步骤：**
1. 验证基线 `wc -l i2v_extension/content.js`（应是 c7963ad 之后的行数）
2. 追加上面那个块
3. 验证行数严格增加
4. `node --check i2v_extension/content.js`
5. 抽检：第 901 行仍是 `chrome.runtime.onMessage`，M2 的 `__i2v_health` 块仍然完整
6. `git diff HEAD -- i2v_extension/content.js | grep "^-[^-]" | wc -l` → 必须为 0
7. Commit: `feat(i2v_extension): add window.__i2v_modules logical namespace for M3 testing`
8. 通过 i2v-cli 自动 reload 扩展
9. 实测：`i2v-cli eval "window.__i2v_modules.meta.__keys()" --world isolated` → 应返回 7 个模块名的数组
10. 实测：`i2v-cli eval "window.__i2v_modules.prompt.read()" --world isolated` → 应返回 `{ok:true,text:...}`

**验收：** 7 个模块都能从 i2v-cli 单独调用，原代码路径不受影响。

---

## 任务 M3.2：纯函数 lib/ + Node 单测

**文件：**
- 创建：`i2v_extension/lib/withRetry.js`
- 创建：`i2v_extension/lib/checkpoint.js`
- 创建：`i2v_extension/lib/workflow-diff.js`
- 创建：`i2v_extension/lib/README.md`
- 创建：`i2v-cli/test/lib-withRetry.test.js`
- 创建：`i2v-cli/test/lib-checkpoint.test.js`
- 创建：`i2v-cli/test/lib-workflow-diff.test.js`

**重要：** lib/ 目录里的是**复制**，不是移动。`background.js` / `content.js` 里的原版保持字节级不变，继续作为生产代码路径。lib/ 副本只是为了让同样的逻辑能在 Chrome 之外用 `node --test` 测试。

### lib/withRetry.js — 从 background.js:195 抽出

```js
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
```

### lib/checkpoint.js — checkpoint 序列化（来自 background.js:117 体系）

```js
// 纯 checkpoint 序列化器。剥离重字段（image_base64）让 checkpoint 不超过
// chrome.storage 限制。background.js 里的生产 saveCheckpoint 把这段
// 内联了；这里抽出一份纯版本用于测试。

const HEAVY_FIELDS = ['image_base64', 'image_data_url'];

export function serializeCheckpoint(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('checkpoint state must be an object');
  }
  // 浅拷贝（rows 嵌套也只剥一层）
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
```

### lib/workflow-diff.js — 对比两次缓存快照算新增 workflowId

```js
// 对比两份 project-cache 快照，返回 `after` 里有但 `before` 里没有的
// workflowId。Phase 1 用这个来检测一行刚提交后被分配了哪个 workflowId
// （生产版本内联在 content.js processRow 里；这里是纯版本用于测试）。

export function diffWorkflowIds(beforeMap, afterMap) {
  if (!afterMap || typeof afterMap !== 'object') return [];
  if (!beforeMap || typeof beforeMap !== 'object') beforeMap = {};
  const added = [];
  for (const wfId of Object.keys(afterMap)) {
    if (!beforeMap[wfId]) added.push(wfId);
  }
  return added;
}

export function pickFirstNewWorkflow(beforeMap, afterMap) {
  const added = diffWorkflowIds(beforeMap, afterMap);
  return added[0] || null;
}
```

### 测试文件

**i2v-cli/test/lib-withRetry.test.js:**
```js
import { test } from 'node:test';
import assert from 'node:assert';
import { withRetry } from '../../i2v_extension/lib/withRetry.js';

test('withRetry: 函数成功时立即返回', async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return 'ok'; });
  assert.strictEqual(r, 'ok');
  assert.strictEqual(calls, 1);
});

test('withRetry: 暂态错误重试后成功', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('timeout reached');
    return 'finally';
  }, { delays: [1, 1, 1], sleepImpl: () => Promise.resolve() });
  assert.strictEqual(r, 'finally');
  assert.strictEqual(calls, 3);
});

test('withRetry: 非暂态错误立即抛出', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('permission denied'); },
              { sleepImpl: () => Promise.resolve() }),
    /permission denied/
  );
  assert.strictEqual(calls, 1);
});

test('withRetry: 重试用完后放弃', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('timeout'); },
              { retries: 2, delays: [1,1,1], sleepImpl: () => Promise.resolve() }),
    /timeout/
  );
  assert.strictEqual(calls, 3); // 第 1 次 + 2 次重试
});
```

**i2v-cli/test/lib-checkpoint.test.js:**
```js
import { test } from 'node:test';
import assert from 'node:assert';
import { serializeCheckpoint, deserializeCheckpoint, isExpired } from '../../i2v_extension/lib/checkpoint.js';

test('serializeCheckpoint: 剥离 rows 中的 image_base64', () => {
  const state = {
    phase: 'phase1',
    rows: [
      { row_n: 1, prompt: 'p1', image_base64: 'AAAAAA' },
      { row_n: 2, prompt: 'p2', image_data_url: 'data:image/png;base64,xxx' },
    ],
  };
  const c = serializeCheckpoint(state);
  assert.strictEqual(c.rows[0].image_base64, undefined);
  assert.strictEqual(c.rows[0].prompt, 'p1');
  assert.strictEqual(c.rows[1].image_data_url, undefined);
  assert.strictEqual(c.rows[1].prompt, 'p2');
  assert.ok(c.savedAt);
});

test('serializeCheckpoint: 非对象输入抛错', () => {
  assert.throws(() => serializeCheckpoint(null), /must be an object/);
});

test('deserializeCheckpoint: 处理字符串和对象', () => {
  assert.deepStrictEqual(deserializeCheckpoint('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(deserializeCheckpoint({ a: 1 }), { a: 1 });
  assert.strictEqual(deserializeCheckpoint(null), null);
  assert.strictEqual(deserializeCheckpoint('not json'), null);
});

test('isExpired: 缺 savedAt 返回 true', () => {
  assert.strictEqual(isExpired(null), true);
  assert.strictEqual(isExpired({}), true);
});

test('isExpired: 新 checkpoint 返回 false', () => {
  assert.strictEqual(isExpired({ savedAt: new Date().toISOString() }), false);
});

test('isExpired: 旧 checkpoint 返回 true', () => {
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  assert.strictEqual(isExpired({ savedAt: old }), true);
});
```

**i2v-cli/test/lib-workflow-diff.test.js:**
```js
import { test } from 'node:test';
import assert from 'node:assert';
import { diffWorkflowIds, pickFirstNewWorkflow } from '../../i2v_extension/lib/workflow-diff.js';

test('diffWorkflowIds: before 空，after 有数据', () => {
  assert.deepStrictEqual(diffWorkflowIds({}, { a: [], b: [] }).sort(), ['a', 'b']);
});

test('diffWorkflowIds: 相同 map 返回空', () => {
  assert.deepStrictEqual(diffWorkflowIds({ a: [] }, { a: [] }), []);
});

test('diffWorkflowIds: 只返回新 key', () => {
  assert.deepStrictEqual(diffWorkflowIds({ a: [] }, { a: [], b: [] }), ['b']);
});

test('diffWorkflowIds: 处理 null 输入', () => {
  assert.deepStrictEqual(diffWorkflowIds(null, { a: [] }), ['a']);
  assert.deepStrictEqual(diffWorkflowIds({ a: [] }, null), []);
});

test('pickFirstNewWorkflow: 返回第一个新增或 null', () => {
  assert.strictEqual(pickFirstNewWorkflow({}, { x: [] }), 'x');
  assert.strictEqual(pickFirstNewWorkflow({ x: [] }, { x: [] }), null);
});
```

**lib/README.md:**
```markdown
# i2v_extension/lib/

从 background.js / content.js 抽出的纯辅助函数，作为 ES module。

**重要：** 这些是副本，不是生产代码的权威源。权威实现仍在原文件里。
这里存在只为了让同样的逻辑能用 `node --test` 在 Chrome 之外做单测。

更新时：原文件和 lib 副本**同时**改，并跑测试。
```

**步骤：**
1. 创建 4 个 lib 文件
2. 创建 3 个 test 文件
3. 跑测试：`cd i2v-cli && node --test test/`
4. 期望：4（已有 cdp 测试） + 4 + 6 + 5 = 19 个测试通过
5. Commit: `feat(lib+test): extract pure helpers withRetry/checkpoint/workflow-diff with Node unit tests`

---

## 任务 M3.3：i2v-cli mock 模式（--mock flag）

**文件：**
- 修改：`i2v-cli/lib/cdp.js`（加 `installMockFetch` 辅助函数）
- 修改：`i2v-cli/bin/i2v-cli.js`（加 `--mock` flag，命中时安装 mock）

**规格：** 传 `--mock` 时，在执行命令前，往 **isolated world** 注入一段 `window.fetch` 拦截器，捕捉所有发往 `i2v-server.vercel.app` 的请求并返回假响应。真实的 Flow API 请求不动。

```js
// 在 lib/cdp.js 加：

export const MOCK_FETCH_SCRIPT = `
(() => {
  if (window.__i2v_mock_installed) return 'already installed';
  window.__i2v_mock_installed = true;
  window.__i2v_mock_log = [];
  const realFetch = window.fetch.bind(window);
  const PROD_HOST = 'i2v-server.vercel.app';
  function fakeResponse(url, body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-i2v-mock': '1' },
    });
  }
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (url && url.includes(PROD_HOST)) {
      window.__i2v_mock_log.push({ ts: Date.now(), method: init?.method || 'GET', url });
      // 按路径路由
      if (url.includes('/api/activate'))   return fakeResponse(url, { success: true, code: 'I2V-MOCK', activated_at: new Date().toISOString() });
      if (url.includes('/api/verify'))     return fakeResponse(url, { success: true, valid: true });
      if (url.includes('/api/sync-row'))   return fakeResponse(url, { success: true });
      if (url.includes('/api/save-rows'))  return fakeResponse(url, { success: true, count: 0 });
      if (url.includes('/api/get-rows'))   return fakeResponse(url, { success: true, rows: [] });
      if (url.includes('/api/log'))        return fakeResponse(url, { success: true });
      if (url.includes('/api/generate'))   return fakeResponse(url, {
        success: true,
        prompts: [{ segment_1: 'mock segment 1', segment_2: 'mock segment 2', segment_1_zh: '模拟', segment_2_zh: '延伸' }],
      });
      return fakeResponse(url, { success: true, _mock: true });
    }
    return realFetch(input, init);
  };
  return 'installed';
})()
`;

export async function installMockFetch(client) {
  // 注入到 isolated world。生产 background.js 的 fetch 在不同进程
  // （CDP 触不到），content.js 的 fetch 在 isolated world，所以这里
  // 主要 cover content.js 的代码路径。
  const result = await client.Runtime.evaluate({
    expression: MOCK_FETCH_SCRIPT,
    contextId: client.__i2v?.isolatedContextId,
    returnByValue: true,
  });
  return result.result.value;
}

export async function readMockLog(client) {
  const result = await client.Runtime.evaluate({
    expression: 'window.__i2v_mock_log || []',
    contextId: client.__i2v?.isolatedContextId,
    returnByValue: true,
  });
  return result.result.value;
}
```

**i2v-cli/bin/i2v-cli.js 改动：**
- parseArgs 加 `--mock`
- 在 `cmdEval` / `cmdCall` / `cmdHealth` / `cmdContexts` 里 `await attach(...)` 之后，如果 `args.mock` 为真就调 `installMockFetch(client)`
- 命令开始时打印一行 `[i2v-cli] mock 模式：i2v-server 请求将被拦截`
- USAGE 里加 `--mock` 文档

**步骤：**
1. 在 `lib/cdp.js` 加 `installMockFetch` + `MOCK_FETCH_SCRIPT`
2. 在 `bin/i2v-cli.js` 接上 `--mock`
3. 跑回归测试：`cd i2v-cli && node --test test/` —— 19 个全过
4. 实测：`i2v-cli eval --mock "fetch('https://i2v-server.vercel.app/api/verify').then(r=>r.json())" --world isolated`
   期望：返回 `{success:true,valid:true}`，**没碰生产**
5. 反向实测：同样的命令**不带** `--mock` 时会真打生产（**别真跑这步**，只是确认代码路径是有条件的）
6. Commit: `feat(i2v-cli): add --mock flag to intercept i2v-server requests`

**关键安全检查：** 用 grep 确认 `i2v-server.vercel.app` 这个域名只在脚本里的一个地方硬编码，不重复。

---

## 任务 M3.4：i2v-cli test 子命令 + reload 子命令

**文件：**
- 修改：`i2v-cli/bin/i2v-cli.js`（加 `cmdTest` + `cmdReload`）

**规格：** 加 `i2v-cli test <module>` 子命令，能跑某个逻辑模块的脚本化场景，不触发完整流水线。加 `i2v-cli reload` 子命令，把 M2 demo 时临时写的 reload-ext 集成进 CLI（chrome.runtime.reload + Page.reload）。

### cmdTest 场景

```
i2v-cli test prompt --text "hi"
  → modules.prompt.injectText("hi") → modules.prompt.read() → 断言文字含 "hi"

i2v-cli test generate
  → modules.generate.isReady() → 打印状态，不点击

i2v-cli test cache
  → modules.cache.read() → 打印 videos.length / images.length

i2v-cli test navigate
  → modules.navigate.listVideoCards() → 打印 uuids

i2v-cli test extend --uuid <uuid>
  → modules.extend.isExtended(uuid) → 打印结果，不实际延伸

i2v-cli test download --dry-run
  → modules.download.getUrl() → 打印 URL，不点下载
```

每个场景：attach → 调对应的 modules.X.Y() → 打印结构化结果 → exit 0/1。

### cmdReload

把 M2 demo 时的 `reload-ext.js` 改成内置子命令：

```js
async function cmdReload(args) {
  const port = args.port;
  // 1. 找 SW target
  const targets = await CDP.List({ port });
  const sw = targets.find(t => t.type === 'service_worker' && (t.url || '').includes('iobbhjboelobcfjkgfggcinhgncliblj'));
  if (!sw) { console.error('未找到 i2v service worker'); process.exit(1); }
  // 2. 调 chrome.runtime.reload()
  const swClient = await CDP({ target: sw.webSocketDebuggerUrl, port });
  await swClient.Runtime.enable();
  try { await swClient.Runtime.evaluate({ expression: 'chrome.runtime.reload()', awaitPromise: false }); } catch {}
  try { await swClient.close(); } catch {}
  await new Promise(r => setTimeout(r, 2000));
  // 3. 刷新 Flow 标签页
  const tabs2 = await CDP.List({ port });
  const flow = tabs2.find(t => /labs.google\/fx\/tools\/flow/.test(t.url || ''));
  if (flow) {
    const tc = await CDP({ target: flow.webSocketDebuggerUrl, port });
    await tc.Page.enable();
    await tc.Page.reload({ ignoreCache: false });
    await tc.close();
  }
  console.log('已 reload');
}
```

**步骤：**
1. 加 `cmdReload` 并在 switch 里接 `case 'reload'`
2. 加 `cmdTest` + 上面 6 个场景，接 `case 'test'`
3. 更新 USAGE
4. `node --check bin/i2v-cli.js`
5. `cd i2v-cli && node --test test/` —— 19 个全过
6. 实测：`node bin/i2v-cli.js reload` → reload 扩展 + 刷新 Flow 页
7. 实测：`node bin/i2v-cli.js test cache` → 通过 modules.cache.read() 读项目缓存
8. 实测：`node bin/i2v-cli.js test prompt --text "hello m3"` → 注入 + 读回，断言含 "hello m3"
9. Commit: `feat(i2v-cli): add reload and test subcommands`

---

## 整体验收（M3 全部完成后）

```bash
# 1. 测试
cd i2v-cli && node --test test/    # 19 通过 / 0 失败

# 2. 模块
node bin/i2v-cli.js reload                     # 自动 reload 扩展
node bin/i2v-cli.js eval "window.__i2v_modules.meta.__keys()" --world isolated
# → ["cache","download","extend","generate","meta","navigate","prompt","upload"]

# 3. Mock
node bin/i2v-cli.js eval --mock "fetch('https://i2v-server.vercel.app/api/verify').then(r=>r.json())" --world isolated
# → {"success":true,"valid":true}（没碰生产）

# 4. test 场景
node bin/i2v-cli.js test cache    # 读缓存零副作用
node bin/i2v-cli.js test prompt --text "smoke test"   # 注入 + 验证

# 5. health 仍然正常
node bin/i2v-cli.js health         # M2 仍然功能完整，无回归
```

**验收标准：**
- 生产扩展行为不变（重新加载扩展，开侧边栏，照常工作）
- 19+ 个单测全过
- Mock 模式 grep + 实测确认未碰生产
- 每个模块都能独立测试，不需要走完整批处理
- 所有 commit 都保持回归测试全绿

## 回滚

每个任务都是独立可逆的，因为全部是追加：
```
git revert <task-commit-sha>
```
彻底回滚整个 M3：
```
git reset --hard c7963ad   # M2 最后一个 commit
```

## 硬约束再次提醒

- 不动 content.js / background.js / popup.js / manifest.json 的任何现有行；不动 i2v-server/ 任何文件
- 不加新 Chrome 权限
- 不引构建步骤
- Mock 模式默认 OFF
- 每个 commit 保持测试全绿
