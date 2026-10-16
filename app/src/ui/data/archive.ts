/**
 * THE DURABLE ARCHIVE, ON SCREEN.
 *
 * Everything this card shows already worked and none of it was visible. The
 * owner's question — "how much historical data is in the system" — could only
 * be answered by opening a browser's developer tools and reading IndexedDB by
 * hand, and the answer was ONE SERIES: binance BTCUSDT 1h, 5,803 bars, 272 KB,
 * in a store the browser was free to evict without asking.
 *
 * A capability nobody can see is a capability nobody has. So this states, in
 * one place:
 *
 *   WHAT IS HELD     the durable copy on the server, per series, with spans.
 *   WHAT IS KEPT     which series are topped up with the terminal closed.
 *   HOW SAFE IT IS   whether the browser granted persistent storage, and what
 *                    it means that it did not.
 *   HOW MUCH ROOM    the disk budget, which is a number the operator sets.
 *
 * NOTHING HERE IS ESTIMATED. Every figure is read from `/svc/bars/inventory`
 * or from `navigator.storage`, and a service that cannot be reached says so
 * rather than rendering a zero — "nothing stored" and "could not ask" are
 * different facts, and a card that showed 0 bars for a gateway that is simply
 * not running would be the most alarming possible way to say "fine".
 */

import { h } from "../dom";
import { renderEffect, signal } from "../../core/signal";
import { enrolledSeries } from "../../data/library";
import {
  bulkDownloadStatus,
  bulkStore,
  pushEnrolment,
  requestPersistence,
  serverInventory,
  startBulkDownload,
} from "../../data/serverbars";
import type { BulkStore, DownloadJob } from "../../data/serverbars";
import type { KV } from "../../store/kv";
import type { ServerSeries } from "../../data/serverbars";

export interface ArchiveCardOptions {
  readonly kv: KV;
  /** Symbols on the watchlist — enrolled alongside the macro spine. */
  readonly watchlist: () => readonly string[];
}

const day = (ms: number): string =>
  Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "—";

/** Bars are 48 bytes each in the local archive, MEASURED: 272 KB / 5,803. */
const BYTES_PER_BAR = 48;

/** Bytes, at the scale a disk budget is discussed in. */
const gbs = (n: number): string => {
  const gb = n / 1_073_741_824;
  if (gb >= 0.1) return `${gb.toFixed(2)} GB`;
  const mb = n / 1_048_576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n)} B`;
};

const size = (bars: number): string => {
  const mb = (bars * BYTES_PER_BAR) / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(mb * 1024))} KB`;
};

