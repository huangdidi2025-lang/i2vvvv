# M2: 选择器数据化 + 健康检查 Implementation Plan

**Goal:** 让 Claude 通过 `i2v-cli health` 一键看出 Flow 改版了哪些 DOM 元素，不需要跑整个批处理也能定位。

**Architecture:** 追加（不重写）到 content.js 一张 `SELECTOR_RULES` 规则表、一个 `findByRules(key)` 多策略 fallback 查找器、一个 `runHealthCheck()` 聚合函数，全部挂到 `window.__i2v.health`。i2v-cli 加 `health` 子命令拉取结果。

**Scope clarification:**
- **In scope:** 11 个原子元素查找（findOpenDialogBtn / findDialog / findTextbox / findGenerateBtn / 等）
- **Out of scope:** 不改现有 `find*` 函数（保持向后兼容）、不重构 processRow / ensureModelSelection / extendVideo 里的算法式查找、不做热更新

**Hard constraints:**
- content.js 只追加，不动现有行
- 不新增 manifest 权限，不改 manifest.json
- 不碰 i2v-server
- TDD where applicable

---

## Task M2.1: 选择器规则表 + findByRules + runHealthCheck (content.js 追加)

**Files:**
- Modify: `i2v_extension/content.js` (APPEND ONLY after current line 1206)

**Spec:** Append a block that defines:

1. **`const SELECTOR_RULES`** — frozen object with ~11 keys, each with:
   - `description` — human-readable
   - `used_by` — array of function names where this is used in existing content.js
   - `strategies` — ordered array of detection strategies
   - Strategy types supported: `css` (CSS selector), `text` (tag + text match), `combo` (custom predicate that returns truthy element)

2. **`function findByRules(key)`** — tries each strategy in order, returns `{element, strategyIndex, strategyUsed}` or `null`

3. **`async function runHealthCheck()`** — iterates all keys, calls findByRules for each, returns summary:
   ```js
   {
     version: "m2-2026-04-06",
     total: 11,
     passed: N,      // strategyIndex === 0
     fallback: N,    // strategyIndex > 0 (primary strategy broken)
     failed: N,      // no strategy worked
     details: [
       {key, status: 'ok'|'fallback'|'fail', strategyIndex, strategyUsed, elementTag, elementText}
     ]
   }
   ```

4. Update `window.__i2v` to include a new `health` namespace with `{SELECTOR_RULES, findByRules, runHealthCheck}`. **IMPORTANT:** the existing `window.__i2v` is `Object.freeze`'d — cannot be mutated. Solution: add a second `window.__i2v_health = {...}` global instead. This avoids touching the existing frozen object.

### Rules to include (copy into SELECTOR_RULES)

