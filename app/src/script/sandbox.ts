/**
 * User-authored indicators, run where they cannot reach anything.
 *
 * WHY A LANGUAGE WAS NOT INVENTED FOR THIS
 * The obvious move is a small expression language: safe by construction,
 * nothing to escape from. It is also a year of work to reach the point where
 * someone can write a rolling percentile, and the people who want custom
 * indicators here already write code for a living. So the language is
 * JavaScript, the data is the six `Float64Array` columns the chart already
 * holds, and the safety comes from WHERE it runs rather than from what it can
 * say.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE ISOLATION ACTUALLY IS, AND WHAT IT IS NOT
 *
 * The script runs in a Worker created from a `blob:` URL, and the first thing
 * that Worker does — before any user code is compiled — is delete the globals
 * that reach the outside world: `fetch`, `XMLHttpRequest`, `WebSocket`,
 * `importScripts`, `indexedDB`, `caches`, `Notification`. A Worker has no DOM,
 * no `localStorage` and no access to this page's variables to begin with.
 *
 * This is a REAL boundary for the things it covers: a script cannot exfiltrate
 * your bars, cannot read your API keys, cannot write to your archive, and
 * cannot hang the interface, because it is not on the interface's thread.
 *
 * It is NOT a defence against a determined attacker running code you chose to
 * paste. A Worker shares the origin; a sufficiently clever script could still
 * spin the CPU inside its timeout or allocate until it is killed. The threat
 * model is "an indicator someone shared that has a bug or a surprise in it",
 * not "hostile code with a browser exploit". Saying which one is covered is
 * more useful than implying both are.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE RULES THE PROTOCOL ENFORCES
 *
 *  1. **A deadline.** Every run is raced against a timer and the Worker is
 *     TERMINATED when it expires, not asked politely to stop — a `while(1)` in
 *     a user script has no other remedy, and without this the feature ships an
 *     easy way to hang the tab.
 *  2. **One Worker per run.** Terminating is the only reliable way to stop
 *     runaway code, so a Worker cannot be reused across runs; a pool would trade
 *     the one guarantee that matters for a few milliseconds of startup.
 *  3. **Length is checked, not trusted.** A script returning 900 values for an
 *     800-bar series would be drawn misaligned with the price it claims to
 *     describe — an indicator that is subtly wrong about WHEN, which is worse
 *     than one that fails.
 */

/** What a script is handed, and what it must return. */
export interface ScriptResult {
  ok: boolean;
  /** One line per plotted series, same length as the input bars. */
  lines: { id: string; values: number[]; color?: string; dash?: number[] }[];
  /** Milliseconds the Worker spent, for the editor's feedback. */
  ms: number;
  /** Empty when `ok`. A message meant for whoever wrote the script. */
  error: string;
}

export interface ScriptBars {
  t: Float64Array;
  o: Float64Array;
  h: Float64Array;
  l: Float64Array;
  c: Float64Array;
  v: Float64Array;
}

/**
 * How long a script may run before it is killed.
 *
 * Generous for the work — a rolling regression over 5,000 bars is a few
 * milliseconds — and short enough that a mistake is a message rather than a
 * pause. The chart redraws at 60fps beside it; a second of nothing is already
 * a long time to wonder whether it worked.
 */
export const SCRIPT_TIMEOUT_MS = 2_000;

/** Most values a script may return per line. Guards a runaway allocation. */
const MAX_POINTS = 200_000;

/**
 * The Worker's own source.
 *
 * Written as a string rather than a separate module because it must be created
 * from a Blob: a bundled Worker file would be fetched by URL, and the whole
 * artefact is one self-contained `index.html` with nothing to fetch.
 *
 * The `delete` list runs FIRST, in its own scope, before the user's function is
 * ever constructed. Ordering is the entire security property here.
 */
