import { describe, expect, it } from "vitest";
import { memoryRawStore, type RawStore } from "../src/store/kv";
import { BEACON_KEY, clearBeacon, probeDurability } from "../src/store/durability";

/** A store whose write silently does nothing — the `file://` failure mode. */
function amnesiacStore(): RawStore {
  const inner = memoryRawStore();
  return {
    getItem: (k) => inner.getItem(k),
    setItem: () => {
      /* accepts the write, keeps nothing. Exactly what a partitioned or
         cleared-on-exit store looks like from inside the page. */
    },
    removeItem: (k) => inner.removeItem(k),
  } as RawStore;
}

/** A store that throws on write, like a locked-down profile. */
function throwingStore(): RawStore {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error("access denied");
    },
    removeItem: () => {
      throw new Error("access denied");
    },
  } as RawStore;
}

describe("durability probe", () => {
  it("says UNKNOWN on a first run rather than crying wolf", () => {
    const raw = memoryRawStore();
    const r = probeDurability(raw, { protocol: "https:", now: () => 1_000 });
    expect(r.state).toBe("unknown");
    expect(r.remedy).toBeNull();
  });

  it("leaves a beacon so the NEXT boot can answer", () => {
    const raw = memoryRawStore();
    probeDurability(raw, { protocol: "https:", now: () => 1_000 });
    expect(raw.getItem(BEACON_KEY)).toBe("1000");
  });

  it("reports DURABLE once a previous beacon comes back", () => {
    const raw = memoryRawStore();
    probeDurability(raw, { protocol: "https:", now: () => 1_000 });
    const second = probeDurability(raw, { protocol: "https:", now: () => 2_000 });
    expect(second.state).toBe("durable");
    expect(second.remedy).toBeNull();
    /* and it refreshes the beacon, so the check keeps working */
    expect(raw.getItem(BEACON_KEY)).toBe("2000");
  });

  it("reports AT-RISK on file:// when the beacon does not come back", () => {
    const raw = amnesiacStore();
    /* Two boots. The first leaves a beacon that is thrown away; the second
       finds nothing. A vanished beacon and a first run are genuinely
       indistinguishable from one read, so this must not claim proof — but on
       file:// it must not stay quiet either, because that is the origin where
       settings are known to evaporate. */
    probeDurability(raw, { protocol: "file:", now: () => 1_000 });
    const second = probeDurability(raw, { protocol: "file:", now: () => 2_000 });
    expect(second.state).toBe("at-risk");
    expect(second.remedy).toContain("localhost:8000");
  });

  it("stays quiet on a first run over http, where a missing beacon is normal", () => {
    const raw = amnesiacStore();
    probeDurability(raw, { protocol: "https:", now: () => 1_000 });
    const second = probeDurability(raw, { protocol: "https:", now: () => 2_000 });
    expect(second.state).toBe("unknown");
    expect(second.remedy).toBeNull();
  });

  it("a working file:// store still reports durable — origin alone is not a verdict", () => {
    const raw = memoryRawStore();
    probeDurability(raw, { protocol: "file:", now: () => 1_000 });
    const second = probeDurability(raw, { protocol: "file:", now: () => 2_000 });
    expect(second.state).toBe("durable");
    expect(second.remedy).toBeNull();
  });

  it("reports EPHEMERAL immediately when the store says it cannot persist", () => {
    const raw = memoryRawStore();
    const r = probeDurability(raw, { protocol: "file:", storeCanPersist: false });
    expect(r.state).toBe("ephemeral");
    expect(r.note).toContain("not being saved");
  });

  it("reports EPHEMERAL when writing throws", () => {
    const r = probeDurability(throwingStore(), { protocol: "https:" });
    expect(r.state).toBe("ephemeral");
  });

  it("gives the file:// remedy for a page opened from a folder", () => {
    const r = probeDurability(memoryRawStore(), { protocol: "file:", storeCanPersist: false });
    expect(r.origin).toBe("file");
    expect(r.remedy).toContain("localhost:8000");
  });

  it("gives the private-window remedy on the web", () => {
    const r = probeDurability(memoryRawStore(), { protocol: "https:", storeCanPersist: false });
    expect(r.origin).toBe("web");
    expect(r.remedy).toContain("private window");
  });

  it("never mentions the storage API to the user", () => {
    for (const protocol of ["file:", "https:"]) {
      const r = probeDurability(memoryRawStore(), { protocol, storeCanPersist: false });
      expect(`${r.note} ${r.remedy ?? ""}`.toLowerCase()).not.toContain("localstorage");
    }
  });

  it("names the symbol among the things that will reset — that is the reported symptom", () => {
    const r = probeDurability(memoryRawStore(), { protocol: "file:", storeCanPersist: false });
    expect(r.note).toContain("symbol");
  });

  it("clearBeacon removes the evidence and survives an unwritable store", () => {
    const raw = memoryRawStore();
    probeDurability(raw, { protocol: "https:", now: () => 1_000 });
    clearBeacon(raw);
    expect(raw.getItem(BEACON_KEY)).toBeNull();
    expect(() => clearBeacon(throwingStore())).not.toThrow();
  });
});
