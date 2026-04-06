/**
 * content.js — 注入 Google Flow 页面的 DOM 自动化脚本
 *
 * 两阶段架构：
 *   Phase 1 (process_row)：上传图片 + 输提示词 + 点生成 → 立即返回，不等视频
 *   Phase 2 (click_card_kebab / click_download)：批量下载
 */

// 不依赖本地后端，图片通过 blob URL 传入
const LOG_PREFIX = "[Flow自动化]";
const CACHE_LOG = "[缓存]";

function log(...args) { console.log(LOG_PREFIX, ...args); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Radix UI 等框架监听 pointerdown 而非 click，单纯 el.click() 无法打开菜单
// 需要发完整的事件序列模拟真实用户点击
function simulateClick(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

// ── 等待工具 ─────────────────────────────────────────────────────────────────

function waitFor(predicate, timeout = 10000, interval = 300) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const id = setInterval(() => {
      try {
        const result = predicate();
        if (result) { clearInterval(id); resolve(result); return; }
      } catch (e) {
        // DOM 更新中可能出现 stale reference，忽略并下次重试
      }
      if (Date.now() - start > timeout) {
        clearInterval(id);
        reject(new Error(`waitFor 超时: ${predicate.toString().slice(0, 80)}`));
      }
    }, interval);
  });
}

// ── React Query 缓存读取 ─────────────────────────────────────────────────────

// 从 React fiber 树中找到 QueryClient
function _findQueryClient() {
  const root = document.getElementById('__next');
  if (!root) return null;
  const containerKey = Object.keys(root).find(k => k.startsWith('__reactContainer$'));
  if (!containerKey) return null;
  const stack = [{ fiber: root[containerKey], depth: 0 }];
  while (stack.length) {
    const { fiber, depth } = stack.pop();
    if (!fiber || depth > 200) continue;
    if (fiber.pendingProps?.client?.getQueryCache) return fiber.pendingProps.client;
    if (fiber.memoizedProps?.client?.getQueryCache) return fiber.memoizedProps.client;
    if (fiber.child) stack.push({ fiber: fiber.child, depth: depth + 1 });
    if (fiber.sibling) stack.push({ fiber: fiber.sibling, depth: depth + 1 });
  }
  return null;
}

// 获取 projectInitialData query 对象
function _getProjectQuery() {
  const qc = _findQueryClient();
  if (!qc) return null;
  return qc.getQueryCache().getAll().find(q =>
    JSON.stringify(q.queryKey).includes('projectInitialData')
  ) || null;
}

// 强制刷新缓存
async function refreshProjectCache() {
  const query = _getProjectQuery();
  if (!query || typeof query.fetch !== 'function') {
    log(CACHE_LOG, "无法刷新缓存：query 不存在或不支持 fetch");
    return { success: false };
  }
  await query.fetch();
  log(CACHE_LOG, "缓存已刷新");
  return { success: true };
}

// 从缓存读取结构化项目数据
function getProjectDataFromCache() {
  const query = _getProjectQuery();
  const data = query?.state?.data;
  if (!data?.projectContents) {
    log(CACHE_LOG, "缓存不可用");
    return null;
  }
  const pc = data.projectContents;
  const allMedia = pc.media.map(m => {
    const rd = m.mediaMetadata?.requestData;
    const vgrd = rd?.videoGenerationRequestData;
    return {
      mediaId: m.name,
      workflowId: m.workflowId,
      isVideo: !!m.video,
      status: m.mediaMetadata?.mediaStatus?.mediaGenerationStatus || null,
      genMode: vgrd?.videoGenerationMode || null,
      imageInputIds: vgrd?.videoGenerationImageInputs?.map(i => i.mediaId) || [],
      videoInputIds: vgrd?.videoGenerationVideoInputs?.map(v => v.mediaId) || [],
      prompt: rd?.promptInputs?.text || null,
    };
  });

  const videos = allMedia.filter(m => m.isVideo);
  const images = allMedia.filter(m => !m.isVideo);

  // 递归计算视频代数（第几代延长）
  function getGeneration(mediaId, visited = new Set()) {
    if (visited.has(mediaId)) return 0;
    visited.add(mediaId);
    const media = allMedia.find(m => m.mediaId === mediaId);
    if (!media) return 0;
    if (media.imageInputIds.length > 0) return 1;
    if (media.videoInputIds.length > 0) return 1 + getGeneration(media.videoInputIds[0], visited);
    return 1;
  }

  // 为每个视频计算代数
  videos.forEach(v => { v.generation = getGeneration(v.mediaId); });

  // 按 workflowId 分组
  const workflowMap = {};
  for (const v of videos) {
    if (!workflowMap[v.workflowId]) workflowMap[v.workflowId] = [];
    workflowMap[v.workflowId].push(v);
  }

  // 分析单个 workflow 的血缘链状态
  function analyzeWorkflow(wfId) {
    const medias = workflowMap[wfId] || [];
    if (!medias.length) return { exists: false };

    // 按代数分类
    const gen1 = medias.filter(m => m.imageInputIds.length > 0);  // 图生视频
    const extensions = medias.filter(m => m.videoInputIds.length > 0);  // 延伸视频

    const gen1Video = gen1[0] || null;
    const extVideo = extensions[0] || null;

    const gen1Status = gen1Video?.status || null;
    const extStatus = extVideo?.status || null;

    const SUCCESSFUL = 'MEDIA_GENERATION_STATUS_SUCCESSFUL';
    const PENDING = 'MEDIA_GENERATION_STATUS_PENDING';

    return {
      exists: true,
      // 第一段（图生视频）
      gen1: {
        mediaId: gen1Video?.mediaId,
        status: gen1Status,
        successful: gen1Status === SUCCESSFUL,
        pending: !gen1Status || gen1Status === PENDING,
        failed: gen1Status && gen1Status !== SUCCESSFUL && gen1Status !== PENDING,
      },
      // 延伸段
      extension: {
        exists: !!extVideo,
        mediaId: extVideo?.mediaId,
        status: extStatus,
        successful: extStatus === SUCCESSFUL,
        pending: !extStatus || extStatus === PENDING,
        failed: extStatus && extStatus !== SUCCESSFUL && extStatus !== PENDING,
        parentMediaId: extVideo?.videoInputIds?.[0] || null,
      },
      // 总览
      totalMedias: medias.length,
      allSuccessful: medias.every(m => m.status === SUCCESSFUL),
      anyFailed: medias.some(m => m.status && m.status !== SUCCESSFUL && m.status !== PENDING),
    };
  }

  log(CACHE_LOG, `读取成功: ${videos.length} 个视频, ${images.length} 张图片, ${Object.keys(workflowMap).length} 个视频 workflow`);
  return { allMedia, videos, images, workflowMap, getGeneration, analyzeWorkflow };
}

