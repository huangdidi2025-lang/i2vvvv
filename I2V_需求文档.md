# I2V 图生视频工具 — 完整需求文档

> 文档版本: 1.0 | 整理日期: 2026-04-02

---

## 一、项目总览

### 1.1 项目背景

"视频工具" 是一套三工具视频生产流水线，用于将产品图片通过 AI 自动生成营销短视频。整套系统围绕 Google Flow (Veo) 视频生成平台构建，分为三个工具：

| 工具 | 功能 | 状态 |
|------|------|------|
| 工具A (`app_tool_a.py`) | 视频分析：视频 → 逐帧截图 → Gemini 分析 → 分镜图 + 8字段提示词 → data.xlsx | 已完成 |
| 工具B (`app_tool_b.py` + `chrome_extension/`) | 视频生成：读取 data.xlsx → Chrome 插件操作 Google Flow → 批量生成视频 → 下载 | 已完成，待测试 |
| **I2V 图生视频** (`i2v_extension/` + `i2v-server/`) | **独立图生视频**：用户上传产品图 → AI 生成提示词 → Chrome 插件操作 Flow → 批量生成+延伸视频 | **开发中** |

**I2V 图生视频** 是从工具B演化出的独立产品，目标是将"产品图片 → 成品视频"的全流程封装为一个 Chrome 扩展 + 云端后端的独立工具，面向终端用户分发。

### 1.2 核心价值

- 用户只需上传产品图片 + 输入简单描述，AI 自动生成专业视频提示词
- 自动操作 Google Flow 页面，无需用户手动操作复杂的视频生成界面
- 支持视频延伸（两段拼接），生成更长的成品视频
- 许可码授权系统，支持商业分发

---

## 二、系统架构

### 2.1 整体架构

```
用户操作                Chrome 扩展                      云端服务
┌──────────┐      ┌─────────────────────┐      ┌──────────────────────┐
│ 上传产品图 │──→  │  sidepanel.html      │      │  Vercel Serverless   │
│ 输入描述   │      │  (popup.js UI 逻辑)  │──→  │  api/index.js        │
│ 点击生成   │      │                     │      │  ├ POST /api/activate │
└──────────┘      │  background.js       │      │  ├ POST /api/verify   │
                  │  (SW: 批处理编排)     │      │  ├ POST /api/generate │
                  │                     │      │  ├ POST /api/sync-row  │
                  │  content.js          │      │  └ 管理接口           │
                  │  (注入 Flow 页面      │      └──────────┬───────────┘
                  │   DOM 自动化)        │                 │
                  └──────────┬──────────┘                 │
                             │                            ▼
                             ▼                   ┌──────────────────┐
                  ┌─────────────────────┐        │ Firebase Firestore│
                  │ Google Flow 页面     │        │ (i2v-5aed8)      │
                  │ labs.google/fx/...   │        │ ├ licenses/      │
                  │                     │        │ ├ users/          │
                  │ Veo 视频生成引擎     │        │ └ users/rows/    │
                  └─────────────────────┘        └──────────────────┘
```

### 2.2 组件清单

| 组件 | 目录 | 技术栈 | 部署位置 |
|------|------|--------|---------|
| Chrome 扩展 | `i2v_extension/` | Chrome MV3, Vanilla JS | 本地安装 |
| 云端 API | `i2v-server/` | Node.js (Vercel Serverless) | Vercel |
| 数据库 | — | Firebase Firestore | Google Cloud (asia-southeast1) |
| AI 提示词 | — | MiniMax API (M2.7-highspeed) | 第三方 API |
| 视频生成 | — | Google Flow (Veo 3.1) | Google 平台 |

### 2.3 废弃方案（仅供参考）

`i2v_app/` 目录是早期的 Playwright + FastAPI 桌面应用方案，因 Playwright 跨线程限制和部署复杂度问题已废弃，改为纯 Chrome 扩展方案。

---

## 三、功能需求

### 3.1 许可码系统

