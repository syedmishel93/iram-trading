/**
 * YOUR OWN RECORD, ON THE PRICE — `chart/claims.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS THE ONE THING A GENERIC CHART CANNOT DRAW
 *
 * TradingView can draw this market better than this terminal will: more drawing
 * tools, a larger indicator library, more data, years more work. What it cannot
 * draw is whether THIS terminal was right the last four hundred times it said
 * something about this market, because it does not know. This does — 759 claims
 * recorded, 445 decided, each with the bar it was made on, its entry, stop and
 * target, and how it resolved.
 *
 * A chart showing that stops being a picture of price and becomes a record of
 * your own decisions against price.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR WAYS TO MAKE IT A LIE, ALL PINNED BELOW
 *
 * 1. **A STAND-DOWN IS NOT A TRADE.** 291 of 400 live claims are the terminal
 *    refusing, not proposing. "Was it right to take this?" and "was it right to
 *    refuse this?" are different questions, and one mark for both would answer
 *    neither.
 * 2. **PENDING IS NOT EVIDENCE.** 326 of 400 have not resolved. Drawing them
 *    like a result would put 326 unearned marks on the chart.
 * 3. **EXPIRED IS NOT A LOSS.** CLAUDE.md states it: a setup that reached
 *    neither target nor stop is its own class, and folding it into "stop"
 *    teaches that "nothing happened" looks like "I was wrong".
 * 4. **ANOTHER MARKET'S CLAIM IS NOT THIS MARKET'S.** A claim made on XAUUSD 1h
 *    drawn on a BTCUSDT 5m chart is a mark in the right place about the wrong
 *    thing, and nothing on screen would say so.
 */

import { describe, expect, it } from "vitest";
import { claimShapes, type Claim } from "../src/chart/claims";
import type { BarView } from "../src/chart/series";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1);

/** Twenty 1m bars from T0. */
const bars: BarView[] = Array.from({ length: 20 }, (_, i) => ({
  t: T0 + i * MIN,
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  v: 10,
}));

const SUBJECT = { symbol: "BTCUSDT", timeframe: "1m", intervalMs: MIN };

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: "c1",
  at: T0 + 5 * MIN,
  symbol: "BTCUSDT",
  timeframe: "1m",
  side: "long",
  verdict: "take",
  outcome: "target",
  entry: 100,
  stop: 99,
  target: 102,
  r_realised: 1,
  resolved_at: T0 + 8 * MIN,
  resolved_price: 102,
  ...over,
});

describe("only this market's claims, and only this timeframe's", () => {
  it("REFUSES ANOTHER SYMBOL, and says how many it dropped", () => {
    /* A mark in the right place about the wrong market is worse than no mark:
       it is in exactly the position a reader trusts. */
    const out = claimShapes([claim(), claim({ id: "c2", symbol: "XAUUSD" })], bars, SUBJECT);
    expect(out.shapes.filter((s) => s.type === "marker")).toHaveLength(1);
    expect(out.dropped.otherMarket).toBe(1);
  });

  it("refuses another timeframe on the same symbol", () => {
    // A 1h claim on a 1m chart lands on a bar it was never about.
    const out = claimShapes([claim({ timeframe: "1h" })], bars, SUBJECT);
    expect(out.shapes).toHaveLength(0);
    expect(out.dropped.otherMarket).toBe(1);
  });

  it("drops a claim from outside the loaded bars rather than clamping it", () => {
    /* Clamping would stack every old claim on the first bar — a cluster that
       reads as a flurry of calls at a moment nothing happened. */
    const out = claimShapes(
      [claim({ at: T0 - 50 * MIN }), claim({ id: "c2", at: T0 + 500 * MIN })],
      bars,
      SUBJECT,
    );
    expect(out.shapes).toHaveLength(0);
    expect(out.dropped.offChart).toBe(2);
  });
});

