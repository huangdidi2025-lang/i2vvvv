# CDP 驱动的 I2V 架构设计

**日期：** 2026-04-06
**状态：** 已批准 brainstorming，待实施
**作者：** Claude + 用户 brainstorming 会话

## 背景与动机

I2V 图生视频工具当前是一个 Chrome MV3 扩展，通过注入 content.js 自动化操作 Google Flow (Veo) 页面。使用中暴露出四类痛点：

1. **Flow UI 频繁改版** 导致 content.js 里硬编码的 DOM 选择器经常失效，每次都要手动排查
2. **功能耦合严重** —— background.js (954 行) 把许可、保活、批处理编排、Phase1、Phase2、下载、checkpoint 全缠在一起；改 A 弄坏 B
3. **调试迭代循环过长** —— Claude 盲写代码 → 用户加载扩展 → 用户手动跑 → 复制日志回传 → Claude 猜错在哪 → 再改。一个 bug 要来回好几轮
4. **已部署在 Vercel 的生产后端 `i2v-server.vercel.app` 有真实用户**，任何测试改动都不能影响它

## 目标（用户原话）

1. 用户可以直接在登录好 Flow 页面下进行自动化脚本操作
2. 每个功能的改动和调整可以互不影响
3. 整合起来的 UI 界面简洁，容易操作
4. 所有工具，用 Claude 可以自动修改、调试、真正去操作工具运行、运行时的监控和调试

## 非目标

- 不重写已部署的 `i2v-server/` Vercel 项目
- 不改动生产 Firebase (`i2v-5aed8`) 的 schema 或数据
- 不改变终端用户的使用体验（他们仍然装同一个 Chrome 扩展）
- 不做云端选择器下发/灰度/众包（yagni，本地维护即可）

## 硬约束（红线）

- **不得影响 `https://i2v-server.vercel.app` 的任何端点行为**
- **不得往生产 Firebase 写测试数据**（测试用 Mock 模式，不打 `/api/activate`、`/api/sync-row`、`/api/save-rows`、`/api/log`）
- 若将来确需改后端，**新建独立测试版本** (例如 `i2v-server-test/` 独立 Vercel 项目)，不动现有生产代码

## 考虑过的方案

### 方案 A：诊断面板 + 独立维护扩展 + 云端规则下发 ❌ 过度工程

做一个 `test.html` 升级版，按 content.js 的 12 个 action 给每个原子能力独立按钮；再做一个独立维护扩展扫描 Flow DOM 生成选择器规则；规则发布到 GitHub raw 或独立 Vercel，用户端定期拉取。

**否决原因：** 工作量大（独立后端 + 规则 schema + 审核台 + 灰度机制），而且最根本的"Claude 能自己调试"这点它解决不了——面板还是要用户手点，Claude 还是盲的。

### 方案 B：静态多策略 fallback 选择器 ⚠️ 有用但不够

每个元素配 3-5 个备选策略（主选择器 + 文本 + 图标 + aria + 结构），运行时按顺序试。

**评估：** 是必要组件，但单独用不够——它只能增加韧性，不能让 Claude 自己迭代。

### 方案 C（最终选定）：CDP 驱动 + 数据化选择器 + 模块化 ✅

核心洞察：**Chrome 自带 `--remote-debugging-port=9222` 可以让外部程序完全控制已登录的浏览器实例**。这意味着 Claude 通过一个薄 CLI 就能：
- 查 Flow 页面实时 DOM
- 在页面里执行任意 JS
- 调用扩展暴露在 `window.__i2v` 上的任意函数
- 读 console 日志、截图、监听 DOM 变化

配合把选择器抽到 `selectors.json`、content.js 拆成功能模块，Claude 就能独立迭代每一个模块而不碰其他部分。

**选定原因：** 一次性把需求 2/3/4 全部解决。需求 3 "UI 简洁" 的实现方式从"加调试面板"变成"砍掉调试面板，调试 UI 就是 Claude 自己"。

## 架构

