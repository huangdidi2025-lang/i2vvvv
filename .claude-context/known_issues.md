# 已知问题清单（v1.0.3）

## 🔴 高优先级

### 1. `elapsed` 未定义 bug (background.js)
**位置**：`runPhase2Extend` → Phase2-B 轮询循环 → 重试分支
**症状**：延伸轮询时遇到需要重试的行就会抛 ReferenceError，中断整个 Phase2
**修复**：在 `retryCount[key] > MAX_FAIL_RETRIES` 检查后、`pushLog` 使用 `elapsed` 前加：
```js
const elapsed = Date.now() - (submitTime[row.row_n] || pollStart);
```

### 2. 批处理"没反应"
**症状**：点"开始生成"后日志只出现标题行，phase 停留在 idle，不进入 Phase1
**可能原因**：
- `handleStartI2V` 中 `runImg2VideoBatched()` 没有 await，SW 在执行前被回收
- `imageBlobUrl` 为空或过大，`popup.js` 的 `row.imageBlobUrl = row.image_base64` 赋值失败
- 消息传递的 rows 数据过大（含多个 base64 图片）导致序列化卡住

### 3. Google Flow UI 稳定性
**症状**：Flow 更新 UI 后硬编码选择器大量失效，导致按钮找不到、流程中断
**长期方案**：需要引入多策略选择器 + 远程配置热更新机制（v1.0.3 未实现）
**临时方案**：每次 UI 变动后手动更新 `content.js` 中的 find* 函数

## 🟡 中优先级

### 4. Vercel Hobby 10 秒超时
**症状**：大图片走 Gemini API 时函数超时
**当前**：`vercel.json` 配了 `maxDuration: 60`，但 Hobby plan 最大只有 10 秒
**方案**：升级 Vercel Pro，或前端压缩图片

### 5. Google Flow IP 封禁
**症状**：频繁自动操作后 Flow 返回 403
**缓解**：行间随机等 5-15 秒（已做），批次间等待
**长期**：IP 轮换、降低频率

### 6. SW 被杀后恢复机制
**症状**：SW 被 Chrome 回收后，alarm 触发恢复，但恢复时 checkpoint 里没图片数据
**现状**：`resumeFromCheckpoint` 只用 cp.rows，丢失 `image_base64`/`imageBlobUrl`
**修复**：从 `chrome.storage.local.i2v_rows` + `i2v_images` 重新加载

## 🟢 低优先级

### 7. manifest.json 版本号未同步
**现象**：发布包叫 v1.0.3，但 `manifest.json` 里 `version: "1.0.0"`
**影响**：Chrome 显示的扩展版本号不正确

### 8. 视频下载未测试
**状态**：`chrome.downloads.download()` 代码已写，但完整流程未跑通验证

### 9. 管理后台不完善
**现状**：`i2v-admin/` 只有基础的许可管理，缺少用量统计、实时监控

### 10. 无多语言支持
**现状**：全中文 UI，未来要分发海外需要 i18n
