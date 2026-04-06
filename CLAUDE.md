# I2V 图生视频 — 开发上下文

## 项目概述

I2V（Image-to-Video）是一套产品图自动生成营销短视频的独立工具，基于 Google Flow (Veo) 视频生成平台，由 **Chrome 扩展 + Vercel 后端 + Firebase 数据库** 构成，面向终端用户分发。

核心流程：
```
用户上传产品图 + 描述 → AI 生成结构化提示词 (segment_1 + segment_2)
  → Chrome 扩展自动操作 Flow 页面 → 批量生成视频 → 延伸视频 → 下载
```

## 组件清单

| 目录 | 职责 | 部署位置 |
|------|------|---------|
| `i2v_extension/` | Chrome MV3 扩展 — UI + DOM 自动化 | 本地安装 |
| `i2v-server/` | Vercel Serverless — 许可/提示词/数据同步 | Vercel (https://i2v-server.vercel.app) |
| `i2v-admin/` | 管理后台 — 许可管理 + 用户查看 | Vercel |
| (Firebase) | 数据库 i2v-5aed8 | Google Cloud asia-southeast1 |
| (MiniMax API) | 提示词生成 | 第三方 |

**注：** 废弃的桌面版（Playwright + FastAPI）已不再使用，不包含在本项目中。

## Chrome 扩展架构

```
i2v_extension/
├── manifest.json            MV3，权限: storage/scripting/tabs/alarms/sidePanel/downloads
│                            host_permissions: https://labs.google/*
├── background.js            Service Worker：许可验证 + 批处理编排 + 保活 + 检查点
├── content.js               注入 Flow 页面：DOM 查找 + 图片上传 + 提示词注入 + 延伸
├── sidepanel.html           侧边栏 UI 骨架
├── popup.js                 UI 逻辑：上传/生成/任务列表/批处理控制
├── styles.css               暗色主题 #2f9cf5
├── popup.html               弹窗 UI（备用）
├── test.html                独立测试面板（硬编码 API）
├── admin/                   管理后台前端
└── icons/
```

## 核心技术点（必须记住的坑）

### 1. 提示词注入 Lexical React 编辑器
`execCommand('insertText')` 只改 DOM 不改 React 状态。**必须用** `beforeinput` InputEvent：
```js
textbox.dispatchEvent(new InputEvent("beforeinput", {
  inputType: "insertText", data: prompt, bubbles: true, cancelable: true,
}));
```

### 2. React Router SPA 导航
`window.location.href = url` 不触发 React Router 路由切换。
**解决：** 找到 `<a href*="/edit/">` 调用 `link.click()`。

### 3. 视频卡 vs 参考图卡
两者都有 `a[href*="/edit/"]`。
**区分：** 视频卡父元素含内嵌 `<button>`（播放按钮），参考图卡没有：
```js
Array.from(document.querySelectorAll('a[href*="/edit/"]'))
  .filter(a => a.parentElement?.querySelectorAll('button').length > 0)
```

### 4. content.js 未注入
Flow SPA 页面扩展安装前打开就不会自动注入。
**解决：** `ensureContentScript()` 先 ping，失败则 `chrome.scripting.executeScript` 强制注入。

### 5. 下载被静默拦截
content.js 的 `btn.click()` 缺 user gesture trust。
**解决：** content.js `getVideoUrl()` 返回 `<video src>` 的 URL，background.js 调 `chrome.downloads.download()`。

### 6. 延伸状态检测
从 React Query 缓存读 `projectInitialData`，判断 workflow 下是否有 `videoInputIds` 非空的 media。
DOM 降级：`[id^="history-step-"]` 数量 ≥ 2 = 已延伸。

### 7. Radix UI 菜单点击
Radix 监听 `pointerdown` 而非 `click`。单纯 `el.click()` 打不开菜单。
**解决：** `simulateClick()` 发完整事件序列（pointerdown + mousedown + pointerup + mouseup + click）。

## 两阶段批处理流程

**Phase 1**（`runPhase1Batch`）：
- 每行：打开对话框 → 上传图片（DataTransfer）→ 输提示词（beforeinput）→ 等生成按钮可用 → 点生成
- 提交后刷新 React Query 缓存对比差异，提取新 workflowId
- 行间随机等 5-15 秒（防封）
- 每批最多 10 行（`BATCH_SIZE = 10`），整批失败最多重试 2 轮

**Phase 2**（`runPhase2Extend`）：
- **阶段 A：** 逐个点进 edit 页，选模型 Veo 3.1 - Fast → 输 segment_2 → 点 Extend → 点生成 → 返回项目页
- **阶段 B：** 在项目页用图标轮询（`videocam` + `stacks` = 已延伸），30 秒间隔，最长 5 分钟/行
- 未延伸超时 → 重新提交延伸，最多 3 次

## Service Worker 保活

- `chrome.alarms` 每 0.4 分钟（24 秒）触发 keepalive
- 批处理状态持久化到 `chrome.storage.local` (`checkpoint`)
- SW 被杀后下次 alarm 触发自动 `resumeFromCheckpoint`
- Checkpoint 只存轻量数据（不含 `image_base64`）

## API 端点 (Vercel)

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/activate` | 激活许可码 |
| POST | `/api/verify` | 验证许可 |
| POST | `/api/generate` | MiniMax 代理 — 生成提示词 |
| POST | `/api/sync-row` | 同步单行数据 |
| POST | `/api/save-rows` | 批量保存 |
| GET  | `/api/get-rows` | 读取行数据 |
| POST | `/api/log` | 操作日志 |
| POST | `/api/admin/create-license` | 管理员创建许可 |
| POST | `/api/admin/users` | 管理员查看用户 |

## Firebase 数据结构

```
licenses/{code}            → { code, active, bound_device_id, created_at }
users/{device_id}          → { device_id, license_code, last_active, app_version }
users/{device_id}/rows/row_{n}   → { row_n, segment_1, segment_2, status, generated_video, ... }
users/{device_id}/logs/{id}      → { action, detail, time }
```

## 数据模型 (chrome.storage.local)

```js
i2v_rows: [
  {
    row_n,                  // 行号
    segment_1, segment_1_zh,// 第1段提示词 (英文 + 中文)
    segment_2, segment_2_zh,// 第2段（延伸）
    user_prompt,            // 用户原始描述
    image_base64,           // 产品图 base64
    image_name,
    status,                 // pending/processing/submitted/extending/done/error
    generated_video,        // 视频 URL
    error_msg,
    _uuid,                  // workflowId（Flow 内部 ID）
  }
]
i2v_images: { [row_n]: { image_base64, image_name } }  // 图片单独存储避免传输截断
checkpoint: { ... }          // 批处理检查点
fav_prompts: [string]        // 收藏的提示词
license_code, device_id      // 许可信息
```

## 关键 DOM 选择器

| 元素 | 选择器 |
|------|-------|
| 打开上传对话框 | `button[aria-haspopup="dialog"]` |
| Upload image 按钮 | 对话框内文本 == 'upload image' |
| 文件输入 | `input[type="file"][accept="image/*"]` |
| 提示词输入框 | `[role="textbox"]`（排除 `aria-label="Editable text"`） |
| 生成按钮 | 文本含 `arrow_forward` 且未 disabled |
| Ingredient 取消 | 文本 == `cancel` |
| Extend 按钮 | 文本含 `extend` |
| 视频卡图标 | `videocam` / `play_circle` / `stacks`（已延伸）|
| 模型选择器 | 含 `Veo` 文字 + `arrow_drop_down` |

**⚠️ Flow UI 经常变，这些选择器会失效，需要时常维护。**

## Vercel 环境变量

| 变量 | 值 |
|------|---|
| `FIREBASE_PROJECT_ID` | i2v-5aed8 |
| `FIREBASE_CLIENT_EMAIL` | firebase-adminsdk-fbsvc@i2v-5aed8.iam.gserviceaccount.com |
| `FIREBASE_PRIVATE_KEY` | (已设置) |
| `MINIMAX_API_KEY` / `GEMINI_API_KEY` | (已设置) |
| `MINIMAX_BASE_URL` | https://aitokenhub.xyz/v1 |
| `MINIMAX_MODEL` | MiniMax-M2.7-highspeed |
| `ADMIN_KEY` | (已设置) |

**注：** 当前生产代码实际用的是 Gemini API（`GEMINI_API_KEY` + `gemini-2.5-flash`），`i2v-server/api/index.js` 里 MiniMax 相关代码已被替换。

## 当前版本 & 状态

- **扩展版本：** v1.0.3（release/i2v-图生视频-v1.0.3.zip）
- **manifest.json：** version 1.0.0（内部版本号未同步）
- **线上 Vercel：** 2026-04-02 的稳定部署

## 已知待解决问题

1. **批处理"没反应"** — 点"开始生成"后日志只显示标题行，phase 停留在 idle（怀疑是 SW 生命周期或 imageBlobUrl 问题）
2. **Vercel Hobby 10 秒超时** — 大图片 AI 调用可能超时
3. **Google Flow IP 封禁** — 频繁自动操作后返回 403
4. **Flow UI 经常变动** — 选择器需要持续维护
5. **批处理运行时 SW 被杀** — 恢复机制需要验证

## 启动流程

```
1. Vercel 已部署 → https://i2v-server.vercel.app
2. Chrome → chrome://extensions/ → 开启开发者模式 → 加载 i2v_extension/
3. 打开 Google Flow 项目页面
4. 点扩展图标 → 侧边栏 → 输入许可码激活
5. 上传产品图 → 输入描述 → 生成提示词 → 开始批量处理
```

## 测试许可码

`I2V-28FB-C5DB`（见 i2v_extension/release/安装使用说明.md）

## 下一步

详见 `I2V_需求文档.md`（完整需求规格）和 `.claude-context/`（历史开发决策与会话记录）。
