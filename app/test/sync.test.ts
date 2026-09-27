import { describe, it, expect } from "vitest";
import {
  createSync,
  syncable,
  newDeviceId,
  isSyncRecord,
  TOMBSTONE_TTL_MS,
  SYNC_CREDENTIAL_KEY,
  type SyncAdapter,
  type SyncRecord,
} from "../src/store/sync";
import {
  supabaseAdapter,
  validateSupabaseConfig,
  newSpaceId,
  restAdapter,
} from "../src/store/supabase";
import { createKV, memoryRawStore, recordSlot } from "../src/store/kv";

/** An in-memory sync target that behaves like the real one. */
function fakeAdapter(seed: SyncRecord[] = []): SyncAdapter & { rows: SyncRecord[] } {
  const rows: SyncRecord[] = [...seed];
  return {
    rows,
    id: "fake",
    label: "Fake",
    describe: () => "memory://fake",
    ping: async () => ({ ok: true, note: "fine" }),
    pull: async (since) => rows.filter((r) => r.at >= since),
    push: async (records) => {
      for (const r of records) {
        // Upsert by key, the way PostgREST merge-duplicates does.
        const i = rows.findIndex((x) => x.key === r.key);
        if (i >= 0) rows[i] = r;
        else rows.push(r);
      }
    },
  };
}

const seq = (): (() => number) => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
  let i = 0;
  return () => (values[i++ % values.length] as number) / 10;
};

describe("what may sync", () => {
  it("refuses to sync the credential that reaches the target", () => {
    expect(syncable(SYNC_CREDENTIAL_KEY)).toBe(false);
    expect(syncable("sync.state")).toBe(false);
  });

  it("refuses cache and archive namespaces", () => {
    expect(syncable("cache.klines")).toBe(false);
    expect(syncable("archive.meta")).toBe(false);
  });

  it("allows ordinary settings", () => {
    expect(syncable("alerts.book")).toBe(true);
    expect(syncable("shell.prefs")).toBe(true);
  });
});

describe("the device id", () => {
  it("is random rather than derived from anything about the machine", () => {
    // A fingerprint-derived id would be a tracking vector in a file people
    // share. It only has to break ties and name the other machine.
    const a = newDeviceId(seq());
    expect(a).toMatch(/^dev_[a-z0-9]{10}$/);
  });

  it("is created once and then reused", () => {
    const kv = createKV(memoryRawStore());
    const first = createSync(kv).device();
    const second = createSync(kv).device();
    expect(second).toBe(first);
  });
});

