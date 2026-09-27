/**
 * THE ACTIVITY LABELS — two jobs must not answer to one name.
 *
 * MEASURED ON SCREEN: "Economic calendar" appeared twice in the failing list,
 * once with "224 of 224 failed" and once with "41 of 41 failed". They are
 * different jobs wanting different things from the operator — a ForexFactory
 * RSS feed whose URL has moved (404) and the main calendar store being rate
 * limited (429) — and two identical rows made them indistinguishable.
 *
 * Same family as CLAUDE.md's "two lists that name a group for the same thing
 * will disagree, and nothing will say so": there, two lists disagreed about one
 * desk; here, one list agreed too much about two jobs.
 */

import { describe, it, expect } from "vitest";
import { activityLabel, activityJobs } from "../src/data/activity";

describe("activityLabel", () => {
  it("gives every JOB a name of its own", () => {
    /* Kinds may share a label — a job's success and its failure are one job.
       Two different JOBS sharing one is the defect. */
    const seen = new Map<string, number>();
    for (const j of activityJobs()) seen.set(j.label, (seen.get(j.label) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([l]) => l)).toEqual([]);
  });

  it("files each event kind under exactly one job", () => {
    /* A kind in two jobs would make the same failure count twice, under two
       names, and no total on the card would add up. */
    const seen = new Map<string, number>();
    for (const j of activityJobs()) for (const k of j.kinds) seen.set(k, (seen.get(k) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it("keeps the raw kind rather than guessing at an unknown job", () => {
    /* A guessed label on a job nobody mapped is worse than the identifier: the
       reader cannot look it up, and cannot tell it was a guess. */
    expect(activityLabel("some_new_loop")).toBe("some_new_loop");
    expect(activityLabel("")).toBe("");
  });

  it("names jobs in the operator's words, not the function's", () => {
    expect(activityLabel("data_forexfactory_cal")).not.toContain("_");
    expect(activityLabel("pair_err")).toBe("New-token scan");
    /* A failure and its success share one job, so they share one name. */
    expect(activityLabel("newpair")).toBe(activityLabel("pair_err"));
  });
});
