/**
 * THE SETTINGS BACKUP — which had no writer at all.
 *
 * `POST /svc/backup` has existed on the server since v29 and NOTHING in the
 * frontend has ever called it. MEASURED on the live service, what it held was:
 *
 *     {"_t": 1234, "_v": 1, "mishel_walletdb": "{\"0xabc\":{\"tier\":\"S\"}}"}
 *
 * `0xabc`, tier S — the exact fixture CLAUDE.md records four test files writing
 * into the operator's live database. So the durable copy was fifteen-day-old
 * TEST RESIDUE, and every setting this browser holds lived in exactly one
 * place: localStorage, which the browser may evict without asking. That is the
 * same shape as the bar archive before v60.3 — one copy, in the one store with
 * no guarantee — and it gets the same fix.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DANGEROUS CASE IS THE EMPTY ONE
 *
 * A backup that runs automatically will eventually run on a profile whose local
 * store is empty: a fresh browser, a cleared one, a private window. Pushing
 * that would OVERWRITE the good copy on the server with nothing, and the
 * operator would find out at exactly the moment they needed it. So this refuses
 * to build a degenerate blob at all, and the refusal names itself.
 *
 * It is the same rule as "a budget that can only be met by deleting recent
 * history is a misconfiguration, not an instruction": the destructive reading
 * of an ambiguous state is never the one to act on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENVELOPES, NOT VALUES
 *
 * Each slot travels as its raw envelope — schema version and write timestamp
 * intact — because `putEnvelope` refuses to go backwards on restore, and it can
 * only do that if the timestamp comes with the value.
 */

import { svcUrl } from "./backend";
import { signal } from "../core/signal";
import type { Envelope, KV } from "../store/kv";
import { syncable } from "../store/sync";

/**
 * The most this will upload.
 *
 * The route stores the blob as one row in SQLite. A browser store can hold
 * megabytes of drawings, and pushing all of it every few minutes would make the
 * backup the largest write this product performs. Settings are small; anything
 * that is not is a cache and can be rebuilt.
 */
export const MAX_BACKUP_BYTES = 256 * 1024;

export type BackupBuild =
  | {
      readonly ok: true;
      readonly blob: Readonly<Record<string, Envelope<unknown>>>;
      readonly bytes: number;
      /** Slots left out for size. Named, never silently dropped. */
      readonly skipped: readonly string[];
      /** Kept OFF the wire on purpose: credentials and machine-local state. */
      readonly withheld: readonly string[];
    }
  | { readonly ok: false; readonly why: string };

/**
 * Collect every slot worth keeping, smallest first so one huge slot cannot
 * crowd out twenty small ones.
 */
