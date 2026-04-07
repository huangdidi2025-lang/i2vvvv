# 迁移指南 — 在新机器上继续开发 i2v-tool

## 1. 仓库

```bash
git clone https://github.com/huangdidi2025-lang/i2vvvv.git i2v-tool
cd i2v-tool
```

## 2. 必装依赖

| 依赖 | 用途 | 备注 |
|---|---|---|
| Node.js ≥ 18 | i2v-cli + 测试 | 推荐 v24 |
| Chrome | 跑扩展 + Flow | 任意稳定版 |
| ffmpeg | clean 后验时长 | `ffprobe` 在 PATH 即可 |
| Vercel CLI | 部署 i2v-server | `npm i -g vercel` 后 `vercel login` |

```bash
cd i2v-cli && npm install
```

## 3. 去水印二进制（**必须单独下载**，已 gitignore）

```
i2v-cli/bin/GeminiWatermarkTool-Video.exe
```

下载：<https://github.com/allenk/VeoWatermarkRemover/releases/download/v0.2.0-demo/GeminiWatermarkTool-Windows-x64-Video.zip> → 解压 → 把 `.exe` 放进 `i2v-cli/bin/`。

## 4. Chrome 启动（带调试端口）

```bash
"C:\Program Files\Google\Chrome\Application\chrome.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="C:\chrome-debug"
```

> 用独立 user-data-dir，**不要用日常 Chrome**（避免污染本人 cookies / 扩展冲突）。

## 5. 装扩展

1. `chrome://extensions/` → 开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选 `i2v_extension/`
3. 注意 manifest 含 `"debugger"` 权限——首次加载时 Chrome 会弹通知，正常允许
4. 打开任意 Google Flow 项目页 + 点扩展图标打开侧边栏

## 6. 激活许可

测试码：`I2V-28FB-C5DB`（线上 Firebase 已存在，与设备 ID 绑定后不可换机）。
若新机器算新设备，需在 admin 后台先**删除旧绑定**或**生成新码**：

- 后台：用浏览器打开本地 `i2v-admin/index.html`，输入 ADMIN_KEY 即可管理
- ADMIN_KEY 在 Vercel 项目 i2v-server 的环境变量里

## 7. 验证一切正常

```bash
# 1. CDP 工具链
node i2v-cli/bin/i2v-cli.js connect          # 应列出 Flow tab
node i2v-cli/bin/i2v-cli.js health           # selector 健康
node i2v-cli/bin/i2v-cli.js reload           # 重载扩展

# 2. 单元测试
cd i2v-cli && npm test                        # 期望 19 pass

# 3. 端到端
node bin/i2v-cli.js download-clean            # 触发完整链路
```

## 8. 关键约束（CLAUDE.md 已强调）

- **不得污染线上**：i2v-server.vercel.app 和 Firebase i2v-5aed8 是生产环境
- 后端改动 → 用 `vercel --prod` 部署需先确认范围
- 调试 Flow 自动化 → **必须先读 [docs/i2v-debug-workflow.md](i2v-debug-workflow.md)**

## 9. 常见坑

| 症状 | 原因 | 解法 |
|---|---|---|
| `connect ECONNREFUSED 9222` | Chrome 没带 `--remote-debugging-port` | 按第 4 步重启 |
| `window.__i2v not defined` | content.js 没注入 | i2v-cli 会自动注入；或 reload 扩展 |
| `chrome.debugger` 横幅吓人 | 正常 | 这是必须的权限来下 15s 完整版 |
| 下载得到 8s 而非 15s | Done 按钮没点 / 走错路径 | 确认 background.js Phase 2-A 有 `click_done` 调用 |
| `clean` 输出空目录 | 工具直接 `--veo` 不接受目录 | i2v-cli 已自己枚举循环；如失败检查二进制在 `i2v-cli/bin/` |

## 10. 环境变量速查（Vercel 上已配，新机器开发不用动）

```
FIREBASE_PROJECT_ID=i2v-5aed8
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@i2v-5aed8.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=...
GEMINI_API_KEY=...
ADMIN_KEY=...
```

只有要本地跑 i2v-server 才需要拷一份到 `i2v-server/.env.local`。

---

**最后一步：** 在新机器读 `CLAUDE.md` + `docs/i2v-debug-workflow.md`，然后 `git log --oneline -10` 看最近的提交脉络。完成。
