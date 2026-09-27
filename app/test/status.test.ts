/**
 * The status strip: the service's health read into five readings.
 *
 * Fixtures are the shapes `/svc/health` (mishel_service.py `health`) and
 * `/svc/sig/watch` (svc/signals.py) actually return — `loops` keyed by loop
 * name with `last` and `stale_s`, `enabled` as a SQLite integer.
 */

import { describe, expect, it } from "vitest";
import { parseStatus, type StatusResult } from "../src/data/status";
import { statusItems } from "../src/ui/shell/statusstrip";
import { TOOL_GROUPS } from "../src/ui/shell/toolsmenu";
import { LAYOUTS } from "../src/ui/shell/viewmenu";
import { VIEWS } from "../src/ui/shell/views";
import { DOCK_PANELS } from "../src/ui/dockpanels";

const HEALTH = {
  ok: true,
  service: "mishel",
  pending_alerts: 3,
  ledger_rows: 40,
  telegram: false,
  loops: {
    alert_loop: { last: 1_790_000_000, stale_s: 12 },
    sig_loop: { last: 1_790_000_000, stale_s: 40 },
    backup_loop: { last: 1_789_990_000, stale_s: 900 },
  },
  stale_loops: ["backup_loop"],
};
const WATCH = { ok: true, watch: [{ id: 1, enabled: 1 }, { id: 2, enabled: 0 }, { id: 3, enabled: 1 }] };

const ok = (h: unknown, w: unknown): StatusResult => ({ state: "ok", value: parseStatus(h, w) });
const item = (items: ReturnType<typeof statusItems>, key: string) => items.find((i) => i.key === key)!;

describe("parseStatus", () => {
  it("reads the real /svc/health and watch shapes", () => {
    expect(parseStatus(HEALTH, WATCH)).toEqual({
      pendingAlerts: 3,
      armedSignals: 2,
      telegram: false,
      loops: 3,
      staleLoops: ["backup_loop"],
    });
  });

  it("says it could not read the armed list, rather than that none are armed", () => {
    expect(parseStatus(HEALTH, null).armedSignals).toBeNull();
    expect(parseStatus(HEALTH, { ok: true, watch: [] }).armedSignals).toBe(0);
  });

  it("reads a partial body from an older service as empty, not as a crash", () => {
    expect(parseStatus({ ok: true }, WATCH)).toMatchObject({ pendingAlerts: 0, loops: 0, staleLoops: [] });
    expect(parseStatus({ pending_alerts: "3" }, WATCH).pendingAlerts).toBe(0);
  });
});

describe("statusItems", () => {
  it("dashes everything it could not ask, and never shows a zero for it", () => {
    const items = statusItems({ state: "offline", reason: "not answering" }, false);
    expect(item(items, "alerts").value).toBe("—");
    expect(item(items, "signals").value).toBe("—");
    expect(item(items, "services").value).toBe("—");
    expect(item(items, "services").why).toBe("not answering");
  });

  it("reads 0 of 0 background services as nothing running, never as all running", () => {
    const s = item(statusItems(ok({ ok: true, pending_alerts: 0, loops: {}, stale_loops: [] }, WATCH), true), "services");
    expect(s.tone).toBe("warn");
    expect(s.why).toMatch(/not being checked/);
  });

  it("colours the services by standing: a stale loop is a warning", () => {
    const s = item(statusItems(ok(HEALTH, WATCH), true), "services");
    expect(s.value).toBe("2/3");
    expect(s.tone).toBe("warn");
    expect(s.why).toContain("backup_loop");
  });

  it("does not colour a count — twelve alerts are not worse than three", () => {
    const a = item(statusItems(ok({ ...HEALTH, pending_alerts: 12 }, WATCH), true), "alerts");
    expect(a.value).toBe("12");
    expect(a.tone).toBe("");
  });

  it("says the risk governor is blind without the broker, not that the book is flat", () => {
    const r = item(statusItems(ok(HEALTH, WATCH), false), "risk");
    expect(r.value).toBe("blind");
    expect(r.tone).toBe("warn");
    expect(item(statusItems(ok(HEALTH, WATCH), true), "risk").value).toBe("live");
  });

  it("dashes armed signals when the list could not be read, and says why", () => {
    const s = item(statusItems(ok(HEALTH, null), true), "signals");
    expect(s.value).toBe("—");
    expect(s.why).toMatch(/could not be read/);
  });
});

describe("All tools", () => {
  const ids = new Set<string>(VIEWS.map((v) => v.id));

  it("links only to desks that exist", () => {
    for (const g of TOOL_GROUPS) for (const t of g.tools) if ("view" in t) expect(ids).toContain(t.view);
  });

  it("reaches every desk, so nothing is left without an address", () => {
    const linked = new Set(TOOL_GROUPS.flatMap((g) => g.tools.flatMap((t) => ("view" in t ? [t.view] : []))));
    expect([...ids].filter((id) => !linked.has(id))).toEqual([]);
  });

  it("opens only inspector cards that exist", () => {
    const cards = new Set(DOCK_PANELS.map((p) => p.id));
    for (const g of TOOL_GROUPS) for (const t of g.tools) if ("card" in t) expect(cards).toContain(t.card);
  });

  it("names why a backend-only tool has no screen", () => {
    for (const g of TOOL_GROUPS) for (const t of g.tools) if ("pending" in t) expect(t.pending.length).toBeGreaterThan(10);
  });

  /*
   * ONE TAXONOMY. Before this was enforced, `toolsmenu.ts` named its own five
   * groups and `VIEWS` named five different ones, and 0 OF 24 view-backed
   * desks were filed in the same group by both: Signals was Strategy on the
   * desk bar and Trading in this menu. Nothing compared them, so nothing said
   * so. These three pin the projection, not the current strings.
   */
  it("files every desk in the group the desk bar files it in", () => {
    const deskGroup = new Map(VIEWS.map((v) => [v.id, v.group as string]));
    for (const g of TOOL_GROUPS) {
      for (const t of g.tools) {
        if ("view" in t) expect([t.view, g.group]).toEqual([t.view, deskGroup.get(t.view)]);
      }
    }
  });

  it("uses the desk bar's own group names, in its order", () => {
    expect(TOOL_GROUPS.map((g) => g.group)).toEqual([...new Set(VIEWS.map((v) => v.group))]);
  });

  it("calls a desk what the desk bar calls it", () => {
    const label = new Map(VIEWS.map((v) => [v.id, v.label as string]));
    for (const g of TOOL_GROUPS) {
      for (const t of g.tools) {
        if ("view" in t) expect([t.view, t.label]).toEqual([t.view, label.get(t.view)]);
      }
    }
  });

  it("lists each desk exactly once", () => {
    const seen = TOOL_GROUPS.flatMap((g) => g.tools.flatMap((t) => ("view" in t ? [t.view] : [])));
    expect(seen.length).toBe(new Set(seen).size);
  });
});

describe("View layouts", () => {
  it("chart focus closes the inspector; the other two open it at a width", () => {
    expect(LAYOUTS.focus.dock).toBe(false);
    expect([LAYOUTS.balanced.dock, LAYOUTS.balanced.width]).toEqual([true, "standard"]);
    expect([LAYOUTS.analysis.dock, LAYOUTS.analysis.width]).toEqual([true, "wide"]);
  });
});
