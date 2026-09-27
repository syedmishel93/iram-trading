/**
 * The vault — the whole terminal as one portable file.
 *
 * WHAT IT IS FOR
 * Three things that were impossible while state lived in two localStorage keys
 * and an IndexedDB nobody could see into:
 *
 *   - **Backup.** Alerts, layouts, watchlists and — optionally — years of
 *     market history in one file you can copy to a drive. Some of that history
 *     is not re-downloadable at any price: Binance serves klines back a long
 *     way, but a broker's MT5 history for a symbol you no longer subscribe to
 *     is gone the day you close the account.
 *   - **Moving machines.** Desktop to laptop without re-deriving a single
 *     setting.
 *   - **Sending someone a reproducible case.** "It refuses to run the study" is
 *     a bug report. A vault file is the same bug report with the data in it.
 *
 * FOUR RULES
 *
 * 1. **Secrets never leave.** Any key that looks like a credential is dropped
 *    on export, and the export SAYS what it dropped rather than silently
 *    omitting it. A backup file gets emailed, put in a shared folder and
 *    attached to a GitHub issue. It must be safe to do all three.
 *
 * 2. **A checksum, and honesty about what it is.** FNV-1a over the payload,
 *    which detects truncation and corruption — the failures that actually
 *    happen to files. It is NOT a signature and does not detect tampering, and
 *    saying otherwise would invite someone to trust a hostile file.
 *
 * 3. **Import is additive and previewable by default.** `inspect()` tells you
 *    what is in a file before anything is touched. Replace mode exists but must
 *    be asked for; an import that silently deleted the alert book you forgot
 *    was there is not recoverable.
 *
 * 4. **Bars travel as base64 columns, not as JSON numbers.** A 40,000-bar
 *    series is 240,000 numbers; as JSON text that is a multi-megabyte parse
 *    that blocks the main thread. The Float64 buffer base64-encodes to a
 *    comparable size, decodes in one pass, and is bit-exact — no float
 *    round-tripping to argue about.
 */

import type { BarArchive, DataQuality, SeriesInventory } from "./barstore";
import { parseSeriesKey } from "./barstore";
import type { Envelope, KV } from "./kv";
import type { BarView } from "../chart/series";

export const VAULT_MAGIC = "IRAM-VAULT";
export const VAULT_VERSION = 1;

export interface VaultSeries {
  key: string;
  symbol: string;
  timeframe: string;
  source: string;
  quality: DataQuality;
  bars: number;
  from: number;
  to: number;
  /** base64 of a Float64Array, one per column. */
  t: string;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export interface VaultFile {
  magic: string;
  version: number;
  createdAt: number;
  app: string;
  /** FNV-1a of the canonical payload. Integrity, not authenticity. */
  checksum: string;
  settings: Record<string, Envelope<unknown>>;
  series: VaultSeries[];
  note: string;
  /** Keys withheld because they looked like credentials. */
  redacted: string[];
}

// ------------------------------------------------------------ base64 cols --

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Encode without `btoa`.
 *
 * `btoa` needs a binary string built one `String.fromCharCode` at a time, which
 * on a 320KB buffer either blows the argument limit or spends longer than the
 * encode itself. This walks the bytes directly. It also means the vault
 * round-trips in Node for the daemon and the tests without a DOM.
 */
export function encodeF64(arr: Float64Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + "==";
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + "=";
  }
  return out;
}

const B64_INDEX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i;
  return m;
})();

export function decodeF64(text: string): Float64Array {
  // Stripping `=` here is why the length arithmetic below works on the payload
  // alone rather than having to reason about padding.
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const byteLen = Math.floor((clean.length * 3) / 4);
  // A truncated column must produce a SHORTER Float64Array, never one whose
  // last element is a partly-filled double — that would read as a real price.
  const usable = byteLen - (byteLen % 8);
  const bytes = new Uint8Array(usable);

  // Out-of-range reads return 0. The loop must run over the FINAL, possibly
  // partial, group: a 4-byte tail encodes as three characters, and stopping at
  // `i + 3 < length` skips it — which silently zeroed the last double of every
  // column whose byte length was not a multiple of three. A Float64Array is
  // eight bytes per element, so that was most of them.
  const at = (i: number): number => (i < clean.length ? (B64_INDEX[clean.charCodeAt(i)] ?? 0) : 0);

  let b = 0;
  for (let i = 0; i < clean.length && b < usable; i += 4) {
    const n = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3);
    if (b < usable) bytes[b++] = (n >> 16) & 255;
    if (b < usable) bytes[b++] = (n >> 8) & 255;
    if (b < usable) bytes[b++] = n & 255;
  }
  return new Float64Array(bytes.buffer, 0, usable / 8);
}

// ---------------------------------------------------------------- checksum --

