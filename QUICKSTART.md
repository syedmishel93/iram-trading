# Quickstart

Everything you need to run, publish, and configure DDT Terminal.

---

## 1. Run it locally

```bash
python run.py
```

Or double-click **`run.bat`** (Windows) / **`run.command`** (macOS), or run
**`./run.sh`** (Linux, macOS, Git Bash; `chmod +x run.sh` the first time).

That is the whole thing. It opens `http://127.0.0.1:8787` — the terminal and the
entire backend, one process, one port. `Ctrl+C` stops it. First run installs the
Python dependencies if they are missing.

```bash
python run.py --status       # what is already running
python run.py --port 9000    # when 8787 is taken
python run.py --legacy       # the frozen v39.29 terminal
python run.py --build        # build the terminal first (needs Node.js)
```

Needs **Python 3.12 or newer**. There is no way to run this without Python: the
whole backend — the data proxy, the store, the models — is written in it.

> `index.html` in the repository root is the **frozen v39.29** terminal, not
> this one. Double-clicking it still works and is still frozen; see `LEGACY.md`.
> The current terminal is `app/`, and `python run.py --legacy` serves the old
> one from the same port if you want to compare them.

---

## 2. Publish to GitHub

You need a free [GitHub](https://github.com) account and [git](https://git-scm.com) installed.

```bash
# inside the ddt-terminal folder:
git init
git add .
git commit -m "Initial commit: DDT Terminal"

# create an empty repo on github.com first (no README), then:
git remote add origin https://github.com/YOUR_USERNAME/ddt-terminal.git
git branch -M main
git push -u origin main
```

### Make it live in the browser (GitHub Pages)
1. On GitHub, open your repo → **Settings** → **Pages**.
2. Under **Build and deployment**, set **Source** = *Deploy from a branch*.
3. Choose branch **`main`**, folder **`/ (root)`**, then **Save**.
4. Wait ~1 minute. Your terminal is live at:
   `https://YOUR_USERNAME.github.io/ddt-terminal/`

Because the app is named `index.html`, it loads automatically — no extra config.

---

## 3. Update it later

After you change anything (or an AI edits `index.html` for you):
```bash
git add .
git commit -m "Describe your change"
git push
```
GitHub Pages redeploys automatically.

---

## 4. Turn on live data (optional)

Open **Settings → Data sources** in the app:

- **Crypto:** works out of the box via Binance's public API (no key).
- **Forex / stocks / metals:** get a **free** API key at [twelvedata.com](https://twelvedata.com), paste it into the API-key field, pick the provider, and click **Test live pull**.
- Flip the **Offline/Online** toggle in the top bar to go live.

**Security:** only use a **read-only market-data** key — never one with trade or withdrawal permissions in a browser. The key stays in memory for the session and is only sent to the data provider. For a hosted version, keep keys in a backend `.env`.

### More providers via the local proxy (yfinance · Polygon · Alpaca · Alpha Vantage)

Browsers can't call those directly. The optional server in **`server/`** does, and hands the data to the terminal:

The proxy is **already running** — it is part of the gateway `run.py` starts, on
the same port as the terminal. There is nothing extra to launch, and nothing to
point at: a page served by the gateway is told it IS the backend (a
`meta name="iram-backend"` tag), so the address is correct by construction.

In **Settings → Data sources**:
1. Proxy upstream → pick a provider. yfinance and Binance need no key;
   Twelve Data, Polygon, Alpaca and Alpha Vantage read a key from the API-key box
   or from environment variables — see `server/README.md`.
2. **Test live pull**, then flip the top-bar toggle to **Online**.

Only override the proxy URL if you are running a standalone
`server/ddt_data_server.py` somewhere else. The three services still run
standalone and the terminal still supports pointing each one somewhere
different — it just no longer has to.

### Alerts

The **Alerts** view is a working engine: build a rule (price, RSI, EMAs, MACD, ATR, ADX, Flux, confluence flip, or break of structure), arm it, and it's checked on every live tick — edge-triggered, with a browser notification, toast, and a triggered log. Click **Enable browser notifications** once to allow pop-ups. Alerts are saved with **Workspace → Export**. It notifies only; it never trades.

---

## 5. Save your setup

Custom strategies, weights, guardrails, and your model live only in the current session (a browser page can't auto-save to disk). Use **Settings → Workspace → Export** to save them to a file, and **Import** to restore them any time. That file is your portable, durable configuration.

---

## Troubleshooting

- **Live data says "blocked":** some browsers and regions block direct vendor calls. Run `python run.py` so the page is on `http://127.0.0.1` rather than `file://`, and check the API key. The gateway's own proxy is the fallback for anything the browser cannot reach itself.
- **`run.sh` won't execute:** run `chmod +x run.sh` first.
- **Port 8787 is taken:** `python run.py --status` says what holds it. A second
  copy of this product is found and reused rather than started twice.
- **Nothing happens on double-click:** open your browser first, then drag `index.html` into it.
- **Drawings disappear on reload:** that's expected — drawings are per-session. Export your workspace to keep strategies/settings.
