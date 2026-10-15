/**
 * THE PRE-MARKET ROUTINE.
 *
 * Every piece of it already existed across six desks; what was missing was the
 * order. The arithmetic is tiny and the risk is entirely in the third state:
 * a step that could not be answered must never read as done and must never
 * read as a failure. This product has shipped both mistakes — a status strip
 * that painted "0 of 0 running" green because a loop that had never ticked
 * reported nothing, and a risk desk that reported a flat book because an
 * unknown unit defaulted to one.
 */

import { describe, expect, it } from "vitest";
import { buildRoutine, summarise, type RoutineInput } from "../src/ui/today/routine";
import { VIEW_IDS } from "../src/ui/shell/views";

/** A morning where everything was answered and everything is done. */
const GOOD: RoutineInput = {
  dataAgeMin: 2,
  eventsToday: 3,
  eventsHigh: 1,
  canTrade: true,
  dayLossUsed: 0,
  watchCount: 5,
  scannedAgoMin: 20,
  planWritten: true,
  alertsArmed: 4,
  alertsCanReach: true,
  reviewedYesterday: true,
};

const stateOf = (i: RoutineInput, id: string) => buildRoutine(i).find((s) => s.id === id)?.state;
const saysOf = (i: RoutineInput, id: string) => buildRoutine(i).find((s) => s.id === id)?.says ?? "";

describe("the routine itself", () => {
  it("IS THE SAME SEVEN STEPS IN THE SAME ORDER, whatever it was told", () => {
    /* A routine whose steps appear and vanish with the data is one nobody can
       learn. The ORDER is the product: what you cannot change, then what you
       decide, then what has to be true before any of it matters. */
    const order = buildRoutine(GOOD).map((s) => s.id);
    expect(order).toEqual(["data", "events", "list", "plan", "limits", "alerts", "review"]);
    expect(buildRoutine({}).map((s) => s.id)).toEqual(order);
  });

  it("SENDS EVERY STEP TO A DESK THAT EXISTS", () => {
    /* A link built from a pattern is a claim. A step pointing at a desk the
       shell cannot render is worse than a step with no link at all. */
    for (const s of buildRoutine(GOOD)) {
      expect(VIEW_IDS.has(s.desk), `${s.id} points at "${s.desk}", which is not a desk`).toBe(true);
    }
  });

  it("GIVES EVERY STEP ONE SHORT LINE WITH ITS NUMBER IN IT", () => {
    for (const s of buildRoutine(GOOD)) {
      expect(s.says.length, `${s.id} says nothing`).toBeGreaterThan(4);
      expect(s.says.length, `${s.id} is a paragraph, not a line`).toBeLessThan(90);
    }
  });
});

describe("could not ask is not the same as nothing", () => {
  it("ANSWERS UNKNOWN FOR EVERY STEP IT WAS TOLD NOTHING ABOUT", () => {
    const blank = buildRoutine({});
    expect(blank.every((s) => s.state === "unknown")).toBe(true);
    for (const s of blank) {
      expect(s.says, `${s.id} invented an answer`).toMatch(/could not check/i);
    }
  });

  it("NEVER COUNTS AN UNANSWERED STEP AS DONE", () => {
    const s = summarise(buildRoutine({}));
    expect(s.done).toBe(0);
    expect(s.unknown).toBe(7);
    expect(s.ready, "a morning nobody could check reported itself ready").toBe(false);
  });

  it("NEVER COUNTS AN UNANSWERED STEP AS A FAILURE EITHER", () => {
    /* The other half, and the one that is easy to get wrong in the opposite
       direction: rendering an unreachable service as a problem is how a
       routine teaches people to ignore it. */
    expect(summarise(buildRoutine({})).blocked).toBe(0);
  });

  it("SAYS HOW MANY IT COULD NOT CHECK, because that is a different morning", () => {
    const partial = summarise(buildRoutine({ ...GOOD, canTrade: undefined, alertsArmed: undefined }));
    expect(partial.says).toMatch(/could not be checked/i);
    expect(partial.unknown).toBe(2);
    expect(partial.ready).toBe(false);
  });

  it("TREATS A SERVICE THAT REFUSED THE SAME AS ONE THAT DID NOT ANSWER", () => {
    /* `canTrade: null` is the governor saying it cannot decide. That is not a
       no, and it is certainly not a yes. */
    expect(stateOf({ ...GOOD, canTrade: null }, "limits")).toBe("unknown");
  });
});

