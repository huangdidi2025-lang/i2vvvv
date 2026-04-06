#!/usr/bin/env node
// i2v-cli entry point
import { listTabs, findFlowTab } from '../lib/cdp.js';

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
      case 'call':
        console.error(`[i2v-cli] '${cmd}' not yet implemented (Task 4)`);
        process.exit(1);
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
