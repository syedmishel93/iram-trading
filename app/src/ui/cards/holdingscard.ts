/**
 * WHAT THIS TERMINAL HOLDS — the thirty stored things that are not settings.
 *
 * The Data desk answers this for BARS: how many series, how much disk, what it
 * costs to keep. Nothing answered it for the key-value store, where your
 * alerts, drawings, claims ledger, journal notes and discovered rules live. So
 * the only way to learn what was on this machine was to open developer tools.
 *
 * `hd-` as the prefix, checked with `scratchpad/classcollide.py` before a line
 * was written: this repository shipped a desk wearing another desk's styles for
 * two releases because `.sy-` was claimed by two sheets and the later one won.
 *
 * NO MOTION HERE. The rows change when a slot is written, which on a live
 * terminal is many times a minute; the house rule is that frequency decides
 * whether a thing animates, and this is the wrong end of it.
 */

import { h, clear } from "../dom";
import { downloadText } from "../download";
import { clearPlan, exportable, heldBytes, inventory, type Holding } from "../../settings/holdings";
import type { KV } from "../../store/kv";

export interface HoldingsCardDeps {
  readonly kv: KV;
  /**
   * Called after anything is cleared, with the keys that were emptied.
   *
   * A desk rendering from a slot that has just been emptied keeps showing data
   * that no longer exists — and worse, writes its stale copy back. Only four
   * modules subscribe to the store for their own key; the rest read once into
   * a signal at construction and write the whole signal back on any change, so
   * clearing the alert book and then touching one alert restored the book. The
   * clear was silently undone.
   *
   * The card cannot know who is reading what, so it reports what went and the
   * caller decides. In this product the caller RELOADS, which re-seeds every
   * store at once, and the confirmation says so before anything is deleted.
   *
   * Absent, the clear still happens and the card still re-renders; what is
   * lost is every OTHER surface's knowledge of it, which is why the production
   * caller passes one and a test can watch it.
   */
  readonly onCleared?: (keys: readonly string[]) => void;
  /** Injected so a test can watch a download without a navigator. */
  readonly save?: (name: string, text: string) => void;
}

export interface HoldingsCard {
  readonly el: HTMLElement;
  /**
   * Re-read the store.
   *
   * The card was built once and never refreshed, on a store its own notes
   * describe as written many times a minute — so every size, every "last
   * written" time and every `held` flag froze at first construction, and a
   * slot first written since read "Nothing stored yet." with no checkbox to
   * clear it. The System desk refreshed its seven other cards and could not
   * refresh this one, because it was handed a bare element.
   */
  refresh(): void;
}

const BYTES = ["B", "KB", "MB"];

