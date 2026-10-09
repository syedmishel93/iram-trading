/**
 * EVERY STORED SLOT, IN ONE PLACE.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Thirty-four things persist to key-value storage. The Settings dialog was
 * handed a list built by hand in `ui/shell.ts`, so five preferences existed,
 * worked, persisted and could not be found anywhere — including `risk.config`,
 * the governor's own limits: daily loss, max trades, losses in a row. As close
 * to a setting as anything in this product, editable only on the Risk desk.
 *
 * Nothing in the terminal answered "what is this configured to do?", and the
 * reason was not a short settings screen. It was that configuration had no
 * owner: a slot is declared beside the data it owns, which is right, and
 * nothing enumerated them, which is the whole defect.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * FOUR KINDS, AND THE SPLIT IS THE DESIGN
 *
 * Adding the five missing ones to the settings list would have been the wrong
 * fix, because the thirty-four are not one population:
 *
 *   preference (10)  a choice that changes behaviour      -> a Settings control
 *   secret      (1)  a credential         -> never rendered, never exported
 *   state      (21)  data the product accumulated  -> seen, sized, exported,
 *                                                     cleared; NOT a control
 *   legacy      (2)  migration leftovers   -> deleted once the path is dead
 *
 * Putting the alert book in Settings as a control is a category error. Twenty
 * one of the thirty-four are not settings at all, and what they need is a
 * holdings view — which exists today for bars and for nothing in this store.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE CENTRAL LIST, NOT `register()` CALLS IN EACH MODULE
 *
 * Distributed registration reads tidier and has a failure already on record
 * here: a module nobody imports never registers, so the capability exists and
 * cannot be seen. A central list can be CHECKED AGAINST THE SOURCE, and
 * `app/test/slotregistry.test.ts` does exactly that — every `*_SLOT` in the
 * tree must appear here, every entry here must still exist, and no key may
 * move. A key is the operator's data; change one and the stored value is
 * orphaned with nothing on screen to say why.
 *
 * `settings/` already imports `ui/appearance`, so it sits above the UI layer
 * and may name a slot from any layer without inverting the layering rule.
 */

import type { Slot } from "../store/kv";
import type { KV } from "../store/kv";
import type { SettingControl, SettingDef } from "./schema";
import { SECTIONS } from "./defs";

/* ------------------------------------------------------------ the slots -- */

import { ACCOUNT_SLOT } from "../core/account";
import { ALERT_BOOK_SLOT } from "../alert/store";
import { DISCOVERED_SLOT } from "../backtest/discovered";
import { SWEEP_SLOT } from "../backtest/sweepcache";
import { CATALOGUE_SLOT } from "../data/catalogue";
import { FUNDAMENTALS_SLOT } from "../data/fundamentals";
import { BUDGET_SLOT } from "../data/library";
import { DRAWINGS_SLOT } from "../draw/store";
import { SAYS_SLOT } from "../journal/says";
import { KNOWLEDGE_SLOT } from "../learn/knowledge";
import { CLAIMS_SLOT, ENABLED_SLOT, RUNS_SLOT } from "../learn/store";
import { SCRIPTS_SLOT } from "../script/store";
import { STUDIES_SLOT, TIMINGS_SLOT } from "../study/store";
import { APPEARANCE_SLOT } from "../ui/appearance";
import { TOPUP_SLOT } from "../ui/data";
import { BOOK_SLOT, CONFIG_SLOT, DAY_SLOT } from "../ui/risk";
import { AUTO_SEARCH_SLOT, PREFS_SLOT, RULES_SLOT } from "../ui/shell/prefs";
import { FLOW_SLOT } from "../ui/strategy/draft";
import { TODAY_PLAN_SLOT } from "../ui/today/focus";

/* ------------------------------------------------------------- the shape -- */

export type SlotKind = "preference" | "secret" | "state" | "legacy";

/** Derived, never restated: a section that does not exist is a compile error. */
export type SectionId = (typeof SECTIONS)[number]["id"];

