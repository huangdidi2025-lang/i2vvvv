# Claude 调试 i2v 工具的工作流

> 这份文档是为**未来的 Claude 会话**写的。当你（Claude）被叫来调试或扩展 i2v 工具时，先读这份。

## TL;DR

你不是盲写代码再让用户跑。你直接通过 CDP 看 Flow 页面、调函数、跑测试。

## 前提：用户的环境设置

1. Chrome 必须用快捷方式启动，target 末尾带 `--remote-debugging-port=9222`
2. i2v 扩展从 `d:\i2v-tool\i2v_extension\` 加载（开发模式）
3. 用户应该在某个 Flow project 页面：`https://labs.google/fx/tools/flow/project/<uuid>`

如果没有这些，问用户先做。验证：`node i2v-cli/bin/i2v-cli.js connect` 应该能找到 Flow tab。

## 你的工具箱

工具都在 `d:/i2v-tool/i2v-cli/`。**全部**通过 bash 调用，**不要**通过 chrome.runtime 消息。

```bash
# 探测页面状态
node i2v-cli/bin/i2v-cli.js connect             # 找 Flow tab
node i2v-cli/bin/i2v-cli.js contexts            # 列执行上下文（main + isolated）
node i2v-cli/bin/i2v-cli.js eval "<js>"         # 主世界跑 JS
node i2v-cli/bin/i2v-cli.js eval "<js>" --world isolated   # isolated world

# 健康检查（page-state aware）
node i2v-cli/bin/i2v-cli.js health              # 11 元素 selector 健康检查
node i2v-cli/bin/i2v-cli.js health --json       # 机器可读

# 调用扩展函数
node i2v-cli/bin/i2v-cli.js call findGenerateBtn         # 调 window.__i2v.<fn>
node i2v-cli/bin/i2v-cli.js call clickVideoCardByUuid <uuid>

# 模块测试（不走完整流水线）
node i2v-cli/bin/i2v-cli.js test prompt --text "..."
node i2v-cli/bin/i2v-cli.js test cache
node i2v-cli/bin/i2v-cli.js test navigate
node i2v-cli/bin/i2v-cli.js test generate
node i2v-cli/bin/i2v-cli.js test extend --uuid <uuid>
node i2v-cli/bin/i2v-cli.js test download --dry-run

# 自动 reload 扩展（改完 content.js 后用）
node i2v-cli/bin/i2v-cli.js reload

# Mock 后端（不碰 i2v-server.vercel.app）
node i2v-cli/bin/i2v-cli.js <任意命令> --mock

# 后台监控（长跑）
node i2v-cli/monitor.js                          # run_in_background:true 启动

# Node 单测（19 个）
cd i2v-cli && npm test
```

## 三个全局命名空间（都在 isolated world）

| 命名空间 | 内容 | 来源 |
|---|---|---|
| `window.__i2v` | 28 个原子函数（findGenerateBtn / processRow / extendVideo ...） | M1 |
| `window.__i2v_health` | SELECTOR_RULES + findByRules + runHealthCheck + detectPageKind | M2 |
| `window.__i2v_modules` | 7 个面向任务模块（upload/prompt/generate/extend/download/cache/navigate）+ meta | M3 |

`__i2v` 三个对象都 `Object.freeze`，不要试图扩展它们；要加新东西就追加新的 `window.__i2v_xxx` 全局。

## 调试一个 Flow 漂移 bug 的标准流程

**症状：** 用户说"扩展点不到 XX 按钮了" 或 health 报某元素 fail

```
1. node i2v-cli/bin/i2v-cli.js health
   → 看哪个 element 是 fail / fallback

2. node i2v-cli/bin/i2v-cli.js eval "<grep DOM 找新 selector>" --world isolated
   → 比如 'Array.from(document.querySelectorAll("button")).map(b=>b.textContent.slice(0,30))'
   → 找出 Flow 改成什么名字了

3. 编辑 i2v_extension/content.js 里 SELECTOR_RULES 对应的 key（约行 1219+）
   - 加新 strategy 而不是替换旧的（旧 strategy 留作 fallback）
   - 必要时加 only_on 标注

4. node i2v-cli/bin/i2v-cli.js reload
   → 自动 reload 扩展 + 刷新 Flow tab

5. node i2v-cli/bin/i2v-cli.js health
   → 验证 fix

6. git commit
```

整个循环不需要用户参与（除非要改 Chrome 启动方式或装新扩展）。

## 常见陷阱

### 1. content.js 必须只追加不修改
原代码 1153 行是生产路径，**绝对不要改 1-1153 行的任何字符**。所有新代码追加在 EOF 后面。M1/M2/M3 都遵守这条。违反 = 用户生产用户立刻挂。

### 2. main world vs isolated world
- `window.__i2v*`、`window.__i2v_health*`、`window.__i2v_modules*` 都在 **isolated world**（content script 注入的）
- `cmdEval` 默认 **main world**，要加 `--world isolated` 才能看到这些命名空间
- `cmdCall` / `cmdHealth` / `cmdContexts` 默认就是 isolated，不用加