**目标**：控制工具分发，支持按设备激活。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| L-01 | 用户输入许可码激活扩展，激活后显示主界面 | P0 |
| L-02 | 每个许可码绑定唯一设备ID（device_id），首次激活时绑定 | P0 |
| L-03 | 设备ID 使用 `crypto.randomUUID()` 自动生成，存储在 `chrome.storage.local` | P0 |
| L-04 | 扩展启动时自动验证许可有效性（调 `/api/verify`） | P1 |
| L-05 | 离线时保持上次验证状态，不阻塞使用 | P1 |
| L-06 | 管理员可通过管理后台创建/吊销许可码 | P1 |
| L-07 | 退出登录清除许可码和本地数据 | P2 |

**API 接口**：
- `POST /api/activate` — 激活许可码（code + device_id）
- `POST /api/verify` — 验证许可码有效性
- `POST /api/revoke` — 吊销许可码（管理员）
- `POST /api/admin/create-license` — 创建新许可码（管理员）

---

### 3.2 提示词生成

**目标**：用户上传产品图 + 简单描述，AI 自动生成结构化视频提示词。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| P-01 | 支持批量上传产品图片（拖拽 + 点击选择） | P0 |
| P-02 | 上传后显示图片预览缩略图，支持单张删除 | P0 |
| P-03 | 用户输入自然语言描述（如"创建一个吸引人的产品展示视频"） | P0 |
| P-04 | 调用 MiniMax API 为每张图生成 3 个创意方向 | P0 |
| P-05 | 每个方向包含两段提示词（segment_1 + segment_2），每段含 9 个字段 | P0 |
| P-06 | 提示词字段：Subject, Context, Action, Style, Camera, Composition, Ambiance, Audio, Last Frame | P0 |
| P-07 | 生成进度实时显示（x/total） | P1 |
| P-08 | 生成结果存入 `chrome.storage.local`（key: `i2v_rows`） | P0 |
| P-09 | 支持单行重新生成提示词 | P1 |
| P-10 | 收藏提示词功能（存储常用描述，点击快速填入） | P2 |

**提示词结构**：
```
segment_1: "Subject: ... | Context: ... | Action: ... | Style: ... | Camera: ... | Composition: ... | Ambiance: ... | Audio: ... | Last Frame: ..."
segment_2: "Subject: ... | Context: ... | ..."  (延伸段)
segment_1_zh: 中文翻译
segment_2_zh: 中文翻译
```

---

### 3.3 批量视频生成（Phase 1）

**目标**：自动操作 Google Flow 页面，批量提交图片+提示词生成视频。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| B-01 | 查找已打开的 Google Flow 项目标签页 | P0 |
| B-02 | 自动注入 content.js（`ensureContentScript`） | P0 |
| B-03 | 每行执行：点"+"按钮 → 上传图片 → 注入提示词 → 点生成 | P0 |
| B-04 | 图片通过 DataTransfer API 注入隐藏的 `<input type="file">` | P0 |
| B-05 | 提示词通过 `beforeinput` InputEvent 注入 Lexical React 编辑器 | P0 |
| B-06 | 等待生成按钮变为可用（图片上传完成），最长等 2 分钟 | P0 |
| B-07 | 提交后等待新视频卡出现，提取 UUID 绑定到行数据 | P0 |
| B-08 | 已有视频卡的 UUID 预收集，用 Set 排除以识别"新卡" | P1 |
| B-09 | 视频卡 vs 参考图卡区分：父元素有 `<button>`（播放按钮）或 `<video>` 标签 | P0 |
| B-10 | 行间随机等待 5-15 秒（防封） | P1 |
| B-11 | 每批最多 10 行（`BATCH_SIZE = 10`） | P1 |
| B-12 | 失败行最多重试 2 轮（`MAX_RETRY_ROUNDS = 2`） | P1 |
| B-13 | 支持中途停止（`stopRequested` 标志） | P0 |

