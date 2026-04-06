/**
 * background.js — I2V 图生视频 Service Worker
 * 许可验证 + 批处理编排（Phase1 提交 + Phase2 延伸）
 * 数据存 chrome.storage.local，同步到 Cloudflare Worker
 */

// ═══ 配置 ═══════════════════════════════════════════════
// 部署 Worker 后替换为实际 URL
const API_BASE = "https://i2v-server.vercel.app";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══ 点击图标打开侧边栏 ════════════════════════════════
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
// 设置侧边栏行为：点击图标切换
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ═══ Service Worker 保活 ════════════════════════════════
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(async () => {
  if (!state.running) {
    const cp = await loadCheckpoint();
    if (cp && cp.running) {
      pushLog("检测到中断批次，自动恢复...");
      resumeFromCheckpoint(cp);
    }
  }
});

// ═══ 全局状态 ════════════════════════════════════════════
let state = {
  running: false,
  stopRequested: false,
  rows: [],
  doneCount: 0,
  errorCount: 0,
  logs: [],
  currentRowN: null,
  phase: "idle",
};

// ═══ 许可信息（从 chrome.storage 读取）═══════════════════
let license = { code: "", device_id: "", valid: false };

async function loadLicense() {
  const data = await chrome.storage.local.get(["license_code", "device_id"]);
  license.code = data.license_code || "";
  license.device_id = data.device_id || "";
  if (!license.device_id) {
    license.device_id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    await chrome.storage.local.set({ device_id: license.device_id });
  }
  if (license.code) {
    await verifyLicense();
  }
}

async function verifyLicense() {
  try {
    const resp = await fetch(`${API_BASE}/api/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: license.code, device_id: license.device_id }),
    });
    const data = await resp.json();
    license.valid = !!data.valid;
    return data;
  } catch (e) {
    // 离线时保持上次状态
    return { valid: license.valid, error: "网络错误" };
  }
}

async function activateLicense(code) {
  const resp = await fetch(`${API_BASE}/api/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, device_id: license.device_id }),
  });
  const data = await resp.json();
  if (data.ok) {
    license.code = code;
    license.valid = true;
    await chrome.storage.local.set({ license_code: code });
  }
  return data;
}

// 启动时加载许可
loadLicense();

// ═══ 日志 & 状态广播 ═══════════════════════════════════
function pushLog(msg) {
  const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = `[${ts}] ${msg}`;
  state.logs.push(line);
  if (state.logs.length > 200) state.logs.shift();
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({
    type: "status_update",
    running: state.running,
    phase: state.phase,
    doneCount: state.doneCount,
    errorCount: state.errorCount,
    totalCount: state.rows.length,
    currentRowN: state.currentRowN,
    logs: state.logs.slice(-50),
  }).catch(() => {});
}

// ═══ 检查点持久化 ═══════════════════════════════════════
async function saveCheckpoint(extra = {}) {
  try {
    // 只存必要字段，去掉 image_base64/imageBlobUrl（太大，容易超 storage 限制）
    const lightRows = state.rows.map(r => ({
      row_n: r.row_n,
      segment_1: r.segment_1,
      segment_2: r.segment_2,
      status: r.status,
      _uuid: r._uuid,
      _skipped: r._skipped,
    }));
    await chrome.storage.local.set({
      checkpoint: {
        version: 1,
        running: state.running,
        phase: state.phase,
        rows: lightRows,
        doneCount: state.doneCount,
        errorCount: state.errorCount,
        ...extra,
      }
    });
  } catch (e) {
    pushLog(`⚠ checkpoint 保存失败: ${e.message}`);
  }
}

async function loadCheckpoint() {
  const { checkpoint } = await chrome.storage.local.get("checkpoint");
  return checkpoint || null;
}

async function clearCheckpoint() {
  await chrome.storage.local.remove("checkpoint");
}

async function resumeFromCheckpoint(cp) {
  state.running = true;
  state.rows = cp.rows || [];
  state.doneCount = cp.doneCount || 0;
  state.errorCount = cp.errorCount || 0;
  state.phase = cp.phase || "idle";
  pushLog(`恢复批次：Phase=${cp.phase}, 进度=${cp.doneCount}/${state.rows.length}`);
  // 从 Phase1 重新开始（简单恢复策略）
  await runImg2VideoBatched();
}

// ═══ Content Script 通信 ════════════════════════════════

async function getFlowTab() {
  const tabs = await chrome.tabs.query({ url: "https://labs.google/fx/tools/flow/project/*" });
  if (!tabs.length) throw new Error("请先打开 Google Flow 项目页面");
  return tabs[0];
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "ping" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    await sleep(500);
  }
}