const WORKER_SOURCE = String.raw`
  // Captured before the doors close: the sandbox deletes postMessage so a
  // script cannot talk back on the channel, but the harness still needs it.
  const reply = self.postMessage.bind(self);
  // --- close the doors, before anything else exists -----------------------
  //
  // WHY THIS IS NOT delete self.fetch.
  // That was the first version and it silently did nothing. In a Worker,
  // fetch, indexedDB and friends are accessors on WorkerGlobalScope's
  // PROTOTYPE, not own properties of self — and delete on a property the
  // object does not own returns true and removes nothing. The sandbox reported
  // itself closed while a script could still reach the network with the bars.
  //
  // So: walk the whole prototype chain removing what is configurable, THEN
  // pin an own property of undefined that is neither writable nor
  // configurable. The pin is what stops a script restoring the accessor from
  // a prototype it can still name.
  for (const name of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts",
    "indexedDB", "caches", "Notification", "BroadcastChannel", "SharedWorker",
    "Worker", "navigator", "crypto", "postMessage", "close",
  ]) {
    for (let o = self; o; o = Object.getPrototypeOf(o)) {
      const d = Object.getOwnPropertyDescriptor(o, name);
      if (d && d.configurable) { try { delete o[name]; } catch (e) {} }
    }
    try {
      Object.defineProperty(self, name, {
        value: undefined, writable: false, configurable: false, enumerable: false,
      });
    } catch (e) { /* already non-configurable and not ours to change */ }
  }

  self.onmessage = (event) => {
    const { source, bars, params } = event.data;
    const started = Date.now();
    try {
      // Named arguments only. The script gets the columns, its parameters and
      // a tiny helper set — and nothing else by name.
      const fn = new Function(
        "bars", "params", "helpers",
        '"use strict";\n' + source + "\n"
      );

      const helpers = {
        sma(src, period) {
          const out = new Array(src.length).fill(NaN);
          let sum = 0;
          for (let i = 0; i < src.length; i++) {
            sum += src[i];
            if (i >= period) sum -= src[i - period];
            if (i >= period - 1) out[i] = sum / period;
          }
          return out;
        },
        ema(src, period) {
          const out = new Array(src.length).fill(NaN);
          const k = 2 / (period + 1);
          let prev = NaN;
          for (let i = 0; i < src.length; i++) {
            const v = src[i];
            prev = Number.isFinite(prev) ? v * k + prev * (1 - k) : v;
            if (i >= period - 1) out[i] = prev;
          }
          return out;
        },
        // NaN is how a warm-up region is drawn as a GAP rather than as a line
        // sloping in from zero. Scripts need a name for it that is not magic.
        nan: NaN,
      };

      const raw = fn(bars, params, helpers);
      reply({ ok: true, lines: normalise(raw), ms: Date.now() - started });
    } catch (err) {
      reply({
        ok: false,
        lines: [],
        ms: Date.now() - started,
        error: String((err && err.message) || err),
      });
    }
  };

  // A script may return one array, an array of arrays, or an array of
  // {id, values}. All three are reasonable things to write and the difference
  // is not worth a documentation page.
  function normalise(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) && !Array.isArray(raw[0]) && typeof raw[0] !== "object"
      ? [raw]
      : Array.isArray(raw) ? raw : [raw];
    return list.map((entry, i) => {
      const values = Array.isArray(entry) ? entry : entry && entry.values;
      if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
        throw new Error("line " + i + " has no values array");
      }
      return {
        id: (entry && entry.id) || ("line" + (i + 1)),
        values: Array.from(values, Number),
        color: entry && entry.color,
        dash: entry && entry.dash,
      };
    });
  }
`;

/**
 * Run `source` over `bars`.
 *
 * Never throws and never rejects: a syntax error in someone's indicator is an
 * ordinary outcome of this function, not an exception for the caller to handle.
 */
export async function runScript(
  source: string,
  bars: ScriptBars,
  params: Record<string, number> = {},
  timeoutMs = SCRIPT_TIMEOUT_MS,
): Promise<ScriptResult> {
  const failed = (error: string, ms = 0): ScriptResult => ({ ok: false, lines: [], ms, error });

  if (typeof Worker === "undefined" || typeof Blob === "undefined") {
    return failed("This browser has no Worker support, so scripts cannot be run safely here.");
  }

  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
  const worker = new Worker(url);
  const started = performance.now();

  return new Promise<ScriptResult>((resolve) => {
    let settled = false;
    const finish = (result: ScriptResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(result);
    };

    const timer = setTimeout(() => {
      /* Terminated, not asked. A script in an infinite loop never reaches a
         message handler, so cooperation is not available as a mechanism. */
      finish(
        failed(
          `Script exceeded ${timeoutMs} ms and was stopped. An unbounded loop is the usual cause.`,
          timeoutMs,
        ),
      );
    }, timeoutMs);

    worker.onerror = (e) => finish(failed(e.message || "Script failed to load."));
    worker.onmessage = (e: MessageEvent) => {
      const data = e.data as ScriptResult;
      const ms = Math.round(performance.now() - started);
      if (!data?.ok) {
        finish(failed(data?.error || "Script failed.", ms));
        return;
      }
      const checked = checkLines(data.lines, bars.c.length);
      finish(checked.error ? failed(checked.error, ms) : { ok: true, lines: checked.lines, ms, error: "" });
    };

    /* Copied, not transferred. Transferring would detach the arrays from the
       chart that is still drawing them — the series would empty mid-frame. */
    worker.postMessage({
      source,
      bars: {
        t: Array.from(bars.t),
        o: Array.from(bars.o),
        h: Array.from(bars.h),
        l: Array.from(bars.l),
        c: Array.from(bars.c),
        v: Array.from(bars.v),
      },
      params,
    });
  });
}

/**
 * The returned lines must be index-aligned with the series.
 *
 * `chart/engine.ts` states the contract: same length as the series, NaN in the
 * warm-up. A shorter or longer array is not a smaller mistake — it is an
 * indicator drawn against the wrong bars, which looks entirely plausible and
 * is wrong about WHEN.
 */
function checkLines(
  lines: ScriptResult["lines"],
  length: number,
): { lines: ScriptResult["lines"]; error: string } {
  if (lines.length === 0) {
    return { lines, error: "Script returned nothing to plot. Return an array of numbers." };
  }
  for (const line of lines) {
    if (line.values.length > MAX_POINTS) {
      return { lines: [], error: `Line "${line.id}" returned ${line.values.length} values — over the ${MAX_POINTS} cap.` };
    }
    if (line.values.length !== length) {
      return {
        lines: [],
        error:
          `Line "${line.id}" returned ${line.values.length} values for ${length} bars. ` +
          `Every line must be the same length as the series, with NaN through the warm-up — ` +
          `otherwise it is plotted against the wrong bars.`,
      };
    }
  }
  return { lines, error: "" };
}
