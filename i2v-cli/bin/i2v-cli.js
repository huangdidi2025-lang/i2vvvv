#!/usr/bin/env node
// i2v-cli entry point
import { listTabs, findFlowTab, attach, evaluate, installMockFetch } from '../lib/cdp.js';
import CDP from 'chrome-remote-interface';

const USAGE = `
i2v-cli — CDP driver for i2v_extension

Usage:
  i2v-cli connect              List all tabs and highlight the Flow tab
  i2v-cli contexts             Show execution contexts (main + isolated worlds)
  i2v-cli health               Check which selectors still work (drift detection)
  i2v-cli eval <js>            Evaluate JS in the Flow tab (main world by default)
  i2v-cli call <fn> [args...]  Call window.__i2v.<fn>(...args) in the isolated world
  i2v-cli reload               Reload the i2v extension and refresh Flow tab
  i2v-cli test <module>        Run a scripted scenario for a single module

Options:
  --port <n>                   CDP port (default 9222)
  --json                       Output JSON instead of human text
  --world <main|isolated>      Override execution world for eval/call
  --mock                       Mock i2v-server requests (intercept in isolated world)

Examples:
  i2v-cli connect
  i2v-cli eval "document.title"
  i2v-cli call findGenerateBtn
`;

function parseArgs(argv) {
  const args = { _: [], port: 9222, json: false, world: null, mock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { args.port = parseInt(argv[++i], 10); }
    else if (a === '--json') { args.json = true; }
    else if (a === '--world') { args.world = argv[++i]; }
    else if (a === '--mock') { args.mock = true; }
    else if (a === '-h' || a === '--help') { args.help = true; }
    else { args._.push(a); }
  }
  return args;
}

async function cmdConnect(args) {
  const tabs = await listTabs(args.port);
  const flowTab = tabs.find(t => /labs\.google\/fx\/tools\/flow/.test(t.url || ''));
  if (args.json) {
    console.log(JSON.stringify({ tabs, flowTab: flowTab || null }, null, 2));
    return;
  }
  console.log(`Found ${tabs.length} tab(s) on port ${args.port}:`);
  for (const t of tabs) {
    const marker = t === flowTab ? ' ← FLOW' : '';
    console.log(`  [${t.id?.slice(0, 8)}] ${t.title?.slice(0, 60) || '(no title)'}${marker}`);
    console.log(`    ${t.url}`);
  }
  if (!flowTab) {
    console.error('\nNo Flow tab found. Open https://labs.google/fx/tools/flow/project/... first.');
    process.exit(2);
  } else {
    console.log(`\nFlow tab OK: ${flowTab.url}`);
  }
}