function sendToContent(tabId, msg, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sendToContent 超时 (${timeout}ms)`)), timeout);
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

function withRetry(fn, context, retries = 3) {
  return (async () => {
    const delays = [3000, 8000, 15000];
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (e) {
        const msg = e.message || "";
        const transient = /超时|timeout|找不到|not found|could not establish/i.test(msg);
        if (!transient || i === retries) throw e;
        pushLog(`  重试 (${i + 1}/${retries}): ${msg.slice(0, 60)}`);
        await sleep(delays[i] || 5000);
        // 重新注入 content script
        try {
          const tab = await getFlowTab();
          await ensureContentScript(tab.id);
        } catch {}
      }
    }
  })();
}

// ═══ 本地行状态更新（同步到任务列表 UI）═══════════════════

async function updateRowStatus(rowN, status, patch) {
  try {
    const { i2v_rows: rows } = await chrome.storage.local.get("i2v_rows");
    if (!rows) return;
    const row = rows.find(r => r.row_n === rowN);
    if (row) {
      row.status = status;
      if (patch && typeof patch === 'object') Object.assign(row, patch);
      await chrome.storage.local.set({ i2v_rows: rows });
    }
  } catch {}
}

// ═══ 云端同步（静默，不阻塞）═══════════════════════════

function syncRow(rowData) {
  fetch(`${API_BASE}/api/sync-row`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: license.device_id, row_data: rowData }),
  }).catch(() => {});
}

function logActivity(action, detail) {
  fetch(`${API_BASE}/api/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: license.device_id, action, detail }),
  }).catch(() => {});
}

// ═══ I2V 批处理 ═════════════════════════════════════════

const BATCH_SIZE = 10;
const MAX_RETRY_ROUNDS = 2;
const MAX_FAIL_RETRIES = 3;
const retryCount = {};  // { "p1_{uuid}" | "p2_{uuid}": count }

async function handleStartI2V(rows, limit) {
  if (state.running) return { error: "已在运行中" };
  if (!license.valid) return { error: "请先激活许可码" };

  state.running = true;
  state.stopRequested = false;
  state.doneCount = 0;
  state.errorCount = 0;
  state.logs = [];
  state.phase = "idle";

  // 从 chrome.storage 读取行数据
  if (rows?.length) {
    state.rows = rows;
  } else {
    // Storage fallback: 必须合并 i2v_images，否则 imageBlobUrl 缺失导致上传失败
    const data = await chrome.storage.local.get(["i2v_rows", "i2v_images"]);
    const imgStore = data.i2v_images || {};
    state.rows = (data.i2v_rows || [])
      .filter(r => r.segment_1 && !r.generated_video)
      .map(r => {
        const img = r.image_base64 || imgStore[r.row_n]?.image_base64 || '';
        return { ...r, image_base64: img, imageBlobUrl: img };
      })
      .filter(r => r.imageBlobUrl); // 没图就跳过，避免无谓重试
  }

  if (limit && limit > 0 && limit < state.rows.length) {
    state.rows = state.rows.slice(0, limit);
    pushLog(`限制处理前 ${limit} 行`);
  }

  if (!state.rows.length) {
    state.running = false;
    return { error: "没有待处理行（请先生成提示词）" };
  }

  pushLog(`开始图生视频 — 共 ${state.rows.length} 行，每批 ${BATCH_SIZE} 行`);
  logActivity("batch_start", { count: state.rows.length });
  await saveCheckpoint();
  pushLog("[debug] 准备调用 runImg2VideoBatched...");
  // fire-and-forget，SW 靠 chrome.alarms 保活 + checkpoint 恢复
  runImg2VideoBatched().then(() => {
    pushLog("[debug] runImg2VideoBatched 正常结束");
  }).catch(e => {
    pushLog(`[debug] runImg2VideoBatched 异常: ${e.message}\n${e.stack}`);
    state.running = false;
    broadcastStatus();
  });
  pushLog("[debug] runImg2VideoBatched 已启动（fire-and-forget）");
  return { ok: true, total: state.rows.length };
}

async function runImg2VideoBatched() {
  pushLog("[debug] runImg2VideoBatched 开始");
  try {
    const allRows = [...state.rows];
    const totalBatches = Math.ceil(allRows.length / BATCH_SIZE);
    pushLog(`[debug] ${allRows.length} 行, ${totalBatches} 批, 第1行keys: ${Object.keys(allRows[0] || {}).join(',')}`);
    pushLog(`[debug] 第1行 imageBlobUrl: ${(allRows[0]?.imageBlobUrl || 'EMPTY').substring(0, 30)}`);
    pushLog(`[debug] 第1行 segment_1: ${(allRows[0]?.segment_1 || 'EMPTY').substring(0, 30)}`);

    for (let i = 0; i < totalBatches; i++) {
      if (state.stopRequested) { pushLog("已停止"); break; }

      const batch = allRows.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
      pushLog(`═══ 批次 ${i + 1}/${totalBatches}（${batch.length} 行）═══`);
      broadcastStatus();

      const successRows = await runPhase1Batch(batch);

      if (state.stopRequested) break;

      if (successRows.length > 0) {
        await runPhase2Extend(successRows);
        pushLog(`批次 ${i + 1} 完成 — ${successRows.length} 行已延伸`);
      } else {
        pushLog(`批次 ${i + 1} 无成功行`);
      }
      broadcastStatus();
    }

    pushLog(`全部完成 — 成功 ${state.doneCount} / 失败 ${state.errorCount}`);
    logActivity("batch_done", { done: state.doneCount, errors: state.errorCount });
  } catch (e) {
    pushLog(`批处理异常: ${e.message}`);
  } finally {
    // 无论成功失败，都确保 running 被重置
    state.running = false;
    await clearCheckpoint();
    broadcastStatus();
  }
}

