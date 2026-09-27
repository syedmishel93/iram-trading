/**
 * New token listings, and the wallets the service scores.
 *
 * The title is drawn by the dock's card head; this is the body. Two cards, one
 * file, because they share a client and a set of refusals — and both existed as
 * greyed-out menu rows reading "no screen yet" until now.
 *
 * WHAT THE PAIRS LIST IS NOT
 *
 * DexScreener's newest token PROFILES: things that have just been listed. That
 * is not a list of things worth buying, and the service's own Telegram message
 * says as much. So nothing here ranks, scores or sorts by anything that would
 * imply a recommendation, the warning is on the card rather than behind a fold,
 * and there is no price, change or volume column — the service stores none, and
 * a column the data cannot fill is a column that invites a guess.
 *
 * NEWEST FIRST IS THE ONLY ORDER THE DATA SUPPORTS. The table holds a key and a
 * timestamp; sorting by anything else would need a number that does not exist.
 *
 * THE ADDRESS IS THE ROW. It is truncated for reading and carries the full
 * value in `title`, because a truncated address copied out of a screen is a
 * transaction sent nowhere. The explorer link is null for any chain nobody
 * mapped, rather than guessed — a link to a 404 reads as "this token does not
 * exist", which is information, and wrong.
 */

import { each, h } from "../dom";
import { signal, computed } from "../../core/signal";
import { pkWhy } from "../panelkit";
import { onShown } from "./shown";
import { ageText, shortAddr } from "../../data/onchain";
import {
  explorerUrl,
  loadDbWallets,
  loadNewPairs,
  type DbWallet,
  type NewPair,
} from "../../data/newpairs";

const clock = signal(Date.now());
setInterval(() => clock.set(Date.now()), 30_000);

export function createNewPairsCard(): { readonly el: HTMLElement; refresh(): void } {
  const pairs = signal<readonly NewPair[]>([]);
  const total = signal(0);
  /** Null until asked. `false` would claim the service is absent before asking. */
  const reachable = signal<boolean | null>(null);
  const why = signal("");

  const refresh = (): void => {
    /* TWELVE, NOT FORTY. MEASURED: 37 rows made the card 1,502px tall in a
       dock where the next largest is 456, so it pushed every other panel off
       the screen. The state line already says how many exist, which is the
       fact that matters; the list is a sample of the newest, and a feed to
       screen does not become more useful by being longer. */
    void loadNewPairs(12).then((a) => {
      if (a.kind === "offline") {
        reachable.set(false);
        why.set(a.why);
        return;
      }
      reachable.set(true);
      why.set("");
      pairs.set(a.value.pairs ?? []);
      total.set(a.value.total ?? 0);
    });
  };

  const state = (): string => {
    if (reachable() === null) return "Reading the scanner's list…";
    if (reachable() === false) return why();
    const n = total();
    if (n === 0) {
      /* THREE DISTINCT STATES. "Could not ask" is above; this is "asked, and
         it holds nothing", which is not the same fact and must not look it. */
      return "The scanner has recorded nothing yet. It polls every five minutes.";
    }
    const shown = pairs().length;
    return shown < n
      ? `${n.toLocaleString()} tokens recorded, ${shown} newest shown.`
      : `${n.toLocaleString()} ${n === 1 ? "token" : "tokens"} recorded.`;
  };

  const row = (p: NewPair): HTMLElement => {
    const url = explorerUrl(p.chain, p.address);
    return h(
      "div",
      { class: "np-row" },
      h("span", { class: "np-chain", text: p.chain }),
      url
        ? (h("a", {
            class: "np-addr",
            href: url,
            target: "_blank",
            rel: "noreferrer noopener",
            title: p.address,
            text: shortAddr(p.address),
          }) as HTMLElement)
        : (h("span", {
            class: "np-addr",
            /* The FULL address on hover, always. A truncated one copied off a
               screen is a transaction sent nowhere. */
            title: p.address,
            text: shortAddr(p.address),
          }) as HTMLElement),
      h("span", { class: "np-when", text: () => ageText(p.t, clock()) }),
    ) as HTMLElement;
  };

  const list = h("div", { class: "np-rows" }) as HTMLElement;
  /* `each`, not a function child: a hand-rolled one that throws loses the whole
     list silently, which cost three tables in v62.13. */
  each(list, () => [...pairs()], (p) => `${p.chain}:${p.address}`, row);

  const el = h(
    "div",
    { class: "np" },
    h("p", { class: "np-state", text: state }),

    /* THE WARNING IS NOT BEHIND A FOLD. This is a feed of things just listed,
       and the single most important fact about that population is what happens
       to most of it. Putting it behind "Why?" would be shortening that deletes
       rather than moves. */
    h("p", {
      class: "np-warn",
      text: "Just listed, not vetted. Most new tokens go to zero — this is a feed to screen, not a list to buy.",
    }),

    list,

    pkWhy(
      "These are DexScreener's newest token profiles, recorded by the scanner that runs with the terminal closed. " +
        "The list carries no price, no change and no volume because the service stores none of them, and a column " +
        "filled by guessing is worse than a column that is not there. Newest first is the only order the data " +
        "supports. An address links to a block explorer only where the chain is one this product knows — a link " +
        "built from a pattern would send you to a page that reads as 'no such token'.",
      "Where this comes from, and why there are no numbers",
    ),
  ) as HTMLElement;

  refresh();
  /* A dock card is built once and kept, so a closed panel would otherwise go on
     polling; `onShown` refreshes it the moment it comes back. */
  onShown(el, refresh);
  return { el, refresh };
}