describe("what counts as evidence", () => {
  it("PENDING IS NOT DRAWN AS A RESULT", () => {
    /* 326 of 400 live claims are pending. Marking them like an outcome would put
       326 unearned results on the chart. */
    const out = claimShapes([claim({ outcome: "pending", r_realised: null, resolved_at: null })], bars, SUBJECT);
    expect(out.counted.hits).toBe(0);
    expect(out.counted.misses).toBe(0);
    expect(out.counted.pending).toBe(1);
  });

  it("EXPIRED IS ITS OWN CLASS, NOT A LOSS", () => {
    /* "Reached neither the target nor the stop" is not "I was wrong". Folding it
       into the misses teaches a reader that nothing happening looks like being
       wrong, and it is most of a quiet market. */
    const out = claimShapes([claim({ outcome: "expired", r_realised: 0 })], bars, SUBJECT);
    expect(out.counted.misses).toBe(0);
    expect(out.counted.expired).toBe(1);
    const mark = out.shapes.find((s) => s.type === "marker");
    expect(mark?.tone).toBe("neutral");
  });

  it("a target is a hit and a stop is a miss, each in its own tone", () => {
    const hit = claimShapes([claim({ outcome: "target" })], bars, SUBJECT);
    const miss = claimShapes([claim({ outcome: "stop", r_realised: -1 })], bars, SUBJECT);
    expect(hit.counted.hits).toBe(1);
    expect(miss.counted.misses).toBe(1);
    expect(hit.shapes.find((s) => s.type === "marker")?.tone).toBe("bull");
    expect(miss.shapes.find((s) => s.type === "marker")?.tone).toBe("bear");
  });
});

describe("THE FIFTH OUTCOME, found on the live ledger and not in the first draft", () => {
  /* MEASURED: 10 of 429 BTCUSDT 1h claims carry `outcome: "unknowable"` - a bar
     whose range covered the stop AND the target, where OHLC cannot say which was
     touched first. `server/mishel_claims.py` excludes it from the denominator and
     says why: "guessing puts a coin flip inside the hit rate, which is worse than
     having no hit rate because it still looks like one."

     The first version of this layer folded every unrecognised outcome into
     `pending`, so the chart would have reported ten calls as STILL OPEN that can
     never open again, under the pending glyph. "Not yet answered" and "cannot be
     answered" are different facts. */

  it("IS NOT COUNTED AS PENDING", () => {
    const out = claimShapes([claim({ outcome: "unknowable", r_realised: null })], bars, SUBJECT);
    expect(out.counted.pending, "a call that cannot be graded is not a call awaiting grading").toBe(0);
    expect(out.counted.unknowable).toBe(1);
  });

  it("is not counted as a hit, a miss, or a timeout either", () => {
    // Its whole meaning is that the ledger tried and could not say.
    const out = claimShapes([claim({ outcome: "unknowable", r_realised: null })], bars, SUBJECT);
    expect(out.counted.hits).toBe(0);
    expect(out.counted.misses).toBe(0);
    expect(out.counted.expired).toBe(0);
  });

  it("wears its own mark, distinct from pending and from expired", () => {
    /* Three different reasons a call has no result: nobody has looked yet, the
       horizon ran out, and the bar cannot be read. One glyph for any two of them
       makes the chart answer a question it was not asked. */
    const marks = (outcome: string): string => {
      const out = claimShapes([claim({ outcome, r_realised: null })], bars, SUBJECT);
      const m = out.shapes.find((sh) => sh.type === "marker") as { text: string } | undefined;
      return m?.text ?? "";
    };
    const set = new Set([marks("pending"), marks("expired"), marks("unknowable")]);
    expect(set.size, "pending, expired and unknowable must not share a mark").toBe(3);
  });

  it("says so in its own sentence rather than being silent", () => {
    // A category excluded from a total has to be named wherever the total is.
    const out = claimShapes(
      [
        claim({ outcome: "target" }),
        claim({ id: "2", outcome: "stop", r_realised: -1 }),
        claim({ id: "3", outcome: "unknowable", r_realised: null }),
      ],
      bars,
      SUBJECT,
    );
    expect(out.why).toMatch(/could not be read|unknowable|cannot be graded/i);
  });

  it("THE BUCKETS PARTITION WHAT WAS COUNTED, so a SIXTH outcome cannot hide", () => {
    /* The server keeps exactly this guarantee and `test_claims_partition.py`
       fails if a sixth outcome is added without a bucket - which is how the
       fifth one arrived. Asserting the partition rather than each field means a
       future `outcome: "cancelled"` fails HERE instead of being drawn as an
       open call forever. */
    const every = ["target", "stop", "expired", "pending", "unknowable"];
    const out = claimShapes(
      every.map((outcome, i) => claim({ id: `p${i}`, outcome, at: T0 + (i + 1) * MIN })),
      bars,
      SUBJECT,
    );
    const c = out.counted;
    const buckets = c.hits + c.misses + c.expired + c.pending + c.unknowable;
    expect(buckets, "every counted claim lands in exactly one bucket").toBe(every.length);
    expect(c.taken + c.stoodDown, "and in exactly one verdict").toBe(every.length);
  });
});

