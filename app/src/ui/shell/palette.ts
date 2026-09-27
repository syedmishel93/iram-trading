/**
 * The command palette's SOURCES.
 *
 * WHAT A SOURCE IS, AND WHY THERE ARE FIVE
 * `ui/palette.ts` owns the widget — the input, the list, the keyboard, the
 * ranking loop. It knows nothing about this terminal. What it takes is an
 * ordered list of sources, each of which claims a prefix and answers a query,
 * and THAT is the part that is about trading rather than about a dropdown.
 * This file is that part and nothing else.
 *
 * The five, in the order they are tested:
 *
 *   `>` commands   — explicit command mode.
 *   `@` structures — the detector's output for the chart on screen.
 *   (none) symbols — the venue's whole listing, ranked by 24-hour volume.
 *   (none) commands— the same commands again, below symbols.
 *   (none) raw     — anything symbol-shaped that the catalogue does not list.
 *
 * Order is a decision and it is written at the call to `createPalette`: an
 * unprefixed query offers symbols above commands, because a symbol is what
 * people type most.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MOVED OUT WITH IT, AND WHAT DELIBERATELY DID NOT
 *
 * The section this came from also held `shownSymbol` / `setShownSymbol` and
 * their timeframe twins, which made a measurement of it report FIVE exports
 * for a thing that has one. Those four are topbar-to-workspace glue — they
 * read the active pane and fall back to `state` — and they stayed in
 * `shell.ts` under their own heading rather than riding along here. A section
 * that exports one value is one a reader can finish.
 *
 * THREE SIBLING DEPENDENCIES after the foundation: the chart's bars, the
 * symbol catalogue, and the detector output. Each is read at query time, not
 * at construction, so none of them has to exist yet when this is called.
 */

import { rank } from "../../core/fuzzy";
import { rankSymbols, type Catalogue } from "../../data/catalogue";
import { createPalette, type PaletteItem, type PaletteSource } from "../palette";
import { abbreviate } from "./format";
import type { ReadSignal } from "../../core/signal";
import type { BarView } from "../../chart/series";
import type { Detection } from "../../detect/types";
import type { Command } from "../../core/commands";
import type { ShellContext } from "./context";

export interface PaletteSectionDeps {
  /** The chart's bars, replay-aware. Owned by the chrome section. */
  readonly bars: ReadSignal<readonly BarView[]>;
  /**
   * The venue's symbol table.
   *
   * The real `Catalogue`, not a `{ symbols(): … }` stub. `rankSymbols` wants
   * whole `SymbolEntry` rows — volume, class and name — and a narrower hand
   * written shape satisfies the call here and then disagrees with the ranker.
   */
  readonly catalogue: Catalogue;
  /** Detector output for the chart on screen, read fresh on every query. */
  readonly detections: ReadSignal<Detection[]>;
}

/**
 * Build the palette.
 *
 * Return type inferred, deliberately. Hand-writing it is how the risk section
 * got a wrong `studies` signature past review and into a compile error.
 */
