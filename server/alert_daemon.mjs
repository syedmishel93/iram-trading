#!/usr/bin/env node
/* =====================================================================
   v40 — ALWAYS-ON ALERT DAEMON
   ---------------------------------------------------------------------
   WHAT IT IS
   The alert book, evaluated with the browser closed. It polls the local
   data proxy for bars, runs the SHIPPED alert engine over them, and
   reports what fired.

   WHY IT RUNS THE SHIPPED ENGINE
   engine/alert-engine.mjs is compiled from the same TypeScript the
   terminal uses — the detectors, the anchor resolution, the hysteresis,
   the look-ahead guard, all of it. There is no second implementation to
   drift. This is the same choice sig_worker.js made in v35 and for the
   same reason: two engines means that the day they disagree, you find
   out on a live trade and cannot tell which one lied.

   WHAT IT REFUSES TO DO
     * Place an order. It reports. Nothing here can trade.
     * Invent a bar. A failed fetch is logged and the poll is skipped;
       the book is never evaluated against partial data.
     * Announce history. The first pass over a symbol is SILENT — a book
       loaded against months of bars legitimately produces dozens of past
       fires, and a startup that emits forty notifications about March is
       a startup you turn off.
     * Reach the network for anything but the local proxy on 127.0.0.1.

   USAGE
     node server/alert_daemon.mjs [--book alerts.json] [--every 60]
                                  [--proxy http://127.0.0.1:8787]
                                  [--webhook URL]

   The book is the JSON the terminal's Signals desk exports. Re-export and
   the daemon picks it up on the next poll — no restart.
   ===================================================================== */
'use strict';

import { readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* A STATIC relative import, deliberately. Importing an absolute path
   dynamically throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows, because
   "C:\..." looks to the ESM loader like a URL with protocol "c:". A relative
   specifier is resolved against this file and is correct on every platform. */
import { evaluateBook, freshFires, readBookFile } from './engine/alert-engine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ---- arguments ------------------------------------------------------ */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BOOK = resolve(arg('book', join(HERE, 'alerts.json')));
const EVERY = Math.max(15, Number(arg('every', '60')) || 60);
const PROXY = arg('proxy', 'http://127.0.0.1:8787');
const WEBHOOK = arg('webhook', '');
const LOG = join(HERE, 'alerts.log');

/* A poll must not outlive its own interval, or two passes overlap and the
   second reports what the first already had in flight. */
const FETCH_TIMEOUT_MS = Math.min(20_000, EVERY * 1000 * 0.8);

/* ---- output --------------------------------------------------------- */

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function say(line) {
  const text = `${stamp()}  ${line}`;
  console.log(text);
  try {
    await appendFile(LOG, `${text}\n`, 'utf8');
  } catch {
    /* A log we cannot write is not a reason to stop alerting. */
  }
}

async function announce(fire, spec) {
  await say(`FIRED  ${spec.symbol} ${spec.timeframe}  ${fire.reason}`);
  if (!WEBHOOK) return;
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        symbol: spec.symbol,
        timeframe: spec.timeframe,
        condition: spec.condition,
        reason: fire.reason,
        price: fire.price,
        anchorPrice: fire.anchorPrice,
        barTime: fire.time,
      }),
    });
  } catch (err) {
    // The webhook is a delivery channel, not the record. Losing it must not
    // lose the alert, which is already in the log above.
    await say(`WARN   webhook failed: ${err.message}`);
  }
}

/* ---- data ----------------------------------------------------------- */

/* Which providers can plausibly serve a symbol, best first.

   The same failover the terminal's registry does, for the same reason: the
   venue you are actually filled at is the venue whose prices are true FOR YOU,
   and a vendor is only a fallback. The proxy's binance provider wants the
   BTCUSD form rather than BTCUSDT, so the symbol is normalised per provider
   here rather than the caller being asked to know that. */
const CRYPTO_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD'];

function candidates(symbol) {
  const upper = symbol.toUpperCase();
  const isCrypto =
    CRYPTO_QUOTES.some((q) => upper.endsWith(q)) || /^(BTC|ETH|SOL|XRP)/.test(upper);
  if (isCrypto) {
    let spot = upper;
    for (const q of CRYPTO_QUOTES) {
      if (spot.endsWith(q)) {
        spot = `${spot.slice(0, -q.length)}USD`;
        break;
      }
    }
    return [
      { provider: 'binance', symbol: spot },
      { provider: '', symbol: upper },
    ];
  }
  return [
    { provider: 'mt5', symbol: upper },
    { provider: '', symbol: upper },
  ];
}