describe("a refusal is a different question from a trade", () => {
  it("A STAND-DOWN IS COUNTED AND MARKED SEPARATELY", () => {
    /* 291 of 400. "Was it right to take this?" and "was it right to refuse
       this?" are different questions; one mark for both answers neither. */
    const out = claimShapes(
      [claim({ verdict: "take" }), claim({ id: "c2", verdict: "stand-down" })],
      bars,
      SUBJECT,
    );
    expect(out.counted.taken).toBe(1);
    expect(out.counted.stoodDown).toBe(1);
    /* PINNED ON THE MARK, NOT ON THE GLYPH. The distinction used to be a trailing
       dot on the text and is now the side of the bar the mark sits on, because a
       group count after that dot read as a negative number. The FACT is the same
       and it is what this asserts: whatever carries it, the two must not be
       drawn identically. */
    const marks = out.shapes
      .filter((s) => s.type === "marker")
      .map((s) => JSON.stringify([(s as { text: string }).text, (s as { above: boolean }).above]));
    expect(new Set(marks).size, "a refusal must not be drawn the same as a trade").toBe(2);
  });

  it("can be asked for trades only, and says what it left out", () => {
    const out = claimShapes(
      [claim({ verdict: "take" }), claim({ id: "c2", verdict: "stand-down" })],
      bars,
      SUBJECT,
      { show: "taken" },
    );
    expect(out.shapes.filter((s) => s.type === "marker")).toHaveLength(1);
    expect(out.why).toContain("stood down");
  });
});

describe("COUNTING A CLASS APART IS NOT ENOUGH; IT HAS TO BE DRAWN APART TOO", () => {
  /* MEASURED on the live chart: BTCUSDT 1h carries 429 claims, 293 of them
     pending, and drawing all of them covered three days of candles. The layer
     already counted pending separately and then drew it anyway - the rule
     enforced in the arithmetic and broken on the screen.

     A pending call is the terminal saying something it has not yet been graded
     on. Two hundred and ninety-three of those is not a record, it is a fog. */

  it("DOES NOT DRAW A PENDING CALL BY DEFAULT", () => {
    const out = claimShapes(
      [claim({ outcome: "target" }), claim({ id: "2", outcome: "pending", at: T0 + 6 * MIN })],
      bars,
      SUBJECT,
    );
    expect(out.shapes.filter((sh) => sh.type === "marker")).toHaveLength(1);
  });

  it("still COUNTS it, so the sentence can say how many were left out", () => {
    // Silently drawing less than was counted is the shape this project calls a
    // study whose dead vendors vanished from its reported window.
    const out = claimShapes(
      [claim({ outcome: "pending" }), claim({ id: "2", outcome: "pending", at: T0 + 6 * MIN })],
      bars,
      SUBJECT,
    );
    expect(out.counted.pending).toBe(2);
    expect(out.dropped.unresolved).toBe(2);
    expect(out.why, "the sentence must say the pending calls are not drawn").toMatch(
      /not drawn|none is drawn|not shown/i,
    );
  });

  it("draws them when asked, so the choice is the operator's", () => {
    const out = claimShapes([claim({ outcome: "pending" })], bars, SUBJECT, { include: "all" });
    expect(out.shapes.filter((sh) => sh.type === "marker")).toHaveLength(1);
    expect(out.dropped.unresolved).toBe(0);
  });

  it("A GRADED CALL IS ALWAYS DRAWN — the default hides doubt, never evidence", () => {
    /* The one thing this layer exists for. If the default could ever hide a
       target or a stop it would be flattering the record by omission, which is
       the worst available failure here. */
    for (const outcome of ["target", "stop", "expired", "unknowable"]) {
      const out = claimShapes([claim({ outcome })], bars, SUBJECT);
      expect(out.shapes.filter((sh) => sh.type === "marker"), outcome).toHaveLength(1);
    }
  });
});