// ── Phase 1：提交生成 + UUID 绑定 ──────────────────────

async function runPhase1Batch(batchRows) {
  state.phase = "i2v_phase1";
  pushLog(`Phase1 开始, ${batchRows.length} 行`);
  const successRows = [];
  const knownUuids = new Set();

  try { // 外层 catch 防止整个函数崩溃

  // 先检查 Flow 设置（Video + Ingredients + 9:16 + x1 + Veo 3.1 - Fast）
  try {
    const tab = await getFlowTab();
    await ensureContentScript(tab.id);
    pushLog("检查 Flow 模式设置...");
    const settings = await sendToContent(tab.id, { action: "ensure_flow_settings" }, 15000);
    if (settings?.changes?.length) {
      pushLog(`已自动修正设置: ${settings.changes.join(', ')}`);
    } else {
      pushLog("✓ Flow 设置正确");
    }
  } catch (e) {
    pushLog(`⚠ 设置检查失败: ${e.message}，继续执行`);
  }

  // 收集已有 workflowId（优先缓存，降级 DOM）
  try {
    const tab = await getFlowTab();
    await ensureContentScript(tab.id);
    const cards = await sendToContent(tab.id, { action: "get_all_video_cards" }, 10000);
    if (cards?.success) {
      cards.cards.forEach(c => knownUuids.add(c.uuid));
      pushLog(`已有 ${knownUuids.size} 个视频卡 (来源: ${cards.source || 'unknown'})`);
    }
  } catch (e) {
    pushLog(`获取现有卡片失败: ${e.message}`);
  }

  for (let attempt = 0; attempt <= MAX_RETRY_ROUNDS; attempt++) {
    const pending = batchRows.filter(r => !r._uuid && !r._skipped);
    if (!pending.length) break;
    if (attempt > 0) pushLog(`重试第 ${attempt} 轮，剩余 ${pending.length} 行`);

    for (const row of pending) {
      if (state.stopRequested) break;
      state.currentRowN = row.row_n;
      broadcastStatus();

      try {
        const tab = await getFlowTab();
        await ensureContentScript(tab.id);

        // 提交生成
        await withRetry(async () => {
          const result = await sendToContent(tab.id, {
            action: "process_row",
            row_n: row.row_n,
            imagePath: row.imageBlobUrl,
            prompt: row.segment_1,
          }, 180000);
          if (!result?.success) throw new Error(result?.error || "process_row 失败");
        }, `行${row.row_n} Phase1`);

        // 等待新 workflowId — 优先刷新缓存对比，降级 DOM 轮询
        let newUuid = null;
        await sleep(3000); // 等 Flow 后端处理

        // 尝试缓存方式：刷新缓存，对比前后差异
        try {
          await sendToContent(tab.id, { action: "refresh_project_cache" }, 10000);
          const after = await sendToContent(tab.id, { action: "get_all_video_cards" }, 10000);
          if (after?.success) {
            const newCard = after.cards.find(c => !knownUuids.has(c.uuid));
            if (newCard) {
              newUuid = newCard.uuid;
              pushLog(`  [缓存] 发现新 workflowId: ${newUuid.slice(0, 8)}`);
            }
          }
        } catch {}

        // 缓存没找到 → 降级轮询（最多 8 次 × 3 秒）
        if (!newUuid) {
          for (let i = 0; i < 8; i++) {
            await sleep(3000);
            try {
              // 再次尝试刷新缓存
              await sendToContent(tab.id, { action: "refresh_project_cache" }, 5000).catch(() => {});
              const cards = await sendToContent(tab.id, { action: "get_all_video_cards" }, 10000);
              if (cards?.success) {
                const newCard = cards.cards.find(c => !knownUuids.has(c.uuid));
                if (newCard) { newUuid = newCard.uuid; break; }
              }
            } catch {}
          }
        }

        if (newUuid) {
          row._uuid = newUuid;
          knownUuids.add(newUuid);
          successRows.push(row);
          state.doneCount++;
          pushLog(`行 ${row.row_n} — UUID: ${newUuid.slice(0, 8)}...`);
          await updateRowStatus(row.row_n, "submitted", { _uuid: newUuid });
          syncRow({ row_n: row.row_n, status: "submitted", uuid: newUuid });
        } else {
          // 没找到新卡 → 计入失败重试
          const key = `p1_${row.row_n}`;
          retryCount[key] = (retryCount[key] || 0) + 1;
          if (retryCount[key] >= MAX_FAIL_RETRIES) {
            pushLog(`行 ${row.row_n} — 未检测到新视频卡，已失败 ${MAX_FAIL_RETRIES} 次，跳过`);
            row._skipped = true;
            state.errorCount++;
          } else {
            pushLog(`行 ${row.row_n} — 未检测到新视频卡 (${retryCount[key]}/${MAX_FAIL_RETRIES})`);
          }
        }

      } catch (e) {
        const key = `p1_${row.row_n}`;
        retryCount[key] = (retryCount[key] || 0) + 1;
        if (retryCount[key] >= MAX_FAIL_RETRIES) {
          state.errorCount++;
          row._skipped = true;
          pushLog(`行 ${row.row_n} 失败 ${MAX_FAIL_RETRIES} 次，跳过: ${e.message}`);
        } else {
          pushLog(`行 ${row.row_n} 失败 (${retryCount[key]}/${MAX_FAIL_RETRIES}): ${e.message}`);
        }
        syncRow({ row_n: row.row_n, status: "error", error_msg: e.message });
      }

      await saveCheckpoint({ successRows: successRows.map(r => ({ row_n: r.row_n, uuid: r._uuid })) });
      const delay = Math.floor(Math.random() * 10000) + 5000;
      pushLog(`  等待 ${Math.round(delay/1000)} 秒...`);
      await sleep(delay);
    }
  }

  } catch (e) {
    pushLog(`Phase1 异常: ${e.message}`);
  }
  return successRows;
}

