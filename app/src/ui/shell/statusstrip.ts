/**
 * The status strip — what the terminal is doing when you are not looking.
 *
 * Five small readings in the command bar: server-side alerts, armed signals,
 * whether the risk governor can see your book, the broker link, and the
 * background services. Each is a button: hovering says what it means, clicking
 * goes where you would fix or use it.
 *
 * WHY "CAN'T SEE BOOK" AND NOT A PERCENTAGE when MT5 is offline: the risk
 * governor answers WARN, never ALLOW, when it cannot read open positions. A
 * heat of 0.0% with no broker is the hand-entered book, not the real one, and
 * the strip must not make the second look like the first.
 */

import { h } from "../dom";
import { icon, type IconName } from "../icons";
import { effect, signal } from "../../core/signal";
import { loadStatus, type StatusResult } from "../../data/status";
import type { ShellContext } from "./context";
import type { createBrokerModel } from "../model/broker";
import type { createSettings } from "../../settings/ui";
import type { LazyDesk } from "./context";

export const STATUS_POLL_MS = 60_000;

export interface StatusStripDeps {
  readonly broker: ReturnType<typeof createBrokerModel>;
  readonly settings: LazyDesk<ReturnType<typeof createSettings>>;
}

export interface StatusItem {
  readonly key: string;
  readonly icon: IconName;
  readonly value: string;
  readonly tone: "" | "warn" | "pos";
  readonly why: string;
}

/**
 * The five readings, from the service status and the broker link.
 *
 * Pure, so every combination — offline, broker up, stale loops — is tested
 * without a network or a DOM.
 */
export function statusItems(s: StatusResult | null, brokerConnected: boolean): StatusItem[] {
  const off = s === null || s.state === "offline";
  const v = s !== null && s.state === "ok" ? s.value : null;
  const stale = v ? v.staleLoops.length : 0;
  return [
    {
      key: "alerts",
      icon: "bell",
      value: v ? String(v.pendingAlerts) : "—",
      tone: "",
      why: off ? "Alerts: the background service is not answering." : `${v?.pendingAlerts ?? 0} price alerts armed on the server. They fire even when the terminal is closed.`,
    },
    {
      key: "signals",
      icon: "signals",
      value: v && v.armedSignals !== null ? String(v.armedSignals) : "—",
      tone: "",
      why: off
        ? "Signals: the background service is not answering."
        : v?.armedSignals === null
          ? "Signals: the service is up but the armed list could not be read."
          : `${v?.armedSignals ?? 0} strategies armed. The server checks them on every closed bar.`,
    },
    {
      key: "risk",
      icon: "risk",
      value: brokerConnected ? "live" : "blind",
      tone: brokerConnected ? "pos" : "warn",
      why: brokerConnected
        ? "The risk governor is reading your real positions from MT5."
        : "The risk governor can't see open positions while MT5 is offline, so it warns rather than clears.",
    },
    {
      key: "mt5",
      icon: "live",
      value: brokerConnected ? "on" : "off",
      tone: brokerConnected ? "pos" : "warn",
      why: brokerConnected ? "MT5 is connected — equity and positions are live." : "MT5 is not connected. Start the terminal and log in to see your real account.",
    },
    {
      key: "services",
      icon: "data",
      value: v ? `${v.loops - stale}/${v.loops}` : "—",
      tone: off || !v || v.loops === 0 || stale > 0 ? "warn" : "pos",
      why: off
        ? (s?.state === "offline" ? s.reason : "Checking the background services…")
        : v?.loops === 0
          ? "No background service has reported yet, so alerts and armed signals are not being checked. Start the terminal with python run.py."
          : stale > 0
          ? `${stale} background services have stopped ticking: ${v?.staleLoops.join(", ")}.`
          : `All ${v?.loops ?? 0} background services that have reported are running${v?.telegram ? ", and Telegram is set up" : "; Telegram is not set up"}.`,
    },
  ];
}

export function createStatusStrip(ctx: ShellContext, d: StatusStripDeps): HTMLElement {
  const { state } = ctx;
  const status = signal<StatusResult | null>(null);
  const poll = (): void => void loadStatus().then((r) => status.set(r));
  poll();
  setInterval(poll, STATUS_POLL_MS);

  const go: Record<string, () => void> = {
    alerts: () => state.view.set("signals"),
    signals: () => state.view.set("signals"),
    risk: () => state.view.set("risk"),
    mt5: () => state.view.set("risk"),
    services: () => d.settings().open(),
  };
  const el = h("div", { class: "status-strip", role: "group", "aria-label": "System status" }) as HTMLElement;
  effect(() => {
    const items = statusItems(status(), d.broker.connected());
    el.replaceChildren(
      ...items.map(
        (it) =>
          h(
            "button",
            {
              class: "sitem",
              type: "button",
              "data-tone": it.tone,
              title: it.why,
              "aria-label": it.why,
              onclick: () => go[it.key]?.(),
            },
            icon(it.icon, { size: 13 }),
            h("span", { class: "sitem-v num", text: it.value }),
          ) as HTMLElement,
      ),
    );
  });
  return el;
}
