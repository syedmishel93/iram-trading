/**
 * One floating layer, one dismissal rule, one focus policy.
 *
 * The alternative — and what almost every codebase ends up with — is each
 * popup implementing its own outside-click listener, its own Escape handler and
 * its own z-index. That fails in the same four ways every time:
 *
 *  1. Escape closes the WRONG thing. A context menu opened from inside a modal
 *     closes the modal. Only a stack fixes that, and a stack has to be shared.
 *  2. The outside-click listener fires on the click that OPENED the popup,
 *     because it was attached during that same event's bubble phase.
 *  3. Focus is lost. You dismiss a menu and the keyboard is now typing into the
 *     document body, so the next shortcut goes nowhere.
 *  4. The popup renders off-screen near an edge, because nobody measured.
 *
 * All four are handled here, once. Everything floating in the terminal — the
 * command palette, the menu bar, right-click menus, the shortcut sheet — goes
 * through this file.
 */

import { h } from "./dom";

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "right-start" | "center";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface OverlayOptions {
  /** Element to hang off, or a viewport point (for a right-click menu). */
  anchor?: HTMLElement | Point;
  placement?: Placement;
  /** Extra class on the positioned wrapper. */
  className?: string;
  /** Called after the overlay is removed, however it was dismissed. */
  onClose?: () => void;
  /** Dismiss on a pointer press outside. Default true. */
  closeOnOutside?: boolean;
  /** Dismiss on Escape. Default true. */
  closeOnEscape?: boolean;
  /** Return focus to whatever had it when this opened. Default true. */
  restoreFocus?: boolean;
  /** Move focus into the overlay on open. Default true. */
  autoFocus?: boolean;
  /** Dim the rest of the app. Modals only. */
  scrim?: boolean;
}

export interface OverlayHandle {
  /** The positioned wrapper. Content was appended to this. */
  readonly el: HTMLElement;
  readonly isOpen: () => boolean;
  close(): void;
  /** Recompute position — call after the content's size changes. */
  reposition(): void;
}

/** Gap between an anchor and the overlay hanging off it. */
const ANCHOR_GAP = 4;
/** Keep this far from the viewport edge so nothing is flush against glass. */
const VIEWPORT_MARGIN = 8;

let layer: HTMLElement | null = null;
const stack: OverlayHandle[] = [];

function ensureLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  layer = h("div", { class: "overlay-layer" });
  document.body.appendChild(layer);
  return layer;
}

/** The topmost overlay — the only one Escape and outside clicks may act on. */
function top(): OverlayHandle | undefined {
  return stack[stack.length - 1];
}

/** Close every open overlay, innermost first. Used when a view is replaced. */
export function closeAllOverlays(): void {
  while (stack.length > 0) (stack[stack.length - 1] as OverlayHandle).close();
}

export function overlayDepth(): number {
  return stack.length;
}

