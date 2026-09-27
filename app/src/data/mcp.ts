/**
 * The MCP engine's client — connecting this terminal to other platforms.
 *
 * `server/svc/mcp.py` speaks Streamable HTTP JSON-RPC to any MCP server and
 * `server/svc/mcpauth.py` signs in to the ones that need it. Both were built,
 * both were verified against live servers, and neither had a caller here — which
 * is this project's own rule turned on me: a capability nobody can see is a
 * capability nobody has. Twelve routes with no screen, measured by
 * `scratchpad/routes.py`, on a metric that had been driven to zero.
 *
 * EVERY FIGURE HERE IS NULLABLE BECAUSE THE SERVICE REFUSES HONESTLY.
 *
 * `/svc/claims/stats` returns `hitRate` as null for a population with nothing
 * decided, the client type said `number`, and `.toFixed()` on the null threw
 * inside `each` — losing whole tables while the data was demonstrably there.
 * These types are written from the shapes the routes actually return, and a
 * refusal is a named state rather than an absent one: `ok: false` always carries
 * a `why`, and `needsAuth` is a THIRD state distinct from both working and
 * broken, because "you have not signed in" is something the operator can fix.
 */

import { svcUrl } from "./backend";

/** A server on the operator's list. */
export interface McpServer {
  readonly name: string;
  readonly url: string;
  readonly added: number;
}

/** What a tool takes. `required` is a subset of `properties`. */
export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly required: readonly string[];
  readonly properties: readonly string[];
}

/**
 * Whether a server is signed in. NEVER carries a token — the server keeps those
 * and `tests/test_mcp_secrets.py` sweeps every route to prove it.
 */
export interface McpSignIn {
  readonly url: string;
  readonly name: string | null;
  readonly signedIn: boolean;
  readonly scope: string | null;
  readonly canRefresh: boolean;
  /** Seconds until the access token expires, or null when it does not say. */
  readonly expiresIn: number | null;
}

/** A refusal is a RESULT. It always names itself. */
export interface McpRefusal {
  readonly ok: false;
  readonly why: string;
  /** True when signing in would fix it — a third state, not a failure. */
  readonly needsAuth: boolean;
  readonly resourceMetadata?: string | null;
  /** Present when a key was refused rather than the whole request. */
  readonly refused?: readonly string[];
}

export interface McpHandshake {
  readonly ok: true;
  readonly url: string;
  readonly protocol: string;
  readonly name: string;
  readonly version: string | null;
}

export interface McpToolList {
  readonly ok: true;
  readonly count: number;
  readonly tools: readonly McpTool[];
}

export interface McpCallResult {
  readonly ok: true;
  readonly tool: string;
  readonly kinds: readonly string[];
  /** The tool's own words. PROSE, usually with JSON inside it — see below. */
  readonly text: string;
  readonly structured: unknown;
}

/** What a Connect press hands back: a URL for the OPERATOR to open. */
export interface McpConnect {
  readonly ok: true;
  readonly authorize: string;
  readonly state: string;
  readonly scopes: readonly string[];
  /** Scopes the server offered and this deliberately did not ask for. */
  readonly withheld: readonly string[];
}

/**
 * The list of servers the operator has added.
 *
 * DECLARED WITH `ok: true` BECAUSE THE UNION NEEDS A DISCRIMINANT. The first
 * draft used inline shapes and `Answer<{servers}>` could not be narrowed —
 * `probe.ok` is not even a legal read when one arm has no such field, and tsc
 * said so seven times. A hand-written client type has caused three defects in
 * this project already; this is the compiler catching the fourth before it ships.
 */
export interface McpServerList {
  readonly ok: true;
  readonly servers: readonly McpServer[];
}

export interface McpSignInList {
  readonly ok: true;
  /** Where sign-ins come back to — this terminal, on loopback. */
  readonly redirect: string;
  readonly servers: readonly McpSignIn[];
}

export interface McpSignOut {
  readonly ok: true;
  readonly revokedRemotely: boolean;
}

/**
 * THE OTHER DIRECTION: this terminal published AS an MCP server, so Claude
 * Desktop or another client can read what history is held, what the broker says
 * and how past reads worked out.
 *
 * `reach` is the field that matters and it is deliberately a SENTENCE, not a
 * boolean. The gateway has one optional secret; with none set this endpoint is
 * reachable by any process on the machine, exactly like `/svc/*`. An operator
 * deciding whether to turn this on needs that stated, and "secure: true" would
 * be a claim this product cannot make.
 */
export interface McpServeState {
  readonly ok: true;
  /** Off until the operator says otherwise — connecting a client is an egress path. */
  readonly on: boolean;
  readonly url: string;
  readonly tools: readonly McpTool[];
  /** What is deliberately NOT published, each with the argument against it. */
  readonly wontPublish: readonly { readonly name: string; readonly why: string }[];
  readonly tokenRequired: boolean;
  readonly reach: string;
  readonly clientConfig: unknown;
}

export interface McpServeSwitch {
  readonly ok: true;
  readonly on: boolean;
}

type Answer<T> = T | McpRefusal;

/**
 * One reader for every route here.
 *
 * A NETWORK FAILURE AND A REFUSAL ARE DIFFERENT FACTS and are both turned into
 * the same SHAPE so no caller has to remember which it is looking at — but the
 * wording keeps them apart. "Could not ask" is not "nothing there", which is the
 * distinction this project records rendering 0 for an unreachable service as the
 * most alarming possible way to say "fine".
 */
