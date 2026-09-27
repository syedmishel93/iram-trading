import { describe, it, expect } from "vitest";
import { fallbackProvider, isTransportFailure, type Provider } from "../src/agent/provider";

const reply = (text: string) => ({ text, toolCalls: [] as const });

const stub = (over: Partial<Provider> = {}): Provider => ({
  id: "openai",
  label: "OpenAI-compatible",
  privacy: "Goes to the endpoint you configured.",
  ready: () => ({ ok: true }),
  chat: async () => reply("remote answer"),
  ...over,
});

const local = stub({ id: "offline", label: "Local analyst", chat: async () => reply("local answer") });

const hooks = () => {
  const seen: string[] = [];
  return {
    seen,
    onFallback: (r: string) => seen.push(r),
    onPrimary: () => seen.push(""),
  };
};

describe("isTransportFailure", () => {
  it("recognises a fetch rejection", () => {
    expect(isTransportFailure(new TypeError("Failed to fetch"))).toBe(true);
  });

  // Cross-realm TypeErrors fail `instanceof`; the name still holds.
  it("recognises one from another realm by name", () => {
    const err = new Error("Failed to fetch");
    err.name = "TypeError";
    expect(isTransportFailure(err)).toBe(true);
  });

  it("does not treat an HTTP error as a transport failure", () => {
    expect(isTransportFailure(new Error("401 Unauthorized"))).toBe(false);
  });
});

describe("fallbackProvider", () => {
  it("uses the primary when it answers", async () => {
    const h = hooks();
    const p = fallbackProvider(() => stub(), local, h);
    expect((await p.chat([], [])).text).toBe("remote answer");
    expect(h.seen).toEqual([""]);
  });

  // THE BUG THIS EXISTS FOR: the OpenAI-compatible provider defaults to a
  // localhost URL and a model name, so `ready()` says yes on a machine where
  // nothing is listening. Configuration is not reachability.
  it("falls back when the endpoint is configured but nothing is listening", async () => {
    const h = hooks();
    const p = fallbackProvider(
      () =>
        stub({
          chat: async () => {
            throw new TypeError("Failed to fetch");
          },
        }),
      local,
      h,
    );
    expect((await p.chat([], [])).text).toBe("local answer");
    expect(h.seen[0]).toMatch(/not reachable/);
    expect(h.seen[0]).toMatch(/terminal's own data/);
  });

  // Falling back here would hide a wrong API key behind plausible local
  // answers — the worst of the three outcomes.
  it("lets an HTTP refusal through instead of hiding it", async () => {
    const h = hooks();
    const p = fallbackProvider(
      () =>
        stub({
          chat: async () => {
            throw new Error("401 Unauthorized — invalid x-api-key");
          },
        }),
      local,
      h,
    );
    await expect(p.chat([], [])).rejects.toThrow(/401/);
    expect(h.seen).toEqual([""]);
  });

  it("does not treat the user pressing stop as a failure", async () => {
    const h = hooks();
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const p = fallbackProvider(() => stub({ chat: async () => { throw abort; } }), local, h);
    await expect(p.chat([], [])).rejects.toThrow(/aborted/);
    expect(h.seen).toEqual([]);
  });

  it("falls back when the primary is not configured, without calling it", async () => {
    const h = hooks();
    let called = false;
    const p = fallbackProvider(
      () =>
        stub({
          ready: () => ({ ok: false, reason: "no model name" }),
          chat: async () => {
            called = true;
            return reply("should not happen");
          },
        }),
      local,
      h,
    );
    expect((await p.chat([], [])).text).toBe("local answer");
    expect(called).toBe(false);
    expect(h.seen[0]).toMatch(/not configured \(no model name\)/);
  });

  // Per-call, never sticky: starting the model server mid-session must work
  // without reloading the terminal.
  it("tries the primary again on the next message", async () => {
    const h = hooks();
    let up = false;
    const p = fallbackProvider(
      () =>
        stub({
          chat: async () => {
            if (!up) throw new TypeError("Failed to fetch");
            return reply("remote answer");
          },
        }),
      local,
      h,
    );
    expect((await p.chat([], [])).text).toBe("local answer");
    up = true;
    expect((await p.chat([], [])).text).toBe("remote answer");
    expect(h.seen[1]).toBe("");
  });

  // The desk must never be blocked from answering: there is always a floor.
  it("always reports itself ready", () => {
    const p = fallbackProvider(() => stub({ ready: () => ({ ok: false, reason: "x" }) }), local, hooks());
    expect(p.ready().ok).toBe(true);
  });

  it("reports the primary's identity, not its own", () => {
    const p = fallbackProvider(() => stub({ id: "anthropic", label: "Anthropic" }), local, hooks());
    expect(p.id).toBe("anthropic");
    expect(p.label).toBe("Anthropic");
  });
});
