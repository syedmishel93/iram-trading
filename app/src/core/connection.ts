/**
 * Connection health — and an honest account of what "never blocked" can mean.
 *
 * WHAT WAS ASKED FOR, AND WHAT IS ACTUALLY POSSIBLE
 * The request was for a firewall, DDoS protection, and low latency so the
 * terminal is never blocked by a host. Two of those three are categories that
 * do not apply to a client, and saying so is more useful than shipping a
 * toggle that does nothing:
 *
 *  - A FIREWALL filters traffic arriving at a machine you control. This program
 *    accepts no inbound connections at all — there is nothing for a firewall to
 *    sit in front of. The desktop build opens no port; the web build cannot.
 *  - DDOS PROTECTION absorbs a flood aimed AT a server. It is something Binance
 *    buys, not something a client can have. A client on the other side of that
 *    protection can only avoid looking like the flood.
 *
 * The third is real, and so is the underlying goal. What actually stops a
 * venue blocking you is being a well-behaved client, and every part of that IS
 * implemented:
 *
 *  1. NEVER EXCEED THE PUBLISHED LIMIT. One weighted budget per host, set at a
 *     third of the ceiling, with real endpoint weights. (core/kernel.ts)
 *  2. BACK OFF MULTIPLICATIVELY ON REFUSAL. A 429 halves the sustained rate; a
 *     418 parks the host for the whole ban and never probes it, because probing
 *     a Binance ban extends it.
 *  3. DO NOT LOOK AUTOMATED. Jitter on every request, so the terminal does not
 *     emit a metronome of identical intervals.
 *  4. NEVER SEND THE SAME REQUEST TWICE. In-flight de-duplication and a
 *     response cache, so the cheapest request is the one not made.
 *  5. TELL A REFUSAL FROM A FAILURE. A 403 carrying HTML is a challenge page,
 *     not an API error. Retrying a network error is correct; retrying a
 *     refusal is precisely how a soft block becomes a hard one.
 *  6. HAVE SOMEWHERE ELSE TO GO. Six sources with automatic failover, so one
 *     venue parking you is not the end of the chart.
 *
 * THIS FILE ADDS THE SEVENTH: know which host is healthy, and say so.
 *
 * ON "ALWAYS ONLINE, OFFLINE ONLY WHEN THERE IS NO CONNECTION"
 * There is no offline MODE any more — nothing to switch on, nothing to forget
 * you left on. `online` is measured, not chosen. When the network genuinely
 * goes, everything that can degrade degrades and says why; when it returns,
 * everything comes back without being asked.
 */

import { signal, type ReadSignal, type Signal } from "./signal";

export type HostHealth = "ok" | "slow" | "throttled" | "blocked" | "unknown";

export interface HostReading {
  readonly host: string;
  readonly label: string;
  readonly health: HostHealth;
  readonly latencyMs: number;
  readonly samples: number;
  readonly note: string;
}

/** Above this a host is slow enough to prefer another. */
export const SLOW_MS = 900;

/** Below this many samples the median is not worth acting on. */
export const MIN_SAMPLES = 3;

/**
 * The shape this reads from the governor.
 *
 * Declared structurally rather than importing `HostState` so the connection
 * layer can be tested with plain objects and never needs a real governor.
 */
export interface HostSnapshot {
  readonly host: string;
  readonly label: string;
  readonly latencyMs: number;
  readonly latencySamples: number;
  readonly bannedUntil: number;
  readonly banReason: string;
  readonly softBlocked: boolean;
  readonly softBlockReason: string;
  readonly queued: number;
  readonly rejections: number;
  /** Epoch ms of the last refusal, or 0. See RECENT_REJECTION_MS. */
  readonly lastRejectionAt: number;
}

/**
 * How long a refusal keeps a host in the throttled band.
 *
 * MEASURED as a bug first: the classifier used the CUMULATIVE `rejections`
 * count, which only ever grows, so one 429 marked a host degraded for the rest
 * of the session while it answered perfectly. A monitor that is wrong in the
 * safe direction still stops being read.
 */
export const RECENT_REJECTION_MS = 60_000;

export function classifyHost(h: HostSnapshot, now: number): HostReading {
  const base = { host: h.host, label: h.label, latencyMs: h.latencyMs, samples: h.latencySamples };

  /* A ban outranks everything. A parked host is not slow, it is shut. */
  if (h.bannedUntil > now) {
    const seconds = Math.ceil((h.bannedUntil - now) / 1000);
    return {
      ...base,
      health: "blocked",
      note: `Parked for ${seconds}s. ${h.banReason || "The venue refused."} Waiting is the fastest way out; probing extends it.`,
    };
  }

  if (h.softBlocked) {
    return { ...base, health: "blocked", note: h.softBlockReason || "The venue is refusing this client." };
  }

  if (h.latencySamples < MIN_SAMPLES) {
    return {
      ...base,
      health: "unknown",
      note:
        h.latencySamples === 0
          ? "Not used yet."
          : `Only ${h.latencySamples} sample(s) — not enough to judge.`,
    };
  }

  const recentlyRefused = h.lastRejectionAt > 0 && now - h.lastRejectionAt < RECENT_REJECTION_MS;
  if (h.queued > 0 || recentlyRefused) {
    return {
      ...base,
      health: "throttled",
      note: recentlyRefused
        ? `Refused ${Math.round((now - h.lastRejectionAt) / 1000)}s ago; the sustained rate was halved and is climbing back.`
        : `${h.queued} request(s) waiting on this host's budget.`,
    };
  }

  if (h.latencyMs > SLOW_MS) {
    return { ...base, health: "slow", note: `${h.latencyMs}ms round trip — another venue will answer sooner.` };
  }

  return { ...base, health: "ok", note: `${h.latencyMs}ms round trip.` };
}

