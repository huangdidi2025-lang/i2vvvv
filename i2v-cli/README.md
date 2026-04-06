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