```js
const SELECTOR_RULES = Object.freeze({
  open_upload_dialog_btn: {
    description: "底部输入栏旁的 + 按钮，打开上传对话框",
    used_by: ["findOpenDialogBtn", "processRow step 1"],
    strategies: [
      { type: "css", selector: 'button[aria-haspopup="dialog"]' },
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button[aria-haspopup]'))
          .find(b => { const t = b.textContent.toLowerCase(); return (t.includes('add') || t.includes('create')) && !t.includes('add media'); }) },
    ],
  },
  dialog: {
    description: "任意已打开的对话框",
    used_by: ["findDialog"],
    strategies: [
      { type: "css", selector: '[role="dialog"]' },
    ],
  },
  file_input: {
    description: "文件上传 <input type=file>",
    used_by: ["findFileInput"],
    strategies: [
      { type: "css", selector: 'input[type="file"][accept="image/*"]' },
      { type: "css", selector: 'input[type="file"]' },
    ],
  },
  prompt_textbox: {
    description: "主提示词输入框（Lexical contenteditable）",
    used_by: ["findTextbox", "processRow step 3"],
    strategies: [
      { type: "combo", fn: () => {
        const all = Array.from(document.querySelectorAll('[role="textbox"]'));
        return all.find(tb => tb.getAttribute('aria-label') !== 'Editable text' && tb.textContent.includes('What do you want to create?'));
      }},
      { type: "combo", fn: () => {
        const all = Array.from(document.querySelectorAll('[role="textbox"]'));
        return all.find(tb => tb.getAttribute('aria-multiline') === 'true' && tb.getAttribute('aria-label') !== 'Editable text');
      }},
      { type: "combo", fn: () => {
        const all = Array.from(document.querySelectorAll('[role="textbox"]'));
        const filtered = all.filter(tb => tb.getAttribute('aria-label') !== 'Editable text');
        return filtered[filtered.length - 1] || null;
      }},
    ],
  },
  generate_btn: {
    description: "生成按钮（arrow_forward 图标）",
    used_by: ["findGenerateBtn", "processRow step 4"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.includes('arrow_forward') && !b.disabled && b.getAttribute('aria-disabled') !== 'true') },
      { type: "text", tag: "button", contains: "Create", excludeDisabled: true },
    ],
  },
  ingredient_cancel_btn: {
    description: "Ingredient 取消按钮",
    used_by: ["findIngredientCancelBtn"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.trim() === 'cancel' || b.title === 'cancel') },
    ],
  },
  download_btn: {
    description: "下载按钮（edit 页）",
    used_by: ["findDownloadButton"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.toLowerCase().includes('download') && !b.disabled) },
    ],
  },
  extend_btn: {
    description: "延伸视频按钮（keyboard_double_arrow_right 图标）",
    used_by: ["findExtendButton", "extendVideo"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => b.textContent.toLowerCase().includes('extend')) },
    ],
  },
  video_card_links: {
    description: "视频卡片链接（非参考图卡）",
    used_by: ["getAllVideoCards", "clickVideoCardByUuid"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('a[href*="/edit/"]'))
          .filter(a => a.parentElement?.querySelectorAll('button').length > 0) },
    ],
    returnsArray: true,
  },
  model_selector_btn: {
    description: "模型选择按钮（Veo 3.1 - Fast dropdown）",
    used_by: ["ensureModelSelection"],
    strategies: [
      { type: "combo", fn: () => Array.from(document.querySelectorAll('button'))
          .find(b => { const t = b.textContent || ''; return (t.includes('Veo') || t.includes('Nano')) && t.includes('arrow_drop_down'); }) },
    ],
  },
  history_steps: {
    description: "编辑页的 history-step（判断是否已延伸）",
    used_by: ["checkVideoExtendedFromDOM"],
    strategies: [
      { type: "css", selector: '[id^="history-step-"]' },
    ],
    returnsArray: true,
  },
});
```

### findByRules implementation

```js
function findByRules(key) {
  const rule = SELECTOR_RULES[key];
  if (!rule) return { element: null, strategyIndex: -1, error: `unknown key: ${key}` };
  for (let i = 0; i < rule.strategies.length; i++) {
    const s = rule.strategies[i];
    let el = null;
    try {
      if (s.type === 'css') {
        el = rule.returnsArray
          ? Array.from(document.querySelectorAll(s.selector))
          : document.querySelector(s.selector);
      } else if (s.type === 'text') {
        const nodes = Array.from(document.querySelectorAll(s.tag || 'button'));
        el = nodes.find(n => {
          if (s.excludeDisabled && (n.disabled || n.getAttribute('aria-disabled') === 'true')) return false;
          const t = n.textContent || '';
          if (s.exact) return t.trim() === s.exact;
          if (s.contains) return t.includes(s.contains);
          return false;
        });
      } else if (s.type === 'combo' && typeof s.fn === 'function') {
        el = s.fn();
      }
    } catch (e) {
      // strategy threw — treat as miss, try next
      el = null;
    }
    const hit = rule.returnsArray ? (Array.isArray(el) && el.length > 0) : !!el;
    if (hit) {
      return { element: el, strategyIndex: i, strategyUsed: s.type };
    }
  }
  return { element: null, strategyIndex: -1 };
}

async function runHealthCheck() {
  const details = [];
  let passed = 0, fallback = 0, failed = 0;
  for (const key of Object.keys(SELECTOR_RULES)) {
    const res = findByRules(key);
    const rule = SELECTOR_RULES[key];
    let status, elementTag = null, elementText = null, count = null;
    if (res.strategyIndex < 0) {
      status = 'fail'; failed++;
    } else if (res.strategyIndex === 0) {
      status = 'ok'; passed++;
    } else {
      status = 'fallback'; fallback++;
    }
    if (res.element) {
      if (rule.returnsArray) {
        count = res.element.length;
        const first = res.element[0];
        if (first) {
          elementTag = first.tagName;
          elementText = (first.textContent || '').trim().slice(0, 80);
        }
      } else {
        elementTag = res.element.tagName;
        elementText = (res.element.textContent || '').trim().slice(0, 80);
      }
    }
    details.push({
      key,
      status,
      strategyIndex: res.strategyIndex,
      strategyUsed: res.strategyUsed || null,
      strategyCount: rule.strategies.length,
      elementTag,
      elementText,
      count,
      description: rule.description,
      usedBy: rule.used_by,
    });
  }
  return {
    version: "m2-2026-04-06",
    total: details.length,
    passed,
    fallback,
    failed,
    ok: failed === 0,
    details,
  };
}

// Expose health namespace as a separate global (window.__i2v is frozen and cannot be mutated)
window.__i2v_health = Object.freeze({
  SELECTOR_RULES,
  findByRules,
  runHealthCheck,
  __version: "m2-2026-04-06",
});
console.log("[i2v] window.__i2v_health exported, rules:", Object.keys(SELECTOR_RULES).length);
```

