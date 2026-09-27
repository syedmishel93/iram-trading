/**
 * SERVER SETTINGS — the few numbers the operator is allowed to change.
 *
 * `scratchpad/svcsweep.py` found two config keys the server READ and nothing
 * could write. The disk budget is the one that mattered: `svc/store.py`
 * `budget_bytes()` reads it, the whole eviction policy enforces it, and the
 * refusal the planner raises when a budget cannot be met without deleting recent
 * history advises **"raise the budget, or drop a market"** — advice nobody could
 * act on. `svc/store.py`'s own comment says "anything beyond this is a deliberate
 * choice", describing a choice that could not be made.
 *
 * `svc/settings.py` made it settable and then had no screen, which is the same
 * defect one layer up: a capability nobody can see is a capability nobody has.
 * This card is the last two of the twelve routes this session left unreachable.
 *
 * IT SITS BESIDE THE STORED-HISTORY CARD because the budget governs that store,
 * and a setting three desks from the thing it controls is a setting nobody
 * connects to its effect.
 *
 * CHOSEN AND MERELY DEFAULTED ARE DIFFERENT FACTS. "5 GB" because the operator
 * picked it and "5 GB" because nobody ever has are the same number and not the
 * same state, and only one of them means it was thought about. The server reports
 * `isDefault` and this says so.
 */

import { h } from "../dom";
import { signal } from "../../core/signal";
import { pkWhy } from "../panelkit";
import { svcUrl } from "../../data/backend";

interface Setting {
  readonly key: string;
  readonly value: string;
  readonly default: string;
  readonly isDefault: boolean;
  readonly what: string;
  readonly readBy: string;
}

/** Plain words for a key nobody should have to read as a key. */
const LABEL: Readonly<Record<string, string>> = {
  store_budget_gb: "Disk the history store may use",
  pair_scan_tg: "Telegram alert for newly listed tokens",
};

/** Which settings are a number and which are on/off. */
const IS_FLAG = new Set(["pair_scan_tg"]);

export function createServerSettingsCard(): { readonly el: HTMLElement; refresh(): void } {
  const rows = signal<readonly Setting[]>([]);
  const note = signal<string>("");
  const saving = signal<string>("");

  async function load(): Promise<void> {
    try {
      const res = await fetch(svcUrl("/svc/settings"));
      const body = (await res.json()) as { ok?: boolean; settings?: readonly Setting[]; why?: string };
      if (body.ok === false) {
        note.set(body.why ?? "the server would not list its settings");
        return;
      }
      rows.set(body.settings ?? []);
    } catch {
      // "Could not ask" is not "nothing there", and rendering an empty list for
      // an unreachable service is the most alarming possible way to say "fine".
      note.set("The terminal's own server is not answering, so its settings could not be read.");
    }
  }

  async function save(key: string, value: string | boolean): Promise<void> {
    saving.set(key);
    note.set("");
    try {
      const res = await fetch(svcUrl("/svc/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      const body = (await res.json()) as { ok?: boolean; why?: string };
      if (body.ok === false) {
        // The server's refusals are written for the operator — "half a gigabyte
        // is the smallest budget worth setting" — so they are shown verbatim.
        note.set(body.why ?? "that was refused and no reason came back");
      }
    } catch {
      note.set("That change could not be sent — the terminal's own server is not answering.");
    }
    saving.set("");
    await load();
  }

  const rowFor = (s: Setting): HTMLElement => {
    if (IS_FLAG.has(s.key)) {
      const on = s.value === "1";
      return h(
        "div",
        { class: "set-row" },
        h("span", { class: "set-name", text: LABEL[s.key] ?? s.key }),
        h("button", {
          class: "tool-btn",
          text: () => (saving() === s.key ? "Saving…" : on ? "On" : "Off"),
          onclick: () => void save(s.key, !on),
        }),
        h("p", { class: "set-what", text: s.what }),
      ) as HTMLElement;
    }

    const field = h("input", {
      class: "set-field field-input",
      type: "text",
      value: s.value,
      spellcheck: "false",
    }) as HTMLInputElement;

    return h(
      "div",
      { class: "set-row" },
      h("span", { class: "set-name", text: LABEL[s.key] ?? s.key }),
      h(
        "div",
        { class: "set-edit" },
        field,
        h("span", { class: "set-unit", text: "GB" }),
        h("button", {
          class: "tool-btn",
          text: () => (saving() === s.key ? "Saving…" : "Set"),
          onclick: () => void save(s.key, field.value),
        }),
      ),
      h("p", { class: "set-what", text: s.what }),
      h("p", {
        class: "set-state",
        text: s.isDefault
          ? `Still the default (${s.default}). Nobody has chosen this yet.`
          : `You set this. The default is ${s.default}.`,
      }),
    ) as HTMLElement;
  };

  /**
   * A REACTIVE SLOT, not a hand-painted list.
   *
   * The first version painted `listBox` only from `refresh()`, so saving a value
   * updated the server, updated the signal, and left the card showing the old
   * one: MEASURED, the budget moved 5 GB -> 40 GB and `/svc/store/inventory`
   * agreed, while the line underneath still read "Still the default (5). Nobody
   * has chosen this yet." Two paths to the DOM and only one of them ran.
   *
   * Rebuilding on change is right here: after a save the field SHOULD show what
   * the server stored, and there is no half-typed state worth preserving.
   */
  const listBox = (): HTMLElement =>
    h("div", { class: "set-list" }, ...rows().map(rowFor)) as HTMLElement;

  const el = h(
    "section",
    { class: "dd-panel set" },
    h("h3", { class: "pf-sub", text: "What this server is allowed to do" }),
    pkWhy(
      "Why so few",
      "Only settings with a reader are listed, and each names the code that reads it. Credentials are deliberately absent: the service's own token and the Telegram token have their own write-only paths, because a page that can change any setting is a page that can rewrite the key the server authenticates with.",
    ),
    listBox,
    () => (note() ? h("p", { class: "set-note", text: note() }) : h("span", { class: "set-gap" })),
    () =>
      rows().length === 0 && !note()
        ? h("p", { class: "set-note", text: "Reading the server's settings…" })
        : h("span", { class: "set-gap" }),
  ) as HTMLElement;

  const refresh = (): void => {
    void load();
  };
  refresh();

  return { el, refresh };
}
