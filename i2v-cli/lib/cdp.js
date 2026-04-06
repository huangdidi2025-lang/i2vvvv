// CDP connection helpers — thin wrapper over chrome-remote-interface
import CDP from 'chrome-remote-interface';

const DEFAULT_PORT = 9222;
const FLOW_URL_PATTERN = /labs\.google\/fx\/tools\/flow/;

export function isFlowTab(tab) {
  if (!tab || typeof tab.url !== 'string') return false;
  return FLOW_URL_PATTERN.test(tab.url);
}

export async function listTabs(port = DEFAULT_PORT) {
  try {
    const tabs = await CDP.List({ port });
    return tabs.filter(t => t.type === 'page');
  } catch (e) {
    throw new Error(
      `Cannot connect to Chrome debug port ${port}. ` +
      `Is Chrome running with --remote-debugging-port=${port}? ` +
      `Original: ${e.message}`
    );
  }
}

export async function findFlowTab(port = DEFAULT_PORT) {
  const tabs = await listTabs(port);
  const flowTabs = tabs.filter(isFlowTab);
  if (flowTabs.length === 0) {
    throw new Error(
      `No Flow tab found. Open https://labs.google/fx/tools/flow/project/... in Chrome first.`
    );
  }
  if (flowTabs.length > 1) {
    console.warn(`[i2v-cli] Warning: ${flowTabs.length} Flow tabs open, using first one: ${flowTabs[0].url}`);
  }
  return flowTabs[0];
}

// Attach to a tab and collect execution contexts.
// MV3 content scripts run in an "isolated world" with a separate execution
// context from the page's main world. Runtime.evaluate defaults to the main
// world, so window.__i2v (set by content.js) is invisible unless we target
// the isolated context explicitly.
//
// Returns { client, contexts: [{id, origin, name, type, isDefault}], mainContextId, isolatedContextId }
export async function attach(tab, port = DEFAULT_PORT) {
  const client = await CDP({ target: tab.webSocketDebuggerUrl, port });
  const contexts = [];
  client.Runtime.executionContextCreated(({ context }) => {
    contexts.push({
      id: context.id,
      origin: context.origin,
      name: context.name,
      type: context.auxData?.type || 'unknown',
      isDefault: !!context.auxData?.isDefault,
      frameId: context.auxData?.frameId,
    });
  });
  await client.Page.enable();
  await client.Runtime.enable();
  // Runtime.enable synchronously emits executionContextCreated for existing
  // contexts, but the events may arrive on the next microtask — wait a tick.
  await new Promise(r => setTimeout(r, 100));
  // Main world: the default context on the TOP frame.
  // Pages can host hidden iframes (about:blank, sandboxes, oauth) which also
  // expose default contexts. Use Page.getFrameTree to find the top frameId,
  // then match by frameId — this is the only reliable way for same-origin
  // iframes.
  let topFrameId = null;
  try {
    const tree = await client.Page.getFrameTree();
    topFrameId = tree?.frameTree?.frame?.id;
  } catch {}
  const defaultContexts = contexts.filter(c => c.isDefault && c.type === 'default');
  const mainContext =
    (topFrameId && defaultContexts.find(c => c.frameId === topFrameId)) ||
    defaultContexts[0] ||
    null;
  // Isolated world: non-default context (type 'isolated'). One per content
  // script per extension. Prefer one whose name matches our extension. Among
  // duplicates (extension reload leaves stale contexts), pick the one with
  // the highest id (= newest).
  const isolatedContexts = contexts.filter(c => c.type === 'isolated');
  const i2vContexts = isolatedContexts
    .filter(c => /i2v|图生视频/i.test(c.name || ''))
    .sort((a, b) => b.id - a.id);
  const i2vContext = i2vContexts[0] || isolatedContexts[0];
  client.__i2v = {
    contexts,
    mainContextId: mainContext?.id,
    isolatedContextId: i2vContext?.id,
  };
  return client;
}

// Evaluate JS in the given execution context.
// opts.world: 'main' (default page context) | 'isolated' (content script context) | undefined (main)
// opts.contextId: override with a specific contextId
export async function evaluate(client, expression, { awaitPromise = true, returnByValue = true, world, contextId } = {}) {
  let ctxId = contextId;
  if (!ctxId && client.__i2v) {
    if (world === 'isolated') ctxId = client.__i2v.isolatedContextId;
    else if (world === 'main') ctxId = client.__i2v.mainContextId;
  }
  const params = {
    expression,
    awaitPromise,
    returnByValue,
    includeCommandLineAPI: false,
    userGesture: false,
  };
  if (ctxId) params.contextId = ctxId;
  const { result, exceptionDetails } = await client.Runtime.evaluate(params);
  if (exceptionDetails) {
    const msg = exceptionDetails.exception?.description || exceptionDetails.text || 'unknown error';
    throw new Error(`Evaluation failed: ${msg}`);
  }
  return result.value;
}

// ═══════════════════════════════════════════════════════════════════════════
// Mock mode: intercept i2v-server requests in the Flow page's isolated world
// so dev tests don't hit production. Default off; opt in via --mock CLI flag.
// ═══════════════════════════════════════════════════════════════════════════

export const MOCK_FETCH_SCRIPT = `
(() => {
  if (window.__i2v_mock_installed) return 'already installed';
  window.__i2v_mock_installed = true;
  window.__i2v_mock_log = [];
  const realFetch = window.fetch.bind(window);
  const PROD_HOST = 'i2v-server.vercel.app';
  function fakeResponse(url, body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-i2v-mock': '1' },
    });
  }
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : input.url;
    if (url && url.includes(PROD_HOST)) {
      window.__i2v_mock_log.push({ ts: Date.now(), method: init?.method || 'GET', url });
      if (url.includes('/api/activate'))   return fakeResponse(url, { success: true, code: 'I2V-MOCK', activated_at: new Date().toISOString() });
      if (url.includes('/api/verify'))     return fakeResponse(url, { success: true, valid: true });
      if (url.includes('/api/sync-row'))   return fakeResponse(url, { success: true });
      if (url.includes('/api/save-rows'))  return fakeResponse(url, { success: true, count: 0 });
      if (url.includes('/api/get-rows'))   return fakeResponse(url, { success: true, rows: [] });
      if (url.includes('/api/log'))        return fakeResponse(url, { success: true });
      if (url.includes('/api/generate'))   return fakeResponse(url, {
        success: true,
        prompts: [{ segment_1: 'mock segment 1', segment_2: 'mock segment 2', segment_1_zh: '模拟', segment_2_zh: '延伸' }],
      });
      return fakeResponse(url, { success: true, _mock: true });
    }
    return realFetch(input, init);
  };
  return 'installed';
})()
`;

export async function installMockFetch(client) {
  if (!client.__i2v?.isolatedContextId) {
    throw new Error('installMockFetch: no isolated context available; is i2v_extension loaded?');
  }
  const result = await client.Runtime.evaluate({
    expression: MOCK_FETCH_SCRIPT,
    contextId: client.__i2v.isolatedContextId,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error('installMockFetch failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
  }
  return result.result.value;
}

export async function readMockLog(client) {
  if (!client.__i2v?.isolatedContextId) return [];
  const result = await client.Runtime.evaluate({
    expression: 'window.__i2v_mock_log || []',
    contextId: client.__i2v.isolatedContextId,
    returnByValue: true,
  });
  return result.result.value || [];
}
