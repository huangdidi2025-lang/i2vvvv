# 测试策略

## 测试分层

### 第1层：静态检查（零依赖，秒级）
```bash
# 语法检查
node -c i2v_extension/background.js
node -c i2v_extension/content.js
node -c i2v_extension/popup.js
node -c i2v-server/api/index.js

# JSON 检查
node -e "JSON.parse(require('fs').readFileSync('i2v_extension/manifest.json'))"
```

### 第2层：API 连通性（需网络，秒级）
```bash
# 验证 Vercel 部署
curl -s https://i2v-server.vercel.app/api/verify \
  -H "Content-Type: application/json" \
  -d '{"code":"TEST","device_id":"test"}'

# 预期：{"valid": false, "error": "许可码无效"}
```

### 第3层：Chrome 扩展自动化测试（puppeteer-core）

**前置**：`npm install puppeteer-core`（使用系统 Chrome，不下载 Chromium）

**测试脚本模板**（可作为参考重新创建）：
```js
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EXTENSION_PATH = path.resolve('d:/i2v-tool/i2v_extension');

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: false,  // 扩展只能有头模式
  args: [
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    '--no-first-run',
    '--window-size=1280,900',
    // 可选：持久化 profile 保留登录态
    '--user-data-dir=d:/i2v-tool/.chrome-test-profile',
  ],
  defaultViewport: null,
});

// 获取扩展 ID
await new Promise(r => setTimeout(r, 3000));
const targets = browser.targets();
const swTarget = targets.find(t =>
  t.type() === 'service_worker' && t.url().includes('chrome-extension://')
);
const extensionId = swTarget?.url().match(/chrome-extension:\/\/([^/]+)/)?.[1];

// 打开 sidepanel
const page = await browser.newPage();
await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

// 通过 chrome.runtime.sendMessage 测试 background
const status = await page.evaluate(() => {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ action: 'get_status' }, resolve);
  });
});
```

**可测试的内容**：
- ✓ 扩展加载 + Service Worker 启动
- ✓ 所有 `chrome.runtime.sendMessage` handler（get_status / save_rows / delete_row / force_reset / activate / generate_prompts ...）
- ✓ UI 元素存在性、初始状态、按钮禁用逻辑
- ✓ `chrome.storage.local` 读写
- ✓ `chrome.alarms` 配置（keepalive）

**不能测试的**：
- ✗ Flow 页面的 DOM 自动化（需要 Google 登录）
- ✗ MiniMax/Gemini API 实际生成（需要有效许可码 + 消耗配额）
- ✗ 视频实际生成和延伸

### 第4层：手动测试（人工，分钟级）

Flow 页面上的真实流程只能手动测：
1. 重新加载扩展（`chrome://extensions/`）
2. 打开 Flow 项目页面
3. 扩展侧边栏：激活 → 上传图 → 生成提示词 → 开始批处理
4. 观察日志区、任务列表状态变化
5. 检查 Flow 上是否出现新视频卡、延伸是否成功

## 常用诊断命令（Flow 页面控制台）

```js
// 扩展状态
chrome.runtime.sendMessage({action: "get_status"}, r => console.log(r))

// 强制重置卡死状态
chrome.runtime.sendMessage({action: "force_reset"}, r => console.log(r))

// 从 storage 查看任务
chrome.storage.local.get("i2v_rows", d => console.log(d.i2v_rows?.length))

// 查看批处理 checkpoint
chrome.storage.local.get("checkpoint", d => console.log(d.checkpoint))

// 清除 checkpoint（手动恢复卡死）
chrome.storage.local.remove("checkpoint")

// 触发启动批处理
window.dispatchEvent(new CustomEvent("__start_i2v__", {detail: {limit: 5}}))

// 停止
window.dispatchEvent(new CustomEvent("__stop_batch__"))
```

## CI/CD 考量

当前项目**没有 CI/CD**。如果要加：
- GitHub Actions 上跑第1层（静态检查）和第2层（API 连通）很容易
- 第3层 puppeteer 测试在无头环境不能加载扩展，需要用 xvfb 或本地 runner
