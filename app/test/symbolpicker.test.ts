// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSymbolPicker,
  isAcceptableSymbol,
  MIN_SYMBOL_LENGTH,
  normaliseSymbol,
  rejectionReason,
  type SymbolMatch,
} from "../src/ui/symbolpicker";

const UNIVERSE = ["BTCUSDT", "ETHUSDT", "BTCDOWNUSDT", "XRPUSDT", "SOLUSDT"];

const search = (q: string, limit: number): SymbolMatch[] =>
  UNIVERSE.filter((s) => s.startsWith(normaliseSymbol(q)))
    .slice(0, limit)
    .map((symbol) => ({ symbol, detail: "1.2B 24h" }));

function mount(current = "BTCUSDT") {
  const input = document.createElement("input");
  input.value = current;
  document.body.appendChild(input);
  const commit = vi.fn();
  const reject = vi.fn();
  const picker = createSymbolPicker({
    input,
    search,
    current: () => current,
    commit,
    reject,
  });
  document.body.appendChild(picker.el);
  return { input, picker, commit, reject };
}

const key = (input: HTMLInputElement, k: string) =>
  input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

const type = (input: HTMLInputElement, v: string) => {
  input.value = v;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("symbol acceptance", () => {
  const known = (s: string) => UNIVERSE.includes(s);

  it("accepts a catalogued symbol", () => {
    expect(isAcceptableSymbol("ETHUSDT", known)).toBe(true);
  });

  it("accepts an instrument the catalogue has never heard of", () => {
    /* EURUSD and XAUUSD come from the MT5 bridge, not Binance. A picker that
       only accepted its own list would break FX entirely. */
    expect(isAcceptableSymbol("EURUSD", known)).toBe(true);
    expect(isAcceptableSymbol("XAUUSD", known)).toBe(true);
  });

  it("rejects a half-typed ticker — the bug that persisted a dead symbol", () => {
    expect(isAcceptableSymbol("ETH", known)).toBe(false);
    expect(isAcceptableSymbol("BT", known)).toBe(false);
  });

  it("rejects blanks and anything with a space", () => {
    expect(isAcceptableSymbol("", known)).toBe(false);
    expect(isAcceptableSymbol("   ", known)).toBe(false);
    expect(isAcceptableSymbol("BTC USDT", known)).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normaliseSymbol("  ethusdt  ")).toBe("ETHUSDT");
    expect(isAcceptableSymbol(" ethusdt ", known)).toBe(true);
  });

  it("explains a refusal in words rather than ignoring the box", () => {
    expect(rejectionReason("ETH")).toContain("too short");
    expect(rejectionReason("BTC USDT")).toContain("not shaped like a ticker");
  });

  it("MIN_SYMBOL_LENGTH still admits the shortest instrument actually quoted", () => {
    expect("EURUSD".length).toBeGreaterThanOrEqual(MIN_SYMBOL_LENGTH);
  });
});

