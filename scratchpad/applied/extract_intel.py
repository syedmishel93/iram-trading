"""Move the on-demand model layer out of mountShell into ui/model/intel.ts."""
import pathlib

SRC = pathlib.Path(
    r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\app\src"
)

HEADER = '''/**
 * The model layer, asked on demand: the regime read and the walk-forward
 * classifier, their busy flag, when they last answered usefully, and the rule
 * that a change of instrument invalidates both.
 *
 * WHY IT IS ITS OWN FILE, AND WHY IT IS ONE SIBLING
 * Five signals and one async function that touch nothing in the shell except
 * the bars they are asked about and the symbol/timeframe that invalidate them.
 * `state` is foundation; `bars` is the single sibling. That is as decoupled as
 * anything in `mountShell` gets, and it had no reason to be inside a
 * 6,800-line closure other than that everything else was.
 *
 * THE TWO NOTES IN HERE ARE BOTH SCARS AND BOTH CARRY ACROSS VERBATIM: why a
 * second caller JOINS the in-flight run rather than being dropped, and why
 * `intelAnsweredAt` tests for a USABLE answer rather than for a non-null
 * signal — `IntelResult<T>` is `T | { ok: false, error }`, so a service that
 * is down still lands a value.
 */

import { effect, signal, type ReadSignal } from "../../core/signal";
import { createIntel, type ForecastRead, type IntelResult, type RegimeRead } from "../../data/intel";
import type { BarView } from "../../chart/series";
import type { ShellContext } from "../shell/context";

/** What the model layer borrows from its siblings. One. */
export interface IntelModelDeps {
  /** The bars the models are asked about, replay-aware. */
  readonly bars: ReadSignal<readonly BarView[]>;
}

/** Build the model layer. Return type inferred, per the extraction procedure. */
export function createIntelModel(ctx: ShellContext, deps: IntelModelDeps) {
  const { state } = ctx;
  const { bars } = deps;

'''

FOOTER = '''
  return { intel, regime, forecast, intelBusy, intelAnsweredAt, runIntel };
}
'''

CALL = '''  /**
   * The model layer, asked on demand — `ui/model/intel.ts`.
   *
   * Both models are seconds of server CPU, so nothing here runs on a tick or on
   * a symbol change — it runs when you press the button, and the panel says so.
   *
   * Constructed HERE rather than lower down because the Setup card and the
   * evidence supervisor both read these signals and both are built above the
   * point the old declarations sat at. The same temporal-dead-zone rule the
   * declarations around this one carry.
   */
  const { intel, regime, forecast, intelBusy, intelAnsweredAt, runIntel } =
    createIntelModel(ctx, { bars });
'''

P1 = (807, 816)
P2 = (902, 945)


def main() -> None:
    p = SRC / "ui" / "shell.ts"
    raw = p.read_text(encoding="utf-8")
    crlf = "\r\n" in raw
    lines = raw.replace("\r\n", "\n").split("\n")

    b1 = lines[P1[0] - 1 : P1[1]]
    b2 = lines[P2[0] - 1 : P2[1]]
    assert "const intelBusy" in b1[-1], b1[-1]
    assert any("When the model lanes last produced" in l for l in b2[:6]), b2[:6]
    assert b2[-1].strip() == "});", b2[-1]

    # Drop the moved block's own section comment: the file header now says it.
    while b1 and not b1[0].lstrip().startswith("const"):
        b1.pop(0)

    moved = "\n".join(b1).rstrip() + "\n\n" + "\n".join(b2).rstrip()
    (SRC / "ui" / "model" / "intel.ts").write_text(
        HEADER + moved + "\n" + FOOTER,
        encoding="utf-8",
        newline="\r\n" if crlf else "\n",
    )

    rest = (
        lines[: P1[0] - 1]
        + CALL.split("\n")
        + lines[P1[1] : P2[0] - 1]
        + lines[P2[1] :]
    )
    body = "\n".join(rest)
    anchor = 'import { createAnalystModel } from "./model/analyst";'
    assert body.count(anchor) == 1
    body = body.replace(
        anchor, anchor + '\nimport { createIntelModel } from "./model/intel";'
    )
    p.write_text(body, encoding="utf-8", newline="\r\n" if crlf else "\n")
    print("moved %d lines into ui/model/intel.ts" % (len(b1) + len(b2)))


main()
