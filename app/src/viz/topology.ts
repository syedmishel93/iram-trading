/**
 * THE SYSTEM AS A GRAPH — jobs joined by the faults they share.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE EDGES ARE SHARED FAILURES AND NOT JOB-TO-KIND
 *
 * `data/activity.ts` already declares which event kinds each job writes, and a
 * graph of that is twenty little stars: every job owns one or two kinds, joins
 * nothing else, and the picture says exactly what the list already said.
 *
 * The relationship worth drawing here is the one that has already cost this
 * project a release. CLAUDE.md records it in full: a nested write deadlocked the
 * thread that held the transaction, `pair_scan_loop` logged 2,069 failures
 * reading "database is locked", and the identical message sits in two other
 * loops' histories. THREE JOBS, ONE ROOT CAUSE — and nothing on any screen
 * connected them, so each read as its own small problem on its own row. A graph
 * whose edges mean "these two fail the same way" draws that cluster immediately.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AN EDGE HERE IS A CLAIM ABOUT A SHARED PROBLEM
 *
 * So a healthy job is never joined to anything. Connecting two working jobs
 * because both logged nothing would make the only signal in the picture
 * meaningless — the same shape as the status strip that painted "0 of 0 running"
 * green.
 *
 * And "waiting for a key only the operator can supply" is kept out of the
 * failures entirely. CLAUDE.md: FRED's 224 skips are not broken, and filing them
 * with the failures buries the ones that are.
 */

import type { ActivityKind } from "../data/activity";
import type { GraphEdge, GraphNode } from "./layout";

/** A fault, and every job it hit. */
export interface FaultCluster {
  readonly signature: string;
  /** How many jobs report this same fault. Two or more is the finding. */
  readonly jobs: number;
  /** Entries logged across all of them. */
  readonly entries: number;
  /** The operator's sentence, with the message in it. */
  readonly why: string;
}

export interface TopologyGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Shared faults, worst first. Stated in words, never left to be inferred. */
  readonly clusters: readonly FaultCluster[];
}

/**
 * Reduce a message to what it is ABOUT, so two instances of one fault match.
 *
 * THE BALANCE IS THE WHOLE DIFFICULTY. The same fault carries a different url,
 * id or number every time, so matching raw text puts every occurrence in its own
 * group and the picture shows no shared causes at all — which looks exactly like
 * a healthy system. Normalise too hard and everything lands in one cluster,
 * which says just as little.
 *
 * So: drop the digits, the query strings and the path tails, keep the words.
 * "database is locked" stays itself; two different 400s against the same API
 * become one; a 404 and a deadlock stay apart.
 */
export function failureSignature(message: string): string {
  const raw = message.trim();
  if (raw === "") return "";
  return raw
    .toLowerCase()
    /* A url varies in every part a caller controls; what matters is the HOST and
       the fact that it was a url at all. */
    .replace(/https?:\/\/([^/\s?]+)[^\s]*/g, "url:$1")
    .replace(/\b[0-9a-f]{8,}\b/g, "#")      // ids, hashes, addresses
    .replace(/\b\d[\d.,:-]*\b/g, "#")        // counts, dates, ports, numbers
    .replace(/['"`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Which standing a job is in. The groups the ring and the palette both use. */
function standingOf(k: ActivityKind): string {
  /* THREE STATES, NOT TWO. "Waiting for something only you can supply" is not
     broken, and filing it with the failures buries the ones that are. */
  if (k.needsYou) return "waiting for you";
  if (k.failing) return "failing";
  if (k.failed > 0) return "has failed";
  return "healthy";
}

/** A job whose faults are worth joining to another job's. */
const isFaulty = (k: ActivityKind): boolean =>
  !k.needsYou && k.failed > 0 && failureSignature(k.sample) !== "";

/**
 * Jobs, grouped by standing, joined where they fail the same way.
 *
 * NOTHING IS HIDDEN. A job that fails in its own unique way is drawn and drawn
 * ALONE, because present-and-unconnected is the true reading and an absent node
 * would say the job does not exist.
 */
export function topologyGraph(kinds: readonly ActivityKind[]): TopologyGraph {
  if (kinds.length === 0) return { nodes: [], edges: [], clusters: [] };

  const bySignature = new Map<string, ActivityKind[]>();
  for (const k of kinds) {
    if (!isFaulty(k)) continue;
    const sig = failureSignature(k.sample);
    const list = bySignature.get(sig);
    if (list === undefined) bySignature.set(sig, [k]);
    else list.push(k);
  }

  const edges: GraphEdge[] = [];
  const clusters: FaultCluster[] = [];

  for (const [sig, group] of bySignature) {
    if (group.length < 2) continue;
    const entries = group.reduce((s, k) => s + k.failed, 0);
    clusters.push({
      signature: sig,
      jobs: group.length,
      entries,
      why:
        `${group.length} jobs are failing the same way — "${group[0]!.sample.slice(0, 90)}" — ` +
        `${entries.toLocaleString()} entries between them. One cause, not ${group.length}.`,
    });
    /* EVERY PAIR IN THE GROUP, so the cluster is visibly one thing rather than a
       chain whose ends look unrelated. At these sizes the pair count is small;
       a group of twenty would be worth a hub node instead. */
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        edges.push({
          from: group[i]!.kind,
          to: group[j]!.kind,
          /* Unsigned: there is no direction to a shared fault. The value is how
             much of the trouble this pair accounts for. */
          value: 1,
          confidence: 1,
        });
      }
    }
  }

  clusters.sort((a, b) => b.entries - a.entries || b.jobs - a.jobs);

  const maxN = Math.max(1, ...kinds.map((k) => k.n));
  const nodes: GraphNode[] = kinds.map((k) => ({
    id: k.kind,
    label: k.kind,
    group: standingOf(k),
    /* SIZE IS HOW MUCH IT HAS LOGGED, on a log scale: one job with 2,069
       entries beside one with 5 would otherwise draw the second at zero, and a
       node too small to see is a job that is not on the screen. */
    weight: Math.log10(1 + k.n) / Math.log10(1 + maxN),
  }));

  return { nodes, edges, clusters };
}
