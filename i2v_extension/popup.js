/* I2V 图生视频 — 侧边栏控制面板逻辑（全中文 UI） */

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let uploadedImages = []; // [{name, base64}]

// ═══ 初始化 ═══════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
  const status = await msg({ action: 'get_status' });
  if (status?.license?.valid) {
    showMain();
    $('#license-info').textContent = status.license.code;
    if (status.running) updateBatchUI(status);
  } else {
    showActivate();
  }

  // 激活
  $('#btn-activate').addEventListener('click', doActivate);
  $('#license-input').addEventListener('keydown', e => { if (e.key === 'Enter') doActivate(); });
  $('#btn-logout').addEventListener('click', doLogout);

  // Tab 切换
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(b => b.classList.toggle('active', b === t));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + t.dataset.tab));
    if (t.dataset.tab === 'tasks') loadTasks();
    if (t.dataset.tab === 'batch') loadBatchStatus();
    // removed videos tab
  }));

  // 图片上传
  const drop = $('#img-drop'), input = $('#img-input');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => handleFiles(input.files));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = 'var(--accent)'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; });
  drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = ''; handleFiles(e.dataTransfer.files); });

  // 提示词输入变化时更新按钮状态
  $('#user-prompt').addEventListener('input', updateGenButtons);

  // 按钮
  $('#btn-batch-gen').addEventListener('click', doBatchGenerate);
  if ($('#btn-one-click')) $('#btn-one-click').addEventListener('click', doOneClick);
  $('#btn-refresh').addEventListener('click', loadTasks);
  $('#btn-clear').addEventListener('click', doClear);
  $('#btn-start').addEventListener('click', doStart);
  $('#btn-stop').addEventListener('click', doStop);
  if ($('#btn-download-all')) $('#btn-download-all').addEventListener('click', doDownloadAll);
  if ($('#btn-clear-cache')) $('#btn-clear-cache').addEventListener('click', doClearFlowCache);

  // 加载收藏提示词
  loadFavPrompts();

  // 状态更新监听
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'status_update') updateBatchUI(m);
  });
});

// ═══ 页面切换 ═════════════════════════════════════════

function showActivate() {
  const a = $('#page-activate'), m = $('#page-main');
  if (a) a.style.display = 'block';
  if (m) m.style.display = 'none';
}
function showMain() {
  const a = $('#page-activate'), m = $('#page-main');
  if (a) a.style.display = 'none';
  if (m) m.style.display = 'block';
}

function msg(data) {
  return new Promise(resolve => chrome.runtime.sendMessage(data, resolve));
}

// ═══ 激活 ═════════════════════════════════════════════

async function doActivate() {
  const code = $('#license-input').value.trim();
  if (!code) return;
  const el = $('#activate-msg');
  el.className = 'msg'; el.textContent = '正在验证...';
  const result = await msg({ action: 'activate', code });
  if (result?.ok) {
    el.className = 'msg success'; el.textContent = '激活成功！';
    setTimeout(() => { showMain(); $('#license-info').textContent = '***' + code.slice(-4); }, 600);
  } else {
    el.className = 'msg error'; el.textContent = result?.error || '激活失败';
  }
}

async function doLogout() {
  await chrome.storage.local.remove(['license_code', 'i2v_rows']);
  showActivate();
}

// ═══ 批量图片上传 ═════════════════════════════════════

async function handleFiles(fileList) {
  uploadedImages = [];
  const previews = $('#img-previews');
  previews.innerHTML = '';

  for (const file of Array.from(fileList)) {
    const base64 = await new Promise(r => {
      const rd = new FileReader();
      rd.onload = () => r(rd.result);
      rd.readAsDataURL(file);
    });
    uploadedImages.push({ name: file.name, base64 });
  }

  renderImagePreviews();
}

function renderImagePreviews() {
  const previews = $('#img-previews');
  previews.innerHTML = '';
  uploadedImages.forEach((img, i) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;display:inline-block';
    const el = document.createElement('img');
    el.src = img.base64;
    const del = document.createElement('span');
    del.textContent = '✕';
    del.style.cssText = 'position:absolute;top:-4px;right:-4px;width:16px;height:16px;background:var(--red);color:#fff;border-radius:50%;font-size:10px;line-height:16px;text-align:center;cursor:pointer';
    del.onclick = () => { uploadedImages.splice(i, 1); renderImagePreviews(); };
    wrap.appendChild(el);
    wrap.appendChild(del);
    previews.appendChild(wrap);
  });
  if ($('#img-count')) $('#img-count').textContent = uploadedImages.length ? `已选择 ${uploadedImages.length} 张图片` : '';
  updateGenButtons();
}

