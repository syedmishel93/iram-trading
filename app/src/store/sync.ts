/**
 * Sync — the same alerts, layouts and watchlists on every machine.
 *
 * THE HARD PART IS NOT THE NETWORK, IT IS THE CONFLICT
 * Two machines, both offline for an hour, both edit the alert book. There is no
 * scheme that makes both edits survive automatically without inventing an
 * intent neither user had. So this does the only defensible thing:
 *
 *   - **Last write wins**, by wall-clock `at`, ties broken by device id so the
 *     outcome is deterministic rather than dependent on who pushed first.
 *   - **And it says so.** Every overwrite is reported as a conflict with both
 *     timestamps and both device names. A sync that silently discards an hour
 *     of work is how people stop trusting sync.
 *
 * WHAT SYNCS AND WHAT DOES NOT
 * Settings sync. Bars do not. A bar archive is hundreds of megabytes of data
 * that is, by definition, identical on every machine because it came from the
 * same public venue — pushing it to a cloud database costs money and
 * bandwidth to reconstruct something a re-fetch rebuilds for free. History
 * moves by vault file, deliberately, when you actually want to move it.
 *
 * DELETES NEED TOMBSTONES
 * A deleted alert that is simply absent from the push comes straight back on
 * the next pull from any machine that still has it. Deletion is recorded as a
 * record with `deletedAt` set, and tombstones are kept for 30 days — long
 * enough for a laptop that was shut all month, short enough that they do not
 * accumulate forever.
 *
 * CREDENTIALS
 * The adapter holds whatever the backend needs. It is stored under a key the
 * vault exporter treats as a secret, so a backup file never carries it. The
 * terminal has no facility for broker credentials and this does not add one:
 * MT5 is reached through the local bridge, which the user logs into themselves.
 */

import { looksSecret } from "./vault";
import type { KV } from "./kv";
import { serviceBase } from "../data/backend";

export interface SyncRecord {
  key: string;
  /** Null for a tombstone. */
  value: unknown;
  /** Schema version of `value`. */
  v: number;
  /** Epoch ms of the write this record represents. */
  at: number;
  /** Set when this record is a deletion. */
  deletedAt: number | null;
  /** Which machine wrote it. */
  device: string;
}

export interface SyncAdapter {
  id: string;
  label: string;
  /** Human-readable target, shown in the UI. Must never include a secret. */
  describe(): string;
  /** Records changed at or after `since`. */
  pull(since: number, signal?: AbortSignal): Promise<SyncRecord[]>;
  /** Upsert. Must be idempotent — a retried push must not duplicate. */
  push(records: readonly SyncRecord[], signal?: AbortSignal): Promise<void>;
  /** Cheap reachability probe. */
  ping(signal?: AbortSignal): Promise<{ ok: boolean; note: string }>;
}

export interface SyncConflict {
  key: string;
  winner: "local" | "remote";
  localAt: number;
  remoteAt: number;
  localDevice: string;
  remoteDevice: string;
  note: string;
}

export interface SyncOutcome {
  ok: boolean;
  pulled: number;
  pushed: number;
  applied: number;
  conflicts: SyncConflict[];
  /** Watermark to pass as `since` next time. */
  cursor: number;
  error: string | null;
  note: string;
}

export interface SyncState {
  lastSyncAt: number;
  cursor: number;
  device: string;
  /** Per-key `at` of the last value we pushed, so we only push changes. */
  pushed: Record<string, number>;
  /** Local deletions awaiting propagation. */
  tombstones: Record<string, number>;
}

export const SYNC_STATE_KEY = "sync.state";
/** Contains "credential", so `looksSecret` withholds it from every vault export. */
export const SYNC_CREDENTIAL_KEY = "sync.credential";

/** Tombstones older than this are dropped. A month of offline is generous. */
export const TOMBSTONE_TTL_MS = 30 * 86_400_000;

/** Keys sync never touches — machine-local by nature, or too big. */
export const NEVER_SYNC = [SYNC_STATE_KEY, SYNC_CREDENTIAL_KEY, "cache.", "archive."];

/**
 * May this key leave the machine?
 *
 * TWO RULES, AND THE SECOND ONE IS THE IMPORTANT ONE.
 *
 * The prefix list above covers things that are meaningless elsewhere — sync's
 * own bookkeeping, the response cache, the bar archive.
 *
 * `looksSecret` covers things that must never leave at ALL, and it is the SAME
 * predicate the vault exporter uses. That shared owner is the point. This
 * function originally had only the prefix list, and when the analyst's API key
 * arrived under `agent.credential` the vault correctly withheld it from every
 * backup while sync happily pushed it, in plaintext, to whatever Supabase
 * project or custom endpoint the user had configured. Nothing was wrong with
 * either rule; what was wrong was that "is this a credential?" had two separate
 * answers, so protecting one path did not protect the other.
 *
 * Any new credential-shaped key is now covered by both paths automatically.
 */
