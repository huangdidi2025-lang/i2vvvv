// Service Worker / sidepanel console + state monitor.
// Polls extension SW state.logs every 3s and prints new entries.
import CDP from 'chrome-remote-interface';

const POLL_MS = 3000;

async function findSwTarget(port) {
  const targets = await CDP.List({ port });
  // Look for the i2v service worker
  return targets.find(t => t.type === 'service_worker' && /iobbhjboelobcfjkgfggcinhgncliblj/.test(t.url || ''));
}

async function findSidepanelTarget(port) {
  const targets = await CDP.List({ port });
  return targets.find(t => (t.url || '').includes('sidepanel.html'));
}

async function main() {
  const port = 9222;
  let lastLogIdx = 0;
  let lastPhase = null;
  let lastRunning = null;

  while (true) {
    try {
      const sp = await findSidepanelTarget(port);
      if (!sp) { process.stdout.write('[sw-mon] no sidepanel tab\n'); await sleep(POLL_MS); continue; }
      const c = await CDP({ target: sp.webSocketDebuggerUrl });
      await c.Runtime.enable();
      // Poll background SW state via msg
      const r = await c.Runtime.evaluate({
        expression: `(async()=>{const s=await chrome.runtime.sendMessage({action:'get_status'});return s})()`,
        awaitPromise: true, returnByValue: true,
      });
      await c.close();
      const st = r.result?.value;
      if (st && st.logs) {
        if (st.phase !== lastPhase || st.running !== lastRunning) {
          process.stdout.write(`[sw-mon ${ts()}] phase=${st.phase} running=${st.running} done=${st.doneCount} err=${st.errorCount}\n`);
          lastPhase = st.phase; lastRunning = st.running;
        }
        const newLogs = st.logs.slice(lastLogIdx);
        for (const line of newLogs) process.stdout.write(`[sw ${ts()}] ${line}\n`);
        lastLogIdx = st.logs.length;
      }
    } catch (e) {
      process.stdout.write(`[sw-mon ${ts()}] err: ${e.message}\n`);
    }
    await sleep(POLL_MS);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }

main().catch(e => { console.error(e); process.exit(1); });