// ═══ 按钮状态管理（图片+提示词都有才能点）══════════════

function updateGenButtons() {
  const hasImages = uploadedImages.length > 0;
  const hasPrompt = ($('#user-prompt').value || '').trim().length > 0;
  const canGenerate = hasImages && hasPrompt;

  $('#btn-batch-gen').disabled = !canGenerate;
  if ($('#btn-one-click')) $('#btn-one-click').disabled = !canGenerate;

  // 状态提示
  if (!hasImages && !hasPrompt) {
    $('#gen-status').textContent = '请上传产品图并输入提示词';
  } else if (!hasImages) {
    $('#gen-status').textContent = '请先上传产品图';
  } else if (!hasPrompt) {
    $('#gen-status').textContent = '请输入提示词描述';
  } else {
    $('#gen-status').textContent = `已就绪：${uploadedImages.length} 张图片`;
  }
}

// ═══ 批量生成提示词 ═══════════════════════════════════

async function doBatchGenerate() {
  if (!uploadedImages.length) { $('#gen-status').textContent = '请先上传产品图'; return; }
  const prompt = ($('#user-prompt').value || '').trim();
  if (!prompt) { $('#gen-status').textContent = '请输入提示词描述'; return; }

  const total = uploadedImages.length;
  let done = 0, errors = 0;

  $('#btn-batch-gen').disabled = true;
  if ($('#btn-one-click')) $('#btn-one-click').disabled = true;
  if ($('#gen-progress')) $('#gen-progress').style.display = '';
  $('#gen-status').textContent = `生成中... 0/${total}`;

  // 自动切换到任务列表标签页，实时看到每条生成结果
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'tasks'));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-tasks'));

  for (let i = 0; i < total; i++) {
    const img = uploadedImages[i];
    $('#gen-status').textContent = `生成中... ${i + 1}/${total} — ${img.name}`;
    if ($('#gen-fill')) $('#gen-fill').style.width = `${Math.round((i / total) * 100)}%`;

    const result = await msg({
      action: 'generate_prompts',
      images_base64: [img.base64],
      prompt,
    });

    if (result?.ok && result.prompts?.length) {
      done++;
      const p = result.prompts[0];
      // 读取当前本地行，计算下一个 row_n
      const curData = await msg({ action: 'get_rows' });
      const curRows = curData?.rows || [];
      const nextRowN = curRows.length ? Math.max(...curRows.map(r => r.row_n)) + 1 : 1;
      // 立即保存到本地（含图片）
      curRows.push({
        row_n: nextRowN,
        segment_1: p.segment_1 || '',
        segment_1_zh: p.segment_1_zh || '',
        segment_2: p.segment_2 || '',
        segment_2_zh: p.segment_2_zh || '',
        user_prompt: prompt,
        image_base64: img.base64,
        image_name: img.name,
        status: 'pending',
        generated_video: '',
        error_msg: '',
      });
      await msg({ action: 'save_rows', rows: curRows });
      // 图片单独存一份（防止 save_rows 传输时被截断）
      await msg({ action: 'save_image', row_n: nextRowN, image_base64: img.base64, image_name: img.name });
      await loadTasks();
    } else {
      errors++;
      const errMsg = result?.error || '未知错误';
      console.error(`图片 ${img.name} 提示词生成失败:`, errMsg);
      $('#gen-status').textContent = `生成中... ${i + 1}/${total} — ${img.name} 失败: ${errMsg}`;
    }
  }

  if ($('#gen-fill')) $('#gen-fill').style.width = '100%';
  $('#gen-status').textContent = `完成！成功 ${done}/${total}，失败 ${errors}`;
  updateGenButtons();

  uploadedImages = [];
  if ($('#img-previews')) $('#img-previews').innerHTML = '';
  if ($('#img-count')) $('#img-count').textContent = '';
}

// ═══ 任务列表（单提示词+悬浮预览+生成状态+重新生成）══

