/**
 * THE CONNECTIONS CARD — what this terminal depends on, and what each last said.
 *
 * Seven routes that had no caller anywhere in the frontend, all answering with
 * real content. They are one card rather than seven because they answer one
 * question — "is everything this thing needs actually reachable" — and seven
 * panels for one question is a process table.
 *
 * THE CLOCK OFFSET LEADS THE BROKER ROW
 *
 * MT5 stamps bars, ticks and deals on the BROKER'S clock, not UTC. The bridge
 * measures the offset from a live tick and subtracts it everywhere. That
 * correction was invisible, and CLAUDE.md records what the same class of error
 * cost when it went the other way: every TwelveData bar displaced by the
 * server's own UTC offset, nothing failing, the chart drawing the right candles
 * in the wrong places. A correction you cannot see is one you cannot check.
 *
 * A ZERO IS NOT A FAILURE HERE. No open streams is the normal state of a
 * terminal nobody has a live feed open on, so it is stated as a count and not
 * coloured — the opposite mistake to `/svc/health` painting "0 of 0 running"
 * green.
 */

import { each, h } from "../dom";
import { signal } from "../../core/signal";
import { pkFold, pkWhy } from "../panelkit";
import {
  backupAge,
  backupState,
  bridgeStatus,
  clockLine,
  kvManifest,
  kvSize,
  providerList,
  providerRank,
  routerHealth,
  streamStatus,
  type BridgeStatus,
  type KvEntry,
  type ProviderRank,
  type RouterHealth,
} from "../../data/services";
import { lastBackup } from "../../data/settingsbackup";

