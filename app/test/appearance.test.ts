// @vitest-environment jsdom
/**
 * The appearance controls: the preset table, the token contract, and the
 * store that turns a preference into an attribute.
 *
 * EVERY EXPECTED VALUE HERE IS WRITTEN OUT OR READ FROM THE STYLESHEET —
 * never computed by the code under test. The one thing that is deliberately
 * cross-checked rather than repeated is "Analyst is today's terminal": it is
 * asserted against the SHIPPED DEFAULTS, because a literal copy of them here
 * would go on passing on the day one of them changed.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_SLOT,
  KNOBS,
  createAppearance,
  knob,
  sanitiseKnob,
} from "../src/ui/appearance";
import {
  CUSTOM,
  LAYOUT_PRESETS,
  findPreset,
  matchPreset,
  presetSummary,
  type LayoutState,
} from "../src/settings/presets";
import { wickWidth } from "../src/chart/engine";
import { createKV, memoryRawStore } from "../src/store/kv";
import { signal } from "../src/core/signal";
import { SECTIONS, buildSettings } from "../src/settings/defs";
import { searchSettings, type SettingDef } from "../src/settings/schema";
import { createSettings } from "../src/settings/ui";
import { shippedSettings, stubDeps } from "./helpers/shippedsettings";

/* `import.meta.url` is an http URL under the jsdom environment, not a file
   one, so the source is read relative to the project root instead. */
const source = (rel: string): string => readFileSync(resolve(process.cwd(), rel), "utf8");
const tokens = source("src/styles/tokens.css");
const settingsCss = source("src/styles/settings.css");
const shellCss = source("src/styles/shell.css");
const engineTs = source("src/chart/engine.ts");

/* `effect` re-runs on a MICROTASK, so an attribute written by one is not on
   the element in the same tick the signal was set. Every assertion about the
   DOM or about storage below waits for that flush rather than for a timer —
   a test that polled would pass for the wrong reason. */
const flush = (): Promise<void> => Promise.resolve();

// ------------------------------------------------------------- presets ---

describe("the layout presets", () => {
  it("Focus is chart-led, and these are the seven values it writes", () => {
    expect(findPreset("focus")?.values).toEqual({
      density: "compact",
      dock: "narrow",
      gutter: "tight",
      liveBar: "standard",
      watchRail: false,
      newsBar: false,
      dockOpen: true,
    });
  });

  it("Trader is the wide one", () => {
    expect(findPreset("trader")?.values).toEqual({
      density: "comfortable",
      dock: "wide",
      gutter: "standard",
      liveBar: "tall",
      watchRail: true,
      newsBar: true,
      dockOpen: true,
    });
  });

  it("Analyst IS the shipped default, field by field", () => {
    /* The point of the rule "nobody's terminal changes appearance on upgrade".
       Compared against the defaults themselves rather than against a copy of
       them: a literal here would keep passing after one of them moved, which
       is exactly the failure this is meant to catch. */
    const analyst = findPreset("analyst")?.values;
    expect(analyst?.dock).toBe(knob("dock").fallback);
    expect(analyst?.gutter).toBe(knob("gutter").fallback);
    expect(analyst?.liveBar).toBe(knob("livebar").fallback);
    /* The shell's own defaults: `prefs["density"] ?? "standard"`,
       `prefs["watchRail"] !== false`, `prefs["newsBar"] !== false`,
       `prefs["dockOpen"] !== false` — see ui/shell.ts. */
    expect(analyst?.density).toBe("standard");
    expect(analyst?.watchRail).toBe(true);
    expect(analyst?.newsBar).toBe(true);
    expect(analyst?.dockOpen).toBe(true);
  });

  it("names three presets, with no duplicate ids and none called custom", () => {
    expect(LAYOUT_PRESETS.map((p) => p.id)).toEqual(["focus", "analyst", "trader"]);
    expect(LAYOUT_PRESETS.some((p) => p.id === CUSTOM)).toBe(false);
  });

  it("every preset value is a choice the knob actually offers", () => {
    for (const preset of LAYOUT_PRESETS) {
      for (const [id, value] of [
        ["dock", preset.values.dock],
        ["gutter", preset.values.gutter],
        ["livebar", preset.values.liveBar],
      ] as const) {
        expect(knob(id).options.map((o) => o.value), `${preset.id}.${id}`).toContain(value);
      }
    }
  });
});