### 3. iframe 让 main world 选错 frame
Flow 页面有同源 iframe（about:blank）。`attach()` 用 `Page.getFrameTree` 拿 top frameId 来匹配，已经修了。如果你看到 `eval "location.href"` 返回 about:blank，说明 frame 选错了——查 cdp.js attach() 的逻辑。

### 4. 不要碰 i2v-server.vercel.app
**生产后端有真实用户**。任何要测试涉及后端的代码路径，加 `--mock` flag。永远不要：
- `git revert` 已部署的 i2v-server commit
- 改 i2v-server/api/*
- 往生产 Firebase (i2v-5aed8) 写测试数据
- 用真实许可码 activate 测试设备

如果需要改后端，**新建** `i2v-server-test/` 独立 Vercel + 独立 Firebase，不动现有的。

### 5. 扩展 ID 不是写死的
`i2v-cli reload` 通过 `chrome.runtime.getManifest().name === /i2v|图生视频/i` 找扩展。换机器或路径都能工作。

### 6. React Query cache 当前抓不到
M1 demo 时发现：`getProjectDataFromCache()` 在新 Flow 返回 null（Flow 可能换了状态管理）。`window.__i2v_modules.cache.read()` 也会返回 null。这是已知问题，未修复。需要调缓存时优先用 `i2v-cli call refreshProjectCache` 看实际行为。

### 7. 失败的视频卡父元素没有 button
Flow UI 里"成功视频卡"父元素有播放按钮，"失败视频卡"和"retry-pending 卡"父元素没有。`SELECTOR_RULES.video_card_links` 已经有 fallback strategy 直接 `a[href*="/edit/"]` 来兜住所有状态。

### 8. detectPageKind 用 Extend 按钮判定 video edit 页
不要只看 history-step 或 video element——image-edit 模式的 retry-pending 卡也可能有 history-step。权威信号是页面有没有 "Extend" 按钮。

## 文件地图

```
i2v_extension/
├── content.js                 1626 行，前 1153 行是生产代码不要动
│                              1156-1206  M1 window.__i2v 导出
│                              1219-1488  M2 SELECTOR_RULES + health
│                              1491-1626  M3 window.__i2v_modules
├── background.js              SW，不要动
├── popup.js / sidepanel.html  UI，不要动
├── manifest.json              MV3，不要动
└── lib/                       M3 抽出的纯函数副本（withRetry/checkpoint/workflow-diff）
                               原版仍在 background.js / content.js 里

i2v-cli/                       Claude 的 CDP 工具箱（用户不装，只你用）
├── bin/i2v-cli.js             CLI 入口
├── lib/cdp.js                 CDP 封装 + isolated/main world 路由 + Mock
├── monitor.js                 后台守护监控
└── test/*.test.js             19 个 Node 单测

docs/plans/                    M1/M2/M3 实施计划（用过的留底）
docs/i2v-debug-workflow.md     就是本文件

i2v-server/                    生产后端，绝对不要碰
```

## 如果用户给你一个新需求

1. **先 brainstorming** —— 用 superpowers:brainstorming skill，问清楚再动
2. **写计划** —— 用 superpowers:writing-plans skill，存 `docs/plans/YYYY-MM-DD-<feature>.md`
3. **派 subagent** —— 用 superpowers:subagent-driven-development skill 执行计划
4. **每个改动都验证** —— `node --check` + `npm test` + `i2v-cli health` 一整套

如果改动牵涉 content.js，**只能在 EOF 后追加**。如果牵涉 background.js / manifest.json，**先和用户确认**。

## 当你怀疑 Flow 改版了

跑这个三连：
```bash
node i2v-cli/bin/i2v-cli.js health                   # 看哪些 fail/fallback
node i2v-cli/bin/i2v-cli.js eval "location.pathname" --world isolated   # 当前页类型
node i2v-cli/bin/i2v-cli.js eval "Array.from(document.querySelectorAll('button')).map(b=>b.textContent.trim().slice(0,30))" --world isolated   # 列出所有按钮
```

通常 5 分钟能定位漂移在哪、改成什么了。

## 当你需要长跑监控

```bash
# 启动（注意必须 run_in_background: true）
node i2v-cli/monitor.js
# 它会写 i2v-cli/monitor-state.json 持久化最新快照
# stdout 持续输出 EVENT/HEALTH/DRIFT 行
# 用 BashOutput / tail 查看进度
# 用 TaskStop 停止
```

监控会自动捕捉：card 数量变化、新/消失的 uuid、Failed 标签、navigate、generate 按钮 enable/disable、sonner toast、health 漂移。

## 调试历史 (rev-list 顺序)

- M1 (5 commits)：CDP 通路，让 Claude 能"看见"和"操作" Flow
- M2 (4 commits + 4 demo 修复)：选择器数据化 + health check + page-state 感知
- M3 (4 commits)：模块命名空间 + lib 纯函数 + 19 个 Node 单测 + Mock 模式 + reload/test 子命令

完整 commit 列表见 `git log --oneline`。

---

**最后一条原则：永远不要在没看过页面状态的情况下乱改选择器。** 用 i2v-cli eval 看看真实 DOM 长什么样，再动手。这就是这套工具存在的全部意义。
