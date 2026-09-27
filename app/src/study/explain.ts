/**
 * The plain-language answer to a steered study: which model won, what the
 * related assets added, and what the run could not say.
 *
 * BUILT ONLY FROM THE REPORT. Every sentence below is assembled from a field
 * `runStudySpec` produced — a step's own headline, its `contest`, its lead-lag
 * profiles, the correction — and nothing is phrased as a finding that the run
 * did not make. When no step compared a model with a baseline, the answer says
 * so rather than naming a winner; when the related assets were loaded but no
 * check read them, it says that too. A missing sentence is better than one
 * that sounds measured and was not.
 *
 * "AI explains · you decide": this module is the explaining. It never
 * recommends, promotes or arms anything.
 */

import type { StudyReport, StepResult } from "./run";
import type { Contest } from "./steps";
import type { Question } from "./question";

export interface ContestLine {
  readonly step: string;
  readonly text: string;
  readonly beat: boolean | null;
}

export interface Explanation {
  /** The one line, in the report's own words. */
  readonly verdict: string;
  /** Every model-versus-baseline comparison that ran. */
  readonly contests: readonly ContestLine[];
  /** One sentence naming the winner, or saying there was none. */
  readonly winner: string;
  /** What the related assets added — or why nothing can be said about it. */
  readonly related: readonly string[];
  /** Steps that could not answer, with the reason. */
  readonly unanswered: readonly string[];
  /** The multiple-testing note — how many things were tried. */
  readonly correction: string;
}

const RELATION_STEPS = ["crossasset", "leadlag", "corrmatrix"] as const;

function contestText(label: string, c: Contest): string {
  if (c.beat === null) return `${label}: ${c.winner} came out ahead of ${c.baseline}, but by how much could not be scored (${c.by}).`;
  return c.beat
    ? `${label}: ${c.winner} beat ${c.baseline} — ${c.by}.`
    : `${label}: nothing beat ${c.baseline} — ${c.by}.`;
}

function okSteps(report: StudyReport): (StepResult & { outcome: Extract<StepResult["outcome"], { state: "ok" }> })[] {
  return report.steps.filter(
    (s): s is StepResult & { outcome: Extract<StepResult["outcome"], { state: "ok" }> } => s.outcome.state === "ok",
  );
}

/**
 * Explain one report.
 *
 * `related` is the related assets that were switched ON for the run, and
 * `missing` the ones that loaded no bars — both from the desk's state, because
 * the report holds the columns that made it into the panel and cannot name
 * the ones that never arrived.
 */
export function explainReport(
  report: StudyReport,
  question: Question,
  related: readonly string[],
  missing: readonly string[] = [],
): Explanation {
  if (report.refusal !== null) {
    return {
      verdict: report.refusal,
      contests: [],
      winner: "Nothing ran, so nothing won.",
      related: [],
      unanswered: [],
      correction: report.correction.text,
    };
  }

  const ok = okSteps(report);
  const contests: ContestLine[] = ok
    .filter((s) => s.outcome.contest !== undefined && s.methodId !== "crossasset")
    .map((s) => {
      const c = s.outcome.contest as Contest;
      return { step: s.label, text: contestText(s.label, c), beat: c.beat };
    });

  const winners = contests.filter((c) => c.beat === true);
  const winner =
    contests.length === 0
      ? "None of the checks that ran compares a model with a baseline, so there is no winner to name."
      : winners.length === 0
        ? contests.length === 1
          ? `${(contests[0] as ContestLine).text} That is a result, and a common one.`
          : `Nothing beat its baseline — all ${contests.length} comparisons came out level or worse. That is a result, and a common one.`
        : winners.length === 1
          ? (winners[0] as ContestLine).text
          : `${winners.length} of ${contests.length} comparisons beat their baseline; the correction below says how much of that survives having tried them all.`;

  const relatedLines: string[] = [];
  if (related.length === 0) {
    relatedLines.push("No related assets were switched on, so nothing was measured against them.");
  } else {
    const byId = new Map(report.steps.map((s) => [s.methodId, s]));
    const ran = RELATION_STEPS.filter((id) => byId.has(id));
    if (ran.length === 0) {
      relatedLines.push(
        question.relatedRole === "measured"
          ? `For this question the related assets are only measured beside ${report.symbol}; none of its checks reads them, so they cannot change the answer.`
          : "The related assets were loaded, but no check that reads them ran.",
      );
    }
    const cross = byId.get("crossasset");
    if (cross !== undefined) {
      if (cross.outcome.state === "ok" && cross.outcome.contest !== undefined) {
        const c = cross.outcome.contest;
        relatedLines.push(
          c.beat === true
            ? `Adding them improved the forecast over ${report.symbol} alone: ${c.by}.`
            : `Adding them did not improve the forecast over ${report.symbol} alone: ${c.by}.`,
        );
      } else if (cross.outcome.state !== "ok") {
        relatedLines.push(`Whether they improve a forecast could not be tested: ${cross.outcome.reason}`);
      }
    }
    const lead = byId.get("leadlag");
    if (lead !== undefined) {
      if (lead.outcome.state === "ok") {
        const leaders = lead.outcome.profiles.filter((p) => (p.clears[0]?.lag ?? 0) > 0);
        relatedLines.push(
          leaders.length === 0
            ? `None of them moved before ${report.symbol} by more than the noise band.`
            : lead.outcome.headline,
        );
      } else {
        relatedLines.push(`Which moves first could not be measured: ${lead.outcome.reason}`);
      }
    }
    const corr = byId.get("corrmatrix");
    if (corr !== undefined && corr.outcome.state === "ok") relatedLines.push(corr.outcome.headline);
  }
  if (missing.length > 0) {
    relatedLines.push(
      `${missing.join(", ")} loaded no bars and ${missing.length === 1 ? "is" : "are"} not in any of these figures.`,
    );
  }

  const unanswered = report.steps
    .filter((s) => s.outcome.state !== "ok")
    .map((s) => {
      const o = s.outcome;
      return o.state === "ok" ? "" : `${s.label} could not answer: ${o.reason}`;
    });

  return {
    verdict: report.headline,
    contests,
    winner,
    related: relatedLines,
    unanswered,
    correction: report.correction.text,
  };
}