async function cmdEval(args) {
  const [, ...rest] = args._;
  const expression = rest.join(' ');
  if (!expression) {
    console.error('Usage: i2v-cli eval "<javascript expression>"');
    process.exit(1);
  }
  const tab = await findFlowTab(args.port);
  const client = await attach(tab, args.port);
  try {
    if (args.mock) {
      const r = await installMockFetch(client);
      console.error(`[i2v-cli] mock 模式: i2v-server 请求将被拦截 (${r})`);
    }
    const world = args.world || 'main'; // eval defaults to main world
    const value = await evaluate(client, expression, { world });
    if (args.json) {
      console.log(JSON.stringify(value, null, 2));
    } else {
      console.log(value === undefined ? '(undefined)' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
    }
  } finally {
    await client.close();
  }
}

async function cmdCall(args) {
  const [, fnPath, ...callArgs] = args._;
  if (!fnPath) {
    console.error('Usage: i2v-cli call <functionName> [jsonArg1] [jsonArg2] ...');
    console.error('Example: i2v-cli call findGenerateBtn');
    console.error('         i2v-cli call processRow \'{"row_n":1,"prompt":"hi"}\'');
    process.exit(1);
  }
  const argsLiteral = callArgs.map(a => {
    try { JSON.parse(a); return a; } // already JSON
    catch { return JSON.stringify(a); } // treat as string
  }).join(', ');
  const expression = `
    (async () => {
      if (typeof window.__i2v === 'undefined') {
        return { __i2v_error: 'window.__i2v not defined. Did content.js load and export? Reload the Flow page.' };
      }
      const fn = window.__i2v[${JSON.stringify(fnPath)}];
      if (typeof fn !== 'function') {
        return { __i2v_error: 'window.__i2v.' + ${JSON.stringify(fnPath)} + ' is not a function. Available: ' + Object.keys(window.__i2v).join(', ') };
      }
      try {
        const result = await fn(${argsLiteral});
        if (result instanceof Element) {
          return {
            __i2v_kind: 'element',
            tag: result.tagName,
            id: result.id || null,
            class: result.className || null,
            text: (result.textContent || '').trim().slice(0, 200),
            visible: !!(result.offsetWidth || result.offsetHeight),
          };
        }
        if (Array.isArray(result)) {
          return { __i2v_kind: 'array', length: result.length, sample: result.slice(0, 3).map(x => x instanceof Element ? { tag: x.tagName, text: (x.textContent||'').trim().slice(0,80) } : x) };
        }
        return { __i2v_kind: 'value', value: result };
      } catch (e) {
        return { __i2v_error: e.message, stack: e.stack };
      }
    })()
  `;
  const tab = await findFlowTab(args.port);
  const client = await attach(tab, args.port);
  try {
    if (args.mock) {
      const r = await installMockFetch(client);
      console.error(`[i2v-cli] mock 模式: i2v-server 请求将被拦截 (${r})`);
    }
    // window.__i2v is defined in the content script's isolated world, not the
    // page's main world, so `call` must target the isolated context.
    const world = args.world || 'isolated';
    if (world === 'isolated' && !client.__i2v?.isolatedContextId) {
      console.error('[call error] No isolated world found. Is the i2v_extension loaded on this page? Try `i2v-cli contexts` to diagnose.');
      process.exit(4);
    }
    const value = await evaluate(client, expression, { world });
    if (args.json) {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    if (value?.__i2v_error) {
      console.error(`[call error] ${value.__i2v_error}`);
      if (value.stack) console.error(value.stack);
      process.exit(3);
    }
    console.log(JSON.stringify(value, null, 2));
  } finally {
    await client.close();
  }
}

async function cmdContexts(args) {
  const tab = await findFlowTab(args.port);
  const client = await attach(tab, args.port);
  try {
    if (args.mock) {
      const r = await installMockFetch(client);
      console.error(`[i2v-cli] mock 模式: i2v-server 请求将被拦截 (${r})`);
    }
    const info = client.__i2v;
    if (args.json) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    console.log(`Tab: ${tab.url}`);
    console.log(`Main world contextId: ${info.mainContextId ?? '(none)'}`);
    console.log(`Isolated world contextId: ${info.isolatedContextId ?? '(none)'}`);
    console.log(`All contexts (${info.contexts.length}):`);
    for (const c of info.contexts) {
      console.log(`  [${c.id}] type=${c.type} isDefault=${c.isDefault} name=${JSON.stringify(c.name)} origin=${c.origin}`);
    }
  } finally {
    await client.close();
  }
}

async function cmdHealth(args) {
  const tab = await findFlowTab(args.port);
  const client = await attach(tab, args.port);
  try {
    if (args.mock) {
      const r = await installMockFetch(client);
      console.error(`[i2v-cli] mock 模式: i2v-server 请求将被拦截 (${r})`);
    }
    if (!client.__i2v?.isolatedContextId) {
      console.error('[health error] No isolated world found. Is i2v_extension loaded? Try `i2v-cli contexts`.');
      process.exit(4);
    }
    // runHealthCheck lives on window.__i2v_health in the isolated world
    const expression = `
      (async () => {
        if (typeof window.__i2v_health === 'undefined') {
          return { __i2v_error: 'window.__i2v_health not defined. Reload the extension and refresh Flow page.' };
        }
        try {
          return await window.__i2v_health.runHealthCheck();
        } catch (e) {
          return { __i2v_error: e.message, stack: e.stack };
        }
      })()
    `;
    const report = await evaluate(client, expression, { world: 'isolated' });
    if (report?.__i2v_error) {
      console.error(`[health error] ${report.__i2v_error}`);
      if (report.stack) console.error(report.stack);
      process.exit(3);
    }
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHealthReport(report);
    }
    // Exit codes: 0 all ok, 1 has fallback warnings, 2 has failures
    if (report.failed > 0) process.exit(2);
    if (report.fallback > 0) process.exit(1);
    process.exit(0);
  } finally {
    await client.close();
  }
}

function printHealthReport(r) {
  const icons = { ok: '[OK]  ', fallback: '[WARN]', fail: '[FAIL]', skipped: '[SKIP]' };
  console.log(`[i2v health] version ${r.version}  pageKind=${r.pageKind || 'unknown'}`);
  const skippedNote = r.skipped ? `  |  ${r.skipped} skipped` : '';
  console.log(`${r.passed} ok  |  ${r.fallback} fallback  |  ${r.failed} failed${skippedNote}  (total ${r.total})`);
  console.log('');
  for (const d of r.details) {
    const icon = icons[d.status] || '[?]';
    let strat;
    if (d.status === 'skipped') {
      strat = d.skipReason || 'skipped';
    } else if (d.strategyIndex < 0) {
      strat = `all ${d.strategyCount} strategies miss`;
    } else {
      strat = `strategy ${d.strategyIndex}/${d.strategyCount - 1}`;
    }
    const elDesc = d.count != null
      ? `(${d.count} matches)`
      : d.elementTag
        ? `${d.elementTag} "${(d.elementText || '').slice(0, 50)}"`
        : d.status === 'skipped' ? '' : '(no element)';
    console.log(`${icon} ${d.key.padEnd(24)} [${strat}]  ${elDesc}`);
    if (d.status === 'fail' || d.status === 'fallback') {
      console.log(`     description: ${d.description}`);
      console.log(`     used by: ${d.usedBy.join(', ')}`);
    }
  }
  console.log('');
  if (r.failed > 0) {
    console.log(`WARNING: ${r.failed} selector(s) fully broken — Flow UI may have changed.`);
  } else if (r.fallback > 0) {
    console.log(`NOTE: ${r.fallback} selector(s) using fallback strategy — primary strategy may be stale.`);
  } else {
    console.log('All applicable selectors on primary strategy. Flow UI matches expectations.');
  }
}

async function cmdReload(args) {
  const port = args.port;
  // 1. List all service worker targets and find the i2v one by manifest name
  const targets = await CDP.List({ port });
  const swCandidates = targets.filter(t => t.type === 'service_worker' && (t.url || '').startsWith('chrome-extension://'));
  if (swCandidates.length === 0) {
    console.error('[reload] No extension service workers found.');
    process.exit(1);
  }
  let i2vSw = null;
  for (const sw of swCandidates) {
    let probeClient = null;
    try {
      probeClient = await CDP({ target: sw.webSocketDebuggerUrl, port });
      await probeClient.Runtime.enable();
      const { result } = await probeClient.Runtime.evaluate({
        expression: '(chrome && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().name) || ""',
        returnByValue: true,
      });
      const name = String(result?.value || '');
      if (/i2v|图生视频/i.test(name)) {
        i2vSw = sw;
        console.log(`[reload] found i2v service worker: name="${name}"`);
        // call chrome.runtime.reload() on this connection
        try {
          await probeClient.Runtime.evaluate({ expression: 'chrome.runtime.reload()', awaitPromise: false });
          console.log('[reload] chrome.runtime.reload() called');
        } catch (e) {
          // expected: SW connection drops mid-reload
        }
        break;
      }
    } catch (e) {
      // candidate didn't match — try next
    } finally {
      try { if (probeClient) await probeClient.close(); } catch {}
    }
  }
  if (!i2vSw) {
    console.error('[reload] No i2v service worker found among ' + swCandidates.length + ' extension SWs.');
    console.error('[reload] Probed names did not match /i2v|图生视频/i.');
    process.exit(2);
  }

  // 2. Wait for the SW to come back, then reload the Flow tab
  await new Promise(r => setTimeout(r, 2000));
  const tabs2 = await CDP.List({ port });
  const flow = tabs2.find(t => /labs\.google\/fx\/tools\/flow/.test(t.url || ''));
  if (!flow) {
    console.log('[reload] no Flow tab open, skipping page refresh');
    return;
  }
  const tabClient = await CDP({ target: flow.webSocketDebuggerUrl, port });
  try {
    await tabClient.Page.enable();
    await tabClient.Page.reload({ ignoreCache: false });
    console.log('[reload] Flow tab reloaded');
  } finally {
    try { await tabClient.close(); } catch {}
  }
}

async function cmdTest(args) {
  const [, module, ...rest] = args._;
  if (!module) {
    console.error('Usage: i2v-cli test <module> [args]');
    console.error('Modules: prompt | generate | cache | navigate | extend | download');
    console.error('Examples:');
    console.error('  i2v-cli test prompt --text "hello"');
    console.error('  i2v-cli test cache');
    console.error('  i2v-cli test navigate');
    console.error('  i2v-cli test generate');
    console.error('  i2v-cli test extend --uuid <uuid>');
    console.error('  i2v-cli test download --dry-run');
    process.exit(1);
  }
  // Parse extra args (--text "...", --uuid "...", --dry-run)
  const extra = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--text') extra.text = rest[++i];
    else if (rest[i] === '--uuid') extra.uuid = rest[++i];
    else if (rest[i] === '--dry-run') extra.dryRun = true;
  }

  const tab = await findFlowTab(args.port);
  const client = await attach(tab, args.port);
  try {
    if (args.mock) {
      const r = await installMockFetch(client);
      console.error(`[i2v-cli] mock 模式: i2v-server 请求将被拦截 (${r})`);
    }
    if (!client.__i2v?.isolatedContextId) {
      console.error('[test error] No isolated world found. Is i2v_extension loaded?');
      process.exit(4);
    }

    let expression;
    switch (module) {
      case 'prompt': {
        const text = extra.text || 'i2v-cli test ' + new Date().toISOString();
        expression = `
          (async () => {
            if (!window.__i2v_modules) return { error: 'window.__i2v_modules not found — reload extension' };
            const inj = await window.__i2v_modules.prompt.injectText(${JSON.stringify(text)});
            const read = window.__i2v_modules.prompt.read();
            const expectedSubstring = ${JSON.stringify(text)}.slice(0, 30);
            return {
              ok: inj.ok && read.ok && (read.text || '').includes(expectedSubstring),
              injected: inj,
              readBack: read,
              expectedSubstring,
            };
          })()
        `;
        break;
      }
      case 'generate':
        expression = `
          (async () => {
            if (!window.__i2v_modules) return { error: 'window.__i2v_modules not found — reload extension' };
            return window.__i2v_modules.generate.isReady();
          })()
        `;
        break;
      case 'cache':
        expression = `
          (async () => {
            if (!window.__i2v_modules) return { error: 'window.__i2v_modules not found — reload extension' };
            const data = window.__i2v_modules.cache.read();
            if (!data) return { ok: false, note: 'cache empty or unreadable on current Flow' };
            return {
              ok: true,
              videos: data.videos?.length ?? null,
              images: data.images?.length ?? null,
              workflowCount: data.workflowMap ? Object.keys(data.workflowMap).length : null,
            };
          })()
        `;
        break;
      case 'navigate':
        expression = `
          (async () => {
            if (!window.__i2v_modules) return { error: 'window.__i2v_modules not found — reload extension' };
            const uuids = window.__i2v_modules.navigate.listVideoCards();
            return { ok: true, count: uuids.length, uuids: uuids.slice(0, 10) };
          })()
        `;
        break;
      case 'extend': {
        if (!extra.uuid) {
          console.error('Usage: i2v-cli test extend --uuid <uuid>');
          process.exit(1);
        }
        expression = `
          (async () => {
            if (!window.__i2v_modules) return { error: 'window.__i2v_modules not found — reload extension' };
            return await window.__i2v_modules.extend.isExtended(${JSON.stringify(extra.uuid)});
          })()
        `;
        break;
      }
      case 'download':
        expression = `
          (async () => {
            if (!window.__i2v_modules) return { error: 'window.__i2v_modules not found — reload extension' };
            const url = await window.__i2v_modules.download.getUrl();
            return { ok: true, url, dryRun: ${extra.dryRun ? 'true' : 'false'} };
          })()
        `;
        break;
      default:
        console.error(`Unknown test module: ${module}`);
        process.exit(1);
    }

    const value = await evaluate(client, expression, { world: 'isolated' });
    if (args.json) {
      console.log(JSON.stringify(value, null, 2));
      return;
    }
    if (value?.error) {
      console.error('[test error] ' + value.error);
      process.exit(3);
    }
    console.log(`[test ${module}] ` + JSON.stringify(value, null, 2));
    if (value && value.ok === false) process.exit(1);
  } finally {
    await client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }
  const [cmd] = args._;
  try {
    switch (cmd) {
      case 'connect':
        await cmdConnect(args);
        break;
      case 'eval':
        await cmdEval(args);
        break;
      case 'call':
        await cmdCall(args);
        break;
      case 'contexts':
        await cmdContexts(args);
        break;
      case 'health':
        await cmdHealth(args);
        break;
      case 'reload':
        await cmdReload(args);
        break;
      case 'test':
        await cmdTest(args);
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.log(USAGE);
        process.exit(1);
    }
  } catch (e) {
    console.error(`[i2v-cli] ${e.message}`);
    process.exit(1);
  }
}

main();