export function syncable(key: string): boolean {
  if (looksSecret(key)) return false;
  return !NEVER_SYNC.some((p) => key === p || key.startsWith(p));
}

/**
 * A stable per-machine identifier.
 *
 * Random, not derived from anything about the user or the browser. A device id
 * built from a fingerprint would be a tracking vector in a file people share,
 * and a random string does the one job needed: break ties deterministically and
 * name the other machine in a conflict message.
 */
export function newDeviceId(random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  return `dev_${s}`;
}

export interface SyncEngine {
  device(): string;
  state(): SyncState;
  /** Record a local deletion so it can propagate. */
  markDeleted(key: string, at?: number): void;
  run(adapter: SyncAdapter, signal?: AbortSignal): Promise<SyncOutcome>;
  reset(): void;
}

const stateSlot = {
  key: SYNC_STATE_KEY,
  version: 1,
  fallback: (): SyncState => ({
    lastSyncAt: 0,
    cursor: 0,
    device: "",
    pushed: {},
    tombstones: {},
  }),
  validate: (v: unknown): SyncState | null => {
    if (v === null || typeof v !== "object") return null;
    const r = v as Partial<SyncState>;
    return {
      lastSyncAt: typeof r.lastSyncAt === "number" ? r.lastSyncAt : 0,
      cursor: typeof r.cursor === "number" ? r.cursor : 0,
      device: typeof r.device === "string" ? r.device : "",
      pushed: (r.pushed ?? {}) as Record<string, number>,
      tombstones: (r.tombstones ?? {}) as Record<string, number>,
    };
  },
};

