import { describe, it, expect } from "vitest";
import {
  exportVault,
  importVault,
  inspectVault,
  serialiseVault,
  encodeF64,
  decodeF64,
  checksum,
  canonical,
  looksSecret,
  fromVaultSeries,
  vaultFilename,
  VAULT_MAGIC,
} from "../src/store/vault";
import { createKV, memoryRawStore, recordSlot } from "../src/store/kv";
import { createArchive, memoryBackend } from "../src/store/barstore";
import type { BarView } from "../src/chart/series";

const NOW = Date.parse("2026-09-01T12:34:00Z");

const hourly = (n: number, endAt = NOW): BarView[] =>
  Array.from({ length: n }, (_, i) => {
    const t = endAt - (n - 1 - i) * 3_600_000;
    return { t, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 + i };
  });

describe("base64 columns", () => {
  it("round-trips every double bit-exactly", () => {
    // JSON numbers would be arguable; a raw buffer is not. These values are
    // chosen to break a naive encoder: denormals, negatives, huge, and the
    // fractional prices that actually appear in a book.
    const values = [0, -0.0001, 1e-300, 1e300, 43_251.23456789, -99.5, Number.MAX_SAFE_INTEGER];
    const decoded = decodeF64(encodeF64(new Float64Array(values)));
    expect([...decoded]).toEqual(values);
  });

  it("round-trips lengths that are not multiples of three bytes", () => {
    // Checking only the LENGTH is what let the dropped-final-group bug through
    // the first time: the array was the right size with a zeroed last element.
    // Compare the values.
    for (const n of [1, 2, 3, 4, 5, 7, 11]) {
      const values = Array.from({ length: n }, (_, i) => (i + 1) * 1.5);
      const arr = new Float64Array(values);
      expect([...decodeF64(encodeF64(arr))]).toEqual(values);
    }
  });

  it("truncates to whole doubles rather than inventing a shifted price", () => {
    // A truncated column must produce FEWER bars, never a bar whose close came
    // from a different index than its open.
    const full = encodeF64(new Float64Array([1, 2, 3, 4]));
    const cut = full.slice(0, full.length - 6);
    const decoded = decodeF64(cut);
    expect(decoded.length).toBeLessThan(4);
    expect([...decoded]).toEqual([1, 2, 3].slice(0, decoded.length));
  });

  it("handles an empty column", () => {
    expect(decodeF64(encodeF64(new Float64Array(0))).length).toBe(0);
  });
});

