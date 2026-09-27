/**
 * Whale watch: the wallets the on-chain service follows, and what they moved.
 *
 * The title is drawn by the dock's card head; this is the body.
 *
 * WHAT THE LIST IS, AND IS NOT
 * `wallet_events` holds EVERY token transfer of a watched wallet — the
 * minimum-dollar threshold only decides which ones reach Telegram. And an
 * event's amount is in TOKENS; the service stores no dollar value for it. So
 * the list is headed "Recent transfers" and the amounts carry their token
 * symbol, never a "$". Calling it "large transfers" would be a claim the data
 * cannot back.
 *
 * WHAT IT CANNOT VERIFY
 * The server accepts any wallet string of eight characters or more. A stored
 * wallet that is not 0x + 40 hex digits cannot be followed on any explorer,
 * and is shown with "not a valid address" rather than hidden. Every event
 * shows its age, so a row from last week reads as last week.
 *
 * The form is built once and kept, so a 60s poll never wipes a half-typed
 * address; only the two lists are redrawn.
 */

import { h, clear } from "../dom";
import { pkEmpty, pkNum, pkSection, pkWhy } from "../panelkit";
import {
  DEFAULT_MIN_USD,
  ONCHAIN_CHAINS,
  ageText,
  isAddress,
  loadOnchain,
  shortAddr,
  unwatchWallet,
  watchWallet,
  type OnchainChain,
  type OnchainResult,
  type WalletEvent,
  type WatchedWallet,
} from "../../data/onchain";
import { isShown, onShown } from "./shown";

export const WHALE_POLL_MS = 60_000;
const MAX_EVENTS = 8;

export const WHALE_EMPTY = "No wallets watched. Add one to be told about its large transfers.";
export const WHALE_OFFLINE = "The on-chain service is not answering.";