export function createDbWalletsCard(): { readonly el: HTMLElement; refresh(): void } {
  const wallets = signal<readonly DbWallet[]>([]);
  const reachable = signal<boolean | null>(null);
  const why = signal("");

  const refresh = (): void => {
    void loadDbWallets().then((a) => {
      if (a.kind === "offline") {
        reachable.set(false);
        why.set(a.why);
        return;
      }
      reachable.set(true);
      why.set("");
      wallets.set(a.value.wallets ?? []);
    });
  };

  const armed = computed(() => wallets().filter((w) => (w.alert ?? 0) > 0).length);

  const state = (): string => {
    if (reachable() === null) return "Reading the wallet list…";
    if (reachable() === false) return why();
    const n = wallets().length;
    if (n === 0) return "No wallets scored yet. The list is filled by the smart-money importer.";
    return `${n} ${n === 1 ? "wallet" : "wallets"} scored, ${armed()} set to alert.`;
  };

  const row = (w: DbWallet): HTMLElement =>
    h(
      "div",
      { class: "np-row np-wal", "data-alert": String((w.alert ?? 0) > 0) },
      h("span", { class: "np-tier", text: w.tier || "—" }),
      h("span", {
        class: "np-addr",
        title: w.wallet,
        text: w.nick || shortAddr(w.wallet),
      }),
      h("span", {
        class: "np-score num",
        /* A score with no scale is a number nobody can read, so it is labelled
           rather than left bare. */
        text: Number.isFinite(w.score) ? w.score.toFixed(2) : "—",
      }),
    ) as HTMLElement;

  const list = h("div", { class: "np-rows" }) as HTMLElement;
  each(list, () => [...wallets()], (w) => w.wallet, row);

  const el = h(
    "div",
    { class: "np" },
    h("p", { class: "np-state", text: state }),
    list,
    pkWhy(
      "These are the wallets the smart-money importer has scored, best first, and the ones marked to alert are " +
        "the ones the background job messages you about. The score is the importer's own, on its own scale — it " +
        "is shown so two wallets can be compared with each other, and it means nothing on its own. This list is " +
        "what the alert loop watches; the transfers it produces are on the Whale watch card.",
      "Whose list this is, and what the score means",
    ),
  ) as HTMLElement;

  refresh();
  onShown(el, refresh);
  return { el, refresh };
}
