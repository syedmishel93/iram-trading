import { describe, it, expect } from "vitest";
import {
  createKV,
  memoryRawStore,
  recordSlot,
  listSlot,
  type RawStore,
  type Slot,
} from "../src/store/kv";
import { PREFS_SLOT } from "../src/ui/shell/prefs";

const numberSlot = (version: number, migrations?: Record<number, (v: unknown) => unknown>): Slot<{ n: number }> => ({
  key: "thing",
  version,
  fallback: () => ({ n: 0 }),
  validate: (v) =>
    v !== null && typeof v === "object" && typeof (v as { n: unknown }).n === "number"
      ? (v as { n: number })
      : null,
  ...(migrations ? { migrations } : {}),
});

/** A store that refuses to write, the way a full or private-mode one does. */
function fullStore(inner: RawStore): RawStore {
  return {
    ...inner,
    getItem: (k) => inner.getItem(k),
    key: (i) => inner.key(i),
    get length() {
      return inner.length;
    },
    setItem() {
      const err = new Error("QuotaExceededError: storage is full");
      (err as Error & { name: string }).name = "QuotaExceededError";
      throw err;
    },
    removeItem: (k) => inner.removeItem(k),
  };
}

describe("the settings store", () => {
  it("round-trips a value with its version and write time", () => {
    const raw = memoryRawStore();
    const kv = createKV(raw, () => 5000);
    const slot = numberSlot(1);

    expect(kv.write(slot, { n: 7 }).ok).toBe(true);
    const read = kv.read(slot);
    expect(read.value).toEqual({ n: 7 });
    expect(read.outcome).toBe("hit");
    expect(kv.touchedAt("thing")).toBe(5000);
  });

  it("returns the default when nothing is stored, and says so", () => {
    const kv = createKV(memoryRawStore());
    const read = kv.read(numberSlot(1));
    expect(read.outcome).toBe("default");
    expect(read.value).toEqual({ n: 0 });
  });

  it("migrates an older value forward and persists the upgrade", () => {
    const raw = memoryRawStore({
      "iram:thing": JSON.stringify({ v: 1, at: 100, value: { n: 3 } }),
    });
    const kv = createKV(raw, () => 999);
    const slot = numberSlot(3, {
      1: (v) => ({ n: (v as { n: number }).n * 2 }),
      2: (v) => ({ n: (v as { n: number }).n + 1 }),
    });

    const read = kv.read(slot);
    expect(read.value).toEqual({ n: 7 });
    expect(read.outcome).toBe("migrated");
    // Written back, so the next boot is a plain hit rather than a re-migration.
    expect(kv.read(slot).outcome).toBe("hit");
  });

  it("REFUSES to touch a value written by a newer build", () => {
    // The case everybody forgets. Opening an old build must not overwrite next
    // month's settings with this month's defaults — that destroys data with no
    // way back.
    const raw = memoryRawStore({
      "iram:thing": JSON.stringify({ v: 9, at: 100, value: { n: 3 } }),
    });
    const kv = createKV(raw);
    const slot = numberSlot(2);

    const read = kv.read(slot);
    expect(read.outcome).toBe("refused-newer");
    expect(read.foundVersion).toBe(9);
    expect(read.note).toMatch(/newer version/);

    const write = kv.write(slot, { n: 1 });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.reason).toBe("newer-on-disk");
    // And the bytes are untouched.
    expect(JSON.parse(raw.getItem("iram:thing")!).v).toBe(9);
  });

  it("quarantines an unparseable value instead of deleting it", () => {
    const raw = memoryRawStore({ "iram:thing": "{not json" });
    const kv = createKV(raw, () => 42);

    const read = kv.read(numberSlot(1));
    expect(read.outcome).toBe("quarantined");
    expect(read.value).toEqual({ n: 0 });

    const held = kv.quarantine();
    expect(held).toHaveLength(1);
    expect(held[0]!.raw).toContain("{not json");
  });

  it("adopts a bare pre-envelope value as v1 rather than discarding it", () => {
    // This is the upgrade path from the old raw localStorage keys. Treating a
    // legacy value as corrupt would silently wipe the user's existing setup on
    // first launch of the new build.
    const raw = memoryRawStore({ "iram:thing": JSON.stringify({ n: 11 }) });
    const kv = createKV(raw);
    expect(kv.read(numberSlot(1)).value).toEqual({ n: 11 });
  });

  it("falls back to the default when the stored shape is wrong", () => {
    const raw = memoryRawStore({
      "iram:thing": JSON.stringify({ v: 1, at: 0, value: { n: "not a number" } }),
    });
    const read = createKV(raw).read(numberSlot(1));
    expect(read.outcome).toBe("default");
    expect(read.note).toMatch(/did not match the expected shape/);
  });

  it("falls back when a migration step is missing rather than guessing", () => {
    const raw = memoryRawStore({
      "iram:thing": JSON.stringify({ v: 1, at: 0, value: { n: 3 } }),
    });
    const read = createKV(raw).read(numberSlot(3, { 1: (v) => v }));
    expect(read.outcome).toBe("default");
    expect(read.note).toMatch(/no migration to v3/);
  });

  it("survives a migration that throws", () => {
    const raw = memoryRawStore({
      "iram:thing": JSON.stringify({ v: 1, at: 0, value: { n: 3 } }),
    });
    const read = createKV(raw).read(
      numberSlot(2, {
        1: () => {
          throw new Error("bad shape");
        },
      }),
    );
    expect(read.outcome).toBe("default");
    expect(read.note).toMatch(/bad shape/);
  });

  it("reports a full store rather than throwing mid-render", () => {
    const kv = createKV(fullStore(memoryRawStore()));
    const res = kv.write(numberSlot(1), { n: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("quota");
      expect(res.error).toMatch(/storage is full/);
    }
  });

  it("notifies subscribers on write and on removal", () => {
    const kv = createKV(memoryRawStore());
    const seen: string[] = [];
    const off = kv.subscribe((k) => seen.push(k));
    kv.write(numberSlot(1), { n: 1 });
    kv.remove("thing");
    off();
    kv.write(numberSlot(1), { n: 2 });
    expect(seen).toEqual(["thing", "thing"]);
  });

  it("keeps one broken subscriber from breaking the others", () => {
    const kv = createKV(memoryRawStore());
    let reached = false;
    kv.subscribe(() => {
      throw new Error("subscriber blew up");
    });
    kv.subscribe(() => {
      reached = true;
    });
    expect(kv.write(numberSlot(1), { n: 1 }).ok).toBe(true);
    expect(reached).toBe(true);
  });

  it("lists only its own namespaced keys", () => {
    const raw = memoryRawStore({
      "iram:a": JSON.stringify({ v: 1, at: 0, value: 1 }),
      "iram:b": JSON.stringify({ v: 1, at: 0, value: 2 }),
      "someone-elses-key": "leave me alone",
    });
    expect(createKV(raw).keys()).toEqual(["a", "b"]);
  });

  it("measures its own footprint and names the biggest keys", () => {
    const kv = createKV(memoryRawStore());
    kv.write(recordSlot("small"), { a: 1 });
    kv.write(recordSlot("big"), { a: "x".repeat(2000) });
    const stats = kv.stats();
    expect(stats.keys).toBe(2);
    expect(stats.bytes).toBeGreaterThan(4000);
    expect(stats.largest[0]!.key).toBe("big");
  });

  it("will not let an envelope go backwards in time", () => {
    // Without this a slow remote push lands after a local edit and silently
    // reverts it — the single worst sync bug there is, because it looks like
    // nothing happened.
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot("x"), { a: 1 });
    const res = kv.putEnvelope("x", { v: 1, at: 500, value: { a: 2 } });
    expect(res.ok).toBe(false);
    expect(kv.get(recordSlot("x"))).toEqual({ a: 1 });
  });
});

