// v35.0 — OPERATIONAL SPINE: Clock · Freshness Contract · Durable STORE
// Runs the SHIPPED source extracted from index.html. No copies, no stubs of the code under test.
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/../index.html', 'utf8');

let P = 0, F = 0;
const ok = (c, m) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };

/* ---- grab a shipped top-level IIFE by a marker inside it ---- */
function grabIIFE(marker) {
  const mi = src.indexOf(marker);
  if (mi < 0) throw new Error('marker missing: ' + marker);
  // the marker lives in the banner comment ABOVE the IIFE -> search forward
  const start = src.indexOf('(function(){', mi);
  if (start < 0) throw new Error('no enclosing IIFE for: ' + marker);
  // NOTE: naive brace counting is WRONG here — these blocks contain regex literals
  // with a '}' inside a character class (e.g. /\s*\(\s*\)\s*[;}]/), which closes the
  // count early. Use the JS parser itself as the oracle: the shortest slice ending at
  // a '})();' that actually COMPILES is the block.
  let k = start;
  for (;;) {
    k = src.indexOf('})();', k + 1);
    if (k < 0) throw new Error('no compilable IIFE end for: ' + marker);
    const cand = src.slice(start, k + 5);
    try { new vm.Script(cand); return cand; } catch (e) { /* keep growing */ }
  }
}

/* ---- a minimal but honest browser harness ---- */
function harness() {
  const listeners = {};
  const els = {};
  const box = {
    console, Math, Date, JSON, Number, String, Array, Object, Blob: function () {}, Promise,
    setTimeout: (fn, ms) => 0, clearTimeout: () => {},
    fetch: () => Promise.reject(new Error('offline in test')),
    navigator: { sendBeacon: () => true },
    localStorage: {
      _d: {},
      getItem(k) { return k in this._d ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; }
    },
    document: {
      visibilityState: 'visible',
      addEventListener: (e, fn) => { (listeners[e] = listeners[e] || []).push(fn); },
      getElementById: id => els[id] || null,
      querySelector: () => null,
      createElement: () => ({ style: {}, appendChild() {}, querySelectorAll: () => [] }),
      body: { appendChild() {} }
    },
    _listeners: listeners
  };
  const nativeTimers = [];
  box.window = box;
  box.globalThis = box;
  box.window.addEventListener = (e, fn) => { (listeners[e] = listeners[e] || []).push(fn); };
  box.setInterval = (fn, ms) => { nativeTimers.push({ fn, ms }); return nativeTimers.length; };
  box.clearInterval = id => { nativeTimers[id - 1] = null; };
  box._nativeTimers = nativeTimers;
  vm.createContext(box);
  return box;
}

/* ============================ CLOCK ============================ */
console.log('\nCLOCK — one governed scheduler');
const clockSrc = grabIIFE('v35.0 OPERATIONAL SPINE');
const b = harness();
vm.runInContext(clockSrc, b);

ok(typeof b.window.Clock === 'object', 'C1: Clock installed on window');
ok(b._nativeTimers.length === 1 && b._nativeTimers[0].ms === 250,
   'C2: exactly ONE native driver (250ms) — the other 57 timers no longer own themselves');

// the wrapper must enrol a normal setInterval call with zero call-site edits
let ranA = 0;
const idA = b.window.setInterval(function tickA() { ranA++; }, 1000);
ok(b._nativeTimers.length === 1, 'C3: setInterval() is governed — no new native timer created');
ok(Object.keys(b.window.Clock.jobs).length === 1, 'C4: the call enrolled as a Clock job');
ok(b.window.Clock.report()[0].name.indexOf('tickA') === 0, 'C5: job auto-named from the function (tickA@1000ms)');

// ERROR ISOLATION: one throwing job must not kill the other
let ranB = 0;
b.window.setInterval(function boom() { throw new Error('kaboom'); }, 1000);
b.window.setInterval(function tickB() { ranB++; }, 1000);
for (const k in b.window.Clock.jobs) b.window.Clock.jobs[k].last = 0;   // make all due
b.window.Clock.tick();
ok(ranA === 1 && ranB === 1, 'C6: ERROR ISOLATION — a throwing job did not stop the other two');
const rep = b.window.Clock.report();
const boomJob = rep.find(j => j.name.indexOf('boom') === 0);
ok(boomJob && boomJob.errs === 1 && /kaboom/.test(boomJob.lastErr),
   'C7: the failure is RECORDED, not swallowed (errs=1, message kept)');
