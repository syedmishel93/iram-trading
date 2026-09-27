/**
 * Settings, as data.
 *
 * WHY A SCHEMA AND NOT A SCREEN
 * The terminal's preferences were scattered across six surfaces — an appearance
 * popover, the Data desk, the Analyst header, `Tools ▸ Alerts`, the Risk desk
 * and the Calculator — and two of them disagreed about how much money you have.
 * Rebuilding that as one hand-written screen would fix the address and keep the
 * real problem: a setting would still be a control someone remembered to place,
 * and nothing could enumerate them.
 *
 * So a setting is a VALUE with a description of itself. From that one list the
 * surface renders itself, search works without a separate index, and "where is
 * that option" has one answer for every option.
 *
 * WHAT A SETTING IS NOT
 * It is not a store. Every definition reads and writes state that already
 * exists — the account store, the shell's preference signals, the alert
 * toggles — so opening this screen cannot introduce a second copy of anything.
 * That is the whole lesson of the equity defect: one fact, one owner.
 */

export type SettingControl =
  | { readonly kind: "number"; readonly min?: number; readonly max?: number; readonly step?: number; readonly unit?: string }
  | { readonly kind: "text"; readonly placeholder?: string }
  | { readonly kind: "toggle" }
  /**
   * A colour, edited with the platform's own picker.
   *
   * Its own kind rather than a `text` field holding "#2DBE8E": a hex string is
   * a thing you get wrong silently, and the one question a colour setting has to
   * answer — "what does it look like" — a text box cannot. `swatchOnly` drops
   * the hex field for settings where the exact value is never worth typing.
   */
  | { readonly kind: "colour"; readonly swatchOnly?: boolean }
  | { readonly kind: "select"; readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }> }
  /** A statement, not a control. Used for the safety contract and diagnostics. */
  | { readonly kind: "note"; readonly tone?: "info" | "warn" | "good" }
  | { readonly kind: "action"; readonly button: string }
  /**
   * A miniature of the terminal, drawn from the role tokens themselves.
   *
   * Its own kind rather than a `note`, because it is the one control here
   * that answers a question no sentence can: what the settings above it
   * actually LOOK like. It holds no state and takes no input — every pixel of
   * it is `var(--…)`, so it restyles with the real chrome instead of being a
   * picture that has to be kept in step with one. `read()` is its description
   * for anyone who cannot see it.
   */
  | { readonly kind: "preview" };

export interface SettingDef {
  /** `section.name`, and the id the palette will address it by. */
  readonly id: string;
  readonly section: string;
  readonly label: string;
  /** One sentence. What it does, and anything it is honest about not doing. */
  readonly hint?: string;
  readonly control: SettingControl;
  /** Current value as a string; `note` and `action` return their text. */
  read(): string;
  /** Commit. Never called for `note`. */
  write?(value: string): void;
  /** Extra words search should match — synonyms, the old location, the jargon. */
  readonly keywords?: readonly string[];
  /** Greyed with a reason rather than hidden, so it can still be found. */
  unavailable?(): string | null;
}

export interface SectionDef {
  readonly id: string;
  readonly label: string;
  /** Nav heading. Sections with the same group are listed together. */
  readonly group: string;
  /** One line under the section title. */
  readonly blurb?: string;
}

// ---------------------------------------------------------------- search ---

export interface SearchHit {
  readonly setting: SettingDef;
  readonly score: number;
}

/**
 * Rank settings against a query.
 *
 * Deliberately not the fuzzy matcher used for symbols and commands. A settings
 * search is looking for a NAME you half-remember — "density", "quiet", "risk" —
 * and subsequence matching turns that into noise: "risk" would match "Ask the
 * analyst before it runs" through five scattered letters. Whole-word and prefix
 * matching over the label, the hint and the keywords is what makes the results
 * defensible.
 *
 * The keyword list is what carries someone who knows the OLD name for a thing,
 * which is most people for the first month after a move.
 */
export function searchSettings(
  settings: readonly SettingDef[],
  sections: readonly SectionDef[],
  query: string,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];

  const terms = q.split(/\s+/).filter((t) => t.length > 0);
  const sectionLabel = new Map(sections.map((s) => [s.id, s.label.toLowerCase()]));

  const hits: SearchHit[] = [];
  for (const setting of settings) {
    const label = setting.label.toLowerCase();
    const hint = (setting.hint ?? "").toLowerCase();
    const keys = (setting.keywords ?? []).map((k) => k.toLowerCase());
    const section = sectionLabel.get(setting.section) ?? "";

    let score = 0;
    let matchedAll = true;

    for (const term of terms) {
      let best = 0;
      if (label === term) best = 100;
      else if (label.startsWith(term)) best = 70;
      else if (wordStart(label, term)) best = 55;
      else if (keys.some((k) => k === term)) best = 50;
      else if (keys.some((k) => wordStart(k, term))) best = 40;
      else if (wordStart(section, term)) best = 25;
      else if (wordStart(hint, term)) best = 15;
      else if (hint.includes(term)) best = 8;

      if (best === 0) {
        matchedAll = false;
        break;
      }
      score += best;
    }

    if (matchedAll) hits.push({ setting, score });
  }

  /* Stable within equal scores: declaration order is the order of the screen,
     so an ambiguous query lists results the way the user will find them. */
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => (b.h.score - a.h.score) || (a.i - b.i))
    .map((w) => w.h);
}

/** True when `term` begins a word in `text` — never mid-word. */
function wordStart(text: string, term: string): boolean {
  if (text === "") return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return false;
    const before = at === 0 ? " " : (text[at - 1] as string);
    if (!/[a-z0-9]/.test(before)) return true;
    from = at + 1;
  }
}

/** Sections in nav order, with their settings attached. */
export function groupSections(
  sections: readonly SectionDef[],
  settings: readonly SettingDef[],
): Array<{ group: string; sections: Array<{ section: SectionDef; settings: SettingDef[] }> }> {
  const bySection = new Map<string, SettingDef[]>();
  for (const s of settings) {
    const list = bySection.get(s.section);
    if (list) list.push(s);
    else bySection.set(s.section, [s]);
  }

  const out: Array<{ group: string; sections: Array<{ section: SectionDef; settings: SettingDef[] }> }> = [];
  for (const section of sections) {
    let bucket = out.find((g) => g.group === section.group);
    if (!bucket) {
      bucket = { group: section.group, sections: [] };
      out.push(bucket);
    }
    bucket.sections.push({ section, settings: bySection.get(section.id) ?? [] });
  }
  return out;
}

/** Every setting that names a section which does not exist. Guards typos. */
export function orphanSettings(
  sections: readonly SectionDef[],
  settings: readonly SettingDef[],
): SettingDef[] {
  const known = new Set(sections.map((s) => s.id));
  return settings.filter((s) => !known.has(s.section));
}
