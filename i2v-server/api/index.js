/**
 * Vercel Serverless Function — I2V API
 * 许可码管理 / MiniMax API 代理 / Firebase 数据同步
 *
 * 环境变量 (Vercel Dashboard → Settings → Environment Variables):
 *   MINIMAX_API_KEY
 *   MINIMAX_BASE_URL (默认 https://aitokenhub.xyz/v1)
 *   MINIMAX_MODEL (默认 MiniMax-M2.7-highspeed)
 *   FIREBASE_PROJECT_ID (i2v-5aed8)
 *   FIREBASE_CLIENT_EMAIL
 *   FIREBASE_PRIVATE_KEY (注意换行用 \n)
 *   ADMIN_KEY
 */

const admin = require('firebase-admin');

// ── Firebase 初始化（冷启动时执行一次）────────────────

let db;
function getDb() {
  if (db) return db;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  db = admin.firestore();
  return db;
}

// ── 主路由 ──────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host}`);
  const path = url.pathname;

  try {
    const body = req.method === 'POST' ? req.body : {};

    if (path === '/api/activate') return res.json(await handleActivate(body));
    if (path === '/api/verify') return res.json(await handleVerify(body));
    if (path === '/api/generate') return res.json(await handleGenerate(body));
    if (path === '/api/sync-row') return res.json(await handleSyncRow(body));
    if (path === '/api/save-rows') return res.json(await handleSaveRows(body));
    if (path === '/api/get-rows') return res.json(await handleGetRows(body));
    if (path === '/api/delete-row') return res.json(await handleDeleteRow(body));
    if (path === '/api/clear-rows') return res.json(await handleClearRows(body));
    if (path === '/api/log') return res.json(await handleLog(body));
    if (path === '/api/revoke') return res.json(await handleRevoke(body));
    if (path === '/api/admin/users') return res.json(await handleAdminUsers(url.searchParams.get('admin_key')));
    if (path === '/api/admin/create-license') return res.json(await handleCreateLicense(body));
    if (path === '/api/admin/user-rows') return res.json(await handleAdminUserRows(url.searchParams.get('admin_key'), url.searchParams.get('device_id')));

    return res.status(404).json({ error: 'Not found' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};

// ═══════════════════════════════════════════════════════
//  许可码管理
// ═══════════════════════════════════════════════════════

async function handleActivate({ code, device_id }) {
  if (!code) return { error: '缺少许可码' };
  const db = getDb();

  const doc = await db.collection('licenses').doc(code).get();
  if (!doc.exists) return { error: '许可码无效' };

  const data = doc.data();
  if (data.active === false) return { error: '许可码已停用，请联系管理员' };

  // 不绑定设备，只记录最近使用的设备
  await db.collection('licenses').doc(code).update({
    last_device_id: device_id || '',
    last_activated_at: new Date().toISOString(),
    active: true,
  });

  await db.collection('users').doc(device_id).set({
    device_id,
    license_code: code,
    last_active: new Date().toISOString(),
    app_version: '1.0.0',
  }, { merge: true });

  return { ok: true, message: '激活成功' };
}

async function handleVerify({ code, device_id }) {
  if (!code) return { valid: false, error: '缺少许可码' };
  const db = getDb();

  const doc = await db.collection('licenses').doc(code).get();
  if (!doc.exists) return { valid: false, error: '许可码无效' };

  const data = doc.data();
  if (data.active === false) return { valid: false, error: '许可码已停用，请联系管理员' };

  // 更新活跃时间
  if (device_id) {
    db.collection('users').doc(device_id).set({
      last_active: new Date().toISOString(),
    }, { merge: true }).catch(() => {});
  }

  return { valid: true };
}

// ═══════════════════════════════════════════════════════
//  提示词生成（代理 MiniMax API）
// ═══════════════════════════════════════════════════════

async function handleGenerate({ images_base64, prompt, code, device_id }) {
  // 验证许可
  const v = await handleVerify({ code, device_id });
  if (!v.valid) return { error: v.error || '许可无效' };

  const apiKey = process.env.GEMINI_API_KEY || 'AIzaSyD7VxejRAPOx6q3Fy81GNbGQvo-OEdS7cQ';
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  if (!apiKey) return { error: '服务器未配置 API Key' };
  if (!images_base64 || !images_base64.length) return { error: '缺少图片' };

  // 构建 Gemini API 格式的 parts
  const contentParts = [];
  for (const img of images_base64) {
    // 提取 base64 数据和 mime type
    const match = img.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (match) {
      contentParts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    } else {
      contentParts.push({ inline_data: { mime_type: 'image/png', data: img } });
    }
  }

  const promptText = `You are a professional video creative director specializing in Veo 3 video generation prompts.

Creative brief from user: ${prompt || 'Create an engaging product video'}

## Core Rules:
Generate English prompts tailored to the Veo model's video generation requirements.

## Step 1: Product Research
Analyze the uploaded product images. Search online for information about this product to understand its features, target audience, and usage context. Then proceed to write the prompts.

## Step 2: Prompt Segmentation
Split into 2 segments of 8-second prompts each.
CRITICAL: Segment 1's LAST FRAME must clearly show the complete person AND product together — this serves as the FIRST FRAME of Segment 2 for seamless video extension.

## Step 3: Generate Video Prompts
Generate 3 clearly different creative directions. Return a JSON array with exactly 3 objects. Each object has 4 fields: segment_1, segment_1_zh, segment_2, segment_2_zh.

All prompts in English, with fluent natural Chinese translations in _zh fields.

Each segment value is a single string with EXACTLY 8 fields separated by " | ":
Subject | Context | Action | Style | Camera | Composition | Ambiance | Audio

## 8-Component Architecture (MANDATORY for each field):

1. **Subject**: Describe the person and product. Reference the ACTUAL product from the uploaded images.
2. **Context**: Match the product's real usage scenario as environment (e.g. shower gel → bathroom; fitness equipment → home gym; laptop → modern office/cafe).
3. **Action**: Describe what happens. Include natural dialogue using colon format: says: "..." (12-15 words max, ~8 seconds natural speech). NEVER use quotation marks directly (prevents subtitle generation). Set dialogue country and accent.
4. **Style**: Visual style direction (cinematic, documentary, lifestyle, etc.)
5. **Camera**: Describe camera movement. MUST use "(thats where the camera is)" syntax for camera position — this triggers Veo 3's camera-aware processing. Example: "Medium close-up from across the desk (thats where the camera is), slowly dollying in"
6. **Composition**: Framing and visual layout. Segment 1 must end with full person + product clearly visible in frame.
7. **Ambiance**: Lighting and mood description.
8. **Audio**: MUST specify background sound (e.g. "quiet office ambiance") to prevent AI audio hallucinations. Specify accent/country for dialogue.

## Direction Guidelines:
- Direction 1: Elegant & premium
- Direction 2: Dynamic & energetic
- Direction 3: Intimate & emotional

## Negative Prompts:
Append to EACH segment: "Negative: no text overlays, no watermarks, no blurry faces, no distorted hands, no subtitles"

## Output Format:
- Use " | " as field separator
- Return ONLY the JSON array, no markdown, no code fences`;

  contentParts.push({ text: promptText });

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: contentParts }],
      generationConfig: { temperature: 0.7 },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { error: `Gemini API 错误: ${resp.status} ${err.substring(0, 200)}` };
  }

  const data = await resp.json();
  let raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
  if (raw.startsWith('```')) {
    const lines = raw.split('\n');
    raw = lines.slice(1, -1).join('\n');
  }

  let prompts;
  try {
    prompts = JSON.parse(raw);
  } catch (e) {
    return { error: `JSON 解析失败: ${raw.substring(0, 100)}` };
  }
  if (!Array.isArray(prompts)) return { error: '返回格式错误' };

  const db = getDb();

  // 记录日志
  db.collection('users').doc(device_id).collection('logs').add({
    action: 'generate_prompts',
    time: new Date().toISOString(),
    detail: { prompt_count: prompts.length },
  }).catch(() => {});

  // 自动保存第一个方向到 Firebase（扩展可通过 /api/get-rows 拉取）
  if (prompts.length > 0 && device_id) {
    const p = prompts[0];
    // 获取当前最大 row_n
    const snap = await db.collection('users').doc(device_id).collection('rows')
      .orderBy('row_n', 'desc').limit(1).get();
    let nextRowN = 1;
    snap.forEach(doc => { nextRowN = (doc.data().row_n || 0) + 1; });

    const rowData = {
      row_n: nextRowN,
      segment_1: p.segment_1 || '',
      segment_1_zh: p.segment_1_zh || '',
      segment_2: p.segment_2 || '',
      segment_2_zh: p.segment_2_zh || '',
      user_prompt: prompt || '',
      status: 'pending',
      generated_video: '',
      error_msg: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await db.collection('users').doc(device_id).collection('rows')
      .doc(`row_${nextRowN}`).set(rowData);
  }

  return { ok: true, prompts: prompts.slice(0, 3) };
}