describe("the checksum", () => {
  it("changes when the content changes", () => {
    expect(checksum("abc")).not.toBe(checksum("abd"));
  });

  it("is stable regardless of key order", () => {
    // Otherwise the same state exported twice gets two different checksums and
    // every re-export looks like corruption.
    expect(canonical({ a: 1, b: { d: 2, c: 3 } })).toBe(canonical({ b: { c: 3, d: 2 }, a: 1 }));
  });

  it("is eight hex characters", () => {
    expect(checksum("anything")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("redaction", () => {
  it("catches every plausible credential key", () => {
    for (const key of [
      "supabase.anonKey",
      "sync.credential",
      "broker_password",
      "mt5.login",
      "api_key",
      "session.token",
      "wallet.mnemonic",
      "authHeader",
    ]) {
      expect(looksSecret(key)).toBe(true);
    }
  });

  it("leaves ordinary settings alone", () => {
    for (const key of ["shell.prefs", "alerts.book", "layout.dock", "watchlist"]) {
      expect(looksSecret(key)).toBe(false);
    }
  });
});

describe("exporting", () => {
  it("carries settings and names what it withheld", async () => {
    // A vault file gets emailed, dropped in a shared folder and attached to an
    // issue. It must be safe to do all three, and it must SAY what is missing
    // rather than silently omitting it.
    const kv = createKV(memoryRawStore(), () => NOW);
    kv.write(recordSlot("shell.prefs"), { theme: "iram" });
    kv.write(recordSlot("sync.credential"), { anonKey: "super-secret" });

    const file = await exportVault(kv, null, { now: () => NOW });
    expect(Object.keys(file.settings)).toEqual(["shell.prefs"]);
    expect(file.redacted).toEqual(["sync.credential"]);
    expect(file.note).toMatch(/withheld as possible credentials/);
    expect(serialiseVault(file)).not.toContain("super-secret");
  });

  it("says plainly that the checksum is not a signature", async () => {
    const kv = createKV(memoryRawStore());
    const file = await exportVault(kv, null, { now: () => NOW });
    expect(file.note).toMatch(/corruption, not tampering/);
  });

  it("leaves history out unless asked", async () => {
    const kv = createKV(memoryRawStore());
    const archive = createArchive(memoryBackend());
    await archive.write({ source: "binance", symbol: "BTC", timeframe: "1h" }, hourly(50), {
      source: "binance",
      quality: "live",
      fetchedAt: NOW,
    });

    const without = await exportVault(kv, archive, { now: () => NOW });
    expect(without.series).toHaveLength(0);

    const withBars = await exportVault(kv, archive, { includeArchive: true, now: () => NOW });
    expect(withBars.series).toHaveLength(1);
    expect(withBars.series[0]!.bars).toBe(50);
  });
});

describe("inspecting before importing", () => {
  it("refuses a file that is not a vault", () => {
    expect(inspectVault("not json").error).toMatch(/not valid JSON/);
    expect(inspectVault(JSON.stringify({ hello: 1 })).error).toMatch(/missing magic header/);
  });

  it("refuses a vault written by a newer format", () => {
    const r = inspectVault(JSON.stringify({ magic: VAULT_MAGIC, version: 99 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/newer than this build understands/);
  });

  it("warns on a checksum mismatch but still allows the import", async () => {
    // The file may be truncated. Refusing outright would strand a partial
    // backup that still contains most of the user's work.
    const kv = createKV(memoryRawStore(), () => NOW);
    kv.write(recordSlot("a"), { x: 1 });
    const file = await exportVault(kv, null, { now: () => NOW });
    const tampered = serialiseVault({ ...file, createdAt: file.createdAt + 1 });

    const r = inspectVault(tampered);
    expect(r.ok).toBe(true);
    expect(r.checksumOk).toBe(false);
    expect(r.warnings[0]).toMatch(/truncated or was edited/);
  });

  it("lists what is inside without touching anything", async () => {
    const kv = createKV(memoryRawStore(), () => NOW);
    kv.write(recordSlot("alerts.book"), { a: 1 });
    const archive = createArchive(memoryBackend());
    await archive.write({ source: "binance", symbol: "BTC", timeframe: "1h" }, hourly(20), {
      source: "binance",
      quality: "live",
      fetchedAt: NOW,
    });

    const text = serialiseVault(
      await exportVault(kv, archive, { includeArchive: true, now: () => NOW }),
    );
    const r = inspectVault(text);
    expect(r.settingKeys).toEqual(["alerts.book"]);
    expect(r.totalBars).toBe(20);
    expect(r.checksumOk).toBe(true);
  });
});

describe("importing", () => {
  it("round-trips settings and bars exactly", async () => {
    const source = createKV(memoryRawStore(), () => NOW);
    source.write(recordSlot("shell.prefs"), { theme: "binance", symbol: "ETHUSDT" });
    const sourceArchive = createArchive(memoryBackend());
    const key = { source: "binance", symbol: "BTCUSDT", timeframe: "1h" };
    await sourceArchive.write(key, hourly(120), {
      source: "binance",
      quality: "live",
      fetchedAt: NOW,
    });

    const text = serialiseVault(
      await exportVault(source, sourceArchive, { includeArchive: true, now: () => NOW }),
    );

    const target = createKV(memoryRawStore(), () => NOW + 1);
    const targetArchive = createArchive(memoryBackend());
    const result = await importVault(text, target, targetArchive);

    expect(result.settingsWritten).toBe(1);
    expect(result.barsWritten).toBe(120);
    expect(target.get(recordSlot("shell.prefs"))).toEqual({
      theme: "binance",
      symbol: "ETHUSDT",
    });

    const read = await targetArchive.read(key, { from: 0, to: NOW }, 3_600_000);
    expect(read.bars).toHaveLength(120);
    expect(read.bars[0]).toEqual(hourly(120)[0]);
  });

  it("merge mode keeps the newer local copy", async () => {
    // An import that silently discarded work you did after the export is not
    // recoverable, so merge is the default.
    const source = createKV(memoryRawStore(), () => 1000);
    source.write(recordSlot("prefs"), { theme: "old" });
    const text = serialiseVault(await exportVault(source, null, { now: () => 1000 }));

    const target = createKV(memoryRawStore(), () => 9000);
    target.write(recordSlot("prefs"), { theme: "new" });

    const result = await importVault(text, target, null);
    expect(target.get(recordSlot("prefs"))).toEqual({ theme: "new" });
    expect(result.settingsSkipped[0]!.why).toBe("local copy is newer");
  });

  it("replace mode takes the file's copy", async () => {
    const source = createKV(memoryRawStore(), () => 1000);
    source.write(recordSlot("prefs"), { theme: "old" });
    const text = serialiseVault(await exportVault(source, null, { now: () => 1000 }));

    const target = createKV(memoryRawStore(), () => 9000);
    target.write(recordSlot("prefs"), { theme: "new" });

    await importVault(text, target, null, { mode: "replace" });
    expect(target.get(recordSlot("prefs"))).toEqual({ theme: "old" });
  });

  it("refuses a credential-shaped key even from a hand-edited file", async () => {
    // Export redacts, but a vault file is untrusted input; the invariant must
    // hold in BOTH directions.
    const text = JSON.stringify({
      magic: VAULT_MAGIC,
      version: 1,
      createdAt: NOW,
      app: "x",
      checksum: "00000000",
      settings: { "broker.password": { v: 1, at: NOW, value: "hunter2" } },
      series: [],
      redacted: [],
      note: "",
    });
    const kv = createKV(memoryRawStore());
    const result = await importVault(text, kv, null);
    expect(result.settingsWritten).toBe(0);
    expect(result.settingsSkipped[0]!.why).toBe("looks like a credential");
    expect(kv.keys()).toEqual([]);
  });

  it("throws on a file it could not read at all", async () => {
    await expect(importVault("garbage", createKV(memoryRawStore()), null)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it("builds only complete bars from mismatched columns", () => {
    const bars = fromVaultSeries({
      key: "k",
      symbol: "S",
      timeframe: "1h",
      source: "x",
      quality: "live",
      bars: 3,
      from: 0,
      to: 2,
      t: encodeF64(new Float64Array([1, 2, 3])),
      o: encodeF64(new Float64Array([1, 2, 3])),
      h: encodeF64(new Float64Array([1, 2, 3])),
      l: encodeF64(new Float64Array([1, 2, 3])),
      c: encodeF64(new Float64Array([1, 2])), // short
      v: encodeF64(new Float64Array([1, 2, 3])),
    });
    expect(bars).toHaveLength(2);
  });
});

describe("the filename", () => {
  it("sorts chronologically in a folder", () => {
    const a = vaultFilename(Date.parse("2026-01-02T03:04:00Z"));
    const b = vaultFilename(Date.parse("2026-11-02T03:04:00Z"));
    expect(a).toBe("iram-vault-20260102-0304.json");
    expect([b, a].sort()).toEqual([a, b]);
  });
});
