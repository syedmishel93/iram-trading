/**
 * THE CONNECTIONS THIS TERMINAL DEPENDS ON, and what each one last said.
 *
 * Seven routes that had no caller anywhere in the frontend, all answering with
 * real content: the broker bridge and its CLOCK OFFSET, the router's readiness,
 * which data vendors exist and which is trusted for what, the settings backup,
 * the browser-store manifest, and the live stream count.
 *
 * WHY THE CLOCK OFFSET IS THE IMPORTANT ONE
 *
 * MT5 stamps bars, ticks and deals on the BROKER'S clock, not in UTC. This
 * product measures the offset from a live tick and subtracts it from every
 * timestamp. CLAUDE.md records what the same class of error cost once already:
 * every TwelveData and AlphaVantage bar was displaced by the server's own UTC
 * offset, and "the chart drew the right candles in the wrong places, which for
 * a session-aware terminal is the worst available outcome". The correction is
 * applied and was invisible; this shows it, so a wrong one could be seen.
 *
 * A COUNT OF ZERO IS NOT A FAILURE HERE. No open streams means nothing is
 * subscribed, which is the normal state of a terminal nobody is watching a
 * live feed on — and `/svc/health` painting "0 of 0 running" green is the
 * mistake in the other direction. Each figure is reported as what it is.
 */

import { apiUrl, proxyBase, svcUrl } from "./backend";

export interface BridgeClock {
  readonly measured: boolean;
  readonly offset_ms: number;
  readonly offset_s: number;
  readonly label: string;
  readonly explain: string;
  readonly note: string;
  readonly measured_at_ms: number;
}

export interface BridgeStatus {
  readonly available: boolean;
  readonly connected: boolean;
  readonly last_err: string | null;
  readonly clock?: BridgeClock;
}

export interface RouterHealth {
  readonly ok: boolean;
  readonly engine: string;
  readonly minRows: number;
  readonly why: string;
}

export interface ProviderList {
  readonly providers: readonly string[];
  /** Those needing no API key — the ones that work out of the box. */
  readonly keyless: readonly string[];
}

export interface ProviderRank {
  readonly note: string;
  readonly rank: Readonly<Record<string, readonly string[]>>;
}

export interface KvEntry {
  readonly bytes: number;
  readonly rev: number;
  readonly t: number;
}

export interface KvManifest {
  readonly ok: boolean;
  readonly manifest: Readonly<Record<string, KvEntry>>;
}

export interface StreamStatus {
  readonly streams: readonly unknown[];
  readonly upstreams: number;
  readonly clients: number;
  readonly saved_connections: number;
}

export type Answer<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "offline"; readonly why: string };

async function ask<T>(url: string, what: string): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { kind: "offline", why: `${what} is not answering on ${url}` };
  }
  if (!res.ok) return { kind: "offline", why: `${what} answered ${res.status} on ${url}` };
  try {
    return { kind: "ok", value: (await res.json()) as T };
  } catch {
    return { kind: "offline", why: `${what} did not answer with a report on ${url}` };
  }
}

export function bridgeStatus(): Promise<Answer<{ bridge: BridgeStatus }>> {
  return ask(svcUrl("/svc/mt5/status"), "the broker bridge");
}
export function routerHealth(): Promise<Answer<RouterHealth>> {
  return ask(svcUrl("/svc/router/health"), "the router service");
}
export function providerList(): Promise<Answer<ProviderList>> {
  return ask(new URL("/providers", proxyBase()).toString(), "the data proxy");
}
export function providerRank(): Promise<Answer<ProviderRank>> {
  return ask(new URL("/providers/rank", proxyBase()).toString(), "the data proxy");
}
export function kvManifest(): Promise<Answer<KvManifest>> {
  return ask(svcUrl("/svc/kv/manifest"), "the settings store");
}
export function backupState(): Promise<Answer<{ ok: boolean; t: number; backup: Record<string, unknown> }>> {
  return ask(svcUrl("/svc/backup"), "the settings backup");
}
export function streamStatus(): Promise<Answer<StreamStatus>> {
  return ask(apiUrl("/api/stream/status"), "the stream gateway");
}

/**
 * How old the settings backup is, and whether that is worth saying.
 *
 * PURE, because it is the part that can be wrong. "Backed up" with no age is
 * the kind of reassurance that survives the backup silently stopping — the
 * `bars_loop` failure mode, where a fresh tick age described a job doing
 * nothing.
 *
 * `null` for "never", never zero: a backup that has never run and one that ran
 * this instant are opposite facts and must not share a rendering.
 */
export function backupAge(t: number, nowMs: number): { readonly days: number | null; readonly stale: boolean } {
  if (!Number.isFinite(t) || t <= 0) return { days: null, stale: true };
  const days = (nowMs - t * 1000) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return { days: null, stale: true };
  /* A week is the threshold because the backup loop runs daily; missing seven
     of them is a mechanism that has stopped rather than a slow day. */
  return { days, stale: days > 7 };
}

/** Total bytes the browser store holds, and its largest single slot. */
export function kvSize(manifest: Readonly<Record<string, KvEntry>>): {
  readonly total: number;
  readonly largest: string;
  readonly largestBytes: number;
  readonly slots: number;
} {
  let total = 0;
  let largest = "";
  let largestBytes = 0;
  let slots = 0;
  for (const [k, v] of Object.entries(manifest ?? {})) {
    const b = Number(v?.bytes);
    if (!Number.isFinite(b) || b < 0) continue;
    slots += 1;
    total += b;
    if (b > largestBytes) {
      largestBytes = b;
      largest = k;
    }
  }
  return { total, largest, largestBytes, slots };
}

/**
 * The broker clock offset, as a sentence.
 *
 * NOT MEASURED IS NOT ZERO. An unmeasured offset means every broker timestamp
 * is being taken at face value, which is a different and more worrying state
 * than a measured offset of zero — and rendering them the same way is how the
 * TwelveData displacement survived: nothing failed, the picture was just about
 * a different time.
 */
export function clockLine(c: BridgeClock | undefined): string {
  if (!c) return "The bridge did not report a clock offset.";
  if (!c.measured) {
    return "The broker's clock offset has NOT been measured, so its timestamps are being taken at face value.";
  }
  const s = c.offset_s;
  if (Math.abs(s) < 1) return "The broker's clock matches UTC, measured from a live tick.";
  const mag = Math.abs(s) >= 3600 ? `${(Math.abs(s) / 3600).toFixed(1)} hours` : `${Math.round(Math.abs(s))} seconds`;
  return `The broker stamps ${mag} ${s > 0 ? "ahead of" : "behind"} UTC. That is measured and subtracted from every bar, tick and deal.`;
}