export function createArchiveCard(opts: ArchiveCardOptions): {
  readonly el: HTMLElement;
  refresh(): Promise<void>;
} {
  const series = signal<readonly ServerSeries[]>([]);
  const totalBars = signal(0);
  /** Null until asked. Not `false` — "not asked" and "absent" differ. */
  const reachable = signal<boolean | null>(null);
  const why = signal("");
  const persisted = signal<{ granted: boolean; why: string } | null>(null);
  const busy = signal(false);
  const enrolledNote = signal("");
  const bulk = signal<BulkStore | null>(null);
  const job = signal<DownloadJob | null>(null);
  const dlSymbol = signal("BTCUSDT");
  const dlMonths = signal(12);
  let poll: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    busy.set(true);
    try {
      const inv = await serverInventory();
      reachable.set(inv.ok);
      why.set(inv.reason);
      series.set(inv.series);
      totalBars.set(inv.totalBars);
      persisted.set(await requestPersistence());
      bulk.set(await bulkStore());
      job.set(await bulkDownloadStatus());
    } finally {
      busy.set(false);
    }
  }

  /**
   * Start a download and watch it.
   *
   * Polled rather than streamed: a download is minutes long and a poll every
   * two seconds is cheaper than a socket that has to be torn down correctly.
   * The interval is cleared the moment the job stops, so a finished download
   * does not leave a timer asking forever.
   */
  async function download(): Promise<void> {
    const started = await startBulkDownload(dlSymbol(), "1m", dlMonths());
    if (!started.ok) {
      enrolledNote.set(started.why);
      return;
    }
    if (poll !== null) clearInterval(poll);
    poll = setInterval(() => {
      void (async () => {
        const j = await bulkDownloadStatus();
        job.set(j);
        if (j === null || j.state !== "running") {
          if (poll !== null) clearInterval(poll);
          poll = null;
          void refresh();
        }
      })();
    }, 2000);
  }

  async function enrolNow(): Promise<void> {
    const rows = enrolledSeries(opts.watchlist());
    const n = await pushEnrolment(rows);
    enrolledNote.set(
      n === null
        ? "Could not reach the archive service to enrol them. Start it with: python run.py"
        : `${n} series enrolled. They are topped up hourly, with the terminal closed.`,
    );
    void refresh();
  }

  const table = h("div", { class: "ar-rows" });
  renderEffect(() => {
    const rows = series();
    table.replaceChildren();
    if (reachable() === null) {
      table.appendChild(h("p", { class: "ar-note", text: "Not asked yet." }));
      return;
    }
    if (reachable() === false) {
      /* NOT ZERO. A gateway that is not running holds an unknown amount, and
         rendering 0 bars would be the most alarming way to say "fine". */
      table.appendChild(
        h("p", {
          class: "ar-note ar-bad",
          text: `${why() || "The archive service is not answering."} Start it with: python run.py`,
        }),
      );
      return;
    }
    if (rows.length === 0) {
      table.appendChild(
        h("p", {
          class: "ar-note",
          text: "The durable archive is empty. It fills as you use the terminal, and hourly once series are enrolled.",
        }),
      );
      return;
    }
    /*
     * NO HEADER ROW. Five column labels over four rows of self-evident figures
     * is chrome: a count reads as a count, and a date reads as a date. The
     * symbol is the only thing at full ink because it is the subject; the rest
     * qualifies it.
     */
    for (const r of [...rows].sort((a, b) => b.bars - a.bars)) {
      table.appendChild(
        h(
          "div",
          { class: "ar-row" },
          h("span", { class: "ar-sym", text: `${r.sym} ${r.tf}`, title: `from ${r.src}` }),
          h("span", { text: `${r.bars.toLocaleString()} bars` }),
          h("span", { class: "ar-span", text: `${day(r.oldest)} to ${day(r.newest)}` }),
          h("span", { class: "ar-dim", text: size(r.bars) }),
        ),
      );
    }
  });

  const el = h(
    "section",
    { class: "dd-panel ar-card" },
    h(
      "header",
      { class: "ar-head-row" },
      h("h2", { class: "ar-title", text: "Stored history" }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        "data-act": "refresh-archive",
        text: () => (busy() ? "Reading…" : "Refresh"),
        disabled: () => busy(),
        onclick: () => void refresh(),
      }),
    ),
    h("p", {
      class: "ar-sub",
      text: "The copy on the server, which survives clearing your browser. The chart reads a faster local cache; this is the one that lasts.",
    }),

    /*
     * THE ANSWER FIRST. This card exists to answer "how much history can I
     * backtest on", and the first version set that in body text as
     * "799 bars across 1 series - about 37 KB on disk" — a meta string of
     * three facts, none of them leading. The count leads now, in the face this
     * terminal uses for what it says on its own account, and everything
     * qualifying it is faint.
     */
    h(
      "div",
      { class: "ar-answer", style: () => (reachable() === true ? "" : "display:none") },
      h("span", { class: "ar-figure", text: () => totalBars().toLocaleString() }),
      h("span", {
        class: "ar-of",
        text: () => {
          const n = series().length;
          return `bars kept, across ${n} ${n === 1 ? "series" : "series"} — about ${size(totalBars())} on disk`;
        },
      }),
    ),

    table,

    /* PERSISTENCE, stated rather than assumed. The browser refused it on this
       origin when measured, and an operator planning to backtest on a local
       archive deserves to know the browser may discard it. */
    h("p", {
      class: "ar-note",
      "data-ok": () => String(persisted()?.granted === true),
      text: () => persisted()?.why ?? "",
      style: () => (persisted() ? "" : "display:none"),
    }),

    /*
     * THE BULK HALF. `svc/bars.py` holds the recent bars a chart reads;
     * `svc/store.py` holds the gigabytes as Parquet on disk. Shown together
     * because "how much history do I have" is one question, and answering it
     * from two places is how the two get confused.
     */
    h(
      "div",
      { class: "ar-bulk" },
      h(
        "div",
        { class: "ar-bulk-head" },
        h("h3", { class: "ar-sub-title", text: "Bulk archive" }),
        h("span", {
          class: "ar-of",
          text: () => {
            const b = bulk();
            if (!b?.ok || !b.engineReady) return "";
            return b.partitions === 0
              ? `empty, ${gbs(b.budgetBytes)} to spend`
              : `${gbs(b.bytes)} of ${gbs(b.budgetBytes)}, in ${b.partitions} months`;
          },
        }),
      ),
      h("p", {
        class: "ar-note",
        "data-ok": () => String(bulk()?.engineReady === true),
        text: () => {
          const b = bulk();
          if (!b) return "";
          if (!b.ok) return `${b.reason}. Start it with: python run.py`;
          if (!b.engineReady) return b.engineWhy;
          return "Minute bars and tick data, as Parquet on disk. Deep enough to settle whether a stop or a target was hit first inside a bar.";
        },
        style: () => (bulk() ? "" : "display:none"),
      }),
      h("p", {
        class: "ar-path",
        text: () => bulk()?.root ?? "",
        style: () => (bulk()?.engineReady === true ? "" : "display:none"),
      }),
    ),

    /*
     * THE CONTROL. Months of 1-minute bars, which is the tier that earns its
     * space: MEASURED at 2.0 MB a month for BTCUSDT, so a year is ~24 MB and
     * it settles whether a stop or a target was hit first inside a bar.
     */
    h(
      "div",
      { class: "ar-dl" },
      h("input", {
        class: "field-input ar-dl-sym",
        type: "text",
        "aria-label": "Symbol to download",
        placeholder: "BTCUSDT",
        value: () => dlSymbol(),
        oninput: (e: Event) => dlSymbol.set((e.target as HTMLInputElement).value.toUpperCase()),
      }),
      h(
        "select",
        {
          class: "field-input ar-dl-months",
          "aria-label": "How many months",
          onchange: (e: Event) => dlMonths.set(Number((e.target as HTMLSelectElement).value)),
        },
        ...[3, 12, 24, 60].map((m) =>
          h("option", { value: String(m), text: `${m} months`, selected: () => dlMonths() === m }),
        ),
      ),
      h("button", {
        class: "ghost-btn",
        type: "button",
        "data-act": "download",
        text: "Download 1m bars",
        title: "Monthly klines from Binance Vision, into the bulk archive. Months already held are skipped.",
        disabled: () => job()?.state === "running",
        onclick: () => void download(),
      }),
    ),
    h(
      "div",
      {
        class: "ar-bar",
        role: "progressbar",
        "aria-label": "Download progress",
        style: () => (job()?.state === "running" ? "" : "display:none"),
      },
      h("i", {
        style: () => {
          const j = job();
          const pct = j && j.total > 0 ? Math.round((j.done / j.total) * 100) : 0;
          return `width:${pct}%`;
        },
      }),
    ),
    h("p", {
      class: "ar-note",
      "data-ok": () => String(job()?.state === "done" && (job()?.failed.length ?? 0) === 0),
      text: () => {
        const j = job();
        if (!j || j.state === "idle") return "";
        const head = `${j.symbol} ${j.timeframe} · ${j.done} of ${j.total} months · ${j.fetched} fetched, ${j.skipped} already held`;
        const tail = j.failed.length > 0 ? ` · ${j.failed.length} could not be fetched: ${j.failed[0]}` : "";
        return j.state === "running" ? `Downloading ${j.note}… ${head}` : `${head}${tail}. ${j.note}`;
      },
      style: () => (job() && job()?.state !== "idle" ? "" : "display:none"),
    }),

    h(
      "div",
      { class: "ar-actions" },
      h("button", {
        class: "primary-btn",
        type: "button",
        "data-act": "enrol",
        text: "Keep these markets current",
        title: "Enrol the macro spine and your watchlist, so the server tops them up hourly",
        onclick: () => void enrolNow(),
      }),
    ),
    h("p", {
      class: "ar-note",
      text: () => enrolledNote(),
      style: () => (enrolledNote() ? "" : "display:none"),
    }),
  ) as HTMLElement;

  return { el, refresh };
}
