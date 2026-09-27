/**
 * Feed & network — what the terminal is talking to, as it talks to it.
 *
 * WHAT THIS ANSWERS THAT NOTHING ELSE DID
 * The status bar had one word for the entire network layer. Six sources, a
 * circuit breaker per source, a shared rate budget, a socket with a reconnect
 * ladder, a local archive and a poller all reported through the same chip. When
 * a chart stopped updating, the only available diagnosis was "STALE" — which is
 * a symptom, and one shared by at least five unrelated causes:
 *
 *   · the source has no socket and nothing was polling it   (the real one)
 *   · the socket is open but the venue stopped sending
 *   · the breaker parked the source and the fallback is slower
 *   · the host is rate-limited and every request is being refused
 *   · the market is shut and the feed is behaving perfectly
 *
 * Every one of those has a different response, and three of them are not faults
 * at all. This panel shows which.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * It never retries, reconnects, switches source or clears a breaker. Every
 * control here is one the operator already has elsewhere, and a diagnostic that
 * changes what it is diagnosing is worse than no diagnostic: you can no longer
 * tell whether the thing recovered or you fixed it.
 */

import { h, clear } from "./dom";
import { renderEffect, type Signal } from "../core/signal";
import { pkChip, pkEmpty, pkLabel, pkRows, pkSection, type PkRow } from "./panelkit";
import { summarise, type FeedEvent, type FeedLog } from "../data/feedlog";
import type { FeedState } from "../data/feed";
import type { Registry } from "../data/sources";
import { netHealth } from "../data/net";

export interface FeedMonOptions {
  readonly log: FeedLog;
  readonly state: () => FeedState;
  readonly transport: Signal<"socket" | "poll" | "none">;
  readonly pollEveryMs: Signal<number>;
  readonly activeSource: Signal<string>;
  readonly reconnects: Signal<number>;
  readonly registry: Registry;
  readonly symbol: () => string;
  /**
   * The broker's measured clock offset, or null when it has not been read.
   *
   * Not defaulted to zero: zero is a claim ("the broker stamps in UTC") and
   * null is the absence of one. Conflating those is how the terminal spent
   * months silently three hours out.
   */
  readonly clockOffsetMs: () => number | null;
}

export interface FeedMonHandle {
  readonly el: HTMLElement;
}

/** `4s` / `2m 10s` / `1h 04m`. Ages, not durations — coarse on purpose. */
export function age(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const hr = Math.floor(m / 60);
  return `${hr}h ${String(m % 60).padStart(2, "0")}m`;
}

