/**
 * Where the backend is — one answer, in one place.
 *
 * WHAT THIS REPLACES
 * Eleven modules each carried their own default: `http://127.0.0.1:8787` in
 * `feed.ts`, `sources.ts` and `brokerquote.ts`; `:8788` in `intel.ts`,
 * `rss.ts`, `context.ts`, `sync.ts`, `edge.ts` and `ledger.ts`; `:8789` in
 * `quant.ts`; and `calendar.ts` held two of them. Three ports, eleven literals,
 * and no way for an operator to move the backend without editing source.
 *
 * The visible symptom was worse than the duplication. Because the desks
 * addressed different processes, a backend that was half-running looked like
 * nine unrelated faults: bars fine, journal dead, quant dead, news dead — the
 * `ERR_CONNECTION_REFUSED` a fresh checkout logs on first run. One base means
 * one thing to be up or down, and `/api/health` says which.
 *
 * THE OVERRIDES ARE NOT DECORATION
 * `server/gateway` serves all three on one port, and that is the default here.
 * But the three services still run standalone, and someone who has them on
 * :8787/:8788/:8789 must not be broken by an upgrade that assumes otherwise.
 * So each service may be pointed somewhere else individually, and does not have
 * to be.
 *
 * WHY IT USES THE RAW STORE AND NOT THE KV LAYER
 * `feed.ts` builds its source registry while the module graph is still loading,
 * which is before `mountShell` has constructed a `KV`. A base address that
 * arrived after the feed was built would be read by nothing. That is the same
 * bootstrap problem the durability beacon has, so this takes the same answer it
 * does: `browserRawStoreProbed()`, which probes the browser store and falls
 * back to memory when it is absent or refuses.
 *
 * Absent is not hypothetical. jsdom exposes `window` with no storage on it, a
 * sandboxed frame throws on the property itself, and the desktop shell may
 * supply its own. Reaching for the global directly would have thrown a
 * `TypeError` from module initialisation, before anything could catch it.
 */

import { browserRawStoreProbed, type RawStore } from "../store/kv";

/** The gateway. All three services, one port — `server/gateway`. */
export const DEFAULT_BACKEND = "http://127.0.0.1:8787";

/** Where a per-service override is persisted. */
export const BACKEND_KEY = "iram.backend";

export interface BackendConfig {
  /** The gateway, and the fallback for every service below. */
  base: string;
  /**
   * Route live bars through the gateway instead of straight at the vendor.
   *
   * OFF by default, and that default is the honest one rather than the timid
   * one. With it off the terminal behaves exactly as it always has: a direct
   * vendor socket where one exists, an HTTP poll where one does not, and no
   * dependency on Python being installed for the chart to stay current.
   *
   * On, it buys two things the direct path cannot:
   *   - ONE vendor connection for every pane watching a symbol, instead of one
   *     per pane. A four-pane layout on BTCUSDT opens four Binance sockets.
   *   - A PUSH for sources that have no socket at all — yfinance, Twelve Data,
   *     Polygon — which today can only be polled, once per tab.
   *
   * It is opt-in because turning it on makes the chart's liveness depend on a
   * second process. The feed falls back to the direct path if the gateway
   * socket does not open, so the cost of trying is bounded, but "my prices
   * stopped" is not a failure mode to enable on someone's behalf.
   */
  stream?: boolean;
  /** Bars, quotes, the MT5 bridge — `/ohlc`, `/quote`, `/mt5/*`. */
  proxy?: string;
  /** Store, alerts, journal, sync — `/svc/*`. */
  service?: string;
  /** GARCH, causal inference, calibration — `/quant/*`. */
  quant?: string;
}

/**
 * The backend this build should talk to before anyone configures anything.
 *
 * When `server/gateway` serves the terminal it injects a meta tag saying so,
 * and the answer is simply "wherever this page came from". That removes the
 * last configuration step from the one-download case AND makes every request
 * same-origin, which means no preflight and no CORS policy in the path at all.
 *
 * The frontend cannot work this out for itself: the same build is served from
 * the Vite dev server, from `run.py`, from a `file://` double-click and from
 * the gateway, and the page origin is the API in exactly one of the four.
 * Guessing would point the terminal at :5173 for its bars.
 */
function shippedDefault(): string {
  try {
    const tag = document.querySelector('meta[name="iram-backend"]');
    if (tag?.getAttribute("content") === "same-origin") {
      const origin = window.location.origin;
      if (isValidBase(origin)) return normalise(origin);
    }
  } catch {
    // No DOM (the headless engines, a test). The literal default is correct
    // there, and throwing during module initialisation would not be.
  }
  return DEFAULT_BACKEND;
}

const DEFAULTS: BackendConfig = { base: shippedDefault() };

let store: RawStore = browserRawStoreProbed().store;
let config: BackendConfig = { ...DEFAULTS, ...readStored() };

/**
 * Point persistence somewhere else — a test, or a host with its own store.
 *
 * Re-reads immediately, because a store swapped in that did not take effect
 * until the next write would be the most confusing possible version of this.
 */
export function useBackendStore(next: RawStore): BackendConfig {
  store = next;
  config = { ...DEFAULTS, ...readStored() };
  return { ...config };
}

