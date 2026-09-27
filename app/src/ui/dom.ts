/**
 * Typed hyperscript with signal binding.
 *
 * Any prop or child may be a function; if it is, it becomes a render effect
 * bound to that one node. So a ticking price rewrites one text node and touches
 * nothing else in the tree.
 */

import { renderEffect } from "../core/signal";

type Primitive = string | number | boolean | null | undefined;
export type Child = Primitive | Node | (() => Primitive | Node) | Child[];

type Props<K extends keyof HTMLElementTagNameMap> = {
  class?: string | (() => string);
  style?: Partial<CSSStyleDeclaration> | (() => string) | string;
  text?: Primitive | (() => Primitive);
  html?: string;
  ref?: (el: HTMLElementTagNameMap[K]) => void;
} & {
  [P in `on${string}`]?: EventListenerOrEventListenerObject;
} & {
  [P in `data-${string}` | `aria-${string}`]?: Primitive | (() => Primitive);
} & {
  [P: string]: unknown;
};

/** Controls whose `value` / `checked` are PROPERTIES, not attributes. */
const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * MEASURED BUG, and it was silent.
 *
 * `setAttribute("value", …)` on an `<input>` sets the *default* value — the
 * thing a form reset returns to. The moment the control becomes "dirty" (the
 * user types, or anything assigns `.value`), the browser stops mirroring the
 * attribute onto the displayed value. So every reactive `value: () => …`
 * binding in this application kept firing, kept writing the attribute, and
 * changed nothing on screen from the first keystroke onwards.
 *
 * Found by making the Risk desk and the Calculator share one account: editing
 * equity in the Calculator correctly updated the store AND the mirrored config
 * slot, and the Risk desk's input went on showing the previous number. The
 * state was right and the screen was wrong, which is the worst version of this
 * for a terminal that sizes trades off what it shows.
 *
 * The `!==` guard matters as much as the fix. Writing `.value` unconditionally
 * on every tick would reset the caret to the end mid-word; because a typed
 * character round-trips through the signal and comes back as the same string,
 * the guard makes that write a no-op and the caret stays put.
 */
function setFormValue(el: Element, name: string, value: Primitive): boolean {
  if (!FORM_TAGS.has(el.tagName)) return false;

  if (name === "value") {
    const next = value === null || value === undefined || value === false ? "" : String(value);
    const control = el as HTMLInputElement;
    if (control.value !== next) control.value = next;
    return true;
  }

  if (name === "checked" && el.tagName === "INPUT") {
    const control = el as HTMLInputElement;
    const next = value === true || value === "true";
    if (control.checked !== next) control.checked = next;
    return true;
  }

  return false;
}

function setAttr(el: Element, name: string, value: Primitive): void {
  if (setFormValue(el, name, value)) return;
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else if (value === true) el.setAttribute(name, "");
  else el.setAttribute(name, String(value));
}

function appendChild(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false || child === true) return;

  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }

  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }

  if (typeof child === "function") {
    // A reactive slot. Text results update a single text node in place; node
    // results replace the previous subtree between two comment anchors.
    const start = document.createComment("");
    const end = document.createComment("");
    parent.appendChild(start);
    parent.appendChild(end);

    let textNode: Text | null = null;
    renderEffect(() => {
      const value = child();

      if (value instanceof Node) {
        while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
        end.parentNode?.insertBefore(value, end);
        textNode = null;
        return;
      }

      const str = value === null || value === undefined || value === false ? "" : String(value);
      if (textNode) {
        // The common case: only the character data changes. No node churn, so
        // the browser does not re-layout siblings on every tick.
        if (textNode.data !== str) textNode.data = str;
        return;
      }
      while (start.nextSibling && start.nextSibling !== end) start.nextSibling.remove();
      textNode = document.createTextNode(str);
      end.parentNode?.insertBefore(textNode, end);
    });
    return;
  }

  parent.appendChild(document.createTextNode(String(child)));
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props<K> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  if (props) {
    for (const [key, raw] of Object.entries(props)) {
      if (raw === undefined) continue;

      if (key === "ref") {
        (raw as (e: HTMLElementTagNameMap[K]) => void)(el);
        continue;
      }

      if (key === "text") {
        if (typeof raw === "function") {
          const fn = raw as () => Primitive;
          const node = document.createTextNode("");
          el.appendChild(node);
          renderEffect(() => {
            const str = String(fn() ?? "");
            if (node.data !== str) node.data = str;
          });
        } else {
          el.textContent = String(raw ?? "");
        }
        continue;
      }

      if (key === "html") {
        el.innerHTML = String(raw);
        continue;
      }

      if (key === "style") {
        if (typeof raw === "function") {
          renderEffect(() => el.setAttribute("style", (raw as () => string)()));
        } else if (typeof raw === "string") {
          el.setAttribute("style", raw);
        } else {
          Object.assign(el.style, raw as Partial<CSSStyleDeclaration>);
        }
        continue;
      }

      if (key.startsWith("on") && typeof raw === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), raw as EventListener);
        continue;
      }

      const attr = key === "className" ? "class" : key;
      if (typeof raw === "function") {
        const fn = raw as () => Primitive;
        renderEffect(() => setAttr(el, attr, fn()));
      } else {
        setAttr(el, attr, raw as Primitive);
      }
    }
  }

  for (const child of children) appendChild(el, child);
  return el;
}

/** Render `list` into `parent`, keyed so unchanged rows keep their DOM nodes. */
export function each<T>(
  parent: HTMLElement,
  list: () => readonly T[],
  key: (item: T, index: number) => string,
  render: (item: T) => HTMLElement,
): void {
  let mounted = new Map<string, HTMLElement>();

  renderEffect(() => {
    const items = list();
    const next = new Map<string, HTMLElement>();
    const frag = document.createDocumentFragment();

    items.forEach((item, i) => {
      const k = key(item, i);
      const existing = mounted.get(k);
      const node = existing ?? render(item);
      next.set(k, node);
      frag.appendChild(node);
    });

    for (const [k, node] of mounted) if (!next.has(k)) node.remove();
    parent.appendChild(frag); // moves existing nodes into new order
    mounted = next;
  });
}

/** Clear a node's children. */
export function clear(el: Node): void {
  while (el.firstChild) el.firstChild.remove();
}