export interface SlotEntry {
  /**
   * The storage key. REQUIRED, and the thing everything else is keyed on.
   *
   * SIX SLOTS ARE DECLARED INSIDE FUNCTIONS — `AGENT_KEY`, `BRIEFS`, `WATCH`,
   * `LAYOUT`, `EXIT`, `RECENT` — so there is no module-level binding to
   * import, and a registry that demanded the Slot object could not name them
   * at all. The guard needs only the key; the holdings view reads, sizes and
   * clears by key through the raw store. Lifting those six to module scope is
   * a refactor with its own risk and is not this change.
   */
  readonly key: string;
  /** Present only where the module exports one. Settings reads through it. */
  readonly slot?: Slot<never>;
  readonly kind: SlotKind;
  /** What to call it on screen. */
  readonly label: string;
  /** One line in the operator's words — never the field name restated. */
  readonly what: string;
  /** Preference only. */
  readonly section?: SectionId;
  /**
   * Preference only.
   *
   * `SettingControl` is the repository's own type, not a parallel one. Two of
   * the ten take `action`: the governor's limits and the twenty-nine detector
   * switches are edited through surfaces that already do the job properly, and
   * a generic widget would be a worse version of a working desk. The entry
   * still exists, so Settings ACCOUNTS for them and can send you there.
   */
  readonly control?: SettingControl;
}

/** A slot's own generic is irrelevant to the registry; only its key is read. */
const anySlot = (s: unknown): Slot<never> => s as Slot<never>;

/* ---------------------------------------------------------- the registry -- */