// ── DOM 查找函数 ──────────────────────────────────────────────────────────────

function findOpenDialogBtn() {
  // 底部输入栏旁的 "+" 按钮（aria-haspopup="dialog"，文本含 "add" 或 "create"）
  // 这个按钮打开包含 "Upload image" 的对话框
  return document.querySelector('button[aria-haspopup="dialog"]')
    // 兜底：任何含 "add" 的 haspopup 按钮（排除顶部导航的 "Add Media"）
    || Array.from(document.querySelectorAll('button[aria-haspopup]'))
      .find(b => {
        const t = b.textContent.toLowerCase();
        return (t.includes('add') || t.includes('create')) && !t.includes('add media');
      });
}

function findDialog() {
  return document.querySelector('[role="dialog"]');
}

function findUploadBtnInDialog() {
  const dialog = findDialog();
  if (!dialog) return null;
  // "Upload image" 可能是 button 或 div，搜索所有可点击元素
  return Array.from(dialog.querySelectorAll('button, div, span, a'))
    .find(el => {
      const t = el.textContent.toLowerCase().trim();
      return t === 'upload image' || t === 'uploadupload image';
    });
}

function findFileInput() {
  return document.querySelector('input[type="file"][accept="image/*"]');
}

function findTextbox() {
  const all = Array.from(document.querySelectorAll('[role="textbox"]'));
  // 方法1：通过占位符文字
  const byPlaceholder = all.find(tb =>
    tb.getAttribute('aria-label') !== 'Editable text' &&
    tb.textContent.includes('What do you want to create?')
  );
  if (byPlaceholder) return byPlaceholder;
  // 方法2：多行输入框（排除搜索栏）
  const byMultiline = all.find(tb =>
    tb.getAttribute('aria-multiline') === 'true' &&
    tb.getAttribute('aria-label') !== 'Editable text'
  );
  if (byMultiline) return byMultiline;
  // 方法3：兜底
  const filtered = all.filter(tb => tb.getAttribute('aria-label') !== 'Editable text');
  return filtered[filtered.length - 1] || null;
}

function findGenerateBtn() {
  return Array.from(document.querySelectorAll('button'))
    .find(b =>
      b.textContent.includes('arrow_forward') &&
      !b.disabled &&
      b.getAttribute('aria-disabled') !== 'true'
    );
}

function findIngredientCancelBtn() {
  return Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent.trim() === 'cancel' || b.title === 'cancel');
}

function findDownloadButton() {
  return Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent.toLowerCase().includes('download') && !b.disabled);
}

// ── Phase 1：提交单行（上传 + 提示词 + 生成，立即返回） ─────────────────────

// ── 检查并配置 Flow 模式设置 ────────────────────────────────────────────────
// 目标: Video + Ingredients + 9:16 + x1 + Veo 3.1 - Fast

const FLOW_SETTINGS = [
  { name: "Video",       match: text => text.includes("Video"),       exact: false },
  { name: "Ingredients", match: text => text.includes("Ingredients"), exact: false },
  { name: "9:16",        match: text => text.includes("9:16"),        exact: false },
  { name: "x1",          match: text => text === "x1",                exact: true },
];

// 通用的智能点击：检查 aria-selected / data-state / class，未选中才点击
async function smartClick(text, exact = false) {
  const els = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"]'));
  const target = els.find(el => {
    const t = el.innerText?.trim() || '';
    return exact ? t === text : t.includes(text);
  });
  if (!target) {
    log(`⚠ 未找到: ${text}`);
    return false;
  }
  const isSelected = target.getAttribute('aria-selected') === 'true'
    || target.getAttribute('data-state') === 'active'
    || target.classList.contains('active');
  if (isSelected) {
    log(`✓ ${text} 已选中`);
    return false;
  }
  simulateClick(target);
  await sleep(300);
  log(`→ 已切换: ${text}`);
  return true;
}

async function ensureFlowSettings() {
  log("检查 Flow 模式设置...");

  // 打开设置面板（底部带模式/比例信息的按钮，aria-haspopup="menu"）
  // 按钮文字可能是 "Video crop_16_9 x2" 或 "🍌 Nano Banana 2 crop_16_9 x2" 等
  // 特征：aria-haspopup="menu" + 文字含 crop_（比例图标）或 x1/x2/x3/x4
  const modeBtn = Array.from(document.querySelectorAll('button')).find(b => {
    if (b.getAttribute('aria-haspopup') !== 'menu') return false;
    const t = b.innerText?.trim() || '';
    return /crop_|x[1-4]$/.test(t) || t.includes('Video') || t.includes('Image');
  });
  if (!modeBtn) {
    log("⚠ 未找到模式设置按钮，跳过");
    return { success: false, error: "未找到模式按钮" };
  }
  log(`模式按钮文字: "${modeBtn.innerText?.trim().replace(/\n/g, ' ').substring(0, 40)}"`);


  // 检查面板是否已打开
  let tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panelOpen = tabs.some(t => t.innerText?.includes('Video') || t.innerText?.includes('Image'));
  if (!panelOpen) {
    simulateClick(modeBtn);
    await sleep(800);
  }

  // 依次检查并切换 4 个设置
  const changes = [];
  for (const s of FLOW_SETTINGS) {
    const changed = await smartClick(s.name, s.exact);
    if (changed) changes.push(s.name);
  }

  // 关闭设置面板
  if (!panelOpen) {
    simulateClick(modeBtn);
    await sleep(300);
  }

  // 检查模型（Veo 3.1 - Fast，独立的 Radix 下拉菜单）
  const modelResult = await ensureModelSelection();
  if (modelResult?.changed) changes.push(TARGET_MODEL);

  if (changes.length) {
    log(`✓ 已修正设置: ${changes.join(', ')}`);
  } else {
    log("✓ 所有设置正确（含模型）");
  }
  return { success: true, changes };
}