/** Short, and never a bare number of bytes past a kilobyte. */
function size(n: number): string {
  if (n <= 0) return "—";
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTES.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${BYTES[i] as string}`;
}

function when(ms: number | null): string {
  if (ms === null) return "—";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

export function createHoldingsCard(deps: HoldingsCardDeps): HoldingsCard {
  const picked = new Set<string>();
  const body = h("div", { class: "hd-body" }) as HTMLElement;
  const foot = h("div", { class: "hd-foot" }) as HTMLElement;
  const el = h(
    "section",
    { class: "dd-panel hd-card" },
    h(
      "header",
      { class: "panel-head" },
      h("h2", { class: "panel-title", text: "Stored on this machine" }),
      h("span", { class: "hd-total" }),
    ),
    body,
    foot,
  ) as HTMLElement;

  const total = el.querySelector(".hd-total") as HTMLElement;

  /** Download one holding's raw envelope, exactly as stored. */
  function exportOne(holding: Holding): void {
    const env = deps.kv.rawEnvelope(holding.key);
    if (env === null) return;
    (deps.save ?? downloadText)(`${holding.key}.json`, JSON.stringify(env, null, 2));
  }

  function render(): void {
    const rows = inventory(deps.kv);
    /* A SELECTION OF SOMETHING THAT IS NO LONGER THERE IS STILL A SELECTION.
       `picked` survived every re-render, so a key emptied elsewhere — by
       another tab, by the owning desk, by a previous clear — stayed in it: the
       foot offered "Clear 1…" against a row that had no checkbox, and a
       selection with nothing clearable in it rendered "This empties . It
       cannot be undone." on the one destructive control in this view. */
    const clearable = new Set(rows.filter((r) => r.held).map((r) => r.key));
    for (const key of [...picked]) if (!clearable.has(key)) picked.delete(key);
    clear(body);
    clear(foot);
    total.textContent = `${rows.filter((r) => r.held).length} of ${rows.length} holding ${size(heldBytes(rows))}`;

    for (const r of rows) {
      const line = h(
        "div",
        {
          class: "hd-row",
          "data-slot": r.key,
          "data-held": String(r.held),
          "data-readable": r.readable === null ? "unknown" : String(r.readable),
        },
        /* Only something that is actually held can be picked for clearing —
           offering a checkbox that would empty nothing is a control that lies
           about what it does. */
        r.held
          ? (h("input", {
              class: "hd-pick",
              type: "checkbox",
              "data-pick": r.key,
              "aria-label": `Select ${r.label}`,
              /* `onclick`, NOT `onchange`. MEASURED: jsdom does not dispatch
                 `change` when `.click()` toggles a checkbox — a listener added
                 natively fired zero times, while a manual dispatch worked, so
                 the wiring was right and the interaction was untestable. A
                 test that has to synthesise `change` is testing the listener
                 rather than the thing a person does. `click` fires in both,
                 and the checked state is already toggled by the time it runs. */
              onclick: (e: Event) => {
                const on = (e.currentTarget as HTMLInputElement).checked;
                if (on) picked.add(r.key);
                else picked.delete(r.key);
                renderFoot(rows);
              },
            }) as HTMLElement)
          : (h("span", { class: "hd-pick-gap" }) as HTMLElement),
        h("span", { class: "hd-name", text: r.label }),
        h("span", { class: "hd-what", text: r.what }),
        h("span", { class: "hd-size num", text: size(r.bytes) }),
        h("span", { class: "hd-when num", text: when(r.touchedAt) }),
        /* NO EXPORT FOR SOMETHING THAT DID NOT READ — `exportable` owns that
           rule now, so it is arithmetic a test can check rather than a
           condition inside a DOM expression. */
        exportable(r)
          ? (h("button", {
              class: "ghost-btn tiny",
              type: "button",
              "data-act": "export",
              text: "Export",
              onclick: () => exportOne(r),
            }) as HTMLElement)
          : (h("span", { class: "hd-why", text: r.readable === false ? r.why : "" }) as HTMLElement),
      ) as HTMLElement;
      body.appendChild(line);
    }

    renderFoot(rows);
  }

  function renderFoot(rows: readonly Holding[]): void {
    clear(foot);
    if (picked.size === 0) {
      foot.appendChild(
        h("span", {
          class: "hd-hint",
          text: "Select something to clear it. Nothing here is a setting — settings live in Settings.",
        }),
      );
      return;
    }
    foot.appendChild(
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        "data-act": "clear",
        text: `Clear ${picked.size}…`,
        onclick: () => askToClear(rows),
      }),
    );
  }

  function askToClear(rows: readonly Holding[]): void {
    const plan = clearPlan([...picked]);
    clear(foot);
    /* NAMES, NOT A COUNT. "Clear 4 items" is how somebody destroys something
       they did not mean to; the same lesson this repository already recorded
       from a bulk delete that had to return the skipped rows rather than how
       many there were. */
    foot.appendChild(
      h("p", {
        class: "hd-confirm",
        "data-confirm": "1",
        /* THE RELOAD IS PART OF THE PROMISE, so it is part of the sentence.
           Without it the clear is undone the moment the owning desk saves
           anything, which is worse than refusing to clear at all. */
        text: `This empties ${plan.labels.join(", ")}. It cannot be undone, and the terminal reloads afterwards so no desk can write its own copy back.`,
      }),
    );
    if (plan.unknown.length > 0) {
      foot.appendChild(
        h("p", {
          class: "hd-refused",
          text: `Refused, because they are not clearable from here: ${plan.unknown.join(", ")}.`,
        }),
      );
    }
    foot.appendChild(
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        "data-act": "clear-confirm",
        text: "Clear them",
        onclick: () => {
          const gone: string[] = [];
          for (const key of picked) {
            if (clearPlan([key]).labels.length === 0) continue;
            deps.kv.remove(key);
            gone.push(key);
          }
          picked.clear();
          render();
          /* AFTER the re-render, so the card is correct even if the caller
             reloads — and only with what was really removed, because a
             refusal reported as a deletion is the shape of a bulk action
             that silently does less than it says. */
          if (gone.length > 0) deps.onCleared?.(gone);
        },
      }),
    );
    foot.appendChild(
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        "data-act": "clear-cancel",
        text: "Keep them",
        onclick: () => renderFoot(rows),
      }),
    );
  }

  render();
  return { el, refresh: render };
}