ok(b.window.Clock.health().failing === 1, 'C8: health() surfaces the failing job count');

// clearInterval on a Clock id must remove the job
b.window.clearInterval(idA);
ok(!Object.keys(b.window.Clock.jobs).some(k => b.window.Clock.jobs[k].name.indexOf('tickA') === 0),
   'C9: clearInterval() removes a governed job');

// RENDER GATING: pure-paint jobs skip while hidden, and do not pile up
let painted = 0;
b.window.Clock.add('paint', 100, () => painted++, { render: true });
b.document.visibilityState = 'hidden';
for (const k in b.window.Clock.jobs) b.window.Clock.jobs[k].last = 0;
b.window.Clock.tick();
ok(painted === 0, 'C10: render job SKIPPED while the tab is hidden');

// WAKE CATCH-UP: the whole point — on return, every due job runs IMMEDIATELY
b.document.visibilityState = 'visible';
const before = ranB;
b.window.Clock.wake();
ok(painted === 1 && ranB === before + 1,
   'C11: WAKE CATCH-UP — every due job ran at once on tab return (not stale-then-eventually)');
ok(typeof b.window.Clock.wokeAfter === 'number', 'C12: the wake gap is measured (wokeAfter)');

/* ======================== FRESHNESS CONTRACT ======================== */
console.log('\nFRESH — the gate that refuses to act on a dead tape');
const Fr = b.window.Fresh;
ok(typeof Fr === 'object', 'F1: Fresh installed on window');

// offline / synthetic => blocked, always
b.MODE = 'offline'; b.window.MODE = 'offline'; b.window._realFeed = false; b.window._lastTick = Date.now();
ok(Fr.state() === 'offline' && Fr.blocks() === true,
   'F2: OFFLINE/synthetic => state "offline" and BLOCKS (never a tradeable number)');

// online websocket, fresh tick => live, allowed
b.MODE = 'online'; b.window.MODE = 'online'; b.window._realFeed = true; b.window._feedDelay = false;
b.window._lastTick = Date.now() - 3000;
ok(Fr.state() === 'live' && Fr.ok() === true, 'F3: live websocket tick (3s) => "live", allowed');
ok(Fr.label() === 'LIVE', 'F4: labelled LIVE');

// online websocket, 45s stale => lagging (warn, still allowed)
b.window._lastTick = Date.now() - 45000;
ok(Fr.state() === 'lagging' && Fr.ok() === true, 'F5: 45s since tick => "lagging" (warn, not blocked)');

// online websocket, 3 min stale => STALE => BLOCKED
b.window._lastTick = Date.now() - 180000;
ok(Fr.state() === 'stale' && Fr.blocks() === true, 'F6: 3min since tick => "stale" => BLOCKED');
ok(/STALE/.test(Fr.label()) && /not a tradeable number/i.test(Fr.why()),
   'F7: it says WHY, in plain language');

// THE HONESTY POINT: vendor lag and tick age are never conflated.
b.window._feedDelay = true;                       // yfinance proxy
b.window._lastTick = Date.now() - 5000;           // feed is ALIVE...
ok(Fr.state() === 'live', 'F8: a delayed vendor can still be ALIVE (tick age is fresh)');
ok(Fr.vendorLag() === 15 * 60 * 1000, 'F9: ...but the ~15m vendor lag is tracked SEPARATELY');
ok(Fr.dataAge() > 15 * 60 * 1000,
   'F10: dataAge() = tickAge + vendorLag — the honest age of the number ON SCREEN');
ok(/delayed/i.test(Fr.label()) && /broker is the truth/i.test(Fr.why()),
   'F11: a delayed feed is NEVER labelled plain "LIVE" — it says delayed, and defers to the broker');

// thresholds must be looser for a polled proxy than for a websocket
b.window._feedDelay = false; const wsT = Fr.thresh().live;
b.window._feedDelay = true;  const pxT = Fr.thresh().live;
ok(pxT > wsT, 'F12: a polled proxy gets a looser liveness threshold than a websocket (no false STALE)');

/* ===================== THE GATE IS ACTUALLY WIRED ===================== */
console.log('\nGATE — the contract has teeth');
ok(/if\(window\.Fresh && Fresh\.blocks\(\)\)[\s\S]{0,220}no decision on a dead tape/.test(src),
   'G1: the Decision Bar REFUSES to render a verdict when the feed is stale');