async function processRow({ row_n, imagePath, prompt }) {
  const filename = imagePath.replace(/\\/g, "/").split("/").pop() || "image.png";
  log(`===== Phase1 行 ${row_n}，图片: ${filename} =====`);

  // 0. 若在 edit 页，先导航回项目页
  if (location.href.includes("/edit/")) {
    const projectUrl = location.href.replace(/\/edit\/[^/?#]+.*$/, "");
    log("在 edit 页，跳回项目页...");
    location.href = projectUrl;
    await sleep(3000);
  }

  // 0.5 关闭可能存在的公告/更新弹窗（如 "Veo 3.1 Lite is now available"）
  const existingDialogs = document.querySelectorAll('[role="dialog"]');
  for (const d of existingDialogs) {
    const isUploadDialog = Array.from(d.querySelectorAll('button'))
      .some(b => b.textContent.toLowerCase().includes('upload'));
    if (!isUploadDialog) {
      // 这不是上传对话框，是公告弹窗，关掉它
      const closeBtn = Array.from(d.querySelectorAll('button'))
        .find(b => /dismiss|get started|close|got it/i.test(b.textContent));
      if (closeBtn) { closeBtn.click(); log("关闭公告弹窗"); await sleep(500); }
      else { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(500); }
    }
  }

  // 1. 移除上一行遗留的 ingredient
  const prevCancel = findIngredientCancelBtn();
  if (prevCancel) {
    log("移除上一行 ingredient...");
    prevCancel.click();
    await sleep(400);
  }

  // 2. 点 + 打开对话框
  const openBtn = await waitFor(findOpenDialogBtn, 8000, 300)
    .catch(() => { throw new Error("找不到 + 按钮"); });
  openBtn.click();
  log("已点 +，等待对话框...");
  await sleep(700);

  // 3. 点 Upload image 按钮
  const uploadBtn = await waitFor(findUploadBtnInDialog, 5000, 200)
    .catch(() => { throw new Error("对话框内找不到 Upload 按钮"); });
  uploadBtn.click();
  await sleep(400);

  // 4. 找 file input
  const fileInput = await waitFor(findFileInput, 5000, 200)
    .catch(() => { throw new Error("找不到 file input"); });

  // 5. 获取图片并注入（imagePath 可以是 blob URL 或 data URL）
  const resp = await fetch(imagePath);
  if (!resp.ok) throw new Error(`获取图片失败 (${resp.status})`);
  const blob = await resp.blob();
  const file = new File([blob], filename, { type: blob.type || "image/png" });

  const filesDt = new DataTransfer();
  filesDt.items.add(file);
  fileInput.files = filesDt.files;
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  fileInput.dispatchEvent(new Event("input", { bubbles: true }));
  log(`图片已注入，等待 ingredient 确认...`);

  // 6. 等待 ingredient cancel 按钮出现（最多 30s）
  await waitFor(findIngredientCancelBtn, 30000, 500)
    .catch(() => { throw new Error("超时：图片未出现在输入栏（30s）"); });
  log("✓ 图片已作为 ingredient 加入");

  // 7. 关闭对话框
  if (findDialog()) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(500);
  }

  // 8. 输入提示词（使用 beforeinput InputEvent 触发 Lexical 状态更新）
  const textbox = await waitFor(findTextbox, 5000, 200)
    .catch(() => { throw new Error("找不到提示词输入框"); });

  log(`textbox: aria-label="${textbox.getAttribute('aria-label')}"`);
  textbox.click();
  await sleep(300);
  textbox.focus();
  await sleep(150);
  document.execCommand("selectAll", false, null);
  await sleep(80);

  const insertEvt = new InputEvent("beforeinput", {
    inputType: "insertText",
    data: prompt,
    bubbles: true,
    cancelable: true,
  });
  textbox.dispatchEvent(insertEvt);
  await sleep(400);

  const written = textbox.textContent.replace(/What do you want to create\?/g, "").trim();
  log(`提示词写入: ${written ? "✓" : "✗"} (${written.length} 字符)`);
  if (!written) throw new Error("提示词注入失败（beforeinput 未被处理）");

  // 9. 等待生成按钮可用（图片上传中时按钮是 disabled）
  log("等待图片上传完成（生成按钮变为可用）...");
  const genBtn = await waitFor(findGenerateBtn, 120000, 1000)
    .catch(() => { throw new Error("超时：生成按钮未变为可用（2分钟）"); });
  log("✓ 生成按钮可用，点击...");
  genBtn.click();

  // 10. 等待 ingredient 消失（说明 Flow 已接受生成请求，输入栏重置）
  log("等待生成请求被接受（ingredient 消失）...");
  await waitFor(() => !findIngredientCancelBtn(), 15000, 500)
    .catch(() => log("警告：ingredient 未消失，继续处理"));

  log(`✓ Phase1 行 ${row_n} 完成，视频正在后台生成`);
  return { success: true };
}

// ── Phase 2a：直接导航到第 N 个视频卡片的 edit 页 ────────────────────────────
// 通过 DOM 结构区分视频卡（含内嵌 button 子元素）和参考图卡（不含）

async function clickCardKebab(cardIndex) {
  log(`寻找第 ${cardIndex} 个视频卡片的 edit 链接...`);

  // 等待至少 cardIndex+1 个视频卡出现（最多 10 分钟）
  // 视频卡特征：a[href*="/edit/"] 的父 div 含有内嵌 button（play 按钮）
  // 参考图卡：a[href*="/edit/"] 的父 div 无内嵌 button
  const videoLinks = await waitFor(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/edit/"]'))
      .filter(a => a.parentElement?.querySelectorAll('button').length > 0);
    return links.length > cardIndex ? links : null;
  }, 600000, 3000).catch(() => null);

  if (!videoLinks) {
    throw new Error(`等待视频卡超时（等待第 ${cardIndex} 个，共 10 分钟）`);
  }

  const link = videoLinks[cardIndex];
  if (!link) throw new Error(`视频卡 ${cardIndex} 没有 /edit/ 链接`);

  log(`点击 edit 链接导航: ...${link.href.split('/edit/')[1]?.substring(0,8)}`);
  link.click();  // React Router SPA，必须用 click() 而非 location.href
  return { success: true };
}

// ── Phase 2：获取所有视频卡信息 ──────────────────────────────────────────────