// ── Phase 2：延伸视频 ──────────────────────────────────

async function runPhase2Extend(successRows) {
  state.phase = "i2v_phase2";
  const submittedSet = new Set();  // 已提交延伸
  const doneSet = new Set();       // 延伸完成
  const skippedSet = new Set();    // 跳过（失败3次）

  // ── 阶段 A：逐个点进 edit 页执行延伸，不等视频渲染完 ──
  pushLog(`Phase2-A: 提交延伸请求（共 ${successRows.length} 行）`);

  for (const row of successRows) {
    if (state.stopRequested) break;
    if (!row.segment_2) { doneSet.add(row.row_n); continue; }

    try {
      const tab = await getFlowTab();
      await ensureContentScript(tab.id);

      // 确保在项目页
      if (tab.url.includes("/edit/")) {
        await sendToContent(tab.id, { action: "navigate_back" });
        await sleep(4000); // 等页面完全加载
        await ensureContentScript(tab.id);
      }

      // 点进 edit 页
      pushLog(`行 ${row.row_n} — 进入编辑页...`);
      await sendToContent(tab.id, { action: "click_video_card_by_uuid", uuid: row._uuid }, 35000);
      await waitForTabUrl(tab.id, /\/edit\/[a-f0-9-]/, 30000);
      await sleep(3000);
      // 导航后重新注入 content script（location.href 会刷新页面）
      await ensureContentScript(tab.id);

      // 检查是否已延伸
      const check = await sendToContent(tab.id, { action: "check_video_extended" }, 10000);
      if (check?.extended) {
        pushLog(`行 ${row.row_n} — 已延伸 ✓`);
        submittedSet.add(row.row_n); doneSet.add(row.row_n); state.doneCount++;
        syncRow({ row_n: row.row_n, status: "done" });
        await updateRowStatus(row.row_n, "done");
        await sendToContent(tab.id, { action: "navigate_back" }).catch(() => {});
        await sleep(1000);
        continue;
      }

      // 执行延伸（输提示词 → Extend → 生成）
      pushLog(`行 ${row.row_n} — 执行延伸...`);
      let ext;
      try {
        ext = await sendToContent(tab.id, {
          action: "extend_video",
          segment2Prompt: row.segment_2,
        }, 90000);  // 90 秒超时（包括等页面加载+模型选择+输入+生成）
      } catch (e) {
        pushLog(`行 ${row.row_n} — extend_video 超时/异常: ${e.message}`);
        ext = null;
      }

      if (ext?.success) {
        if (ext.generationAccepted) {
          pushLog(`行 ${row.row_n} — 延伸指令已提交 ✓`);
          submittedSet.add(row.row_n);
          syncRow({ row_n: row.row_n, status: "extending" });
          await updateRowStatus(row.row_n, "extending");
        } else {
          pushLog(`行 ${row.row_n} — 延伸生成未确认开始，可能仍在处理`);
          submittedSet.add(row.row_n);  // 仍标记为已提交，轮询时再检查
        }
      } else {
        pushLog(`行 ${row.row_n} — 延伸失败: ${ext?.error || '未知错误'}`);
      }

      // 点击 Done 让 Flow 把延伸固化（必须，否则项目页 kebab 下载不到 15s 完整版）
      try {
        const doneRes = await sendToContent(tab.id, { action: "click_done" }, 8000);
        if (doneRes?.success) pushLog(`行 ${row.row_n} — Done ✓`);
        else pushLog(`行 ${row.row_n} — Done 失败: ${doneRes?.error || '未知'}`);
      } catch (e) {
        pushLog(`行 ${row.row_n} — Done 异常: ${e.message}`);
      }
      await sleep(1500);

      // 返回项目页，继续下一个
      await sendToContent(tab.id, { action: "navigate_back" }).catch(() => {});
      await sleep(4000);
      await ensureContentScript(tab.id).catch(() => {});

    } catch (e) {
      pushLog(`行 ${row.row_n} 延伸失败: ${e.message}`);
      const key = `p2_${row._uuid}`;
      retryCount[key] = (retryCount[key] || 0) + 1;
      if (retryCount[key] >= MAX_FAIL_RETRIES) {
        skippedSet.add(row.row_n); state.errorCount++;
        pushLog(`行 ${row.row_n} 失败 ${MAX_FAIL_RETRIES} 次，跳过`);
      }
      try { await sendToContent((await getFlowTab()).id, { action: "navigate_back" }).catch(() => {}); } catch {}
      await sleep(1000);
    }

    await saveCheckpoint({ submittedRowNs: [...submittedSet] });
    broadcastStatus();
  }

  pushLog(`Phase2-A 完成: 已提交 ${submittedSet.size}, 已完成 ${doneSet.size}, 跳过 ${skippedSet.size}`);

  // ── 阶段 B：在项目页用图标轮询延伸状态 ──
  // videocam = 视频卡，stacks = 已延伸
  // 已提交延伸的行只等待，不重试；超过5分钟没出现 stacks 才算失败重试
  const pendingRows = successRows.filter(r =>
    r.segment_2 && !doneSet.has(r.row_n) && !skippedSet.has(r.row_n)
  );

  if (pendingRows.length > 0) {
    pushLog(`Phase2-B: 等待 ${pendingRows.length} 个延伸生成完成...`);
    const pollTimeout = Math.max(pendingRows.length * 5 * 60000, 1800000);
    const pollStart = Date.now();
    const submitTime = {};  // 记录每行提交延伸的时间
    for (const row of pendingRows) {
      if (submittedSet.has(row.row_n)) submitTime[row.row_n] = Date.now();
    }
    const EXTEND_WAIT = 0; // 每轮轮询发现未延伸就立即执行

    while (Date.now() - pollStart < pollTimeout) {
      if (state.stopRequested) break;

      const stillPending = pendingRows.filter(r => !doneSet.has(r.row_n) && !skippedSet.has(r.row_n));
      if (!stillPending.length) break;

      try {
        const tab = await getFlowTab();
        await ensureContentScript(tab.id);

        if (tab.url.includes("/edit/")) {
          await sendToContent(tab.id, { action: "navigate_back" });
          await sleep(4000);
          await ensureContentScript(tab.id);
        }

        const cards = await sendToContent(tab.id, { action: "get_all_video_cards" }, 10000);

        if (cards?.success) {
          // 日志输出本轮扫描结果
          const extCount = cards.cards.filter(c => c.isExtended).length;
          const notExtCount = cards.cards.filter(c => !c.isExtended).length;
          pushLog(`[轮询] 视频卡 ${cards.cards.length} 个: 已延伸 ${extCount}, 未延伸 ${notExtCount}`);
          for (const row of stillPending) {
            const card = cards.cards.find(c => c.uuid === row._uuid);
            const st = card ? (card.isExtended ? '✓已延伸' : '等待中') : '未出现';
            const wait = Math.round((Date.now() - (submitTime[row.row_n] || pollStart)) / 1000);
            pushLog(`  行 ${row.row_n} (${row._uuid?.substring(0,8)}): ${st}, 已等 ${wait}s`);
          }

          for (const row of stillPending) {
            if (state.stopRequested) break;
            const card = cards.cards.find(c => c.uuid === row._uuid);

            if (!card) {
              pushLog(`  行 ${row.row_n} (${row._uuid?.substring(0,8)}): 视频卡未找到，可能还在生成中`);
              continue;
            }

            // ✓ 有 stacks 图标 = 延伸完成
            if (card.isExtended) {
              pushLog(`行 ${row.row_n} — 延伸完成 ✓ (stacks)`);
              doneSet.add(row.row_n);
              state.doneCount++;
              syncRow({ row_n: row.row_n, status: "done" });
              await updateRowStatus(row.row_n, "done");
              continue;
            }

            // 没有 stacks — 直接执行重试

            // 超过 5 分钟还没出现 stacks → 视为失败，重新提交延伸
            const key = `p2_${row._uuid}`;
            retryCount[key] = (retryCount[key] || 0) + 1;
            if (retryCount[key] > MAX_FAIL_RETRIES) {
              pushLog(`行 ${row.row_n} — 延伸 ${MAX_FAIL_RETRIES} 次未成功，跳过`);
              skippedSet.add(row.row_n);
              state.errorCount++;
              await updateRowStatus(row.row_n, "error");
              continue;
            }

            pushLog(`行 ${row.row_n} — 等待 ${Math.round(elapsed/60000)} 分钟仍未延伸，重试 (${retryCount[key]}/${MAX_FAIL_RETRIES})`);
            pushLog(`  图片: ${row.image_name || '(无名称)'}`);
            pushLog(`  第2段提示词: ${row.segment_2?.substring(0, 50)}...`);
            pushLog(`  视频UUID: ${row._uuid?.substring(0, 8)}`);

            try {
              // 进入 edit 页
              pushLog(`  → 进入编辑页...`);
              await sendToContent(tab.id, { action: "click_video_card_by_uuid", uuid: row._uuid }, 35000);
              await waitForTabUrl(tab.id, /\/edit\/[a-f0-9-]/, 30000);
              await sleep(3000);
              await ensureContentScript(tab.id);

              // 执行延伸
              pushLog(`  → 填入提示词并执行延伸...`);
              const ext = await sendToContent(tab.id, {
                action: "extend_video",
                segment2Prompt: row.segment_2,
              }, 90000);

              if (ext?.success) {
                pushLog(`  → 延伸指令已提交 ✓`);
                submitTime[row.row_n] = Date.now();
              } else {
                pushLog(`  → 延伸失败: ${ext?.error || '未知'}`);
              }

              // 返回项目页
              pushLog(`  → 返回项目页`);
              await sendToContent(tab.id, { action: "navigate_back" }).catch(() => {});
              await sleep(4000);
              await ensureContentScript(tab.id).catch(() => {});

            } catch (e) {
              pushLog(`行 ${row.row_n} — 重试异常: ${e.message}`);
              try { await sendToContent((await getFlowTab()).id, { action: "navigate_back" }).catch(() => {}); } catch {}
              await sleep(2000);
            }
          }
        }
      } catch (e) {
        pushLog(`轮询异常: ${e.message}`);
      }

      const remaining = pendingRows.filter(r => !doneSet.has(r.row_n) && !skippedSet.has(r.row_n)).length;
      if (remaining > 0) {
        pushLog(`等待中... 剩余 ${remaining} 个，已完成 ${doneSet.size}，30 秒后检查`);
        broadcastStatus();
        await sleep(30000);
      }
    }
  }

  pushLog(`Phase2 完成: 成功 ${doneSet.size} / 跳过 ${skippedSet.size} / 总计 ${successRows.length}`);
}