describe("where the mark goes", () => {
  it("SITS ON THE BAR THE CALL WAS MADE ON, not where it resolved", () => {
    /* The bar you knew on. Placing it at the resolution would show you a record
       of the past that you could only have had afterwards. */
    const out = claimShapes([claim({ at: T0 + 5 * MIN, resolved_at: T0 + 12 * MIN })], bars, SUBJECT);
    const mark = out.shapes.find((s) => s.type === "marker") as { x: number };
    expect(mark.x).toBe(5);
  });

  it("finds the bar by TIME, not by position in the array", () => {
    // A gapped series indexes differently from a continuous one, and a claim
    // placed by position would drift by exactly the number of missing bars.
    const gapped = bars.filter((_, i) => i !== 3);
    const out = claimShapes([claim({ at: T0 + 7 * MIN })], gapped, SUBJECT);
    const mark = out.shapes.find((s) => s.type === "marker") as { x: number };
    expect(gapped[mark.x]?.t).toBe(T0 + 7 * MIN);
  });

  it("PLACES BY VERDICT, NOT BY SIDE — and side no longer moves the mark", () => {
    /* THIS REPLACED AN EARLIER RULE, deliberately. Placement used to follow the
       claim's side, so a mark never sat where the move it predicted would go.
       There is one axis and two facts competing for it, and the verdict is the
       one a reader is actually asking about: did the terminal act, or refuse?
       Carrying the verdict in the glyph instead cost a second character, and a
       group count appended to it read as a negative number at 1:1.

       Asserting side does NOT move the mark is the half that stops the old rule
       creeping back and silently taking the axis over. */
    const longTake = claimShapes([claim({ side: "long", verdict: "take" })], bars, SUBJECT);
    const shortTake = claimShapes([claim({ side: "short", verdict: "take" })], bars, SUBJECT);
    const stood = claimShapes([claim({ side: "long", verdict: "stand-down" })], bars, SUBJECT);
    const above = (r: ReturnType<typeof claimShapes>): boolean =>
      (r.shapes.find((s) => s.type === "marker") as { above: boolean }).above;
    expect(above(longTake), "a taken trade sits below the bar").toBe(false);
    expect(above(shortTake), "side must not move it").toBe(false);
    expect(above(stood), "a refusal sits above the bar").toBe(true);
  });
});

describe("ONE BAR, ONE MARK PER VERDICT", () => {
  /* MEASURED at 1:1 on the live chart: where a dozen calls share a bar, the
     renderer's collision handling pushed them into a VERTICAL TOWER reaching far
     above and below the candle. On a price chart a y position is read as a price,
     so a tower of ticks is a set of claims drawn at levels nobody ever traded -
     plausible, unlabelled, and not red. The same class as a per-series scale.

     Collapsing them is also the only way the layer reads at all: the marks are
     the point, and a fog of them is worse than TradingView rather than better. */

  const onSameBar = (n: number, over: Partial<Claim> = {}): Claim[] =>
    Array.from({ length: n }, (_, i) =>
      claim({ id: `s${i}`, at: T0 + 5 * MIN + 1000 * i, entry: 100 + i, ...over }),
    );

  it("COLLAPSES CALLS THAT SHARE A BAR INTO ONE MARK", () => {
    const out = claimShapes(onSameBar(6), bars, SUBJECT);
    expect(out.shapes.filter((sh) => sh.type === "marker")).toHaveLength(1);
  });

  it("that mark CARRIES THE COUNT, so collapsing hides nothing", () => {
    // Six calls shown as one unlabelled tick would under-report the record.
    const out = claimShapes(onSameBar(6), bars, SUBJECT);
    const m = out.shapes.find((sh) => sh.type === "marker") as { text: string };
    expect(m.text).toContain("6");
  });

  it("A TAKE AND A STAND-DOWN ON ONE BAR STAY APART", () => {
    /* They answer different questions, so merging them into a single mark would
       lose the distinction the whole layer is built around. */
    const out = claimShapes(
      [...onSameBar(3, { verdict: "take" }), ...onSameBar(3, { verdict: "stand-down" })],
      bars,
      SUBJECT,
    );
    expect(out.shapes.filter((sh) => sh.type === "marker")).toHaveLength(2);
  });

  it("takes its TONE from the balance of the calls on that bar", () => {
    const mostlyHit = claimShapes(
      [...onSameBar(3, { outcome: "target" }), ...onSameBar(1, { outcome: "stop" })],
      bars,
      SUBJECT,
    );
    const mostlyMiss = claimShapes(
      [...onSameBar(1, { outcome: "target" }), ...onSameBar(3, { outcome: "stop" })],
      bars,
      SUBJECT,
    );
    expect(mostlyHit.shapes.find((sh) => sh.type === "marker")?.tone).toBe("bull");
    expect(mostlyMiss.shapes.find((sh) => sh.type === "marker")?.tone).toBe("bear");
  });

  it("SITS AT A PRICE THAT WAS ACTUALLY CLAIMED, never outside the group", () => {
    /* The reason the tower was wrong. Whatever price the collapsed mark takes, it
       has to be one the calls it stands for were made around. */
    const out = claimShapes(onSameBar(6), bars, SUBJECT);
    const m = out.shapes.find((sh) => sh.type === "marker") as { y: number };
    expect(m.y).toBeGreaterThanOrEqual(100);
    expect(m.y).toBeLessThanOrEqual(105);
  });

  it("a lone call is still its own glyph, not a count of one", () => {
    const out = claimShapes([claim({ outcome: "target" })], bars, SUBJECT);
    const m = out.shapes.find((sh) => sh.type === "marker") as { text: string };
    expect(m.text).not.toContain("1");
  });

  it("REPORTS HOW MANY MARKS IT DREW, so the control cannot contradict the chart", () => {
    // A badge reading 429 beside a chart carrying 41 marks is a number the
    // operator can see is wrong, which costs the whole layer its credibility.
    const out = claimShapes(onSameBar(6), bars, SUBJECT);
    expect(out.marks).toBe(out.shapes.filter((sh) => sh.type === "marker").length);
  });
});

