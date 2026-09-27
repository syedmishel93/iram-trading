/**
 * The workspace: a tree of split panes.
 *
 * WHY A TREE AND NOT A GRID OF PRESETS
 * MetaTrader gives you tile/cascade. TradingView gives you a fixed menu of
 * layouts up to 8. Both are the same admission: the layout is a picture the
 * vendor drew, and if the one you need is not on the list you do not get it. A
 * binary split tree gives every one of those layouts as a special case AND the
 * ones nobody enumerated — 1h wide across the top with three 5m panes beneath
 * it is just two splits.
 *
 * WHY IT IS PURE
 * Every operation returns a NEW tree and touches nothing. That is what makes
 * undo one line, makes a saved workspace a `JSON.stringify` away, and makes the
 * whole thing testable without a DOM. The renderer diffs old against new; the
 * model never knows a screen exists.
 *
 * LINK GROUPS
 * Bloomberg's best idea, and the one every retail platform skipped: panes carry
 * a colour, and changing the symbol in one pane changes it in every pane
 * wearing the same colour. `none` links to nothing. That is how you get a
 * four-timeframe view of one instrument that follows you when you switch
 * instruments, without four separate symbol boxes to keep in sync by hand — and
 * a pane deliberately left unlinked stays put while the rest of the desk moves.
 *
 * THE CHANNEL CARRIES THE SYMBOL, NOT THE TIMEFRAME
 * Every pane keeps its own horizon, always. A channel that also synchronised
 * the timeframe would make the layout above — one instrument, four horizons —
 * the one layout you could not build, since panes are born linked and splits
 * inherit the group. See `applyLink`.
 */

/** Link channels. Named by colour because that is how they are recognised. */
export const LINK_GROUPS = ["none", "amber", "cyan", "violet", "rose"] as const;
export type LinkGroup = (typeof LINK_GROUPS)[number];

/** What a pane can show. Chart is the default; the rest are the desks. */
export type PaneContent = "chart" | "depth" | "signals" | "screener" | "flow" | "agent";

export interface PaneNode {
  readonly kind: "leaf";
  readonly id: string;
  readonly content: PaneContent;
  readonly symbol: string;
  readonly timeframe: string;
  readonly link: LinkGroup;
}

export interface SplitNode {
  readonly kind: "split";
  /** "row" places children side by side; "col" stacks them. */
  readonly dir: "row" | "col";
  /** Fraction of the axis given to `a`, clamped to [MIN_RATIO, 1-MIN_RATIO]. */
  readonly ratio: number;
  readonly a: LayoutNode;
  readonly b: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

/**
 * Smallest share a pane may be squeezed to.
 *
 * A pane thinner than this cannot render an axis, so dragging a splitter to the
 * edge produces a sliver that looks broken rather than a pane that is small.
 * Clamping here — in the model — means every caller gets it, including a
 * hand-edited saved layout.
 */
export const MIN_RATIO = 0.12;

export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r));
}

export interface PaneSeed {
  content?: PaneContent;
  symbol?: string;
  timeframe?: string;
  link?: LinkGroup;
}

let paneCounter = 0;

/** Fresh pane id. Monotonic, so ids never collide within a session. */
export function newPaneId(): string {
  paneCounter += 1;
  return `p${paneCounter.toString(36)}`;
}

/** For tests: make ids reproducible. */
export function resetPaneIds(to = 0): void {
  paneCounter = to;
}

export function makePane(seed: PaneSeed = {}): PaneNode {
  return {
    kind: "leaf",
    id: newPaneId(),
    content: seed.content ?? "chart",
    symbol: seed.symbol ?? "BTCUSDT",
    timeframe: seed.timeframe ?? "1h",
    link: seed.link ?? "amber",
  };
}

/** Every pane in the tree, left-to-right / top-to-bottom. */
export function panes(node: LayoutNode): PaneNode[] {
  if (node.kind === "leaf") return [node];
  return [...panes(node.a), ...panes(node.b)];
}

