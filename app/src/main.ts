/* Faces first: the @font-face rules must be registered before any token that
   names them is resolved. */
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/type.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/desks.css";
import "./styles/chrome.css";
/* The chart header. After chrome.css so it specialises the row it restyles. */
import "./styles/topbar.css";
import "./styles/risk.css";
import "./styles/settings.css";
import "./styles/learn.css";
/* The Knowledge desk. After learn.css — it is the same family and specialises
   nothing the Learning desk defines, so order buys nothing here except sitting
   beside the sheet it is a sibling of. */
import "./styles/knowledge.css";
import "./styles/briefing.css";
import "./styles/study.css";
/* The Connections desk. Its own `.graph-` prefix, checked against every other
   sheet with `scratchpad/classcollide.py` before it was chosen. */
import "./styles/graph.css";
/* The inspector's shared vocabulary. BEFORE setup.css, so the Setup card can
   still specialise what the kit defines rather than fighting it. */
import "./styles/panelkit.css";
import "./styles/minichart.css";
import "./styles/setup.css";
import "./styles/inspector.css";
/* v59.2 inspector cards, each over a service that had no screen. After
   inspector.css and panelkit.css, whose vocabulary they reuse. */
import "./styles/card-gov.css";
import "./styles/card-alerts.css";
import "./styles/card-whale.css";
import "./styles/card-newpairs.css";
import "./styles/card-levels.css";
import "./styles/card-watch.css";
import "./styles/card-read.css";
import "./styles/chartdrawer.css";
import "./styles/review.css";
import "./styles/strategy.css";
/* The Live panel. After panelkit.css, because it reuses `.pk-kv` for an
   event's numbers and specialises nothing the kit defines. */
import "./styles/livefeed.css";
import "./styles/watchrail.css";
import "./styles/agent-expert.css";
/* LAST, and that is the point: press feedback extends controls the files above
   define, so it has to win on equal specificity. See `press.css` for the audit
   that produced it — 65 selectors with `:hover`, one file with `:active`. */
import "./styles/press.css";
/* v59.2 — the v5 design's look, LAST so it wins ties. See its header. */
import "./styles/v5.css";

import { mountShell } from "./ui/shell";
import { appearance } from "./ui/appearance";
import { scheduleFrame } from "./core/frame";
import { requestPersistence } from "./data/serverbars";

/**
 * The stored appearance, BEFORE the shell mounts.
 *
 * `ui/appearance.ts` builds its signals lazily, and the only other caller is
 * `buildSettings` — which runs when the Settings surface is first created.
 * MEASURED before this line existed: a terminal saved with dots and heavy
 * wicks came back with `--chart-grid-style: lines` and `--chart-wick: 1` on
 * the engine's theme, because nothing had set the attributes yet and the
 * chart reads them once at construction. The preference was saved, restored
 * into a signal nobody had asked for, and applied the moment you opened
 * Settings — which looks exactly like the setting not persisting.
 *
 * Here rather than inside `mountShell`: the attributes must be on :root
 * before the chart's first `themeFromCss()`, and this is the file that owns
 * what happens before the shell exists.
 */
appearance();

/**
 * ASK THE BROWSER TO STOP EVICTING THE ARCHIVE.
 *
 * MEASURED on this product's own origin: `navigator.storage.persisted()` was
 * FALSE, which means every bar it had ever downloaded was disposable — the
 * browser could reclaim the lot under disk pressure, with no event and no
 * warning. That is a poor foundation for anything calling itself a backtest.
 *
 * Fire-and-forget, after the shell: the answer changes nothing about how the
 * page starts, and blocking the first paint on a storage negotiation would
 * trade a real cost for a hypothetical one. The result is reported in the
 * Research library rather than swallowed, and the durable copy in
 * `server/svc/bars.py` is what makes a refusal survivable.
 */
void requestPersistence();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
mountShell(root);

/**
 * Hand over from the boot shell.
 *
 * `index.html` paints a static skeleton of the chrome so the window is not blank
 * while this module runs — MEASURED at 800ms to first contentful paint against a
 * document that had finished loading at 454ms.
 *
 * Removed a frame AFTER mount, not in the same task: `mountShell` returns
 * before the browser has laid anything out, so tearing the skeleton down here
 * would show one blank frame — the exact flash the skeleton exists to prevent.
 *
 * `scheduleFrame`, NOT `requestAnimationFrame`, AND THIS ONE BIT ME.
 * A bare rAF never fires in a tab that is not being composited, and the first
 * version used two nested ones. Boot the terminal in a background tab — which
 * is how it is normally opened, from a launcher — and the skeleton was never
 * taken down: a `position: fixed` overlay at `z-index: 9999` sitting over every
 * click in the application, for ever. `core/frame.ts` exists because
 * `ui/strategy.ts` hit the same trap, and it falls back to a timer when frames
 * are not being served.
 *
 * The node is REMOVED rather than hidden, once the fade it declares has run,
 * for the same reason: an invisible overlay still swallows input.
 */
const boot = document.getElementById("boot");
if (boot) {
  scheduleFrame(() => {
    boot.setAttribute("data-done", "");
    const done = (): void => boot.remove();
    boot.addEventListener("transitionend", done, { once: true });
    /* `transitionend` never fires when the transition is suppressed — reduced
       motion, a hidden tab, or a zero duration. Comfortably past the 150ms the
       fade declares. */
    window.setTimeout(done, 400);
  });
}