ok(/act==='ticket'[\s\S]{0,400}Fresh\.blocks\(\)[\s\S]{0,120}Ticket refused/.test(src),
   'G2: the MT5 ORDER TICKET is refused on a stale feed — the one artefact that becomes money');
ok(src.indexOf('id="stFresh"') > 0 && src.indexOf('id="stClock"') > 0,
   'G3: freshness + jobs chips are in the status bar (always visible)');
ok(src.indexOf('window.clockXray=function') > 0, 'G4: the jobs X-ray panel ships');

/* ============================ DURABLE STORE ============================ */
console.log('\nSTORE — SQLite is the source of truth, localStorage is a cache');
const storeSrc = grabIIFE('v35.0 STAGE C');
const b2 = harness();
b2.window.Clock = { add() {} };
vm.runInContext(storeSrc, b2);
const S = b2.window.STORE;
ok(typeof S === 'object', 'S1: STORE installed');

const DURABLE = ['mishel_journal', 'mishel_sigalerts', 'mishel_sigmem', 'mishel_drawmap', 'mishel_drawtpl',
                 'mishel_annot', 'mishel_pins', 'mishel_actionq', 'mishel_layouts', 'mishel_guard',
                 'mishel_ck_acct', 'mishel_ck_risk', 'mishel_ruggers', 'mishel_walletdb', 'mishel_wnick'];
ok(DURABLE.every(k => S.durable(k)), 'S2: all 15 irreplaceable keys are marked durable');
ok(!S.durable('mishel_theme') && !S.durable('mishel_compact') && !S.durable('mishel_paneh'),
   'S3: cosmetics (theme/compact/pane heights) are NOT synced — those SHOULD be per-device');

S.set('mishel_journal', '[{"r":1}]');
ok(b2.localStorage.getItem('mishel_journal') === '[{"r":1}]',
   'S4: a durable write still hits localStorage instantly (reads stay fast)');
ok(S.get('mishel_journal') === '[{"r":1}]', 'S5: STORE.get reads the cache');

// THE LEAK CHECK: no durable key may bypass STORE anywhere in the shipped file
const leaks = DURABLE.filter(k => src.indexOf("localStorage.setItem('" + k + "'") >= 0);
ok(leaks.length === 0, 'S6: LEAK CHECK — no durable key writes straight to localStorage (' +
   (leaks.length ? leaks.join(',') : 'clean') + ')');
ok(DURABLE.every(k => src.indexOf("STORE.set('" + k + "'") >= 0),
   'S7: every durable key is written through STORE.set in the shipped file');

ok(typeof S.hydrate === 'function' && typeof S.flushNow === 'function',
   'S8: hydrate() (server-ahead pull) + flushNow() ship');
ok(/beforeunload/.test(storeSrc) && /sendBeacon/.test(storeSrc),
   'S9: a closing tab flushes via sendBeacon — the last journal entry is not lost');
ok(/SYNC\.state='unsynced'/.test(storeSrc) && /queue\[k\]=items\[k\]/.test(storeSrc),
   'S10: on service failure it says UNSYNCED and REQUEUES — it never pretends the write landed');
ok(src.indexOf('id="stSync"') > 0, 'S11: the sync chip is in the status bar (silence is not "fine")');

/* ============ THE LOOP IS CLOSED ============ */
console.log('\nARM — the bell now arms the SERVER, not just this tab');
ok(/window\.sigArmServer=function/.test(src), 'A1: sigArmServer ships');
ok(/sigArmServer\(k,true\)/.test(src) && /sigArmServer\(k,false\)/.test(src),
   'A2: the existing bell button calls it on both arm and disarm');
ok(/\/svc\/sig\/watch/.test(src), 'A3: it writes to the service sig_watch table');
ok(/armed ON THE SERVER[\s\S]{0,80}tab closed/.test(src),
   'A4: success says plainly that it fires with the tab CLOSED');
ok(/armed IN THIS TAB ONLY[\s\S]{0,140}will NOT fire/.test(src),
   'A5: HONESTY — if the service is unreachable it says the alert will NOT fire browser-closed. It never implies cover it does not have.');

console.log('\nv35.0 OPERATIONAL SPINE: ' + P + ' passed, ' + F + ' failed');
process.exit(F ? 1 : 0);
