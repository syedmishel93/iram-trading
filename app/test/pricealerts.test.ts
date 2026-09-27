// @vitest-environment jsdom
/**
 * Server-side price alerts: `data/pricealerts.ts` and the inspector card.
 *
 * Fixture rows are written by hand from the DDL in server/db/schema.py —
 * alerts(id, sym, op, price, note, created, fired), times in Unix SECONDS.
 * Every expected value is a literal; URLs are checked by parsing what `fetch`
 * was actually called with, never against a value the code under test built.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { addAlert, deleteAlert, loadAlerts, parseAlerts, suggestOp } from "../src/data/pricealerts";
import { createAlertsCard, distancePct, parsePriceInput } from "../src/ui/cards/alertscard";
import { signal } from "../src/core/signal";

/* As `dict(sqlite3.Row)` serialises them through Flask's jsonify. */
const ROWS = [
  { id: 9, sym: "BTCUSD", op: "above", price: 85000.0, note: "breakout", created: 1758400000.123, fired: null },
  { id: 8, sym: "EURUSD", op: "below", price: 1.0815, note: null, created: 1758300000.5, fired: 1758350000.25 },
  { id: 7, sym: "XAUUSD", op: "below", price: 3300.0, note: "", created: 1758200000.0, fired: null },
];

describe("parseAlerts", () => {
  it("reads every column of real rows", () => {
    const out = parseAlerts(ROWS);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ id: 9, sym: "BTCUSD", op: "above", price: 85000, note: "breakout", created: 1758400000.123, fired: null });
    expect(out[1]?.fired).toBe(1758350000.25);
  });

  it("reads a NULL note as empty text, not as a malformed row", () => {
    expect(parseAlerts(ROWS)[1]?.note).toBe("");
  });

  it("drops malformed rows and keeps the good ones", () => {
    const out = parseAlerts([
      ROWS[0],
      { id: 1, sym: "BTCUSD", op: "sideways", price: 1, note: "", created: 1, fired: null },
      { id: 2, sym: "", op: "above", price: 1, note: "", created: 1, fired: null },
      { id: 3, sym: "BTCUSD", op: "above", price: null, note: "", created: 1, fired: null },
      { id: "4", sym: "BTCUSD", op: "above", price: 1, note: "", created: 1, fired: null },
      { id: 5, sym: "BTCUSD", op: "above", price: 1, note: "", created: 1, fired: "yesterday" },
      { id: 6, sym: "BTCUSD", op: "above", price: 1, note: "", fired: null },
      null,
      "row",
    ]);
    expect(out.map((a) => a.id)).toEqual([9]);
  });

  it("answers a non-list with no rows", () => {
    expect(parseAlerts({ ok: false })).toEqual([]);
    expect(parseAlerts(null)).toEqual([]);
  });
});

describe("suggestOp", () => {
  it("is above for a target over the price and below otherwise", () => {
    expect(suggestOp(85000, 80000)).toBe("above");
    expect(suggestOp(75000, 80000)).toBe("below");
    expect(suggestOp(80000, 80000)).toBe("below");
  });

  it("defaults to above when there is no price to compare against", () => {
    expect(suggestOp(85000, null)).toBe("above");
    expect(suggestOp(Number.NaN, 80000)).toBe("above");
  });
});

describe("card helpers", () => {
  it("parses a typed price with thousands separators and refuses junk", () => {
    expect(parsePriceInput("85,000")).toBe(85000);
    expect(parsePriceInput(" 1.0815 ")).toBe(1.0815);
    expect(parsePriceInput("")).toBeNaN();
    expect(parsePriceInput("abc")).toBeNaN();
  });

  it("measures distance as a percentage of the current price", () => {
    expect(distancePct(88000, 80000)).toBeCloseTo(10, 10);
    expect(distancePct(72000, 80000)).toBeCloseTo(-10, 10);
    expect(distancePct(1, null)).toBeNull();
  });
});

type Seen = { url: string; init: RequestInit | undefined };

function respond(status: number, body: unknown): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return { status, ok: status < 400, json: async () => body } as Response;
  });
  return seen;
}

