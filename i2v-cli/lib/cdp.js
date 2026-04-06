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

export async function attach(tab, port = DEFAULT_PORT) {
  const client = await CDP({ target: tab.webSocketDebuggerUrl, port });
  await client.Runtime.enable();
  return client;
}

export async function evaluate(client, expression, { awaitPromise = true, returnByValue = true } = {}) {
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    awaitPromise,
    returnByValue,
    includeCommandLineAPI: false,
    userGesture: false,
  });
  if (exceptionDetails) {
    const msg = exceptionDetails.exception?.description || exceptionDetails.text || 'unknown error';
    throw new Error(`Evaluation failed: ${msg}`);
  }
  return result.value;
}