async function getAllVideoCards() {
  // 用 <i> 图标区分视频卡和延伸状态
  // 视频卡判断：有 videocam 或 play_circle（已延伸的视频没有 videocam，只有 play_circle + stacks）
  // 延伸判断：有 stacks 图标
  log("收集视频卡（图标判断）...");
  const tiles = document.querySelectorAll('a[href*="/edit/"]');
  const cards = [];
  const seen = new Set();

  tiles.forEach((tile, i) => {
    const uuid = tile.getAttribute('href')?.match(/\/edit\/([a-f0-9-]+)/)?.[1] || '';
    if (!uuid || seen.has(uuid)) return;
    seen.add(uuid);

    const parent = tile.closest('button') || tile.parentElement;
    const icons = parent ? Array.from(parent.querySelectorAll('i')).map(el => el.textContent.trim()) : [];

    // 视频卡：有 videocam 或 play_circle
    const isVideo = icons.includes('videocam') || icons.includes('play_circle');
    if (!isVideo) return; // 跳过纯图片卡（无播放图标）

    const isExtended = icons.includes('stacks');
    cards.push({
      index: cards.length,
      uuid,
      href: `/edit/${uuid}`,
      isExtended,
      hasExtension: isExtended,
      icons,
    });
  });

  const extended = cards.filter(c => c.isExtended).length;
  const needExtend = cards.filter(c => !c.isExtended).length;
  log(`视频卡: ${cards.length} 个（已延伸 ${extended}, 需延伸 ${needExtend}）`);
  return { success: true, cards };
}

// ── Phase 2：从 edit 页提取提示词 Subject ────────────────────────────────────

async function getEditPagePrompt() {
  log("提取 edit 页提示词...");
  const text = document.body.innerText;
  const subjectMatch = text.match(/Subject:\s*([^|]+)/);
  if (subjectMatch) {
    const subject = subjectMatch[1].trim();
    log(`✓ Subject: ${subject.substring(0, 60)}...`);
    return { success: true, subject };
  }
  // 备用：取页面前面的长文本行作为提示词
  const lines = text.split('\n').filter(l => l.trim().length > 20);
  const prompt = lines.find(l => l.includes('Subject:')) || lines[0] || '';
  log(`⚠ Subject 提取失败，备用: ${prompt.substring(0, 60)}`);
  return { success: true, subject: prompt.substring(0, 200) };
}

// ── Phase 2：点击指定 uuid 的视频卡进入 edit 页 ─────────────────────────────

async function clickVideoCardByUuid(uuid) {
  log(`点击视频卡 uuid=${uuid.substring(0, 8)}...`);
  // 等待链接出现（页面可能还在加载/渲染中）
  const link = await waitFor(() => {
    return document.querySelector(`a[href*="/edit/${uuid}"]`);
  }, 30000, 500).catch(() => null);

  if (!link) throw new Error(`找不到 uuid=${uuid.substring(0, 8)} 的卡片链接（30s）`);

  // 尝试 React Router click，如果不行用 location.href 兜底
  link.click();
  await sleep(500);

  // 检查 URL 是否变了
  if (!location.href.includes(`/edit/${uuid}`)) {
    log(`link.click() 未触发导航，用 location.href 兜底`);
    location.href = link.href;
  }

  return { success: true };
}

// ── Phase 2b：获取 edit 页的视频 URL ──────────────────────────────────────────

async function getVideoUrl() {
  log("寻找视频 URL...");
  // 先等下载按钮出现，确认视频已生成完毕
  await waitFor(findDownloadButton, 30000, 500)
    .catch(() => { throw new Error("找不到 Download 按钮，视频可能未生成（30s）"); });

  // 找 <video src="https://..."> 元素
  const video = await waitFor(() => {
    const v = document.querySelector("video[src]");
    if (v && v.src && v.src.startsWith("http")) return v;
    return null;
  }, 10000, 500).catch(() => null);

  if (video) {
    log(`✓ 找到 video.src: ${video.src.substring(0, 80)}`);
    return { success: true, url: video.src };
  }

  // 备用：找 <source src="..."> in video
  const source = document.querySelector("video source[src]");
  if (source && source.src.startsWith("http")) {
    log(`✓ 找到 source.src: ${source.src.substring(0, 80)}`);
    return { success: true, url: source.src };
  }

  throw new Error("页面中找不到视频元素（video[src]）");
}

// ── Phase 2b（备用）：在 edit 页点击 Download ──────────────────────────────────

async function clickDownload() {
  log("在 edit 页等待 Download 按钮...");
  const btn = await waitFor(findDownloadButton, 30000, 500)
    .catch(() => { throw new Error("找不到 Download 按钮（30s 超时）"); });
  btn.click();
  log("✓ 已点击 Download");
  return { success: true };
}

// ── 图生视频 Phase 2：检测是否已延长 ─────────────────────────────────────────
// edit 页右侧历史面板：若有 2+ 个视频卡，说明该视频已被延长过