// ═══════════════════════════════════════════════════════
//  数据同步
// ═══════════════════════════════════════════════════════

async function handleSyncRow({ device_id, row_data }) {
  if (!device_id || !row_data) return { error: '缺少参数' };
  const db = getDb();
  const rowN = row_data.row_n || 0;
  await db.collection('users').doc(device_id).collection('rows').doc(`row_${rowN}`).set({
    ...row_data,
    updated_at: new Date().toISOString(),
  }, { merge: true });
  return { ok: true };
}

async function handleSaveRows({ device_id, rows }) {
  if (!device_id || !rows) return { error: '缺少参数' };
  const db = getDb();
  const batch = db.batch();
  for (const row of rows) {
    const docRef = db.collection('users').doc(device_id).collection('rows').doc(`row_${row.row_n}`);
    // 不存图片 base64，只存提示词和状态
    const { image_base64, imageBlobUrl, ...lightRow } = row;
    batch.set(docRef, { ...lightRow, updated_at: new Date().toISOString() }, { merge: true });
  }
  await batch.commit();
  return { ok: true, saved: rows.length };
}

async function handleGetRows({ device_id, code }) {
  if (!device_id) return { error: '缺少 device_id' };
  // 简单验证
  if (code) {
    const v = await handleVerify({ code, device_id });
    if (!v.valid) return { error: '许可无效' };
  }
  const db = getDb();
  const snap = await db.collection('users').doc(device_id).collection('rows').get();
  const rows = [];
  snap.forEach(doc => rows.push(doc.data()));
  rows.sort((a, b) => (a.row_n || 0) - (b.row_n || 0));
  return { ok: true, rows };
}

