# M1: CDP 通路打通 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Claude drive the user's already-logged-in Chrome via CDP to query and call functions on the Flow page, without touching production backend or existing extension logic.

**Architecture:** Start Chrome with `--remote-debugging-port=9222`. Build a Node.js CLI (`i2v-cli`) that uses `chrome-remote-interface` to connect, find the Flow tab, and execute JavaScript in its context. Add a single appended block to `content.js` that exports existing functions onto `window.__i2v` — zero logic change.

**Tech Stack:** Node.js (>=18), `chrome-remote-interface` npm package, Chrome DevTools Protocol, existing Chrome MV3 extension.

**Design doc:** `docs/plans/2026-04-06-cdp-driven-i2v-design.md`

**Hard constraints (must not violate):**
- Do NOT modify `i2v-server/` directory
- Do NOT send any request to `https://i2v-server.vercel.app`
- Do NOT change any existing function in `content.js` — only append the export block at the end
- Do NOT change `manifest.json` permissions, background.js, popup.js, or any existing extension file except the single append to `content.js`

---

## Task 0: Pre-flight checks

**Files:** none (verification only)

**Step 1:** Verify Node.js version

Run: `node --version`
Expected: `v18.x` or higher. If lower, stop and ask user to upgrade.

**Step 2:** Verify working directory

Run: `pwd` (or equivalent) — should print `d:\i2v-tool` or similar.

**Step 3:** Verify `i2v_extension/content.js` exists

Run: `ls i2v_extension/content.js`
Expected: file exists.

**Step 4:** Verify `i2v-cli/` does NOT yet exist

Run: `ls i2v-cli 2>/dev/null || echo "not exists"`
Expected: `not exists`. If it exists, stop and ask user what to do.

---

## Task 1: Create i2v-cli package skeleton

**Files:**
- Create: `i2v-cli/package.json`
- Create: `i2v-cli/.gitignore`
- Create: `i2v-cli/README.md`

**Step 1:** Create `i2v-cli/package.json`

```json
{
  "name": "i2v-cli",
  "version": "0.1.0",
  "private": true,
  "description": "CDP driver CLI for debugging i2v_extension on Google Flow",
  "type": "module",
  "bin": {
    "i2v-cli": "./bin/i2v-cli.js"
  },
  "scripts": {
    "start": "node bin/i2v-cli.js",
    "test": "node --test test/"
  },
  "dependencies": {
    "chrome-remote-interface": "^0.33.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

**Step 2:** Create `i2v-cli/.gitignore`

```
node_modules/
*.log
.DS_Store
```

**Step 3:** Create `i2v-cli/README.md`

```markdown
# i2v-cli

CDP driver CLI for debugging `i2v_extension` on Google Flow. Lets Claude (or a developer) query DOM and call exported functions on the Flow page from a terminal.

**Not shipped to end users.** This is a local developer tool only.

## Prerequisites

1. Node.js >= 18
2. Chrome started with remote debugging enabled (see "Chrome setup" below)
3. `i2v_extension` loaded in Chrome and the user is on a Flow project page

## Install

```
cd i2v-cli
npm install
```

## Chrome setup (Windows)

1. Right-click your Chrome desktop shortcut → Properties
2. In "Target" field, append ` --remote-debugging-port=9222` after the closing quote of `chrome.exe`. Example:

   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
   ```

3. Click OK. Close all Chrome windows. Launch from this shortcut.
4. Verify: open http://localhost:9222/json/version — should return JSON.

**Note:** Only use this shortcut when debugging. The port is localhost-only but avoid on shared machines.

## Usage

```
# Connect and list tabs, auto-detect Flow tab
node bin/i2v-cli.js connect

# Evaluate JavaScript in Flow tab
node bin/i2v-cli.js eval "document.title"

# Call a function exported on window.__i2v
node bin/i2v-cli.js call findGenerateBtn
node bin/i2v-cli.js call findTextbox
```

## Safety

- This CLI never sends requests to `i2v-server.vercel.app`
- It only reads/executes in the already-open Flow tab
- No data is sent outside your machine
```

**Step 4:** Install dependency

Run: `cd i2v-cli && npm install`
Expected: `node_modules/` created, `chrome-remote-interface` present, no errors.

**Step 5:** Verify install

Run: `ls i2v-cli/node_modules/chrome-remote-interface/package.json`
Expected: file exists.

**Step 6:** Commit

```bash
git add i2v-cli/package.json i2v-cli/.gitignore i2v-cli/README.md i2v-cli/package-lock.json
git commit -m "feat(i2v-cli): add package skeleton with chrome-remote-interface dep"
```

