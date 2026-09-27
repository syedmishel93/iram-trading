/**
 * Data desk — storage, cache, network budget, sync and backup.
 *
 * Every one of these was previously invisible. The archive grew without limit
 * and nobody could see what was in it; the cache did not exist; the request
 * budget did not exist; there was no backup and no way to move a setup between
 * machines. You cannot manage what you cannot see, and a terminal that silently
 * accumulates a gigabyte of 1-minute bars until IndexedDB refuses a write is
 * managing nothing.
 *
 * THE RULE FOR EVERY DESTRUCTIVE CONTROL HERE
 * Preview first, then apply the PREVIEWED plan. Not "recompute and delete" —
 * the plan you approved is the plan that runs. Some of this history is not
 * re-downloadable at any price, so a control that deletes what it did not show
 * you is not acceptable, however convenient.
 */

import { signal, effect, renderEffect } from "../core/signal";
import { h, clear } from "./dom";
import { scheduleFrame } from "../core/frame";
import { parseSeriesKey, type BarArchive, type SeriesInventory } from "../store/barstore";
import {
  planRetention,
  applyRetention,
  ruleFor,
  DEFAULT_POLICY,
  DEFAULT_RETENTION,
  fmtBytes,
  fmtAge,
  type RetentionPlan,
} from "../store/retention";
import { responseCache, governor, netHealth, resetNet, supervisor } from "../data/net";
import type { KernelJob } from "../core/kernel";
import { intervalMs, type HistoryService } from "../data/history";
import { sharedKnowledge, type KnowledgeBase } from "../learn/knowledge";
import { createStudyStore, STUDIES_SLOT, TIMINGS_SLOT, type StudyRecord } from "../study/store";
import type { Timings } from "../study/plan";
import { YEAR_MS } from "../study/window";
import { MAX_STUDY_BARS } from "./study/state";
import {
  deletable,
  defaultOpenGroups,
  filterSeries,
  groupBySymbol,
  coverageLanes,
  coverageYears,
  groupLine,
  learnedItems,
  planTopUp,
  usedBy,
  TOPUP_PAGE,
  TOPUP_PER_PASS,
  type LearnedItem,
  type LibrarySort,
} from "./research/library";
import { whoTag } from "./today/card";
import { pkFold, pkWhy } from "./panelkit";
import type { KV } from "../store/kv";
import {
  createSync,
  localServiceAdapter,
  SYNC_CREDENTIAL_KEY,
  type SyncAdapter,
  type SyncOutcome,
} from "../store/sync";
import {
  supabaseAdapter,
  restAdapter,
  validateSupabaseConfig,
  newSpaceId,
  type SupabaseConfig,
} from "../store/supabase";
import {
  exportVault,
  importVault,
  inspectVault,
  serialiseVault,
  vaultFilename,
  type VaultInspection,
} from "../store/vault";
import { gatewayBase, isConsolidated } from "../data/backend";
import { MACRO_SPINE } from "../data/library";
import { watchedSymbols } from "./watchlist";
import { UNREACHABLE, healthLabel, healthTone, probeGateway, type GatewayHealth } from "../data/gateway";

export interface DataHandle {
  el: HTMLElement;
  activate(): void;
}

export interface DataOptions {
  archive: BarArchive;
  kv: KV;
  /** Series the terminal is using right now; never swept. */
  pinned: () => string[];
  /**
   * The archive-backed history service. OPTIONAL: without it the library
   * cannot download or update a series, and those controls are not drawn —
   * a Download button with nothing behind it would be a lie.
   */
  history?: HistoryService;
  /** The knowledge base. Defaults to the shared one — there is only one. */
  knowledge?: KnowledgeBase;
}

/** Whether the library keeps its series up to date in the background. Off by default. */
const TOPUP_SLOT = {
  key: "research.topup",
  version: 1,
  fallback: (): boolean => false,
  validate: (v: unknown): boolean | null => (typeof v === "boolean" ? v : null),
};

const TOPUP_JOB = "library-topup";

type TargetKind = "none" | "local" | "supabase" | "rest";

interface SyncConfig {
  kind: TargetKind;
  supabase?: Partial<SupabaseConfig>;
  rest?: { base: string; token?: string };
}

const syncConfigSlot = {
  key: SYNC_CREDENTIAL_KEY,
  version: 1,
  fallback: (): SyncConfig => ({ kind: "none" }),
  validate: (v: unknown): SyncConfig | null => {
    if (v === null || typeof v !== "object") return null;
    const r = v as SyncConfig;
    return ["none", "local", "supabase", "rest"].includes(r.kind) ? r : null;
  },
};

const pct = (v: number): string => `${Math.round(v * 100)}%`;

const when = (at: number, now: number): string => {
  if (!Number.isFinite(at) || at <= 0) return "never";
  const ms = now - at;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
};

const day = (t: number): string =>
  Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "—";