/**
 * FNV-1a, 32-bit, as eight hex characters.
 *
 * Chosen because it is four lines, has no dependency, and catches the failures
 * a backup file actually suffers: a truncated download, a text editor that
 * mangled the encoding, a partial copy. It is not a MAC. A file whose checksum
 * matches is intact, not trustworthy.
 */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// --------------------------------------------------------------- redaction --

/**
 * Anything that could be a credential.
 *
 * Deliberately over-broad. A false positive costs the user re-entering a
 * setting; a false negative puts an API key in a file that gets attached to an
 * issue. Those are not comparable, so the test is generous and the export names
 * everything it withheld.
 */
export const SECRET_PATTERN = /(key|token|secret|password|passwd|credential|auth|bearer|apikey|api_key|session|cookie|private|seed|mnemonic|login|account_?id)/i;

export function looksSecret(key: string): boolean {
  return SECRET_PATTERN.test(key);
}

// ----------------------------------------------------------------- export --

export interface ExportOptions {
  /** Include bar history. Off by default: settings are KB, history is MB. */
  includeArchive?: boolean;
  /** Limit to these series keys. Empty means all. */
  seriesKeys?: readonly string[];
  /** Skip series larger than this, so one huge 1m series cannot dominate. */
  maxBarsPerSeries?: number;
  now?: () => number;
}

export async function exportVault(
  kv: KV,
  archive: BarArchive | null,
  opts: ExportOptions = {},
): Promise<VaultFile> {
  const now = opts.now ?? Date.now;
  const settings: Record<string, Envelope<unknown>> = {};
  const redacted: string[] = [];

  for (const key of kv.keys()) {
    if (looksSecret(key)) {
      redacted.push(key);
      continue;
    }
    const env = kv.rawEnvelope(key);
    if (env) settings[key] = env;
  }

  const series: VaultSeries[] = [];
  if (opts.includeArchive && archive) {
    const wanted = new Set(opts.seriesKeys ?? []);
    const inventory = await archive.inventory();
    const maxBars = opts.maxBarsPerSeries ?? 200_000;

    for (const s of inventory) {
      if (wanted.size > 0 && !wanted.has(s.key)) continue;
      if (s.bars > maxBars) continue;
      const key = parseSeriesKey(s.key);
      const read = await archive.read(key, { from: s.oldest, to: s.newest }, 0);
      if (read.bars.length === 0) continue;
      series.push(toVaultSeries(s, read.bars));
    }
  }

  const payload = {
    magic: VAULT_MAGIC,
    version: VAULT_VERSION,
    createdAt: now(),
    app: "IRAM Intelligence Terminal",
    settings,
    series,
    redacted,
  };

  return {
    ...payload,
    checksum: checksum(canonical(payload)),
    note:
      redacted.length > 0
        ? `${redacted.length} key(s) withheld as possible credentials: ${redacted.join(", ")}. The checksum detects corruption, not tampering.`
        : "The checksum detects corruption, not tampering. Treat a vault file from someone else as untrusted input.",
  };
}

function toVaultSeries(meta: SeriesInventory, bars: readonly BarView[]): VaultSeries {
  const n = bars.length;
  const col = (pick: (b: BarView) => number): string => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = pick(bars[i] as BarView);
    return encodeF64(a);
  };
  return {
    key: meta.key,
    symbol: meta.symbol,
    timeframe: meta.timeframe,
    source: meta.source,
    quality: (meta.qualities[0] ?? "unknown") as DataQuality,
    bars: n,
    from: (bars[0] as BarView).t,
    to: (bars[n - 1] as BarView).t,
    t: col((b) => b.t),
    o: col((b) => b.o),
    h: col((b) => b.h),
    l: col((b) => b.l),
    c: col((b) => b.c),
    v: col((b) => b.v),
  };
}