async function checkVideoExtended() {
  log("检查视频是否已延长...");

  // 先刷新缓存再读（否则读到的是触发延伸前的旧数据）
  await refreshProjectCache().catch(() => {});

  const wfId = location.href.match(/\/edit\/([a-f0-9-]+)/)?.[1];
  if (!wfId) {
    log("⚠ 不在 edit 页，无法检查延伸状态");
    return { success: true, extended: false, videoCount: 0 };
  }

  // 从缓存读取：精确判断是否有 VIDEO_EXTENSION 类型的 media
  const data = getProjectDataFromCache();
  if (data) {
    const wfMedias = (data.workflowMap[wfId] || []);
    // 核心判断：是否有 videoInputIds 非空的 media（= 延伸视频）
    const hasExtension = wfMedias.some(m => m.videoInputIds.length > 0);
    const maxGen = Math.max(0, ...wfMedias.map(m => m.generation));
    const allSuccessful = wfMedias.length > 0 && wfMedias.every(m => m.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL');
    const anyFailed = wfMedias.some(m =>
      m.status && m.status !== 'MEDIA_GENERATION_STATUS_SUCCESSFUL' &&
      m.status !== 'MEDIA_GENERATION_STATUS_PENDING'
    );
    // 正在生成中：有 PENDING 状态的 media
    const anyPending = wfMedias.some(m =>
      !m.status || m.status === 'MEDIA_GENERATION_STATUS_PENDING'
    );

    log(CACHE_LOG, `workflow ${wfId.substring(0, 8)}: ${wfMedias.length} 个视频, 有延伸=${hasExtension}, 代数=${maxGen}, 全成功=${allSuccessful}, 有失败=${anyFailed}, 有待处理=${anyPending}`);
    return {
      success: true,
      extended: hasExtension && allSuccessful,  // 有延伸 + 全部成功 = 延伸完成
      extending: hasExtension && !allSuccessful && !anyFailed,  // 有延伸但未完成 = 生成中
      videoCount: wfMedias.length,
      maxGeneration: maxGen,
      hasExtension,
      allSuccessful,
      anyFailed,
      anyPending,
      source: 'cache',
    };
  }

  // 降级：DOM 方式
  log("⚠ 缓存不可用，使用 DOM 降级检测");
  return checkVideoExtendedFromDOM();
}

// DOM 版：用 history-step 元素判断延伸状态
// 每个 [id^="history-step-"] 代表一段视频
// 有 add 图标 = 原始生成，无 add = 延展
// stepCount >= 2 → 已延伸
async function checkVideoExtendedFromDOM() {
  log("检查视频延长（DOM history-step）...");

  const steps = document.querySelectorAll('[id^="history-step-"]');
  const stepCount = steps.length;

  if (stepCount === 0) {
    log("未找到 history-step 元素");
    return { success: true, extended: false, videoCount: 0, source: 'dom' };
  }

  // 分析每个 step 的类型
  const stepsInfo = [...steps].reverse().map((step, idx) => {
    const icons = [...step.querySelectorAll('I')].map(i => i.textContent.trim());
    const isGenerate = icons.includes('add');
    return { segment: idx + 1, type: isGenerate ? 'generate' : 'extend' };
  });

  const extendCount = stepsInfo.filter(s => s.type === 'extend').length;
  log(`DOM history-step: 总段数=${stepCount}, 延展=${extendCount}, 段详情=${stepsInfo.map(s => s.type).join(',')}`);

  return {
    success: true,
    extended: stepCount >= 2,
    videoCount: stepCount,
    extendCount,
    source: 'dom',
  };
}

// ── 图生视频 Phase 2：延长视频（输入 segment_2 + 点 Extend 生成）────────────

function findExtendButton() {
  // 实际文本: "keyboard_double_arrow_rightExtend"，需要用 includes 匹配
  return Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent.toLowerCase().includes('extend'));
}

// ── 模型选择：确保使用 Veo 3.1 - Fast ─────────────────────────────────────────

const TARGET_MODEL = "Veo 3.1 - Fast";

async function ensureModelSelection() {
  log("检查模型选择...");

  // 找到模型选择器按钮（包含 Veo 文字 + arrow_drop_down）
  const allBtns = Array.from(document.querySelectorAll('button'));
  const modelBtn = allBtns.find(b => {
    const t = b.textContent || '';
    return (t.includes('Veo') || t.includes('Nano')) && t.includes('arrow_drop_down');
  });

  if (!modelBtn) {
    log("⚠ 未找到模型选择器，跳过（使用当前模型）");
    return { success: true, error: "未找到模型选择器", skipped: true };
  }

  // 按钮文字可能含图标文字如 "volume_up"，用 includes 判断
  const btnText = modelBtn.textContent || '';
  log(`模型按钮原始文字: "${btnText.substring(0, 60)}"`);

  if (btnText.includes(TARGET_MODEL) && !btnText.includes('Lower Priority')) {
    log(`✓ 模型已是: ${TARGET_MODEL}`);
    return { success: true, model: TARGET_MODEL, changed: false };
  }

  // 需要切换模型 — 用 simulateClick 打开 Radix 下拉菜单
  log(`当前模型不是 ${TARGET_MODEL}，尝试切换...`);
  simulateClick(modelBtn);
  await sleep(800);

  // Radix DropdownMenu: [role="menuitem"] > div > button
  // 找到目标菜单项，然后点击其内部的 button
  const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
  log(`菜单项数量: ${menuItems.length}`);

  let targetMenuItem = null;
  let targetButton = null;

  // 方法1：通过 menuitem 内 span 的精确文字匹配
  for (const item of menuItems) {
    const spans = item.querySelectorAll('span');
    for (const span of spans) {
      const t = span.innerText?.trim() || '';
      if (t === TARGET_MODEL) {
        targetMenuItem = item;
        targetButton = item.querySelector('button');
        log(`方法1（span精确匹配）找到: "${t}"`);
        break;
      }
    }
    if (targetMenuItem) break;
  }

  // 方法2：通过 menuitem textContent 模糊匹配
  if (!targetMenuItem) {
    targetMenuItem = menuItems.find(el => {
      const t = el.textContent || '';
      return t.includes(TARGET_MODEL) && !t.includes('Lower Priority');
    });
    if (targetMenuItem) {
      targetButton = targetMenuItem.querySelector('button');
      log(`方法2（textContent匹配）找到`);
    }
  }

  // 方法3：兜底扫描所有按钮找文字匹配（不依赖生成 class）
  if (!targetMenuItem) {
    const allBtnsInPage = Array.from(document.querySelectorAll('button'));
    const matchBtn = allBtnsInPage.find(b => {
      const t = b.innerText?.trim() || '';
      return t === TARGET_MODEL; // 精确匹配按钮文字
    });
    if (matchBtn) {
      targetMenuItem = matchBtn.closest('[role="menuitem"]') || matchBtn.parentElement;
      targetButton = matchBtn;
      log(`方法3（按钮文字精确匹配）找到`);
    }
  }

  if (!targetMenuItem) {
    log("⚠ 未找到 " + TARGET_MODEL + " 选项，使用当前模型继续");
    // 关闭菜单（不用 Escape，避免触发导航）
    simulateClick(modelBtn);
    await sleep(500);
    return { success: true, error: "未找到目标模型选项", skipped: true };
  }

  // 点击菜单项内部的 button（Radix 要求点内部 button）
  const clickTarget = targetButton || targetMenuItem;
  log(`点击目标: ${clickTarget.tagName}, text="${clickTarget.textContent?.trim().substring(0, 30)}"`);
  simulateClick(clickTarget);
  await sleep(1000);

  log(`✓ 已切换到 ${TARGET_MODEL}`);
  return { success: true, model: TARGET_MODEL, changed: true };
}

