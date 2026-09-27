// @vitest-environment jsdom
/**
 * The knowledge base's line on the Setup card.
 *
 * THE PROPERTY THAT MATTERS IS "BESIDE", NOT "INSTEAD OF".
 * The point of the second line is that the card carries two different pieces of
 * evidence about one setup — this chart's window replayed now, and everything
 * ever harvested, sliced by condition — and that they are allowed to disagree.
 * A change that quietly replaced the first with the second would pass any test
 * that only looked for the new text, so every case below asserts the OLD line
 * is still there too.
 */

import { describe, expect, it } from "vitest";
import { renderHistory, type SetupHistory } from "../src/setup/ui";
import type { KnowledgePrior } from "../src/learn/knowledge";

const HIST: SetupHistory = {
  note: "23 of 51 reached target — 45%, at least 32% with 95% confidence, +0.37R per attempt at 2R.",
  n: 51,
  wins: 23,
  hitRate: 23 / 51,
  hitLow: 0.32,
  expectancy: 0.37,
  breakEven: 1 / 3,
  medianBars: 8,
  enough: true,
  adverse: false,
  bars: 5900,
  canDeepen: false,
  busy: false,
  progress: "",
  disagreement: "",
  alternatives: [],
  fieldNote: "",
};

const PRIOR: KnowledgePrior = {
  standing: "usable",
  cell: null,
  axis: "regime",
  stale: false,
  line:
    "In this regime here: 23 of 51, at least 32%, +0.37R per attempt — " +
    "from replays of 5,900 bars, last updated 2h ago.",
};

const noop = (): void => undefined;

describe("the Setup card's second line", () => {
  it("renders the base's line beneath the replay, without displacing it", () => {
    const el = renderHistory({ ...HIST, prior: PRIOR }, noop);

    const replay = el.querySelector(".setup-hist-note");
    const prior = el.querySelector(".setup-hist-prior");
    expect(replay?.textContent).toBe(HIST.note);
    expect(prior?.textContent).toBe(PRIOR.line);

    /* Order, checked in the DOM rather than assumed: the in-sample replay is
       the card's own read and the base qualifies it, so it cannot come first. */
    expect(replay?.compareDocumentPosition(prior as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    /* And the strip is still the strip: the sample chip survives. */
    expect(el.querySelector(".setup-hist-stats")?.textContent).toContain("51");
  });

  it("shows nothing at all when the base has nothing", () => {
    const el = renderHistory(
      { ...HIST, prior: { standing: "none", cell: null, axis: "", line: "", stale: false } },
      noop,
    );
    expect(el.querySelector(".setup-hist-prior")).toBeNull();
    /* A row that says "no data" on every render trains people to skip the
       strip it lives in. */
    expect(el.querySelector(".setup-hist-note")?.textContent).toBe(HIST.note);
  });

  it("shows nothing when the shell has not passed a prior at all", () => {
    const el = renderHistory(HIST, noop);
    expect(el.querySelector(".setup-hist-prior")).toBeNull();
  });

  it("marks a thin prior as thin and a stale one as stale", () => {
    const thin = renderHistory(
      {
        ...HIST,
        prior: {
          standing: "thin",
          cell: null,
          axis: "regime",
          stale: false,
          line: "In this regime here: only 7 trials harvested, under the 12 needed before a rate means anything.",
        },
      },
      noop,
    ).querySelector(".setup-hist-prior");
    expect(thin?.getAttribute("data-standing")).toBe("thin");
    expect(thin?.getAttribute("data-stale")).toBe("false");

    const stale = renderHistory({ ...HIST, prior: { ...PRIOR, stale: true } }, noop).querySelector(
      ".setup-hist-prior",
    );
    expect(stale?.getAttribute("data-stale")).toBe("true");
  });
});
