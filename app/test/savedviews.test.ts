import { describe, expect, it } from "vitest";
import { createKV, memoryRawStore } from "../src/store/kv";
import {
  compactFilters,
  configMatches,
  createViewStore,
  isEmptyConfig,
  type SavedView,
} from "../src/ui/savedviews";

const kv = () => createKV(memoryRawStore());
const KEY = "screener.views";
let clock = 1000;
const now = () => (clock += 1);

describe("compactFilters", () => {
  it("drops empty and whitespace-only expressions", () => {
    expect(compactFilters({ a: ">70", b: "", c: "   " })).toEqual({ a: ">70" });
  });

  it("trims what it keeps", () => {
    expect(compactFilters({ a: "  >70 " })).toEqual({ a: ">70" });
  });
});

describe("isEmptyConfig", () => {
  it("is true with neither a sort nor a real filter", () => {
    expect(isEmptyConfig({ sort: [], filters: { a: "  " } })).toBe(true);
  });

  it("is false once either exists", () => {
    expect(isEmptyConfig({ sort: [{ column: "score", dir: "desc" }], filters: {} })).toBe(false);
    expect(isEmptyConfig({ sort: [], filters: { a: ">1" } })).toBe(false);
  });
});

describe("view store", () => {
  it("saves and reads back a view", () => {
    const store = createViewStore(kv(), KEY, now);
    const id = store.save("Majors", {
      sort: [{ column: "score", dir: "desc" }],
      filters: { symbol: "usd", score: ">70" },
    });
    const v = store.get(id) as SavedView;
    expect(v.name).toBe("Majors");
    expect(v.sort).toEqual([{ column: "score", dir: "desc" }]);
    expect(v.filters).toEqual({ symbol: "usd", score: ">70" });
  });

  it("survives a reload", () => {
    const store1 = createViewStore(kv(), KEY, now);
    const raw = memoryRawStore();
    const shared = createKV(raw);
    const a = createViewStore(shared, KEY, now);
    a.save("Majors", { sort: [{ column: "score", dir: "desc" }], filters: {} });
    const b = createViewStore(shared, KEY, now);
    expect(b.views().map((v) => v.name)).toEqual(["Majors"]);
    expect(store1.views()).toHaveLength(0);
  });

  it("re-saving the same name REPLACES rather than duplicating", () => {
    const store = createViewStore(kv(), KEY, now);
    const first = store.save("Majors", { sort: [], filters: { score: ">70" } });
    const second = store.save("majors ", { sort: [], filters: { score: ">80" } });
    expect(second).toBe(first);
    expect(store.views()).toHaveLength(1);
    expect(store.get(first)?.filters).toEqual({ score: ">80" });
  });

  it("keeps a re-saved view in its original position", () => {
    /* A view that jumped to the end whenever you adjusted it would make the
       tab strip unlearnable. */
    const store = createViewStore(kv(), KEY, now);
    store.save("A", { sort: [], filters: { a: ">1" } });
    store.save("B", { sort: [], filters: { b: ">1" } });
    store.save("C", { sort: [], filters: { c: ">1" } });
    store.save("A", { sort: [], filters: { a: ">2" } });
    expect(store.views().map((v) => v.name)).toEqual(["A", "B", "C"]);
  });

  it("normalises the name it stores", () => {
    const store = createViewStore(kv(), KEY, now);
    const id = store.save("  Big   movers  ", { sort: [], filters: { a: ">1" } });
    expect(store.get(id)?.name).toBe("Big movers");
  });

  it("strips empty filters on save", () => {
    const store = createViewStore(kv(), KEY, now);
    const id = store.save("V", { sort: [], filters: { a: ">1", b: "" } });
    expect(store.get(id)?.filters).toEqual({ a: ">1" });
  });

  it("removes and renames", () => {
    const store = createViewStore(kv(), KEY, now);
    const id = store.save("V", { sort: [], filters: { a: ">1" } });
    store.rename(id, "W");
    expect(store.get(id)?.name).toBe("W");
    store.rename(id, "   ");
    expect(store.get(id)?.name).toBe("W"); // a blank rename is refused
    store.remove(id);
    expect(store.views()).toHaveLength(0);
  });

  it("discards a malformed sort key rather than claiming an order it lacks", () => {
    /* `applySort` ignores a key naming a missing column, so a view carrying one
       would promise an order it does not deliver. */
    const raw = memoryRawStore({
      "iram:screener.views": JSON.stringify({
        v: 1,
        at: 1,
        value: [
          {
            id: "vw_x",
            name: "Hand edited",
            sort: [{ column: "score", dir: "desc" }, { nope: true }, "garbage"],
            filters: { score: ">70", bad: 5 },
          },
        ],
      }),
    });
    const store = createViewStore(createKV(raw), KEY, now);
    const v = store.views()[0] as SavedView;
    expect(v.sort).toEqual([{ column: "score", dir: "desc" }]);
    expect(v.filters).toEqual({ score: ">70" });
  });

  it("ignores entries with no id or name", () => {
    const raw = memoryRawStore({
      "iram:screener.views": JSON.stringify({
        v: 1,
        at: 1,
        value: [{ name: "no id" }, { id: "x" }, null, 5],
      }),
    });
    expect(createViewStore(createKV(raw), KEY, now).views()).toHaveLength(0);
  });
});

describe("configMatches", () => {
  const view: SavedView = {
    id: "v",
    name: "V",
    sort: [{ column: "score", dir: "desc" }],
    filters: { score: ">70" },
  };

  it("is true for the same question", () => {
    expect(configMatches(view, { sort: [{ column: "score", dir: "desc" }], filters: { score: ">70" } })).toBe(true);
  });

  it("ignores empty filter cells on the live side", () => {
    expect(
      configMatches(view, {
        sort: [{ column: "score", dir: "desc" }],
        filters: { score: ">70", symbol: "" },
      }),
    ).toBe(true);
  });

  it("is false when the direction changed", () => {
    expect(configMatches(view, { sort: [{ column: "score", dir: "asc" }], filters: { score: ">70" } })).toBe(false);
  });

  it("is false when a filter changed or was added", () => {
    expect(configMatches(view, { sort: view.sort, filters: { score: ">80" } })).toBe(false);
    expect(configMatches(view, { sort: view.sort, filters: { score: ">70", symbol: "usd" } })).toBe(false);
  });

  it("treats sort ORDER as significant", () => {
    /* "score then spread" is a different question from "spread then score". */
    const two: SavedView = {
      ...view,
      sort: [
        { column: "score", dir: "desc" },
        { column: "spread", dir: "asc" },
      ],
    };
    expect(
      configMatches(two, {
        sort: [
          { column: "spread", dir: "asc" },
          { column: "score", dir: "desc" },
        ],
        filters: view.filters,
      }),
    ).toBe(false);
  });
});