/** `UTC+3` from a millisecond offset. Whole and half hours both read right. */
export function offsetLabel(ms: number | null): string {
  if (ms === null) return "not measured";
  if (ms === 0) return "UTC";
  const sign = ms < 0 ? "-" : "+";
  const total = Math.abs(Math.round(ms / 60_000));
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `UTC${sign}${hh}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

const KIND_LABEL: Readonly<Record<FeedEvent["kind"], string>> = {
  attempt: "try",
  switch: "switch",
  tick: "tick",
  poll: "poll",
  socket: "socket",
  load: "load",
  notice: "note",
};

function hhmmss(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * One log line.
 *
 * The time is local wall-clock rather than an age, because the operator is
 * correlating these against a chart and against their own memory of when
 * something looked wrong. Ages belong on the summary rows above, where the
 * question is "how long has this been true".
 */
function eventRow(e: FeedEvent): HTMLElement {
  return h(
    "div",
    { class: "fm-ev", "data-ok": String(e.ok), "data-kind": e.kind },
    h("span", { class: "fm-ev-t num", text: hhmmss(e.at) }),
    h("span", { class: "fm-ev-kind", text: KIND_LABEL[e.kind] }),
    h("span", { class: "fm-ev-src", text: e.source }),
    h("span", { class: "fm-ev-text", text: e.text }),
    h("span", {
      class: "fm-ev-ms num",
      text: typeof e.ms === "number" && Number.isFinite(e.ms) ? `${Math.round(e.ms)}ms` : "",
    }),
  ) as HTMLElement;
}

export function createFeedMonitor(o: FeedMonOptions): FeedMonHandle {
  const el = h("div", { class: "fm" }) as HTMLElement;

  // ---- what is carrying the data right now --------------------------------
  const transportRows = (): PkRow[] => {
    const t = o.transport();
    const st = o.state();
    const every = o.pollEveryMs();
    const rows: PkRow[] = [
      { label: "Source", value: o.activeSource() || "—" },
      {
        label: "Transport",
        value:
          t === "socket"
            ? "websocket"
            : t === "poll"
              ? `polling · ${Math.round(every / 1000)}s`
              : "nothing",
        ...(t === "none" ? { tone: "neg" as const } : {}),
        /* The distinction the STALE badge could not make. */
        ...(t === "none"
          ? { note: "not updating — the chart will go stale" }
          : t === "poll"
            ? { note: "no live stream, so it checks every few seconds" }
            : {}),
      },
      {
        label: "Last update",
        value: Number.isFinite(st.tickAgeMs) ? age(st.tickAgeMs) : "never",
        ...(st.quality === "stale" || st.quality === "offline" ? { tone: "neg" as const } : {}),
      },
      {
        label: "Quality",
        value: st.quality,
        note: st.note,
        tone:
          st.quality === "live"
            ? "pos"
            : st.quality === "closed"
              ? "mute"
              : st.quality === "delayed"
                ? "attn"
                : "neg",
      },
      {
        label: "Reconnects",
        value: String(o.reconnects()),
        ...(o.reconnects() > 0
          ? { note: "each gap was re-downloaded" }
          : {}),
      },
    ];
    return rows;
  };

  // ---- the clock, which was the bug ---------------------------------------
  const clockRows = (): PkRow[] => {
    const off = o.clockOffsetMs();
    return [
      {
        label: "Broker clock",
        value: offsetLabel(off),
        ...(off === null ? { tone: "attn" as const } : off === 0 ? {} : { tone: "pos" as const }),
        note:
          off === null
            ? "not measured — bar times shown as the broker sends them"
            : off === 0
              ? "broker uses UTC — no adjustment needed"
              : "measured and corrected on every bar and trade",
      },
    ];
  };

  // ---- per-source roll-up --------------------------------------------------
  const sourcesBody = h("div", { class: "fm-srcs" }) as HTMLElement;
  renderEffect(() => {
    clear(sourcesBody);
    const stats = new Map(summarise(o.log.events()).map((s) => [s.source, s]));
    const sym = o.symbol();
    const active = o.activeSource();
    for (const src of o.registry.sources) {
      const s = stats.get(src.id);
      const disabled = o.registry.isDisabled(src.id);
      const parked = o.registry.breaker.isOpen(src.id);
      const covers = src.supports(sym);
      sourcesBody.appendChild(
        h(
          "div",
          { class: "fm-src", "data-active": String(active === src.id) },
          h(
            "div",
            { class: "fm-src-head" },
            h("span", { class: "fm-src-name", text: src.label }),
            ...(disabled
              ? [pkChip("off", "neg")]
              : parked
                ? [pkChip("parked", "neg")]
                : active === src.id
                  ? [pkChip("serving", "pos")]
                  : covers
                    ? []
                    : [pkChip("n/a here")]),
          ),
          h("div", {
            class: "fm-src-note",
            text: disabled
              ? "switched off in Settings"
              : parked
                ? "paused after repeated failures — retries automatically"
                : !covers
                  ? `does not cover ${sym} — ${src.covers}`
                  : s
                    ? `${s.ok}/${s.attempts} ok${
                        Number.isFinite(s.avgMs) ? ` · ${Math.round(s.avgMs)}ms avg` : ""
                      } · ${s.lastNote}`
                    : "not used yet",
          }),
        ),
      );
    }
  });

  // ---- the rate budget -----------------------------------------------------
  const budgetRows = (): PkRow[] => {
    const n = netHealth();
    return [
      {
        label: "Requests",
        value: String(n.requests),
        ...(n.shared > 0 ? { note: `${n.shared} de-duplicated in flight` } : {}),
      },
      { label: "Saved by cache", value: String(n.saved) },
      {
        label: "Refused",
        value: String(n.rejections),
        ...(n.rejections > 0 ? { tone: "attn" as const } : {}),
      },
      {
        label: "Parked hosts",
        value: String(n.parked.length),
        ...(n.parked.length > 0 ? { tone: "neg" as const } : {}),
        note: n.parked.length > 0 ? n.parked.map((p) => p.host).join(", ") : n.note,
      },
    ];
  };

  // ---- the log -------------------------------------------------------------
  const logBody = h("div", { class: "fm-log" }) as HTMLElement;
  renderEffect(() => {
    clear(logBody);
    const events = o.log.events();
    if (events.length === 0) {
      logBody.appendChild(
        pkEmpty("empty", "Nothing yet. Load a symbol to see its data sources."),
      );
      return;
    }
    /* Capped at what a dock column can show without becoming a second scroll
       area inside the first. The ring holds far more; this is the window. */
    for (const e of events.slice(0, 60)) logBody.appendChild(eventRow(e));
  });

  /* `pkRowsLive` is the same shape; inlined here only because these four blocks
     each read a different set of signals and one wrapper per block keeps the
     invalidations from crossing. */
  const live = (fn: () => readonly PkRow[]): HTMLElement =>
    h("div", { class: "pk-live" }, () => pkRows(fn())) as HTMLElement;

  el.appendChild(pkSection("Carrying the data", undefined, live(transportRows)));
  el.appendChild(pkSection("Clock", "broker time vs ours", live(clockRows)));
  el.appendChild(pkSection("Sources", "in the order they are tried", sourcesBody));
  el.appendChild(pkSection("Rate budget", "shared by every panel", live(budgetRows)));
  el.appendChild(
    h(
      "div",
      { class: "pk-sec" },
      h(
        "div",
        { class: "fm-log-head" },
        pkLabel("Live log", "newest first"),
        h("button", {
          class: "ghost-btn fm-clear",
          type: "button",
          text: "Clear",
          title: "Clears this log only.",
          onclick: () => o.log.clear(),
        }),
      ),
      logBody,
    ),
  );

  return { el };
}
