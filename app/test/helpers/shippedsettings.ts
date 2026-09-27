/**
 * The real settings list, built against a stub.
 *
 * WHY THIS EXISTS
 * `orphanSettings(SECTIONS, [])` — which is what the coherence test used to
 * assert — says an empty list contains no orphans. That is true of every
 * codebase and catches nothing. The mistake it was written to catch, a mistyped
 * `section:` on a definition, can only be caught by building the definitions
 * that actually ship.
 *
 * `buildSettings` reads its dependencies lazily inside each `read()`, so a stub
 * only has to be shaped correctly, not functional. Nothing here pretends to be
 * a real account, a real archive or a real source list — the point is to
 * enumerate the definitions, not to exercise them.
 */

import { signal, type Signal } from "../../src/core/signal";
import { buildSettings, type DefDeps } from "../../src/settings/defs";
import { DEFAULT_RULES, type GateRules } from "../../src/setup/rules";
import { DEFAULT_EXIT_RULES, type ExitRules } from "../../src/setup/exit";
import { DEFAULT_ACCOUNT, type Account } from "../../src/core/account";
import type { SettingDef } from "../../src/settings/schema";

/**
 * A working account store, because the definitions genuinely read it.
 *
 * The first version of this stub was `{}` and the read-through test caught it
 * immediately — `account.currency` calls `account.account()`. A stub thin enough
 * to throw would make that test pass only by never being run.
 */
function stubAccount(): DefDeps["account"] {
  const account = signal<Account>({ ...DEFAULT_ACCOUNT });
  return {
    account,
    update: (patch) => account.set({ ...account.peek(), ...patch }),
    conflicts: signal<readonly never[]>([]) as DefDeps["account"]["conflicts"],
    resolve: () => {},
    dismissConflicts: () => {},
  };
}

export function stubDeps(over: Partial<DefDeps> = {}): DefDeps {
  let rules: GateRules = { ...DEFAULT_RULES };
  let exits: ExitRules = { ...DEFAULT_EXIT_RULES };
  let volumeHeight = 48;

  const s = <T>(v: T): Signal<T> => signal<T>(v);

  return {
    account: stubAccount(),
    theme: s("iram"),
    themes: ["iram", "daylight"],
    density: s("standard"),
    densities: ["compact", "standard"],
    accent: s("theme"),
    accents: ["theme", "brass"],
    /* The three shell-owned layout signals a preset writes. Present here on
       purpose: they are optional on `DefDeps` so a build that has not wired
       them still compiles, and the definitions that depend on them would then
       never be enumerated by any test. The stub is what keeps them covered. */
    watchRail: s(true),
    newsBar: s(true),
    dockOpen: s(true),
    defaultTimeframe: s("1h"),
    timeframes: ["1m", "1h", "1d"],
    chartKind: s("candles"),
    chartKinds: ["candles", "line"],
    volumeOn: s(true),
    sessionBands: s(true),
    gridOn: s(true),
    candleUp: s(""),
    candleDown: s(""),
    effectiveCandle: (which) => (which === "up" ? "#2dbe8e" : "#f0616d"),
    evidenceAuto: s(true),
    volumeHeight: () => volumeHeight,
    setVolumeHeight: (px: number) => {
      volumeHeight = px;
    },
    alertSound: s(true),
    alertDesktop: s(false),
    durability: { state: "durable", note: "", remedy: null },
    storageBytes: () => 0,
    feedNote: () => "",
    version: "test",
    rules: () => rules,
    setRule: (patch) => {
      rules = { ...rules, ...patch };
    },
    resetRules: () => {
      rules = { ...DEFAULT_RULES };
    },
    exitRules: () => exits,
    setExitRule: (patch) => {
      exits = { ...exits, ...patch };
    },
    resetExitRules: () => {
      exits = { ...DEFAULT_EXIT_RULES };
    },
    sources: () => [],
    setSourceEnabled: () => {},
    sourceEnabled: () => true,
    studyParams: s({}),
    symbol: () => "BTCUSDT",
    openKeyboardSheet: () => {},
    openNotificationLog: () => {},
    exportVault: () => {},
    resetGovernor: () => {},
    ...over,
  };
}

export function shippedSettings(over: Partial<DefDeps> = {}): SettingDef[] {
  return buildSettings(stubDeps(over));
}