describe("a sync round trip", () => {
  it("pushes local settings that the target has never seen", async () => {
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot("alerts.book"), { a: 1 });
    const engine = createSync(kv, () => 1000);
    const adapter = fakeAdapter();

    const out = await engine.run(adapter);
    expect(out.ok).toBe(true);
    expect(out.pushed).toBe(1);
    expect(adapter.rows.find((r) => r.key === "alerts.book")?.value).toEqual({ a: 1 });
  });

  it("does not push the same value twice", async () => {
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot("alerts.book"), { a: 1 });
    const engine = createSync(kv, () => 1000);
    const adapter = fakeAdapter();

    await engine.run(adapter);
    const second = await engine.run(adapter);
    expect(second.pushed).toBe(0);
  });

  it("applies a remote record the local machine has never seen", async () => {
    const kv = createKV(memoryRawStore(), () => 1000);
    const engine = createSync(kv, () => 5000);
    const adapter = fakeAdapter([
      { key: "watchlist", value: ["BTCUSDT"], v: 1, at: 2000, deletedAt: null, device: "dev_other" },
    ]);

    const out = await engine.run(adapter);
    expect(out.applied).toBe(1);
    // Read the raw envelope: `recordSlot` validates an OBJECT, and this value
    // is an array, so the slot would correctly fall back to its default.
    expect(kv.rawEnvelope("watchlist")?.value).toEqual(["BTCUSDT"]);
    expect(out.conflicts).toHaveLength(0);
  });

  it("lets the newer write win and REPORTS the loss", async () => {
    // A sync that silently discards an hour of work is how people stop
    // trusting sync. The overwrite is allowed; hiding it is not.
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot("prefs"), { theme: "local" }); // at 1000
    const engine = createSync(kv, () => 9000);
    const adapter = fakeAdapter([
      { key: "prefs", value: { theme: "remote" }, v: 1, at: 5000, deletedAt: null, device: "dev_b" },
    ]);

    const out = await engine.run(adapter);
    expect(kv.get(recordSlot("prefs"))).toEqual({ theme: "remote" });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]!.winner).toBe("remote");
    expect(out.conflicts[0]!.remoteDevice).toBe("dev_b");
    expect(out.note).toMatch(/the losing edit is gone/);
  });

  it("keeps the local copy and reports it when local is newer", async () => {
    const kv = createKV(memoryRawStore(), () => 9000);
    kv.write(recordSlot("prefs"), { theme: "local" }); // at 9000
    const engine = createSync(kv, () => 9000);
    const adapter = fakeAdapter([
      { key: "prefs", value: { theme: "remote" }, v: 1, at: 5000, deletedAt: null, device: "dev_b" },
    ]);

    const out = await engine.run(adapter);
    expect(kv.get(recordSlot("prefs"))).toEqual({ theme: "local" });
    expect(out.conflicts[0]!.winner).toBe("local");
    expect(adapter.rows.find((r) => r.key === "prefs")?.value).toEqual({ theme: "local" });
  });

  it("breaks an exact tie deterministically by device id", async () => {
    // Otherwise the outcome depends on who pushed first, and two machines can
    // disagree forever.
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot("prefs"), { theme: "local" }, 5000);
    const engine = createSync(kv, () => 9000, seq());
    const adapter = fakeAdapter([
      {
        key: "prefs",
        value: { theme: "remote" },
        v: 1,
        at: 5000,
        deletedAt: null,
        // "zzz" sorts above any generated dev_ id, so remote must win.
        device: "zzz_highest",
      },
    ]);

    await engine.run(adapter);
    expect(kv.get(recordSlot("prefs"))).toEqual({ theme: "remote" });
  });

  it("propagates a deletion instead of letting it come back", async () => {
    // A deleted alert that is merely absent from the push returns on the next
    // pull from any machine that still has it.
    const kv = createKV(memoryRawStore(), () => 1000);
    const engine = createSync(kv, () => 2000);
    const adapter = fakeAdapter();

    engine.markDeleted("alerts.book", 2000);
    const out = await engine.run(adapter);

    expect(out.pushed).toBe(1);
    const row = adapter.rows[0]!;
    expect(row.deletedAt).toBe(2000);
    expect(row.value).toBeNull();
  });

  it("applies a remote tombstone", async () => {
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot("alerts.book"), { a: 1 });
    const engine = createSync(kv, () => 9000);
    const adapter = fakeAdapter([
      { key: "alerts.book", value: null, v: 0, at: 5000, deletedAt: 5000, device: "dev_b" },
    ]);

    await engine.run(adapter);
    expect(kv.keys()).not.toContain("alerts.book");
  });

  it("does not delete a local record that is newer than the tombstone", async () => {
    const kv = createKV(memoryRawStore(), () => 9000);
    kv.write(recordSlot("alerts.book"), { a: 1 }); // at 9000
    const engine = createSync(kv, () => 9000);
    const adapter = fakeAdapter([
      { key: "alerts.book", value: null, v: 0, at: 5000, deletedAt: 5000, device: "dev_b" },
    ]);

    await engine.run(adapter);
    expect(kv.get(recordSlot("alerts.book"))).toEqual({ a: 1 });
  });

  it("expires tombstones after a month so they do not accumulate", async () => {
    const kv = createKV(memoryRawStore(), () => 0);
    let now = 1000;
    const engine = createSync(kv, () => now);
    const adapter = fakeAdapter();

    engine.markDeleted("gone", 1000);
    await engine.run(adapter);
    expect(Object.keys(engine.state().tombstones)).toEqual(["gone"]);

    now = 1000 + TOMBSTONE_TTL_MS + 1;
    await engine.run(adapter);
    expect(Object.keys(engine.state().tombstones)).toEqual([]);
  });

  it("advances the cursor to the newest record SEEN, not to the local clock", async () => {
    // A clock a few seconds fast would skip anything written on another machine
    // during the round trip — permanently.
    const kv = createKV(memoryRawStore(), () => 1000);
    const engine = createSync(kv, () => 999_999);
    const adapter = fakeAdapter([
      { key: "a", value: 1, v: 1, at: 4000, deletedAt: null, device: "dev_b" },
      { key: "b", value: 2, v: 1, at: 7000, deletedAt: null, device: "dev_b" },
    ]);

    const out = await engine.run(adapter);
    expect(out.cursor).toBe(7000);
  });

  it("changes nothing locally when the pull fails", async () => {
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot("prefs"), { theme: "local" });
    const engine = createSync(kv, () => 1000);
    const broken: SyncAdapter = {
      ...fakeAdapter(),
      pull: async () => {
        throw new Error("network down");
      },
    };

    const out = await engine.run(broken);
    expect(out.ok).toBe(false);
    expect(out.error).toBe("network down");
    expect(out.note).toMatch(/nothing was changed locally/);
    expect(kv.get(recordSlot("prefs"))).toEqual({ theme: "local" });
  });

  it("keeps local changes queued when the push fails", async () => {
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot("prefs"), { theme: "local" });
    const engine = createSync(kv, () => 1000);
    const broken: SyncAdapter = {
      ...fakeAdapter(),
      push: async () => {
        throw new Error("write refused");
      },
    };

    const out = await engine.run(broken);
    expect(out.ok).toBe(false);
    expect(out.note).toMatch(/still queued and will retry/);
    // The watermark must NOT have advanced, or the change is lost forever.
    expect(engine.state().pushed["prefs"]).toBeUndefined();
  });

  it("never sends the credential key to the target", async () => {
    const kv = createKV(memoryRawStore(), () => 1000);
    kv.write(recordSlot(SYNC_CREDENTIAL_KEY), { anonKey: "secret" });
    kv.write(recordSlot("prefs"), { theme: "x" });
    const engine = createSync(kv, () => 1000);
    const adapter = fakeAdapter();

    await engine.run(adapter);
    expect(adapter.rows.map((r) => r.key)).toEqual(["prefs"]);
  });
});