async function extendVideo(segment2Prompt) {
  log(`延长视频：输入 segment_2 → Extend → 生成`);
  log(`延长提示词: "${segment2Prompt?.substring(0, 50)}..."`);

  // 等 edit 页完全加载（等 textbox 和 Extend 按钮都出现）
  log("等待 edit 页加载完成...");
  await waitFor(() => findTextbox() && findExtendButton(), 30000, 500)
    .catch(() => { throw new Error("edit 页加载超时（30s）：textbox 或 Extend 按钮未出现"); });
  log("✓ edit 页已加载");

  // 先确保模型正确
  await ensureModelSelection();
  await sleep(500);

  // 1. 找提示词输入框，输入 segment_2
  const textbox = findTextbox();
  if (!textbox) throw new Error("找不到延长提示词输入框");

  // 延长页输入框用 beforeinput InputEvent（与 processRow 相同方式）
  textbox.click();
  await sleep(300);
  textbox.focus();
  await sleep(150);
  document.execCommand("selectAll", false, null);
  await sleep(80);
  textbox.dispatchEvent(new InputEvent("beforeinput", {
    inputType: "insertText",
    data: segment2Prompt,
    bubbles: true,
    cancelable: true,
  }));
  await sleep(400);

  const written = textbox.textContent.replace(/What happens next\?/g, "").trim();
  log(`延长提示词写入: ${written ? "✓" : "✗"} (${written.length} 字符)`);
  if (!written) throw new Error("延长提示词注入失败");

  // 2. 点击 Extend 按钮
  const extendBtn = findExtendButton();
  if (!extendBtn) throw new Error("找不到 Extend 按钮");
  log("✓ 点击 Extend...");
  simulateClick(extendBtn);
  await sleep(1000);

  // 3. 等待生成按钮可用，然后点击
  log("等待生成按钮...");
  const genBtn = await waitFor(findGenerateBtn, 15000, 500)
    .catch(() => { throw new Error("找不到 → 生成按钮（15s）"); });
  log("✓ 点击生成按钮...");
  simulateClick(genBtn);
  await sleep(500);

  // 等待延长生成被接受：history-step 数量增加
  const stepsBefore = document.querySelectorAll('[id^="history-step-"]').length;
  const accepted = await waitFor(() => {
    const stepsNow = document.querySelectorAll('[id^="history-step-"]').length;
    return stepsNow > stepsBefore ? true : null;
  }, 15000, 1000).catch(() => null);

  if (accepted) {
    log("✓ history-step 数量增加，延长生成已确认开始");
  } else {
    log("⚠ 15 秒内 history-step 未增加，生成状态未知（继续）");
  }

  return { success: true, generationAccepted: !!accepted };
}

// ── Phase 2c：点击 Done 按钮（延长完成后确认）─────────────────────────────────

async function clickDoneButton() {
  log("查找 Done 按钮...");
  const doneBtn = Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent?.trim().toLowerCase() === 'done');
  if (doneBtn) {
    doneBtn.click();
    log("✓ 已点击 Done 按钮");
    await sleep(2000);
    return { success: true };
  }
  log("⚠ 未找到 Done 按钮");
  return { success: false, error: "未找到 Done 按钮" };
}

// ── Phase 2d：从 edit 页导航回项目页 ─────────────────────────────────────────

function navigateBack() {
  const projectUrl = location.href.replace(/\/edit\/[^/?#]+.*$/, "");
  log(`导航回项目页: ${projectUrl}`);
  location.href = projectUrl;
  return { success: true };
}

// ── 消息监听 ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "ensure_flow_settings") {
    ensureFlowSettings()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "ensure_model") {
    ensureModelSelection()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "process_row") {
    processRow(msg)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "click_card_kebab") {
    clickCardKebab(msg.cardIndex)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "get_all_video_cards") {
    getAllVideoCards()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "get_edit_page_prompt") {
    getEditPagePrompt()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "click_video_card_by_uuid") {
    clickVideoCardByUuid(msg.uuid)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "get_video_url") {
    getVideoUrl()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "click_download") {
    clickDownload()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "check_video_extended") {
    checkVideoExtended()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "extend_video") {
    extendVideo(msg.segment2Prompt)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "click_done") {
    clickDoneButton()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "navigate_back") {
    sendResponse(navigateBack());
    return false;
  }

  if (msg.action === "get_project_data") {
    const data = getProjectDataFromCache();
    if (data) {
      sendResponse({
        success: true,
        videos: data.videos,
        images: data.images,
        workflowMap: data.workflowMap,
        source: 'cache',
      });
    } else {
      sendResponse({ success: false, error: "缓存不可用" });
    }
    return false;
  }

  if (msg.action === "analyze_workflow") {
    // 刷新缓存后分析指定 workflow 的血缘链状态
    refreshProjectCache().catch(() => {}).then(() => {
      const data = getProjectDataFromCache();
      if (data && msg.uuid) {
        const analysis = data.analyzeWorkflow(msg.uuid);
        log(CACHE_LOG, `workflow ${msg.uuid.substring(0, 8)} 分析: gen1=${analysis.gen1?.status}, ext=${analysis.extension?.exists ? analysis.extension.status : '无'}`);
        sendResponse({ success: true, ...analysis });
      } else {
        sendResponse({ success: false, error: "缓存不可用" });
      }
    });
    return true;
  }

  if (msg.action === "refresh_project_cache") {
    refreshProjectCache()
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === "ping") {
    sendResponse({ ok: true, url: location.href });
    return false;
  }
});

