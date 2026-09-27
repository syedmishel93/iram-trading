/**
 * Getting a fire in front of the operator.
 *
 * Three channels, deliberately layered weakest-first, because the strong ones
 * need permission that may never be granted and an alert system that only works
 * for users who clicked "Allow" is not an alert system:
 *
 *   1. In-app log — always works, zero permission.
 *   2. Tab title — works when the tab is merely in the background.
 *   3. OS notification — works when the browser is behind other windows, and
 *      is the only one that survives you not looking at the screen.
 *
 * Permission is requested from a user gesture only. A page that fires the
 * permission prompt on load gets denied by reflex, and the denial is sticky.
 */

import type { AlertFire } from "./types";

export type NotifyPermission = "unsupported" | "default" | "granted" | "denied";

export function notifyPermission(): NotifyPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifyPermission;
}

export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return "denied";
  }
}

/** Title-bar attention that clears itself the moment the tab is looked at. */
function flashTitle(count: number): void {
  if (typeof document === "undefined") return;
  const base = document.title.replace(/^\(\d+\)\s*/, "");
  document.title = count > 0 ? `(${count}) ${base}` : base;
  const restore = (): void => {
    document.title = base;
    document.removeEventListener("visibilitychange", onVis);
  };
  const onVis = (): void => {
    if (!document.hidden) restore();
  };
  document.addEventListener("visibilitychange", onVis);
}

/**
 * A short two-tone chime, synthesised rather than shipped.
 *
 * An audio file would be an external asset, and this build is one self-contained
 * HTML file by contract. WebAudio costs nothing and cannot fail to load.
 */
export function chime(direction: "up" | "down" = "up"): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const [a, b] = direction === "up" ? [660, 990] : [660, 440];
    for (const [i, f] of [a, b].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f as number;
      gain.gain.setValueAtTime(0.0001, now + i * 0.11);
      gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.11 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.11);
      osc.stop(now + i * 0.11 + 0.12);
    }
    // Contexts are cheap but not free; let it go once the sound is done.
    window.setTimeout(() => void ctx.close(), 600);
  } catch {
    // Autoplay policy, no audio device, or a headless test. Silence is fine —
    // the log and the title still carry the alert.
  }
}

export interface DeliverOptions {
  sound: boolean;
  desktop: boolean;
  symbol: string;
}

/** Push one batch of fires through every channel the user has enabled. */
export function deliver(fires: readonly AlertFire[], opts: DeliverOptions): void {
  if (fires.length === 0) return;

  flashTitle(fires.length);
  if (opts.sound) chime();

  if (!opts.desktop || notifyPermission() !== "granted") return;
  // One notification per fire, capped: a batch of forty on a history reload
  // would bury every other notification on the machine.
  for (const f of fires.slice(0, 3)) {
    try {
      const n = new Notification(`${opts.symbol} — alert`, {
        body: f.reason,
        tag: `${f.alertId}:${f.time}`,
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // Some browsers throw for Notification outside a service worker.
    }
  }
  if (fires.length > 3) {
    try {
      void new Notification(`${opts.symbol} — ${fires.length - 3} more alerts`, {
        body: "Open the Signals desk for the full list.",
        tag: "iram-overflow",
      });
    } catch {
      /* as above */
    }
  }
}
