import { describe, it, expect, vi } from "vitest";
import {
  parseChord,
  parseSequence,
  chordMatches,
  chordFromEvent,
  formatChord,
  formatSequence,
  createKeymap,
  detectPlatform,
  type Chord,
} from "../src/core/keys";

/** A KeyboardEvent stand-in. jsdom is not loaded for this file. */
function ev(key: string, mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {}) {
  let defaultPrevented = false;
  return {
    key,
    ctrlKey: mods.ctrl === true,
    altKey: mods.alt === true,
    shiftKey: mods.shift === true,
    metaKey: mods.meta === true,
    target: null,
    preventDefault() {
      defaultPrevented = true;
    },
    get defaultPrevented() {
      return defaultPrevented;
    },
  } as unknown as KeyboardEvent;
}

/** A fake focused element, for the typing guard. */
function inputEv(key: string, tag = "INPUT", type = "text"): KeyboardEvent {
  const e = ev(key) as unknown as { target: unknown };
  e.target = { tagName: tag, type, isContentEditable: false };
  return e as unknown as KeyboardEvent;
}

describe("detectPlatform", () => {
  it("recognises macOS", () => {
    expect(detectPlatform({ platform: "MacIntel", userAgent: "" })).toBe("mac");
  });
  it("recognises iOS", () => {
    expect(detectPlatform({ platform: "", userAgent: "iPhone" })).toBe("mac");
  });
  it("defaults everything else to other", () => {
    expect(detectPlatform({ platform: "Win32", userAgent: "" })).toBe("other");
  });
});