const live = (over: Partial<LayoutState> = {}): LayoutState => ({
  density: "standard",
  dock: "standard",
  gutter: "standard",
  liveBar: "standard",
  watchRail: true,
  newsBar: true,
  dockOpen: true,
  ...over,
});

describe("matchPreset", () => {
  it("reports the preset the live layout matches", () => {
    expect(matchPreset(live())).toBe("analyst");
    expect(matchPreset(live({ density: "compact", dock: "narrow", gutter: "tight", watchRail: false, newsBar: false }))).toBe("focus");
    expect(matchPreset(live({ density: "comfortable", dock: "wide", liveBar: "tall" }))).toBe("trader");
  });

  it("one field off the preset is custom, not the nearest preset", () => {
    expect(matchPreset(live({ gutter: "airy" }))).toBe(CUSTOM);
    expect(matchPreset(live({ watchRail: false }))).toBe(CUSTOM);
  });

  it("skips a field this build cannot read rather than reporting custom for ever", () => {
    /* A shell that has not wired the rail reports null for it. The other six
       still match Analyst, and the readout must say so. */
    expect(matchPreset(live({ watchRail: null, newsBar: null, dockOpen: null }))).toBe("analyst");
    /* And a null field cannot rescue a real mismatch. */
    expect(matchPreset(live({ watchRail: null, density: "compact" }))).toBe(CUSTOM);
  });
});

describe("presetSummary", () => {
  it("names every preference the preset will overwrite", () => {
    const focus = findPreset("focus");
    expect(focus).not.toBeNull();
    const text = presetSummary(focus as NonNullable<typeof focus>);
    for (const word of ["density", "inspector", "gutter", "live bar", "watchlist rail", "news strip"]) {
      expect(text, word).toContain(word);
    }
    expect(text).toContain("compact");
    expect(text).toContain("rail off");
    expect(text).toContain("news strip off");
  });
});

// ------------------------------------------------------------- the store ---

describe("sanitiseKnob", () => {
  it("keeps a known choice", () => {
    expect(sanitiseKnob("radius", "round")).toBe("round");
    expect(sanitiseKnob("wick", "heavy")).toBe("heavy");
  });

  it("replaces anything else with the choice that sets no attribute", () => {
    expect(sanitiseKnob("radius", "circular")).toBe("soft");
    expect(sanitiseKnob("gutter", 12)).toBe("standard");
    expect(sanitiseKnob("grid", null)).toBe("lines");
    expect(sanitiseKnob("wick", undefined)).toBe("hairline");
  });
});

describe("createAppearance", () => {
  it("starts on the defaults and sets NO attribute for any of them", () => {
    const root = document.createElement("div");
    createAppearance(createKV(memoryRawStore()), root);
    for (const k of KNOBS) expect(root.hasAttribute(k.attribute), k.id).toBe(false);
  });

  it("writes the attribute for a non-default choice and takes it off again", async () => {
    const root = document.createElement("div");
    const look = createAppearance(createKV(memoryRawStore()), root);

    look.radius.set("round");
    look.wick.set("heavy");
    await flush();
    expect(root.getAttribute("data-radius")).toBe("round");
    expect(root.getAttribute("data-wick")).toBe("heavy");

    look.radius.set("soft");
    await flush();
    expect(root.hasAttribute("data-radius")).toBe(false);
  });

  it("persists, and reads back only values the knobs still offer", async () => {
    const kv = createKV(memoryRawStore());
    const root = document.createElement("div");
    createAppearance(kv, root).dock.set("wide");
    await flush();
    expect(kv.read(APPEARANCE_SLOT).value["dock"]).toBe("wide");

    const second = createAppearance(kv, document.createElement("div"));
    expect(second.dock()).toBe("wide");

    kv.write(APPEARANCE_SLOT, { dock: "enormous" });
    expect(createAppearance(kv, document.createElement("div")).dock()).toBe("standard");
  });

  it("runs without a document at all, because the settings list is enumerated in node", () => {
    const look = createAppearance(createKV(memoryRawStore()), null);
    expect(() => look.gutter.set("airy")).not.toThrow();
    expect(look.gutter()).toBe("airy");
  });
});

// ------------------------------------------------------------ the tokens ---

