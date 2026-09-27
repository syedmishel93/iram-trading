# IRAM Terminal — desktop

A native window around the same `app/dist/index.html` the browser build ships.
Tauri, not Electron: it uses the operating system's own webview instead of
bundling a second copy of Chromium, so the installer is single-digit megabytes
rather than two hundred, and the terminal does not run a browser engine of its
own that then needs its own security updates.

## Why bother, when the web build is one self-contained file

Not for the window frame. Three capabilities a browser tab cannot have.

### 1. The venue's own rate-limit counter becomes readable

This is the one that matters.

Binance returns `x-mbx-used-weight-1m` on every response — how much of your
1200-weight minute you have actually spent, according to the exchange. **A
browser cannot read it.** The header is on the wire, but without an
`Access-Control-Expose-Headers` naming it, the fetch specification hides it from
page script. This was measured, not assumed: the only headers readable from
`api.binance.com` in a tab are `cache-control`, `content-length`,
`content-type`, `expires` and `pragma`.

So the web build runs the request governor on a **local estimate**, deliberately
sized at a third of the published ceiling, and the Data desk says so rather than
showing a counter stuck at zero.

Requests issued from Rust are not subject to CORS at all. In the desktop build
the governor can read what the exchange thinks you have spent, which is the
difference between believing you are inside the limit and knowing it.

### 2. Nothing closes the tab

The alert engine and the retention sweep run for as long as the terminal is
open. In a browser that is until somebody tidies their windows.

### 3. The window remembers itself

Size and position persist. A second launch focuses the running window rather
than starting a rival copy — two terminals against one IndexedDB origin would
fight over the same archive and the same alert book.

## Building

```bash
cd desktop && npm install && npm run build
```

`npm run build` rebuilds the web bundle first, then compiles the shell and
produces an installer. For just the executable, skipping the installer:

```bash
npm run build:quick
```

Development, with hot reload against the Vite dev server:

```bash
npm run dev
```

Requires a Rust toolchain (`rustup`), and on Windows the WebView2 runtime, which
ships with Windows 10 21H2 and later.

## What this process deliberately cannot do

The capability allow-list in `src-tauri/capabilities/default.json` is the entire
privilege surface, and it is short on purpose:

- **No shell command permission.** The process cannot run anything.
- **No general filesystem permission.** Downloads go through the webview's own
  save flow, the same as in a browser.
- **An HTTP scope naming specific hosts** — the market-data endpoints, the two
  local service ports, and the model endpoints. Nothing else is reachable, so a
  compromised page cannot use the CORS-free HTTP client as an open proxy.
- **No order, position, wallet or credential capability of any kind.** The same
  guarantee the web build makes, enforced the same structural way: the
  capability does not exist in the process, so there is no policy for anything
  to argue its way around.

The Content Security Policy in `tauri.conf.json` lists every origin the page may
reach. Adding a data source means adding it there as well as to the capability
file — deliberately two places, because widening what the terminal can talk to
should be a decision rather than a side effect.