export function findPane(node: LayoutNode, id: string): PaneNode | null {
  if (node.kind === "leaf") return node.id === id ? node : null;
  return findPane(node.a, id) ?? findPane(node.b, id);
}

export function paneCount(node: LayoutNode): number {
  return node.kind === "leaf" ? 1 : paneCount(node.a) + paneCount(node.b);
}

/**
 * Replace one pane, leaving the rest of the tree untouched by identity.
 *
 * Identity matters: the renderer keeps a live ChartEngine per pane and reuses
 * the DOM for any subtree that came back `===`. Rebuilding the whole tree on
 * every symbol change would tear down and recreate every canvas on screen.
 */
export function updatePane(
  node: LayoutNode,
  id: string,
  patch: Partial<Omit<PaneNode, "kind" | "id">>,
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id !== id) return node;
    return { ...node, ...patch };
  }
  const a = updatePane(node.a, id, patch);
  const b = updatePane(node.b, id, patch);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/**
 * Split a pane in two.
 *
 * The new pane INHERITS the old one's symbol, timeframe and link group. This is
 * deliberate: you split because you want another view OF WHAT YOU ARE LOOKING
 * AT. Opening an empty pane on some default symbol means every split is
 * followed by retyping the thing that was already on screen.
 */
export function splitPane(
  node: LayoutNode,
  id: string,
  dir: "row" | "col",
  seed?: PaneSeed,
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.id !== id) return node;
    const fresh = makePane({
      content: seed?.content ?? node.content,
      symbol: seed?.symbol ?? node.symbol,
      timeframe: seed?.timeframe ?? node.timeframe,
      link: seed?.link ?? node.link,
    });
    return { kind: "split", dir, ratio: 0.5, a: node, b: fresh };
  }
  const a = splitPane(node.a, id, dir, seed);
  const b = splitPane(node.b, id, dir, seed);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/**
 * Close a pane; its sibling takes the whole space.
 *
 * Closing the LAST pane returns the tree unchanged. A workspace with no panes
 * is not a state the UI has anything to draw for, and "the close button did
 * nothing" is a far better failure than a blank terminal.
 */