describe("symbol picker", () => {
  it("opens on focus and lists the catalogue", () => {
    const { input, picker } = mount();
    input.dispatchEvent(new Event("focus"));
    expect(picker.isOpen()).toBe(true);
    expect(picker.el.querySelectorAll(".sym-opt").length).toBeGreaterThan(0);
  });

  it("filters as you type and ranks the exact prefix first", () => {
    const { input, picker } = mount();
    type(input, "BTC");
    const names = [...picker.el.querySelectorAll(".sym-opt-name")].map((n) => n.textContent);
    expect(names[0]).toBe("BTCUSDT");
    expect(names).toContain("BTCDOWNUSDT");
  });

  it("commits the highlighted row on Enter", () => {
    const { input, commit } = mount();
    type(input, "ETH");
    key(input, "Enter");
    expect(commit).toHaveBeenCalledWith("ETHUSDT");
  });

  it("commits a full ticker typed without touching the list", () => {
    const { input, commit } = mount();
    type(input, "EURUSD");
    /* No row matches, so nothing is highlighted and Enter takes the text. */
    key(input, "Enter");
    expect(commit).toHaveBeenCalledWith("EURUSD");
  });

  it("does NOT commit a half-typed symbol on Enter, and says why", () => {
    const { input, commit, reject } = mount();
    input.dispatchEvent(new Event("focus"));
    type(input, "ZZ");
    key(input, "Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalled();
    expect(input.value).toBe("BTCUSDT");
  });

  it("restores on blur instead of committing — the dead-symbol fix", () => {
    const { input, commit } = mount();
    type(input, "ETH");
    input.dispatchEvent(new Event("blur"));
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe("BTCUSDT");
  });

  it("abandons the edit on Escape", () => {
    const { input, picker, commit } = mount();
    type(input, "SOL");
    key(input, "Escape");
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe("BTCUSDT");
    expect(picker.isOpen()).toBe(false);
  });

  it("stops Escape propagating, so abandoning an edit does not also close the dock", () => {
    const { input } = mount();
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    type(input, "SOL");
    key(input, "Escape");
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
  });

  it("moves the highlight with the arrow keys and wraps", () => {
    const { input, picker, commit } = mount();
    type(input, "BTC");
    key(input, "ArrowDown");
    const active = picker.el.querySelector('[data-active="true"] .sym-opt-name');
    expect(active?.textContent).toBe("BTCDOWNUSDT");
    key(input, "Enter");
    expect(commit).toHaveBeenCalledWith("BTCDOWNUSDT");
  });

  it("a stray Enter straight after focus cannot change the instrument", () => {
    /* Nothing is highlighted while browsing, and Enter with nothing typed
       abandons the edit rather than re-committing what is already on screen —
       so a stray keystroke is inert instead of merely harmless. */
    const { input, picker, commit } = mount();
    input.dispatchEvent(new Event("focus"));
    expect(picker.el.querySelector('[data-active="true"]')).toBeNull();
    key(input, "Enter");
    expect(commit).not.toHaveBeenCalled();
    expect(input.value).toBe("BTCUSDT");
  });

  describe("browsing", () => {
    /**
     * The reported problem, in one sentence: "when i click the currency pair it
     * should show all the pairs that is available".
     *
     * It did not. On focus the box still holds the current symbol, so the query
     * was that symbol and the list opened already narrowed to it — on XAUUSD
     * that was four instruments, every one of them XAU. Opening the list is a
     * different question from searching it, and until `browsing` existed there
     * was no way to ask the first one.
     */
    it("shows the WHOLE universe on open, not just the symbol in the box", () => {
      const { input, picker } = mount("BTCUSDT");
      input.dispatchEvent(new Event("focus"));
      const names = [...picker.el.querySelectorAll(".sym-opt-name")].map((e) => e.textContent);
      expect(names).toEqual(UNIVERSE);
    });

    it("narrows to the query the moment anything is typed", () => {
      const { input, picker } = mount("BTCUSDT");
      input.dispatchEvent(new Event("focus"));
      type(input, "SOL");
      const names = [...picker.el.querySelectorAll(".sym-opt-name")].map((e) => e.textContent);
      expect(names).toEqual(["SOLUSDT"]);
    });

    it("goes back to browsing after the edit is abandoned", () => {
      const { input, picker } = mount("BTCUSDT");
      input.dispatchEvent(new Event("focus"));
      type(input, "SOL");
      key(input, "Escape");
      input.dispatchEvent(new Event("focus"));
      expect(picker.el.querySelectorAll(".sym-opt")).toHaveLength(UNIVERSE.length);
    });

    it("reopens when an already-focused box is clicked", () => {
      /* Without this, dismissing with Escape and clicking the box again fires
         no focus event, nothing reopens, and the control reads as dead at
         exactly the moment someone is retrying it. */
      const { input, picker } = mount();
      input.dispatchEvent(new Event("focus"));
      key(input, "Escape");
      expect(picker.isOpen()).toBe(false);
      input.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(picker.isOpen()).toBe(true);
    });

    it("stays open on a query that matches nothing", () => {
      /* The footer explains an empty result. A panel that vanishes on a typo is
         how a control starts feeling broken. */
      const { input, picker } = mount();
      input.dispatchEvent(new Event("focus"));
      type(input, "ZZZZZZ");
      expect(picker.isOpen()).toBe(true);
      expect(picker.el.querySelector(".sym-foot")?.textContent).toContain("No match");
    });
  });

  describe("currency tabs", () => {
    const withTabs = () => {
      const input = document.createElement("input");
      input.value = "BTCUSDT";
      document.body.appendChild(input);
      const seen: (string | null)[] = [];
      const picker = createSymbolPicker({
        input,
        filters: [{ id: "USDT", label: "USDT" }],
        total: (f) => (f === null ? 99 : 42),
        search: (q, limit, filter) => {
          seen.push(filter);
          return search(q, limit);
        },
        current: () => "BTCUSDT",
        commit: vi.fn(),
      });
      document.body.appendChild(picker.el);
      return { input, picker, seen };
    };

    it("renders an All tab plus one per filter, All selected", () => {
      const { picker } = withTabs();
      const tabs = [...picker.el.querySelectorAll(".sym-tab")];
      expect(tabs.map((t) => t.textContent)).toEqual(["All", "USDT"]);
      expect(tabs[0]?.getAttribute("data-on")).toBe("true");
    });

    it("passes the chosen filter down to the search", () => {
      const { input, picker, seen } = withTabs();
      input.dispatchEvent(new Event("focus"));
      seen.length = 0;
      const usdt = picker.el.querySelectorAll(".sym-tab")[1] as HTMLElement;
      usdt.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
      expect(seen).toContain("USDT");
    });

    it("suppresses the default on a tab press so the box keeps focus", () => {
      /* A click blurs the input first, and blur RESTORES and closes — so
         without preventDefault the panel shuts before the tab's own handler
         runs and the tabs appear completely dead. */
      const { input, picker } = withTabs();
      input.dispatchEvent(new Event("focus"));
      const usdt = picker.el.querySelectorAll(".sym-tab")[1] as HTMLElement;
      const ev = new Event("pointerdown", { bubbles: true, cancelable: true });
      usdt.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(picker.isOpen()).toBe(true);
    });

    it("says how many of the tab's instruments are on screen", () => {
      const { input, picker } = withTabs();
      input.dispatchEvent(new Event("focus"));
      expect(picker.el.querySelector(".sym-foot")?.textContent).toContain("of 99");
    });
  });

  it("survives a browser with no scrollIntoView", () => {
    /* jsdom has none, and neither do some embedded webviews. Arrow keys must
       not throw where the only thing lost is a scroll. */
    const { input } = mount();
    type(input, "BTC");
    expect(() => key(input, "ArrowDown")).not.toThrow();
  });

  it("commits a click on a row without the blur restoring first", () => {
    const { input, picker, commit } = mount();
    type(input, "XRP");
    const row = picker.el.querySelector(".sym-opt") as HTMLElement;
    row.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    expect(commit).toHaveBeenCalledWith("XRPUSDT");
    expect(input.value).toBe("XRPUSDT");
  });

  it("marks itself up as a combobox for screen readers", () => {
    const { input } = mount();
    expect(input.getAttribute("role")).toBe("combobox");
    input.dispatchEvent(new Event("focus"));
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("destroy detaches every listener", () => {
    const { input, picker, commit } = mount();
    picker.destroy();
    type(input, "ETH");
    key(input, "Enter");
    expect(commit).not.toHaveBeenCalled();
  });
});