```
┌────────────────────────────────────────────────────────────┐
│ Windows 桌面快捷方式                                          │
│   chrome.exe --remote-debugging-port=9222                  │
│              --user-data-dir=<已登录 profile>                │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Flow 标签页 (labs.google/fx/tools/flow/...)          │  │
│  │                                                      │  │
│  │  ┌────────────────────────────────────────────────┐  │  │
│  │  │ i2v_extension (用户装的扩展, MV3)               │  │  │
│  │  │                                                │  │  │
│  │  │  content.js (拆成模块)                         │  │  │
│  │  │    ├── content/selectors.js (读 selectors.json)│  │  │
│  │  │    ├── content/upload.js                      │  │  │
│  │  │    ├── content/prompt.js                      │  │  │
│  │  │    ├── content/generate.js                    │  │  │
│  │  │    ├── content/extend.js                      │  │  │
│  │  │    ├── content/download.js                    │  │  │
│  │  │    └── content/cache.js                       │  │  │
│  │  │                                                │  │  │
│  │  │  dev 模式挂载:                                 │  │  │
│  │  │    window.__i2v = {                           │  │  │
│  │  │      selectors: { findGenerateBtn, ... },     │  │  │
│  │  │      upload: { uploadImage, ... },            │  │  │
│  │  │      prompt: { injectPrompt, ... },           │  │  │
│  │  │      generate: { clickGenerate, ... },        │  │  │
│  │  │      extend: { extendVideo, ... },            │  │  │
│  │  │      download: { getVideoUrl, ... },          │  │  │
│  │  │      cache: { getProjectData, ... },          │  │  │
│  │  │      health: { runHealthCheck },              │  │  │
│  │  │    }                                           │  │  │
│  │  └────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────────┬────────────────────────────────┘
                            │ WebSocket (CDP)
                            │ ws://localhost:9222/devtools/...
                            ▼
              ┌─────────────────────────────┐
              │ i2v-cli (Node.js + CRI)     │
              │                             │
              │ Commands:                   │
              │   i2v-cli connect           │  找到 Flow 标签页
              │   i2v-cli eval "<js>"       │  跑任意 JS
              │   i2v-cli call <path> [...] │  调 window.__i2v 里的函数
              │   i2v-cli logs [--tail]     │  流式读 console
              │   i2v-cli screenshot <file> │  截当前状态
              │   i2v-cli health            │  选择器健康检查
              │   i2v-cli test <module>     │  分模块测试
              │   i2v-cli --mock            │  拦截所有 i2v-server 请求
              └─────────────────────────────┘
                            ▲
                            │ bash
                            │
                      ┌─────┴──────┐
                      │  Claude    │
                      │  (我)      │
                      └────────────┘
```

## 核心组件

### 1. `i2v-cli/` — Node.js CDP 客户端