export interface ConnectionState {
  /** False only when the machine genuinely has no network. */
  readonly online: boolean;
  readonly hosts: readonly HostReading[];
  /** Fastest healthy host, or null when none is. */
  readonly fastest: HostReading | null;
  /**
   * The best figure available when there is no JUDGED host yet.
   *
   * MEASURED as a usability problem, not guessed: loading a chart makes ONE
   * governor request, so a fresh terminal sits below MIN_SAMPLES and the badge
   * read "—" until the third fetch. That is honest but useless — the number was
   * there the whole time, it just wasn't trustworthy enough to route on.
   *
   * So the two questions are separated. `fastest` answers "which venue should
   * the registry prefer?" and still demands a real median. `provisional`
   * answers "how is the connection right now?" and will show a one-sample
   * figure — clearly marked as one, never used for routing.
   */
  readonly provisional: HostReading | null;
  readonly blocked: readonly HostReading[];
  readonly note: string;
}

export function readConnection(
  online: boolean,
  snapshots: readonly HostSnapshot[],
  now: number,
): ConnectionState {
  const hosts = snapshots.map((h) => classifyHost(h, now));
  const blocked = hosts.filter((h) => h.health === "blocked");

  const healthy = hosts
    .filter((h) => h.health === "ok" || h.health === "slow")
    .sort((a, b) => a.latencyMs - b.latencyMs);
  const fastest = healthy[0] ?? null;

  /* Best figure available regardless of confidence. Blocked hosts are excluded
     — a parked venue's last round trip is not a reading on the connection. */
  const provisional =
    fastest ??
    hosts
      .filter((h) => h.health !== "blocked" && h.samples > 0)
      .sort((a, b) => a.latencyMs - b.latencyMs)[0] ??
    null;

  let note: string;
  if (!online) {
    note =
      "No network. Nothing is being fetched, and nothing is being invented to fill the gap — the chart shows what was already loaded and the freshness badge says how old it is.";
  } else if (hosts.length === 0) {
    note = "Online. No host has been used yet.";
  } else if (blocked.length > 0) {
    note = `${blocked.length} host(s) refusing: ${blocked.map((h) => h.label).join(", ")}. The registry will use the others.`;
  } else if (fastest) {
    note = `Online. Fastest venue is ${fastest.label} at ${fastest.latencyMs}ms.`;
  } else {
    /* Distinguish "nothing measured" from "nothing healthy". The first version
       said "not enough samples" in BOTH cases, which reported a throttled host
       as an unmeasured one — the opposite of the truth. */
    const throttled = hosts.filter((x) => x.health === "throttled");
    note =
      throttled.length > 0
        ? `Online. ${throttled.length} host(s) throttled and recovering: ${throttled.map((x) => x.label).join(", ")}.`
        : provisional
          ? `Online. ${provisional.label} answered in ${provisional.latencyMs}ms, but on ${provisional.samples} sample(s) — too few to route on yet.`
          : "Online, but no host has been measured yet.";
  }

  return { online, hosts, fastest, provisional, blocked, note };
}

export interface ConnectionMonitor {
  readonly state: ReadSignal<ConnectionState>;
  readonly online: Signal<boolean>;
  /** Recompute from the governor now. Cheap; no network. */
  refresh(): void;
  dispose(): void;
}

export interface MonitorOptions {
  readonly snapshots: () => readonly HostSnapshot[];
  readonly now?: () => number;
  /** How often to re-read the governor. No requests are made. */
  readonly intervalMs?: number;
}

/**
 * Watch the connection.
 *
 * `navigator.onLine` is the trigger, not the truth: it reports whether the
 * machine has a network interface, which is false-positive-prone (a captive
 * portal, a VPN with no route) and occasionally false-negative. So it is used
 * to react IMMEDIATELY to a change, while the authoritative signal is whether
 * requests are actually succeeding — which the governor already knows.
 */
export function createConnectionMonitor(opts: MonitorOptions): ConnectionMonitor {
  const now = opts.now ?? (() => Date.now());
  const online = signal<boolean>(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  const state = signal<ConnectionState>(readConnection(online.peek(), opts.snapshots(), now()));

  const refresh = (): void => {
    state.set(readConnection(online.peek(), opts.snapshots(), now()));
  };

  const goOnline = (): void => {
    online.set(true);
    refresh();
  };
  const goOffline = (): void => {
    online.set(false);
    refresh();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
  }

  const timer =
    typeof window !== "undefined"
      ? window.setInterval(refresh, opts.intervalMs ?? 5_000)
      : 0;

  return {
    state,
    online,
    refresh,
    dispose() {
      if (typeof window !== "undefined") {
        window.removeEventListener("online", goOnline);
        window.removeEventListener("offline", goOffline);
        if (timer) window.clearInterval(timer);
      }
    },
  };
}