describe("record validation", () => {
  it("rejects anything that is not a record", () => {
    expect(isSyncRecord(null)).toBe(false);
    expect(isSyncRecord({ key: "a" })).toBe(false);
    expect(isSyncRecord({ key: "a", at: 1, device: "d" })).toBe(true);
  });
});

describe("the Supabase adapter", () => {
  const cfg = {
    url: "https://proj.supabase.co",
    anonKey: "anon-public-key",
    space: "a".repeat(32),
  };

  it("never puts the key in the string shown to the user", () => {
    // `describe()` ends up in the UI and in logs.
    const d = supabaseAdapter(cfg, (async () => new Response("[]")) as typeof fetch).describe();
    expect(d).not.toContain("anon-public-key");
    expect(d).toContain("proj.supabase.co");
  });

  it("insists on a long space id, because that IS the access control", () => {
    // With the shipped RLS policy the space id is the only secret. A short one
    // is guessable and the failure is silent — your settings are simply
    // readable and nothing tells you.
    expect(validateSupabaseConfig({ ...cfg, space: "short" })).toContainEqual(
      expect.stringMatching(/only secret/),
    );
    expect(validateSupabaseConfig(cfg)).toEqual([]);
  });

  it("generates a space id long enough to be one", () => {
    expect(newSpaceId(seq())).toHaveLength(32);
  });

  it("names the two failures people actually hit", async () => {
    const rls = supabaseAdapter(cfg, (async () =>
      new Response("denied", { status: 401 })) as typeof fetch);
    await expect(rls.pull(0)).rejects.toThrow(/row level security/);

    const missing = supabaseAdapter(cfg, (async () =>
      new Response("nope", { status: 404 })) as typeof fetch);
    await expect(missing.pull(0)).rejects.toThrow(/Run the setup SQL/);
  });

  it("upserts on push, or the second sync is a primary-key violation", async () => {
    let seen: RequestInit | undefined;
    const adapter = supabaseAdapter(cfg, (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch);

    await adapter.push([
      { key: "a", value: 1, v: 1, at: 5, deletedAt: null, device: "dev_a" },
    ]);
    const headers = seen?.headers as Record<string, string>;
    expect(headers["prefer"]).toContain("resolution=merge-duplicates");
    expect(headers["x-iram-space"]).toBe(cfg.space);
  });

  it("sends nothing at all when there is nothing to push", async () => {
    let calls = 0;
    const adapter = supabaseAdapter(cfg, (async () => {
      calls++;
      return new Response(null, { status: 201 });
    }) as typeof fetch);
    await adapter.push([]);
    expect(calls).toBe(0);
  });

  it("maps a tombstone row to a null value", async () => {
    const adapter = supabaseAdapter(cfg, (async () =>
      new Response(
        JSON.stringify([
          { space: cfg.space, key: "a", value: null, v: 1, at: 9, deleted_at: 9, device: "dev_b" },
        ]),
      )) as typeof fetch);
    const rows = await adapter.pull(0);
    expect(rows[0]!.deletedAt).toBe(9);
    expect(rows[0]!.value).toBeNull();
  });
});

describe("the generic REST adapter", () => {
  it("accepts either a bare array or a { records } envelope", async () => {
    const bare = restAdapter("http://x.test", undefined, (async () =>
      new Response(JSON.stringify([{ key: "a", at: 1, device: "d", value: 1, v: 1, deletedAt: null }]))) as typeof fetch);
    expect(await bare.pull(0)).toHaveLength(1);

    const wrapped = restAdapter("http://x.test", undefined, (async () =>
      new Response(
        JSON.stringify({ records: [{ key: "a", at: 1, device: "d", value: 1, v: 1, deletedAt: null }] }),
      )) as typeof fetch);
    expect(await wrapped.pull(0)).toHaveLength(1);
  });
});

describe("syncable — credentials", () => {
  // REGRESSION. The vault withheld `agent.credential` via looksSecret while
  // sync pushed it in plaintext to Supabase, because "is this a credential?"
  // had two separate answers. One predicate now owns that question.
  it("refuses to sync the analyst API key", () => {
    expect(syncable("agent.credential")).toBe(false);
  });

  it("refuses anything credential-shaped, not just the keys we thought of", () => {
    for (const key of [
      "agent.credential",
      "broker.apiKey",
      "user.token",
      "x.secret",
      "supabase.password",
      "mt5.login",
      "wallet.mnemonic",
      "session.cookie",
    ]) {
      expect(syncable(key)).toBe(false);
    }
  });

  it("still syncs ordinary settings", () => {
    for (const key of ["shell.prefs", "alerts.book", "workspace.layout", "commands.recent"]) {
      expect(syncable(key)).toBe(true);
    }
  });

  it("still refuses the machine-local prefixes", () => {
    expect(syncable("cache.klines")).toBe(false);
    expect(syncable("archive.meta")).toBe(false);
    expect(syncable("sync.state")).toBe(false);
  });
});