(Skip commit if repo has no git history — design doc noted project is not a git repo. Check with `git status` first; if "not a git repository" error, skip all commit steps in this plan.)

---

## Task 2: CDP connection library

**Files:**
- Create: `i2v-cli/lib/cdp.js`
- Create: `i2v-cli/test/cdp.test.js`

**Step 1:** Write failing test first

Create `i2v-cli/test/cdp.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { isFlowTab } from '../lib/cdp.js';

test('isFlowTab: matches Flow project URL', () => {
  assert.strictEqual(isFlowTab({ url: 'https://labs.google/fx/tools/flow/project/abc123' }), true);
});

test('isFlowTab: matches Flow tools path', () => {
  assert.strictEqual(isFlowTab({ url: 'https://labs.google/fx/tools/flow' }), true);
});

test('isFlowTab: rejects non-Flow tabs', () => {
  assert.strictEqual(isFlowTab({ url: 'https://google.com' }), false);
  assert.strictEqual(isFlowTab({ url: 'https://labs.google/other' }), false);
});

test('isFlowTab: rejects tabs without url', () => {
  assert.strictEqual(isFlowTab({}), false);
  assert.strictEqual(isFlowTab(null), false);
});
```

**Step 2:** Run test and verify it fails

Run: `cd i2v-cli && node --test test/cdp.test.js`
Expected: FAIL — `Cannot find module '../lib/cdp.js'`

**Step 3:** Implement `i2v-cli/lib/cdp.js`

```js
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
```

**Step 4:** Run test and verify it passes

Run: `cd i2v-cli && node --test test/cdp.test.js`
Expected: all 4 tests pass.

**Step 5:** Commit

```bash
git add i2v-cli/lib/cdp.js i2v-cli/test/cdp.test.js
git commit -m "feat(i2v-cli): add CDP connection helpers with isFlowTab unit tests"
```

---

## Task 3: CLI entry point with `connect` command

**Files:**
- Create: `i2v-cli/bin/i2v-cli.js`

**Step 1:** Implement CLI entry with only the `connect` subcommand

Create `i2v-cli/bin/i2v-cli.js`:

```js
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
```

**Step 2:** Verify file runs (help output)

Run: `cd i2v-cli && node bin/i2v-cli.js --help`
Expected: prints USAGE, exits 0.

**Step 3:** Verify unknown command handling

Run: `cd i2v-cli && node bin/i2v-cli.js foo; echo "exit=$?"`
Expected: prints `Unknown command: foo`, exit code 1.

**Step 4:** Verify connect error when Chrome not running with debug port

(Only if user confirms Chrome is NOT currently on port 9222)

Run: `cd i2v-cli && node bin/i2v-cli.js connect`
Expected: error message about "Cannot connect to Chrome debug port 9222", exit 1.

**STOP HERE AND ASK THE USER:**