describe("TAKES AND REFUSALS ARE TWO POPULATIONS, never one rate", () => {
  /* MEASURED on the live chart: 429 BTCUSDT 1h claims, 315 of them refusals, and
     the layer printed one pooled "78 of 126 reached target". Most of that rate is
     about trades the terminal DECLINED, where reaching target means the refusal
     COST something - so the pooled figure runs the two questions together and
     answers neither.

     `server/mishel_claims.py` `gate_verdict` keeps them apart on purpose and
     compares them ("Do the gates earn their refusals?"). The chart must report
     the same way rather than invent a second interpretation - one fact, one
     owner. It is NOT this layer's job to flip a sign per claim. */

  it("REPORTS THE TWO RATES SEPARATELY", () => {
    const out = claimShapes(
      [
        claim({ id: "a", verdict: "take", outcome: "target", at: T0 + 2 * MIN }),
        claim({ id: "b", verdict: "take", outcome: "stop", at: T0 + 3 * MIN }),
        claim({ id: "c", verdict: "stand-down", outcome: "target", at: T0 + 4 * MIN }),
        claim({ id: "d", verdict: "stand-down", outcome: "target", at: T0 + 6 * MIN }),
        claim({ id: "e", verdict: "stand-down", outcome: "stop", at: T0 + 7 * MIN }),
      ],
      bars,
      SUBJECT,
    );
    expect(out.counted.takenDecided).toBe(2);
    expect(out.counted.takenHits).toBe(1);
    expect(out.counted.stoodDecided).toBe(3);
    expect(out.counted.stoodHits).toBe(2);
  });

  it("NEVER PRINTS A POOLED RATE over both populations", () => {
    /* 1 of 2 taken and 2 of 3 refused is not "3 of 5", and a reader given the
       pooled figure cannot recover either. */
    const out = claimShapes(
      [
        claim({ id: "a", verdict: "take", outcome: "target", at: T0 + 2 * MIN }),
        claim({ id: "b", verdict: "take", outcome: "stop", at: T0 + 3 * MIN }),
        claim({ id: "c", verdict: "stand-down", outcome: "target", at: T0 + 4 * MIN }),
        claim({ id: "d", verdict: "stand-down", outcome: "target", at: T0 + 6 * MIN }),
        claim({ id: "e", verdict: "stand-down", outcome: "stop", at: T0 + 7 * MIN }),
      ],
      bars,
      SUBJECT,
    );
    expect(out.why).not.toContain("3 of 5");
    expect(out.why).toMatch(/1 of 2/);
    expect(out.why).toMatch(/2 of 3/);
  });

  it("says a refused call reaching target is the REFUSAL being wrong", () => {
    // Without that, a green mark on a refusal reads as good news.
    const out = claimShapes(
      [
        claim({ id: "c", verdict: "stand-down", outcome: "target", at: T0 + 4 * MIN }),
        claim({ id: "e", verdict: "stand-down", outcome: "stop", at: T0 + 7 * MIN }),
      ],
      bars,
      SUBJECT,
    );
    expect(out.why).toMatch(/would have|refus|declin/i);
  });

  it("names only the population that exists when one is empty", () => {
    const out = claimShapes(
      [claim({ id: "a", verdict: "take", outcome: "target" })],
      bars,
      SUBJECT,
    );
    expect(out.why).toMatch(/1 of 1/);
    expect(out.why).not.toMatch(/0 of 0/);
  });
});

