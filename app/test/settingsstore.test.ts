/**
 * THE BACKTESTER'S SETTINGS, AS STORED.
 *
 * The sanitiser is the whole risk surface. Stored settings are the operator's
 * data and arrive from an older build, a hand-edited export, or another tab —
 * so every field is read individually and clamped, because the two easy
 * failures are both silent: rejecting the whole blob over one bad number
 * resets a configuration somebody spent time on, and trusting a number sizes
 * every position by it.
 */

import { describe, expect, it } from "vitest";
import {
  BACKTEST_SETTINGS_SLOT,
  createSettingsStore,
  sanitiseSettings,
} from "../src/backtest/settingsstore";
import { PRESETS, STANDARD, flatteryIn } from "../src/backtest/settings";
import { createKV, memoryRawStore } from "../src/store/kv";

const kv = () => createKV(memoryRawStore());

describe("reading stored settings", () => {
  it("FALLS BACK TO THE STANDARD WHEN THERE IS NOTHING", () => {
    expect(sanitiseSettings(undefined)).toEqual(STANDARD);
    expect(sanitiseSettings(null)).toEqual(STANDARD);
    expect(sanitiseSettings("not settings")).toEqual(STANDARD);
    expect(sanitiseSettings([])).toEqual(STANDARD);
  });

  it("KEEPS THE GOOD FIELDS WHEN ONE IS BAD", () => {
    /* The failure that matters. Rejecting the whole blob because one number is
       wrong silently resets a configuration somebody spent time on, with
       nothing on screen saying why. */
    const read = sanitiseSettings({
      bar: { minTrades: 120, maxPbo: "nonsense" },
      risk: { perTrade: 0.005 },
    });
    expect(read.bar.minTrades).toBe(120);
    expect(read.bar.maxPbo, "a bad neighbour took a good field with it").toBe(STANDARD.bar.maxPbo);
    expect(read.risk.perTrade).toBe(0.005);
    expect(read.fills).toEqual(STANDARD.fills);
  });

  it("CLAMPS RISK PER TRADE, because a stored 50 is not a preference", () => {
    /* This repository already records a unit defect that sized positions a
       thousand times wrong. A stored `perTrade` of 50 reads as 5,000% of
       equity; the clamp is the refusal, applied where the value enters. */
    expect(sanitiseSettings({ risk: { perTrade: 50 } }).risk.perTrade).toBe(0.1);
    expect(sanitiseSettings({ risk: { perTrade: -3 } }).risk.perTrade).toBe(0.0001);
  });

  it("CLAMPS EVERY OTHER RANGE IT CAN ACT ON", () => {
    const wild = sanitiseSettings({
      bar: { maxPbo: 9, minRetention: -1, minTrades: 0 },
      data: { minCoverage: 44 },
      windows: { count: 500, testBars: 1, purgeBars: -8 },
    });
    expect(wild.bar.maxPbo).toBe(1);
    expect(wild.bar.minRetention).toBe(0);
    expect(wild.bar.minTrades).toBe(1);
    expect(wild.data.minCoverage).toBe(1);
    expect(wild.windows.count).toBe(24);
    expect(wild.windows.testBars).toBe(20);
    expect(wild.windows.purgeBars).toBe(0);
  });

  it("REFUSES AN ENTRY MODE OR COST MODEL IT DOES NOT KNOW", () => {
    /* A stored string that names nothing must not reach a switch that falls
       through — the honest answer is the standard, which is the conservative
       one in both cases. */
    expect(sanitiseSettings({ fills: { entry: "whenever" } }).fills.entry).toBe("next-open");
    expect(sanitiseSettings({ costs: { model: "free-lunch" } }).costs.model).toBe("standard");
  });

  it("SANITISES THE BROKER'S FIGURES RATHER THAN CASTING THEM", () => {
    /* A cast would let a string through to arithmetic that produces NaN, and
       the engine would charge NaN as a cost of nothing — the most flattering
       possible reading of a corrupt field. */
    const read = sanitiseSettings({
      costs: { model: "measured", override: { spread: 0.00042, commission: "lots", nonsense: 1 } },
    });
    expect(read.costs.override).toEqual({ spread: 0.00042 });
  });

  it("DROPS AN EMPTY OVERRIDE rather than storing a hollow one", () => {
    const read = sanitiseSettings({ costs: { model: "measured", override: { commission: "x" } } });
    expect(read.costs.override).toBeUndefined();
  });
});

describe("the store", () => {
  it("SEEDS FROM STORAGE AND WRITES THROUGH", () => {
    const store = createKV(memoryRawStore());
    const a = createSettingsStore(store);
    expect(a.settings()).toEqual(STANDARD);

    expect(a.patch("bar", { minTrades: 150 }).ok).toBe(true);
    expect(a.settings().bar.minTrades).toBe(150);
    /* A reload: a second store over the same bytes. */
    expect(createSettingsStore(store).settings().bar.minTrades).toBe(150);
  });

  it("CHANGES ONE GROUP WITHOUT TOUCHING THE REST", () => {
    const s = createSettingsStore(kv());
    s.patch("risk", { perTrade: 0.004 });
    expect(s.settings().risk.perTrade).toBe(0.004);
    expect(s.settings().bar).toEqual(STANDARD.bar);
    expect(s.settings().windows).toEqual(STANDARD.windows);
  });

  it("NAMES THE PRESET IT MATCHES, AND NOTHING ONCE EDITED", () => {
    /* "Strict, edited" and "Strict" are different configurations and must not
       read the same — which is the entire reason settings are recorded. */
    const s = createSettingsStore(kv());
    expect(s.presetId()).toBe("standard");
    s.usePreset("paranoid");
    expect(s.presetId()).toBe("paranoid");
    s.patch("bar", { minTrades: 201 });
    expect(s.presetId()).toBeNull();
  });

  it("REFUSES A PRESET ID IT DOES NOT HAVE, and changes nothing", () => {
    const s = createSettingsStore(kv());
    s.usePreset("strict");
    const before = s.settings();
    expect(s.usePreset("does-not-exist")).toBeNull();
    expect(s.settings()).toEqual(before);
  });

  it("CARRIES FLATTERY THROUGH A ROUND TRIP, so a dishonest run cannot forget", () => {
    /* The point of the honesty flag is that it survives storage. A
       configuration that admitted to look-ahead before a reload and not after
       would be the worst of both. */
    const store = createKV(memoryRawStore());
    createSettingsStore(store).usePreset("lie");
    const again = createSettingsStore(store);
    expect(flatteryIn(again.settings()).length).toBeGreaterThan(0);
  });

  it("STORES UNDER A KEY THAT IS THE OPERATOR'S DATA", () => {
    expect(BACKTEST_SETTINGS_SLOT.key).toBe("backtest.settings");
    expect(BACKTEST_SETTINGS_SLOT.version).toBe(1);
  });

  it("ROUND-TRIPS EVERY SHIPPED PRESET UNCHANGED", () => {
    /* A preset that does not survive its own sanitiser is a preset that
       silently becomes something else on the next boot. */
    for (const p of PRESETS) {
      expect(sanitiseSettings(JSON.parse(JSON.stringify(p.settings))), p.id).toEqual(p.settings);
    }
  });
});