export function createSync(
  kv: KV,
  now: () => number = Date.now,
  random: () => number = Math.random,
): SyncEngine {
  let state = kv.get(stateSlot);
  if (!state.device) {
    state = { ...state, device: newDeviceId(random) };
    kv.write(stateSlot, state);
  }

  const persist = (next: SyncState): void => {
    state = next;
    kv.write(stateSlot, next);
  };

  return {
    device: () => state.device,
    state: () => ({ ...state, pushed: { ...state.pushed }, tombstones: { ...state.tombstones } }),

    markDeleted(key, at) {
      if (!syncable(key)) return;
      persist({ ...state, tombstones: { ...state.tombstones, [key]: at ?? now() } });
    },

    async run(adapter, signal) {
      const t = now();
      const conflicts: SyncConflict[] = [];
      let applied = 0;

      let remote: SyncRecord[];
      try {
        remote = await adapter.pull(state.cursor, signal);
      } catch (err) {
        return {
          ok: false,
          pulled: 0,
          pushed: 0,
          applied: 0,
          conflicts,
          cursor: state.cursor,
          error: err instanceof Error ? err.message : String(err),
          note: `pull from ${adapter.describe()} failed; nothing was changed locally`,
        };
      }

      // ---- apply remote -> local
      const tombstones = { ...state.tombstones };
      for (const rec of remote) {
        if (!syncable(rec.key)) continue;
        const local = kv.rawEnvelope(rec.key);
        const localAt = local?.at ?? tombstones[rec.key] ?? -1;

        if (rec.deletedAt !== null) {
          if (localAt <= rec.at) {
            kv.remove(rec.key);
            tombstones[rec.key] = rec.at;
            applied++;
          }
          continue;
        }

        if (localAt < 0) {
          kv.putEnvelope(rec.key, { v: rec.v, at: rec.at, value: rec.value });
          applied++;
          continue;
        }

        if (rec.at > localAt || (rec.at === localAt && rec.device > state.device)) {
          const res = kv.putEnvelope(rec.key, { v: rec.v, at: rec.at, value: rec.value });
          if (res.ok) {
            applied++;
            // Only a real overwrite of a DIFFERENT local edit is a conflict.
            // Reporting every incoming record as one would make the list
            // meaningless, and a warning nobody reads is not a warning.
            if (local && local.at > (state.pushed[rec.key] ?? -1)) {
              conflicts.push({
                key: rec.key,
                winner: "remote",
                localAt: local.at,
                remoteAt: rec.at,
                localDevice: state.device,
                remoteDevice: rec.device,
                note: `remote copy from ${rec.device} was newer; your local edit at ${new Date(
                  local.at,
                ).toISOString()} was replaced`,
              });
            }
          }
        } else if (localAt > rec.at && local && local.at > (state.pushed[rec.key] ?? -1)) {
          conflicts.push({
            key: rec.key,
            winner: "local",
            localAt: local.at,
            remoteAt: rec.at,
            localDevice: state.device,
            remoteDevice: rec.device,
            note: `your copy is newer and will be pushed, replacing ${rec.device}'s`,
          });
        }
      }

      // ---- collect local -> remote
      const outgoing: SyncRecord[] = [];
      for (const key of kv.keys()) {
        if (!syncable(key)) continue;
        const env = kv.rawEnvelope(key);
        if (!env) continue;
        if ((state.pushed[key] ?? -1) >= env.at) continue;
        outgoing.push({
          key,
          value: env.value,
          v: env.v,
          at: env.at,
          deletedAt: null,
          device: state.device,
        });
      }
      for (const [key, at] of Object.entries(tombstones)) {
        if ((state.pushed[key] ?? -1) >= at) continue;
        outgoing.push({ key, value: null, v: 0, at, deletedAt: at, device: state.device });
      }

      if (outgoing.length > 0) {
        try {
          await adapter.push(outgoing, signal);
        } catch (err) {
          return {
            ok: false,
            pulled: remote.length,
            pushed: 0,
            applied,
            conflicts,
            cursor: state.cursor,
            error: err instanceof Error ? err.message : String(err),
            note: `pulled ${remote.length} and applied ${applied}, but the push to ${adapter.describe()} failed. Local changes are still queued and will retry.`,
          };
        }
      }

      // ---- advance the watermark
      const pushed = { ...state.pushed };
      for (const rec of outgoing) pushed[rec.key] = rec.at;
      for (const rec of remote) pushed[rec.key] = Math.max(pushed[rec.key] ?? 0, rec.at);

      const liveTombstones: Record<string, number> = {};
      for (const [key, at] of Object.entries(tombstones)) {
        if (t - at < TOMBSTONE_TTL_MS) liveTombstones[key] = at;
      }

      // The cursor is the newest record SEEN, not `now`. Using the local clock
      // would skip anything written on another machine during this round trip,
      // and a clock a few seconds fast would skip it permanently.
      const newest = remote.reduce((a, r) => Math.max(a, r.at), state.cursor);

      persist({
        lastSyncAt: t,
        cursor: newest,
        device: state.device,
        pushed,
        tombstones: liveTombstones,
      });

      return {
        ok: true,
        pulled: remote.length,
        pushed: outgoing.length,
        applied,
        conflicts,
        cursor: newest,
        error: null,
        note:
          conflicts.length > 0
            ? `${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} resolved by last-write-wins — review them, the losing edit is gone.`
            : `in sync with ${adapter.describe()}`,
      };
    },

    reset() {
      persist({
        lastSyncAt: 0,
        cursor: 0,
        device: state.device,
        pushed: {},
        tombstones: {},
      });
    },
  };
}

// ------------------------------------------------------------- adapters ----

/**
 * The local Python service as a sync target.
 *
 * The zero-setup option, and the right default: it is already running, it is on
 * 127.0.0.1, nothing leaves the machine, and it gives a laptop on the same LAN
 * a target without an account anywhere. It syncs settings between BROWSERS and
 * survives a cache clear, which is most of what people actually want.
 */
export function localServiceAdapter(base = serviceBase()): SyncAdapter {
  const url = (path: string): string => `${base}${path}`;
  return {
    id: "local",
    label: "Local service",
    describe: () => base,

    async ping(signal) {
      try {
        const res = await fetch(url("/svc/health"), { ...(signal ? { signal } : {}) });
        return res.ok
          ? { ok: true, note: `reachable at ${base}` }
          : { ok: false, note: `service answered ${res.status}` };
      } catch {
        return {
          ok: false,
          note: `not running at ${base} — start everything with "python run.py"`,
        };
      }
    },

    async pull(since, signal) {
      const res = await fetch(url(`/svc/sync/pull?since=${Math.floor(since)}`), {
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`sync pull: service answered ${res.status}`);
      const rows = (await res.json()) as unknown;
      return Array.isArray(rows) ? rows.filter(isSyncRecord) : [];
    },

    async push(records, signal) {
      const res = await fetch(url("/svc/sync/push"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ records }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`sync push: service answered ${res.status}`);
    },
  };
}

export function isSyncRecord(v: unknown): v is SyncRecord {
  if (v === null || typeof v !== "object") return false;
  const r = v as SyncRecord;
  return typeof r.key === "string" && typeof r.at === "number" && typeof r.device === "string";
}