async function loadTasks() {
  const data = await msg({ action: 'get_rows' });
  // 过滤空行（没有提示词内容的不显示）
  const rows = (data?.rows || []).filter(r => r.segment_1 || r.segment_1_zh);
  const tbody = $('#task-body');
  if ($('#task-count')) $('#task-count').textContent = `(${rows.length} 个)`;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无任务，请先生成提示词</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((r, idx) => {
    const thumb = r.image_base64 ? `<img src="${r.image_base64}">` : '-';
    const seg1Short = (r.segment_1 || '').substring(0, 40);
    const seg1Full = escHtml(r.segment_1 || '(空)');
    const seg1ZhFull = escHtml(r.segment_1_zh || '');
    const seg2Full = escHtml(r.segment_2 || '(空)');
    const seg2ZhFull = escHtml(r.segment_2_zh || '');
    const upShort = (r.user_prompt || '').substring(0, 30);
    const upFull = escHtml(r.user_prompt || '(无)');

    let statusBadge, statusText;
    const st = r.status || 'pending';
    if (st === 'done' || r.generated_video) { statusBadge = 'badge-done'; statusText = '已生成'; }
    else if (st === 'extending' || st === 'processing' || st === 'submitted') { statusBadge = 'badge-processing'; statusText = '处理中'; }
    else if (st === 'error' || r.error_msg) { statusBadge = 'badge-error'; statusText = '失败'; }
    else { statusBadge = 'badge-pending'; statusText = '待处理'; }

    const isFaved = favPrompts.includes(r.user_prompt || '');

    return `<tr>
      <td>${r.row_n}</td>
      <td>${thumb}</td>
      <td class="prompt-cell">
        <span class="prompt-text">${escHtml(seg1Short)}...</span>
        <div class="prompt-tooltip">
          <span class="seg-label">Segment 1 (EN):</span>${seg1Full}
          ${seg1ZhFull ? `<span class="seg-label">第1段 (中文):</span>${seg1ZhFull}` : ''}
          <span class="seg-label">Segment 2 (EN):</span>${seg2Full}
          ${seg2ZhFull ? `<span class="seg-label">第2段 (中文):</span>${seg2ZhFull}` : ''}
        </div>
      </td>
      <td class="prompt-cell">
        <span class="prompt-text">${escHtml(upShort)}${upShort ? '...' : ''}</span>
        <div class="prompt-tooltip">${upFull}</div>
        ${r.user_prompt ? `<button class="btn-fav ${isFaved ? 'active' : ''}" onclick="toggleFav(${idx})" title="收藏提示词">${isFaved ? '★' : '☆'}</button>` : ''}
      </td>
      <td><span class="badge ${statusBadge}">${statusText}</span></td>
      <td>
        <button class="btn-regen" onclick="regenPrompt(${r.row_n})" title="重新生成提示词">刷新</button>
        <button class="btn-del" onclick="deleteRow(${r.row_n})" title="删除此行" style="color:var(--red);margin-left:4px">删除</button>
      </td>
    </tr>`;
  }).join('');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══ 重新生成单行提示词 ═══════════════════════════════

async function regenPrompt(rowN) {
  const data = await msg({ action: 'get_rows' });
  const rows = data?.rows || [];
  const row = rows.find(r => r.row_n === rowN);
  if (!row) return;
  if (!row.image_base64) { alert('该行没有图片数据，无法重新生成'); return; }

  const prompt = row.user_prompt || ($('#user-prompt')?.value || '').trim() || '创建一个吸引人的产品视频';

  // UI 反馈
  const btn = document.querySelector(`button[onclick="regenPrompt(${rowN})"]`);
  if (btn) { btn.textContent = '生成中...'; btn.disabled = true; }

  const result = await msg({
    action: 'generate_prompts',
    images_base64: [row.image_base64],
    prompt,
  });

  if (result?.ok && result.prompts?.length) {
    // 服务端已自动保存新提示词，刷新列表即可
    await loadTasks();
  } else {
    alert('重新生成失败: ' + (result?.error || '未知错误'));
    if (btn) { btn.textContent = '刷新'; btn.disabled = false; }
  }
}

// ═══ 删除单行 ═══════════════════════════════════════

async function deleteRow(rowN) {
  // 侧边栏中 confirm() 可能被阻止，改用按钮二次确认
  const btn = document.querySelector(`button[onclick="deleteRow(${rowN})"]`);
  if (btn && btn.dataset.confirmed !== 'true') {
    btn.textContent = '确认?';
    btn.style.background = 'var(--red)';
    btn.style.color = '#fff';
    btn.dataset.confirmed = 'true';
    // 3秒后恢复
    setTimeout(() => {
      if (btn.dataset.confirmed === 'true') {
        btn.textContent = '删除';
        btn.style.background = '';
        btn.style.color = 'var(--red)';
        btn.dataset.confirmed = '';
      }
    }, 3000);
    return;
  }
  await msg({ action: 'delete_row', row_n: rowN });
  loadTasks();
}

async function doClear() {
  const btn = $('#btn-clear');
  if (btn && btn.dataset.confirmed !== 'true') {
    btn.textContent = '确认清空?';
    btn.style.color = '#fff';
    btn.style.background = 'var(--red)';
    btn.dataset.confirmed = 'true';
    setTimeout(() => {
      if (btn.dataset.confirmed === 'true') {
        btn.textContent = '清空';
        btn.style.color = 'var(--red)';
        btn.style.background = '';
        btn.dataset.confirmed = '';
      }
    }, 3000);
    return;
  }
  btn.dataset.confirmed = '';
  await msg({ action: 'clear_rows' });
  loadTasks();
}

// ═══ 批量处理 ═════════════════════════════════════════

async function loadBatchStatus() {
  const st = await msg({ action: 'get_status' });
  if (st) updateBatchUI(st);
}

function updateBatchUI(st) {
  const total = st.totalCount || 0;
  const done = st.doneCount || 0;
  const errors = st.errorCount || 0;

  $('#st-total').textContent = total;
  $('#st-done').textContent = done;
  $('#st-pending').textContent = Math.max(0, total - done - errors);
  $('#st-error').textContent = errors;

  if (st.running) {
    $('#btn-start').disabled = true;
    $('#btn-stop').disabled = false;
    if ($('#batch-progress')) $('#batch-progress').style.display = '';
    const pct = total ? Math.round((done / total) * 100) : 0;
    if ($('#batch-fill')) $('#batch-fill').style.width = pct + '%';
    if ($('#batch-info')) $('#batch-info').textContent = `${st.phase || ''} — ${done}/${total}`;
  } else {
    $('#btn-start').disabled = false;
    $('#btn-stop').disabled = true;
  }

  if (st.logs?.length) {
    const box = $('#log-box');
    if (box) {
      box.innerHTML = st.logs.map(line => {
        let color = '';
        if (/失败|错误|error/i.test(line)) color = 'color:var(--red)';
        else if (/完成|成功/i.test(line)) color = 'color:var(--green)';
        else if (/开始|Phase|批次/i.test(line)) color = 'color:var(--accent)';
        return `<div style="${color}">${escHtml(line)}</div>`;
      }).join('');
      box.scrollTop = box.scrollHeight;
    }
  }
}

async function doStart() {
  const data = await msg({ action: 'get_rows' });
  const rows = (data?.rows || []).filter(r => r.segment_1 && !r.generated_video);
  if (!rows.length) { if ($('#batch-info')) $('#batch-info').textContent = '没有待处理任务'; return; }

  // 检查是否所有行都有图片
  const missingImages = rows.filter(r => !r.image_base64);
  if (missingImages.length) {
    if ($('#batch-info')) $('#batch-info').textContent = `${missingImages.length} 行缺少图片数据，请重新上传图片生成提示词`;
    return;
  }

  for (const row of rows) {
    row.imageBlobUrl = row.image_base64;
  }

  const result = await msg({ action: 'start_i2v', rows });
  if (result?.error) { if ($('#batch-info')) $('#batch-info').textContent = '错误: ' + result.error; }
}

async function doStop() {
  await msg({ action: 'stop' });
}

// ═══ 收藏提示词 ═══════════════════════════════════════

let favPrompts = [];

async function loadFavPrompts() {
  const data = await chrome.storage.local.get('fav_prompts');
  favPrompts = data.fav_prompts || [];
  renderFavChips();
}

function renderFavChips() {
  const container = $('#fav-prompts');
  if (!container) return;
  if (!favPrompts.length) { container.innerHTML = ''; return; }

  container.innerHTML = favPrompts.map((p, i) => {
    const short = p.substring(0, 25);
    return `<div class="fav-chip" onclick="useFavPrompt(${i})">
      ${escHtml(short)}...
      <div class="fav-full">${escHtml(p)}</div>
      <span class="fav-del" onclick="event.stopPropagation();deleteFav(${i})">✕</span>
    </div>`;
  }).join('');
}

async function toggleFav(rowIdx) {
  const data = await msg({ action: 'get_rows' });
  const rows = data?.rows || [];
  if (rowIdx >= rows.length) return;
  const prompt = rows[rowIdx].user_prompt;
  if (!prompt) return;

  const idx = favPrompts.indexOf(prompt);
  if (idx >= 0) {
    favPrompts.splice(idx, 1);
  } else {
    favPrompts.push(prompt);
  }
  await chrome.storage.local.set({ fav_prompts: favPrompts });
  renderFavChips();
  loadTasks(); // 刷新表格里的收藏状态
}

async function deleteFav(i) {
  favPrompts.splice(i, 1);
  await chrome.storage.local.set({ fav_prompts: favPrompts });
  renderFavChips();
  loadTasks();
}

function useFavPrompt(i) {
  if (i < favPrompts.length && $('#user-prompt')) {
    $('#user-prompt').value = favPrompts[i];
    updateGenButtons();
  }
}

// ═══ 一键生成（提示词生成 → 自动切到批量处理 → 启动）══

async function doOneClick() {
  if (!uploadedImages.length) { $('#gen-status').textContent = '请先上传产品图'; return; }
  const prompt = ($('#user-prompt').value || '').trim();
  if (!prompt) { $('#gen-status').textContent = '请输入提示词描述'; return; }

  // 第一步：批量生成提示词
  await doBatchGenerate();

  // 检查是否有生成成功的任务
  const data = await msg({ action: 'get_rows' });
  const pending = (data?.rows || []).filter(r => r.segment_1 && !r.generated_video);
  if (!pending.length) {
    $('#gen-status').textContent = '提示词生成失败，无法继续批量处理';
    return;
  }

  // 第二步：自动切换到批量处理标签
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'batch'));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-batch'));
  loadBatchStatus();

  // 第三步：启动批量处理
  $('#gen-status').textContent = '';
  for (const row of pending) {
    if (row.image_base64 && !row.imageBlobUrl) {
      row.imageBlobUrl = row.image_base64;
    }
  }
  const result = await msg({ action: 'start_i2v', rows: pending });
  if (result?.error) {
    if ($('#batch-info')) $('#batch-info').textContent = '启动失败: ' + result.error;
  }
}

