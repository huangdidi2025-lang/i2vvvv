#!/usr/bin/env node
// i2v-cli entry point
import { listTabs, findFlowTab, attach, evaluate } from '../lib/cdp.js';

const USAGE = `
i2v-cli — CDP driver for i2v_extension

Usage:
  i2v-cli connect              List all tabs and highlight the Flow tab
  i2v-cli eval <js>            Evaluate JavaScript in the Flow tab
  i2v-cli call <fn> [args...]  Call window.__i2v.<fn>(...args) in the Flow tab

Options:
  --port <n>                   CDP port (default 9222)
  --json                       Output JSON instead of human text

Examples:
  i2v-cli connect
  i2v-cli eval "document.title"
  i2v-cli call findGenerateBtn
`;

function parseArgs(argv) {
  const args = { _: [], port: 9222, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') { args.port = parseInt(argv[++i], 10); }
    else if (a === '--json') { args.json = true; }
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
    const value = await evaluate(client, expression);
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
    const value = await evaluate(client, expression);
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
