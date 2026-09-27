/**
 * The shortcut sheet.
 *
 * Generated from the keymap, never written by hand. A hand-maintained cheat
 * sheet is wrong within two releases, and a cheat sheet you cannot trust is
 * worse than none — you check it, it lies, and you stop opening it.
 *
 * Grouped by the command's own group, so the sheet reorganises itself for free
 * when a command moves.
 */

import { h } from "./dom";
import { openOverlay, type OverlayHandle } from "./overlay";
import { formatSequence } from "../core/keys";
import type { Keymap } from "../core/keys";
import type { CommandRegistry } from "../core/commands";

export function openShortcutSheet(keymap: Keymap, commands: CommandRegistry): OverlayHandle {
  /* Bindings whose id names no command are still shown — they are real keys
     that really do something, and hiding them would make the sheet a lie by
     omission. They land under "Other". */
  const groups = new Map<string, { label: string; keys: string }[]>();

  for (const binding of keymap.list()) {
    const cmd = commands.get(binding.id);
    const group = cmd?.group ?? "Other";
    const label = cmd?.title ?? binding.id;
    const row = { label, keys: formatSequence(binding.chords, keymap.platform) };
    const list = groups.get(group);
    if (list) list.push(row);
    else groups.set(group, [row]);
  }

  const panel = h(
    "div",
    { class: "keys" },
    h("h2", { class: "keys-title", text: "Keyboard" }),
    h(
      "div",
      { class: "keys-grid" },
      ...Array.from(groups, ([name, rows]) =>
        h(
          "section",
          {},
          h("div", { class: "keys-group-name", text: name }),
          ...rows.map((r) =>
            h(
              "div",
              { class: "keys-row" },
              h("span", { class: "keys-label", text: r.label }),
              h("span", { class: "keys-kbd", text: r.keys }),
            ),
          ),
        ),
      ),
    ),
    h("div", {
      class: "field-hint",
      style: "margin-top:16px",
      text:
        "Single letters are inert while the cursor is in a text field. Sequences like G then C are typed one key after the other, not held together.",
    }),
  );

  return openOverlay(panel, {
    placement: "center",
    className: "overlay-palette",
    scrim: true,
  });
}
