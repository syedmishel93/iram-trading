/**
 * THE SETTINGS BACKUP HAD NO WRITER.
 *
 * `POST /svc/backup` exists on the server and NOTHING in the frontend has ever
 * called it. MEASURED on the live service, what it holds is:
 *
 *     {"_t": 1234, "_v": 1, "mishel_walletdb": "{\\"0xabc\\":{\\"tier\\":\\"S\\"}}"}
 *
 * `0xabc`, tier S — the exact fixture CLAUDE.md records four test files writing
 * into the operator's live database. So the "durable copy on the server" was
 * fifteen-day-old test residue, and every setting this browser holds existed in
 * exactly one place: localStorage, which the browser may evict without asking.
 * Same shape as the bar archive before v60.3, and the same fix.
 *
 * THE DANGEROUS CASE IS THE EMPTY ONE
 *
 * A backup runs automatically, so it will run on a profile whose local store is
 * empty — a fresh browser, a cleared one, a private window. Pushing THAT would
 * overwrite the good copy on the server with nothing, and the operator would
 * discover it at exactly the moment they needed it. So the builder REFUSES
 * rather than uploading an empty or degenerate blob, and says which.
 */

import { describe, it, expect } from "vitest";
import { buildBackup, startBackup, MAX_BACKUP_BYTES } from "../src/data/settingsbackup";
import { createKV, memoryRawStore, recordSlot } from "../src/store/kv";

const slotA = recordSlot("prefs", 1);
const slotB = recordSlot("pins", 1);

function kvWith(): ReturnType<typeof createKV> {
  const kv = createKV(memoryRawStore());
  kv.write(slotA, { theme: "dark" });
  kv.write(slotB, { list: ["BTCUSDT"] });
  return kv;
}

describe("buildBackup", () => {
  it("carries every slot as its RAW ENVELOPE, versions and timestamps intact", () => {
    /* Envelopes, not values: `putEnvelope` refuses to go backwards, and it can
       only do that if the timestamp travels with the value. */
    const r = buildBackup(kvWith());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.blob).sort()).toEqual(["pins", "prefs"]);
    const env = r.blob["prefs"] as { v: number; at: number; value: unknown };
    expect(env.v).toBe(1);
    expect(typeof env.at).toBe("number");
    expect(env.value).toEqual({ theme: "dark" });
  });

  it("REFUSES an empty store rather than overwriting a good server copy", () => {
    /* The whole hazard. A fresh or cleared browser backing itself up would
       destroy the copy it exists to protect. */
    const r = buildBackup(createKV(memoryRawStore()));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/nothing|empty/i);
  });

  it("refuses when every slot is unreadable, rather than sending {}", () => {
    const kv = createKV(memoryRawStore({ "iram:junk": "not json" }));
    const r = buildBackup(kv);
    expect(r.ok).toBe(false);
  });

  it("caps the payload and names what it left out", () => {
    const kv = createKV(memoryRawStore());
    kv.write(slotA, { theme: "dark" });
    /* One oversized slot must not silently take the backup with it. */
    kv.write(slotB, { blob: "x".repeat(MAX_BACKUP_BYTES + 1000) });
    const r = buildBackup(kv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.blob)).toContain("prefs");
    expect(Object.keys(r.blob)).not.toContain("pins");
    expect(r.skipped).toContain("pins");
    expect(r.bytes).toBeLessThanOrEqual(MAX_BACKUP_BYTES);
  });

  it("reports the size it actually built, not the size it was asked for", () => {
    const r = buildBackup(kvWith());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes).toBe(JSON.stringify(r.blob).length);
  });

  it("is stable: the same store builds the same blob", () => {
    /* A backup that differs every call would push on every debounce tick and
       fill the log with writes that changed nothing. */
    const kv = kvWith();
    expect(JSON.stringify(buildBackup(kv))).toBe(JSON.stringify(buildBackup(kv)));
  });
});

describe("buildBackup and credentials", () => {
  it("NEVER uploads a credential, and defers to the one owner of that question", () => {
    /* `store/sync.ts` records this defect happening once already: the analyst's
       API key arrived under `agent.credential`, the vault withheld it from
       backups and sync pushed it in plaintext, because "is this a credential?"
       had two answers. This module is a THIRD path off the machine and must
       not become the third answer — the live store holds `agent.credential`
       right now. */
    const kv = createKV(memoryRawStore());
    kv.write(recordSlot("prefs", 1), { theme: "dark" });
    kv.write(recordSlot("agent.credential", 1), { key: "sk-ant-not-a-real-key" });
    const r = buildBackup(kv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.blob)).toContain("prefs");
    expect(Object.keys(r.blob)).not.toContain("agent.credential");
    expect(r.withheld).toContain("agent.credential");
    /* And the secret must not appear anywhere in the serialised payload. */
    expect(JSON.stringify(r.blob)).not.toContain("sk-ant");
  });

  it("refuses rather than uploading {} when everything is withheld", () => {
    const kv = createKV(memoryRawStore());
    kv.write(recordSlot("agent.credential", 1), { key: "secret" });
    const r = buildBackup(kv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/credential|machine-local/i);
  });
});