- 位置：`d:\i2v-tool\i2v-cli\` (新建，跟 i2v_extension 平级)
- 依赖：`chrome-remote-interface` (npm)
- 入口：`bin/i2v-cli.js`
- 核心模块：
  - `lib/cdp.js` — 连接 CDP、列出标签页、找 Flow 标签页、Runtime.evaluate 封装
  - `lib/commands/` — 每个子命令一个文件 (eval.js, call.js, logs.js, screenshot.js, health.js, test.js)
  - `lib/mock.js` — Fetch 拦截：向 Flow 标签页注入 Network interception，把所有 `i2v-server.vercel.app` 请求短路成本地假响应
- 约定：所有命令都是异步的，带 `--timeout` 和 `--json` 输出选项

### 2. `i2v_extension/content/` — 模块化 content script

- **现状：** `content.js` 单文件 1153 行
- **目标：** 按功能拆分为独立模块，每个模块暴露纯函数，模块之间通过明确接口调用，不共享隐式状态
- 拆分清单：
  ```
  content/
    index.js       入口: 注册 onMessage 监听器 + 挂 window.__i2v (dev 模式) + 注入 regen 按钮
    selectors.js   从 selectors.json 读规则 + 多策略 fallback 查找元素
    upload.js      DataTransfer 上传图片
    prompt.js      beforeinput 注入提示词到 Lexical 编辑器
    generate.js    等生成按钮可用 + 点击
    extend.js      切模型 + 输 segment_2 + 点 Extend + 点生成
    download.js    getVideoUrl + clickDownload
    cache.js       React Query 缓存读写 + workflowId diff
    lib/dom.js     simulateClick / waitFor / smartClick 等基础工具
  ```
- **向后兼容：** `index.js` 里把原本的 `chrome.runtime.onMessage` action 路由全部保留，转发到新模块，background.js 不用改

### 3. `i2v_extension/selectors.json` — 数据化选择器规则

- 位置：`i2v_extension/selectors.json` (打包进扩展)
- schema：
  ```json
  {
    "version": "2026.04.06.1",
    "flow_url_pattern": "labs.google/fx/tools/flow",
    "elements": {
      "open_upload_dialog_btn": {
        "description": "打开上传对话框的按钮",
        "used_by": ["upload.js:openDialog"],
        "strategies": [
          { "type": "css", "selector": "button[aria-haspopup='dialog']" },
          { "type": "text", "tag": "button", "contains": "upload" }
        ],
        "validation": {
          "visible": true,
          "clickable": true,
          "count": 1
        }
      }
    }
  }
  ```
- `selectors.js` 实现 `findElement(key)`：按 strategies 顺序尝试，命中即返回；同时记录"命中的是第几条策略"到 `window.__i2v_health` 以便 `i2v-cli health` 读取
- 规则更新：Claude 直接编辑 `selectors.json`，`git commit` 即"发布"；用户端下次加载扩展时自动用新规则

### 4. 生产隔离 / Mock 模式

- `i2v-cli` 默认启动时注入 Mock：在 Flow 标签页里 hook `window.fetch` 和 `XMLHttpRequest`，拦截所有到 `i2v-server.vercel.app` 的请求
- 拦截规则：
  - `/api/activate`, `/api/verify` → 返回固定的 fake license 响应
  - `/api/sync-row`, `/api/save-rows`, `/api/log` → 返回 `{ok: true}`，真实请求不发出
  - `/api/generate` → 返回一份写死的 segment_1/segment_2 样例 JSON
- 只有显式加 `--prod` flag 才会让真实请求通过
- 这一层在 CLI 侧实现，不动扩展代码（扩展代码照常 fetch，只是被前置拦截了）

### 5. 健康检查系统

- `i2v-cli health` 的实现：
  1. CDP 连到 Flow 标签页
  2. 调用 `window.__i2v.health.runHealthCheck()`（在 `content/selectors.js` 里定义）
  3. 该函数遍历 `selectors.json` 的所有 elements，对每个 key 跑 `findElement`
  4. 返回结构：
     ```json
     {
       "ok": true,
       "total": 15,
       "passed": 14,
       "failed": 1,
       "details": [
         { "key": "open_upload_dialog_btn", "status": "ok", "strategy_used": 0 },
         { "key": "generate_btn", "status": "fallback", "strategy_used": 2, "warning": "主策略失效" },
         { "key": "extend_btn", "status": "fail", "tried": 3, "error": "all strategies miss" }
       ]
     }
     ```
- Claude 看到输出后可以：
  - 如果 `failed > 0`：用 `i2v-cli eval` 跑 `document.querySelector(...)` 试探新选择器，更新 `selectors.json`，再跑 health 验证
  - 如果 `fallback`：提示用户"主策略失效，建议更新"，但不阻塞执行

### 6. 分模块测试

- `i2v-cli test <module>`：
  - `test upload --file sample.png` → 只跑 `window.__i2v.upload.uploadImage()`，不碰其他环节
  - `test prompt --text "hello"` → 只测提示词注入
  - `test extend --uuid xxx --segment2 "..."` → 只测延伸某一个视频
  - `test cache` → 只测 React Query 缓存读取
- 每个测试独立，不依赖前后环节；Claude 可以精准验证某个函数是否工作

## 数据流示例：Claude 修一个选择器飘移 Bug

**场景：** Flow 改版了，`findGenerateBtn` 找不到生成按钮了，批处理跑不起来

**之前（盲写）：**
1. 用户报 bug："生成按钮点不到"
2. Claude 猜测改 content.js
3. 用户 reload 扩展、打开 Flow、跑批处理、复制日志
4. 日志显示还是不行
5. 回到步骤 2，循环 N 次

**现在（CDP 驱动）：**
1. Claude `i2v-cli health` → 看到 `generate_btn: fail`
2. Claude `i2v-cli eval "document.body.innerHTML.match(/arrow_forward.*?</button>/g)"` → 看到 Flow 改成了新 icon
3. Claude `i2v-cli eval "[...document.querySelectorAll('button')].filter(b => b.textContent.includes('新图标名')).length"` → 验证新选择器能命中
4. Claude 编辑 `selectors.json`，给 `generate_btn` 的 strategies 加一条新规则
5. Claude `i2v-cli health` → 看到 `generate_btn: ok`，修复完成
6. Claude `i2v-cli test generate` → 实际点一下验证
7. 全程不需要用户参与

## 模块独立性保证

需求 2 "每个功能改动互不影响" 通过三个层次保证：

1. **代码层：** content.js 拆成 7 个模块，每个模块只导出纯函数，不共享全局变量（`window.__i2v` 只是展示面板，不是状态存储）
2. **测试层：** `i2v-cli test <module>` 可以脱离其他模块单独跑任意一个，验证不受其他模块影响
3. **数据层：** 选择器规则抽到 JSON，改元素查找逻辑不用动业务代码

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| CDP 调试端口暴露给本机其他程序 | 只监听 localhost，文档里提醒用户不要在多用户共享机器上用 |
| dev 模式的 `window.__i2v` 被打包进生产版本 | manifest build 时用环境变量区分，生产版本剥离 |
| Chrome 升级破坏 CDP 协议 | `chrome-remote-interface` 是稳定库，Chrome 团队保证向后兼容 |
| 拆分 content.js 时引入 regression | M2 之前先把所有现有 action 做一遍手动冒烟测试，拆完再跑一遍对比 |
| selectors.json 热更新机制暂未实现（需要重新加载扩展） | M1-M3 先不做热更新，Claude 改完 JSON 后用户 reload 扩展；未来迭代再加 |
| Chrome `--remote-debugging-port` 启动会丢失默认配置 | 明确告诉用户新建一个带参数的快捷方式，不覆盖原快捷方式 |

## 里程碑

### M1 — CDP 通路打通（最小可行）

**目标：** 证明 Claude 能"看见"和"操作" Flow 页面

- 文档：如何改 Chrome 快捷方式加 `--remote-debugging-port=9222`
- `i2v-cli/` 初始化 (package.json + chrome-remote-interface)
- `i2v-cli connect` 命令：找到 Flow 标签页并打印 title/url
- `i2v-cli eval "<js>"` 命令：在 Flow 页面执行任意 JS
- `content.js` 最小改动：在文件末尾追加 `window.__i2v = { findGenerateBtn, findTextbox, processRow, extendVideo, getProjectDataFromCache, ... }`（导出已有函数，**不改任何逻辑**）
- `i2v-cli call __i2v.findGenerateBtn` 验证能调到
- **验收：** Claude 能通过 bash 拿到 Flow 页面 DOM 查询结果
- **停下点：** 用户 review 通路，确认 OK 再继续

### M2 — 选择器数据化 + 健康检查

**目标：** Flow 改版时能一眼看出哪个选择器失效

- 新建 `i2v_extension/selectors.json`，把 content.js 里所有硬编码选择器迁移进去（约 15-20 个元素）
- 新建 `content/selectors.js` 实现 `findElement(key)` + 多策略 fallback
- content.js 里 `findGenerateBtn` / `findTextbox` 等函数改成调用 `findElement('generate_btn')`，**不改调用点**
- 新增 `window.__i2v.health.runHealthCheck()`
- `i2v-cli health` 命令
- **验收：** `i2v-cli health` 返回所有元素当前状态，Claude 能独立判断 Flow 是否改版
- **停下点：** 跑一次 health 看当前 Flow 真实状态

### M3 — 模块化 + 分模块测试

**目标：** 每个功能可以独立改、独立测、互不影响

- content.js 拆成 `content/` 下 7 个模块
- 纯函数（checkpoint 序列化、cache diff、prompt JSON 解析）抽到 `i2v_extension/lib/`，加 Node `--test` 单测
- `i2v-cli test <module>` 命令
- `i2v-cli --mock` 模式（拦截 i2v-server 请求）
- **验收：** Claude 能独立测试任意一个功能，且不污染生产后端
- **停下点：** 全部完成，日常使用流程建立

## 成功标准

1. Claude 可以通过 `i2v-cli` 独立完成 "看到 Flow DOM → 改选择器 → 验证修复" 的循环，用户只需 reload 扩展
2. `selectors.json` 里任意选择器改动不会影响其他选择器
3. content.js 任意模块改动不会影响其他模块，`i2v-cli test <module>` 能独立验证
4. 跑 `i2v-cli` 的任何命令都不会向 `i2v-server.vercel.app` 发请求（除非显式 `--prod`）
5. 终端用户使用 Chrome 扩展的体验和之前完全一样

## 未来（不在本次范围）

- selectors.json 热更新（不 reload 扩展就能生效）
- 选择器规则云端分发 + 灰度
- i2v-cli 开发服务器模式（长连接 + 文件 watch）
- 自动化回归测试套件