/**
 * Deterministic serialisation for the checksum.
 *
 * `JSON.stringify` preserves insertion order, so the same state exported twice
 * could produce two different checksums purely because a key was written in a
 * different order. Sorting makes the checksum a function of the CONTENT.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src).sort()) out[k] = src[k];
      return out;
    }
    return v;
  });
}

export function serialiseVault(file: VaultFile): string {
  return JSON.stringify(file, null, 0);
}

// ----------------------------------------------------------------- import --

export interface VaultInspection {
  ok: boolean;
  error?: string;
  version: number;
  createdAt: number;
  settingKeys: string[];
  series: Array<{ key: string; bars: number; from: number; to: number }>;
  totalBars: number;
  checksumOk: boolean;
  warnings: string[];
}

/** Read a vault file WITHOUT applying it. Always the first step. */
export function inspectVault(text: string): VaultInspection {
  const empty: VaultInspection = {
    ok: false,
    version: 0,
    createdAt: 0,
    settingKeys: [],
    series: [],
    totalBars: 0,
    checksumOk: false,
    warnings: [],
  };

  let file: VaultFile;
  try {
    file = JSON.parse(text) as VaultFile;
  } catch (err) {
    return { ...empty, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (file?.magic !== VAULT_MAGIC) {
    return { ...empty, error: "not an IRAM vault file (missing magic header)" };
  }
  if (typeof file.version !== "number" || file.version > VAULT_VERSION) {
    return {
      ...empty,
      version: Number(file.version) || 0,
      error: `vault format v${file.version} is newer than this build understands (v${VAULT_VERSION})`,
    };
  }

  const { checksum: stored, note: _note, ...rest } = file;
  const recomputed = checksum(canonical(rest));
  const warnings: string[] = [];
  if (stored !== recomputed) {
    warnings.push(
      `checksum mismatch (file says ${stored}, content computes ${recomputed}) — the file is truncated or was edited. Import will still work; the data may not be complete.`,
    );
  }
  if ((file.redacted?.length ?? 0) > 0) {
    warnings.push(`${file.redacted.length} key(s) were withheld when this was exported.`);
  }

  const series = (file.series ?? []).map((s) => ({
    key: s.key,
    bars: s.bars,
    from: s.from,
    to: s.to,
  }));

  return {
    ok: true,
    version: file.version,
    createdAt: file.createdAt,
    settingKeys: Object.keys(file.settings ?? {}),
    series,
    totalBars: series.reduce((a, s) => a + s.bars, 0),
    checksumOk: stored === recomputed,
    warnings,
  };
}

export interface ImportOptions {
  /** Bring settings across. Default true. */
  settings?: boolean;
  /** Bring bar history across. Default true when the file has any. */
  archive?: boolean;
  /**
   * "merge" keeps whichever copy is newer per key; "replace" takes the file's.
   * Merge is the default because it is the only one that cannot lose work you
   * did after the export.
   */
  mode?: "merge" | "replace";
}

export interface ImportResult {
  settingsWritten: number;
  settingsSkipped: Array<{ key: string; why: string }>;
  seriesWritten: number;
  barsWritten: number;
  errors: string[];
}

export async function importVault(
  text: string,
  kv: KV,
  archive: BarArchive | null,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const inspection = inspectVault(text);
  if (!inspection.ok) throw new Error(inspection.error ?? "unreadable vault");

  const file = JSON.parse(text) as VaultFile;
  const mode = opts.mode ?? "merge";
  const result: ImportResult = {
    settingsWritten: 0,
    settingsSkipped: [],
    seriesWritten: 0,
    barsWritten: 0,
    errors: [],
  };

  if (opts.settings !== false) {
    for (const [key, env] of Object.entries(file.settings ?? {})) {
      // A vault file is untrusted input. Even though export redacts, an
      // imported file could carry a secret-looking key from a hand-edited copy;
      // refusing it keeps the invariant true in both directions.
      if (looksSecret(key)) {
        result.settingsSkipped.push({ key, why: "looks like a credential" });
        continue;
      }
      const local = kv.rawEnvelope(key);
      if (mode === "merge" && local !== null && local.at >= env.at) {
        result.settingsSkipped.push({ key, why: "local copy is newer" });
        continue;
      }
      const w = mode === "replace" ? kv.putEnvelope(key, { ...env, at: Date.now() }) : kv.putEnvelope(key, env);
      if (w.ok) result.settingsWritten++;
      else result.settingsSkipped.push({ key, why: w.error });
    }
  }

  const wantArchive = opts.archive ?? true;
  if (wantArchive && archive && (file.series?.length ?? 0) > 0) {
    for (const s of file.series) {
      try {
        const bars = fromVaultSeries(s);
        if (bars.length === 0) continue;
        await archive.write(parseSeriesKey(s.key), bars, {
          source: s.source,
          quality: s.quality,
          fetchedAt: file.createdAt,
        });
        result.seriesWritten++;
        result.barsWritten += bars.length;
      } catch (err) {
        result.errors.push(`${s.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

export function fromVaultSeries(s: VaultSeries): BarView[] {
  const t = decodeF64(s.t);
  const o = decodeF64(s.o);
  const h = decodeF64(s.h);
  const l = decodeF64(s.l);
  const c = decodeF64(s.c);
  const v = decodeF64(s.v);
  // Shortest column wins. A truncated file must produce fewer complete bars,
  // never a bar whose close came from a different index than its open.
  const n = Math.min(t.length, o.length, h.length, l.length, c.length, v.length);
  const out: BarView[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      t: t[i] as number,
      o: o[i] as number,
      h: h[i] as number,
      l: l[i] as number,
      c: c[i] as number,
      v: v[i] as number,
    };
  }
  return out;
}

/** Suggested filename. Sortable, so a folder of backups reads chronologically. */
export function vaultFilename(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `iram-vault-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}.json`;
}