export function closePane(node: LayoutNode, id: string): LayoutNode {
  if (node.kind === "leaf") return node;
  if (node.a.kind === "leaf" && node.a.id === id) return node.b;
  if (node.b.kind === "leaf" && node.b.id === id) return node.a;
  const a = closePane(node.a, id);
  const b = closePane(node.b, id);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Path to a split node: a string of "a"/"b" steps from the root. */
export type SplitPath = string;

export function setRatio(node: LayoutNode, path: SplitPath, ratio: number): LayoutNode {
  if (node.kind === "leaf") return node;
  if (path.length === 0) {
    const next = clampRatio(ratio);
    return next === node.ratio ? node : { ...node, ratio: next };
  }
  const step = path[0];
  const rest = path.slice(1);
  if (step === "a") {
    const a = setRatio(node.a, rest, ratio);
    return a === node.a ? node : { ...node, a };
  }
  if (step === "b") {
    const b = setRatio(node.b, rest, ratio);
    return b === node.b ? node : { ...node, b };
  }
  return node;
}

/** Flip a split's direction — the fastest way to rearrange without redrawing. */
export function flipSplit(node: LayoutNode, path: SplitPath): LayoutNode {
  if (node.kind === "leaf") return node;
  if (path.length === 0) return { ...node, dir: node.dir === "row" ? "col" : "row" };
  const step = path[0];
  const rest = path.slice(1);
  if (step === "a") {
    const a = flipSplit(node.a, rest);
    return a === node.a ? node : { ...node, a };
  }
  if (step === "b") {
    const b = flipSplit(node.b, rest);
    return b === node.b ? node : { ...node, b };
  }
  return node;
}

/**
 * Apply a change to every pane on the same link channel.
 *
 * The source pane is always updated, even when it is `none`: unlinking a pane
 * must not make it stop responding to its own controls. Everything else follows
 * only if it shares a channel that is not `none`.
 */
export function applyLink(
  node: LayoutNode,
  sourceId: string,
  patch: Partial<Pick<PaneNode, "symbol" | "timeframe">>,
): LayoutNode {
  const source = findPane(node, sourceId);
  if (!source) return node;

  const walk = (n: LayoutNode): LayoutNode => {
    if (n.kind === "leaf") {
      const isSource = n.id === sourceId;
      const linked = source.link !== "none" && n.link === source.link;
      if (!isSource && !linked) return n;

      /**
       * The channel carries the SYMBOL. The timeframe is the pane's own.
       *
       * This is the whole point of the feature as described at the top of this
       * file — "a four-timeframe view of one instrument that follows you when
       * you switch instruments" — and propagating the timeframe made that
       * exact layout impossible to build. Panes are created on `amber` and
       * `splitPane` inherits the group, so every pane on a fresh workspace is
       * linked: setting one to 4h set all of them to 4h, and the user's report
       * was the plain truth — there was no way to give two panes two
       * timeframes. A linked pane follows the instrument and keeps its own
       * horizon; that is the only reading under which the colours are useful.
       */
      const next = isSource
        ? { ...n, ...patch }
        : patch.symbol === undefined || patch.symbol === n.symbol
          ? n
          : { ...n, symbol: patch.symbol };
      /* Preserve identity when nothing actually changed, so the renderer does
         not rebuild a chart that is already showing the right thing. */
      return next.symbol === n.symbol && next.timeframe === n.timeframe ? n : next;
    }
    const a = walk(n.a);
    const b = walk(n.b);
    return a === n.a && b === n.b ? n : { ...n, a, b };
  };

  return walk(node);
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly root: LayoutNode;
  /** The pane keyboard input and the topbar act on. */
  readonly activePaneId: string;
}

/**
 * Named starting layouts.
 *
 * These are the presets the other platforms stop at — offered because they are
 * genuinely the common cases, not because the model cannot express more.
 */
export type PresetName = "single" | "duo" | "duo-stacked" | "triple" | "quad" | "focus-trio";

export function preset(name: PresetName, seed: PaneSeed = {}): LayoutNode {
  const p = (over: PaneSeed = {}): PaneNode => makePane({ ...seed, ...over });

  switch (name) {
    case "single":
      return p();
    case "duo":
      return { kind: "split", dir: "row", ratio: 0.5, a: p(), b: p() };
    case "duo-stacked":
      return { kind: "split", dir: "col", ratio: 0.5, a: p(), b: p() };
    case "triple":
      /* One tall pane on the left, two stacked on the right — the layout for
         "my chart, plus the two timeframes that qualify it". */
      return {
        kind: "split",
        dir: "row",
        ratio: 0.58,
        a: p(),
        b: { kind: "split", dir: "col", ratio: 0.5, a: p(), b: p() },
      };
    case "quad":
      return {
        kind: "split",
        dir: "col",
        ratio: 0.5,
        a: { kind: "split", dir: "row", ratio: 0.5, a: p(), b: p() },
        b: { kind: "split", dir: "row", ratio: 0.5, a: p(), b: p() },
      };
    case "focus-trio":
      /* The execution layout: one large pane across the top, three small ones
         beneath. Big enough to trade from, with the context underneath. */
      return {
        kind: "split",
        dir: "col",
        ratio: 0.62,
        a: p(),
        b: {
          kind: "split",
          dir: "row",
          ratio: 0.34,
          a: p(),
          b: { kind: "split", dir: "row", ratio: 0.5, a: p(), b: p() },
        },
      };
  }
}

/**
 * Validate a layout loaded from storage or a vault file.
 *
 * A saved workspace is untrusted input: it may come from an older version, a
 * hand-edited vault, or a sync from a machine running a build that knows a pane
 * content this one does not. Anything unrecognised is REPLACED with a valid
 * default rather than rejected, because losing your whole desk over one unknown
 * field is a worse outcome than losing one pane's content type.
 */
export function sanitizeLayout(value: unknown, depth = 0): LayoutNode | null {
  if (depth > 12) return null; /* a hand-edited file can nest forever */
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  if (v["kind"] === "leaf") {
    const content = v["content"];
    const link = v["link"];
    return {
      kind: "leaf",
      id: typeof v["id"] === "string" && v["id"].length > 0 ? v["id"] : newPaneId(),
      content: isPaneContent(content) ? content : "chart",
      symbol: typeof v["symbol"] === "string" && v["symbol"].length > 0 ? v["symbol"] : "BTCUSDT",
      timeframe: typeof v["timeframe"] === "string" && v["timeframe"].length > 0 ? v["timeframe"] : "1h",
      link: isLinkGroup(link) ? link : "amber",
    };
  }

  if (v["kind"] === "split") {
    const a = sanitizeLayout(v["a"], depth + 1);
    const b = sanitizeLayout(v["b"], depth + 1);
    /* A split with a dead child is not a split. Promoting the survivor keeps
       the rest of the layout rather than discarding the branch. */
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    return {
      kind: "split",
      dir: v["dir"] === "col" ? "col" : "row",
      ratio: clampRatio(typeof v["ratio"] === "number" ? v["ratio"] : 0.5),
      a,
      b,
    };
  }

  return null;
}

const PANE_CONTENTS: readonly PaneContent[] = ["chart", "depth", "signals", "screener", "flow", "agent"];

function isPaneContent(v: unknown): v is PaneContent {
  return typeof v === "string" && (PANE_CONTENTS as readonly string[]).includes(v);
}

function isLinkGroup(v: unknown): v is LinkGroup {
  return typeof v === "string" && (LINK_GROUPS as readonly string[]).includes(v);
}

export function sanitizeWorkspace(value: unknown): Workspace | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const root = sanitizeLayout(v["root"]);
  if (!root) return null;
  const list = panes(root);
  const first = list[0];
  if (!first) return null;
  const active = typeof v["activePaneId"] === "string" ? v["activePaneId"] : "";
  return {
    id: typeof v["id"] === "string" && v["id"].length > 0 ? v["id"] : `ws-${newPaneId()}`,
    name: typeof v["name"] === "string" && v["name"].length > 0 ? v["name"] : "Workspace",
    root,
    /* An active id that no longer names a pane would leave the topbar driving
       nothing. Falling back to the first pane is always valid. */
    activePaneId: list.some((p) => p.id === active) ? active : first.id,
  };
}