describe("requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the rule as JSON to /svc/alerts", async () => {
    const seen = respond(200, { ok: true });
    const r = await addAlert({ sym: "BTCUSD", op: "above", price: 85000, note: "breakout" });
    expect(r).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/svc/alerts");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ sym: "BTCUSD", op: "above", price: 85000, note: "breakout" });
  });

  it("refuses a non-positive or non-finite price without asking the server", async () => {
    const seen = respond(200, { ok: true });
    expect((await addAlert({ sym: "BTCUSD", op: "above", price: 0 })).ok).toBe(false);
    expect((await addAlert({ sym: "BTCUSD", op: "above", price: Number.NaN })).ok).toBe(false);
    expect((await addAlert({ sym: "BTCUSD", op: "above", price: -5 })).ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("reports the server's 400 as a refusal", async () => {
    respond(400, { ok: false, err: "sym/op" });
    const r = await addAlert({ sym: "BTCUSD", op: "above", price: 1 });
    expect(r.ok).toBe(false);
  });

  it("DELETEs by id", async () => {
    const seen = respond(200, { ok: true });
    expect(await deleteAlert(7)).toEqual({ ok: true });
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/svc/alerts/7");
    expect(seen[0]?.init?.method).toBe("DELETE");
  });

  it("GETs /svc/alerts and parses the rows", async () => {
    const seen = respond(200, ROWS);
    const r = await loadAlerts();
    expect(new URL(seen[0]?.url ?? "").pathname).toBe("/svc/alerts");
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.value.map((a) => a.id)).toEqual([9, 8, 7]);
  });

  it("reports a failing fetch as OFFLINE, never as an empty list", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await loadAlerts();
    expect(r.state).toBe("offline");
  });

  it("reports an HTTP error as OFFLINE too", async () => {
    respond(500, null);
    expect((await loadAlerts()).state).toBe("offline");
  });
});

describe("alerts card", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const mount = () => {
    const sym = signal("BTCUSD");
    const px = signal<number | null>(80000);
    const card = createAlertsCard({ symbol: sym, price: px, fmtPx: (v) => v.toLocaleString("en-US") });
    document.body.appendChild(card.el);
    return { card, sym, px };
  };

  it("shows the offline sentence, not the empty one, when the service is down", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const { card } = mount();
    await vi.waitFor(() => expect(card.el.textContent).toContain("The alert service is not answering."));
    expect(card.el.textContent).not.toContain("No alerts.");
    card.dispose();
  });

  it("shows the empty sentence when the server holds no alerts", async () => {
    respond(200, []);
    const { card } = mount();
    await vi.waitFor(() =>
      expect(card.el.textContent).toContain("No alerts. They fire from the server — even with the terminal closed."),
    );
    card.dispose();
  });

  it("lists the current symbol first with its distance, and fired alerts apart", async () => {
    respond(200, [
      { id: 3, sym: "XAUUSD", op: "below", price: 3300, note: "", created: 1758200000, fired: null },
      { id: 2, sym: "BTCUSD", op: "above", price: 84000, note: "", created: 1758100000, fired: null },
      { id: 1, sym: "EURUSD", op: "below", price: 1.08, note: "", created: 1758000000, fired: 1758050000 },
    ]);
    const { card } = mount();
    await vi.waitFor(() => expect(card.el.querySelectorAll(".alc-row")).toHaveLength(3));
    const pending = [...card.el.querySelectorAll(".alc-groups > .alc-rows .alc-row-text")].map((n) => n.textContent);
    expect(pending[0]).toBe("BTCUSD above 84,000 · 5.0% away");
    expect(pending[1]).toBe("XAUUSD below 3,300");
    const fired = card.el.querySelector(".alc-fired");
    expect(fired?.textContent).toContain("EURUSD below");
    expect(fired?.textContent).toContain("fired");
    card.dispose();
  });

  it("refuses a bad price inline and follows the typed price for direction", async () => {
    const seen = respond(200, []);
    const { card } = mount();
    const input = card.el.querySelector<HTMLInputElement>(".alc-input");
    const select = card.el.querySelector<HTMLSelectElement>(".alc-op");
    const add = card.el.querySelector<HTMLButtonElement>(".alc-btn");
    if (!input || !select || !add) throw new Error("add row missing");

    input.value = "-3";
    input.dispatchEvent(new Event("input"));
    add.click();
    await vi.waitFor(() => expect(card.el.querySelector(".alc-msg")?.textContent).toBe("Enter a price above zero."));
    expect(seen.filter((s) => s.init?.method === "POST")).toHaveLength(0);

    input.value = "70000";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(select.value).toBe("below"));
    input.value = "90000";
    input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(select.value).toBe("above"));

    /* A manual choice sticks while they keep typing. */
    select.value = "below";
    select.dispatchEvent(new Event("change"));
    input.value = "95000";
    input.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 300));
    expect(select.value).toBe("below");

    add.click();
    await vi.waitFor(() => expect(seen.filter((s) => s.init?.method === "POST")).toHaveLength(1));
    const post = seen.find((s) => s.init?.method === "POST");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ sym: "BTCUSD", op: "below", price: 95000 });
    card.dispose();
  });
});