export function buildBackup(kv: KV, maxBytes = MAX_BACKUP_BYTES): BackupBuild {
  const keys = kv.keys();
  if (keys.length === 0) {
    return {
      ok: false,
      why: "this browser holds nothing to back up — refusing, so an empty profile cannot overwrite the copy on the server",
    };
  }

  const sized: Array<{ key: string; env: Envelope<unknown>; bytes: number }> = [];
  const withheld: string[] = [];
  for (const key of keys) {
    /*
     * "IS THIS A CREDENTIAL?" HAS EXACTLY ONE ANSWER IN THIS CODEBASE.
     *
     * `store/sync.ts` records what happens when it has two: the analyst's API
     * key arrived under `agent.credential`, the vault exporter correctly
     * withheld it from every backup, and sync pushed it in plaintext to
     * whatever endpoint was configured. Neither rule was wrong; there were just
     * two of them.
     *
     * This module is a THIRD path off the machine, and it was about to make the
     * same mistake — the live store holds `agent.credential` right now and an
     * earlier draft of this function would have uploaded it. `syncable` is that
     * one owner, so a credential-shaped key added tomorrow is covered here
     * without anyone remembering to come back.
     */
    if (!syncable(key)) {
      withheld.push(key);
      continue;
    }
    const env = kv.rawEnvelope(key);
    if (!env) continue; // unreadable or quarantined: not this function's problem
    let bytes = 0;
    try {
      bytes = JSON.stringify(env).length;
    } catch {
      continue; // not serialisable, so it cannot be backed up at all
    }
    sized.push({ key, env, bytes });
  }

  if (sized.length === 0) {
    return {
      ok: false,
      why: withheld.length > 0
        ? "everything in this browser is either a credential or machine-local — nothing to back up"
        : "nothing in this browser could be read back as a settings slot — refusing rather than uploading an empty backup",
    };
  }

  /* SMALLEST FIRST. One oversized slot must not cost twenty small ones their
     place; the alternative loses the cheap settings to protect one cache. */
  sized.sort((a, b) => a.bytes - b.bytes || a.key.localeCompare(b.key));

  const blob: Record<string, Envelope<unknown>> = {};
  const skipped: string[] = [];
  let used = 2; // the enclosing braces
  for (const s of sized) {
    /* +key, quotes, colon, comma. Approximate on purpose: the exact figure is
       measured from the finished blob below rather than accumulated here. */
    const cost = s.bytes + s.key.length + 4;
    if (used + cost > maxBytes) {
      skipped.push(s.key);
      continue;
    }
    blob[s.key] = s.env;
    used += cost;
  }

  if (Object.keys(blob).length === 0) {
    return { ok: false, why: "every slot is larger than the backup limit on its own" };
  }

  /* THE SIZE IT ACTUALLY BUILT, not the size it was asked for. A reported
     figure that comes from the request rather than the result is the defect
     `mishel_edge.upsert` shipped for months. */
  return { ok: true, blob, bytes: JSON.stringify(blob).length, skipped, withheld };
}

/**
 * The last push, for the card that reports it.
 *
 * "Backed up" with no evidence is exactly the reassurance that survives the
 * mechanism stopping — `bars_loop` reported a fresh tick age for a whole
 * release while doing nothing. So the RESULT is kept and shown, not the
 * intention.
 */
export type PushResult =
  | { readonly ok: true; readonly bytes: number; readonly t: number }
  | { readonly ok: false; readonly why: string };

/** Send it. Refuses to send a blob the builder refused to build. */
export async function pushBackup(build: BackupBuild): Promise<PushResult> {
  if (!build.ok) return { ok: false, why: build.why };
  const url = svcUrl("/svc/backup");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(build.blob),
    });
    if (!res.ok) return { ok: false, why: `the settings backup answered ${res.status} on ${url}` };
    const body = (await res.json()) as { ok?: boolean; bytes?: number; t?: number; error?: string };
    if (body.ok !== true) return { ok: false, why: body.error ?? "the settings backup refused and did not say why" };
    return { ok: true, bytes: body.bytes ?? build.bytes, t: body.t ?? Date.now() / 1000 };
  } catch {
    return { ok: false, why: `the settings backup is not answering on ${url}` };
  }
}

/** How long after a change to wait before pushing. */
export const BACKUP_DEBOUNCE_MS = 45_000;

/** What the last attempt did. Null until one has been made. */
export const lastBackup = signal<PushResult | null>(null);

/**
 * Back up on change, debounced, and once shortly after boot.
 *
 * DEBOUNCED BECAUSE A KV WRITE IS CHEAP AND A BACKUP IS NOT. Dragging a
 * drawing writes on every pointer move; uploading each one would make this the
 * noisiest thing the product does.
 *
 * Returns a disposer, and the last result, so a card can say what happened
 * rather than leaving "backed up" as an assumption nobody checks.
 */