// ── 开发工具：通过页面 JS 触发插件操作 ──────────────────────────────────────
// 保存行数据到 chrome.storage（测试用）
window.addEventListener("__save_rows__", (e) => {
  const rows = e.detail?.rows || [];
  log("保存 " + rows.length + " 行到 chrome.storage...");
  chrome.runtime.sendMessage({ action: "save_rows", rows }, (resp) => {
    log("保存结果: " + JSON.stringify(resp));
    window.dispatchEvent(new CustomEvent("__save_rows_result__", { detail: resp }));
  });
});
// 强制重置（清除卡住的状态）
window.addEventListener("__force_reset__", () => {
  log("强制重置...");
  chrome.runtime.sendMessage({ action: "force_reset" }, (resp) => {
    log("重置结果: " + JSON.stringify(resp));
    window.dispatchEvent(new CustomEvent("__reset_result__", { detail: resp }));
  });
});
// 重载插件
window.addEventListener("__reload_extension__", () => {
  log("收到重载指令，重载插件...");
  chrome.runtime.sendMessage({ action: "reload_extension" });
});
// 启动 i2v 批量生成（从页面 JS 触发，用于自动化测试）
// 可选 detail.limit 限制行数，如 new CustomEvent("__start_i2v__", {detail: {limit: 30}})
window.addEventListener("__start_i2v__", (e) => {
  const limit = e.detail?.limit || 0;
  log(`收到 i2v 启动指令... limit=${limit || '全部'}`);
  chrome.runtime.sendMessage({ action: "start_img2video", limit }, (resp) => {
    log("i2v 启动结果: " + JSON.stringify(resp));
    window.dispatchEvent(new CustomEvent("__i2v_started__", { detail: resp }));
  });
});
// 收集并下载 Flow 已有视频
window.addEventListener("__collect_videos__", () => {
  log("收到收集视频指令...");
  chrome.runtime.sendMessage({ action: "collect_videos" }, (resp) => {
    log("收集结果: " + JSON.stringify(resp));
  });
});
// 停止批量任务
window.addEventListener("__stop_batch__", () => {
  log("收到停止指令...");
  chrome.runtime.sendMessage({ action: "stop" }, (resp) => {
    log("停止结果: " + JSON.stringify(resp));
  });
});
// 获取状态
window.addEventListener("__get_status__", () => {
  chrome.runtime.sendMessage({ action: "get_status" }, (resp) => {
    window.dispatchEvent(new CustomEvent("__status_result__", { detail: resp }));
  });
});

// ── 视频卡片注入"重新生成"按钮 ──────────────────────────────────────────────

function injectRegenButtons() {
  // 找到所有视频卡片（有播放按钮或 video 的）
  const allLinks = Array.from(document.querySelectorAll('a[href*="/edit/"]'));
  const videoLinks = allLinks.filter(a => {
    const parent = a.parentElement;
    const hasButton = parent?.querySelectorAll('button').length > 0;
    const hasVideo = parent?.querySelector('video') !== null || a.querySelector('video') !== null;
    return hasButton || hasVideo;
  });

  videoLinks.forEach(a => {
    const parent = a.parentElement;
    // 避免重复注入
    if (parent.querySelector('.i2v-regen-btn')) return;

    const uuid = a.href.match(/\/edit\/([a-f0-9-]+)/)?.[1];
    if (!uuid) return;

    const btn = document.createElement('button');
    btn.className = 'i2v-regen-btn';
    btn.textContent = '重新生成';
    btn.style.cssText = `
      position: absolute; bottom: 8px; right: 8px; z-index: 50;
      background: rgba(47,156,245,0.9); color: #fff; border: none;
      border-radius: 6px; padding: 4px 10px; font-size: 11px;
      font-weight: 600; cursor: pointer; backdrop-filter: blur(4px);
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      transition: opacity 0.2s;
    `;
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(47,156,245,1)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(47,156,245,0.9)'; });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.textContent = '已加入队列';
      btn.style.background = 'rgba(34,197,94,0.9)';
      btn.disabled = true;
      setTimeout(() => { btn.style.opacity = '0'; setTimeout(() => btn.remove(), 300); }, 1500);

      // 通知 background 重新生成
      chrome.runtime.sendMessage({
        action: "regen_video",
        uuid: uuid,
      }, (resp) => {
        log("重新生成请求: " + JSON.stringify(resp));
      });
    });

    // 确保父元素有 position:relative
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    parent.appendChild(btn);
  });
}

// 定时检查并注入按钮（Flow 是 SPA，DOM 动态变化）
setInterval(injectRegenButtons, 3000);
// 首次延迟注入
setTimeout(injectRegenButtons, 2000);

log(`content.js 已加载  URL: ${location.pathname}`);


// ═══════════════════════════════════════════════════════════════════════════
// Developer-mode exports for i2v-cli (CDP driver)
// Appended 2026-04-06 for M1. This block ONLY re-exports existing functions on
// a namespaced global so a developer (or Claude via i2v-cli) can call them
// from Chrome DevTools Protocol. It adds no new logic. Safe to strip for a
// production build by deleting everything below this line.
// ═══════════════════════════════════════════════════════════════════════════
try {
  window.__i2v = Object.freeze({
    // pure DOM queries
    simulateClick,
    waitFor,
    findOpenDialogBtn,
    findDialog,
    findUploadBtnInDialog,
    findFileInput,
    findTextbox,
    findGenerateBtn,
    findIngredientCancelBtn,
    findDownloadButton,
    findExtendButton,

    // cache helpers
    refreshProjectCache,
    getProjectDataFromCache,

    // actions (side effects!)
    smartClick,
    ensureFlowSettings,
    processRow,
    clickCardKebab,
    getAllVideoCards,
    getEditPagePrompt,
    clickVideoCardByUuid,
    getVideoUrl,
    clickDownload,
    checkVideoExtended,
    checkVideoExtendedFromDOM,
    ensureModelSelection,
    extendVideo,
    clickDoneButton,
    navigateBack,

    // metadata
    __version: "m1-2026-04-06",
    __keys() { return Object.keys(window.__i2v).sort(); },
  });
  console.log("[i2v] window.__i2v exported for i2v-cli, keys:", Object.keys(window.__i2v).length);
} catch (e) {
  console.warn("[i2v] failed to export window.__i2v:", e);
}


