// Long-running Flow monitor.
// Polls the Flow tab every POLL_MS via CDP, detects state changes, prints
// timestamped events to stdout and writes a snapshot to monitor-state.json.
//
// Usage (background): launched by Claude via Bash run_in_background.
// Stop: kill the process or send SIGINT.

import { findFlowTab, attach, evaluate } from './lib/cdp.js';
import { writeFileSync } from 'node:fs';

const POLL_MS = 15000;
const HEALTH_EVERY_N_POLLS = 20; // health check every 20 polls = 5 min
const STATE_FILE = new URL('./monitor-state.json', import.meta.url);

const probe = `
(() => {
  const cards = Array.from(document.querySelectorAll('a[href*="/edit/"]'));
  const uuids = cards.map(a => a.href.split('/').pop());
  const failedDivs = Array.from(document.querySelectorAll('div'))
    .filter(d => d.textContent.trim() === 'Failed' && d.children.length === 0);
  // Try to associate failed labels with cards (best effort: each failed label
  // sits inside a card container, so count is enough for change detection)
  const failedCount = failedDivs.length;
  // Collect any toaster / sonner notifications
  const toasts = Array.from(document.querySelectorAll('[data-sonner-toast], [role="status"]'))
    .map(t => (t.textContent || '').trim().slice(0, 200))
    .filter(Boolean);
  // Generate button state (enabled = ready for next prompt)
  const genBtn = Array.from(document.querySelectorAll('button'))
    .find(b => b.textContent.includes('arrow_forward'));
  const genState = genBtn ? {
    text: genBtn.textContent.slice(0, 30),
    disabled: genBtn.disabled || genBtn.getAttribute('aria-disabled') === 'true',
  } : null;
  return {
    url: location.href,
    cardCount: cards.length,
    uuids,
    failedCount,
    toasts,
    genState,
    title: document.title,
  };
})()
`;

const healthProbe = `
(async () => {
  if (typeof window.__i2v_health === 'undefined') return { error: 'no __i2v_health' };
  return await window.__i2v_health.runHealthCheck();
})()
`;

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function log(level, msg, extra) {
  const line = `[${ts()}] ${level} ${msg}` + (extra ? ' ' + JSON.stringify(extra) : '');
  console.log(line);
}

function shallowEqArr(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let prev = null;
let pollCount = 0;
let lastHealth = null;

async function tick(client) {
  pollCount++;
  let snap;
  try {
    snap = await evaluate(client, probe, { world: 'isolated' });
  } catch (e) {
    log('ERR', 'probe failed', { msg: e.message });
    return;
  }

  const events = [];

  if (!prev) {
    events.push(`init: ${snap.cardCount} cards, ${snap.failedCount} failed`);
  } else {
    if (snap.cardCount !== prev.cardCount) {
      events.push(`card_count: ${prev.cardCount} -> ${snap.cardCount}`);
    }
    if (!shallowEqArr(snap.uuids, prev.uuids)) {
      const added = snap.uuids.filter(u => !prev.uuids.includes(u));
      const removed = prev.uuids.filter(u => !snap.uuids.includes(u));
      if (added.length) events.push(`new_uuid: ${added.map(u => u.slice(0, 8)).join(',')}`);
      if (removed.length) events.push(`gone_uuid: ${removed.map(u => u.slice(0, 8)).join(',')}`);
    }
    if (snap.failedCount !== prev.failedCount) {
      const dir = snap.failedCount > prev.failedCount ? 'INCREASED' : 'decreased';
      events.push(`failed_label: ${prev.failedCount} -> ${snap.failedCount} (${dir})`);
    }
    if (snap.url !== prev.url) {
      events.push(`navigated: ${prev.url.slice(-40)} -> ${snap.url.slice(-40)}`);
    }
    if (snap.genState?.disabled !== prev.genState?.disabled) {
      events.push(`generate_btn: disabled=${snap.genState?.disabled}`);
    }
    // New toasts (toasts that weren't in prev)
    const newToasts = snap.toasts.filter(t => !prev.toasts.includes(t));
    for (const t of newToasts) events.push(`toast: ${t.slice(0, 100)}`);
  }

  if (events.length) {
    for (const e of events) log('EVENT', e);
  } else {
    log('tick', `${pollCount} cards=${snap.cardCount} failed=${snap.failedCount}`);
  }

  // Periodic health check
  if (pollCount % HEALTH_EVERY_N_POLLS === 0) {
    try {
      const h = await evaluate(client, healthProbe, { world: 'isolated' });
      if (h?.error) {
        log('WARN', 'health unavailable: ' + h.error);
      } else {
        log('HEALTH', `${h.passed} ok / ${h.fallback} fallback / ${h.failed} failed (total ${h.total})`);
        if (lastHealth) {
          const drift = h.details.filter(d => {
            const old = lastHealth.details.find(o => o.key === d.key);
            return old && old.status !== d.status;
          });
          for (const d of drift) {
            const oldStatus = lastHealth.details.find(o => o.key === d.key).status;
            log('DRIFT', `${d.key}: ${oldStatus} -> ${d.status}`);
          }
        }
        lastHealth = h;
      }
    } catch (e) {
      log('ERR', 'health probe failed: ' + e.message);
    }
  }

  prev = snap;

  // Persist state
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      lastTick: new Date().toISOString(),
      pollCount,
      snap,
      lastHealth,
    }, null, 2));
  } catch (e) {
    log('ERR', 'state write failed: ' + e.message);
  }
}

async function main() {
  log('INFO', `monitor starting, poll every ${POLL_MS}ms, health every ${HEALTH_EVERY_N_POLLS} polls`);
  let tab, client;
  try {
    tab = await findFlowTab();
    client = await attach(tab);
    log('INFO', `attached to ${tab.url.slice(-50)}`);
  } catch (e) {
    log('FATAL', 'attach failed: ' + e.message);
    process.exit(1);
  }

  let stopping = false;
  process.on('SIGINT', () => { log('INFO', 'SIGINT, stopping'); stopping = true; });
  process.on('SIGTERM', () => { log('INFO', 'SIGTERM, stopping'); stopping = true; });

  while (!stopping) {
    try {
      await tick(client);
    } catch (e) {
      log('ERR', 'tick crashed: ' + e.message);
      // Try to reconnect
      try {
        await client.close();
      } catch {}
      try {
        tab = await findFlowTab();
        client = await attach(tab);
        log('INFO', 're-attached to ' + tab.url.slice(-50));
      } catch (re) {
        log('FATAL', 'reattach failed: ' + re.message);
        await new Promise(r => setTimeout(r, 30000));
        continue;
      }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  try { await client.close(); } catch {}
  log('INFO', 'monitor stopped cleanly');
  process.exit(0);
}

main().catch(e => {
  log('FATAL', 'main crashed: ' + e.message);
  console.error(e.stack);
  process.exit(1);
});
