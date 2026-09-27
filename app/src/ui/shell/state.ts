/**
 * The shell's reactive state, as a type.
 *
 * MOVED OUT OF `ui/shell.ts` so a section lifted into its own file can name what
 * it reads. While this lived inside the shell module it was unexported and
 * unreachable, which meant every extraction had to either re-declare the shape
 * or take twenty loose signals — and re-declaring it is how two files come to
 * disagree about what `dockCard` holds.
 *
 * It is a TYPE only. The signals themselves are still created in `mountShell`,
 * once, and handed to sections through `ShellContext` — one owner, many readers,
 * which is the same rule `core/account.ts` enforces about equity.
 */

import type { Signal } from "../../core/signal";
import type { ChartKind } from "../../chart/engine";
import type { PriceScale } from "../../chart/viewport";
import type { DetectorId } from "../../detect/index";
import type { Params } from "../../chart/params";
import type { ThemeName, Density } from "./views";
import type { DockMode } from "../dockpanels";
import type { DrawerTab } from "../chartdrawer";

export interface ShellState {
  theme: Signal<ThemeName>;
  view: Signal<string>;
  dockOpen: Signal<boolean>;
  focus: Signal<"off" | "on" | "full">;
  symbol: Signal<string>;
  timeframe: Signal<string>;
  chartKind: Signal<ChartKind>;
  /** Linear or logarithmic price axis. See `chart/viewport.ts`. */
  priceScale: Signal<PriceScale>;
  /** Tint the chart background by trading session, on intraday timeframes. */
  sessionBands: Signal<boolean>;
  gridOn: Signal<boolean>;
  candleUp: Signal<string>;
  candleDown: Signal<string>;
  mas: Signal<string[]>;
  /** Price overlays from `chart/studies.ts`. Separate from `mas` because the
      three EMAs predate the registry and are their own toolbar control. */
  studies: Signal<string[]>;
  /** Sub-panes below the chart from `chart/panes.ts` — oscillators with their
      own y-axis, which a price overlay cannot be. */
  panes: Signal<string[]>;
  /**
   * Per-indicator settings, for the studies AND the panes.
   *
   * ONE map for both, keyed by indicator id, because an id is unique across
   * the two registries and the alternative — two maps that must be kept in
   * step — is how "why did my RSI period not save" happens. Only indicators
   * running NON-DEFAULT settings appear here; `sanitiseAll` drops the rest, so
   * the preferences blob stays small and "has anything been tuned" is a
   * property of the map's size rather than a scan.
   */
  studyParams: Signal<Record<string, Params>>;
  /** Inspector dock: layout mode, which panels are open, which card is shown. */
  dockMode: Signal<DockMode>;
  dockOpenIds: Signal<string[]>;
  dockCard: Signal<string>;
  /** v59.2 cards pinned to the top of the column, in pin order. */
  dockPinned: Signal<string[]>;
  /** v59.2 cards taken off the column — offered back under "+ Add panel". */
  dockRemoved: Signal<string[]>;
  /** v59.2 the drawer under the chart: expanded, and which tab. */
  chartDrawerOpen: Signal<boolean>;
  chartDrawerTab: Signal<DrawerTab>;
  detectors: Signal<DetectorId[]>;
  /** Higher timeframes whose structure is projected onto this chart. */
  htf: Signal<string[]>;
  density: Signal<Density>;
}