export const REGISTRY: readonly SlotEntry[] = [
  /* ---- preference: a choice that changes what the terminal does ---- */
  {
    key: ACCOUNT_SLOT.key,
    slot: anySlot(ACCOUNT_SLOT),
    kind: "preference",
    label: "Account and risk",
    what: "Your balance, leverage and how much of it one trade may risk.",
    section: "account",
    control: { kind: "action", button: "Open" },
  },
  {
    key: CONFIG_SLOT.key,
    slot: anySlot(CONFIG_SLOT),
    kind: "preference",
    label: "Trading limits",
    what: "Daily loss limit, trades per day, losses in a row before it stops you.",
    section: "account",
    control: { kind: "action", button: "Open the Risk desk" },
  },
  {
    key: RULES_SLOT.key,
    slot: anySlot(RULES_SLOT),
    kind: "preference",
    label: "Pre-trade checks",
    what: "Which checks have to pass before a setup is called tradable.",
    section: "rules",
    control: { kind: "action", button: "Edit the checks" },
  },
  {
    /* Declared inside a function; no binding to import. Key only. */
        key: "setup.exitRules",
    kind: "preference",
    label: "Exits",
    what: "Where the stop and the targets go when a plan is built for you.",
    section: "exits",
    control: { kind: "action", button: "Edit the exits" },
  },
  {
    key: ENABLED_SLOT.key,
    slot: anySlot(ENABLED_SLOT),
    kind: "preference",
    label: "Detectors",
    what: "Which structure detectors run on the chart and feed the scan.",
    section: "indicators",
    control: { kind: "action", button: "Choose detectors" },
  },
  {
    key: APPEARANCE_SLOT.key,
    slot: anySlot(APPEARANCE_SLOT),
    kind: "preference",
    label: "Appearance",
    what: "Theme, density and the type scale the whole terminal is drawn at.",
    section: "appearance",
    control: { kind: "action", button: "Open" },
  },
  {
    key: PREFS_SLOT.key,
    slot: anySlot(PREFS_SLOT),
    kind: "preference",
    label: "Panels",
    what: "Whether the dock, the watch rail and the news strip are shown.",
    section: "appearance",
    control: { kind: "action", button: "Open" },
  },
  {
    key: AUTO_SEARCH_SLOT.key,
    slot: anySlot(AUTO_SEARCH_SLOT),
    kind: "preference",
    label: "Search a new market unasked",
    what: "Sweep a market you have not searched before, the first time you open it.",
    section: "rules",
    control: { kind: "toggle" },
  },
  {
    key: BUDGET_SLOT.key,
    slot: anySlot(BUDGET_SLOT),
    kind: "preference",
    label: "Disk budget",
    what: "How many gigabytes of price history this machine may keep.",
    section: "data",
    control: { kind: "number", min: 1, max: 200, step: 1, unit: "GB" },
  },
  {
    key: TOPUP_SLOT.key,
    slot: anySlot(TOPUP_SLOT),
    kind: "preference",
    label: "Keep history topped up",
    what: "Fetch new bars for enrolled markets while the terminal is open.",
    section: "data",
    control: { kind: "toggle" },
  },

  /* ---- secret ---- */
  {
    /* Declared inside a function; no binding to import. Key only. */
        key: "agent.credential",
    kind: "secret",
    label: "Analyst credential",
    what: "An API key for the analyst. Never shown and never included in an export.",
  },

  /* ---- state: what the product has accumulated ---- */
  {
    key: ALERT_BOOK_SLOT.key,
    slot: anySlot(ALERT_BOOK_SLOT),
    kind: "state",
    label: "Alerts",
    what: "The price alerts you have set, and which have already fired.",
  },
  {
    key: BOOK_SLOT.key,
    slot: anySlot(BOOK_SLOT),
    kind: "state",
    label: "Position book",
    what: "Positions you entered by hand, for sizing when the broker is not connected.",
  },
  {
    key: DAY_SLOT.key,
    slot: anySlot(DAY_SLOT),
    kind: "state",
    label: "Today's counters",
    what: "Trades taken and R lost today, measured against your limits.",
  },
  {
    /* Declared inside a function; no binding to import. Key only. */
        key: "agent.briefs",
    kind: "state",
    label: "Saved briefs",
    what: "Analyst write-ups you kept, with the chart they were written about.",
  },
  {
    key: CATALOGUE_SLOT.key,
    slot: anySlot(CATALOGUE_SLOT),
    kind: "state",
    label: "Instrument catalogue",
    what: "The cached list of markets your broker and venues offer.",
  },
  {
    key: CLAIMS_SLOT.key,
    slot: anySlot(CLAIMS_SLOT),
    kind: "state",
    label: "Claims ledger",
    what: "Every call the terminal made, and how each one actually turned out.",
  },
  {
    key: RUNS_SLOT.key,
    slot: anySlot(RUNS_SLOT),
    kind: "state",
    label: "Model runs",
    what: "Each time a model was fitted, and what it scored out of sample.",
  },
  {
    key: KNOWLEDGE_SLOT.key,
    slot: anySlot(KNOWLEDGE_SLOT),
    kind: "state",
    label: "Edge library",
    what: "What replaying history measured, sliced by the conditions it met.",
  },
  {
    key: DISCOVERED_SLOT.key,
    slot: anySlot(DISCOVERED_SLOT),
    kind: "state",
    label: "Discovered rules",
    what: "Rule sets the autonomous search found, with what each was charged.",
  },
  {
    key: SWEEP_SLOT.key,
    slot: anySlot(SWEEP_SLOT),
    kind: "state",
    label: "Search cache",
    what: "Finished searches, so reopening a market does not re-run them.",
  },
  {
    key: DRAWINGS_SLOT.key,
    slot: anySlot(DRAWINGS_SLOT),
    kind: "state",
    label: "Drawings",
    what: "Lines, levels and shapes you have drawn on charts.",
  },
  {
    key: FLOW_SLOT.key,
    slot: anySlot(FLOW_SLOT),
    kind: "state",
    label: "Strategy draft",
    what: "A rule set you were part way through building.",
  },
  {
    key: FUNDAMENTALS_SLOT.key,
    slot: anySlot(FUNDAMENTALS_SLOT),
    kind: "state",
    label: "Fundamentals cache",
    what: "Recently fetched fundamentals, kept so the panel opens instantly.",
  },
  {
    /* Declared inside a function; no binding to import. Key only. */
        key: "workspace.layout",
    kind: "state",
    label: "Saved layouts",
    what: "Your pane arrangements and which symbols are linked together.",
  },
  {
    /* Declared inside a function; no binding to import. Key only. */
        key: "commands.recent",
    kind: "state",
    label: "Recent symbols",
    what: "What you have looked at lately, for the command palette.",
  },
  {
    key: SAYS_SLOT.key,
    slot: anySlot(SAYS_SLOT),
    kind: "state",
    label: "Journal notes",
    what: "What you wrote about a trade at the time you took it.",
  },
  {
    key: SCRIPTS_SLOT.key,
    slot: anySlot(SCRIPTS_SLOT),
    kind: "state",
    label: "Your scripts",
    what: "Indicators you wrote yourself, and their saved settings.",
  },
  {
    key: STUDIES_SLOT.key,
    slot: anySlot(STUDIES_SLOT),
    kind: "state",
    label: "Studies",
    what: "Research questions you set up, with their drivers and windows.",
  },
  {
    key: TIMINGS_SLOT.key,
    slot: anySlot(TIMINGS_SLOT),
    kind: "state",
    label: "Study timings",
    what: "How long each study took, so the next one can estimate itself.",
  },
  {
    key: TODAY_PLAN_SLOT.key,
    slot: anySlot(TODAY_PLAN_SLOT),
    kind: "state",
    label: "Today's plan",
    what: "The setup you wrote down to take today, before the market moved.",
  },
  {
    /* Declared inside a function; no binding to import. Key only. */
        key: "screener.watch",
    kind: "state",
    label: "Watchlist",
    what: "The markets you are keeping an eye on, and how they are sorted.",
  },

  /* ---- the six the name-based guard could not see ----
     Its pattern was `const <NAME>_SLOT`, which is a NAMING CONVENTION and
     not the thing itself; these are declared as a plain `SLOT` or through
     `listSlot`. One of them holds what the operator wrote about their own
     trades, and it was invisible to the list whose job is to enumerate. */
  {
    key: "journal.entries",
    kind: "state",
    label: "Journal",
    what: "Every trade you recorded, with the plan you wrote before taking it.",
  },
  {
    key: "review.rules",
    kind: "state",
    label: "Review rules",
    what: "Rules you committed to after reviewing your own trades.",
  },
  {
    key: "watchlist.v1",
    kind: "state",
    label: "Watchlist contents",
    what: "The markets on your list. Separate from how that list is sorted.",
  },
  {
    key: "playbook.v1",
    kind: "state",
    label: "Playbook",
    what: "Rule sets you wrote or edited by hand, as opposed to ones found by a search.",
  },
  {
    key: "paper.v1",
    kind: "state",
    label: "Paper trades",
    what: "Practice fills taken against the live feed, and their results.",
  },
  {
    /* READ BY THE ACCOUNT MIGRATION TOO, which believes it is a pre-v40
       shape and is in fact this desk's current saved inputs. Recorded in
       the guard's TWO_DECLARATIONS with the full reasoning. */
    key: "calculator.v1",
    kind: "state",
    label: "Calculator inputs",
    what: "What the calculator was last set to, so it opens where you left it.",
  },
];