/**
 * Focusable descendants, in tab order.
 *
 * `:not([disabled])` matters: a trap that includes disabled controls parks the
 * ring on something that cannot be activated, and the user is left pressing Tab
 * wondering why nothing happens.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

function isPoint(a: HTMLElement | Point | undefined): a is Point {
  return !!a && typeof (a as Point).x === "number";
}

export function openOverlay(content: HTMLElement, opts: OverlayOptions = {}): OverlayHandle {
  const host = ensureLayer();
  const placement = opts.placement ?? "bottom-start";
  const closeOnOutside = opts.closeOnOutside !== false;
  const closeOnEscape = opts.closeOnEscape !== false;
  const restoreFocus = opts.restoreFocus !== false;
  const autoFocus = opts.autoFocus !== false;

  const previouslyFocused = document.activeElement as HTMLElement | null;

  const scrim = opts.scrim === true ? h("div", { class: "overlay-scrim" }) : null;
  const el = h("div", {
    class: `overlay${opts.className ? ` ${opts.className}` : ""}`,
    "data-placement": placement,
  });
  el.appendChild(content);

  if (scrim) host.appendChild(scrim);
  host.appendChild(el);

  let open = true;

  const reposition = (): void => {
    if (!open) return;
    if (placement === "center") {
      el.style.left = "";
      el.style.top = "";
      return;
    }

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left: number;
    let topPx: number;

    if (isPoint(opts.anchor)) {
      left = opts.anchor.x;
      topPx = opts.anchor.y;
    } else if (opts.anchor instanceof HTMLElement) {
      const a = opts.anchor.getBoundingClientRect();
      switch (placement) {
        case "bottom-end":
          left = a.right - rect.width;
          topPx = a.bottom + ANCHOR_GAP;
          break;
        case "top-start":
          left = a.left;
          topPx = a.top - rect.height - ANCHOR_GAP;
          break;
        case "right-start":
          left = a.right + ANCHOR_GAP;
          topPx = a.top;
          break;
        default:
          left = a.left;
          topPx = a.bottom + ANCHOR_GAP;
      }
    } else {
      left = VIEWPORT_MARGIN;
      topPx = VIEWPORT_MARGIN;
    }

    /**
     * Flip before clamping.
     *
     * Clamping alone slides a menu up until it covers the button that opened
     * it — you can no longer see what you clicked. Flipping to the other side
     * of the anchor keeps the trigger visible, and clamping then only handles
     * the residual case where neither side fits.
     */
    if (topPx + rect.height > vh - VIEWPORT_MARGIN) {
      if (opts.anchor instanceof HTMLElement) {
        const a = opts.anchor.getBoundingClientRect();
        const above = a.top - rect.height - ANCHOR_GAP;
        if (above >= VIEWPORT_MARGIN) topPx = above;
        else topPx = Math.max(VIEWPORT_MARGIN, vh - rect.height - VIEWPORT_MARGIN);
      } else {
        const above = topPx - rect.height;
        topPx = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, vh - rect.height - VIEWPORT_MARGIN);
      }
    }
    if (left + rect.width > vw - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, vw - rect.width - VIEWPORT_MARGIN);
    }
    if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
    if (topPx < VIEWPORT_MARGIN) topPx = VIEWPORT_MARGIN;

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(topPx)}px`;
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (top() !== handle) return;

    if (e.key === "Escape" && closeOnEscape) {
      e.preventDefault();
      e.stopPropagation();
      handle.close();
      return;
    }

    /* Focus trap. Without it, Tab walks out of a modal and into the app behind
       it, where the ring is invisible because the scrim is over it. */
    if (e.key === "Tab" && opts.scrim === true) {
      const items = focusable(el);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  /**
   * Outside-press dismissal, on pointerDOWN and in the CAPTURE phase.
   *
   * `click` is too late: the press has already landed on whatever is under the
   * menu, so the first click outside both closes the menu and activates the
   * thing behind it. Capture is what stops a stopPropagation() somewhere in the
   * app from making a menu impossible to dismiss.
   */
  const onPointerDown = (e: Event): void => {
    if (top() !== handle) return;
    const target = e.target as Node | null;
    if (target && el.contains(target)) return;
    handle.close();
  };

  const onViewportChange = (): void => reposition();

  const handle: OverlayHandle = {
    el,
    isOpen: () => open,
    reposition,
    close() {
      if (!open) return;
      open = false;

      window.removeEventListener("keydown", onKeyDown, true);
      if (closeOnOutside) window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);

      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);

      el.remove();
      scrim?.remove();

      /* Only restore focus if it is still ours to restore. If the user has
         already clicked into something else, yanking the caret back would be
         worse than leaving it. */
      if (restoreFocus && previouslyFocused?.isConnected) {
        const active = document.activeElement;
        if (active === document.body || active === null || el.contains(active)) {
          previouslyFocused.focus();
        }
      }

      opts.onClose?.();
    },
  };

  stack.push(handle);

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);

  /**
   * Attach the outside listener on the NEXT task, not this one.
   *
   * The click that opened this overlay is still propagating. Attaching now
   * means that same event reaches this listener, is outside the overlay by
   * definition, and closes it instantly — the classic "menu will not open" bug.
   */
  if (closeOnOutside) {
    setTimeout(() => {
      if (open) window.addEventListener("pointerdown", onPointerDown, true);
    }, 0);
  }

  reposition();

  if (autoFocus) {
    const first = focusable(el)[0];
    if (first) first.focus();
    else {
      /* Nothing focusable inside: park focus on the container itself so Escape
         still reaches the app and the ring is not left behind the scrim. */
      el.tabIndex = -1;
      el.focus();
    }
  }

  return handle;
}