describe("the steps that can stop the day", () => {
  it("BLOCKS ON STALE DATA, and names the age against the limit", () => {
    expect(stateOf({ ...GOOD, dataAgeMin: 90 }, "data")).toBe("blocked");
    expect(saysOf({ ...GOOD, dataAgeMin: 90 }, "data")).toMatch(/90m.*15m/);
    expect(stateOf({ ...GOOD, dataAgeMin: 90, dataStaleAfterMin: 240 }, "data")).toBe("done");
  });

  it("BLOCKS WHEN THE GOVERNOR SAYS NO, and shows how much of the limit went", () => {
    expect(stateOf({ ...GOOD, canTrade: false, dayLossUsed: 1 }, "limits")).toBe("blocked");
    expect(saysOf({ ...GOOD, canTrade: false, dayLossUsed: 1 }, "limits")).toMatch(/100%/);
  });

  it("BLOCKS ON ALERTS THAT ARE ARMED AND CANNOT REACH YOU", () => {
    /* ARMED AND UNREACHABLE IS WORSE THAN NOT ARMED, because it looks done.
       This product shipped three loops firing into a channel that had no
       caller at all, under twelve green dots. */
    expect(stateOf({ ...GOOD, alertsArmed: 4, alertsCanReach: false }, "alerts")).toBe("blocked");
    expect(saysOf({ ...GOOD, alertsArmed: 4, alertsCanReach: false }, "alerts")).toMatch(/reach you/i);

    /* Nothing armed is a TODO, not a block: there is nothing to fail. */
    expect(stateOf({ ...GOOD, alertsArmed: 0 }, "alerts")).toBe("todo");
  });

  it("LEADS WITH WHAT IS STOPPING YOU, not with the count", () => {
    const s = summarise(buildRoutine({ ...GOOD, canTrade: false }));
    expect(s.says).toMatch(/^1 thing stopping you/);
    expect(s.ready).toBe(false);
  });
});

describe("the ordinary morning", () => {
  it("SAYS READY ONLY WHEN EVERY STEP WAS ANSWERED AND DONE", () => {
    const s = summarise(buildRoutine(GOOD));
    expect(s).toMatchObject({ done: 7, total: 7, blocked: 0, unknown: 0, ready: true, says: "Ready." });
  });

  it("COUNTS AN UNSCANNED LIST AS SOMETHING LEFT TO DO", () => {
    expect(stateOf({ ...GOOD, scannedAgoMin: undefined }, "list")).toBe("todo");
    expect(stateOf({ ...GOOD, scannedAgoMin: 60 * 9 }, "list")).toBe("todo");
    expect(saysOf({ ...GOOD, scannedAgoMin: 60 * 9 }, "list")).toMatch(/9h ago/);
  });

  it("DOES NOT ASK YOU TO SCAN A LIST THAT IS EMPTY", () => {
    /* It sends you to the watchlist instead, which is the step that actually
       moves you forward. A routine that tells you to scan nothing is one you
       stop reading. */
    const empty = buildRoutine({ ...GOOD, watchCount: 0 }).find((s) => s.id === "list");
    expect(empty?.state).toBe("todo");
    expect(empty?.desk).toBe("watchlist");
    expect(empty?.says).toMatch(/nothing on your list/i);
  });

  it("CALLS A QUIET CALENDAR AN ANSWER, not a gap", () => {
    /* Zero scheduled events is a fact about the day and a step you have
       completed by looking. It is not the same as a calendar that did not
       answer, which is the step above it. */
    expect(stateOf({ ...GOOD, eventsToday: 0 }, "events")).toBe("done");
    expect(saysOf({ ...GOOD, eventsToday: 0 }, "events")).toMatch(/nothing scheduled/i);
  });

  it("REFUSES TO CONGRATULATE AN EMPTY ROUTINE", () => {
    /* `verdict()` concluded "go" from no gates at all, and a strip painted
       "0 of 0 running" green. An empty list is not a passing list. */
    const s = summarise([]);
    expect(s.ready).toBe(false);
    expect(s.says).toMatch(/nothing to check/i);
  });
});