export function createData(opts: DataOptions): DataHandle {
  const inventory = signal<SeriesInventory[]>([]);
  const plan = signal<RetentionPlan | null>(null);
  const busy = signal<string | null>(null);
  const message = signal<string | null>(null);
  const tick = signal(0);

  const sync = createSync(opts.kv);
  const syncCfg = signal<SyncConfig>(opts.kv.get(syncConfigSlot));
  const syncResult = signal<SyncOutcome | null>(null);
  const pending = signal<{ text: string; inspection: VaultInspection } | null>(null);

  const policy = (): typeof DEFAULT_POLICY => ({
    ...DEFAULT_POLICY,
    pinned: opts.pinned(),
  });

  const refresh = async (): Promise<void> => {
    inventory.set(await opts.archive.inventory());
    tick.update((n) => n + 1);
  };

  const adapterFor = (cfg: SyncConfig): SyncAdapter | null => {
    if (cfg.kind === "local") return localServiceAdapter();
    if (cfg.kind === "supabase") {
      const s = cfg.supabase;
      if (!s || validateSupabaseConfig(s).length > 0) return null;
      return supabaseAdapter(s as SupabaseConfig);
    }
    if (cfg.kind === "rest" && cfg.rest?.base) {
      return restAdapter(cfg.rest.base, cfg.rest.token);
    }
    return null;
  };

  const saveCfg = (next: SyncConfig): void => {
    syncCfg.set(next);
    opts.kv.write(syncConfigSlot, next);
  };

  // ------------------------------------------------------------- storage --

  const totals = (): { series: number; bars: number; bytes: number } => {
    const inv = inventory();
    return {
      series: inv.length,
      bars: inv.reduce((a, s) => a + s.bars, 0),
      bytes: inv.reduce((a, s) => a + s.approxBytes, 0),
    };
  };

  /* ── the library: which studies use each series, and per-row actions ── */

  const studyStore = createStudyStore(opts.kv);
  const studies = signal<readonly StudyRecord[]>(studyStore.list());
  const timings = signal<Timings>(studyStore.timings());
  /* Read from the store on every change, including another tab's: the store
     keeps no copy of its own, so there is nothing here that can go stale. */
  opts.kv.subscribe((key) => {
    if (key === STUDIES_SLOT.key) studies.set(studyStore.list());
    if (key === TIMINGS_SLOT.key) timings.set(studyStore.timings());
  });

  /** The series whose Delete is waiting for its second click. */
  const confirmDelete = signal<string | null>(null);

  /**
   * THE LIBRARY IS A LIST OF SERIES; THE OPERATOR THINKS IN MARKETS.
   *
   * Flat, the table listed BTCUSDT four times — 1h, 5m, 1d, 15m — scattered
   * among every other market by whatever order the store returned. "How much
   * BTC do I hold" could only be answered by reading the whole table and adding
   * up. Grouping by symbol answers it in the group's own header, and it is the
   * unit every bulk action is actually aimed at: you refresh a MARKET.
   */
  const filterText = signal("");
  const sortBy = signal<LibrarySort>("symbol");
  const selected = signal<ReadonlySet<string>>(new Set<string>());
  /** The bulk Delete waiting for its second click — same two-step as a row. */
  const confirmBulk = signal(false);

  /**
   * WHICH MARKETS ARE EXPANDED.
   *
   * `null` means "nobody has said", and the default answer is computed from
   * what is on the chart. Storing the default AS a set instead would freeze it
   * at whatever was pinned when the desk first rendered, so switching the
   * chart's symbol would leave the wrong market open with no way to tell why.
   * The first click turns the question into an explicit set, seeded from the
   * default so nothing appears to jump shut.
   */
  const openGroups = signal<ReadonlySet<string> | null>(null);
  const autoOpen = (): ReadonlySet<string> => defaultOpenGroups(inventory(), new Set(opts.pinned()));
  /* A query IS a request to see what matches, so it overrides the state
     entirely rather than being ANDed with it — otherwise searching a shut
     market returns "1 of 10 series" and shows nothing, which reads as a bug. */
  const isOpen = (symbol: string): boolean =>
    filterText().trim() !== "" || (openGroups() ?? autoOpen()).has(symbol);
  const toggleOpen = (symbol: string): void =>
    openGroups.update((cur) => {
      const next = new Set(cur ?? autoOpen());
      if (!next.delete(symbol)) next.add(symbol);
      return next;
    });

  const toggleSel = (key: string): void =>
    selected.update((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const setSel = (keys: readonly string[], on: boolean): void =>
    selected.update((cur) => {
      const next = new Set(cur);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  /* Both of these are `ui/research/library.ts`, which is where the library's
     reasoning lives so that it can be tested against a fixture rather than
     trusted because the table looked right. */
  const shown = (): SeriesInventory[] => filterSeries(inventory(), filterText(), sortBy());
  const grouped = (): ReturnType<typeof groupBySymbol> => groupBySymbol(shown());

  const deleteSeries = (s: SeriesInventory): void => {
    busy.set("delete");
    void (async () => {
      try {
        await opts.archive.clear({ source: s.source, symbol: s.symbol, timeframe: s.timeframe });
        message.set(`Deleted ${s.symbol} ${s.timeframe} from ${s.source}: ${s.bars.toLocaleString()} bars, ${fmtBytes(s.approxBytes)}. Anything that needs it will download it again.`);
      } catch (err) {
        message.set(`${s.symbol} ${s.timeframe} could not be deleted — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        confirmDelete.set(null);
        busy.set(null);
        await refresh();
      }
    })();
  };

  const updateSeries = (s: SeriesInventory): void => {
    const history = opts.history;
    if (history === undefined) return;
    busy.set(`update:${s.key}`);
    void (async () => {
      try {
        const before = s.bars;
        await history.load(s.symbol, s.timeframe, { refresh: true, limit: TOPUP_PAGE });
        await refresh();
        const after = inventory().filter((x) => x.symbol === s.symbol && x.timeframe === s.timeframe).reduce((a, x) => a + x.bars, 0);
        message.set(`${s.symbol} ${s.timeframe}: fetched the latest ${TOPUP_PAGE.toLocaleString()} bars; the library now holds ${after.toLocaleString()} (was ${before.toLocaleString()} in this copy).`);
      } catch (err) {
        message.set(`${s.symbol} ${s.timeframe} could not be updated — ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        busy.set(null);
      }
    })();
  };

  /**
   * Bulk update, SEQUENTIALLY and reporting what it lost.
   *
   * Parallel is how a free vendor tier starts refusing, and a bulk action that
   * counts only its successes is the shape this repository already records:
   * anything tolerating a partial failure names what it lost.
   */
  const updateSelected = (): void => {
    const history = opts.history;
    if (history === undefined) return;
    const rows = inventory().filter((x) => selected().has(x.key));
    if (rows.length === 0) return;
    busy.set("bulk");
    void (async () => {
      const failed: string[] = [];
      let ok = 0;
      try {
        for (const [i, r] of rows.entries()) {
          bulkNote.set(`Updating ${r.symbol} ${r.timeframe} — ${i + 1} of ${rows.length}`);
          try {
            await history.load(r.symbol, r.timeframe, { refresh: true, limit: TOPUP_PAGE });
            ok += 1;
          } catch (err) {
            failed.push(`${r.symbol} ${r.timeframe}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        await refresh();
        message.set(
          `${ok} of ${rows.length} series updated.` +
            (failed.length > 0 ? ` ${failed.length} did not: ${failed.slice(0, 3).join("; ")}` : ""),
        );
      } finally {
        bulkNote.set("");
        busy.set(null);
      }
    })();
  };

  const deleteSelected = (): void => {
    const { remove: rows, skipped: left } = deletable(inventory(), selected(), new Set(opts.pinned()));
    const skipped = left.length;
    if (rows.length === 0) {
      message.set("Nothing to delete — everything selected is on the chart right now.");
      confirmBulk.set(false);
      return;
    }
    busy.set("bulk");
    void (async () => {
      let bars = 0;
      let bytes = 0;
      const failed: string[] = [];
      try {
        for (const [i, r] of rows.entries()) {
          bulkNote.set(`Deleting ${r.symbol} ${r.timeframe} — ${i + 1} of ${rows.length}`);
          try {
            await opts.archive.clear({ source: r.source, symbol: r.symbol, timeframe: r.timeframe });
            bars += r.bars;
            bytes += r.approxBytes;
          } catch (err) {
            failed.push(`${r.symbol} ${r.timeframe}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        await refresh();
        message.set(
          `Deleted ${rows.length - failed.length} series: ${bars.toLocaleString()} bars, ${fmtBytes(bytes)}.` +
            (skipped > 0 ? ` ${skipped} left alone — on the chart right now.` : "") +
            (failed.length > 0 ? ` ${failed.length} failed: ${failed.slice(0, 3).join("; ")}` : ""),
        );
      } finally {
        selected.set(new Set<string>());
        confirmBulk.set(false);
        bulkNote.set("");
        busy.set(null);
      }
    })();
  };

  const seriesTable = h("div", { class: "dd-table lib-table" });
  renderEffect(() => {
    const groups = grouped();
    const pinned = new Set(opts.pinned());
    const recs = studies();
    const confirming = confirmDelete();
    const sel = selected();
    clear(seriesTable);

    if (inventory().length === 0) {
      seriesTable.appendChild(
        h("p", {
          class: "dd-empty prose",
          text: "The library is empty. It fills as you load charts and run studies — every series is kept, with its gaps and where it came from.",
        }),
      );
      return;
    }
    if (groups.length === 0) {
      seriesTable.appendChild(
        h("p", { class: "dd-empty prose", text: `No series matches “${filterText()}”. ${inventory().length} are held.` }),
      );
      return;
    }

    for (const g of groups) {
      const keys = g.rows.map((r) => r.key);
      const all = keys.every((k) => sel.has(k));
      const open = isOpen(g.symbol);
      const chosen = keys.filter((k) => sel.has(k)).length;
      const onChart = g.rows.some((r) => pinned.has(r.key));
      seriesTable.appendChild(
        h(
          "div",
          { class: "lib-group", "data-open": open ? "true" : "false" },
          h("input", {
            class: "lib-check",
            type: "checkbox",
            checked: all,
            "aria-label": `Select every ${g.symbol} series`,
            /* PARTIAL IS ITS OWN STATE. With one of two rows ticked and the
               market shut, an empty box says "nothing here is selected" while
               bulk Delete is aimed at one of them. `indeterminate` is a
               PROPERTY with no matching attribute, so it cannot be set through
               props and needs the ref; the table is rebuilt whole on every
               change, so a plain assignment here is never stale. */
            ref: (el: HTMLInputElement) => {
              el.indeterminate = chosen > 0 && !all;
            },
            onchange: (e: Event) => setSel(keys, (e.target as HTMLInputElement).checked),
          }),
          /* The disclosure is a BUTTON and the checkbox is its sibling: a
             checkbox nested inside a button is invalid, and a click that both
             selects and expands is a control nobody can predict. */
          h(
            "button",
            {
              class: "lib-caret",
              type: "button",
              "aria-expanded": String(open),
              title: open ? `Hide ${g.symbol}'s bar sizes` : `Show ${g.symbol}'s bar sizes`,
              onclick: () => toggleOpen(g.symbol),
            },
            h("span", { class: "lib-group-sym", text: g.symbol }),
            h("span", { class: "lib-group-meta", text: groupLine(g, fmtBytes) }),
          ),
          /* A SELECTION INSIDE A SHUT GROUP MUST STILL BE VISIBLE. Bulk Delete
             acts on it, and a count the operator cannot see is the same shape
             as a bulk action that silently does less than it was asked. */
          ...(chosen > 0 && !all ? [h("span", { class: "lib-group-sel", text: `${chosen} selected` })] : []),
          ...(onChart ? [h("span", { class: "lib-group-chart", text: "on the chart" })] : []),
        ),
      );

      if (!open) continue;

      for (const s of g.rows) {
        const rule = ruleFor(DEFAULT_RETENTION, s.timeframe);
        const isPinned = pinned.has(s.key);
        const users = usedBy(s, recs, pinned);
        const policy = rule.keepMs === null ? "Kept forever by the retention policy." : `The retention policy keeps ${fmtAge(rule.keepMs)} of it.`;
        const acts: HTMLElement[] =
          confirming === s.key
            ? [
                h("button", {
                  class: "ghost-btn dd-danger",
                  type: "button",
                  text: "Delete",
                  title: `Remove ${s.bars.toLocaleString()} bars. Some history cannot be downloaded again at any price.`,
                  disabled: () => busy() !== null,
                  onclick: () => deleteSeries(s),
                }) as HTMLElement,
                h("button", { class: "ghost-btn", type: "button", text: "Keep", onclick: () => confirmDelete.set(null) }) as HTMLElement,
              ]
            : [
                ...(opts.history === undefined
                  ? []
                  : [
                      h("button", {
                        class: "ghost-btn",
                        type: "button",
                        text: () => (busy() === `update:${s.key}` ? "Updating…" : "Update"),
                        title: "Fetch the newest bars for this series",
                        disabled: () => busy() !== null,
                        onclick: () => updateSeries(s),
                      }) as HTMLElement,
                    ]),
                h("button", {
                  class: "ghost-btn",
                  type: "button",
                  text: "Delete",
                  /* The chart's own series cannot be deleted from under it — the
                     same pin the retention sweep honours. */
                  disabled: isPinned ? "" : undefined,
                  title: isPinned ? "On the chart right now, so it cannot be deleted." : "Asks once more before deleting",
                  onclick: () => confirmDelete.set(s.key),
                }) as HTMLElement,
              ];
        seriesTable.appendChild(
          h(
            "div",
            { class: "dd-row lib-row", "data-pinned": isPinned ? "true" : "false", title: policy },
            h("input", {
              class: "lib-check",
              type: "checkbox",
              checked: sel.has(s.key),
              "aria-label": `Select ${s.symbol} ${s.timeframe}`,
              onchange: () => toggleSel(s.key),
            }),
            h(
              "span",
              { class: "dd-tf mono" },
              h("span", { text: s.timeframe }),
              ...(s.qualities.includes("demo")
                ? [h("span", { class: "chip", "data-tone": "attn", text: "DEMO" })]
                : []),
            ),
            h("span", { class: "dd-src", text: s.source }),
            h("span", { class: "dd-range mono", text: `${day(s.oldest)} → ${day(s.newest)}` }),
            h("span", { class: "num num-right", text: s.bars.toLocaleString() }),
            h("span", { class: "num num-right", text: fmtBytes(s.approxBytes) }),
            h("span", { class: "dd-policy", text: users.length === 0 ? "—" : users.join(", ") }),
            h("span", { class: "rs-lib-acts" }, ...acts),
          ),
        );
        if (confirming === s.key) {
          seriesTable.appendChild(
            h("p", {
              class: "dd-problem prose",
              text:
                users.length === 0
                  ? `Delete ${s.symbol} ${s.timeframe} from ${s.source}? ${s.bars.toLocaleString()} bars, ${fmtBytes(s.approxBytes)}. Nothing saved uses it.`
                  : `Delete ${s.symbol} ${s.timeframe} from ${s.source}? ${s.bars.toLocaleString()} bars. Used by ${users.join(", ")} — they will download it again when next run, if the vendor still serves that far back.`,
            }),
          );
        }
      }
    }
  });

  const planBox = h("div", { class: "dd-plan" });
  renderEffect(() => {
    const p = plan();
    clear(planBox);
    if (!p) return;

    planBox.appendChild(
      h("p", { class: "dd-plan-summary", text: p.summary }),
    );
    if (p.changes.length > 0) {
      const list = h("div", { class: "dd-plan-list" });
      for (const c of p.changes.slice(0, 25)) {
        list.appendChild(
          h(
            "div",
            { class: "dd-plan-row", "data-kind": c.kind },
            h("span", { class: "dd-plan-kind", text: c.kind.toUpperCase() }),
            h("span", { class: "dd-plan-sym", text: `${c.symbol} ${c.timeframe}` }),
            h("span", {
              class: "num num-right",
              text: `${c.bars.toLocaleString()} bars · ${fmtBytes(c.bytes)}`,
            }),
            h("span", { class: "dd-plan-why prose", text: c.reason }),
          ),
        );
      }
      planBox.appendChild(list);
      planBox.appendChild(
        h("button", {
          class: "primary-btn dd-danger",
          text: () => (busy() === "apply" ? "Deleting…" : `Delete ${p.changes.length} — free ${fmtBytes(p.bytesFreed)}`),
          disabled: () => busy() !== null,
          onclick: () => {
            busy.set("apply");
            void (async () => {
              // The PREVIEWED plan runs, not a freshly recomputed one. The
              // approval was for what was on screen.
              const result = await applyRetention(opts.archive, p);
              await refresh();
              plan.set(null);
              busy.set(null);
              message.set(
                `Removed ${result.barsRemoved.toLocaleString()} bars, freeing ${fmtBytes(
                  result.bytesFreed,
                )}.${result.errors.length > 0 ? ` ${result.errors.length} series failed.` : ""}`,
              );
            })();
          },
        }),
      );
    }
  });

  /* ── download: markets and bar sizes, into the library ─────────────── */

  const dlSymbol = h("input", {
    class: "dd-input lib-sym mono",
    type: "text",
    spellcheck: "false",
    placeholder: "BTCUSDT, XAUUSD, ETHUSDT…",
    "aria-label": "Symbols to download, separated by commas",
  });
  /**
   * TIMEFRAMES ARE A SET, NOT A CHOICE.
   *
   * A `<select>` downloads one bar size per press, so filling one market at 1h,
   * 1d and 5m was three trips through the form — and nobody studies a single
   * timeframe. Chips, so "this market, properly" is one press; the queue line
   * names the leg in flight, because "Downloading…" for four minutes is
   * indistinguishable from a hang.
   */
  const DL_TFS = ["5m", "15m", "1h", "4h", "1d"] as const;
  const dlTimeframes = signal<readonly string[]>(["1h"]);
  const toggleTf = (t: string): void =>
    dlTimeframes.update((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const dlDepth = h(
    "select",
    { class: "dd-select", "aria-label": "How much history" },
    ...([[2, "2 years"], [1, "1 year"], [5, "5 years"]] as const).map(([v, t]) => h("option", { value: String(v), text: t })),
  );

  /** How far a download has reached, so a long run is legibly in progress. */
  const dlQueue = signal<{ done: number; total: number; now: string } | null>(null);

  const downloadSeries = (): void => {
    const history = opts.history;
    if (history === undefined) return;
    const symbols = [
      ...new Set(
        dlSymbol.value
          .split(/[,\s]+/)
          .map((x) => x.trim().toUpperCase())
          .filter((x) => x !== ""),
      ),
    ];
    const tfs = [...dlTimeframes()];
    if (symbols.length === 0 || tfs.length === 0) {
      message.set("Name at least one symbol, and pick at least one bar size.");
      return;
    }
    const years = Number(dlDepth.value);
    const legs = symbols.flatMap((symbol) => tfs.map((tf) => ({ symbol, tf })));

    busy.set("download");
    message.set(null);
    dlQueue.set({ done: 0, total: legs.length, now: "" });
    void (async () => {
      const failed: string[] = [];
      let ok = 0;
      let capped = false;
      try {
        for (const [i, leg] of legs.entries()) {
          dlQueue.set({ done: i, total: legs.length, now: `${leg.symbol} ${leg.tf}` });
          /* The same ceiling a study fetches to (`MAX_STUDY_BARS`), for the same
             reason: past it the fetch is minutes long and the bars describe
             markets that no longer exist. */
          const wanted = Math.ceil((years * YEAR_MS) / intervalMs(leg.tf));
          const target = Math.min(MAX_STUDY_BARS, wanted);
          if (wanted > target) capped = true;
          try {
            const first = await history.load(leg.symbol, leg.tf, { limit: Math.min(target, TOPUP_PAGE) });
            if (first.bars.length === 0) {
              failed.push(`${leg.symbol} ${leg.tf}: no source had it`);
              continue;
            }
            if (first.bars.length < target) {
              await history.backfill(leg.symbol, leg.tf, target, {
                onProgress: (n) =>
                  dlQueue.set({
                    done: i,
                    total: legs.length,
                    now: `${leg.symbol} ${leg.tf} — ${n.toLocaleString()} older bars so far`,
                  }),
              });
            }
            ok += 1;
          } catch (err) {
            failed.push(`${leg.symbol} ${leg.tf}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        await refresh();
        /* A PARTIAL RUN NAMES WHAT IT LOST. A count of successes with the
           failures dropped is the defect shape this repository already records
           for a study whose dead vendors vanished from its window. */
        message.set(
          `${ok} of ${legs.length} downloaded.` +
            (capped ? ` Capped at ${MAX_STUDY_BARS.toLocaleString()} bars each.` : "") +
            (failed.length > 0 ? ` ${failed.length} did not — ${failed.slice(0, 3).join("; ")}` : ""),
        );
        if (failed.length === 0) dlSymbol.value = "";
      } finally {
        dlQueue.set(null);
        busy.set(null);
      }
    })();
  };

  /**
   * PRESETS, because typing eight tickers by hand is how a library stays
   * half-filled. Each writes into the same field it would have been typed into,
   * so what is about to be fetched is visible BEFORE it is fetched rather than
   * being a button that silently queues sixteen downloads.
   */
  const preset = (label: string, title: string, syms: () => readonly string[]): HTMLElement =>
    h("button", {
      class: "ghost-btn lib-preset",
      type: "button",
      text: label,
      title,
      onclick: () => {
        const list = [...new Set(syms())].filter((x) => x !== "");
        if (list.length === 0) {
          message.set(`${label} is empty, so there is nothing to fill in.`);
          return;
        }
        dlSymbol.value = list.join(", ");
        dlSymbol.focus();
      },
    }) as HTMLElement;

  const downloadRow =
    opts.history === undefined
      ? null
      : h(
          "div",
          { class: "lib-dl" },
          h(
            "div",
            { class: "lib-dl-line" },
            dlSymbol,
            h(
              "div",
              { class: "lib-presets" },
              preset("On the chart", "Whatever the terminal is showing right now", () =>
                opts.pinned().map((k) => parseSeriesKey(k).symbol),
              ),
              preset("Watchlist", "Every symbol you are watching", () => watchedSymbols(opts.kv)),
              preset("Macro spine", "The eight markets that explain each other", () =>
                MACRO_SPINE.map((m) => m.symbol),
              ),
            ),
          ),
          h(
            "div",
            { class: "lib-dl-line" },
            h(
              "div",
              { class: "lib-chips", role: "group", "aria-label": "Bar sizes to download" },
              ...DL_TFS.map((t) =>
                h("button", {
                  class: "lib-chip mono",
                  type: "button",
                  text: t,
                  "aria-pressed": () => String(dlTimeframes().includes(t)),
                  onclick: () => toggleTf(t),
                }),
              ),
            ),
            dlDepth,
            h("button", {
              class: "primary-btn",
              type: "button",
              text: () => {
                const q = dlQueue();
                if (q !== null) return `Downloading ${q.done + 1} of ${q.total}…`;
                const n = dlTimeframes().length;
                return n === 1 ? "Download" : `Download ${n} bar sizes`;
              },
              disabled: () => busy() !== null,
              onclick: downloadSeries,
            }),
          ),
          h("p", {
            class: "lib-queue mono",
            text: () => dlQueue()?.now ?? "",
            style: () => (dlQueue() === null ? "display:none" : ""),
          }),
        );

  /* ── the toolbar over the table: find, order, and act on many at once ── */

  /** What a bulk action is doing right now, named per item. */
  const bulkNote = signal("");

  const sortSelect = h(
    "select",
    {
      class: "dd-select",
      "aria-label": "Order the library by",
      onchange: (e: Event) => sortBy.set((e.target as HTMLSelectElement).value as LibrarySort),
    },
    ...([
      ["symbol", "Market, then bar size"],
      ["bars", "Most bars first"],
      ["size", "Largest first"],
      ["fresh", "Most recent first"],
    ] as const).map(([v, t]) => h("option", { value: v, text: t })),
  );

  const toolbar = h(
    "div",
    { class: "lib-toolbar" },
    h("input", {
      class: "dd-input lib-filter",
      type: "search",
      placeholder: "Find a market, bar size or source",
      "aria-label": "Filter the library",
      oninput: (e: Event) => filterText.set((e.target as HTMLInputElement).value),
    }),
    sortSelect,
    h("span", { class: "lib-spacer" }),
    h("span", {
      class: "lib-count",
      text: () => {
        const n = selected().size;
        const held = inventory().length;
        const showing = shown().length;
        if (n > 0) return `${n} selected`;
        return showing === held ? `${held} series` : `${showing} of ${held} series`;
      },
    }),
    h("button", {
      class: "ghost-btn",
      type: "button",
      /* One control, not two: with every market already open the only useful
         action is closing them, and vice versa. Two buttons where one is always
         a no-op is two things to read and one of them is never the answer. */
      text: () => (grouped().every((g) => isOpen(g.symbol)) ? "Collapse all" : "Expand all"),
      disabled: () => inventory().length === 0 || filterText().trim() !== "",
      title: () =>
        filterText().trim() !== "" ? "While you are searching, every match is shown." : "",
      onclick: () => {
        const all = grouped().every((g) => isOpen(g.symbol));
        openGroups.set(all ? new Set<string>() : new Set(grouped().map((g) => g.symbol)));
      },
    }),
    h("button", {
      class: "ghost-btn",
      type: "button",
      text: "Select all shown",
      style: () => (selected().size > 0 ? "display:none" : ""),
      disabled: () => inventory().length === 0,
      onclick: () => setSel(shown().map((r) => r.key), true),
    }),
    h("button", {
      class: "ghost-btn",
      type: "button",
      text: () => (busy() === "bulk" ? "Updating…" : "Update selected"),
      style: () => (selected().size > 0 && opts.history !== undefined ? "" : "display:none"),
      disabled: () => busy() !== null,
      onclick: updateSelected,
    }),
    h("button", {
      class: "ghost-btn dd-danger",
      type: "button",
      text: () => (confirmBulk() ? `Delete ${selected().size} — sure?` : "Delete selected"),
      style: () => (selected().size > 0 ? "" : "display:none"),
      disabled: () => busy() !== null,
      /* Two clicks, like every other destructive control on this desk. The
         second click is the one that deletes, and the label says so. */
      onclick: () => (confirmBulk() ? deleteSelected() : confirmBulk.set(true)),
    }),
    h("button", {
      class: "ghost-btn",
      type: "button",
      text: "Clear",
      style: () => (selected().size > 0 ? "" : "display:none"),
      onclick: () => {
        selected.set(new Set<string>());
        confirmBulk.set(false);
      },
    }),
    h("p", {
      class: "lib-bulk-note mono",
      text: () => bulkNote(),
      style: () => (bulkNote() === "" ? "display:none" : ""),
    }),
  );

  /* ── the hero: every market's history on one axis ─────────────────── */

  /**
   * WHAT YOU HOLD, AND WHERE THE HOLES ARE.
   *
   * This desk's whole question, and until now it was answerable only by
   * reading six date ranges out of a table and holding them in your head at
   * once. On a shared axis it is the shape.
   *
   * The arithmetic is `coverageLanes` in `ui/research/library.ts` — pure, and
   * covered by seven tests, because a segment drawn at the wrong percentage
   * is a lie about when you hold data and no eye would catch a 3% error.
   */
  const ribbon = h("div", { class: "lib-ribbon" });
  renderEffect(() => {
    const inv = inventory();
    const cov = coverageLanes(inv);
    clear(ribbon);

    if (cov.lanes.length === 0) {
      ribbon.appendChild(
        h("p", {
          class: "dd-empty prose",
          text: "Nothing held yet. Fetch a market below and its history appears here.",
        }),
      );
      return;
    }

    const pinnedKeys = new Set(opts.pinned());
    const grid = h("div", { class: "lib-rib-grid" });
    for (const y of coverageYears(cov)) {
      grid.appendChild(h("span", { class: "lib-rib-year", style: `left:${y.left}%`, text: String(y.year) }));
    }

    for (const lane of cov.lanes) {
      const onChart = inv.some((r) => r.symbol === lane.symbol && pinnedKeys.has(r.key));
      ribbon.appendChild(
        h(
          "div",
          {
            class: "lib-rib-row",
            "data-on": onChart ? "true" : "false",
            title: `${lane.symbol}: ${lane.bars.toLocaleString()} bars, ${fmtBytes(lane.bytes)}, covering ${Math.round(lane.held)}% of the span`,
          },
          h("span", { class: "lib-rib-sym", text: lane.symbol }),
          h(
            "span",
            { class: "lib-rib-track" },
            ...lane.segments.map((seg) =>
              h("span", { class: "lib-rib-seg", style: `left:${seg.left}%;width:${seg.width}%` }),
            ),
          ),
          h("span", { class: "lib-rib-size num", text: fmtBytes(lane.bytes) }),
        ),
      );
    }
    ribbon.appendChild(grid);
  });

  const sweepRow = h(
    "div",
    { class: "dd-actions lib-sweep" },
    h("button", {
      class: "primary-btn",
      text: () => (busy() === "plan" ? "Checking…" : "Preview what would be removed"),
      disabled: () => busy() !== null,
      onclick: () => {
        busy.set("plan");
        message.set(null);
        scheduleFrame(() => {
          void (async () => {
            await refresh();
            plan.set(planRetention(inventory(), policy(), Date.now()));
            busy.set(null);
          })();
        });
      },
    }),
    h("button", { class: "ghost-btn", text: "Refresh", onclick: () => void refresh() }),
  );

  const heroPanel = h(
    "section",
    { class: "dd-panel lib-hero" },
    h(
      "header",
      { class: "lib-hero-head" },
      h(
        "div",
        { class: "lib-hero-title" },
        h("p", { class: "label", text: "Research — your data library" }),
        h(
          "div",
          { class: "lib-figure" },
          h("span", { class: "lib-figure-n", text: () => totals().bars.toLocaleString() }),
          h("span", {
            class: "lib-figure-of",
            text: () =>
              `bars, in ${totals().series} series across ${new Set(inventory().map((x) => x.symbol)).size} markets`,
          }),
        ),
      ),
      h(
        "div",
        { class: "lib-key" },
        h("span", { class: "lib-key-swatch", "data-kind": "held" }),
        h("span", { text: "held" }),
        h("span", { class: "lib-key-swatch", "data-kind": "gap" }),
        h("span", { text: "no data" }),
      ),
    ),
    ribbon,
  );

  const storagePanel = h(
    "section",
    { class: "dd-panel" },
    h("p", { class: "label", text: "What it costs to keep" }),
    pkWhy("Bars live in IndexedDB as Float64 columns — six per bar, 48 bytes. The archive keeps gaps and provenance with every segment, which is why a backtest can refuse to run rather than quietly averaging over a hole.", "How it is stored"),
    h(
      "div",
      { class: "dd-stats" },
      h(
        "div",
        { class: "dd-stat" },
        h("span", { class: "label", text: "Series" }),
        h("span", { class: "dd-stat-v num", text: () => String(totals().series) }),
      ),
      h(
        "div",
        { class: "dd-stat" },
        h("span", { class: "label", text: "Bars" }),
        h("span", { class: "dd-stat-v num", text: () => totals().bars.toLocaleString() }),
      ),
      h(
        "div",
        { class: "dd-stat" },
        h("span", { class: "label", text: "On disk" }),
        h("span", { class: "dd-stat-v num", text: () => fmtBytes(totals().bytes) }),
      ),
      h(
        "div",
        { class: "dd-stat" },
        h("span", { class: "label", text: "Budget" }),
        h("span", {
          class: "dd-stat-v num",
          text: () => `${pct(totals().bytes / DEFAULT_POLICY.maxBytes)} of ${fmtBytes(DEFAULT_POLICY.maxBytes)}`,
        }),
      ),
    ),
    /* REFERENCE MATERIAL FOLDS AWAY. Six rules that change about once a year
       sat permanently under a table you use every day; `pkFold` is `pkWhy` for
       a body rather than a sentence, so it reads as the same control. */
    pkFold("What is kept, and for how long", h("div", { class: "dd-policy-grid" })),
  );

  // The retention table is static; build it once rather than in an effect.
  {
    const grid = storagePanel.querySelector(".dd-policy-grid") as HTMLElement;
    for (const rule of DEFAULT_RETENTION) {
      grid.appendChild(
        h(
          "div",
          { class: "dd-policy-row" },
          h("span", { class: "dd-tf mono", text: rule.timeframe }),
          h("span", {
            class: "dd-keep",
            text: rule.keepMs === null ? "forever" : fmtAge(rule.keepMs),
          }),
          h("span", { class: "dd-why prose", text: rule.why }),
        ),
      );
    }
  }

  // ------------------------------------------------------------- learned --
  /**
   * What the system has stored about its own results — and forgetting it.
   *
   * Forgetting is destructive, so it is two clicks like every other delete on
   * this desk, and it NEVER touches bars: the three stores listed are results
   * computed from bars, and the bars above are untouched by all of them.
   */
  const knowledge = opts.knowledge ?? sharedKnowledge(opts.kv);
  const confirmForget = signal<string | null>(null);

  const forget = (item: LearnedItem): void => {
    let gone = 0;
    if (item.kind === "study-runs") gone = studyStore.forgetRuns(item.ref);
    if (item.kind === "knowledge") gone = knowledge.forget((e) => `${e.symbol}|${e.timeframe}` === item.ref);
    if (item.kind === "timings") {
      const res = studyStore.setTimings({});
      gone = res.ok ? item.count : 0;
    }
    confirmForget.set(null);
    message.set(
      gone > 0
        ? `Forgot ${item.title}: ${gone.toLocaleString()} stored result${gone === 1 ? "" : "s"}. Your bars are untouched.`
        : `Nothing was removed for ${item.title} — the store refused the write or it was already empty.`,
    );
  };

  const learnedList = h("div", { class: "rs-learned" });
  renderEffect(() => {
    const items = learnedItems(studies(), knowledge.entries(), timings());
    const confirming = confirmForget();
    if (items.length === 0) {
      learnedList.replaceChildren(
        h("p", { class: "dd-empty prose", text: "Nothing stored yet. Saved studies' runs, replayed setups and measured run times will appear here." }),
      );
      return;
    }
    learnedList.replaceChildren(
      ...items.map((it) =>
        h(
          "div",
          { class: "rs-learned-row" },
          h(
            "div",
            { class: "rs-learned-main" },
            h("strong", { text: it.title }),
            h("span", { class: "rs-learned-detail", text: it.detail }),
          ),
          ...(confirming === it.id
            ? [
                h("button", { class: "ghost-btn dd-danger", type: "button", text: "Forget", onclick: () => forget(it) }),
                h("button", { class: "ghost-btn", type: "button", text: "Keep", onclick: () => confirmForget.set(null) }),
              ]
            : [h("button", { class: "ghost-btn", type: "button", text: "Forget", title: "Asks once more", onclick: () => confirmForget.set(it.id) })]),
        ),
      ),
    );
  });

  const learnedPanel = h(
    "section",
    { class: "dd-panel rs-card" },
    h("header", { class: "rs-card-head" }, h("h2", { class: "panel-title", text: "What the system has learned" }), whoTag("ai", "AI memory")),
    learnedList,
    h("p", {
      class: "dd-note prose",
      text: "Forgetting removes the stored results only — your bars stay. Anything forgotten comes back only by running it again.",
    }),
  );

  // ----------------------------------------------------------- AI may use --
  /**
   * The three permissions in the design, each wired to what exists.
   *
   * Only ONE has a mechanism today: the background top-up below, which the
   * switch adds to and removes from the supervisor, so the job exists exactly
   * while the box is ticked. The other two are shown DISABLED and say so — a
   * switch that does nothing is worse than no switch, and hiding them would
   * hide that they are planned. No stored backtest is reused (every run
   * recomputes from the bars), and nothing drafts a strategy from past results.
   */
  const topupOn = signal<boolean>(opts.kv.get(TOPUP_SLOT));
  const lastTopUp = signal<string>("");

  const topupJob = (history: HistoryService): KernelJob => ({
    id: TOPUP_JOB,
    label: "Library top-up",
    everyMs: 60 * 60_000,
    priority: "background",
    run: async (abort) => {
      const due = planTopUp(await opts.archive.inventory(), Date.now());
      let ok = 0;
      let failed = 0;
      for (const t of due) {
        if (abort.aborted) break;
        try {
          const r = await history.load(t.symbol, t.timeframe, { refresh: true, limit: Math.min(TOPUP_PAGE, t.missing + 2), signal: abort });
          if (r.bars.length > 0 && !r.fromCache) ok += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      lastTopUp.set(
        due.length === 0
          ? `Last check ${new Date().toLocaleTimeString()}: every series was already current.`
          : `Last pass ${new Date().toLocaleTimeString()}: ${ok} of ${due.length} series updated${failed > 0 ? `, ${failed} got nothing new from any source` : ""}.`,
      );
      await refresh();
    },
  });

  const setTopup = (on: boolean): void => {
    const history = opts.history;
    const next = on && history !== undefined;
    topupOn.set(next);
    /* Written in the setter, not by an effect: a preference that is not durable
       at the moment it is changed is not a preference (`learn/store.ts`). */
    const res = opts.kv.write(TOPUP_SLOT, next);
    if (!res.ok) message.set(`The background download switch was not saved — ${res.error}`);
    if (next && history !== undefined) supervisor.add(topupJob(history));
    else supervisor.remove(TOPUP_JOB);
  };
  if (topupOn.peek()) setTopup(true);

  const permission = (text: string, control: HTMLElement, note: string | (() => string)): HTMLElement =>
    h("label", { class: "rs-perm" }, control, h("span", { class: "rs-perm-text" }, h("span", { text }), h("span", { class: "rs-perm-note", text: note })));

  const usePanel = h(
    "section",
    { class: "dd-panel rs-card" },
    h("header", { class: "rs-card-head" }, h("h2", { class: "panel-title", text: "How the AI may use it" }), whoTag("you", "You decide")),
    permission(
      "Reuse stored backtests — a re-run only computes what changed",
      h("input", { type: "checkbox", disabled: "", checked: false }),
      "Not built yet. Every run recomputes from the bars; only a one-line summary of each run is kept.",
    ),
    permission(
      "Let the AI draft strategies from what has worked before",
      h("input", { type: "checkbox", disabled: "", checked: false }),
      "Not built yet. Nothing drafts a strategy from stored results today.",
    ),
    permission(
      "Keep downloading new bars in the background",
      h("input", {
        type: "checkbox",
        checked: () => topupOn(),
        disabled: opts.history === undefined ? "" : undefined,
        onchange: (e: Event) => setTopup((e.target as HTMLInputElement).checked),
      }),
      () =>
        opts.history === undefined
          ? "Unavailable here: this desk was opened without the history service."
          : topupOn()
            ? lastTopUp() || `On. Once an hour, while the terminal is open, the ${TOPUP_PER_PASS} stalest series are brought up to date.`
            : `Off. When on: once an hour, while the terminal is open, the ${TOPUP_PER_PASS} stalest series are brought up to date.`,
    ),
  );

  // --------------------------------------------------------------- cache --

  const cachePanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Cache" }),
    h("p", { class: "dd-lede", text: "In memory, in front of the network. Your bars are not here — those are in the library." }),
    pkWhy("In-memory, in front of the network: positioning data, the calendar, and the screener's per-symbol candles. Freshness is computed from the bar interval rather than guessed — a response stays valid until the bar that was forming when it arrived has closed. The chart's own history is not here; that is the archive above, which is durable and carries its gaps.", "What is cached, and for how long"),
    h(
      "div",
      { class: "dd-stats" },
      h(
        "div",
        { class: "dd-stat" },
        h("span", { class: "label", text: "Hit rate" }),
        h("span", {
          class: "dd-stat-v num",
          text: () => {
            tick();
            return pct(responseCache.stats().hitRate);
          },
        }),
      ),
      h(
        "div",
        { class: "dd-stat" },
        h("span", { class: "label", text: "Entries" }),
        h("span", {
          class: "dd-stat-v num",
          text: () => {
            tick();
            return String(responseCache.stats().entries);
          },
        }),
      ),
      h(
        "div",
        { class: "dd-stat" },
        h("span", { class: "label", text: "Memory" }),
        h("span", {
          class: "dd-stat-v num",
          text: () => {
            tick();
            return fmtBytes(responseCache.stats().bytes);
          },
        }),
      ),
      h(
        "div",
        { class: "dd-stat" },
        h("span", { class: "label", text: "Requests saved" }),
        h("span", {
          class: "dd-stat-v num",
          text: () => {
            tick();
            return netHealth().saved.toLocaleString();
          },
        }),
      ),
    ),
    h("button", {
      class: "ghost-btn",
      text: "Clear cache",
      onclick: () => {
        // Deliberately does NOT touch the archive. A control labelled "clear
        // cache" must never delete history.
        resetNet();
        tick.update((n) => n + 1);
        message.set("Cache cleared. Stored bars are untouched.");
      },
    }),
  );

  // ------------------------------------------------------------- network --

  /**
   * ONE ROW PER HOST, not one card.
   *
   * Each host had a name row, a full-width progress bar and a mono meta line —
   * three lines and a 1700px rule for a budget that is almost always full, times
   * five hosts. That is a debug console, and this file's own rule says a status
   * strip is not one. The row now carries the budget as a 72px bar beside the
   * numbers, and the two facts that are NOT per-host — "the venue's counter is
   * not readable in a browser" appeared identically under every Binance host —
   * are stated once beneath the list.
   */
  const hostList = h("div", { class: "dd-hosts" });
  renderEffect(() => {
    tick();
    const stats = governor.stats();
    const now = Date.now();
    clear(hostList);

    if (stats.hosts.length === 0) {
      hostList.appendChild(
        h("p", { class: "dd-empty prose", text: "No requests yet this session." }),
      );
      return;
    }

    for (const host of stats.hosts) {
      const parked = host.bannedUntil > now;
      const reduced = host.ratePerSec < host.nominalRatePerSec;
      hostList.appendChild(
        h(
          "div",
          { class: "dd-host", "data-parked": parked ? "true" : "false" },
          h("span", { class: "dd-host-name mono", text: host.host }),
          h("span", { class: "dd-host-label", text: host.label }),
          h(
            "span",
            { class: "dd-host-bar", title: `${host.tokens.toFixed(0)} of ${host.capacity} budget left` },
            h("span", {
              class: "dd-host-fill",
              style: `width:${Math.max(0, Math.min(100, (host.tokens / host.capacity) * 100))}%`,
            }),
          ),
          h("span", {
            class: "dd-host-rate mono",
            /* The rate is the fact worth ranking, and a REDUCED one is the only
               state here that means anything has gone wrong short of a ban. */
            "data-reduced": reduced ? "true" : "false",
            text: `${host.ratePerSec}/s`,
            title: reduced ? `Reduced from ${host.nominalRatePerSec}/s after a refusal` : "",
          }),
          h("span", { class: "dd-host-req mono", text: host.requests.toLocaleString() }),
          parked
            ? h("span", {
                class: "chip",
                "data-tone": "neg",
                text: `${Math.ceil((host.bannedUntil - now) / 1000)}s`,
                title: host.banReason,
              })
            : h("span", { class: "dd-host-ok", text: "ok" }),
        ),
      );
      /* A parked host is the one case worth a second line: it is the only
         state the operator can act on, and the reason names the action. */
      if (parked) hostList.appendChild(h("p", { class: "dd-host-why prose", text: host.banReason }));
    }

    const blocked = stats.hosts.filter((x) => x.headerBlocked).length;
    if (blocked > 0) {
      hostList.appendChild(
        h("p", {
          class: "dd-host-foot",
          text: `${blocked} venue${blocked === 1 ? "" : "s"} do not let a browser read their own usage counter, so those run on the local estimate.`,
        }),
      );
    }
  });

  const networkPanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Request budget" }),
    h("p", { class: "dd-lede", text: "Each venue gets one budget, held under its published limit rather than at it." }),
    pkWhy("Every outbound request in the terminal spends from one budget per host, sized under the venue's published limit rather than at it — Binance allows 20 weight/second and this sustains 8. A refusal halves the sustained rate rather than pausing and returning to it, and a 418 parks the host for the full ban, because probing a Binance ban extends it. Where the venue publishes its own usage counter and the browser is allowed to read it, that counter overrides the local estimate.", "How the budget is set"),
    hostList,
    h("p", {
      class: "dd-note prose",
      text: () => {
        tick();
        return netHealth().note;
      },
    }),
  );

  // ---------------------------------------------------------------- sync --

  const syncFields = h("div", { class: "dd-fields" });
  renderEffect(() => {
    const cfg = syncCfg();
    clear(syncFields);

    if (cfg.kind === "supabase") {
      const s = cfg.supabase ?? {};
      const field = (
        label: string,
        value: string,
        onInput: (v: string) => void,
        type = "text",
      ): HTMLElement =>
        h(
          "label",
          { class: "dd-field" },
          h("span", { class: "label", text: label }),
          h("input", {
            class: "dd-input mono",
            type,
            value,
            oninput: (e: Event) => onInput((e.target as HTMLInputElement).value),
          }),
        );

      syncFields.append(
        field("Project URL", s.url ?? "", (v) =>
          saveCfg({ ...cfg, supabase: { ...s, url: v } }),
        ),
        field(
          "Anon key",
          s.anonKey ?? "",
          (v) => saveCfg({ ...cfg, supabase: { ...s, anonKey: v } }),
          "password",
        ),
        h(
          "div",
          { class: "dd-field-row" },
          field("Space id", s.space ?? "", (v) =>
            saveCfg({ ...cfg, supabase: { ...s, space: v } }),
          ),
          h("button", {
            class: "ghost-btn",
            text: "Generate",
            onclick: () => saveCfg({ ...cfg, supabase: { ...s, space: newSpaceId() } }),
          }),
        ),
        h("p", {
          class: "dd-warn prose",
          text: "The anon key is public by design — it ships in every Supabase web app. What actually protects your rows is row level security. With the single-user policy the space id is the only secret, so make it long and treat it like a password. The setup SQL is in the header of src/store/supabase.ts.",
        }),
        ...validateSupabaseConfig(s).map((problem) =>
          h("p", { class: "dd-problem prose", text: problem }),
        ),
      );
    }

    if (cfg.kind === "rest") {
      syncFields.append(
        h(
          "label",
          { class: "dd-field" },
          h("span", { class: "label", text: "Base URL" }),
          h("input", {
            class: "dd-input mono",
            value: cfg.rest?.base ?? "",
            oninput: (e: Event) =>
              saveCfg({
                ...cfg,
                rest: { ...cfg.rest, base: (e.target as HTMLInputElement).value },
              }),
          }),
        ),
        h("p", {
          class: "dd-warn prose",
          text: "Two endpoints: GET /sync/pull?since= and POST /sync/push. That is the whole contract, so a self-hosted target is an afternoon rather than a project — and \"cloud\" never has to mean one vendor.",
        }),
      );
    }

    if (cfg.kind === "local") {
      syncFields.appendChild(
        h("p", {
          class: "dd-warn prose",
          text: "Settings sync through the Python service on 127.0.0.1. Nothing leaves this machine, and it survives a browser cache clear. Requires the terminal to be started with python run.py.",
        }),
      );
    }
  });

  const syncPanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Sync" }),
    h("p", { class: "dd-lede", text: "Alerts, layouts and watchlists across machines." }),
    pkWhy("Alerts, layouts and watchlists across machines. Bars do NOT sync — they are the same public data on every machine and a re-fetch rebuilds them for free, so history moves by vault file instead, when you actually want it moved.", "Why bars do not sync"),
    h(
      "div",
      { class: "dd-actions" },
      h("select", {
        class: "dd-select",
        "aria-label": "Sync target",
        onchange: (e: Event) =>
          saveCfg({ ...syncCfg(), kind: (e.target as HTMLSelectElement).value as TargetKind }),
        ref: (el: HTMLSelectElement) => {
          for (const [value, text] of [
            ["none", "Off"],
            ["local", "Local service (127.0.0.1)"],
            ["supabase", "Supabase"],
            ["rest", "Custom endpoint"],
          ] as const) {
            el.appendChild(h("option", { value, text }));
          }
          effect(() => {
            el.value = syncCfg().kind;
          });
        },
      }),
      h("button", {
        class: "primary-btn",
        text: () => (busy() === "sync" ? "Syncing…" : "Sync now"),
        disabled: () => busy() !== null || syncCfg().kind === "none",
        onclick: () => {
          const adapter = adapterFor(syncCfg());
          if (!adapter) {
            message.set("The sync target is not configured yet.");
            return;
          }
          busy.set("sync");
          void (async () => {
            syncResult.set(await sync.run(adapter));
            busy.set(null);
          })();
        },
      }),
    ),
    syncFields,
    h("p", {
      class: "dd-note mono",
      text: () => `this machine: ${sync.device()} · last sync ${when(sync.state().lastSyncAt, Date.now())}`,
    }),
    h("div", { class: "dd-sync-result" }),
  );

  {
    const box = syncPanel.querySelector(".dd-sync-result") as HTMLElement;
    renderEffect(() => {
      const r = syncResult();
      clear(box);
      if (!r) return;
      box.appendChild(
        h("p", {
          class: r.ok ? "dd-ok prose" : "dd-problem prose",
          text: r.ok
            ? `Pulled ${r.pulled}, applied ${r.applied}, pushed ${r.pushed}. ${r.note}`
            : `${r.error} — ${r.note}`,
        }),
      );
      for (const c of r.conflicts) {
        box.appendChild(
          h(
            "div",
            { class: "dd-conflict" },
            h("span", { class: "chip", "data-tone": "attn", text: c.winner.toUpperCase() }),
            h("span", { class: "mono", text: c.key }),
            h("span", { class: "dd-plan-why prose", text: c.note }),
          ),
        );
      }
    });
  }

  // --------------------------------------------------------------- vault --

  const importBox = h("div", { class: "dd-import" });
  renderEffect(() => {
    const p = pending();
    clear(importBox);
    if (!p) return;

    const i = p.inspection;
    importBox.append(
      h("p", {
        class: "dd-plan-summary",
        text: i.ok
          ? `${i.settingKeys.length} setting(s), ${i.series.length} series, ${i.totalBars.toLocaleString()} bars. Exported ${day(i.createdAt)}.`
          : (i.error ?? "unreadable"),
      }),
      ...i.warnings.map((w) => h("p", { class: "dd-problem prose", text: w })),
    );

    if (!i.ok) return;

    importBox.append(
      h("button", {
        class: "primary-btn",
        text: "Import — keep whichever copy is newer",
        onclick: () => {
          void (async () => {
            const r = await importVault(p.text, opts.kv, opts.archive, { mode: "merge" });
            await refresh();
            pending.set(null);
            message.set(
              `Imported ${r.settingsWritten} setting(s) and ${r.barsWritten.toLocaleString()} bars. ${
                r.settingsSkipped.length
              } skipped. Reload to apply settings.`,
            );
          })();
        },
      }),
      h("button", {
        class: "ghost-btn",
        text: "Cancel",
        onclick: () => pending.set(null),
      }),
    );
  });

  const download = (name: string, text: string): void => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = h("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next frame: revoking synchronously can beat the download.
    scheduleFrame(() => URL.revokeObjectURL(url));
  };

  const vaultPanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Backup and transfer" }),
    h("p", { class: "dd-lede", text: "One file: settings, alerts, layouts, and optionally your history." }),
    pkWhy("One file: settings, alerts, layouts, and optionally your bar history. Anything that looks like a credential is withheld and named, so the file is safe to email, share or attach to an issue. The checksum detects corruption — it is not a signature, so a vault file from someone else is untrusted input.", "What is withheld, and what the checksum proves"),
    h(
      "div",
      { class: "dd-actions" },
      h("button", {
        class: "primary-btn",
        text: "Export settings",
        onclick: () => {
          void (async () => {
            const file = await exportVault(opts.kv, null);
            download(vaultFilename(file.createdAt), serialiseVault(file));
            message.set(
              file.redacted.length > 0
                ? `Exported. Withheld ${file.redacted.length} credential-shaped key(s): ${file.redacted.join(", ")}.`
                : "Exported.",
            );
          })();
        },
      }),
      h("button", {
        class: "primary-btn",
        text: () => (busy() === "export" ? "Packing…" : "Export settings + history"),
        disabled: () => busy() !== null,
        onclick: () => {
          busy.set("export");
          scheduleFrame(() => {
            void (async () => {
              const file = await exportVault(opts.kv, opts.archive, { includeArchive: true });
              download(vaultFilename(file.createdAt), serialiseVault(file));
              busy.set(null);
              message.set(
                `Exported ${file.series.length} series, ${file.series
                  .reduce((a, s) => a + s.bars, 0)
                  .toLocaleString()} bars.`,
              );
            })();
          });
        },
      }),
      h(
        "label",
        { class: "ghost-btn dd-file" },
        "Import a vault…",
        h("input", {
          type: "file",
          accept: "application/json,.json",
          style: "display:none",
          onchange: (e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            void file.text().then((text) => {
              // Inspect first, ALWAYS. Nothing is written until the contents
              // have been shown and the import confirmed.
              pending.set({ text, inspection: inspectVault(text) });
            });
            (e.target as HTMLInputElement).value = "";
          },
        }),
      ),
    ),
    importBox,
  );


  // ---------------------------------------------------------------- backend --
  /**
   * ONE LINE FOR A QUESTION THAT USED TO TAKE NINE CONSOLE ERRORS.
   *
   * The desks each addressed the backend independently, so a backend that was
   * half up presented as unrelated faults on unrelated desks, and the console
   * evidence — `ERR_CONNECTION_REFUSED` with no host attached — did not contain
   * the action that fixes it. `/api/health` answers for all three at once and
   * names what each missing piece costs.
   *
   * "No backend" is shown MUTED, not red. Running with no Python at all is a
   * supported way to use this terminal: bars come from Binance directly and
   * every desk that needs the service says so itself. A permanently red light
   * for the normal case is a light the operator learns to skip, which costs
   * them the one time it is `degraded` and actually means something.
   */
  const health = signal<GatewayHealth>(UNREACHABLE);
  const probing = signal(false);

  const checkBackend = async (): Promise<void> => {
    probing.set(true);
    try {
      health.set(await probeGateway());
    } finally {
      probing.set(false);
    }
  };

  const backendPanel = h(
    "section",
    { class: "dd-panel" },
    h("h2", { class: "panel-title", text: "Backend" }),
    h("p", { class: "dd-lede", text: "Bars, the store and the model service." }),
    pkWhy("Bars, the store and the model service. One address serves all three; Settings → Backend is where it is changed.", "Where it lives"),
    h(
      "div",
      { class: "dd-actions" },
      h("span", {
        class: () => `dd-badge dd-badge-${healthTone(health())}`,
        text: () => (probing() ? "CHECKING" : healthLabel(health())),
      }),
      h("code", { class: "dd-mono", text: () => gatewayBase() }),
      h("span", {
        class: "dd-sub",
        text: () => (health().latencyMs > 0 ? `${health().latencyMs} ms` : ""),
      }),
      h("button", {
        class: "ghost-btn",
        text: "Check",
        onclick: () => {
          void checkBackend();
        },
      }),
    ),
    h("p", {
      class: "dd-warn prose",
      text: () => health().advice,
      style: () => (health().advice ? "" : "display:none"),
    }),
    h("p", {
      class: "dd-sub prose",
      text: "Split across separate addresses. Clearing the overrides in Settings puts every service on one gateway.",
      style: () => (isConsolidated() ? "display:none" : ""),
    }),
    h("div", {
      class: "dd-stats",
      ref: (el: HTMLElement) => {
        renderEffect(() => {
          clear(el);
          for (const service of health().services) {
            el.appendChild(
              h(
                "div",
                { class: "dd-stat" },
                h("span", { class: "label", text: service.name }),
                h("span", {
                  class: service.ok ? "dd-svc-ok" : "dd-svc-down",
                  /* The COST, not the exception. "quant is down" is a fact;
                     "GARCH and causal inference are unavailable" is the fact
                     the operator can actually decide about. */
                  text: service.ok ? service.provides : (service.error ?? "not loaded"),
                }),
              ),
            );
          }
        });
      },
    }),
  );

  // ----------------------------------------------------------------- root --
  /**
   * THREE SECTIONS, one on screen at a time.
   *
   * Seven panels stacked down one column meant the answer to "what do I hold"
   * and the answer to "is Binance rate-limiting me" were the same scroll, and
   * five of the seven are things you read once a month. They are three
   * different questions and they are now three sections:
   *
   *   Library     what you hold, and getting more of it
   *   Connection  the backend, the request budget, the cache
   *   Transfer    sync, and the vault file
   *
   * Not persisted: a desk you open to answer a question should open on the
   * question it is named after, not on wherever you left it three days ago.
   */
  const SECTIONS = [
    { id: "library", label: "Library" },
    { id: "connection", label: "Connection" },
    { id: "transfer", label: "Transfer" },
  ] as const;
  const section = signal<(typeof SECTIONS)[number]["id"]>("library");

  const sectionBar = h(
    "div",
    { class: "dd-sections", role: "group", "aria-label": "Data desk sections" },
    ...SECTIONS.map((sec) =>
      h("button", {
        class: "seg-btn",
        type: "button",
        text: sec.label,
        "aria-pressed": () => String(section() === sec.id),
        onclick: () => section.set(sec.id),
      }),
    ),
  );

  /* `hidden` rather than unmounting: every panel holds live state — a filter,
     a selection, a pending import — and an effect that has been running since
     activation. Rebuilding on each switch would throw all of it away. */
  const group = (id: (typeof SECTIONS)[number]["id"], ...body: HTMLElement[]): HTMLElement =>
    h("div", { class: "dd-group", hidden: () => (section() === id ? null : "") }, ...body) as HTMLElement;

  const el = h(
    "section",
    { class: "dd" },
    sectionBar,
    h("p", {
      class: "dd-message",
      text: () => message() ?? "",
      style: () => (message() ? "" : "display:none"),
    }),
    /*
     * THE LAYOUT LAW: a primary column holding the work, and a rail holding
     * what the work is measured against.
     *
     * Every desk was one full-width column of full-width panels, so content
     * either stretched to 1800px or sat capped beside 800px of nothing — the
     * "empty space" the owner photographed twice. Eight columns and four.
     */
    group(
      "library",
      h(
        "div",
        { class: "dd-layout" },
        h("div", { class: "dd-primary" }, heroPanel, downloadRow, toolbar, seriesTable, sweepRow, planBox),
        h("div", { class: "dd-rail" }, storagePanel, learnedPanel, usePanel),
      ) as HTMLElement,
    ),
    group("connection", backendPanel, networkPanel, cachePanel),
    group("transfer", syncPanel, vaultPanel),
  );

  return {
    el,
    activate() {
      void refresh();
      // Probed on activation rather than on a timer: this desk is where the
      // question is asked, and polling a backend to report that it is absent
      // is the kind of background chatter the request budget exists to stop.
      void checkBackend();
    },
  };
}
