# How to run — every platform

> **Two terminals live in this repository and this page covers both.** The
> current one is `app/`, it builds to `app/dist/index.html`, and `run.py` serves
> it. `index.html` in the repository root is the **frozen v39.29** terminal —
> still openable, still frozen, see `LEGACY.md`. The mobile and hosting sections
> below are about that single self-contained file; the desktop section is about
> the current product.

---

## Windows · macOS · Linux (desktop)

**One command, any OS:**

```bash
python run.py
```

That is the whole thing. It opens `http://127.0.0.1:8787` — the terminal AND the
whole backend (bars, quotes, the store, alerts, news, the models, live
streaming), one process, one port. `Ctrl+C` stops it.

```bash
python run.py --status       # what is already running, start nothing
python run.py --port 9000    # when 8787 is taken by something else
python run.py --legacy       # the frozen v39.29 terminal, same port
python run.py --build        # build the terminal first (needs Node.js)
python run.py --install      # install the Python dependencies, then exit
```

**Double-click launchers (the same thing):**
- **Windows:** `run.bat`
- **macOS:** `run.command` (first time: right-click → Open, or `chmod +x run.command`)
- **Linux / Git Bash:** `run.sh` (first time: `chmod +x run.sh`, then `./run.sh`)

All three are three-line wrappers around `run.py`, and that is deliberate: a
shell script cannot be the single entry point (Windows will not run `.sh` from a
double-click, `.bat` does not exist off Windows), so the only thing the shells do
is find Python. Every decision lives in `run.py`, once, so the three platforms
cannot drift apart.

**Requires Python 3.12 or newer.** Not optional and not a preference — the whole
backend is Python, and `server/mishel_service.py` uses backslash escapes inside
f-strings, which is a `SyntaxError` before 3.12. macOS and Linux ship a Python;
on Windows install it from python.org or the Microsoft Store.

First run installs the Python dependencies if they are missing. A machine
without the scientific stack still runs everything except the Quant desk, and
the launcher says so rather than reporting "dependencies missing" for a chart
that was fine.

---

## iPad / iPhone (iOS / iPadOS)

Safari can't run a local server or `.sh`/`.bat` files. Pick one:

1. **Host it (best, full live data).** Push the folder to a free static host — GitHub Pages, Netlify, or Cloudflare Pages — and open the URL in Safari. Because the app is `index.html`, it loads at the root. See "Hosting" below.
2. **Open the file locally (offline).** Save `index.html` to the Files app, then open it with an app that can render local HTML (e.g. **Documents by Readdle** → its built-in browser). Synthetic mode works; live data may be blocked from `file://`.
3. **Developer option:** the free **a-Shell** app has Python — run `python run.py` in it, then open `http://127.0.0.1:8787` in a browser tab.

Crypto live streaming (Binance WebSocket) works in mobile Safari **when the page is served over http/https** (i.e. hosted), not from a local file.

---

## Android

1. **Open the file locally (offline).** Use a file manager to open `index.html` in Chrome or Firefox (`file://…`). Synthetic mode works; live data may be limited by the mobile browser.
2. **Run a local server on the phone (full live data):**
   - **Termux** (from F-Droid): `pkg install python` → `cd` to the folder → `python run.py` → open `http://127.0.0.1:8787`.
   - **Pydroid 3** (Play Store): open `run.py` and press ▶, then open the URL.
3. **Host it** (see below) and open the URL — simplest for live data.

---

## Live data on mobile

- **Crypto** (Binance WebSocket) works on any hosted/served page — no key, no proxy.
- **Forex / stocks** need a provider. The proxy runs on a *computer*, not a phone, and it is part of the gateway `run.py` starts. If your phone and computer are on the same Wi-Fi, set the terminal's **Proxy URL** to the computer's LAN address, e.g. `http://192.168.1.20:8787`, and start the gateway with `IRAM_HOST=0.0.0.0 IRAM_ALLOW_REMOTE=1 python run.py`. **Both variables are needed and the second one is a real decision:** the gateway has no authentication of its own and forwards whatever vendor API keys it was configured with, so it refuses to bind off loopback until you say you meant it. Only do this on a network you trust.

---

## Hosting (works on literally every device)

```bash
# inside the project folder:
git init && git add . && git commit -m "Mishel Intelligence Trading"
# create an empty GitHub repo, then:
git remote add origin https://github.com/YOU/mishel-intelligence-trading.git
git branch -M main && git push -u origin main
```
On GitHub: **Settings → Pages → Deploy from branch → main / root**. In ~1 minute it's live at
`https://YOU.github.io/mishel-intelligence-trading/` — open that on Windows, Mac, Linux, iPad, or Android.

---

## Saving your setup

The app deliberately avoids browser storage (so it runs from `file://` anywhere). Your custom strategies, weights, guardrails, model, alerts, and proxy config are saved via **Settings → Workspace → Export**, and restored with **Import** — that file is your portable configuration across all devices.