describe("startBackup scheduling", () => {
  /**
   * AN INERT TRANSPORT, because the live one reached the operator's server.
   *
   * `startBackup`'s push argument used to default to `pushBackup`, and under
   * vitest the global `fetch` resolves against the running gateway — so these
   * very tests POSTed two fixture slots over the operator's thirteen real ones.
   * Measured after the fact: the server row read `{pins, prefs}`.
   *
   * The argument now has no default, so this stub is not a convenience: there
   * is no way to call `startBackup` here without supplying one.
   */
  const stubPush = async (): Promise<{ ok: false; why: string }> => ({
    ok: false,
    why: "stub transport — this test must never reach a server",
  });

  /** A controllable clock, so the debounce is arithmetic and not a wait. */
  function fakeTimers() {
    let now = 0;
    let next = 1;
    const jobs = new Map<number, { at: number; fn: () => void }>();
    return {
      schedule: (fn: () => void, ms: number): number => {
        const id = next++;
        jobs.set(id, { at: now + ms, fn });
        return id;
      },
      cancel: (id: number): void => {
        jobs.delete(id);
      },
      advance(ms: number) {
        now += ms;
        for (const [id, j] of [...jobs]) {
          if (j.at <= now) {
            jobs.delete(id);
            j.fn();
          }
        }
      },
      pending: () => jobs.size,
    };
  }

  it("A DEBOUNCE WITH NO CEILING NEVER FIRES under continuous writes", async () => {
    /*
     * THE DEFECT THIS PINS, found live. Every KV write cancelled the pending
     * timer and rescheduled it. This terminal writes continuously — recent
     * commands, the day's risk, appearance, the account — so the deadline was
     * pushed out forever and the backup NEVER ran. The server row stayed at a
     * 15-day-old test fixture through three full page loads while the code was
     * present, imported and correct.
     *
     * Same family as the rolling window that could never expire: a mechanism
     * whose trigger is reset by the very activity it is meant to capture.
     */
    const kv = createKV(memoryRawStore());
    kv.write(slotA, { theme: "dark" });
    const t = fakeTimers();
    const results: unknown[] = [];
    const stop = startBackup(kv, (r) => results.push(r), stubPush, t.schedule, t.cancel);

    /* CONSUME THE BOOT TIMER FIRST.
     *
     * An earlier version of this test advanced before writing, so the 15s boot
     * push fired on the first tick and the assertion passed WITH THE CEILING
     * REMOVED — a vacuous test of exactly the kind this project keeps finding.
     * Proved by deleting the ceiling line and watching it still pass. This
     * write cancels the boot timer immediately, so what follows measures only
     * the continuous-write path the defect lived in. */
    kv.write(slotB, { n: -1 });

    /* A write every 30s, forever — closer together than the 45s debounce. */
    for (let i = 0; i < 20; i++) {
      t.advance(30_000);
      kv.write(slotB, { n: i });
    }
    /* With a ceiling this must have fired; without one it never does.
       A real tick, not `Promise.resolve()`: the push goes through `fetch`,
       which in this environment fails fast against no server and still has to
       settle. What is asserted is that the attempt HAPPENED — whether it
       reached a server is not this test's subject. */
    await new Promise((r) => setTimeout(r, 120));
    expect(results.length).toBeGreaterThan(0);
    stop();
  });

  it("still coalesces a burst rather than pushing on every keystroke", () => {
    const kv = createKV(memoryRawStore());
    kv.write(slotA, { theme: "dark" });
    const t = fakeTimers();
    let calls = 0;
    const stop = startBackup(kv, () => (calls += 1), stubPush, t.schedule, t.cancel);
    /* Twenty writes inside one second must not be twenty uploads. */
    for (let i = 0; i < 20; i++) kv.write(slotB, { n: i });
    t.advance(1_000);
    expect(calls).toBe(0);
    stop();
  });

  it("stops scheduling once disposed", () => {
    const kv = createKV(memoryRawStore());
    kv.write(slotA, { theme: "dark" });
    const t = fakeTimers();
    const stop = startBackup(kv, () => {}, stubPush, t.schedule, t.cancel);
    stop();
    kv.write(slotB, { n: 1 });
    expect(t.pending()).toBe(0);
  });
});