// ═══════════════════════════════════════════════════════════════════════════
// M2: Data-driven selectors + health check
// Appended 2026-04-06 for M2. Defines SELECTOR_RULES (a declarative rule table),
// findByRules() (multi-strategy fallback finder), and runHealthCheck() (reports
// which selectors still work on the current Flow DOM). Exposed on the new
// window.__i2v_health global so callers (e.g. i2v-cli health) can query drift.
//
// window.__i2v (from M1) is Object.freeze'd and cannot be extended, so this
// uses a separate namespace.
// ═══════════════════════════════════════════════════════════════════════════
const SELECTOR_RULES = Object.freeze({
  open_upload_dialog_btn: {
    description: "底部输入栏旁的 + 按钮，打开上传对话框",
    used_by: ["findOpenDialogBtn", "processRow step 1"],
    strategies: [
      { type: "css", selector: 'button[aria-haspopup="dialog"]' },
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button[aria-haspopup]'))
          .find(b => { const t = b.textContent.toLowerCase(); return (t.includes('add') || t.includes('create')) && !t.includes('add media'); }) },
    ],
  },
  dialog: {
    description: "任意已打开的对话框",
    used_by: ["findDialog"],
    strategies: [
      { type: "css", selector: '[role="dialog"]' },
    ],
  },
  file_input: {
    description: "文件上传 input[type=file]",
    used_by: ["findFileInput"],
    strategies: [
      { type: "css", selector: 'input[type="file"][accept="image/*"]' },
      { type: "css", selector: 'input[type="file"]' },
    ],
  },
  prompt_textbox: {
    description: "主提示词输入框（Lexical contenteditable）",
    used_by: ["findTextbox", "processRow step 3"],
    strategies: [
      { type: "combo", fn: () => {
        const all = Array.from(document.querySelectorAll('[role="textbox"]'));
        return all.find(tb => tb.getAttribute('aria-label') !== 'Editable text' && tb.textContent.includes('What do you want to create?'));
      }},
      { type: "combo", fn: () => {
        const all = Array.from(document.querySelectorAll('[role="textbox"]'));
        return all.find(tb => tb.getAttribute('aria-multiline') === 'true' && tb.getAttribute('aria-label') !== 'Editable text');
      }},
      { type: "combo", fn: () => {
        const all = Array.from(document.querySelectorAll('[role="textbox"]'));
        const filtered = all.filter(tb => tb.getAttribute('aria-label') !== 'Editable text');
        return filtered[filtered.length - 1] || null;
      }},
    ],
  },
  generate_btn: {
    description: "生成按钮（arrow_forward 图标）",
    used_by: ["findGenerateBtn", "processRow step 4"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.includes('arrow_forward') && !b.disabled && b.getAttribute('aria-disabled') !== 'true') },
      { type: "text", tag: "button", contains: "Create", excludeDisabled: true },
    ],
  },
  ingredient_cancel_btn: {
    description: "Ingredient 取消按钮",
    used_by: ["findIngredientCancelBtn"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.trim() === 'cancel' || b.title === 'cancel') },
    ],
  },
  download_btn: {
    description: "下载按钮（edit 页）",
    used_by: ["findDownloadButton"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.toLowerCase().includes('download') && !b.disabled) },
    ],
  },
  extend_btn: {
    description: "延伸视频按钮（keyboard_double_arrow_right 图标）",
    used_by: ["findExtendButton", "extendVideo"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.toLowerCase().includes('extend')) },
    ],
  },
  video_card_links: {
    description: "视频卡片链接（含成功+失败状态，不含参考图卡）",
    used_by: ["getAllVideoCards", "clickVideoCardByUuid"],
    strategies: [
      // Strategy 0 (legacy): parent has play button. Misses failed-state cards.
      { type: "combo", fn: () => Array.from(document.querySelectorAll('a[href*="/edit/"]'))
          .filter(a => a.parentElement?.querySelectorAll('button').length > 0) },
      // Strategy 1 (2026-04 Flow update): all /edit/ anchors are video cards.
      // In current Flow UI failed cards have no play button, but reference
      // image cards do not use the /edit/ URL pattern at all.
      { type: "css", selector: 'a[href*="/edit/"]' },
    ],
    returnsArray: true,
  },
  model_selector_btn: {
    description: "模型选择按钮（Veo 3.1 - Fast dropdown）",
    used_by: ["ensureModelSelection"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => { const t = b.textContent || ''; return (t.includes('Veo') || t.includes('Nano')) && t.includes('arrow_drop_down'); }) },
    ],
  },
  history_steps: {
    description: "编辑页的 history-step（判断是否已延伸）",
    used_by: ["checkVideoExtendedFromDOM"],
    strategies: [
      { type: "css", selector: '[id^="history-step-"]' },
    ],
    returnsArray: true,
  },
});

function findByRules(key) {
  const rule = SELECTOR_RULES[key];
  if (!rule) return { element: null, strategyIndex: -1, error: `unknown key: ${key}` };
  for (let i = 0; i < rule.strategies.length; i++) {
    const s = rule.strategies[i];
    let el = null;
    try {
      if (s.type === 'css') {
        el = rule.returnsArray
          ? Array.from(document.querySelectorAll(s.selector))
          : document.querySelector(s.selector);
      } else if (s.type === 'text') {
        const nodes = Array.from(document.querySelectorAll(s.tag || 'button'));
        el = nodes.find(n => {
          if (s.excludeDisabled && (n.disabled || n.getAttribute('aria-disabled') === 'true')) return false;
          const t = n.textContent || '';
          if (s.exact) return t.trim() === s.exact;
          if (s.contains) return t.includes(s.contains);
          return false;
        });
      } else if (s.type === 'combo' && typeof s.fn === 'function') {
        el = s.fn();
      }
    } catch (e) {
      el = null;
    }
    const hit = rule.returnsArray ? (Array.isArray(el) && el.length > 0) : !!el;
    if (hit) {
      return { element: el, strategyIndex: i, strategyUsed: s.type };
    }
  }
  return { element: null, strategyIndex: -1 };
}

async function runHealthCheck() {
  const details = [];
  let passed = 0, fallback = 0, failed = 0;
  for (const key of Object.keys(SELECTOR_RULES)) {
    const res = findByRules(key);
    const rule = SELECTOR_RULES[key];
    let status, elementTag = null, elementText = null, count = null;
    if (res.strategyIndex < 0) {
      status = 'fail'; failed++;
    } else if (res.strategyIndex === 0) {
      status = 'ok'; passed++;
    } else {
      status = 'fallback'; fallback++;
    }
    if (res.element) {
      if (rule.returnsArray) {
        count = res.element.length;
        const first = res.element[0];
        if (first) {
          elementTag = first.tagName;
          elementText = (first.textContent || '').trim().slice(0, 80);
        }
      } else {
        elementTag = res.element.tagName;
        elementText = (res.element.textContent || '').trim().slice(0, 80);
      }
    }
    details.push({
      key,
      status,
      strategyIndex: res.strategyIndex,
      strategyUsed: res.strategyUsed || null,
      strategyCount: rule.strategies.length,
      elementTag,
      elementText,
      count,
      description: rule.description,
      usedBy: rule.used_by,
    });
  }
  return {
    version: "m2-2026-04-06",
    total: details.length,
    passed,
    fallback,
    failed,
    ok: failed === 0,
    details,
  };
}

window.__i2v_health = Object.freeze({
  SELECTOR_RULES,
  findByRules,
  runHealthCheck,
  __version: "m2-2026-04-06",
});
console.log("[i2v] window.__i2v_health exported, rules:", Object.keys(SELECTOR_RULES).length);
