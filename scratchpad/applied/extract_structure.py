"""Move the detection-derivation block out of mountShell into ui/model/structure.ts.

The text is moved programmatically rather than retyped, per CLAUDE.md's
extraction procedure step 3 — every comment in it was written where the code
lived and carries across verbatim.
"""
import pathlib

SRC = pathlib.Path(
    r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\app\src"
)

HEADER = '''/**
 * What the detectors found on this chart, and what survives to be drawn.
 *
 * WHY IT IS ITS OWN FILE
 * `mountShell` was one function of 6,837 lines holding 185 declarations, and
 * every extraction attempted since v50 was refused by the repository's own
 * rule — more than ten siblings means the coupling has been moved into a
 * signature rather than removed. That refusal is a property of the SHAPE, not
 * of the sections: when state, derivation, DOM and effects share one closure,
 * "sibling" means "any of the other 184 locals".
 *
 * This is the first piece of the model layer that fixes it. It is pure
 * derivation — eight `computed`s over the bars, the enabled detectors and the
 * operator's filters, with no DOM and no effects — and it borrows FIVE things
 * from its siblings. That number is the argument for the split.
 *
 * WHAT DID NOT CHANGE
 * Nothing about the behaviour, and not one comment. The notes below on why
 * detection reads CLOSED bars only, why `detectData` peeks at `bars` but
 * depends on the loaded symbol and timeframe, why the alert engine gets a
 * different set from the chart, and why the draw cap is per kind AND
 * timeframe were all written against this code and are carried across as
 * they stood.
 */

import { computed, type ReadSignal } from "../../core/signal";
import { DETECTOR_FOR_KIND, runDetectors, toDetectInput } from "../../detect";
import { detectHigher } from "../../detect/mtf";
import type { Detection, DetectInput } from "../../detect/types";
import type { BarView } from "../../chart/series";
import { requiredDetectors, type createAlertStore } from "../../alert/store";
import { densityFactor } from "../detectpanel";
import type { ShellContext } from "../shell/context";

/**
 * What this model borrows from its siblings.
 *
 * Five, all owned elsewhere in the shell. `state` and `feed` are foundation
 * and arrive on the context instead — which is exactly why the list is five
 * and not seven.
 */
export interface StructureModelDeps {
  /** The chart's bars, replay-aware. */
  readonly bars: ReadSignal<readonly BarView[]>;
  /** The operator's confidence floor, from the detector popover. */
  readonly detectMinConfidence: ReadSignal<number>;
  /** How crowded the chart may get: "focused" | "standard" | "everything". */
  readonly detectDensity: ReadSignal<string>;
  /** "long" | "short" | "both". */
  readonly detectDirection: ReadSignal<string>;
  /** Armed alerts decide which detectors must keep running. */
  readonly alertStore: ReturnType<typeof createAlertStore>;
}

/**
 * Build the model.
 *
 * The return type is INFERRED. A hand-written one was rejected by the compiler
 * on the first attempt at the palette section and a hand-written sibling type
 * has now caused three defects here; `ReturnType<typeof createStructureModel>`
 * cannot drift from this because it is a reference to it.
 */
export function createStructureModel(ctx: ShellContext, deps: StructureModelDeps) {
  const { state, feed } = ctx;
  const { bars, detectMinConfidence, detectDensity, detectDirection, alertStore } = deps;

'''

FOOTER = '''
  return {
    closedBarCount,
    detectData,
    detections,
    alertDetections,
    passesFilters,
    filteredOut,
    drawn,
    detectCounts,
  };
}
'''

CALL = '''  /**
   * Detections, filters and the draw cap — `ui/model/structure.ts`.
   *
   * Moved out whole (v56). Eight derived reads that had no DOM and no effects
   * in them, over five siblings. Destructured here so every call site below is
   * unchanged, which is what makes the move reviewable as a move.
   */
  const {
    closedBarCount,
    detectData,
    detections,
    alertDetections,
    passesFilters,
    filteredOut,
    drawn,
    detectCounts,
  } = createStructureModel(ctx, {
    bars,
    detectMinConfidence,
    detectDensity,
    detectDirection,
    alertStore,
  });
'''

START, END = 962, 1176  # 1-indexed, inclusive


def main() -> None:
    p = SRC / "ui" / "shell.ts"
    raw = p.read_text(encoding="utf-8")
    crlf = "\r\n" in raw
    lines = raw.replace("\r\n", "\n").split("\n")

    block = lines[START - 1 : END]
    assert "const closedBarCount" in block[19], block[19]
    assert block[-1].strip() == "", repr(block[-1])
    assert "detectCounts" in "\n".join(block[-12:]), "tail is not detectCounts"

    out = SRC / "ui" / "model"
    out.mkdir(exist_ok=True)
    (out / "structure.ts").write_text(
        HEADER + "\n".join(block).rstrip() + "\n" + FOOTER,
        encoding="utf-8",
        newline="\r\n" if crlf else "\n",
    )

    rest = lines[: START - 1] + CALL.split("\n") + lines[END:]
    body = "\n".join(rest)
    anchor = 'import { createWatchRail } from "./watchrail";'
    assert body.count(anchor) == 1
    body = body.replace(
        anchor,
        anchor + '\nimport { createStructureModel } from "./model/structure";',
    )
    p.write_text(body, encoding="utf-8", newline="\r\n" if crlf else "\n")
    print("moved %d lines into ui/model/structure.ts" % len(block))


main()
