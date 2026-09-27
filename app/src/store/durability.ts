/**
 * Does this browser actually KEEP what we write?
 *
 * WHY THIS EXISTS
 * `browserRawStore()` in kv.ts falls back to an in-memory store when
 * localStorage throws, and the only trace of that is a `console.warn` nobody
 * reads. The user-visible consequence is that every preference silently resets
 * on reload — and because `shell.ts` reads
 * `prefs["symbol"] ?? "BTCUSDT"`, the symptom a trader actually reports is
 * **"I cannot change the currency pair, it is always BTCUSDT."** They change it,
 * it works, they reload, and it is back. Nothing on screen ever explains why.
 *
 * That is the exact failure this project keeps writing down: not a wrong pixel,
 * a confident wrong state. The terminal looked like it accepted the change.
 *
 * WHY A BEACON RATHER THAN A CAPABILITY CHECK
 * The obvious implementation is "try to write, and if it throws, storage is
 * broken". That is what kv.ts already does, and it is not enough — it catches
 * the throwing cases (private windows, locked-down profiles) and misses the
 * ones where a write appears to SUCCEED and then does not survive:
 *
 *   - a `file://` page, where storage is partitioned per document in some
 *     browsers and discarded in others — and `run.bat` tells people to open
 *     `app\dist\index.html` directly, so this is the common case, not an edge one
 *   - storage cleared on exit by policy or by the user's own settings
 *   - a webview that reports a working localStorage and drops it on teardown
 *
 * None of those throw. The only honest test of "does a write survive a reload"
 * is to write something and look for it after a reload. So: every boot leaves a
 * beacon, and every boot looks for the previous one.
 *
 * WHAT IT REFUSES TO CLAIM
 * On the very first run there is no previous beacon, so the answer is `unknown`
 * — not `ephemeral`. A first-run warning would fire for every new user on a
 * perfectly healthy browser, and a warning that is usually wrong is one people
 * learn to dismiss. `ephemeral` is only ever returned on EVIDENCE: either the
 * store told us it cannot persist, or we wrote a beacon and it was gone.
 */

import type { RawStore } from "./kv";

/** Where the beacon lives. Deliberately outside the `iram:` slot namespace. */
export const BEACON_KEY = "__iram_durability_beacon__";

export type DurabilityState =
  /** A beacon written by an earlier session came back. Writes survive. */
  | "durable"
  /**
   * Not proven either way, but the page was opened straight from a folder,
   * where browsers give no useful guarantee. Writing this test is what showed
   * the case needed its own state: on `file://` Chrome accepts a write and may
   * partition or discard it, so `storeCanPersist` stays true and a missing
   * beacon is indistinguishable from a first run. Reporting that as `unknown`
   * would stay silent for exactly the user who is being bitten.
   */
  | "at-risk"
  /** Nothing to compare against yet — first run, or the beacon was cleared. */
  | "unknown"
  /** Measured: a write did not survive, or the store cannot persist at all. */
  | "ephemeral";

export interface DurabilityReport {
  readonly state: DurabilityState;
  /** Plain language, safe to show a trader. Never mentions localStorage. */
  readonly note: string;
  /** What the user can actually do about it, or null when nothing is wrong. */
  readonly remedy: string | null;
  /** How the page was opened. Drives the remedy wording. */
  readonly origin: "file" | "web" | "unknown";
}

export interface ProbeOptions {
  /**
   * `location.protocol`, injected so this is testable without a DOM.
   * Anything ending in `file:` is treated as a local file.
   */
  readonly protocol?: string | undefined;
  /**
   * False when kv.ts already fell back to memory. That is proof on its own and
   * skips waiting a whole reload to find out.
   */
  readonly storeCanPersist?: boolean;
  readonly now?: () => number;
}

const FILE_REMEDY =
  "Start the terminal with run.bat (or run.py) and open it at " +
  "http://localhost:8000 instead of opening the file directly. Pages opened " +
  "straight from a folder are not allowed to keep anything.";

const BLOCKED_REMEDY =
  "This usually means a private window, or a browser set to clear site data on " +
  "exit. Open the terminal in a normal window, or allow this site to store data.";

function originOf(protocol: string | undefined): DurabilityReport["origin"] {
  if (protocol === undefined) return "unknown";
  if (protocol === "file:") return "file";
  if (protocol === "http:" || protocol === "https:") return "web";
  return "unknown";
}

/**
 * Read the previous session's beacon, then leave one for the next session.
 *
 * Call this ONCE, as early as possible, before anything else writes. It is
 * cheap: one read and one write of a short string.
 */
export function probeDurability(raw: RawStore, opts: ProbeOptions = {}): DurabilityReport {
  const origin = originOf(opts.protocol);
  const now = opts.now ?? Date.now;
  const remedy = origin === "file" ? FILE_REMEDY : BLOCKED_REMEDY;

  /* kv.ts already discovered the store throws. No point writing a beacon into
     a memory store to rediscover it on a reload that will never see it. */
  if (opts.storeCanPersist === false) {
    return {
      state: "ephemeral",
      note: "Settings are not being saved. Anything you change — the symbol, the timeframe, your account numbers — will be back to its default the next time this page loads.",
      remedy,
      origin,
    };
  }

  let previous: string | null = null;
  try {
    previous = raw.getItem(BEACON_KEY);
  } catch {
    /* Reading threw even though writing did not. Treat as no evidence rather
       than as proof — the write below is the real test. */
    previous = null;
  }

  let wrote = true;
  try {
    raw.setItem(BEACON_KEY, String(now()));
  } catch {
    wrote = false;
  }

  if (!wrote) {
    return {
      state: "ephemeral",
      note: "Settings are not being saved. Anything you change — the symbol, the timeframe, your account numbers — will be back to its default the next time this page loads.",
      remedy,
      origin,
    };
  }

  if (previous !== null) {
    return {
      state: "durable",
      note: "Settings are saved on this browser and survive a reload.",
      remedy: null,
      origin,
    };
  }

  /* No beacon came back. On a normal web origin that means a first run and
     nothing is wrong. Opened from a folder it means we cannot tell — and
     because that is precisely where settings are known to evaporate, silence
     would fail the one user who needs telling. */
  if (origin === "file") {
    return {
      state: "at-risk",
      note: "This page was opened straight from a folder, so the browser may not keep your settings. If the symbol or timeframe is back to its default every time you open the terminal, this is why.",
      remedy: FILE_REMEDY,
      origin,
    };
  }

  return {
    state: "unknown",
    note: "First run on this browser — whether settings survive a reload will be known next time the terminal opens.",
    remedy: null,
    origin,
  };
}

/**
 * Clear the beacon. Only for tests and for the Data desk's "reset local data",
 * so a wipe does not leave the next boot claiming durability it cannot show.
 */
export function clearBeacon(raw: RawStore): void {
  try {
    raw.removeItem(BEACON_KEY);
  } catch {
    /* nothing to do: an unwritable store has no beacon to clear */
  }
}
