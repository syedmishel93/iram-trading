/**
 * The keyboard.
 *
 * v40 handled shortcuts with a `switch` on `e.key` inside one listener in
 * shell.ts. That works for four keys and fails for forty: there is no way to
 * ask what is bound, no way to show it to the user, no way for a desk to add a
 * binding while it is mounted and remove it when it is not, and no way to stop
 * two features quietly claiming the same key. Every one of those is a
 * requirement the moment the terminal has a command palette.
 *
 * So: one registry, one listener, and the binding table is DATA — which is what
 * lets the help overlay, the command palette and the menus all render the same
 * shortcuts without any of them hard-coding a string.
 *
 * THREE THINGS THIS GETS RIGHT THAT AD-HOC HANDLERS DO NOT
 *
 * 1. Typing is not a shortcut. While focus is in a text field, a bare "f" is
 *    the letter f. Bindings must opt in with `allowInInput`, and only Escape
 *    and the palette's own opener do.
 *
 * 2. Sequences. "g c" (go to chart) is two keystrokes, not a chord, and holding
 *    a prefix open needs a timeout or the terminal silently eats the next key
 *    forever. The pending prefix is exposed so the status bar can show it —
 *    a mode you cannot see is a mode you are stuck in.
 *
 * 3. Mod is not Ctrl. On macOS the palette is ⌘K and on Windows it is Ctrl+K,
 *    and writing both everywhere is how one of them rots. Bindings say "Mod"
 *    and this file resolves it once, from the actual platform.
 */