/**
 * Read an override written by a previous session.
 *
 * Guarded twice over: `localStorage` throws outright in a sandboxed frame or
 * with site data blocked, and the value itself is whatever was last written to
 * a key anyone can edit from a console. A bad value must leave the defaults
 * standing, not take the terminal down before it draws a candle.
 */
function readStored(): Partial<BackendConfig> {
  try {
    const raw = store.getItem(BACKEND_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Partial<BackendConfig> = {};
    for (const key of ["base", "proxy", "service", "quant"] as const) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && isValidBase(value)) out[key] = normalise(value);
    }
    if ((parsed as Record<string, unknown>)["stream"] === true) out.stream = true;
    return out;
  } catch {
    return {};
  }
}

/**
 * Is this something we are willing to send requests to?
 *
 * http/https only. A `javascript:` or `data:` base would be executed rather
 * than fetched, and this value can arrive from a text field.
 */
export function isValidBase(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Trailing slashes off, so every caller can join with a leading-slash path. */
export function normalise(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** The current configuration, as a copy. */
export function backendConfig(): BackendConfig {
  return { ...config };
}

/**
 * Point the terminal at a different backend.
 *
 * Returns the configuration actually applied — an invalid base is refused and
 * the previous one stands, because the alternative is a terminal that has
 * quietly stopped being able to reach anything.
 */
export function configureBackend(patch: Partial<BackendConfig>, persist = true): BackendConfig {
  const next: BackendConfig = { ...config };
  if (patch.stream !== undefined) next.stream = patch.stream;
  for (const key of ["base", "proxy", "service", "quant"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === "") {
      // Empty clears an override back to the base. `base` itself cannot be
      // cleared to nothing; it falls back to the shipped default.
      if (key === "base") next.base = DEFAULT_BACKEND;
      else delete next[key];
      continue;
    }
    if (isValidBase(value)) next[key] = normalise(value);
  }
  config = next;
  if (persist) {
    try {
      store.setItem(BACKEND_KEY, JSON.stringify(next));
    } catch {
      // Storage refused. The setting still applies for this session, which is
      // strictly better than refusing to accept it at all.
    }
  }
  return { ...config };
}

/** Reset to the shipped default. Used by tests and by the settings panel. */
export function resetBackend(persist = true): BackendConfig {
  config = { ...DEFAULTS };
  if (persist) {
    try {
      store.removeItem(BACKEND_KEY);
    } catch {
      /* nothing to undo */
    }
  }
  return { ...config };
}

/* -------------------------------------------------------------- accessors -- */

/** Bars, quotes and the MT5 bridge. */
export function proxyBase(): string {
  return config.proxy ?? config.base;
}

/** The store: alerts, journal, sync, risk, on-chain. */
export function serviceBase(): string {
  return config.service ?? config.base;
}

/**
 * A `/svc/...` address, joined rather than interpolated.
 *
 * THE SHAPE, NOT A PATCH. `data/quant.ts` once exported
 * `QUANT_BASE = (): string => quantBase()` and every call site wrote
 * `fetch(`${QUANT_BASE}${path}`)`. A template literal stringifies a FUNCTION
 * BY ITS SOURCE, so every request went to the literal path
 * `() => quantBase()/quant/health` — a 404 on a service that was up and
 * healthy, and legal TypeScript that `tsc` cannot see. The fix there was to
 * leave no bare base in the module to interpolate; this is that fix, available
 * to every caller of the service instead of one.
 */
export function svcUrl(path: string): string {
  const base = serviceBase();
  return `${base.endsWith("/") ? base.slice(0, -1) : base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The model service. */
export function quantBase(): string {
  return config.quant ?? config.base;
}

/** A gateway address, joined rather than interpolated — see `svcUrl`. */
export function apiUrl(path: string): string {
  const base = gatewayBase();
  return `${base.endsWith("/") ? base.slice(0, -1) : base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The gateway itself — `/api/health`, `/api/lab`, `/ws/bars`. */
export function gatewayBase(): string {
  return config.base;
}

/**
 * The WebSocket origin for the gateway, derived rather than configured.
 *
 * A second address to keep in step with the first is a second address to get
 * wrong, and the failure is invisible until a socket is opened. `https` maps to
 * `wss` so a gateway behind TLS does not produce a mixed-content block that
 * reads, in the console, as the socket simply not connecting.
 */
export function gatewayWsBase(): string {
  const base = gatewayBase();
  return base.startsWith("https:")
    ? `wss:${base.slice("https:".length)}`
    : `ws:${base.slice("http:".length)}`;
}

/** Whether live bars should be routed through the gateway. */
export function streamThroughBackend(): boolean {
  return config.stream === true;
}

/**
 * The gateway's live-bar socket for one symbol and timeframe.
 *
 * The symbol is passed through untouched. `/ws/bars` decides between Binance's
 * socket and a polled upstream itself, and it owns the vendor dialects — the
 * lesson from `fetch_bars`, where guessing the vendor from a `USDT` suffix
 * meant reading the vendor's dialect to choose the vendor.
 */
export function gatewayStreamUrl(symbol: string, timeframe: string): string {
  const params = new URLSearchParams({ symbol, timeframe });
  return `${gatewayWsBase()}/ws/bars?${params.toString()}`;
}

/** True when every service resolves to the same origin — the gateway shape. */
export function isConsolidated(): boolean {
  const base = config.base;
  return proxyBase() === base && serviceBase() === base && quantBase() === base;
}