async function bars(symbol, interval, limit) {
  const attempts = [];
  for (const c of candidates(symbol)) {
    try {
      return await fetchBars(c.provider, c.symbol, interval, limit);
    } catch (err) {
      attempts.push(`${c.provider || 'default'}: ${err.message}`);
    }
  }
  // Every attempt named, so a silent zero is impossible to mistake for calm.
  throw new Error(attempts.join(' | '));
}

async function fetchBars(provider, symbol, interval, limit) {
  const url =
    `${PROXY}/ohlc?symbol=${encodeURIComponent(symbol)}` +
    (provider ? `&provider=${encodeURIComponent(provider)}` : '') +
    `&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`proxy responded ${res.status}`);
    const body = await res.json();
    // The proxy reports a provider-level failure as 200 with an error field.
    if (body && body.error) throw new Error(String(body.error));
    const rows = Array.isArray(body) ? body : (body.bars ?? body.data ?? []);
    const out = [];
    for (const r of rows) {
      const bar = Array.isArray(r)
        ? { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }
        : { t: +(r.t ?? r.time), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +(r.v ?? 0) };
      // A malformed row is dropped, never patched: a bar with a guessed close
      // is exactly the thing that makes an alert fire on something that did
      // not happen.
      if (Number.isFinite(bar.t) && Number.isFinite(bar.c)) out.push(bar);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/* ---- state ---------------------------------------------------------- */

/** alertId -> bar times already reported, so a re-walk is not a re-alert. */
let seen = Object.create(null);
/** symbol|timeframe pairs whose first pass has completed. */
const primed = new Set();
let lastBookText = '';
let specs = [];

async function loadBook() {
  if (!existsSync(BOOK)) return;
  const text = await readFile(BOOK, 'utf8');
  if (text === lastBookText) return;
  lastBookText = text;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    await say(`ERROR  ${BOOK} is not valid JSON: ${err.message}`);
    return;
  }
  const result = readBookFile(parsed);
  if (!result.ok) {
    await say(`ERROR  ${BOOK}: ${result.error}`);
    return;
  }
  specs = result.alerts;
  const on = specs.filter((s) => s.enabled).length;
  await say(`BOOK   ${specs.length} alerts (${on} enabled) from ${BOOK}`);
}

/* ---- the poll ------------------------------------------------------- */

async function poll() {
  await loadBook();

  const enabled = specs.filter((s) => s.enabled);
  if (enabled.length === 0) return;

  // One fetch per symbol/timeframe, not per alert.
  const groups = new Map();
  for (const s of enabled) {
    const key = `${s.symbol}|${s.timeframe}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const [key, group] of groups) {
    const [symbol, timeframe] = key.split('|');
    let series;
    try {
      series = await bars(symbol, timeframe, 1000);
    } catch (err) {
      await say(`WARN   ${symbol} ${timeframe}: ${err.message} — skipping this pass`);
      continue;
    }
    if (series.length < 60) {
      await say(`WARN   ${symbol} ${timeframe}: only ${series.length} bars — skipping`);
      continue;
    }

    const result = evaluateBook(series, group);
    const { fresh, seen: next } = freshFires(result.fires, seen);
    seen = next;

    for (const o of result.orphaned) {
      const spec = group.find((s) => s.id === o.id);
      await say(`ORPHAN ${symbol} ${timeframe}: ${o.reason}${spec ? '' : ''}`);
    }

    // THE FIRST PASS IS SILENT. Months of history legitimately contain dozens
    // of past fires; announcing them on startup is how the whole thing gets
    // muted on day one.
    if (!primed.has(key)) {
      primed.add(key);
      await say(
        `PRIMED ${symbol} ${timeframe}: ${result.closedBars} closed bars, ` +
          `${result.fires.length} historical fires recorded and NOT announced`,
      );
      continue;
    }

    for (const f of fresh) {
      const spec = group.find((s) => s.id === f.alertId);
      if (spec) await announce(f, spec);
    }
  }
}

/* ---- run ------------------------------------------------------------ */

await say(`START  polling every ${EVERY}s via ${PROXY}`);
await say(`       book: ${BOOK}`);
if (!existsSync(BOOK)) {
  await say(`       (no book yet — export one from the terminal's Signals desk)`);
}
if (WEBHOOK) await say(`       webhook: ${WEBHOOK}`);
await say(`       this daemon reports. It cannot place an order.`);

async function loop() {
  try {
    await poll();
  } catch (err) {
    // One bad pass must never end the process: an alert daemon that dies
    // quietly is worse than one that never ran, because you think it is on.
    await say(`ERROR  poll failed: ${err && err.stack ? err.stack : err}`);
  }
}

await loop();
setInterval(() => void loop(), EVERY * 1000);

process.on('SIGINT', async () => {
  await say('STOP   interrupted');
  process.exit(0);
});
