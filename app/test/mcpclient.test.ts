/**
 * THE MCP CLIENT'S PURE PARTS — `data/mcp.ts`.
 *
 * `embeddedJson` is the one that matters. AN MCP TOOL ANSWERS A LANGUAGE MODEL,
 * so its text block is prose with the data inside it. MEASURED on a live server:
 *
 *     Here is the Crypto.com Exchange candlestick data {"instrument_name":...}
 *
 * `JSON.parse` on that throws, and it threw on the very first real call the
 * engine made — in the probe written to read it. The server has the same function
 * for the same reason (`svc/mcp.py embedded_json`, pinned by
 * `tests/test_mcp_client.py`); this one exists so the card can offer a parsed view
 * without pretending the prose is a contract.
 *
 * THE BARE-PARSE ASSERTION IS THE LOAD-BEARING ONE. Without it these tests pass
 * whatever the function does.
 *
 * `stateOf` is here because THREE STATES, NOT TWO, is the whole point: a server
 * waiting for a sign-in is not broken, and filing it with the failures buries the
 * ones that are. One owner for that judgement, because the card, the rail colour
 * and the row detail all ask.
 */

import { describe, expect, it } from "vitest";
import { argHint, embeddedJson, stateOf, type McpTool } from "../src/data/mcp";

const REAL =
  "Here is the Crypto.com Exchange candlestick data " +
  '{"instrument_name":"BTC_USD","timeframe":"1h","data":' +
  '[{"open":"84719.82","close":"84879.90","timestamp":"2026-09-25T11:00:00Z"}]}';

describe("embeddedJson finds the data inside a tool's prose", () => {
  it("a bare JSON.parse fails on the real answer", () => {
    expect(() => JSON.parse(REAL)).toThrow();
  });

  it("finds the object and keeps the prose separately", () => {
    const got = embeddedJson(REAL);
    expect(got).not.toBeNull();
    expect((got!.data as { instrument_name: string }).instrument_name).toBe("BTC_USD");
    expect(got!.prose).toBe("Here is the Crypto.com Exchange candlestick data");
  });

  it("survives a trailing sentence after the object", () => {
    const got = embeddedJson('Data: {"a": 1} Let me know if you need more.');
    expect(got!.data).toEqual({ a: 1 });
    expect(got!.prose).toContain("Let me know");
  });

  it("finds an array as well as an object", () => {
    expect(embeddedJson("Here you go: [1, 2, 3]")!.data).toEqual([1, 2, 3]);
  });

  it("takes the whole object when braces are nested", () => {
    const got = embeddedJson('Result {"a": {"b": [1, {"c": 2}]}} done');
    expect(got!.data).toEqual({ a: { b: [1, { c: 2 }] } });
    expect(got!.prose).toBe("Result  done");
  });

  it("returns null for prose with no data rather than an empty object", () => {
    // Null and `{}` are different facts: one says the tool explained itself in
    // words, the other says it answered with nothing.
    expect(embeddedJson("I could not find that instrument.")).toBeNull();
    expect(embeddedJson("")).toBeNull();
  });

  it("returns null for malformed JSON and never repairs it", () => {
    expect(embeddedJson('data {"a": ')).toBeNull();
  });
});

describe("stateOf keeps three states apart", () => {
  const shook = {
    ok: true as const,
    url: "https://x.test/mcp",
    protocol: "2025-03-26",
    name: "X",
    version: "1",
  };

  it("not checked yet is its own state, not a failure", () => {
    expect(stateOf(null, false).state).toBe("unknown");
  });

  it("a server needing no sign-in reads as connected and says so", () => {
    const got = stateOf(shook, false);
    expect(got.state).toBe("connected");
    expect(got.detail).toContain("no sign-in needed");
  });

  it("a signed-in server says which protocol it agreed", () => {
    const got = stateOf(shook, true);
    expect(got.state).toBe("connected");
    expect(got.detail).toContain("2025-03-26");
  });

  it("needing a sign-in is NOT refused", () => {
    // The distinction the whole card rests on: this one the operator can fix.
    const got = stateOf(
      { ok: false, needsAuth: true, why: "this server wants you to sign in" },
      false,
    );
    expect(got.state).toBe("needs-sign-in");
    expect(got.detail).toContain("sign in");
  });

  it("a genuine failure is refused and carries the reason", () => {
    const got = stateOf(
      { ok: false, needsAuth: false, why: "could not reach this server: ConnectError" },
      false,
    );
    expect(got.state).toBe("refused");
    expect(got.detail).toContain("could not reach");
  });
});

describe("argHint says what a tool takes", () => {
  const tool = (over: Partial<McpTool>): McpTool => ({
    name: "t",
    title: "T",
    description: "",
    required: [],
    properties: [],
    ...over,
  });

  it("names a tool that takes nothing rather than showing an empty string", () => {
    expect(argHint(tool({}))).toBe("takes nothing");
  });

  it("marks the optional arguments and leaves the required ones bare", () => {
    expect(
      argHint(tool({ properties: ["instrument_name", "timeframe"], required: ["instrument_name"] })),
    ).toBe("instrument_name, timeframe?");
  });
});