**Steps:**
1. Read current tail of content.js (lines 1200-1206) to find unique anchor
2. Append the block above after the last line
3. Verify: `wc -l` — should increase to ~1380
4. Verify: `node --check i2v_extension/content.js` — pass
5. Verify: existing `window.__i2v` untouched (grep `Object.freeze({` — should match twice now)
6. Regression: `cd i2v-cli && node --test test/cdp.test.js` — 4/4 pass

**User action:** reload extension + F5 Flow page

**Live verify (controller will do):** `i2v-cli eval "typeof window.__i2v_health" --world isolated` → `object`

**Commit:** `feat(i2v_extension): add SELECTOR_RULES + findByRules + runHealthCheck`

---

## Task M2.2: i2v-cli health subcommand

**Files:**
- Modify: `i2v-cli/bin/i2v-cli.js` (add `cmdHealth` + wire into switch + USAGE)

**Spec:** Add `cmdHealth(args)` that:
- Connects and attaches to isolated world
- Calls `window.__i2v_health.runHealthCheck()` via evaluate
- Prints human-readable report (default) or JSON (`--json`):
  ```
  [i2v health] version m2-2026-04-06
  ✅ 9 OK  ⚠ 2 fallback  ❌ 0 failed  (total 11)

  ✅ open_upload_dialog_btn    [strategy 0/2]  BUTTON "arrow_drop_downadd"
  ⚠ generate_btn              [strategy 1/2]  BUTTON "Create"  (primary strategy missed!)
  ❌ extend_btn                [all 1 strategies miss]
     description: 延伸视频按钮
     used by: findExtendButton, extendVideo
  ```
- Exits 0 if all ok, 1 if any fallback (warning), 2 if any failed

**Steps:**
1. Add `cmdHealth` after `cmdContexts`
2. Wire `case 'health': await cmdHealth(args); break;` in switch
3. Add `i2v-cli health` line to USAGE string
4. Syntax check: `node --check bin/i2v-cli.js`
5. Regression: `node --test test/`
6. Live test: `node bin/i2v-cli.js health` — should output report

**Commit:** `feat(i2v-cli): add health subcommand for selector drift detection`

---

## Acceptance

After both tasks commit, run:
```
cd i2v-cli
node bin/i2v-cli.js health
node bin/i2v-cli.js health --json | grep version
```

Expected: human report shows most elements ✅, no crashes. JSON contains `"version": "m2-2026-04-06"`.

## Rollback

If M2.1 breaks content.js (syntax error blocks extension load):
```
git reset --hard 103426f
```

If M2.2 breaks CLI:
```
git checkout 103426f -- i2v-cli/bin/i2v-cli.js
```
