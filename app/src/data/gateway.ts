/**
 * One question to the backend: are you there, and what of you is working?
 *
 * THE PROBLEM THIS SOLVES IS A DIAGNOSTIC ONE
 * Before the gateway, the terminal learned about the backend the way it learns
 * about anything else — by a request failing. Nine desks addressed three
 * processes, so a backend that was half up produced nine unrelated-looking
 * faults: bars fine, journal dead, quant dead, news dead. The operator's
 * information was a console full of `ERR_CONNECTION_REFUSED` with no host
 * attached to any of them, and the correct action ("start the service") was
 * nowhere in that evidence.
 *
 * `/api/health` answers for all of it at once, and names what each missing
 * piece costs.
 *
 * WHY THE THREE OUTCOMES ARE KEPT APART
 * "Not running", "running but a service failed to import", and "answering
 * something that is not this API" need three different responses from a human,
 * and collapsing them into `ok: false` is how a missing `pip install` gets
 * diagnosed as a firewall problem for an hour. So:
 *
 *   unreachable  nothing is listening        -> start it
 *   degraded     up, a service did not load  -> install that dependency
 *   foreign      up, but not our API         -> something else owns this port
 *   ok           all three loaded
 *
 * `foreign` is not paranoia. :8787 is a popular port, and the failure it
 * produces otherwise — a 200 that parses to nothing useful — is the one most
 * likely to be read as "the gateway is broken".
 */

import { gatewayBase } from "./backend";

export type GatewayState = "ok" | "degraded" | "unreachable" | "foreign";

export interface GatewayService {
  readonly name: string;
  readonly ok: boolean;
  readonly error: string | null;
  /** What stops working without it — shown instead of a stack trace. */
  readonly provides: string;
}

export interface GatewayHealth {
  readonly state: GatewayState;
  readonly base: string;
  readonly version: string;
  readonly services: readonly GatewayService[];
  /** Whether the eleven service loops are running. */
  readonly background: boolean;
  /** Round trip in ms, or 0 when it never answered. */
  readonly latencyMs: number;
  /** One sentence naming the next action. Empty when `state` is `ok`. */
  readonly advice: string;
}

export const UNREACHABLE: GatewayHealth = {
  state: "unreachable",
  base: "",
  version: "",
  services: [],
  background: false,
  latencyMs: 0,
  /* run.py, not `python -m gateway`: the gateway alone starts with
     IRAM_BACKGROUND unset, and the eleven service loops (alerts, backups, the
     dead-man's heartbeat) silently never run — CLAUDE.md's own finding. */
  advice: "No backend. Start the terminal with python run.py.",
};

/**
 * Ask the gateway how it is.
 *
 * Never throws and never rejects. This is called to render a status line, and
 * a status line that can throw is a status line that takes the desk with it
 * when the thing it reports on is down — which is exactly when it is read.
 */
export async function probeGateway(
  base = gatewayBase(),
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<GatewayHealth> {
  const started = now();
  let payload: unknown;
  try {
    const response = await fetchImpl(`${base}/api/health`, {
      headers: { accept: "application/json" },
    });
    // A 5xx from the gateway is still the gateway answering, and its body says
    // which service is at fault. Only a thrown fetch means nothing is there.
    payload = await response.json();
  } catch {
    return { ...UNREACHABLE, base };
  }
  const latencyMs = Math.round(now() - started);

  if (typeof payload !== "object" || payload === null || !("services" in payload)) {
    return {
      state: "foreign",
      base,
      version: "",
      services: [],
      background: false,
      latencyMs,
      advice: `Something is listening on ${base}, but it is not the IRAM gateway.`,
    };
  }

  const body = payload as Record<string, unknown>;
  const rawServices = (body["services"] ?? {}) as Record<string, Record<string, unknown>>;

  const services: GatewayService[] = Object.entries(rawServices).map(([name, value]) => ({
    name,
    ok: value["ok"] === true,
    error: typeof value["error"] === "string" ? value["error"] : null,
    provides: typeof value["provides"] === "string" ? value["provides"] : "",
  }));

  const background = ((body["background"] ?? {}) as Record<string, unknown>)["enabled"] === true;
  const down = services.filter((s) => !s.ok);

  return {
    state: down.length === 0 ? "ok" : "degraded",
    base,
    version: typeof body["version"] === "string" ? body["version"] : "",
    services,
    background,
    latencyMs,
    advice: down.length === 0 ? "" : adviceFor(down),
  };
}

/**
 * What to do about the services that did not load.
 *
 * Names the cost before the remedy. "Install scipy" is an instruction; "the
 * quant desk is dark until you install scipy" is a reason, and the operator
 * gets to decide whether they wanted that desk today.
 */
function adviceFor(down: readonly GatewayService[]): string {
  const list = down.map((s) => `${s.name} (${s.provides || "unknown"})`).join("; ");
  return `Running, but ${down.length} of 3 services failed to load — ${list}. Try: pip install -r server/requirements.txt`;
}

/** A short label for a status pill. */
export function healthLabel(health: GatewayHealth): string {
  switch (health.state) {
    case "ok":
      return health.background ? "BACKEND · LOOPS ON" : "BACKEND";
    case "degraded":
      return `BACKEND · ${health.services.filter((s) => !s.ok).length} DOWN`;
    case "foreign":
      return "PORT TAKEN";
    case "unreachable":
      return "NO BACKEND";
  }
}

/**
 * Tone for that pill.
 *
 * `unreachable` is deliberately NOT an error tone. The terminal is designed to
 * work with no backend at all — bars come from Binance directly and the desks
 * that need Python say so themselves. Painting the normal case red trains the
 * operator to ignore the indicator, which costs them the one time it is
 * `degraded` and actually means something.
 */
export function healthTone(health: GatewayHealth): "good" | "warn" | "mute" {
  if (health.state === "ok") return "good";
  if (health.state === "unreachable") return "mute";
  return "warn";
}