describe("the appearance tokens", () => {
  it("every knob option has a rule, and the default has none", () => {
    for (const k of KNOBS) {
      for (const option of k.options) {
        const rule = `[${k.attribute}="${option.value}"]`;
        if (option.value === k.fallback) {
          expect(tokens.includes(rule), `${rule} must not exist — the default sets no attribute`).toBe(false);
        } else {
          expect(tokens.includes(rule), `${rule} missing from tokens.css`).toBe(true);
        }
      }
    }
  });

  it("every role a knob re-points is declared, and read by something", () => {
    /* A token defined and referenced nowhere is a setting that does nothing;
       a token referenced and never defined is the `--fs-0` orphan, which
       drops the whole declaration silently. Both directions, per token. */
    const consumers = `${shellCss}\n${settingsCss}\n${engineTs}`;
    for (const role of ["--r-card", "--shell-gap", "--w-dock", "--h-status", "--chart-grid-style", "--chart-wick"]) {
      expect(tokens.includes(`${role}:`), `${role} is not declared in tokens.css`).toBe(true);
      expect(consumers.includes(role), `${role} is defined but nothing reads it`).toBe(true);
    }
  });

  it("the appearance block comes AFTER the density block, because a tie is broken by order", () => {
    /* `[data-gutter="tight"]` and `[data-density="compact"]` are both (0,1,0)
       and both write --shell-gap. Nothing in CSS warns about this; the file's
       own comment says the block must stay last, and this is what makes that
       a fact rather than a hope. */
    expect(tokens.indexOf('[data-gutter="tight"]')).toBeGreaterThan(tokens.indexOf('[data-density="compact"]'));
    expect(tokens.indexOf('[data-dock-size="narrow"]')).toBeGreaterThan(tokens.lastIndexOf("--w-dock:      360px"));
    expect(tokens.indexOf('[data-livebar="tall"]')).toBeGreaterThan(tokens.indexOf("--h-status:    30px"));
    expect(tokens.indexOf('[data-radius="square"]')).toBeGreaterThan(tokens.indexOf("--r-card: 12px"));
  });

  it("the inspector widths stay inside the range the splitter allows", () => {
    /* 260 and 720 are --w-dock-min and --w-dock-max. A preset that put the
       inspector outside them would be a width the drag handle refuses. */
    for (const px of [288, 460]) {
      expect(px).toBeGreaterThanOrEqual(260);
      expect(px).toBeLessThanOrEqual(720);
      expect(tokens).toContain(`${px}px`);
    }
  });

  it("no literal duration was introduced with the preview", () => {
    /* tokens.css is the only file allowed a raw ms value; a literal in a
       transition cannot be re-pointed to 0 under prefers-reduced-motion. */
    expect(/transition[^;]*\d+ms/.test(settingsCss)).toBe(false);
  });
});

describe("wickWidth", () => {
  it("reads the token", () => {
    expect(wickWidth("1")).toBe(1);
    expect(wickWidth("1.5")).toBe(1.5);
    expect(wickWidth("2")).toBe(2);
  });

  it("falls back to the width the chart has always drawn", () => {
    expect(wickWidth("")).toBe(1);
    expect(wickWidth("thick")).toBe(1);
  });

  it("clamps rather than letting a wick vanish or swallow the body", () => {
    expect(wickWidth("0")).toBe(0.5);
    expect(wickWidth("40")).toBe(3);
  });
});

// ---------------------------------------------------- the shipped section ---