// ── URL 等待 ───────────────────────────────────────────

function waitForTabUrl(tabId, pattern, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (pattern.test(tab.url)) { clearInterval(check); resolve(tab.url); }
        if (Date.now() - start > timeout) { clearInterval(check); reject(new Error("URL 等待超时")); }
      } catch { clearInterval(check); reject(new Error("标签页已关闭")); }
    }, 500);
  });
}

// ═══ 消息处理 ════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.action) {
      case "activate":
        return sendResponse(await activateLicense(msg.code));

      case "verify":
        return sendResponse(await verifyLicense());

      case "get_license":
        return sendResponse({ ...license });

      case "start_i2v":
        return sendResponse(await handleStartI2V(msg.rows, msg.limit));

      case "stop":
        state.stopRequested = true;
        pushLog("正在停止...");
        return sendResponse({ ok: true });

      case "force_reset":
        state.running = false;
        state.stopRequested = false;
        state.phase = "idle";
        state.rows = [];
        state.doneCount = 0;
        state.errorCount = 0;
        state.logs = [];
        state.currentRowN = null;
        await clearCheckpoint();
        return sendResponse({ ok: true, message: "已重置" });

      case "get_status":
        return sendResponse({
          running: state.running,
          phase: state.phase,
          doneCount: state.doneCount,
          errorCount: state.errorCount,
          totalCount: state.rows.length,
          currentRowN: state.currentRowN,
          logs: state.logs.slice(-50),
          license: { valid: license.valid, code: license.code ? "***" + license.code.slice(-4) : "" },
        });

      case "save_rows":
        // 本地保存（任务列表显示用）
        try { await chrome.storage.local.set({ i2v_rows: msg.rows }); } catch {}
        // 静默归档到服务器（不含图片，永久存储，不影响本地）
        try {
          const lightRows = (msg.rows || []).map(r => {
            const { image_base64, imageBlobUrl, ...rest } = r;
            return rest;
          });
          fetch(`${API_BASE}/api/save-rows`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_id: license.device_id, rows: lightRows }),
          }).catch(() => {});
        } catch {}
        return sendResponse({ ok: true });

      case "get_rows": {
        // 只从本地读取（任务列表 = 本地数据）
        const localData = await chrome.storage.local.get(["i2v_rows", "i2v_images"]);
        const rows = localData.i2v_rows || [];
        const imgStore = localData.i2v_images || {};
        // 补充图片
        const merged = rows.map(r => ({
          ...r,
          image_base64: r.image_base64 || imgStore[r.row_n]?.image_base64 || '',
          image_name: r.image_name || imgStore[r.row_n]?.image_name || '',
        }));
        return sendResponse({ rows: merged });
      }

      case "save_image":
        // 单独存图片到本地（按 row_n 索引）
        try {
          const imgStore = (await chrome.storage.local.get("i2v_images")).i2v_images || {};
          imgStore[msg.row_n] = { image_base64: msg.image_base64, image_name: msg.image_name || '' };
          await chrome.storage.local.set({ i2v_images: imgStore });
        } catch (e) { console.error("save_image 失败:", e); }
        return sendResponse({ ok: true });

      case "delete_row": {
        // 只删本地，服务器数据保留
        const delData = await chrome.storage.local.get(["i2v_rows", "i2v_images"]);
        const delRows = (delData.i2v_rows || []).filter(r => r.row_n !== msg.row_n);
        const delImgs = delData.i2v_images || {};
        delete delImgs[msg.row_n];
        await chrome.storage.local.set({ i2v_rows: delRows, i2v_images: delImgs });
        return sendResponse({ ok: true });
      }

      case "clear_rows":
        // 只清本地，服务器数据保留
        await chrome.storage.local.remove(["i2v_rows", "i2v_images"]);
        return sendResponse({ ok: true });

      case "generate_prompts":
        return sendResponse(await generatePrompts(msg.images_base64, msg.prompt));

      case "download_videos":
        return sendResponse(await handleDownloadVideos(msg.row_ns, msg.sub_path));

      case "regen_video":
        return sendResponse(await handleRegenVideo(msg.uuid));

      default:
        return sendResponse({ error: "未知操作" });
    }
  })();
  return true; // 保持 sendResponse 通道
});