const usd = (n: number): string => `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

const isChain = (s: string): s is OnchainChain => (ONCHAIN_CHAINS as readonly string[]).includes(s);

export function createWhaleCard(): { readonly el: HTMLElement; refresh(): void } {
  let result: OnchainResult | null = null;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let everMounted = false;

  /* ------------------------------------------------------------- form -- */
  let addrInput!: HTMLInputElement;
  let chainSelect!: HTMLSelectElement;
  let minInput!: HTMLInputElement;
  let watchBtn!: HTMLButtonElement;
  const formMsg = h("p", { class: "wh-msg", role: "status" }) as HTMLElement;

  const say = (text: string, tone: "neg" | "mute"): void => {
    formMsg.textContent = text;
    formMsg.setAttribute("data-tone", tone);
  };

  const submit = async (ev: Event): Promise<void> => {
    ev.preventDefault();
    const wallet = addrInput.value.trim();
    if (!isAddress(wallet)) {
      say("Not a wallet address: expected 0x followed by 40 hex digits.", "neg");
      return;
    }
    const minUsd = Number(minInput.value);
    if (!Number.isFinite(minUsd) || minUsd <= 0) {
      say("The minimum must be a dollar amount above zero.", "neg");
      return;
    }
    const chain = chainSelect.value;
    if (!isChain(chain)) {
      say("Pick a chain from the list.", "neg");
      return;
    }
    watchBtn.disabled = true;
    const r = await watchWallet({ wallet, chain, minUsd });
    watchBtn.disabled = false;
    if (!r.ok) {
      say(r.reason, "neg");
      return;
    }
    addrInput.value = "";
    say(`Watching ${shortAddr(wallet.toLowerCase())} on ${chain}.`, "mute");
    refresh();
  };

  const form = h(
    "form",
    { class: "wh-form", onsubmit: (ev: Event) => void submit(ev) },
    h("input", {
      class: "wh-addr",
      type: "text",
      placeholder: "0x… wallet address",
      spellcheck: "false",
      autocomplete: "off",
      "aria-label": "Wallet address",
      ref: (e: HTMLInputElement) => (addrInput = e),
    }),
    h(
      "select",
      { class: "wh-chain", "aria-label": "Chain", ref: (e: HTMLSelectElement) => (chainSelect = e) },
      ...ONCHAIN_CHAINS.map((c) => h("option", { value: c, text: c })),
    ),
    h(
      "label",
      { class: "wh-min", title: "A transfer at least this size, in US dollars, sends a Telegram alert." },
      h("span", { text: "min $" }),
      h("input", {
        type: "number",
        min: "1",
        step: "1000",
        value: String(DEFAULT_MIN_USD),
        "aria-label": "Minimum transfer in US dollars",
        ref: (e: HTMLInputElement) => (minInput = e),
      }),
    ),
    h("button", { class: "ghost-btn wh-go", type: "submit", text: "Watch", ref: (e: HTMLButtonElement) => (watchBtn = e) }),
  ) as HTMLElement;

  /* ------------------------------------------------------------ lists -- */
  const body = h("div", { class: "wh-body" }) as HTMLElement;

  const unwatch = async (w: WatchedWallet): Promise<void> => {
    busy = true;
    render();
    const r = await unwatchWallet(w.wallet);
    busy = false;
    if (!r.ok) say(r.reason, "neg");
    else say(`Stopped watching ${shortAddr(w.wallet)}.`, "mute");
    refresh();
  };

  const walletRow = (w: WatchedWallet): HTMLElement =>
    h(
      "div",
      { class: "wh-wallet" },
      h("span", { class: "wh-addr-text num", text: shortAddr(w.wallet), title: w.wallet }),
      isAddress(w.wallet)
        ? null
        : h("span", {
            class: "wh-bad",
            text: "not a valid address",
            title: "Not 0x and 40 hex digits, so no explorer can follow it and nothing will ever arrive for it.",
          }),
      h("span", { class: "wh-chain-text", text: w.chain ?? "ethereum (default)" }),
      h("span", { class: "wh-thr num", text: `≥ ${usd(w.minUsd)}`, title: "Telegram alert threshold, US dollars" }),
      h("button", {
        class: "wh-x",
        type: "button",
        text: "×",
        title: `Stop watching ${w.wallet}`,
        "aria-label": `Stop watching ${w.wallet}`,
        disabled: busy,
        onclick: () => void unwatch(w),
      }),
    ) as HTMLElement;

  const eventRow = (e: WalletEvent, nowMs: number): HTMLElement =>
    h(
      "div",
      { class: "wh-event", "data-dir": e.direction === "BUY" ? "in" : "out" },
      h("span", { class: "wh-dir", text: e.direction }),
      h("span", {
        class: "wh-amt num",
        text: `${pkNum(e.amount)} ${e.sym}`,
        title: `${e.amount} tokens of ${e.sym}${e.token ? ` (${e.token})` : ""}. Token units, not dollars.`,
      }),
      h("span", { class: "wh-who num", text: shortAddr(e.wallet), title: e.wallet }),
      h("span", { class: "wh-age", text: ageText(e.t, nowMs), title: new Date(e.t * 1000).toLocaleString() }),
    ) as HTMLElement;

  function sections(): HTMLElement[] {
    if (result === null) return [pkEmpty("loading", "Asking the on-chain service…")];
    if (result.state === "offline") {
      return [pkEmpty("unavailable", WHALE_OFFLINE), h("p", { class: "wh-reason", text: result.reason }) as HTMLElement];
    }
    const { wallets, events, skipped } = result.value;
    const on = wallets.filter((w) => w.enabled);
    const off = wallets.length - on.length;
    const nowMs = Date.now();
    const out: HTMLElement[] = [];

    out.push(
      on.length === 0
        ? pkEmpty("empty", WHALE_EMPTY)
        : pkSection(
            "Watched",
            `${on.length}${off > 0 ? ` · ${off} switched off` : ""}`,
            h("div", { class: "wh-wallets" }, ...on.map(walletRow)),
          ),
    );

    const shown = events.slice(0, MAX_EVENTS);
    out.push(
      pkSection(
        "Recent transfers",
        "in tokens, newest first",
        shown.length === 0
          ? pkEmpty("empty", "No transfers recorded for watched wallets yet.")
          : h("div", { class: "wh-events" }, ...shown.map((e) => eventRow(e, nowMs))),
      ),
    );

    if (skipped > 0) {
      out.push(
        h("p", {
          class: "wh-reason",
          text: `${skipped} row${skipped === 1 ? "" : "s"} from the service could not be read and ${skipped === 1 ? "is" : "are"} not shown.`,
        }) as HTMLElement,
      );
    }

    out.push(
      pkWhy(
        "Every token transfer of a watched wallet is recorded here, whatever its size. The dollar minimum only decides " +
          "which transfers send a Telegram alert. Amounts are in tokens: the service keeps no dollar value per transfer. " +
          "BUY means tokens arrived in the wallet and SELL means they left; a transfer is not proof of a trade. " +
          "Stopping a watch switches it off and keeps its settings, so watching again restores it.",
        "What this shows",
      ),
    );
    return out;
  }

  const el = h("div", { class: "wh-card" }, form, formMsg, body) as HTMLElement;

  function render(): void {
    clear(body);
    for (const n of sections()) body.appendChild(n);
  }

  /* ---------------------------------------------------------- polling -- */
  /* Polls while the card is in the page. A card that has been attached and
     then removed stops asking; `refresh()` starts it again. */
  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (el.isConnected) everMounted = true;
      /* Drawn, not merely connected — `./shown.ts`. Before first mount it
         keeps the original behaviour, so a card built early still loads. */
      if (isShown(el) || !everMounted) refresh();
      else schedule();
    }, WHALE_POLL_MS);
  }
  onShown(el, () => refresh());

  /* One request at a time. A refresh asked for mid-flight (a Watch landing
     during a poll) runs once more afterwards, so the answer shown is never
     one fetched before the change. */
  let inflight = false;
  let again = false;
  function refresh(): void {
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    if (el.isConnected) everMounted = true;
    void loadOnchain(MAX_EVENTS).then((r) => {
      inflight = false;
      result = r;
      render();
      if (again) {
        again = false;
        refresh();
      } else schedule();
    });
  }

  render();
  refresh();
  return { el, refresh };
}
