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
  await client.Runtime.enable();
  // Runtime.enable synchronously emits executionContextCreated for existing
  // contexts, but the events may arrive on the next microtask — wait a tick.
  await new Promise(r => setTimeout(r, 100));
  // Main world: the default context on the top frame (isDefault true, type 'default')
  const mainContext = contexts.find(c => c.isDefault && c.type === 'default');
  // Isolated world: non-default context on the top frame (type 'isolated')
  // There can be multiple isolated worlds (one per content script from each
  // extension). We prefer one whose name matches our extension, else first.
  const isolatedContexts = contexts.filter(c => c.type === 'isolated');
  const i2vContext = isolatedContexts.find(c => /i2v|图生视频/i.test(c.name || '')) || isolatedContexts[0];
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