const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function createConnectionsCard(): { readonly el: HTMLElement; refresh(): void } {
  const bridge = signal<BridgeStatus | null>(null);
  const router = signal<RouterHealth | null>(null);
  const providers = signal<{ providers: readonly string[]; keyless: readonly string[] } | null>(null);
  const rank = signal<ProviderRank | null>(null);
  const kv = signal<Readonly<Record<string, KvEntry>>>({});
  const backupT = signal(0);
  const streams = signal<{ upstreams: number; clients: number } | null>(null);
  /** One per row: null until asked, so nothing claims absence before asking. */
  const errs = signal<Readonly<Record<string, string>>>({});

  const note = (k: string, why: string): void =>
    errs.update((m) => ({ ...m, [k]: why }));
  const clearNote = (k: string): void =>
    errs.update((m) => {
      const { [k]: _drop, ...rest } = m;
      return rest;
    });

  const refresh = (): void => {
    void bridgeStatus().then((a) => {
      if (a.kind === "offline") return note("bridge", a.why);
      clearNote("bridge");
      bridge.set(a.value.bridge ?? null);
    });
    void routerHealth().then((a) => {
      if (a.kind === "offline") return note("router", a.why);
      clearNote("router");
      router.set(a.value);
    });
    void providerList().then((a) => {
      if (a.kind === "offline") return note("providers", a.why);
      clearNote("providers");
      providers.set(a.value);
    });
    void providerRank().then((a) => {
      if (a.kind === "ok") rank.set(a.value);
    });
    void kvManifest().then((a) => {
      if (a.kind === "offline") return note("kv", a.why);
      clearNote("kv");
      kv.set(a.value.manifest ?? {});
    });
    void backupState().then((a) => {
      if (a.kind === "offline") return note("backup", a.why);
      clearNote("backup");
      backupT.set(typeof a.value.t === "number" ? a.value.t : 0);
    });
    void streamStatus().then((a) => {
      if (a.kind === "offline") return note("streams", a.why);
      clearNote("streams");
      streams.set({ upstreams: a.value.upstreams ?? 0, clients: a.value.clients ?? 0 });
    });
  };

  /** One line: a name, a state, and the sentence that qualifies it. */
  const line = (
    name: string,
    state: () => string,
    detail: () => string,
    level: () => "ok" | "bad" | "attn" | "none",
  ): HTMLElement =>
    h(
      "div",
      { class: "cx-row", "data-level": level },
      h("span", { class: "cx-name", text: name }),
      h("span", { class: "cx-state", text: state }),
      h("p", { class: "cx-detail", text: detail }),
    ) as HTMLElement;

  const bridgeLevel = (): "ok" | "bad" | "attn" | "none" => {
    if (errs()["bridge"]) return "attn";
    const b = bridge();
    if (!b) return "none";
    if (!b.available || !b.connected) return "bad";
    /* Connected but with an UNMEASURED clock is not a clean pass: every broker
       timestamp is then being taken at face value. */
    return b.clock?.measured ? "ok" : "attn";
  };

  const backupLevel = (): "ok" | "bad" | "attn" | "none" => {
    if (errs()["backup"]) return "attn";
    const a = backupAge(backupT(), Date.now());
    if (a.days === null) return "attn";
    return a.stale ? "attn" : "ok";
  };

  const rankRows = (): readonly { readonly cls: string; readonly order: string }[] => {
    const r = rank();
    if (!r?.rank) return [];
    return Object.entries(r.rank).map(([cls, order]) => ({ cls, order: order.join(" → ") }));
  };

  const rankBox = h("div", { class: "cx-rank" }) as HTMLElement;
  each(rankBox, rankRows, (x) => x.cls, (x) =>
    h(
      "div",
      { class: "cx-rank-row" },
      h("span", { class: "cx-rank-cls", text: x.cls }),
      h("span", { class: "cx-rank-order", text: x.order }),
    ) as HTMLElement,
  );

  const el = h(
    "section",
    { class: "dd-panel cx" },
    h("h3", { class: "pf-sub", text: "What this terminal is connected to" }),

    line(
      "Broker bridge",
      () => {
        if (errs()["bridge"]) return "could not ask";
        const b = bridge();
        if (!b) return "…";
        if (!b.available) return "not installed";
        return b.connected ? "connected" : "not connected";
      },
      () => {
        const e = errs()["bridge"];
        if (e) return e;
        const b = bridge();
        if (!b) return "";
        if (!b.available) return b.last_err || "The MT5 bridge is not available on this machine.";
        /* THE CLOCK IS THE POINT OF THIS ROW. */
        return clockLine(b.clock);
      },
      bridgeLevel,
    ),

    line(
      "Router",
      () => {
        if (errs()["router"]) return "could not ask";
        const r = router();
        if (!r) return "…";
        return r.ok ? "ready" : "not ready";
      },
      () => {
        const e = errs()["router"];
        if (e) return e;
        const r = router();
        if (!r) return "";
        return r.ok
          ? `${r.engine}. It needs ${r.minRows.toLocaleString()} graded trades before it will make a call.`
          : r.why || "The router is not ready and did not say why.";
      },
      () => (errs()["router"] ? "attn" : router() ? (router()?.ok ? "ok" : "attn") : "none"),
    ),

    line(
      "Data vendors",
      () => {
        if (errs()["providers"]) return "could not ask";
        const p = providers();
        return p ? `${p.providers.length} wired` : "…";
      },
      () => {
        const e = errs()["providers"];
        if (e) return e;
        const p = providers();
        if (!p) return "";
        /* WHICH ONES WORK WITHOUT A KEY is the fact an operator acts on. */
        return `${p.keyless.join(" and ")} need no API key. The rest are only used if you have supplied one.`;
      },
      () => (errs()["providers"] ? "attn" : providers() ? "ok" : "none"),
    ),

    line(
      "Settings backup",
      () => {
        if (errs()["backup"]) return "could not ask";
        const a = backupAge(backupT(), Date.now());
        if (a.days === null) return "never";
        return a.days < 1 ? "today" : `${Math.round(a.days)} days ago`;
      },
      () => {
        const e = errs()["backup"];
        if (e) return e;
        /* THE LAST ATTEMPT, not the intention. "Backed up" with no evidence is
           the reassurance that survives the mechanism stopping — which is
           exactly what happened here: the route had no caller for its whole
           life and the server held a test fixture. */
        const push = lastBackup();
        if (push && !push.ok) return `The last backup did not go through: ${push.why}`;
        const a = backupAge(backupT(), Date.now());
        if (a.days === null) return "Nothing has been backed up to the server yet.";
        const size = kvSize(kv());
        const where = size.slots > 0
          ? ` This browser holds ${size.slots} slots, ${kb(size.total)} in all, the largest being ${size.largest}.`
          : "";
        return a.stale
          ? `The backup loop runs daily, so this is older than it should be.${where}`
          : `The server keeps a copy that survives clearing this browser.${where}`;
      },
      backupLevel,
    ),

    line(
      "Live streams",
      () => {
        if (errs()["streams"]) return "could not ask";
        const s = streams();
        return s ? `${s.upstreams} open` : "…";
      },
      () => {
        const e = errs()["streams"];
        if (e) return e;
        const s = streams();
        if (!s) return "";
        /* NOT COLOURED. Zero streams is the normal state of a terminal nobody
           has a live feed open on, and painting it red would make the ordinary
           case look broken. */
        return s.upstreams === 0
          ? "Nothing is subscribed to a live feed right now. That is the usual state."
          : `${s.clients} client${s.clients === 1 ? "" : "s"} attached.`;
      },
      () => (errs()["streams"] ? "attn" : "none"),
    ),

    pkFold("Which vendor is trusted for what", h("div", { class: "cx-rank-wrap" }, rankBox, h("p", {
      class: "cx-rank-note",
      text: () => rank()?.note ?? "",
    }))),

    pkWhy(
      "These are the services this terminal talks to, and each row says what it last answered rather than whether " +
        "it is supposed to be there. The broker line leads with the clock offset because MT5 stamps its bars and " +
        "deals on the broker's own clock: the offset is measured from a live tick and subtracted everywhere, and a " +
        "correction you cannot see is one you cannot check. An offset that has NOT been measured is not the same as " +
        "one measured at zero, and the two are never drawn alike.",
      "Why the broker's clock is the first thing here",
    ),
  ) as HTMLElement;

  refresh();
  return { el, refresh };
}
