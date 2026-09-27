/**
 * Supabase (and any PostgREST-compatible endpoint) as a sync target.
 *
 * WHY REST AND NOT THE SDK
 * `@supabase/supabase-js` is ~40KB gzipped and pulls in a websocket client, a
 * postgrest builder and an auth stack — for two HTTP calls. The shipped
 * artefact is ONE self-contained index.html with no dependencies, and adding a
 * package to send a GET and a POST would trade that for nothing. PostgREST is
 * a plain REST API; this is the whole client.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BE CLEAR ABOUT WHAT THE ANON KEY IS
 *
 * The Supabase anon key is designed to be public — it ships inside every web
 * app that uses Supabase. It is NOT a password. The thing that actually decides
 * who can read your rows is ROW LEVEL SECURITY, and a table with RLS off is
 * readable and writable by anyone holding that public key.
 *
 * So the setup below is not optional decoration. Run it before syncing anything
 * you would mind a stranger reading:
 *
 *   create table public.iram_sync (
 *     space      text        not null,
 *     key        text        not null,
 *     value      jsonb,
 *     v          integer     not null default 1,
 *     at         bigint      not null,
 *     deleted_at bigint,
 *     device     text        not null,
 *     primary key (space, key)
 *   );
 *   create index iram_sync_at on public.iram_sync (space, at);
 *   alter table public.iram_sync enable row level security;
 *
 *   -- Option A — single user, no accounts. The space id IS the secret.
 *   -- Generate a long random one; treat it exactly like a password.
 *   create policy iram_space on public.iram_sync
 *     for all to anon
 *     using (space = current_setting('request.headers', true)::json->>'x-iram-space')
 *     with check (space = current_setting('request.headers', true)::json->>'x-iram-space');
 *
 *   -- Option B — real accounts. Replace `space` with `owner uuid default
 *   -- auth.uid()` and policy on `owner = auth.uid()`. Use this if more than one
 *   -- person will ever have the key.
 *
 * Option A is honest security-by-secret-identifier: anyone with your anon key
 * AND your space id has your settings. That is genuinely fine for chart
 * layouts and genuinely not fine for anything else — which is why bars, broker
 * details and anything matching the credential pattern never go near it.
 *
 * WHAT IS ACTUALLY SENT
 * Alerts, layouts, watchlists, preferences. Not bars. Not credentials — the
 * sync credential itself is stored under a key the vault exporter redacts, and
 * `syncable()` refuses to enumerate it. The terminal has no broker secrets to
 * leak because it never holds any: MT5 is reached through the local bridge you
 * log into yourself.
 *
 * The key is kept in localStorage in plain text, like every web app's session.
 * Anyone with access to this browser profile can read it. If that matters on
 * this machine, use the local-service adapter instead — nothing leaves at all.
 */

import type { SyncAdapter, SyncRecord } from "./sync";

export interface SupabaseConfig {
  /** Project URL, e.g. https://abcdefgh.supabase.co */
  url: string;
  /** The anon (publishable) key. */
  anonKey: string;
  /** Table name. Default `iram_sync`. */
  table?: string;
  /**
   * Namespace. With the Option A policy above this is the only thing keeping
   * your rows yours, so make it long and random.
   */
  space: string;
}

interface Row {
  space: string;
  key: string;
  value: unknown;
  v: number;
  at: number;
  deleted_at: number | null;
  device: string;
}