describe("list slots", () => {
  const isThing = (v: unknown): v is { id: string } =>
    v !== null && typeof v === "object" && typeof (v as { id: unknown }).id === "string";

  it("drops one bad row instead of the whole book", () => {
    // A half-written entry must not take the user's other alerts with it.
    const raw = memoryRawStore({
      "iram:book": JSON.stringify({
        v: 1,
        at: 0,
        value: [{ id: "a" }, { broken: true }, { id: "b" }],
      }),
    });
    const kv = createKV(raw);
    expect(kv.get(listSlot("book", 1, isThing))).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("returns the empty list when the stored value is not a list at all", () => {
    const raw = memoryRawStore({
      "iram:book": JSON.stringify({ v: 1, at: 0, value: { not: "a list" } }),
    });
    expect(createKV(raw).get(listSlot("book", 1, isThing))).toEqual([]);
  });
});

/**
 * The shell preferences migration that turned the news bar on.
 *
 * WHY THIS NEEDS A TEST RATHER THAN A DEFAULT CHANGE.
 * `newsOn` reads `prefs["newsBar"] !== false`, which looks like it would pick up
 * anyone who never chose. It does not: the preferences snapshot is rewritten on
 * every save with the current value of every field, so every existing install
 * already holds an explicit `newsBar: false` written by the OLD default. A
 * default change alone reaches nobody, and the failure is silent — the code
 * looks correct and nothing happens.
 */
describe("shell.prefs v1 -> v2 — the news bar default", () => {
  const migrate = (v: unknown): unknown =>
    (PREFS_SLOT.migrations as Record<number, (x: unknown) => unknown>)[1]!(v);

  const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

  it("is registered at the version the slot claims", () => {
    expect(PREFS_SLOT.version).toBe(2);
    expect(PREFS_SLOT.migrations[1]).toBeTypeOf("function");
  });

  it("drops a stored false, so the new default can be seen", () => {
    const out = asRecord(migrate({ newsBar: false, theme: "dark" }));
    expect("newsBar" in out).toBe(false);
    // And it is the ONLY thing touched.
    expect(out["theme"]).toBe("dark");
  });

  it("leaves a stored true alone — that could only have been deliberate", () => {
    expect(asRecord(migrate({ newsBar: true }))["newsBar"]).toBe(true);
  });

  it("does not invent the key when it was never there", () => {
    const out = asRecord(migrate({ theme: "dark" }));
    expect("newsBar" in out).toBe(false);
  });

  it("does not mutate the value it was given", () => {
    const before = { newsBar: false, density: "cosy" };
    migrate(before);
    expect(before.newsBar).toBe(false);
  });

  it("survives a value that is not an object", () => {
    for (const junk of [null, 42, "x", [1, 2]]) {
      expect(() => migrate(junk)).not.toThrow();
    }
  });

  /** The end-to-end proof: read a v1 record through the real store. */
  it("upgrades a v1 record on read, and the result reads as ON", () => {
    const raw = memoryRawStore();
    // A v1 record exactly as the old build wrote it.
    raw.setItem("iram:shell.prefs", JSON.stringify({ v: 1, at: 1, value: { newsBar: false, theme: "dark" } }));

    const kv = createKV(raw);
    const report = kv.read(PREFS_SLOT);
    expect(report.outcome).toBe("migrated");
    expect(report.foundVersion).toBe(1);

    // This is the expression `ui/shell.ts` actually evaluates.
    expect(report.value["newsBar"] !== false).toBe(true);
    expect(report.value["theme"]).toBe("dark");
  });

  it("keeps a deliberate OFF off, once it is written under v2", () => {
    const raw = memoryRawStore();
    raw.setItem("iram:shell.prefs", JSON.stringify({ v: 2, at: 1, value: { newsBar: false } }));
    const kv = createKV(raw);
    const report = kv.read(PREFS_SLOT);
    expect(report.outcome).toBe("hit");
    expect(report.value["newsBar"] !== false).toBe(false);
  });
});
