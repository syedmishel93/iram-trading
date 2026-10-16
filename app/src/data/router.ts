/**
 * Client for the router — `server/svc/router.py`, behind the gateway.
 *
 * WHY THE BROWSER SENDS THE LEDGER RATHER THAN THE SERVER BUILDING IT
 * Because the labels have to come from the engine that will trade on them.
 * `backtest/ledger.ts` prices with `modelledFill` and the same costs the
 * backtest used; a server that rebuilt the ledger from its own bars would be a
 * second implementation of "what would this setup have done", and the first
 * time the two disagreed there would be no way to tell which the strategy's
 * expectancy had been measured with.
 *
 * THREE OUTCOMES, NOT A NULLABLE ONE — the shape `data/quant.ts` argues for:
 *
 *   ok       — a report, which may itself say the model learned nothing
 *   refused  — a REASON, verbatim, and a finding worth showing
 *   offline  — the service is not answering; nothing is known either way
 *
 * A report with `skill: false` is a SUCCESS of this call and a failure of the
 * model, and those must not look alike. "No skill" is the most common honest
 * answer a router can give, and a client that folded it into an error would
 * make the system look broken every time it was being truthful.
 */

import { svcUrl } from "./backend";

/** One bucket of the reliability curve. */
export interface CalibrationBucket {
  readonly from: number;
  readonly to: number;
  readonly n: number;
  readonly predicted: number;
  readonly observed: number;
}

export interface FoldSpan {
  readonly trainFrom: number;
  readonly trainTo: number;
  readonly testFrom: number;
  readonly testTo: number;
  readonly trainRows: number;
  readonly testRows: number;
}

export interface RouterReport {
  readonly ok: boolean;
  readonly why: string;
  readonly rows: number;
  readonly scored: number;
  readonly auc: number;
  readonly accuracy: number;
  readonly baseRate: number;
  readonly lift: number;
  /** Whether it beat the base rate out of sample by more than its own noise. */
  readonly skill: boolean;
  readonly folds: number;
  readonly timeOrdered: boolean;
  readonly foldSpans: readonly FoldSpan[];
  readonly calibration: readonly CalibrationBucket[];
  readonly suggestedThreshold: number;
  readonly thresholdBasis: string;
  readonly features: readonly string[];
}

export type RouterResult =
  | { readonly kind: "ok"; readonly report: RouterReport }
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "offline"; readonly why: string };

/** A ledger row as the service reads it. */
export interface RouterRow {
  readonly t: number;
  readonly outcome: string;
  readonly features: Readonly<Record<string, number>>;
}

/**
 * Fit and score a router over these candidates.
 *
 * `minRows` is the service's business and is not sent unless a caller means to
 * lower it, because a caller that lowered it silently would be asking for the
 * one thing the service exists to refuse.
 */
export async function trainRouter(
  rows: readonly RouterRow[],
  opts: { readonly minRows?: number; readonly signal?: AbortSignal } = {},
): Promise<RouterResult> {
  const url = svcUrl("/svc/router/train");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidates: rows,
        ...(opts.minRows !== undefined ? { minRows: opts.minRows } : {}),
      }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    /* Addressed to the operator, not the developer: they can start the
       service, and they cannot do anything with a TypeError. */
    return { kind: "offline", why: `the router is not answering on ${url}` };
  }

  if (!res.ok) {
    return { kind: "offline", why: `the router answered ${res.status} on ${url}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* An HTML body here means something else is on this address — the exact
       shape that once had the news bar reporting a service that was up. */
    return { kind: "offline", why: `the router did not answer with a report on ${url}` };
  }

  const r = body as Partial<RouterReport>;
  if (typeof r !== "object" || r === null || typeof r.ok !== "boolean") {
    return { kind: "offline", why: `the router's answer was not a report` };
  }
  if (!r.ok) {
    return { kind: "refused", why: r.why || "the router refused without saying why" };
  }
  return { kind: "ok", report: body as RouterReport };
}
