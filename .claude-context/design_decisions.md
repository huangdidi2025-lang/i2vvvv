# 关键技术决策

## 1. 为什么选 Chrome 扩展而不是桌面应用？

**早期方案**：`i2v_app/`（Playwright + FastAPI + 自带 Chromium）
**废弃原因**：
- Playwright 跨线程限制（FastAPI 异步 + Playwright 同步 API 难协调）
- 打包分发复杂（要带 Chromium 运行时，体积 200MB+）
- 用户需要登录两次（系统 Chrome + Playwright 的 Chromium）

**现方案**：Chrome 扩展 MV3
- 用户在自己的 Chrome 里登录 Google 一次即可
- 扩展体积小（< 500KB）
- 用 `chrome.scripting.executeScript` 注入 content.js 自动化 DOM

## 2. 为什么用 Service Worker + chrome.alarms 保活？

MV3 Service Worker 不能常驻，Chrome 会在空闲 30 秒后杀掉。
**保活方案**：`chrome.alarms` 周期最小 0.4 分钟（24 秒），每次触发时 SW 被唤醒。
**检查点恢复**：批处理状态持久化到 `chrome.storage.local.checkpoint`，SW 被杀后下次 alarm 触发时检查 checkpoint，自动继续。

## 3. 为什么提示词用 `beforeinput` InputEvent？

Flow 的输入框是 **Lexical**（Facebook 的 React 编辑器）。
- `execCommand('insertText')` 只修改 DOM，Lexical 内部状态不更新 → 点生成时读到空字符串
- `textContent = "..."` 同理
- 直接设置 React 组件 props 需要穿透 fiber，极不稳定

**Lexical 的数据流**：监听 `beforeinput` → 更新 Editor State → 触发 onChange → 更新 DOM。
所以发 `beforeinput` InputEvent 是唯一能触发 React 状态更新的方式。

## 4. 为什么下载视频走 background.js 而不是 content.js？

content.js 里的 `btn.click()` 触发的 download 会被 Chrome 判定为"非用户手势"（user gesture trust 链断了），静默拦截。
background.js 用 `chrome.downloads.download({url})` 是扩展特权 API，不需要 user gesture。

**流程**：
1. content.js 找到 `<video src="https://...">` 提取 URL
2. 返回给 background.js
3. background.js 调 `chrome.downloads.download()` 直接下载

## 5. 为什么视频卡和参考图卡区分要看父元素？

Flow 的 DOM 结构里两种卡都是 `a[href*="/edit/"]`，单看链接无法区分。
观察发现：
- 视频卡：父 div 有内嵌 `<button>`（播放按钮）
- 参考图卡：父 div 没有内嵌 button
```js
a.parentElement?.querySelectorAll('button').length > 0
```

## 6. 为什么从缓存读 workflowId 而不是直接轮询 DOM？

Flow 是 SPA，新卡片出现有延迟（后端处理 + 前端渲染）。
DOM 轮询：需要 3-5 次 × 3 秒 = 10+ 秒，且图片卡可能抢先出现干扰
**缓存方案**：直接调用 Flow 内部的 React Query `projectInitialData`，刷新后对比 before/after 的 workflow ID 集合，秒级拿到新 workflowId。

**找 QueryClient**：从 `#__next` 根节点走 React fiber 树，找 `pendingProps.client.getQueryCache` 或 `memoizedProps.client.getQueryCache`。

## 7. 为什么 Radix 菜单要用 simulateClick 而不是 el.click()？

Radix UI DropdownMenu 监听 `pointerdown` 而非 `click`。
`el.click()` 只派发 `click` 事件，菜单不会打开。
**simulateClick 发送事件序列**：
```
pointerdown → mousedown → pointerup → mouseup → click
```

## 8. 提示词的 8 字段架构（Subject|Context|Action|Style|Camera|Composition|Ambiance|Audio）

参考 Veo 3 官方最佳实践 + 社区验证：
- **Subject**：人 + 产品
- **Context**：真实使用场景（洗浴用品→浴室，健身器材→家庭健身房）
- **Action**：含对话，**禁止直接使用引号**（会触发字幕生成）
- **Camera**：**必须** 使用 `(thats where the camera is)` 语法触发 Veo 3 的镜头感知
- **Audio**：**必须** 指定背景音（否则 AI 会幻觉出诡异音效）

分段策略：**segment_1 的最后一帧必须是 segment_2 的首帧**，用于无缝延伸拼接。

## 9. Firebase 数据存储策略

**原则**：服务器只存"轻量数据"（提示词、状态、元数据），**不存图片 base64**（太大、Firebase 配额贵）。
- `image_base64` 只在扩展本地 `chrome.storage.local.i2v_images` 保存
- 同步到 Firebase 时 `save_rows` / `sync-row` 会 `destructure image_base64, imageBlobUrl, ...rest` 过滤掉

## 10. 许可码系统

**设计**：
- 不绑定设备（早期版本绑定过，但导致用户换机麻烦）
- 只记录 `last_device_id` 和 `last_activated_at`
- 管理员可以 `active: false` 停用许可
- 扩展启动时调 `/api/verify`，离线时保留上次状态不阻塞使用
