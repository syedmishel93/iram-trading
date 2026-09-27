/**
 * NOTIFICATIONS THAT REACH YOU WITH THE TERMINAL CLOSED.
 *
 * `/svc/telegram` and `/svc/notify` have been built and working for releases
 * with zero callers. They are the only part of this product that can tell you
 * anything when the tab is shut — the alert loop, the signal loop and the
 * dead-man's-switch heartbeat all send through them — so until now every one of
 * those loops was firing into nothing.
 *
 * THE BROWSER NEVER HOLDS THE TOKEN.
 *
 * That is the route's own design and the reason this is a server call rather
 * than a fetch to Telegram from the tab: a token in browser storage is a token
 * in every backup of that profile, and this product already backs the profile
 * up. The field is a password input, the value is sent once, and nothing here
 * keeps it or logs it — after a successful save the box is cleared, because a
 * secret left on screen is a secret in the next screenshot.
 *
 * WHAT IT CANNOT TELL YOU
 *
 * Whether the credentials are still good. Telegram answers the SAVE, and that
 * answer is reported honestly — but a token revoked next week will fail
 * silently inside a background loop at 3am. So the card offers a test you can
 * press, and says plainly that a green tick means "it worked when you pressed
 * it" rather than "it will work tonight".
 */

import { h } from "../dom";
import { pkWhy } from "../panelkit";
import { signal } from "../../core/signal";
import { notify, setTelegram } from "../../data/governor";

export function notifyCard(): HTMLElement {
  const token = signal("");
  const chat = signal("");
  const note = signal("");
  const level = signal<"none" | "ok" | "bad">("none");
  const busy = signal(false);

  const save = (): void => {
    const t = token().trim();
    const c = chat().trim();
    if (!t || !c) {
      level.set("bad");
      note.set("Both the bot token and the chat id are needed — Telegram will not route a message without them.");
      return;
    }
    busy.set(true);
    note.set("Saving on the server and sending a confirmation…");
    level.set("none");
    void setTelegram(t, c).then((a) => {
      busy.set(false);
      if (a.kind === "offline") {
        level.set("bad");
        note.set(a.why);
        return;
      }
      if (a.value.ok) {
        level.set("ok");
        note.set("Saved, and Telegram accepted a message. Check your chat — if nothing arrived, the chat id is the usual culprit.");
        /* CLEARED ON SUCCESS. A secret left in a box is a secret in the next
           screenshot, and the server holds it now. */
        token.set("");
        chat.set("");
      } else {
        level.set("bad");
        note.set(
          "The server stored them, and Telegram refused the message. That is almost always a wrong token or a " +
            "chat the bot has never been spoken to — send your bot a message first, then try again.",
        );
      }
    });
  };

  const test = (): void => {
    busy.set(true);
    note.set("Sending a test through the server's stored credentials…");
    level.set("none");
    void notify("IRAM test — notifications are reaching you with the terminal closed.").then((a) => {
      busy.set(false);
      if (a.kind === "offline") {
        level.set("bad");
        note.set(a.why);
        return;
      }
      level.set(a.value.ok ? "ok" : "bad");
      note.set(
        a.value.ok
          ? "Sent. That means it worked just now — not that it will work tonight, which nothing here can promise."
          : "The server has no credentials stored, or Telegram refused them. Save a token and chat id below.",
      );
    });
  };

  const field = (
    label: string,
    hint: string,
    value: () => string,
    set: (v: string) => void,
    secret: boolean,
  ): HTMLElement =>
    h(
      "div",
      { class: "ntf-field" },
      h("label", { class: "field-label", text: label }),
      h("input", {
        class: "field-input",
        /* A PASSWORD INPUT, so the value is not in a screenshot or read over a
           shoulder. It travels once to this operator's own server and is never
           stored in the browser. */
        type: secret ? "password" : "text",
        autocomplete: "off",
        spellcheck: "false",
        value: () => value(),
        oninput: (e: Event) => set((e.target as HTMLInputElement).value),
      }),
      h("span", { class: "field-hint", text: hint }),
    ) as HTMLElement;

  return h(
    "section",
    { class: "dd-panel ntf" },
    h("h3", { class: "pf-sub", text: "Reaching you with the terminal closed" }),
    h("p", {
      class: "ntf-lede",
      text:
        "The alert loop, the signal loop and the dead-man's-switch heartbeat all send through here. " +
        "Until this is set up, every one of them fires into nothing.",
    }),

    h(
      "div",
      { class: "ntf-fields" },
      field("Bot token", "From @BotFather. Held on your server, never in the browser.", token, (v) => token.set(v), true),
      field("Chat id", "Message your bot once first, or it cannot reply to you.", chat, (v) => chat.set(v), false),
    ),

    h(
      "div",
      { class: "ntf-actions" },
      h("button", { class: "primary-btn", type: "button", text: "Save and confirm", disabled: () => busy(), onclick: save }),
      h("button", { class: "ghost-btn", type: "button", text: "Send a test", disabled: () => busy(), onclick: test }),
    ),

    h("p", { class: "ntf-note", "data-level": () => level(), text: () => note(), style: () => (note() ? "" : "display:none") }),

    pkWhy(
      "The token goes to your own server and is stored there, so the browser never holds it — a secret in browser " +
        "storage is a secret in every backup of that profile, and this product backs the profile up. The box is " +
        "cleared once it is saved. What this cannot tell you is whether the credentials are still good: a token " +
        "revoked next week will fail inside a background loop at three in the morning, so a successful test means " +
        "it worked when you pressed it and nothing more.",
      "Where the token goes, and what a test proves",
    ),
  ) as HTMLElement;
}