describe("the Appearance controls, as they ship", () => {
  const byId = (defs: readonly SettingDef[], id: string): SettingDef => {
    const found = defs.find((s) => s.id === id);
    if (!found) throw new Error(`no setting ${id}`);
    return found;
  };

  it("the preset select writes the shell's OWN signals, not a copy of them", () => {
    const watchRail = signal(true);
    const newsBar = signal(true);
    const dockOpen = signal(true);
    const density = signal("standard");
    const defs = shippedSettings({ watchRail, newsBar, dockOpen, density });

    const preset = byId(defs, "appearance.preset");
    expect(preset.read()).toBe("analyst");

    preset.write?.("focus");
    expect(watchRail()).toBe(false);
    expect(newsBar()).toBe(false);
    expect(dockOpen()).toBe(true);
    expect(density()).toBe("compact");
    expect(byId(defs, "appearance.dock").read()).toBe("narrow");
    expect(byId(defs, "appearance.gutter").read()).toBe("tight");
    /* And the readout follows the values, because it IS the values. */
    expect(preset.read()).toBe("focus");

    /* A single hand edit takes it off the preset without anything else moving. */
    byId(defs, "appearance.gutter").write?.("airy");
    expect(preset.read()).toBe(CUSTOM);
    expect(density()).toBe("compact");

    preset.write?.("analyst");
    expect(preset.read()).toBe("analyst");
  });

  it("choosing Custom is a no-op, because there is no layout called custom", () => {
    const density = signal("standard");
    const preset = byId(shippedSettings({ density }), "appearance.preset");
    preset.write?.(CUSTOM);
    expect(density()).toBe("standard");
  });

  it("the grid control maps off / lines / dots onto two owners", () => {
    const gridOn = signal(true);
    const grid = byId(shippedSettings({ gridOn }), "chart.grid");

    grid.write?.("dots");
    expect(gridOn()).toBe(true);
    expect(grid.read()).toBe("dots");

    grid.write?.("off");
    expect(gridOn()).toBe(false);
    expect(grid.read()).toBe("off");

    /* Switching it back on restores the dialect rather than resetting it. */
    grid.write?.("dots");
    expect(grid.read()).toBe("dots");
    grid.write?.("lines");
    expect(grid.read()).toBe("lines");
  });

  it("omits the rail and news rows when the shell does not expose them, and says so", () => {
    const { watchRail, newsBar, dockOpen, ...noLayout } = stubDeps();
    void watchRail;
    void newsBar;
    void dockOpen;
    const defs = buildSettings(noLayout);
    const ids = defs.map((s) => s.id);
    expect(ids).not.toContain("appearance.watchrail");
    expect(ids).not.toContain("appearance.newsbar");
    /* A control wired to nothing is worse than an absent one — but the note
       has to NAME what it could not reach. */
    const note = byId(defs, "appearance.presetnote").read();
    expect(note).toContain("the watchlist rail");
    expect(note).toContain("the news strip");
    /* And with them present it claims nothing it did not do. */
    expect(byId(shippedSettings(), "appearance.presetnote").read()).not.toContain("cannot reach");
  });

  it("every new control is findable by the word somebody would search for", () => {
    const defs = shippedSettings();
    for (const [query, id] of [
      ["preset", "appearance.preset"],
      ["corners", "appearance.radius"],
      ["gutter", "appearance.gutter"],
      ["inspector", "appearance.dock"],
      ["dots", "chart.grid"],
      ["wick", "chart.wick"],
      ["hollow", "chart.bodystyle"],
      ["font", "appearance.textsize"],
    ] as const) {
      const hits = searchSettings(defs, SECTIONS, query).map((h) => h.setting.id);
      expect(hits, query).toContain(id);
    }
  });
});

/**
 * EVERY SELECT ON THE SETTINGS SCREEN SHOWED ITS FIRST OPTION.
 *
 * MEASURED in the running terminal before the fix: :root carried
 * `data-density="standard"` while the Density select read "compact", and the
 * same was true of Theme, Accent and every new control added beside them —
 * `.set-select` values were `["focus","iram","theme","compact","square",…]`,
 * which is each list's first entry and nothing to do with the live value.
 *
 * `dom.ts` applies props BEFORE children, so `value: () => …` assigned
 * `select.value` while the element had no `<option>` to match — a write the
 * DOM discards in silence. It is the same class as the bug `dom.ts`'s own
 * header records about `setAttribute("value")`: the state was right and the
 * screen was wrong, which for a preferences screen means the control lies
 * about what the terminal is doing until you touch it.
 */
describe("a select shows the value, not the first option", () => {
  it("renders the live value even when it is not first in the list", () => {
    /* "standard" is second in the stub's list, so a control showing the first
       entry and a control showing the truth cannot be confused. */
    const density = signal("standard");
    const defs = shippedSettings({ density });
    /* Appearance first, so the panel renders it on open: switching section is
       a frame-scheduled re-render and this test is about the control, not
       about the scheduler. */
    const surface = createSettings({
      sections: SECTIONS.filter((s) => s.id === "appearance"),
      settings: defs,
    });
    surface.open();

    const select = document.querySelector<HTMLSelectElement>('.set-select[aria-label="Density"]');
    expect(select).not.toBeNull();
    expect(select?.options[0]?.value).toBe("compact");
    expect(select?.value).toBe("standard");
    surface.close();
  });
});