describe("parseChord", () => {
  it("parses a bare key", () => {
    expect(parseChord("k", "other")).toEqual({
      key: "k",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  });

  it("parses modifiers", () => {
    expect(parseChord("Ctrl+Shift+K", "other")).toMatchObject({ key: "k", ctrl: true, shift: true });
  });

  // Mod is the whole reason the platform is a parameter: writing Ctrl+K and
  // Cmd+K in two places is how one of them rots.
  it("resolves Mod to Ctrl off macOS and Meta on it", () => {
    expect(parseChord("Mod+K", "other")).toMatchObject({ ctrl: true, meta: false });
    expect(parseChord("Mod+K", "mac")).toMatchObject({ ctrl: false, meta: true });
  });

  it("aliases named keys", () => {
    expect(parseChord("Esc", "other")?.key).toBe("escape");
    expect(parseChord("Space", "other")?.key).toBe(" ");
    expect(parseChord("Up", "other")?.key).toBe("arrowup");
  });

  it("parses a trailing literal plus", () => {
    expect(parseChord("Mod++", "other")).toMatchObject({ key: "+", ctrl: true });
  });

  it("returns null for an unknown modifier rather than throwing", () => {
    expect(parseChord("Hyper+K", "other")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseChord("   ", "other")).toBeNull();
  });
});

describe("parseSequence", () => {
  it("parses a single chord", () => {
    expect(parseSequence("Mod+K", "other")?.length).toBe(1);
  });

  it("parses a multi-chord sequence", () => {
    const seq = parseSequence("g c", "other");
    expect(seq?.length).toBe(2);
    expect(seq?.[0]?.key).toBe("g");
    expect(seq?.[1]?.key).toBe("c");
  });

  it("fails the whole sequence if any chord is bad", () => {
    expect(parseSequence("g Hyper+c", "other")).toBeNull();
  });
});

describe("chordMatches", () => {
  const bound = (s: string): Chord => parseChord(s, "other") as Chord;

  it("matches an exact chord", () => {
    expect(chordMatches(bound("Ctrl+K"), chordFromEvent(ev("k", { ctrl: true })))).toBe(true);
  });

  it("rejects a missing modifier", () => {
    expect(chordMatches(bound("Ctrl+K"), chordFromEvent(ev("k")))).toBe(false);
  });

  it("rejects an extra modifier", () => {
    expect(chordMatches(bound("k"), chordFromEvent(ev("k", { ctrl: true })))).toBe(false);
  });

  // On most layouts "?" cannot be typed without Shift. A binding for "?" that
  // rejected the Shift it required would never fire at all.
  it("accepts the shift a symbol key needs to exist", () => {
    expect(chordMatches(bound("?"), chordFromEvent(ev("?", { shift: true })))).toBe(true);
  });

  it("still requires shift when the binding asks for it", () => {
    expect(chordMatches(bound("Shift+K"), chordFromEvent(ev("k")))).toBe(false);
    expect(chordMatches(bound("Shift+K"), chordFromEvent(ev("K", { shift: true })))).toBe(true);
  });

  it("rejects an unrequested shift on a letter", () => {
    expect(chordMatches(bound("k"), chordFromEvent(ev("K", { shift: true })))).toBe(false);
  });
});

describe("formatChord", () => {
  it("writes Windows style off macOS", () => {
    expect(formatChord(parseChord("Mod+Shift+K", "other") as Chord, "other")).toBe("Ctrl+Shift+K");
  });

  // ⌃⌥⇧⌘ is fixed by convention. Any other order reads as wrong to anyone who
  // has used a Mac application.
  it("writes macOS symbols in the conventional order", () => {
    const chord = parseChord("Ctrl+Alt+Shift+Cmd+K", "mac") as Chord;
    expect(formatChord(chord, "mac")).toBe("⌃⌥⇧⌘K");
  });

  it("labels named keys legibly", () => {
    expect(formatChord(parseChord("Esc", "other") as Chord, "other")).toBe("Esc");
    expect(formatChord(parseChord("Space", "other") as Chord, "other")).toBe("Space");
  });

  it("formats a sequence with spaces", () => {
    expect(formatSequence(parseSequence("g c", "other") as Chord[], "other")).toBe("G C");
  });
});

describe("createKeymap", () => {
  it("fires a bound chord and reports consumption", () => {
    const km = createKeymap("other");
    const run = vi.fn();
    km.bind("Mod+K", "palette.open", run);
    expect(km.handle(ev("k", { ctrl: true }))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("ignores an unbound key", () => {
    const km = createKeymap("other");
    expect(km.handle(ev("q"))).toBe(false);
  });

  it("calls preventDefault only when it consumes the event", () => {
    const km = createKeymap("other");
    km.bind("f", "focus", () => {});
    const hit = ev("f");
    km.handle(hit);
    expect(hit.defaultPrevented).toBe(true);
    const miss = ev("q");
    km.handle(miss);
    expect(miss.defaultPrevented).toBe(false);
  });

  it("unbinds via the returned disposer", () => {
    const km = createKeymap("other");
    const run = vi.fn();
    const off = km.bind("f", "focus", run);
    off();
    expect(km.handle(ev("f"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  // The single most important rule in the file: while you are typing, letters
  // are letters.
  it("does not fire a bare letter while focus is in a text field", () => {
    const km = createKeymap("other");
    const run = vi.fn();
    km.bind("f", "focus", run);
    expect(km.handle(inputEv("f"))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("fires in a text field when the binding opts in", () => {
    const km = createKeymap("other");
    const run = vi.fn();
    km.bind("Escape", "close", run, { allowInInput: true });
    expect(km.handle(inputEv("Escape"))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  // A range slider or a checkbox does not swallow text, so a shortcut over one
  // is still a shortcut.
  it("treats non-text inputs as safe for shortcuts", () => {
    const km = createKeymap("other");
    const run = vi.fn();
    km.bind("f", "focus", run);
    expect(km.handle(inputEv("f", "INPUT", "range"))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("respects a when() gate", () => {
    const km = createKeymap("other");
    const run = vi.fn();
    let allowed = false;
    km.bind("f", "focus", run, { when: () => allowed });
    expect(km.handle(ev("f"))).toBe(false);
    allowed = true;
    expect(km.handle(ev("f"))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs a two-chord sequence", () => {
    const km = createKeymap("other");
    const run = vi.fn();
    km.bind("g c", "goto.chart", run);
    expect(km.handle(ev("g"))).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(km.pending().length).toBe(1);
    expect(km.handle(ev("c"))).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(km.pending().length).toBe(0);
  });

  it("abandons a sequence on a key that continues nothing", () => {
    const km = createKeymap("other");
    const run = vi.fn();
    km.bind("g c", "goto.chart", run);
    km.handle(ev("g"));
    expect(km.handle(ev("z"))).toBe(false);
    expect(km.pending().length).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  // A prefix that stays armed forever eats the next keystroke minutes later.
  it("drops a pending prefix after the timeout", () => {
    vi.useFakeTimers();
    try {
      const km = createKeymap("other");
      const run = vi.fn();
      km.bind("g c", "goto.chart", run);
      km.handle(ev("g"));
      expect(km.pending().length).toBe(1);
      vi.advanceTimersByTime(2000);
      expect(km.pending().length).toBe(0);
      km.handle(ev("c"));
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a sequence while focus is in a text field", () => {
    const km = createKeymap("other");
    km.bind("g c", "goto.chart", () => {});
    expect(km.handle(inputEv("g"))).toBe(false);
    expect(km.pending().length).toBe(0);
  });

  it("never treats a modifier keypress as a chord", () => {
    const km = createKeymap("other");
    expect(km.handle(ev("Control", { ctrl: true }))).toBe(false);
    expect(km.handle(ev("Shift", { shift: true }))).toBe(false);
  });

  // The status-bar indicator binds to this. Polling would not do: the prefix
  // can clear on a TIMER with no input to hang a repaint off, and an indicator
  // still lit after the sequence expired is worse than none.
  it("announces the pending prefix as it changes", () => {
    const km = createKeymap("other");
    const seen: string[][] = [];
    km.onPending((chords) => seen.push(chords.map((c) => c.key)));
    km.bind("g c", "goto.chart", () => {});
    km.handle(ev("g"));
    km.handle(ev("c"));
    expect(seen).toEqual([["g"], []]);
  });

  it("announces the prefix clearing on timeout", () => {
    vi.useFakeTimers();
    try {
      const km = createKeymap("other");
      const seen: number[] = [];
      km.onPending((chords) => seen.push(chords.length));
      km.bind("g c", "goto.chart", () => {});
      km.handle(ev("g"));
      vi.advanceTimersByTime(2000);
      expect(seen).toEqual([1, 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not announce when nothing was pending", () => {
    const km = createKeymap("other");
    const seen: number[] = [];
    km.onPending((chords) => seen.push(chords.length));
    km.bind("f", "focus", () => {});
    km.handle(ev("f"));
    km.handle(ev("z"));
    expect(seen).toEqual([]);
  });

  it("detaches a pending listener", () => {
    const km = createKeymap("other");
    const seen: number[] = [];
    const off = km.onPending((chords) => seen.push(chords.length));
    km.bind("g c", "goto.chart", () => {});
    off();
    km.handle(ev("g"));
    expect(seen).toEqual([]);
  });

  it("exposes bindings for the help sheet", () => {
    const km = createKeymap("other");
    km.bind("Mod+K", "palette.open", () => {});
    expect(km.list().length).toBe(1);
    expect(km.keysFor("palette.open")).toBe("Mod+K");
    expect(km.keysFor("nope")).toBeNull();
  });

  // Registration order wins so behaviour is deterministic; the warning is how
  // the clash actually gets fixed.
  it("warns on a duplicate binding and keeps the first", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const km = createKeymap("other");
      const first = vi.fn();
      const second = vi.fn();
      km.bind("Mod+K", "one", first);
      km.bind("Mod+K", "two", second);
      expect(warn).toHaveBeenCalled();
      km.handle(ev("k", { ctrl: true }));
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns on an unparseable binding without taking the keymap down", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const km = createKeymap("other");
      km.bind("Hyper+K", "bad", () => {});
      const run = vi.fn();
      km.bind("f", "good", run);
      expect(km.handle(ev("f"))).toBe(true);
      expect(run).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