describe("a scan whose time nobody kept", () => {
  it("COUNTS AS SCANNED, rather than sending you to redo it", () => {
    /* The Today desk knows a scan happened and does not keep its time. Both
       obvious bodges are lies: passing 0 claims it ran this minute, leaving it
       out claims it never ran. The boolean says the true, weaker thing. */
    const i: RoutineInput = { ...GOOD, scannedAgoMin: undefined, scanned: true };
    expect(stateOf(i, "list")).toBe("done");
    expect(saysOf(i, "list")).toMatch(/5 scanned\.$/);
  });

  it("STILL ASKS WHEN NOTHING HAS SCANNED", () => {
    expect(stateOf({ ...GOOD, scannedAgoMin: undefined, scanned: false }, "list")).toBe("todo");
    expect(stateOf({ ...GOOD, scannedAgoMin: undefined }, "list")).toBe("todo");
  });

  it("PREFERS A REAL AGE OVER THE BOOLEAN when it has one", () => {
    /* An age is strictly better information, and a nine-hour-old scan is a
       todo however emphatically a boolean says it happened. */
    expect(stateOf({ ...GOOD, scanned: true, scannedAgoMin: 60 * 9 }, "list")).toBe("todo");
  });
});

describe("a warning is not a refusal", () => {
  it("LETS A WARN THROUGH, because the governor distinguishes them", () => {
    /* `GovLevel` is allow | warn | block. Collapsing warn into block would
       stand the operator down on a day the service only wanted to raise an
       eyebrow; collapsing it into allow would hide the eyebrow. The routine
       takes a boolean, so the mapping lives at the boundary and is tested
       there — the step passes on warn and the reason stays visible on the
       Risk desk, which is where the reasons are. */
    expect(stateOf({ ...GOOD, canTrade: true, dayLossUsed: 0.6 }, "limits")).toBe("done");
    expect(saysOf({ ...GOOD, canTrade: true, dayLossUsed: 0.6 }, "limits")).toMatch(/60%/);
  });

  it("SAYS THE SENTENCE WITHOUT A NUMBER when the limit cannot be divided by", () => {
    /* A zero daily-loss limit cannot produce a share. Reporting 0% would read
       as "nothing spent", which is the most reassuring possible way to say
       "this cannot be measured". */
    expect(saysOf({ ...GOOD, canTrade: true, dayLossUsed: undefined }, "limits")).toBe("Inside your limits.");
    expect(saysOf({ ...GOOD, canTrade: false, dayLossUsed: undefined }, "limits")).toBe("Stopped for the day.");
  });

  it("CLAMPS THE SHARE, because a day can go past its own limit", () => {
    /* The governor stops you AT the limit, but a gap or a slipped stop can
       realise more than the cap. 140% is a true number and a broken bar; the
       step reports the standing, not the overshoot. */
    expect(saysOf({ ...GOOD, canTrade: false, dayLossUsed: 1.4 }, "limits")).toMatch(/100%/);
    expect(saysOf({ ...GOOD, canTrade: true, dayLossUsed: -0.2 }, "limits")).toMatch(/0%/);
  });
});

describe("stale means something different on every timeframe", () => {
  it("TAKES THE LIMIT IT WAS GIVEN, rather than one number for every chart", () => {
    /* Fourteen minutes is nothing on a daily chart and an outage on a 1m one.
       The limit comes from the bar size, so the step means the same thing
       everywhere — the alternative is a routine that cries stale on a daily
       chart every afternoon and never cries at all on a minute one. */
    const dayChart = { ...GOOD, dataAgeMin: 200, dataStaleAfterMin: 4320 };
    expect(stateOf(dayChart, "data")).toBe("done");

    const minuteChart = { ...GOOD, dataAgeMin: 200, dataStaleAfterMin: 5 };
    expect(stateOf(minuteChart, "data")).toBe("blocked");
    expect(saysOf(minuteChart, "data")).toMatch(/200m.*5m/);
  });

  it("ROUNDS THE AGE FOR READING, and never shows a negative one", () => {
    /* A bar stamped slightly ahead of this machine's clock is ordinary — the
       server stamps it — and "-2m old" reads as a fault in the terminal. */
    expect(saysOf({ ...GOOD, dataAgeMin: 0.4 }, "data")).toMatch(/0m old/);
  });
});