async function ask<T>(path: string, init?: RequestInit): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(svcUrl(path), init);
  } catch {
    return {
      ok: false,
      needsAuth: false,
      why: "the terminal's own server is not answering on this address, so nothing could be asked",
    };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      needsAuth: false,
      why: `the server answered ${res.status} with something that is not an answer`,
    };
  }
  const got = body as { ok?: boolean; why?: string; error?: string };
  if (got.ok === false) {
    return {
      ok: false,
      needsAuth: Boolean((body as { needsAuth?: boolean }).needsAuth),
      why: got.why ?? got.error ?? "the server refused and did not say why",
      resourceMetadata: (body as { resourceMetadata?: string | null }).resourceMetadata ?? null,
      ...((body as { refused?: readonly string[] }).refused
        ? { refused: (body as { refused: readonly string[] }).refused }
        : {}),
    };
  }
  return body as T;
}

const post = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

export const listServers = (): Promise<Answer<McpServerList>> =>
  ask("/svc/mcp/servers");

export const addServer = (name: string, url: string): Promise<Answer<McpServerList>> =>
  ask("/svc/mcp/add", post({ name, url }));

export const removeServer = (url: string): Promise<Answer<McpServerList>> =>
  ask("/svc/mcp/remove", post({ url }));

export const probeServer = (url: string): Promise<Answer<McpHandshake>> =>
  ask(`/svc/mcp/probe?url=${encodeURIComponent(url)}`);

export const listTools = (url: string): Promise<Answer<McpToolList>> =>
  ask(`/svc/mcp/tools?url=${encodeURIComponent(url)}`);

export const callTool = (
  url: string,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Answer<McpCallResult>> =>
  ask("/svc/mcp/call", post({ url, tool, arguments: args }));

export const signInStatus = (): Promise<Answer<McpSignInList>> =>
  ask("/svc/mcp/signin-status");

/**
 * Prepare a sign-in. Returns a URL; it does NOT open it.
 *
 * `allowWrite` is off unless the operator asks. The server withholds write
 * scopes by default — LunarCrush advertises `api.write`, and asking for it to
 * read sentiment would request permission to write to their account on a consent
 * screen where it is one word among three.
 */
export const connectServer = (
  url: string,
  resourceMetadata?: string | null,
  allowWrite = false,
): Promise<Answer<McpConnect>> =>
  ask("/svc/mcp/connect", post({ url, resourceMetadata, allowWrite }));

export const serveState = (): Promise<Answer<McpServeState>> =>
  ask("/svc/mcp/serve/state");

/** Turn this terminal's own MCP server on or off. The operator's decision. */
export const setServe = (on: boolean): Promise<Answer<McpServeSwitch>> =>
  ask("/svc/mcp/serve/enable", post({ on }));

export const signOut = (url: string): Promise<Answer<McpSignOut>> =>
  ask("/svc/mcp/signout", post({ url }));

/* ------------------------------------------------------------------ pure -- */

/**
 * Find the JSON inside a tool's PROSE, or say there is none.
 *
 * AN MCP TOOL ANSWERS A LANGUAGE MODEL, so its text is model-facing prose with
 * the data embedded. MEASURED on a live server:
 *
 *     Here is the Crypto.com Exchange candlestick data {"instrument_name":...}
 *
 * `JSON.parse` on that throws, and it threw on the first real call the engine
 * ever made. The server has the same function for the same reason; this one
 * exists so the card can OFFER a parsed view without pretending the prose is a
 * contract. It refuses rather than repairing — that wording can change without
 * notice and there is no schema behind it.
 */
export function embeddedJson(text: string): { readonly data: unknown; readonly prose: string } | null {
  if (!text) return null;
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  const start =
    brace < 0 ? bracket : bracket < 0 ? brace : Math.min(brace, bracket);
  if (start < 0) return null;
  // Walk back from the end: the payload is the LONGEST suffix that parses, which
  // costs nothing at these sizes and needs no brace counting to get wrong.
  for (let end = text.length; end > start; end -= 1) {
    const slice = text.slice(start, end);
    const last = slice[slice.length - 1];
    if (last !== "}" && last !== "]") continue;
    try {
      const data: unknown = JSON.parse(slice);
      return { data, prose: (text.slice(0, start) + text.slice(end)).trim() };
    } catch {
      /* keep shrinking */
    }
  }
  return null;
}

/**
 * How a server's state should read. ONE OWNER, because three surfaces ask.
 *
 * The three states are deliberately distinct: a server that needs signing in is
 * not broken, and filing it with the failures buries the ones that are — the
 * same distinction as "waiting for a key only you can supply" in the job list.
 */
export type McpState = "connected" | "needs-sign-in" | "refused" | "unknown";

export function stateOf(
  probe: Answer<McpHandshake> | null,
  signedIn: boolean,
): { readonly state: McpState; readonly detail: string } {
  if (probe === null) return { state: "unknown", detail: "not checked yet" };
  if (probe.ok) {
    return {
      state: "connected",
      detail: signedIn
        ? `signed in, speaking ${probe.protocol}`
        : `speaking ${probe.protocol}, no sign-in needed`,
    };
  }
  if (probe.needsAuth) {
    return { state: "needs-sign-in", detail: probe.why };
  }
  return { state: "refused", detail: probe.why };
}

/** A tool's arguments, as a one-line hint. Empty when it takes none. */
export function argHint(tool: McpTool): string {
  if (tool.properties.length === 0) return "takes nothing";
  const req = new Set(tool.required);
  return tool.properties.map((p) => (req.has(p) ? p : `${p}?`)).join(", ");
}
