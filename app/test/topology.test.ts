/**
 * THE SYSTEM GRAPH — `viz/topology.ts`.
 *
 * WHY THE EDGES ARE SHARED FAILURE SIGNATURES AND NOT JOB-TO-KIND.
 *
 * A job-to-kind graph is twenty little stars: every job owns one or two kinds
 * and connects to nothing else, so the picture carries no information a list
 * does not. The relationship that is actually worth drawing in this system is
 * the one that has already cost this project a release — TWO JOBS FAILING THE
 * SAME WAY.
 *
 * CLAUDE.md records it: a nested write deadlocked the thread holding the
 * transaction, `pair_scan_loop` logged 2,069 failures reading "database is
 * locked", and the same message appears in two other loops' histories. Three
 * jobs, one root cause, and nothing on any screen connected them — each looked
 * like its own small problem. A graph whose edges are "these fail identically"
 * would have drawn that cluster on day one.
 *
 * THE TEST THAT MATTERS IS `two jobs failing the same way are connected`.
 *
 * THE SECOND IS `a healthy job is never joined to anything`. An edge here means
 * "these two share a problem", so joining two working jobs because both logged
 * "ok" would make the one signal in the picture meaningless.
 */

import { describe, expect, it } from "vitest";
import { failureSignature, topologyGraph } from "../src/viz/topology";
import type { ActivityKind } from "../src/data/activity";

const kind = (over: Partial<ActivityKind> & { kind: string }): ActivityKind => ({
  n: 10,
  failed: 0,
  newest: 1_790_000_000,
  oldest: 1_780_000_000,
  sample: "",
  failing: false,
  needsYou: false,
  ...over,
});

describe("reducing a message to what it is about", () => {
  it("STRIPS THE VARYING PARTS so two instances of one fault match", () => {
    /* The same fault carries a different url, id or number every time. Matching
       raw text would put every occurrence in its own group and the picture would
       show no shared causes at all — which looks exactly like a healthy system. */
    const a = failureSignature("400 Client Error: Bad Request for url: https://api.x.com/v4/a?page=1");
    const b = failureSignature("400 Client Error: Bad Request for url: https://api.x.com/v4/b?page=9");
    expect(a).toBe(b);
  });

  it("keeps genuinely different faults apart", () => {
    // Over-normalising is the opposite failure: one giant cluster says nothing.
    expect(failureSignature("database is locked")).not.toBe(
      failureSignature("404 Client Error: Not Found for url: https://x.com/rss.php"),
    );
  });

  it("matches the deadlock message that actually cost a release", () => {
    expect(failureSignature("database is locked")).toBe(failureSignature("database is locked"));
  });

  it("an empty message has no signature, rather than a shared empty one", () => {
    // Otherwise every job with no sample joins one meaningless cluster.
    expect(failureSignature("")).toBe("");
    expect(failureSignature("   ")).toBe("");
  });
});

describe("the graph", () => {
  const locked = "database is locked";

  const kinds: readonly ActivityKind[] = [
    kind({ kind: "pair_err", n: 2069, failed: 2069, sample: locked }),
    kind({ kind: "data_cointelegraph", n: 28, failed: 28, sample: locked }),
    kind({ kind: "whale_err", n: 5, failed: 5, failing: true, sample: locked }),
    kind({ kind: "data_mvrv", n: 225, failed: 225, sample: "400 Client Error: Bad Request for url: https://x/v4?a=1" }),
    kind({ kind: "data_fred", n: 280, failed: 0, needsYou: true, sample: "skipped: set FRED_API_KEY" }),
    kind({ kind: "backup", n: 400, failed: 0, sample: "" }),
    kind({ kind: "mt5_sync", n: 120, failed: 0, sample: "" }),
  ];

  it("TWO JOBS FAILING THE SAME WAY ARE CONNECTED", () => {
    /* THE PROOF. Three jobs, one deadlock, and until this they looked like three
       unrelated small problems on three different rows. */
    const g = topologyGraph(kinds);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.size).toBeGreaterThan(3);
    const joined = g.edges.filter((e) => Math.abs(e.value) > 0);
    expect(joined.length).toBeGreaterThan(0);
    // The three that share the deadlock must all be in one connected set.
    const reach = new Set<string>(["pair_err"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of g.edges) {
        if (reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); grew = true; }
        if (reach.has(e.to) && !reach.has(e.from)) { reach.add(e.from); grew = true; }
      }
    }
    expect(reach.has("data_cointelegraph")).toBe(true);
    expect(reach.has("whale_err")).toBe(true);
  });

  it("A HEALTHY JOB IS NEVER JOINED TO ANYTHING", () => {
    /* An edge means "these two share a problem". Joining two working jobs
       because both logged nothing would make the only signal in the picture
       meaningless — the same shape as a status strip painting 0 of 0 green. */
    const g = topologyGraph(kinds);
    for (const e of g.edges) {
      expect(["backup", "mt5_sync"]).not.toContain(e.from);
      expect(["backup", "mt5_sync"]).not.toContain(e.to);
    }
  });

  it("a job failing in its OWN way is drawn, and drawn alone", () => {
    // Present and unconnected is the true reading, and it must not be hidden.
    const g = topologyGraph(kinds);
    expect(g.nodes.some((n) => n.id === "data_mvrv")).toBe(true);
    expect(g.edges.some((e) => e.from === "data_mvrv" || e.to === "data_mvrv")).toBe(false);
  });

  it("KEEPS 'WAITING FOR YOU' OUT OF THE FAILURES", () => {
    /* CLAUDE.md: "waiting for a key only you can supply (FRED, 224 skips) is not
       broken, and filing it with the failures buries the ones that are." */
    const g = topologyGraph(kinds);
    const fred = g.nodes.find((n) => n.id === "data_fred");
    expect(fred?.group).toBe("waiting for you");
    expect(g.edges.some((e) => e.from === "data_fred" || e.to === "data_fred")).toBe(false);
  });

  it("groups by standing, so colour can follow it", () => {
    const g = topologyGraph(kinds);
    const groups = new Set(g.nodes.map((n) => n.group));
    /* FOUR STANDINGS, and the distinction between the middle two is the point:
       `failing` is failing NOW, `has failed` carries a history that has gone
       quiet. The deadlock entries in this fixture are days old, which is exactly
       how the real ones read — filing them as live failures would put a red dot
       on a problem that stopped, and filing them as healthy would hide 2,069
       entries. */
    expect(groups.has("failing")).toBe(true);
    expect(groups.has("has failed")).toBe(true);
    expect(groups.has("waiting for you")).toBe(true);
    expect(groups.has("healthy")).toBe(true);
  });

  it("names the shared faults it found, with how many jobs each one hit", () => {
    // The finding is the CLUSTER, so it is stated in words and not left for the
    // reader to infer from which dots are near each other.
    const g = topologyGraph(kinds);
    expect(g.clusters.length).toBeGreaterThan(0);
    const worst = g.clusters[0]!;
    expect(worst.jobs).toBeGreaterThanOrEqual(3);
    expect(worst.why).toContain("locked");
  });

  it("weights every node into the range the layout expects", () => {
    const g = topologyGraph(kinds);
    expect(g.nodes.every((n) => n.weight >= 0 && n.weight <= 1)).toBe(true);
  });

  it("an empty log is an empty graph, not a claim that all is well", () => {
    const g = topologyGraph([]);
    expect(g.nodes).toHaveLength(0);
    expect(g.clusters).toHaveLength(0);
  });
});