export function entriesOfKind(kind: SlotKind): readonly SlotEntry[] {
  return REGISTRY.filter((e) => e.kind === kind);
}

/* ----------------------------------------------------- settings, derived -- */

/**
 * A `SettingDef` for every preference, built FROM THE REGISTRY.
 *
 * The defect this replaces: `buildSettings` was handed a list assembled by
 * hand, so a preference reached Settings only if somebody remembered to add
 * it. Five never were. Iterating the registry means the next one cannot be
 * forgotten — it is in Settings the moment it is registered, or the guard
 * fails because it was not registered at all.
 *
 * TWO CONTROLS ARE AN `action`, AND THAT IS NOT A SHORTCUT. The governor's
 * limits and the twenty-nine detector switches are edited through surfaces
 * that already do the job well; a generic widget would be a worse version of a
 * working desk. The entry still exists, so Settings ACCOUNTS for the
 * preference and can point at where it lives. Only what genuinely is one value
 * — a toggle, a number — gets a control that reads and writes here.
 */
export function registrySettings(kv: KV): readonly SettingDef[] {
  const out: SettingDef[] = [];

  for (const e of entriesOfKind("preference")) {
    const control = e.control;
    const section = e.section;
    if (control === undefined || section === undefined) continue;

    /* A refused write is REMEMBERED and reported through `unavailable`.
       `kv.write` returns a result rather than throwing, so the easy bug is to
       ignore it: the control moves, nothing is stored, and the next reload
       puts it back with no explanation. */
    let refused: string | null = null;

    const base = { id: `${section}.${e.key}`, section, label: e.label, hint: e.what, control };

    if (control.kind === "action" || e.slot === undefined) {
      out.push({ ...base, read: () => e.what, unavailable: () => refused });
      continue;
    }

    const slot = e.slot;
    out.push({
      ...base,
      read: () => String(kv.read(slot).value),
      write: (v: string) => {
        const next =
          control.kind === "toggle" ? v === "true" : control.kind === "number" ? Number(v) : v;
        const res = kv.write(slot, next as never);
        refused = res.ok
          ? null
          : res.reason === "quota"
            ? "This machine is out of room for settings. Clear something on the System desk and try again."
            : res.reason === "newer-on-disk"
              ? "A newer version of this setting is already stored — reload before changing it."
              : "This setting could not be stored on this machine.";
      },
      unavailable: () => refused,
    });
  }

  return out;
}