/**
 * Geometry for the renderer: one rectangle per pane, in fractions of the host.
 *
 * Computed from the tree rather than left to nested flexbox because the chart
 * canvases need explicit pixel sizes anyway, and because a splitter needs to
 * know exactly where it sits. Fractions, not pixels, so this stays pure and the
 * caller multiplies by whatever the host measures.
 */
export interface PaneRect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface SplitterRect {
  readonly path: SplitPath;
  readonly dir: "row" | "col";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Geometry {
  readonly panes: readonly PaneRect[];
  readonly splitters: readonly SplitterRect[];
}

export function geometry(node: LayoutNode): Geometry {
  const paneOut: PaneRect[] = [];
  const splitOut: SplitterRect[] = [];

  const walk = (n: LayoutNode, x: number, y: number, w: number, h: number, path: string): void => {
    if (n.kind === "leaf") {
      paneOut.push({ id: n.id, x, y, w, h });
      return;
    }
    if (n.dir === "row") {
      const aw = w * n.ratio;
      walk(n.a, x, y, aw, h, `${path}a`);
      walk(n.b, x + aw, y, w - aw, h, `${path}b`);
      splitOut.push({ path, dir: "row", x: x + aw, y, w: 0, h });
    } else {
      const ah = h * n.ratio;
      walk(n.a, x, y, w, ah, `${path}a`);
      walk(n.b, x, y + ah, w, h - ah, `${path}b`);
      splitOut.push({ path, dir: "col", x, y: y + ah, w, h: 0 });
    }
  };

  walk(node, 0, 0, 1, 1, "");
  return { panes: paneOut, splitters: splitOut };
}