> "Task 3 done. Before I can test connect/eval/call for real, you need to:
> 1. Close all Chrome windows
> 2. Launch Chrome from a shortcut with `--remote-debugging-port=9222` appended to the target
> 3. Open a Flow project page (https://labs.google/fx/tools/flow/project/...)
> 4. Make sure i2v_extension is loaded
>
> Once done, tell me and I'll continue."

**Step 5:** After user confirms, run connect for real

Run: `cd i2v-cli && node bin/i2v-cli.js connect`
Expected: prints tab list, shows "← FLOW" next to Flow tab, prints `Flow tab OK: ...`.

If failure, diagnose before proceeding:
- Port unreachable → shortcut not set up correctly
- Tab list empty → Chrome not running
- No Flow tab → user hasn't opened Flow page

**Step 6:** Commit

```bash
git add i2v-cli/bin/i2v-cli.js
git commit -m "feat(i2v-cli): add bin entry with connect subcommand"
```

---

## Task 4: `eval` and `call` subcommands

**Files:**
- Modify: `i2v-cli/bin/i2v-cli.js`

**Step 1:** Add `cmdEval` and `cmdCall` functions to `bin/i2v-cli.js`

Modify `bin/i2v-cli.js`:

At the top, expand the import:
```js
import { listTabs, findFlowTab, attach, evaluate } from '../lib/cdp.js';
```

Add these two functions after `cmdConnect`:

```js
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
  // Build: window.__i2v && typeof window.__i2v.<fn> === 'function'
  //        ? (async () => { const r = await window.__i2v.<fn>(...args); return serializeResult(r); })()
  //        : { error: 'window.__i2v.<fn> not available' }
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
        // Serialize: DOM elements become {tag, id, class, text, visible}
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
```

In the `switch (cmd)` block, replace the `eval`/`call` case stubs with real calls:

```js
      case 'eval':
        await cmdEval(args);
        break;
      case 'call':
        await cmdCall(args);
        break;
```

**Step 2:** Verify eval works with a trivial expression

Run: `cd i2v-cli && node bin/i2v-cli.js eval "document.title"`
Expected: prints the Flow tab's title (something like `Flow — Google Labs`).

**Step 3:** Verify eval handles errors cleanly

Run: `cd i2v-cli && node bin/i2v-cli.js eval "thisIsNotDefined"`
Expected: exits 1 with error message "Evaluation failed: ReferenceError: thisIsNotDefined is not defined".

**Step 4:** Verify call correctly errors when `window.__i2v` not defined yet

Run: `cd i2v-cli && node bin/i2v-cli.js call findGenerateBtn`
Expected: `[call error] window.__i2v not defined...` (because Task 5 hasn't run yet to define it).

**Step 5:** Commit

```bash
git add i2v-cli/bin/i2v-cli.js
git commit -m "feat(i2v-cli): add eval and call subcommands with DOM element serialization"
```

---

## Task 5: Export existing content.js functions to window.__i2v

**Files:**
- Modify: `i2v_extension/content.js` (append only, do NOT touch lines 1-1153)

**Critical rule:** Do NOT modify any existing line in content.js. Only append a new block at the end. If any existing line is touched the task fails.

**Step 1:** Re-verify the current line count

Run: `wc -l i2v_extension/content.js`
Expected: `1153 i2v_extension/content.js`. If different, stop and re-read the file to understand what changed.

**Step 2:** Verify the set of functions currently defined at top level

Run: `grep -nE "^(async )?function " i2v_extension/content.js`

Confirm these exist (list known from earlier exploration):
- `simulateClick`, `waitFor`, `_findQueryClient`, `_getProjectQuery`, `refreshProjectCache`, `getProjectDataFromCache`
- `findOpenDialogBtn`, `findDialog`, `findUploadBtnInDialog`, `findFileInput`, `findTextbox`, `findGenerateBtn`, `findIngredientCancelBtn`, `findDownloadButton`
- `smartClick`, `ensureFlowSettings`, `processRow`
- `clickCardKebab`, `getAllVideoCards`, `getEditPagePrompt`, `clickVideoCardByUuid`
- `getVideoUrl`, `clickDownload`, `checkVideoExtended`, `checkVideoExtendedFromDOM`
- `findExtendButton`, `ensureModelSelection`, `extendVideo`, `clickDoneButton`, `navigateBack`
- `injectRegenButtons`

**Step 3:** Append the export block to `i2v_extension/content.js`

Use the Edit tool to append (find a unique anchor at end of file). First read the last ~10 lines to find a safe unique anchor:

Run: `tail -15 i2v_extension/content.js` (use Read tool with offset)

Then append this block after the last existing line:

```js

// ═══════════════════════════════════════════════════════════════════════════
// Developer-mode exports for i2v-cli (CDP driver)
// This block is intentionally appended at the very end and MUST NOT be relied
// upon by production code paths. It only exposes existing functions on a
// namespaced global so that a developer (or Claude via i2v-cli) can call them
// from Chrome DevTools Protocol without going through chrome.runtime messaging.
//
// Safe to strip for a production build by deleting everything below this line.
// ═══════════════════════════════════════════════════════════════════════════
try {
  window.__i2v = Object.freeze({
    // selectors (pure DOM queries, no side effects beyond the query itself)
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

    // actions (careful: these have side effects on the Flow page)
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
```

**Step 4:** Verify file line count increased (and existing lines untouched)

Run: `wc -l i2v_extension/content.js`
Expected: ~1200 lines (1153 + appended block). Should be strictly greater than 1153.

**Step 5:** Verify the append syntactically parses by reading last 50 lines

Use Read tool on `i2v_extension/content.js` with `offset: 1150` — confirm the original ending is intact and the new block follows cleanly.

**Step 6:** Sanity-check that nothing before line 1153 changed

Run: `grep -n "injectRegenButtons" i2v_extension/content.js`
Expected: still appears at line 1091 (the same line as before).

Run: `grep -n "chrome.runtime.onMessage.addListener" i2v_extension/content.js`
Expected: still at line 901.

**Step 7:** STOP AND ASK USER TO RELOAD EXTENSION

> "Task 5 code done. Please:
> 1. Go to chrome://extensions/
> 2. Click the reload icon on 'I2V 图生视频'
> 3. Refresh the Flow project tab (F5)
> 4. Open the Flow tab's DevTools console and verify you see `[i2v] window.__i2v exported for i2v-cli, keys: N`
> 5. Tell me when done."

**Step 8:** After user confirms, verify from CLI side

Run: `cd i2v-cli && node bin/i2v-cli.js eval "typeof window.__i2v"`
Expected: prints `object`.

Run: `cd i2v-cli && node bin/i2v-cli.js eval "window.__i2v.__keys()"`
Expected: prints a JSON array containing at least `findGenerateBtn`, `findTextbox`, `processRow`, etc.

**Step 9:** Call a pure-query function end to end

Run: `cd i2v-cli && node bin/i2v-cli.js call findGenerateBtn`
Expected output shape:
```json
{
  "__i2v_kind": "element",
  "tag": "BUTTON",
  "text": "... arrow_forward ...",
  "visible": true
}
```
OR (if not on a page with the generate button currently):
```json
{
  "__i2v_kind": "value",
  "value": null
}
```

Either is acceptable — both prove the CLI → CDP → extension export chain works.

**Step 10:** Call another query function for a second data point

Run: `cd i2v-cli && node bin/i2v-cli.js call findTextbox`
Expected: similar — either an element descriptor or `null` value.

**Step 11:** Commit

```bash
git add i2v_extension/content.js
git commit -m "feat(i2v_extension): export existing functions on window.__i2v for i2v-cli access"
```

---

## Task 6: Final acceptance and documentation update

**Files:**
- Modify: `i2v-cli/README.md` (add "verified" section)
- Modify: `docs/plans/2026-04-06-m1-cdp-bootstrap.md` (mark complete)

**Step 1:** Acceptance checklist — run each and record the output

Run these 5 commands from the repo root and paste outputs into the summary:

1. `cd i2v-cli && node bin/i2v-cli.js --help` — should print USAGE
2. `cd i2v-cli && node bin/i2v-cli.js connect` — should show Flow tab with "← FLOW" marker
3. `cd i2v-cli && node bin/i2v-cli.js eval "document.title"` — should print Flow page title
4. `cd i2v-cli && node bin/i2v-cli.js eval "window.__i2v.__version"` — should print `m1-2026-04-06`
5. `cd i2v-cli && node bin/i2v-cli.js call findGenerateBtn` — should print element JSON or null

**Step 2:** Hard-constraint verification

Grep to ensure no production backend references were introduced:

Run: `grep -r "i2v-server.vercel.app" i2v-cli/`
Expected: no matches.

Run: `grep -r "firebase" i2v-cli/ -i`
Expected: no matches.

**Step 3:** Regression check — existing extension still works

Ask user:
> "Please do a quick smoke test: reload the extension, open the side panel, try clicking any existing button (e.g. 'generate prompts' or 'start batch'). Confirm the existing flow still works as before. Tell me pass/fail."

If FAIL → stop, investigate which line of Task 5's append broke it (most likely a function name mismatch).

**Step 4:** Update `i2v-cli/README.md` — add a "## Verified" section near the top:

```markdown
## Verified

- M1 completed on 2026-04-06
- Verified commands: `connect`, `eval`, `call`
- Verified against `content.js` export version `m1-2026-04-06`
```

**Step 5:** Commit final state

```bash
git add i2v-cli/README.md
git commit -m "docs(i2v-cli): mark M1 verified"
```

**Step 6:** Report M1 complete to user

Print a summary:
- Files created: `i2v-cli/package.json`, `i2v-cli/.gitignore`, `i2v-cli/README.md`, `i2v-cli/lib/cdp.js`, `i2v-cli/test/cdp.test.js`, `i2v-cli/bin/i2v-cli.js`
- Files modified: `i2v_extension/content.js` (appended export block only)
- Files NOT touched: `background.js`, `popup.js`, `manifest.json`, `i2v-server/`, anything in Firebase
- What Claude can now do: query Flow DOM, call any of ~25 exported functions, all without user intervention beyond Chrome reload

> "M1 complete. Ready for review. Next stop: M2 (selectors.json + health check) — but only after you confirm M1 is stable."

---

## Rollback procedure (if anything breaks the user's existing extension)

If the user reports the extension is broken after Task 5:

1. Read last 60 lines of `i2v_extension/content.js`
2. Remove the entire appended `// ═══...` block back to but not including the original last line
3. Verify `wc -l` shows 1153 again
4. Ask user to reload extension and retest
5. Investigate root cause before retrying (most likely: referenced a function name that doesn't exist in content.js)

## What this plan does NOT do (explicit non-goals)

- Does not modify `background.js`, `popup.js`, `sidepanel.html`, `manifest.json`, or any file in `i2v-server/`
- Does not extract selectors to JSON (M2)
- Does not split content.js into modules (M3)
- Does not implement Mock mode fetch interception (M3)
- Does not implement hot-reload
- Does not send any request to production backend