/**
 * The longest this will EVER wait, however busy the store is.
 *
 * THE DEFECT THIS FIXES, FOUND LIVE. `bump` cancelled the pending timer on
 * every KV write and rescheduled it. This terminal writes continuously —
 * recent commands, the day's risk, appearance, the account — so the deadline
 * was pushed out forever and the backup NEVER RAN. The server row sat at a
 * 15-day-old test fixture through three full page loads while the code was
 * present, imported, and correct in every other respect.
 *
 * A debounce whose trigger is reset by the very activity it exists to capture
 * is not a debounce, it is an off switch. Same family as the rolling window
 * that could never expire because its length never changed.
 */
export const BACKUP_MAX_WAIT_MS = 5 * 60_000;

/**
 * Back up on change, debounced, with a ceiling, and once shortly after boot.
 *
 * DEBOUNCED BECAUSE A KV WRITE IS CHEAP AND A BACKUP IS NOT. Dragging a drawing
 * writes on every pointer move; uploading each one would make this the noisiest
 * thing the product does.
 *
 * CEILINGED BECAUSE A DEBOUNCE ALONE NEVER FIRED. The ceiling timer is set on
 * the first write of a quiet period and is NEVER cancelled by a later one, so
 * the backup happens at least every `BACKUP_MAX_WAIT_MS` no matter what.
 *
 * Returns a disposer. The result goes to `onResult`, because "backed up" with
 * no evidence is the reassurance that survives the mechanism stopping — which
 * is precisely what happened here.
 */
export function startBackup(
  kv: KV,
  onResult: (r: PushResult) => void,
  /*
   * THE TRANSPORT IS AN ARGUMENT WITH NO DEFAULT, AND THAT IS DELIBERATE.
   *
   * It had a default of `pushBackup`, and a scheduling test that called
   * `startBackup` with a fake clock reached the OPERATOR'S LIVE SERVER: under
   * vitest the global `fetch` resolves against the running gateway, so the test
   * POSTed its two fixture slots over thirteen real ones. Measured — the server
   * row came back `{pins, prefs}`.
   *
   * CLAUDE.md records this arriving through a different door already
   * (`createHistory` defaulting to the real `/svc/bars` client) and states the
   * rule it produced: make reaching a real store something a caller OPTS IN to,
   * because "a default that is inert cannot be reached by a test that does not
   * know it exists". A default that is LIVE is the opposite, and the four test
   * files that once wrote to `mishel.db` are the same family.
   *
   * So `mountShell` passes `pushBackup` explicitly and every test passes a
   * stub. There is no spelling of this call that silently touches the network.
   */
  push: (b: BackupBuild) => Promise<PushResult>,
  schedule: (fn: () => void, ms: number) => number = (fn, ms) => setTimeout(fn, ms) as unknown as number,
  cancel: (id: number) => void = (id) => clearTimeout(id),
): () => void {
  let debounceTimer: number | null = null;
  let ceilingTimer: number | null = null;
  let stopped = false;

  const clearTimers = (): void => {
    if (debounceTimer !== null) {
      cancel(debounceTimer);
      debounceTimer = null;
    }
    if (ceilingTimer !== null) {
      cancel(ceilingTimer);
      ceilingTimer = null;
    }
  };

  const run = (): void => {
    clearTimers();
    if (stopped) return;
    void push(buildBackup(kv)).then(onResult);
  };

  const bump = (): void => {
    if (stopped) return;
    if (debounceTimer !== null) cancel(debounceTimer);
    debounceTimer = schedule(run, BACKUP_DEBOUNCE_MS);
    /* THE CEILING. Set once per quiet period and never cancelled by a later
       write — that is the whole point, and the line whose absence meant this
       never ran at all. */
    if (ceilingTimer === null) ceilingTimer = schedule(run, BACKUP_MAX_WAIT_MS);
  };

  const unsub = kv.subscribe(bump);
  /* One shortly after boot, so a browser that is never edited still ends up
     with a copy on the server — the failure this whole module exists for. */
  debounceTimer = schedule(run, 15_000);

  return () => {
    stopped = true;
    clearTimers();
    unsub();
  };
}