// ═══ 批量去水印下载 ═══════════════════════════════════

async function doDownloadAll() {
  const data = await msg({ action: 'get_rows' });
  const doneRows = (data?.rows || []).filter(r => r.status === 'done' || r.generated_video);
  const statusEl = $('#download-status');

  if (!doneRows.length) {
    if (statusEl) statusEl.textContent = '没有已生成的视频可下载';
    return;
  }

  if (statusEl) statusEl.textContent = `正在处理 ${doneRows.length} 个视频...`;

  // 通过 background 触发下载 + 上传到数据库
  const result = await msg({
    action: 'download_videos',
    row_ns: doneRows.map(r => r.row_n),
  });

  if (result?.ok) {
    if (statusEl) statusEl.textContent = `完成！已下载 ${result.downloaded || 0} 个视频`;
  } else {
    if (statusEl) statusEl.textContent = '下载失败: ' + (result?.error || '未知错误');
  }
}

// ═══ 清除 Flow 缓存 ═════════════════════════════════

async function doClearFlowCache() {
  const statusEl = $('#cache-status');
  const btn = $('#btn-clear-cache');
  if (btn) { btn.disabled = true; btn.textContent = '正在清除...'; }

  try {
    // 查找 Flow 标签页
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    if (!tabs.length) {
      if (statusEl) statusEl.textContent = '未找到 Flow 页面，请先打开 Google Flow';
      return;
    }

    const tabId = tabs[0].id;

    // 在 Flow 页面执行清除操作
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // 清除 Flow 域名下的缓存存储
        if (caches) { caches.keys().then(names => names.forEach(name => caches.delete(name))); }
        // 清除 localStorage 和 sessionStorage
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
      },
    });

    // 强制重置扩展运行状态
    await msg({ action: 'force_reset' });

    // 刷新 Flow 页面
    await chrome.tabs.reload(tabId, { bypassCache: true });

    if (statusEl) statusEl.textContent = '已清除缓存并刷新 Flow 页面，请重新登录后再试';
  } catch (e) {
    if (statusEl) statusEl.textContent = '清除失败: ' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '清除 Flow 缓存并刷新'; }
  }
}