**DOM 操作关键选择器**：
| 元素 | 选择器/查找方式 |
|------|----------------|
| "+" 按钮 | `button[aria-haspopup="dialog"]` |
| Upload image | 对话框内文本包含 'upload image' |
| 文件输入 | `input[type="file"][accept="image/*"]` |
| 文本框 | `[role="textbox"]`（排除 aria-label='Editable text'） |
| 生成按钮 | 文本含 'arrow_forward' 且未 disabled |
| Ingredient 取消 | 文本 = 'cancel' |

---

### 3.4 视频延伸（Phase 2）

**目标**：对 Phase 1 生成的视频执行 Extend 操作，拼接第二段提示词生成更长视频。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| E-01 | 从项目页导航到视频的 edit 页（通过 UUID 点击卡片链接） | P0 |
| E-02 | 检查视频是否已延伸（历史缩略图条 video 子元素 >= 2） | P0 |
| E-03 | 确保模型选择为 "Veo 3.1 - Fast"（排除 Lower Priority） | P1 |
| E-04 | 输入 segment_2 提示词到延伸输入框 | P0 |
| E-05 | 点击 Extend 按钮 → 等待生成按钮可用 → 点击生成 | P0 |
| E-06 | 等待延伸完成（历史条出现第 2 个 video 子元素），最长 5 分钟 | P0 |
| E-07 | 延伸完成后点击 Done 按钮 | P1 |
| E-08 | 导航回项目页继续处理下一行 | P0 |
| E-09 | 未完成的行定时重试（30 秒间隔轮询） | P1 |
| E-10 | 全局超时保护（每行 8 分钟，最少 1 小时） | P1 |

**延伸检测逻辑**：
```
历史缩略图条 [class*="sc-b48c2ff4-2"]
├── video (第1段) → count=1 → 未延伸
├── video (第1段) + video (第2段) → count=2 → 已延伸
└── video (第1段) + div (加载中) → count=1 video → 正在生成
```

---

### 3.5 Service Worker 保活与恢复

**目标**：Chrome MV3 Service Worker 可能被随时杀掉，需要保活和断点恢复。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| S-01 | 使用 `chrome.alarms` 每 24 秒触发一次保活 | P0 |
| S-02 | 批处理状态持久化到 `chrome.storage.local`（checkpoint） | P0 |
| S-03 | 保活回调检测中断批次，自动恢复执行 | P1 |
| S-04 | checkpoint 包含：running、phase、rows、doneCount、errorCount、successRows | P0 |
| S-05 | 批处理完成后清除 checkpoint | P0 |
| S-06 | `force_reset` 消息强制清除卡死状态 | P1 |

---

### 3.6 UI 界面

**目标**：Chrome 扩展侧边栏（SidePanel）提供全中文操作界面。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| U-01 | 激活页：许可码输入框 + 激活按钮 + 状态提示 | P0 |
| U-02 | 三标签页切换：提示词生成 / 任务列表 / 批量处理 | P0 |
| U-03 | 提示词生成标签：拖拽上传区 + 描述输入框 + 批量生成按钮 + 一键生成按钮 | P0 |
| U-04 | 任务列表标签：表格显示（序号/缩略图/提示词/描述/状态/操作） | P0 |
| U-05 | 提示词悬浮预览（tooltip 显示完整 segment_1 和 segment_2） | P1 |
| U-06 | 批量处理标签：统计面板（总数/完成/待处理/错误）+ 进度条 + 日志 | P0 |
| U-07 | 实时日志区域，颜色区分（红=错误，绿=成功，蓝=信息） | P1 |
| U-08 | 暗色主题，主色调 #2f9cf5 | P2 |
| U-09 | 收藏提示词芯片（快速调用常用描述） | P2 |
| U-10 | 一键生成：自动串联"提示词生成 → 切换到批量处理 → 启动" | P1 |

---

### 3.7 数据同步