export function createPaletteSection(ctx: ShellContext, d: PaletteSectionDeps) {
  const { commands, keymap, state, toaster } = ctx;
  const { bars, catalogue, detections } = d;

  const toPaletteItem = (r: {
    item: Command;
    positions: readonly number[];
  }): PaletteItem => ({
    id: r.item.id,
    title: r.item.title,
    group: r.item.group,
    ...(r.item.detail ? { detail: r.item.detail() } : {}),
    ...(r.item.checked ? { checked: r.item.checked() } : {}),
    ...(r.item.danger ? { danger: true } : {}),
    ...(keymap.keysFor(r.item.id) !== null ? { hint: keymap.keysFor(r.item.id) as string } : {}),
    positions: r.positions,
    run: () => commands.run(r.item.id),
  });

  const commandSource: PaletteSource = {
    prefix: "",
    label: "",
    placeholder: "Type a symbol, or a command…",
    search: (query, limit) => commands.search(query, limit).map(toPaletteItem),
  };

  const explicitCommandSource: PaletteSource = {
    ...commandSource,
    prefix: ">",
    label: "commands",
    placeholder: "Run a command…",
  };

  /**
   * Symbols.
   *
   * A short curated list, plus whatever was typed. Anything symbol-shaped is
   * offered verbatim as the last row, so an instrument nobody thought to list
   * is one keystroke away rather than unreachable — which is the failure mode
   * of every hard-coded picker.
   */
  /**
   * The seed list moved into `data/catalogue.ts`, where it is a FLOOR rather
   * than the whole offering: the palette now searches every symbol the venue
   * lists, ranked by 24-hour volume. Ranking by liquidity is what makes typing
   * "BT" return BTCUSDT instead of BTCDOWNUSDT.
   */

  const symbolSource: PaletteSource = {
    prefix: "",
    label: "",
    placeholder: "Type a symbol, or a command…",
    search: (query, limit) => {
      const trimmed = query.trim().toUpperCase();
      const pool = catalogue.symbols();
      /* `rankSymbols`, not a bare `rank`: a fuzzy sort alone put the near-dead
         four-letter listings (BTCU, ETHU, SOLU…) above the busiest pairs on the
         exchange for every major asset. See the measurement in catalogue.ts. */
      return rankSymbols(pool, trimmed, limit).map(
        (r): PaletteItem => ({
          id: `sym:${r.item.symbol}`,
          title: r.item.symbol,
          group: "Symbol",
          positions: r.positions,
          detail:
            r.item.symbol === state.symbol.peek()
              ? "on screen"
              : r.item.volume > 0
                ? `${abbreviate(r.item.volume)} 24h`
                : "",
          run: () => {
            state.symbol.set(r.item.symbol);
            state.view.set("chart");
          },
        }),
      );
    },
  };

  /**
   * The escape hatch for an instrument nobody listed.
   *
   * Its own source, ordered LAST, and gated on a length that a real ticker has
   * and a command search usually does not. Typing "ema" produced a speculative
   * "load EMA" row ABOVE the three EMA commands the user was obviously
   * reaching for — a hard-coded picker's failure mode inverted into a ranking
   * bug. Five characters is the shortest of the symbols this terminal actually
   * quotes (EURUSD, XAUUSD, BTCUSDT are six or more), and it keeps short
   * command searches out of the symbol namespace entirely.
   */
  const RAW_SYMBOL_MIN = 5;

  const rawSymbolSource: PaletteSource = {
    prefix: "",
    label: "",
    placeholder: "Type a symbol, or a command…",
    search: (query) => {
      const trimmed = query.trim().toUpperCase();
      if (trimmed.length < RAW_SYMBOL_MIN) return [];
      if (catalogue.symbols().some((e) => e.symbol === trimmed)) return [];
      if (!/^[A-Z0-9._-]+$/.test(trimmed)) return [];
      return [
        {
          id: `sym-raw:${trimmed}`,
          title: trimmed,
          group: "Load a symbol not on the list",
          detail: "fetches from whichever source has it",
          run: () => {
            state.symbol.set(trimmed);
            state.view.set("chart");
          },
        },
      ];
    },
  };

  const structureSource: PaletteSource = {
    prefix: "@",
    label: "structures",
    placeholder: "Find a detected structure…",
    search: (query, limit) => {
      const series = bars.peek();
      const found = detections.peek();
      return rank(found, query, (dd) => [dd.label, dd.reason, dd.kind], limit).map(
        (r): PaletteItem => ({
          id: r.item.id,
          title: r.item.label,
          group: r.item.kind,
          detail: r.item.reason,
          hint: `${(r.item.confidence * 100).toFixed(0)}%`,
          positions: r.positions,
          run: () => {
            state.view.set("chart");
            const bar = series[Math.min(r.item.to, series.length - 1)];
            toaster.push({
              level: "info",
              title: r.item.label,
              body: bar
                ? `${r.item.reason} — at ${new Date(bar.t).toISOString().slice(0, 16).replace("T", " ")}`
                : r.item.reason,
            });
          },
        }),
      );
    },
  };

  const palette = createPalette({
    /* Order matters: prefixed sources are tested first, and the default mode
       puts symbols above commands because a symbol is what people type most. */
    sources: [explicitCommandSource, structureSource, symbolSource, commandSource, rawSymbolSource],
    footer: "↑↓ select · ↵ run · > commands · @ structures · esc close",
  });

  return { palette };
}
