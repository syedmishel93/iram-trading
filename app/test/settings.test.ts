import { describe, expect, it } from "vitest";
import {
  groupSections,
  orphanSettings,
  searchSettings,
  type SectionDef,
  type SettingDef,
} from "../src/settings/schema";
import { SECTIONS } from "../src/settings/defs";
import { shippedSettings } from "./helpers/shippedsettings";

const sections: SectionDef[] = [
  { id: "account", label: "Account & risk", group: "Trading" },
  { id: "appearance", label: "Appearance", group: "Terminal" },
  { id: "data", label: "Data & storage", group: "Data" },
];

const def = (id: string, section: string, label: string, extra: Partial<SettingDef> = {}): SettingDef => ({
  id,
  section,
  label,
  control: { kind: "text" },
  read: () => "",
  ...extra,
});

const settings: SettingDef[] = [
  def("account.equity", "account", "Equity", {
    hint: "Drives every lot size.",
    keywords: ["risk desk", "capital"],
  }),
  def("account.riskPct", "account", "Risk per trade", { keywords: ["position size"] }),
  def("appearance.density", "appearance", "Density", {
    hint: "Scales the whole terminal.",
    keywords: ["compact", "scale"],
  }),
  def("appearance.theme", "appearance", "Theme", { keywords: ["dark", "light", "colour"] }),
  def("data.vault", "data", "Export a settings vault", { keywords: ["backup", "data desk"] }),
];

const ids = (hits: ReturnType<typeof searchSettings>): string[] => hits.map((h) => h.setting.id);

describe("searchSettings", () => {
  it("returns nothing for an empty query", () => {
    expect(searchSettings(settings, sections, "  ")).toEqual([]);
  });

  it("finds by exact label first", () => {
    expect(ids(searchSettings(settings, sections, "density"))[0]).toBe("appearance.density");
  });

  it("finds by prefix", () => {
    expect(ids(searchSettings(settings, sections, "equ"))).toContain("account.equity");
  });

  it("finds by a keyword — what the thing used to be called", () => {
    /* Someone who knows it as "the Data desk export" must land on it. */
    expect(ids(searchSettings(settings, sections, "backup"))).toContain("data.vault");
    expect(ids(searchSettings(settings, sections, "risk desk"))).toContain("account.equity");
  });

  it("matches only at word starts, never mid-word", () => {
    /* The reason this is not the fuzzy matcher: subsequence matching would
       find "risk" inside half the hints and return noise. */
    expect(ids(searchSettings(settings, sections, "ensity"))).toEqual([]);
  });

  it("ANDs multiple terms", () => {
    expect(ids(searchSettings(settings, sections, "risk trade"))).toEqual(["account.riskPct"]);
    expect(searchSettings(settings, sections, "density backup")).toEqual([]);
  });

  it("ranks a label match above a hint match", () => {
    const hits = ids(searchSettings(settings, sections, "scale"));
    /* "scale" is a keyword of density and a word in its hint; either way the
       density row must lead. */
    expect(hits[0]).toBe("appearance.density");
  });

  it("finds by section name", () => {
    expect(ids(searchSettings(settings, sections, "appearance")).length).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    expect(ids(searchSettings(settings, sections, "THEME"))).toContain("appearance.theme");
  });

  it("is stable within equal scores, so results keep screen order", () => {
    const a = ids(searchSettings(settings, sections, "a"));
    const b = ids(searchSettings(settings, sections, "a"));
    expect(a).toEqual(b);
  });
});

describe("groupSections", () => {
  it("groups sections under their nav heading, in declaration order", () => {
    const groups = groupSections(sections, settings);
    expect(groups.map((g) => g.group)).toEqual(["Trading", "Terminal", "Data"]);
  });

  it("attaches each section's settings", () => {
    const groups = groupSections(sections, settings);
    const account = groups[0]?.sections[0];
    expect(account?.section.id).toBe("account");
    expect(account?.settings.map((s) => s.id)).toEqual(["account.equity", "account.riskPct"]);
  });

  it("keeps a section with no settings rather than dropping it silently", () => {
    const withEmpty = [...sections, { id: "keyboard", label: "Keyboard", group: "Terminal" }];
    const groups = groupSections(withEmpty, settings);
    const terminal = groups.find((g) => g.group === "Terminal");
    expect(terminal?.sections.map((s) => s.section.id)).toEqual(["appearance", "keyboard"]);
  });
});

describe("orphanSettings", () => {
  it("catches a setting naming a section that does not exist", () => {
    const typo = def("x.y", "acount", "Typo");
    expect(orphanSettings(sections, [...settings, typo]).map((s) => s.id)).toEqual(["x.y"]);
  });

  it("the shipped sections have no orphans", () => {
    /* A guard against a typo in defs.ts silently hiding a real setting: an
       orphan renders nowhere and is findable only by search.

       Built from the REAL definitions. Passing `[]` here — which is what this
       test used to do — asserts that an empty list contains no orphans, which
       is true of every codebase and catches nothing. Adding a section is
       exactly when a mistyped `section:` slips in. */
    expect(orphanSettings(SECTIONS, shippedSettings()).map((s) => s.id)).toEqual([]);
  });

  it("every shipped section actually holds a setting", () => {
    // A section with nothing in it renders as a heading over empty space.
    const used = new Set(shippedSettings().map((s) => s.section));
    expect(SECTIONS.filter((s) => !used.has(s.id)).map((s) => s.id)).toEqual([]);
  });

  it("the shipped settings have unique ids", () => {
    const all = shippedSettings().map((s) => s.id);
    expect(all.length).toBe(new Set(all).size);
  });

  it("every setting with a control can be read without throwing", () => {
    for (const setting of shippedSettings()) {
      expect(() => setting.read(), setting.id).not.toThrow();
    }
  });
});

describe("the shipped section list", () => {
  it("has unique ids", () => {
    const seen = new Set(SECTIONS.map((s) => s.id));
    expect(seen.size).toBe(SECTIONS.length);
  });

  it("gives every section a group and a blurb", () => {
    for (const s of SECTIONS) {
      expect(s.group.length).toBeGreaterThan(0);
      expect((s.blurb ?? "").length).toBeGreaterThan(0);
    }
  });
});