// ═══ 提示词生成（调 Worker API）══════════════════════════

async function generatePrompts(imagesBase64, prompt) {
  if (!license.valid) return { error: "请先激活许可码" };

  try {
    const resp = await fetch(`${API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images_base64: imagesBase64,
        prompt,
        code: license.code,
        device_id: license.device_id,
      }),
    });
    return await resp.json();
  } catch (e) {
    return { error: `网络错误: ${e.message}` };
  }
}

// ═══ 批量去水印下载 ══════════════════════════════════════

// chrome.debugger 驱动 trusted click — 走 Flow 原生 kebab → Download → 720p 流程
// 唯一能拿 15s 完整版的路径（simulateClick 过不了 user gesture trust）
async function debuggerClick(tabId, x, y) {
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

async function evalInTab(tabId, expression) {
  const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  return r?.result?.value;
}

async function triggerCardDownloadViaDebugger(tabId, uuid) {
  // attach (idempotent)
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached = true;
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw e;
  }
  try {
    // 1. 找卡片中心 + hover
    const cardPos = await evalInTab(tabId, `(()=>{const a=document.querySelector('a[href*="${uuid}"]');if(!a)return null;const r=a.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (!cardPos) throw new Error('找不到卡片');
    // 真实 mouse move 到卡中心 → 触发 hover → kebab 渲染
    // 先移到一个无关位置 → 再移到卡心，避免「已经在卡上但 hover state 没刷新」
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
    await sleep(200);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardPos.x, y: cardPos.y });
    await sleep(2500);
    // 2. 找 kebab (more_vert，hover 后渲染)
    const kebab = await retryEval(tabId, `(()=>{const all=Array.from(document.querySelectorAll('button')).filter(b=>/more_vert/.test(b.textContent||''));const cardA=document.querySelector('a[href*="${uuid}"]');if(!cardA)return null;const cr=cardA.getBoundingClientRect();const k=all.find(b=>{const r=b.getBoundingClientRect();return r.y>cr.top&&r.y<cr.bottom&&Math.abs(r.x-cr.right)<150});if(!k)return null;const r=k.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, 5000);
    if (!kebab) throw new Error('hover 后未找到 kebab');
    await debuggerClick(tabId, kebab.x, kebab.y);
    await sleep(800);
    // 3. 点 Download 菜单项
    const dl = await retryEval(tabId, `(()=>{const m=Array.from(document.querySelectorAll('[role="menuitem"]')).find(x=>/download/i.test(x.textContent||''));if(!m)return null;const r=m.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, 4000);
    if (!dl) throw new Error('未找到 Download 菜单项');
    await debuggerClick(tabId, dl.x, dl.y);
    await sleep(800);
    // 4. 点 720p Original Size
    const q = await retryEval(tabId, `(()=>{const m=Array.from(document.querySelectorAll('[role="menuitem"]')).find(x=>(x.textContent||'').includes('720p'));if(!m)return null;const r=m.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, 4000);
    if (!q) throw new Error('未找到 720p 选项');
    await debuggerClick(tabId, q.x, q.y);
    return { ok: true };
  } finally {
    if (attached) {
      try { await chrome.debugger.detach({ tabId }); } catch {}
    }
  }
}

async function retryEval(tabId, expr, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evalInTab(tabId, expr);
    if (v) return v;
    await sleep(200);
  }
  return null;
}

// 用 onDeterminingFilename 拦截 Flow 原生下载并改名/落到 subPath
let _pendingDownload = null;
const _completedDownloads = new Set(); // 已完成的 download id（捕获后立即追踪 onChanged）
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (_pendingDownload && /\.mp4$/i.test(item.filename || '') && !/i2v_row_\d+/.test(item.filename)) {
    const target = _pendingDownload.target;
    _pendingDownload.captured = { id: item.id, originalFilename: item.filename };
    suggest({ filename: target, conflictAction: 'uniquify' });
    return true;
  }
  return false;
});
// 全局监听 onChanged，记录所有 complete 的 id（避免 listener 注册时机错过事件）
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current === 'complete') _completedDownloads.add(delta.id);
  if (delta.state?.current === 'interrupted') _completedDownloads.add(delta.id); // 也算结束
});

async function waitForDownloadComplete(downloadId, timeoutMs = 120000) {
  // 1. 已完成立即返回
  if (_completedDownloads.has(downloadId)) { _completedDownloads.delete(downloadId); return; }
  // 2. 主动 search 检查（防止 onChanged 监听时机错过）
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (_completedDownloads.has(downloadId)) { _completedDownloads.delete(downloadId); return; }
    const items = await new Promise(r => chrome.downloads.search({ id: downloadId }, r));
    if (items?.[0]?.state === 'complete') { _completedDownloads.delete(downloadId); return; }
    if (items?.[0]?.state === 'interrupted') throw new Error(`下载 ${downloadId} 中断`);
    await sleep(500);
  }
  throw new Error(`下载 ${downloadId} 超时`);
}

async function handleDownloadVideos(rowNs, subPath) {
  if (!rowNs?.length) return { error: "没有要下载的行" };

  const { i2v_rows: rows } = await chrome.storage.local.get("i2v_rows");
  if (!rows) return { error: "没有任务数据" };
  // 清理 subPath：去除前后斜杠 + 禁止 .. 越级
  const safeSub = (subPath || '').replace(/^\/+|\/+$/g, '').replace(/\.\.+/g, '');

  let downloaded = 0;
  for (const rowN of rowNs) {
    const row = rows.find(r => r.row_n === rowN);
    if (!row) continue;

    if (!row._uuid) {
      pushLog(`行 ${rowN} — 缺 _uuid，跳过`);
      continue;
    }

    try {
      const tab = await getFlowTab();
      // 必须在项目页（不是 edit 页）才能 hover 卡片
      if (/\/edit\//.test(tab.url || '')) {
        await ensureContentScript(tab.id);
        await sendToContent(tab.id, { action: "navigate_back" });
        await sleep(3500);
      }
      // 设置 download 拦截目标
      const baseName = `i2v_row_${rowN}_${Date.now()}.mp4`;
      const target = safeSub ? `${safeSub}/${baseName}` : baseName;
      _pendingDownload = { target, captured: null };
      // 触发 Flow 原生 kebab → Download → 720p
      pushLog(`行 ${rowN} — 触发 Flow 原生下载 (chrome.debugger)`);
      await triggerCardDownloadViaDebugger(tab.id, row._uuid);
      // 等 onDeterminingFilename 捕获
      const start = Date.now();
      while (!_pendingDownload.captured && Date.now() - start < 30000) await sleep(300);
      if (!_pendingDownload.captured) {
        pushLog(`行 ${rowN} — 30s 内未捕获到 Flow 下载事件`);
        _pendingDownload = null;
        continue;
      }
      const dlId = _pendingDownload.captured.id;
      _pendingDownload = null;
      // 等下载完成
      await waitForDownloadComplete(dlId, 120000);
      pushLog(`行 ${rowN} — ✓ 下载完成 → ${target}`);
      // 持久化文件名（相对 Downloads）
      await updateRowStatus(rowN, "done", { generated_video_file: target });
      downloaded++;
      syncRow({ row_n: rowN, status: "downloaded", video_downloaded: true });
    } catch (e) {
      _pendingDownload = null;
      pushLog(`行 ${rowN} 下载失败: ${e.message}`);
    }
  }

  logActivity("download_videos", { count: downloaded, total: rowNs.length });
  return { ok: true, downloaded };
}

// ═══ 重新生成视频 ════════════════════════════════════════

async function handleRegenVideo(uuid) {
  if (!uuid) return { error: "缺少 UUID" };

  // 在任务列表中找到对应 UUID 的行，或创建新行
  const { i2v_rows: rows } = await chrome.storage.local.get("i2v_rows");
  if (!rows) return { error: "没有任务数据" };

  // 查找绑定了这个 UUID 的行
  let targetRow = rows.find(r => r._uuid === uuid);

  if (targetRow) {
    // 重置状态
    targetRow.status = "regen";
    targetRow.generated_video = "";
    targetRow.video_url = "";
    targetRow.error_msg = "";
    targetRow._uuid = "";
    await chrome.storage.local.set({ i2v_rows: rows });
    pushLog(`行 ${targetRow.row_n} 已标记为重新生成`);
    syncRow({ row_n: targetRow.row_n, status: "regen" });
    return { ok: true, row_n: targetRow.row_n };
  }

  // 如果找不到对应行，创建新行（用 UUID 记录来源）
  const nextRowN = rows.length ? Math.max(...rows.map(r => r.row_n)) + 1 : 1;
  rows.push({
    row_n: nextRowN,
    segment_1: "",
    segment_1_zh: "",
    segment_2: "",
    segment_2_zh: "",
    image_base64: "",
    status: "regen",
    generated_video: "",
    error_msg: "",
    regen_from_uuid: uuid,
  });
  await chrome.storage.local.set({ i2v_rows: rows });
  pushLog(`已创建重新生成任务 #${nextRowN}（来自 UUID: ${uuid.substring(0, 8)}）`);
  return { ok: true, row_n: nextRowN };
}