export interface Chord {
  /** Normalised: lowercase for letters, the literal name otherwise ("escape"). */
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

export type Platform = "mac" | "other";

/**
 * The running platform, detected once.
 *
 * `navigator.platform` is deprecated but is the only thing that reliably
 * separates macOS from everything else in every engine this ships on;
 * `userAgentData` is Chromium-only and absent in the test environment. The
 * detection is isolated here so exactly one place is wrong if it ever breaks.
 */
export function detectPlatform(nav?: { platform?: string; userAgent?: string }): Platform {
  const src = nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (!src) return "other";
  const hay = `${src.platform ?? ""} ${src.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(hay) ? "mac" : "other";
}

/** Aliases accepted in binding strings, mapped to the normalised key name. */
const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  del: "delete",
  ins: "insert",
  return: "enter",
  space: " ",
  spacebar: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  pgup: "pageup",
  pgdn: "pagedown",
  plus: "+",
  minus: "-",
};

/**
 * Parse one chord: "Mod+Shift+K", "Alt+1", "?", "Escape".
 *
 * Returns null on anything unparseable rather than throwing. A bad binding
 * string should cost that one shortcut, not the whole keymap and with it every
 * other shortcut in the app.
 */
export function parseChord(input: string, platform: Platform = detectPlatform()): Chord | null {
  const raw = input.trim();
  if (raw.length === 0) return null;

  /* Split on "+" but keep a literal "+" as a key: "Mod++" is Mod plus the plus
     key, and a naive split turns that into an empty final part. */
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === "+" && buf.length > 0) {
      parts.push(buf);
      buf = "";
    } else if (ch === "+" && buf.length === 0 && i === raw.length - 1) {
      buf = "+";
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push(buf);
  if (parts.length === 0) return null;

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;

  const last = (parts[parts.length - 1] as string).toLowerCase();

  for (let i = 0; i < parts.length - 1; i++) {
    switch ((parts[i] as string).toLowerCase()) {
      case "mod":
        if (platform === "mac") meta = true;
        else ctrl = true;
        break;
      case "ctrl":
      case "control":
        ctrl = true;
        break;
      case "alt":
      case "option":
        alt = true;
        break;
      case "shift":
        shift = true;
        break;
      case "meta":
      case "cmd":
      case "command":
        meta = true;
        break;
      default:
        return null; /* an unknown modifier is a typo, not a key */
    }
  }

  const key = KEY_ALIASES[last] ?? last;
  if (key.length === 0) return null;
  return { key, ctrl, alt, shift, meta };
}

/** Parse a whole binding: chords separated by spaces form a sequence. */
export function parseSequence(input: string, platform: Platform = detectPlatform()): Chord[] | null {
  /* Split on spaces, but " " (the space key) is written as "Space" and has
     already been aliased, so a bare space here is only ever a separator. */
  const chunks = input.trim().split(/\s+/).filter((s) => s.length > 0);
  if (chunks.length === 0) return null;
  const out: Chord[] = [];
  for (const chunk of chunks) {
    const chord = parseChord(chunk, platform);
    if (!chord) return null;
    out.push(chord);
  }
  return out;
}

/** The chord a keyboard event represents. */
export function chordFromEvent(e: KeyboardEvent): Chord {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  return { key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

/**
 * Does an event chord satisfy a bound chord?
 *
 * Shift is asymmetric on purpose. A binding for "?" must fire when the user
 * presses Shift+/ — which is the only way to type "?" on most layouts — so a
 * shift-produced symbol must not be rejected for carrying a shift it needed.
 * A binding that explicitly says Shift still requires it.
 */
export function chordMatches(bound: Chord, event: Chord): boolean {
  if (bound.key !== event.key) return false;
  if (bound.ctrl !== event.ctrl) return false;
  if (bound.alt !== event.alt) return false;
  if (bound.meta !== event.meta) return false;
  if (bound.shift) return event.shift;
  /* Single non-alphanumeric characters may require Shift to produce at all. */
  const producedByShift = bound.key.length === 1 && !/[a-z0-9]/.test(bound.key);
  return producedByShift ? true : !event.shift;
}

const MAC_SYMBOLS: Record<string, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
};

const KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  enter: "↵",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
  backspace: "⌫",
  delete: "Del",
  pageup: "PgUp",
  pagedown: "PgDn",
  tab: "Tab",
};

/** Render a chord the way the platform writes it. Used by menus, help, palette. */
export function formatChord(chord: Chord, platform: Platform = detectPlatform()): string {
  const label = KEY_LABELS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  if (platform === "mac") {
    /* macOS order is fixed by convention: ⌃⌥⇧⌘. Getting it wrong reads as
       amateur to anyone who has used a Mac app. */
    let out = "";
    if (chord.ctrl) out += MAC_SYMBOLS["ctrl"];
    if (chord.alt) out += MAC_SYMBOLS["alt"];
    if (chord.shift) out += MAC_SYMBOLS["shift"];
    if (chord.meta) out += MAC_SYMBOLS["meta"];
    return out + label;
  }
  const parts: string[] = [];
  if (chord.ctrl) parts.push("Ctrl");
  if (chord.alt) parts.push("Alt");
  if (chord.shift) parts.push("Shift");
  if (chord.meta) parts.push("Win");
  parts.push(label);
  return parts.join("+");
}

export function formatSequence(chords: readonly Chord[], platform: Platform = detectPlatform()): string {
  return chords.map((c) => formatChord(c, platform)).join(" ");
}

export interface Binding {
  /** The binding string as written, e.g. "Mod+K" or "g c". */
  readonly keys: string;
  readonly chords: readonly Chord[];
  /** What it does — the id of a command, or a free label for the help sheet. */
  readonly id: string;
  readonly run: (e: KeyboardEvent) => void;
  /** Fire even while focus is in a text field. Escape and the palette only. */
  readonly allowInInput: boolean;
  /** Gate: a binding whose `when` is false is invisible AND inert. */
  readonly when: (() => boolean) | undefined;
}

export interface BindOptions {
  allowInInput?: boolean;
  when?: () => boolean;
}

export interface Keymap {
  /** Register a binding. Returns a disposer, so a desk can unbind on unmount. */
  bind(keys: string, id: string, run: (e: KeyboardEvent) => void, opts?: BindOptions): () => void;
  /** Feed an event. Returns true if a binding consumed it. */
  handle(e: KeyboardEvent): boolean;
  /** Every registered binding, for the help sheet and the menus. */
  list(): readonly Binding[];
  /** The binding string for an id, if one exists — menus render this. */
  keysFor(id: string): string | null;
  /** Chords typed so far in an unfinished sequence, for the status bar. */
  pending(): readonly Chord[];
  /**
   * Notified whenever the pending prefix changes, including when it times out.
   *
   * A poll would not do: the prefix can clear on a TIMER with no user input to
   * hang a repaint off, and an indicator that stays lit after the sequence has
   * expired is worse than no indicator at all. Returns a disposer.
   */
  onPending(fn: (chords: readonly Chord[]) => void): () => void;
  /** Attach to a target. Returns a disposer. */
  attach(target: EventTarget): () => void;
  readonly platform: Platform;
}

/** How long a sequence prefix stays armed. Longer feels stuck; shorter races. */
const SEQUENCE_TIMEOUT_MS = 1400;

/** Keys that are modifiers themselves and can never complete a chord. */
const MODIFIER_KEYS = new Set(["control", "alt", "shift", "meta", "os", "altgraph"]);

function isEditable(el: EventTarget | null): boolean {
  if (!el || typeof (el as Element).tagName !== "string") return false;
  const node = el as HTMLElement;
  const tag = node.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    /* Checkboxes, radios and ranges do not swallow text, so a shortcut over one
       of those is still a shortcut. Only fields you can type into are guarded. */
    const type = (node as HTMLInputElement).type;
    return !(type === "checkbox" || type === "radio" || type === "range" || type === "button");
  }
  return node.isContentEditable === true;
}

export function createKeymap(platform: Platform = detectPlatform()): Keymap {
  const bindings: Binding[] = [];
  const pendingListeners = new Set<(chords: readonly Chord[]) => void>();
  let pendingChords: Chord[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const announcePending = (): void => {
    for (const fn of pendingListeners) fn(pendingChords.slice());
  };

  const clearPending = (): void => {
    const had = pendingChords.length > 0;
    pendingChords = [];
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (had) announcePending();
  };

  const armPending = (): void => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(clearPending, SEQUENCE_TIMEOUT_MS);
  };

  const keymap: Keymap = {
    platform,

    bind(keys, id, run, opts = {}) {
      const chords = parseSequence(keys, platform);
      if (!chords) {
        /* Loud, but not fatal. A typo in one binding string must not take the
           keyboard down with it. */
        console.warn(`[iram] unparseable key binding "${keys}" for ${id} — ignored`);
        return () => {};
      }

      /**
       * Conflict detection, out loud.
       *
       * Two features silently claiming Mod+K is a bug that presents as "the
       * palette sometimes does not open". Registration order still wins, so
       * behaviour is deterministic; the warning is how it gets fixed.
       */
      const clash = bindings.find(
        (b) =>
          b.chords.length === chords.length &&
          b.chords.every((c, i) => chordMatches(c, chords[i] as Chord)),
      );
      if (clash) {
        console.warn(`[iram] key "${keys}" is already bound to ${clash.id}; ${id} will not fire`);
      }

      const binding: Binding = {
        keys,
        chords,
        id,
        run,
        allowInInput: opts.allowInInput === true,
        when: opts.when,
      };
      bindings.push(binding);
      return () => {
        const i = bindings.indexOf(binding);
        if (i >= 0) bindings.splice(i, 1);
      };
    },

    handle(e) {
      if (MODIFIER_KEYS.has(e.key.toLowerCase())) return false;

      const chord = chordFromEvent(e);
      const editable = isEditable(e.target);
      const candidate = [...pendingChords, chord];

      /**
       * A sequence in progress is abandoned the moment focus is in a field:
       * otherwise "g" then a click into the symbol box then "c" fires a
       * navigation the user did not ask for.
       */
      if (editable && pendingChords.length > 0) clearPending();

      let prefixExists = false;

      for (const b of bindings) {
        if (editable && !b.allowInInput) continue;
        if (b.when && !b.when()) continue;
        if (b.chords.length < candidate.length) continue;

        let ok = true;
        for (let i = 0; i < candidate.length; i++) {
          if (!chordMatches(b.chords[i] as Chord, candidate[i] as Chord)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;

        if (b.chords.length === candidate.length) {
          clearPending();
          e.preventDefault();
          b.run(e);
          return true;
        }
        prefixExists = true;
      }

      if (prefixExists) {
        pendingChords = candidate;
        armPending();
        announcePending();
        /* A prefix key must not also type its letter into whatever is focused,
           and must not scroll the page if it was Space. */
        e.preventDefault();
        return true;
      }

      /* Not a prefix and not a match: any half-typed sequence is dead. */
      if (pendingChords.length > 0) clearPending();
      return false;
    },

    list() {
      return bindings.slice();
    },

    keysFor(id) {
      const found = bindings.find((b) => b.id === id);
      return found ? found.keys : null;
    },

    pending() {
      return pendingChords.slice();
    },

    onPending(fn) {
      pendingListeners.add(fn);
      return () => pendingListeners.delete(fn);
    },

    attach(target) {
      const listener = (ev: Event): void => {
        keymap.handle(ev as KeyboardEvent);
      };
      target.addEventListener("keydown", listener);
      return () => target.removeEventListener("keydown", listener);
    },
  };

  return keymap;
}