export function validateSupabaseConfig(cfg: Partial<SupabaseConfig>): string[] {
  const problems: string[] = [];
  if (!cfg.url) problems.push("project URL is required");
  else if (!/^https?:\/\//.test(cfg.url)) problems.push("project URL must start with https://");
  if (!cfg.anonKey) problems.push("anon key is required");
  if (!cfg.space) problems.push("space id is required");
  else if (cfg.space.length < 16) {
    // With the Option A policy the space id is the entire access control. A
    // short one is guessable, and the failure is silent: your settings are
    // simply readable and nothing tells you.
    problems.push("space id is under 16 characters — with an RLS space policy it is the only secret");
  }
  return problems;
}

/** A long random namespace, for the setup UI. */
export function newSpaceId(random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  return s;
}

export function supabaseAdapter(
  cfg: SupabaseConfig,
  fetchImpl: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a),
): SyncAdapter {
  const table = cfg.table ?? "iram_sync";
  const base = cfg.url.replace(/\/+$/, "");
  const endpoint = `${base}/rest/v1/${encodeURIComponent(table)}`;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: cfg.anonKey,
    authorization: `Bearer ${cfg.anonKey}`,
    "content-type": "application/json",
    // Read by the RLS policy in Option A.
    "x-iram-space": cfg.space,
    ...extra,
  });

  /**
   * Turn a PostgREST failure into something actionable.
   *
   * The default message is a status code, and the two failures people actually
   * hit — RLS refusing the row, and the table not existing — both look like
   * generic 4xx. Naming them saves an hour of guessing.
   */
  const explain = async (res: Response, what: string): Promise<never> => {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* body already consumed or unreadable; the status still tells the story */
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `${what}: Supabase refused the request (${res.status}). Either the anon key is wrong, or row level security is rejecting this space. ${detail}`,
      );
    }
    if (res.status === 404) {
      throw new Error(
        `${what}: table "${table}" not found at ${base}. Run the setup SQL in supabase.ts. ${detail}`,
      );
    }
    throw new Error(`${what}: Supabase answered ${res.status}. ${detail}`);
  };

  return {
    id: "supabase",
    label: "Supabase",
    // Never the key. This string ends up in the UI and in logs.
    describe: () => `${base} → ${table} (space ${cfg.space.slice(0, 6)}…)`,

    async ping(signal) {
      try {
        const res = await fetchImpl(`${endpoint}?select=key&limit=1`, {
          headers: headers(),
          ...(signal ? { signal } : {}),
        });
        if (res.ok) return { ok: true, note: `reachable; table "${table}" is readable` };
        if (res.status === 401 || res.status === 403) {
          return { ok: false, note: `key accepted but RLS refused — check the policy on "${table}"` };
        }
        if (res.status === 404) return { ok: false, note: `table "${table}" does not exist` };
        return { ok: false, note: `Supabase answered ${res.status}` };
      } catch (err) {
        return { ok: false, note: err instanceof Error ? err.message : String(err) };
      }
    },

    async pull(since, signal) {
      const url = new URL(endpoint);
      url.searchParams.set("select", "*");
      url.searchParams.set("space", `eq.${cfg.space}`);
      url.searchParams.set("at", `gte.${Math.floor(since)}`);
      url.searchParams.set("order", "at.asc");
      // A cap, so a first sync against a large table cannot hang the desk.
      // The cursor advances, so the next run continues from where this stopped.
      url.searchParams.set("limit", "1000");

      const res = await fetchImpl(url.toString(), {
        headers: headers(),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) await explain(res, "sync pull");

      const rows = (await res.json()) as Row[];
      return rows.map(
        (r): SyncRecord => ({
          key: String(r.key),
          value: r.value,
          v: Number(r.v) || 1,
          at: Number(r.at) || 0,
          deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
          device: String(r.device ?? "unknown"),
        }),
      );
    },

    async push(records, signal) {
      if (records.length === 0) return;
      const rows: Row[] = records.map((r) => ({
        space: cfg.space,
        key: r.key,
        value: r.deletedAt === null ? r.value : null,
        v: r.v,
        at: r.at,
        deleted_at: r.deletedAt,
        device: r.device,
      }));

      // PostgREST upsert. Without `merge-duplicates` the second sync from the
      // same machine is a primary-key violation and every push after the first
      // fails.
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: headers({
          prefer: "resolution=merge-duplicates,return=minimal",
        }),
        body: JSON.stringify(rows),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) await explain(res, "sync push");
    },
  };
}

/**
 * Any endpoint that speaks the two-call sync protocol.
 *
 * For a self-hosted target, a Cloudflare Worker over KV, a small Flask app, or
 * a colleague's server. The contract is deliberately tiny — `GET ?since=` and
 * `POST {records}` — so that writing one is an afternoon rather than a project,
 * and so that "cloud" never means "one vendor".
 */
export function restAdapter(
  base: string,
  token?: string,
  fetchImpl: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a),
): SyncAdapter {
  const root = base.replace(/\/+$/, "");
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  return {
    id: "rest",
    label: "Custom endpoint",
    describe: () => root,

    async ping(signal) {
      try {
        const res = await fetchImpl(`${root}/sync/pull?since=0&limit=1`, {
          headers: headers(),
          ...(signal ? { signal } : {}),
        });
        return res.ok
          ? { ok: true, note: `reachable at ${root}` }
          : { ok: false, note: `answered ${res.status}` };
      } catch (err) {
        return { ok: false, note: err instanceof Error ? err.message : String(err) };
      }
    },

    async pull(since, signal) {
      const res = await fetchImpl(`${root}/sync/pull?since=${Math.floor(since)}`, {
        headers: headers(),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`sync pull: ${root} answered ${res.status}`);
      const body = (await res.json()) as unknown;
      const rows = Array.isArray(body) ? body : ((body as { records?: unknown[] })?.records ?? []);
      return (rows as SyncRecord[]).filter(
        (r) => r && typeof r.key === "string" && typeof r.at === "number",
      );
    },

    async push(records, signal) {
      const res = await fetchImpl(`${root}/sync/push`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ records }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) throw new Error(`sync push: ${root} answered ${res.status}`);
    },
  };
}
