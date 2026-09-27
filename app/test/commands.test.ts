import { describe, it, expect, vi } from "vitest";
import { createCommands, groupCommands, type Command } from "../src/core/commands";

const cmd = (id: string, title: string, over: Partial<Command> = {}): Command => ({
  id,
  title,
  group: "Test",
  run: () => {},
  ...over,
});

describe("createCommands", () => {
  it("registers and retrieves", () => {
    const reg = createCommands();
    reg.register(cmd("a.one", "One"));
    expect(reg.get("a.one")?.title).toBe("One");
    expect(reg.all().length).toBe(1);
  });

  it("keeps registration order", () => {
    const reg = createCommands();
    reg.register(cmd("z", "Zebra"), cmd("a", "Apple"));
    expect(reg.all().map((c) => c.id)).toEqual(["z", "a"]);
  });

  it("unregisters via the returned disposer", () => {
    const reg = createCommands();
    const off = reg.register(cmd("a", "One"), cmd("b", "Two"));
    off();
    expect(reg.all().length).toBe(0);
  });

  // A silently replaced id looks like the first registration never happened.
  it("warns on a duplicate id and replaces it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reg = createCommands();
      reg.register(cmd("a", "First"));
      reg.register(cmd("a", "Second"));
      expect(warn).toHaveBeenCalled();
      expect(reg.all().length).toBe(1);
      expect(reg.get("a")?.title).toBe("Second");
    } finally {
      warn.mockRestore();
    }
  });

  it("runs a command", () => {
    const reg = createCommands();
    const run = vi.fn();
    reg.register(cmd("a", "One", { run }));
    reg.run("a");
    expect(run).toHaveBeenCalledOnce();
  });

  it("warns rather than throwing on an unknown id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => createCommands().run("ghost")).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses to run a command whose when() is false", () => {
    const reg = createCommands();
    const run = vi.fn();
    reg.register(cmd("a", "One", { run, when: () => false }));
    reg.run("a");
    expect(run).not.toHaveBeenCalled();
  });

  // The palette is how you reach every other feature, including the ones that
  // would let you recover. It must survive a command that throws.
  it("contains a throwing command", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reg = createCommands();
      reg.register(cmd("boom", "Boom", { run: () => { throw new Error("nope"); } }));
      expect(() => reg.run("boom")).not.toThrow();
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("contains a rejecting async command", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reg = createCommands();
      reg.register(cmd("boom", "Boom", { run: () => Promise.reject(new Error("nope")) }));
      reg.run("boom");
      await Promise.resolve();
      await Promise.resolve();
      expect(err).toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });

  it("filters available() by when()", () => {
    const reg = createCommands();
    let on = false;
    reg.register(cmd("a", "One"), cmd("b", "Two", { when: () => on }));
    expect(reg.available().map((c) => c.id)).toEqual(["a"]);
    on = true;
    expect(reg.available().length).toBe(2);
  });

  it("notifies run listeners and detaches them", () => {
    const reg = createCommands();
    const seen: string[] = [];
    const off = reg.onRun((id) => seen.push(id));
    reg.register(cmd("a", "One"));
    reg.run("a");
    off();
    reg.run("a");
    expect(seen).toEqual(["a"]);
  });
});

describe("search", () => {
  const build = () => {
    const reg = createCommands();
    reg.register(
      cmd("chart.ema200", "Toggle EMA 200", { group: "Chart", keywords: "moving average trend" }),
      cmd("data.export", "Export vault", { group: "Data" }),
      cmd("ws.split", "Split pane right", { group: "Workspace" }),
      cmd("hidden.one", "Hidden", { when: () => false }),
    );
    return reg;
  };

  it("returns everything available for an empty query", () => {
    expect(build().search("").length).toBe(3);
  });

  it("excludes unavailable commands", () => {
    expect(build().search("hidden").length).toBe(0);
  });

  it("finds by title", () => {
    expect(build().search("ema")[0]?.item.id).toBe("chart.ema200");
  });

  it("finds by keyword", () => {
    expect(build().search("moving")[0]?.item.id).toBe("chart.ema200");
  });

  it("finds by group prefix, the way it is rendered", () => {
    expect(build().search("workspace split")[0]?.item.id).toBe("ws.split");
  });

  it("finds by id", () => {
    expect(build().search("data.export")[0]?.item.id).toBe("data.export");
  });

  it("honours the limit", () => {
    expect(build().search("", 2).length).toBe(2);
  });

  it("returns match positions for highlighting", () => {
    const out = build().search("export");
    expect((out[0]?.positions.length ?? 0)).toBeGreaterThan(0);
  });
});

describe("recency", () => {
  it("puts the last-run command first on an empty query", () => {
    const reg = createCommands();
    reg.register(cmd("a", "Alpha"), cmd("b", "Bravo"), cmd("c", "Charlie"));
    reg.run("c");
    expect(reg.search("")[0]?.item.id).toBe("c");
  });

  // A session has phases. What you reached for a minute ago is far more likely
  // to be next than what you reach for every morning.
  it("orders by recency, not by frequency", () => {
    const reg = createCommands();
    reg.register(cmd("a", "Alpha"), cmd("b", "Bravo"));
    reg.run("a");
    reg.run("a");
    reg.run("b");
    expect(reg.search("").map((r) => r.item.id).slice(0, 2)).toEqual(["b", "a"]);
  });

  it("does not duplicate an id in the recent list", () => {
    const reg = createCommands();
    reg.register(cmd("a", "Alpha"));
    reg.run("a");
    reg.run("a");
    expect(reg.recent()).toEqual(["a"]);
  });

  it("boosts a recent command among near-ties", () => {
    const reg = createCommands();
    reg.register(cmd("x.alpha", "Alpha one"), cmd("y.alpha", "Alpha two"));
    expect(reg.search("alpha")[0]?.item.id).toBe("x.alpha");
    reg.run("y.alpha");
    expect(reg.search("alpha")[0]?.item.id).toBe("y.alpha");
  });

  // Recency reorders near-ties; it must not override a clearly better match,
  // or the palette stops answering what you typed.
  it("does not let recency beat a decisively better text match", () => {
    const reg = createCommands();
    reg.register(cmd("chart.ema", "EMA"), cmd("data.export", "Export vault"));
    reg.run("data.export");
    expect(reg.search("ema")[0]?.item.id).toBe("chart.ema");
  });

  it("seeds recency from storage", () => {
    const reg = createCommands();
    reg.register(cmd("a", "Alpha"), cmd("b", "Bravo"));
    reg.seedRecent(["b"]);
    expect(reg.search("")[0]?.item.id).toBe("b");
  });

  it("ignores non-strings when seeding", () => {
    const reg = createCommands();
    reg.seedRecent(["a", 3 as unknown as string, "b"]);
    expect(reg.recent()).toEqual(["a", "b"]);
  });

  it("caps the recent list", () => {
    const reg = createCommands();
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push(`c${i}`);
    reg.register(...ids.map((id) => cmd(id, id)));
    for (const id of ids) reg.run(id);
    expect(reg.recent().length).toBeLessThanOrEqual(24);
    expect(reg.recent()[0]).toBe("c39");
  });
});

describe("groupCommands", () => {
  it("groups while preserving order inside each group", () => {
    const out = groupCommands([
      cmd("a", "A", { group: "Chart" }),
      cmd("b", "B", { group: "Data" }),
      cmd("c", "C", { group: "Chart" }),
    ]);
    expect([...out.keys()]).toEqual(["Chart", "Data"]);
    expect(out.get("Chart")?.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("returns an empty map for an empty list", () => {
    expect(groupCommands([]).size).toBe(0);
  });
});