**目标**：本地操作数据同步到云端 Firebase，支持管理员远程查看。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| D-01 | 行数据同步到 Firestore：`users/{device_id}/rows/row_{n}` | P1 |
| D-02 | 操作日志同步：`users/{device_id}/logs/{timestamp}` | P2 |
| D-03 | 同步操作静默执行，失败不阻塞主流程 | P0 |
| D-04 | 管理员通过 `/api/admin/users` 查看所有用户数据 | P2 |

---

### 3.8 视频下载

**目标**：批量下载已生成的视频。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| DL-01 | 使用 `chrome.downloads.download()` 下载视频（绕过浏览器安全限制） | P0 |
| DL-02 | 从 edit 页提取 `<video src="...">` 获取视频 URL | P0 |
| DL-03 | 第一个文件弹出保存对话框（`saveAs: true`），后续自动保存到同目录 | P1 |
| DL-04 | 下载后同步状态到云端 | P2 |

---

### 3.9 重新生成

**目标**：支持对失败或不满意的视频重新生成。

| 需求编号 | 需求描述 | 优先级 |
|---------|---------|--------|
| R-01 | 任务列表中每行有"重新生成"按钮，可重新调 AI 生成提示词 | P1 |
| R-02 | Flow 项目页视频卡上注入"重新生成"浮动按钮 | P1 |
| R-03 | 重新生成重置行状态（清除 UUID、视频路径、错误信息） | P1 |
| R-04 | 重新生成按钮点击后显示"已加入队列"反馈，1.5 秒后消失 | P2 |

---

## 四、非功能需求

### 4.1 防封策略

| 需求编号 | 需求描述 |
|---------|---------|
| NF-01 | 行间随机等待 5-15 秒 |
| NF-02 | 批次间等待 |
| NF-03 | 操作模拟真实用户行为（click、focus、beforeinput） |
| NF-04 | 单批最多 10 行，避免短时间大量请求 |

### 4.2 错误处理与重试

| 需求编号 | 需求描述 |
|---------|---------|
| NF-05 | `sendToContent` 超时 60 秒（process_row 180 秒） |
| NF-06 | 瞬态错误自动重试 3 次（超时、找不到元素、连接失败） |
| NF-07 | 重试间隔递增：3s → 8s → 15s |
| NF-08 | 重试前重新注入 content.js |
| NF-09 | Phase 1 失败行整批重试最多 2 轮 |
| NF-10 | 批处理异常 finally 必须重置 `state.running = false` |

### 4.3 性能约束

| 需求编号 | 需求描述 |
|---------|---------|
| NF-11 | Vercel Hobby 版函数超时 10 秒（需注意大图片的 MiniMax API 调用可能超时） |
| NF-12 | 图片以 data URL (base64) 在 chrome.storage 中存储，需注意存储容量 |
| NF-13 | 日志保留最近 200 条，广播最近 50 条 |

---

## 五、已知 Bug 与技术债

### 5.1 已解决的关键问题

| # | 问题 | 根因 | 解决方案 |
|---|------|------|---------|
| 1 | 提示词注入后 React 状态不更新 | Lexical 编辑器不响应 `execCommand('insertText')` | 使用 `beforeinput` InputEvent |
| 2 | 视频卡与参考图卡混淆 | 两者都有 `a[href*="/edit/"]` | 父元素检查 button/video 子元素 |
| 3 | content.js 未注入 | SPA 页面扩展刷新后不自动注入 | `ensureContentScript()` ping+强制注入 |
| 4 | 下载被静默拦截 | content.js click 缺少 user gesture trust | background.js 用 `chrome.downloads.download()` |
| 5 | React Router 导航失效 | `location.href` 不触发 SPA 路由 | 找 `<a>` 元素调用 `.click()` |
| 6 | batch running 卡死不恢复 | `runImg2VideoBatched` 无 await，异常不捕获 | 外层 try/catch/finally |
| 7 | checkVideoExtended 误判 | 占位 div 也被计入 | 只统计含 `<video>` 的子元素 |

### 5.2 当前待解决问题（截至 2026-04-02）