describe("the two verdicts are told apart on the chart itself", () => {
  it("A TAKE AND A REFUSAL SIT ON OPPOSITE SIDES OF THE BAR", () => {
    /* The modifier that used to carry this was a trailing dot, and with a group
       count after it `✓·45` read as a NEGATIVE NUMBER at 1:1. Position costs no
       characters and cannot be misread as arithmetic. */
    const take = claimShapes([claim({ verdict: "take" })], bars, SUBJECT);
    const stood = claimShapes([claim({ verdict: "stand-down" })], bars, SUBJECT);
    const a = take.shapes.find((sh) => sh.type === "marker") as { above: boolean };
    const b = stood.shapes.find((sh) => sh.type === "marker") as { above: boolean };
    expect(a.above).not.toBe(b.above);
  });

  it("NO GLYPH IS A CHARACTER A NUMBER CAN ABSORB", () => {
    /* MEASURED at 1:1 after the trailing dot was removed: the EXPIRED glyph was
       an en dash, so a group of ten expired calls rendered `–10` and read as
       NEGATIVE TEN. Exactly the defect the one-character rule was written to
       fix, surviving in the one glyph that is itself a minus sign - and the
       one-character test could not see it, because a dash IS one character.

       Pending is `·`, a decimal point, and would have done the same under
       `include: "all"`. The rule has to be about the CHARACTER CLASS, not the
       length. */
    const numeric = new Set(["-", "–", "—", "+", ".", "·", ",", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    for (const verdict of ["take", "stand-down"]) {
      for (const outcome of ["target", "stop", "expired", "unknowable", "pending"]) {
        const out = claimShapes([claim({ verdict, outcome })], bars, SUBJECT, { include: "all" });
        const m = out.shapes.find((sh) => sh.type === "marker") as { text: string };
        expect(numeric.has(m.text), `${verdict}/${outcome} drew ${JSON.stringify(m.text)}`).toBe(false);
      }
    }
  });

  it("EVERY GLYPH IS ONE CHARACTER, so an appended count cannot be misread", () => {
    for (const verdict of ["take", "stand-down"]) {
      for (const outcome of ["target", "stop", "expired", "unknowable"]) {
        const out = claimShapes([claim({ verdict, outcome })], bars, SUBJECT);
        const m = out.shapes.find((sh) => sh.type === "marker") as { text: string };
        expect([...m.text], `${verdict}/${outcome}`).toHaveLength(1);
      }
    }
  });
});

describe("what it says about itself", () => {
  it("states the sample, never a bare rate", () => {
    const out = claimShapes(
      [claim(), claim({ id: "2", outcome: "stop" }), claim({ id: "3", outcome: "pending" })],
      bars,
      SUBJECT,
    );
    expect(out.why).toMatch(/\d/);
    expect(out.why.length).toBeGreaterThan(24);
  });

  it("an empty ledger says so rather than drawing nothing silently", () => {
    const out = claimShapes([], bars, SUBJECT);
    expect(out.shapes).toHaveLength(0);
    expect(out.why).toContain("no claims");
  });

  it("never emits a shape with a non-finite coordinate", () => {
    // One NaN and the renderer drops it silently, which reads as a missing call.
    const out = claimShapes(
      [claim({ entry: Number.NaN }), claim({ id: "2", at: Number.NaN })],
      bars,
      SUBJECT,
    );
    for (const s of out.shapes) {
      for (const v of Object.values(s)) {
        if (typeof v === "number") expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
