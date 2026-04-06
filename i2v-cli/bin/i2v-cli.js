#!/usr/bin/env node
// i2v-cli entry point
import { listTabs, findFlowTab, attach, evaluate } from '../lib/cdp.js';

const USAGE = `
i2v-cli — CDP driver for i2v_extension

Usage:
  i2v-cli connect              List all tabs and highlight the Flow tab
  i2v-cli contexts             Show execution contexts (main + isolated worlds)
  i2v-cli health               Check which selectors still work (drift detection)
  i2v-cli eval <js>            Evaluate JS in the Flow tab (main world by default)
  i2v-cli call <fn> [args...]  Call window.__i2v.<fn>(...args) in the isolated world

Options:
  --port <n>                   CDP port (default 9222)
  --json                       Output JSON instead of human text
  --world <main|isolated>      Override execution world for eval/call

Examples:
  i2v-cli connect
  i2v-cli eval "document.title"
  i2v-cli call findGenerateBtn
`;

function parseArgs(argv) {
  const args = { _: [], port: 9222, json: false, world: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { args.port = parseInt(argv[++i], 10); }
    else if (a === '--json') { args.json = true; }
    else if (a === '--world') { args.world = argv[++i]; }
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
  const okIcon = '[OK]';
  const warnIcon = '[WARN]';
  const failIcon = '[FAIL]';
  console.log(`[i2v health] version ${r.version}`);
  console.log(`${r.passed} ok  |  ${r.fallback} fallback  |  ${r.failed} failed  (total ${r.total})`);
  console.log('');
  for (const d of r.details) {
    const icon = d.status === 'ok' ? okIcon : d.status === 'fallback' ? warnIcon : failIcon;
    const strat = d.strategyIndex < 0
      ? `all ${d.strategyCount} strategies miss`
      : `strategy ${d.strategyIndex}/${d.strategyCount - 1}`;
    const elDesc = d.count != null
      ? `(${d.count} matches)`
      : d.elementTag
        ? `${d.elementTag} "${(d.elementText || '').slice(0, 50)}"`
        : '(no element)';
    console.log(`${icon} ${d.key.padEnd(24)} [${strat}]  ${elDesc}`);
    if (d.status !== 'ok') {
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
    console.log('All selectors on primary strategy. Flow UI matches expectations.');
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