| # | 问题 | 状态 | 描述 |
|---|------|------|------|
| 1 | 批处理"没反应" | 调试中 | 点"开始生成"后日志只显示标题行，phase 停留在 idle |
| 2 | SW 可能被杀 | 待验证 | `handleStartI2V` 中 `runImg2VideoBatched()` 没有 await，SW 可能在执行前被回收 |
| 3 | imageBlobUrl 可能为空 | 待验证 | popup.js 将 `image_base64` 赋给 `imageBlobUrl`，但 image_base64 本身可能为空或过大 |
| 4 | Vercel 超时 | 已知限制 | Hobby 版最大 10 秒，大图片 MiniMax 调用可能超时 |
| 5 | Google Flow IP 封禁 | 已遇到 | 频繁自动操作后返回 403，需换 IP |

---

## 六、文件清单与职责

### 6.1 Chrome 扩展 (`i2v_extension/`)

| 文件 | 职责 |
|------|------|
| `manifest.json` | MV3 扩展声明：权限（storage/activeTab/scripting/tabs/alarms/sidePanel/downloads）、host_permissions（labs.google/*） |
| `background.js` | Service Worker：许可验证、批处理编排（Phase1+Phase2）、下载管理、检查点持久化、保活、状态广播 |
| `content.js` | 注入 Flow 页面：DOM 查找、图片上传、提示词注入、视频卡收集、延伸操作、模型选择、重新生成按钮注入 |
| `sidepanel.html` | 侧边栏 UI 骨架（三标签页 + 激活页） |
| `popup.js` | UI 逻辑：图片上传处理、提示词生成、任务列表渲染、批量处理控制、收藏管理 |
| `styles.css` | 暗色主题样式 |
| `popup.html` | 弹窗版 UI（备用） |
| `test.html` | 独立测试面板（硬编码 API + 许可码） |
| `admin/index.html` | 管理后台（许可管理、用户查看） |

### 6.2 云端服务 (`i2v-server/`)

| 文件 | 职责 |
|------|------|
| `api/index.js` | Vercel Serverless 函数：许可激活/验证、MiniMax 提示词生成代理、Firebase 数据同步、管理接口 |
| `vercel.json` | 路由重写（`/api/*` → `api/index`）、函数超时配置（60s） |
| `package.json` | 依赖：firebase-admin ^12.0.0 |

### 6.3 废弃的桌面版 (`i2v_app/`，仅参考)

| 文件 | 原职责 |
|------|--------|
| `main.py` | Playwright 浏览器 + FastAPI 服务器启动 |
| `server.py` | REST API（图片上传/提示词生成/批处理/日志流） |
| `flow_automation.py` | Playwright DOM 自动化 |
| `prompt_generator.py` | MiniMax API 封装 |
| `cloud_sync.py` | Firebase 非阻塞同步 |
| `models.py` / `spreadsheet.py` | 数据模型 / Excel 操作 |

---

## 七、部署与配置

### 7.1 环境变量（Vercel）

| 变量名 | 说明 | 当前值 |
|--------|------|--------|
| `FIREBASE_PROJECT_ID` | Firebase 项目 ID | i2v-5aed8 |
| `FIREBASE_CLIENT_EMAIL` | 服务账号邮箱 | firebase-adminsdk-fbsvc@i2v-5aed8.iam.gserviceaccount.com |
| `FIREBASE_PRIVATE_KEY` | 服务账号私钥 | (已设置) |
| `MINIMAX_API_KEY` | MiniMax API 密钥 | (已设置) |
| `MINIMAX_BASE_URL` | MiniMax API 地址 | https://aitokenhub.xyz/v1 |
| `MINIMAX_MODEL` | 使用的模型 | MiniMax-M2.7-highspeed |
| `ADMIN_KEY` | 管理员密钥 | (已设置) |

### 7.2 启动流程

```
1. Vercel 部署：i2v-server/ → https://i2v-server.vercel.app
2. Chrome 安装扩展：chrome://extensions → 加载 i2v_extension/ 目录
3. 用户打开 Google Flow 项目页面
4. 点击扩展图标 → 侧边栏打开 → 输入许可码激活
5. 上传产品图 → 输入描述 → 生成提示词 → 开始批量处理
```

---

## 八、数据流

```
用户上传图片 (base64)
    │
    ▼
popup.js → 存入 uploadedImages[]
    │
    ▼ 点击"批量生成提示词"
    │
popup.js → background.js (generate_prompts)
    │       → Vercel /api/generate
    │         → MiniMax API (视觉模型分析图片)
    │         → 返回 3 个创意方向 (segment_1 + segment_2)
    │
    ▼ 用户选择 / 自动取第一个方向
    │
popup.js → background.js (save_rows)
    │       → chrome.storage.local (i2v_rows)
    │
    ▼ 点击"开始生成"
    │
popup.js → background.js (start_i2v)
    │       → handleStartI2V() → runImg2VideoBatched()
    │
    ├── Phase 1 (runPhase1Batch)
    │   └── 每行: background → content.js (process_row)
    │       ├── 上传图片 (DataTransfer → file input)
    │       ├── 注入提示词 (beforeinput → Lexical)
    │       ├── 点击生成按钮
    │       └── 等待新卡片 → 记录 UUID
    │
    ├── Phase 2 (runPhase2Extend)
    │   └── 每行:
    │       ├── 导航到 edit 页 (click_video_card_by_uuid)
    │       ├── 检查是否已延伸 (check_video_extended)
    │       ├── 选择模型 (ensure_model → Veo 3.1 - Fast)
    │       ├── 输入 segment_2 (beforeinput)
    │       ├── 点 Extend → 点生成
    │       ├── 等待延伸完成 (轮询 video 子元素数)
    │       └── 点 Done → 导航回项目页
    │
    └── 完成 → state.running = false, clearCheckpoint()
```

---

## 九、测试清单

### 9.1 提示词生成

- [ ] 上传 1 张图 → 成功返回 3 个方向的 segment_1 + segment_2
- [ ] 上传 5 张图 → 逐张处理，进度正确更新
- [ ] 无图/无描述时按钮禁用
- [ ] MiniMax API 超时时显示错误信息

### 9.2 批量处理 Phase 1

- [ ] 扩展刷新后 content.js 能成功注入
- [ ] 图片上传成功（ingredient cancel 按钮出现）
- [ ] 提示词注入成功（文本框非空）
- [ ] 生成按钮点击后新视频卡出现，UUID 正确绑定
- [ ] 停止功能正常工作

### 9.3 批量处理 Phase 2

- [ ] 从项目页成功导航到 edit 页
- [ ] 模型自动切换到 Veo 3.1 - Fast
- [ ] segment_2 提示词成功注入
- [ ] Extend 按钮点击后历史条出现第 2 个元素
- [ ] 延伸完成后 Done 按钮成功点击
- [ ] 成功导航回项目页

### 9.4 断点恢复

- [ ] SW 被杀后通过 alarm 恢复
- [ ] checkpoint 数据正确保存和读取
- [ ] force_reset 成功清除卡死状态

### 9.5 端到端

- [ ] 完整流程：上传 3 张图 → 生成提示词 → Phase1 提交 → Phase2 延伸 → 下载视频
- [ ] 部分失败行正确标记，不影响其他行

---

## 十、后续规划

| 优先级 | 事项 |
|--------|------|
| 紧急 | 修复批处理"没反应"的 bug（SW 生命周期 / imageBlobUrl 问题） |
| 高 | 解决 Vercel Hobby 10 秒超时（升级 Pro 或改用其他部署方案） |
| 高 | 防封策略完善（IP 轮换、请求频率自适应） |
| 中 | 视频下载功能测试 |
| 中 | 批量下载去水印功能 |
| 低 | 管理后台完善（用量统计、许可管理优化） |
| 低 | 多语言支持 |