async function handleDeleteRow({ device_id, row_n }) {
  if (!device_id || row_n === undefined) return { error: '缺少参数' };
  const db = getDb();
  await db.collection('users').doc(device_id).collection('rows').doc(`row_${row_n}`).delete();
  return { ok: true };
}

async function handleClearRows({ device_id }) {
  if (!device_id) return { error: '缺少 device_id' };
  const db = getDb();
  const snap = await db.collection('users').doc(device_id).collection('rows').get();
  const batch = db.batch();
  snap.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
  return { ok: true, deleted: snap.size };
}

async function handleLog({ device_id, action, detail }) {
  if (!device_id) return { error: '缺少 device_id' };
  const db = getDb();
  await db.collection('users').doc(device_id).collection('logs').add({
    action: action || '',
    detail: detail || {},
    time: new Date().toISOString(),
  });
  return { ok: true };
}

// ═══════════════════════════════════════════════════════
//  管理接口
// ═══════════════════════════════════════════════════════

async function handleRevoke({ code, admin_key }) {
  if (admin_key !== process.env.ADMIN_KEY) return { error: '权限不足' };
  if (!code) return { error: '缺少许可码' };
  const db = getDb();
  await db.collection('licenses').doc(code).update({ active: false });
  return { ok: true, message: `许可码 ${code} 已停用` };
}

async function handleCreateLicense({ code, admin_key }) {
  if (admin_key !== process.env.ADMIN_KEY) return { error: '权限不足' };
  if (!code) {
    const bytes = require('crypto').randomBytes(4);
    code = `I2V-${bytes.toString('hex').slice(0, 4).toUpperCase()}-${bytes.toString('hex').slice(4, 8).toUpperCase()}`;
  }
  const db = getDb();
  await db.collection('licenses').doc(code).set({
    code,
    active: true,
    created_at: new Date().toISOString(),
    bound_device_id: '',
  });
  return { ok: true, code };
}

async function handleAdminUsers(adminKey) {
  if (adminKey !== process.env.ADMIN_KEY) return { error: '权限不足' };
  const db = getDb();
  const snap = await db.collection('users').get();
  const users = [];
  snap.forEach(doc => users.push({ id: doc.id, ...doc.data() }));
  return { ok: true, users };
}

async function handleAdminUserRows(adminKey, deviceId) {
  if (adminKey !== process.env.ADMIN_KEY) return { error: '权限不足' };
  if (!deviceId) return { error: '缺少 device_id' };
  const db = getDb();
  const snap = await db.collection('users').doc(deviceId).collection('rows').get();
  const rows = [];
  snap.forEach(doc => rows.push({ id: doc.id, ...doc.data() }));
  rows.sort((a, b) => (a.row_n || 0) - (b.row_n || 0));
  return { ok: true, rows };
}
