/**
 * The agent desk.
 *
 * The layout is the argument. A chat bubble sits alone in most products; here
 * every answer is preceded by the tool calls that produced it, rendered as
 * collapsed monospace rows you can expand into the raw JSON. That ordering is
 * the point: you read the evidence, then the conclusion, and if there is no
 * evidence row the conclusion is visibly about nothing.
 *
 * The provider selector is in the header rather than buried in settings,
 * because WHERE THE CONVERSATION GOES is not a preference — it is the first
 * thing a person needs to know before typing their position size into a text
 * box. The privacy line for the selected provider is always on screen.
 */

import { h, clear } from "./dom";
import { renderEffect, effect, type Signal } from "../core/signal";
import type { AgentSession, TranscriptEntry } from "../agent/session";
import type { Provider } from "../agent/provider";

import type { Brief } from "../agent/brief";

export interface AgentDeskOptions {
  readonly session: AgentSession;
  readonly providers: readonly Provider[];
  readonly providerId: Signal<string>;
  /** Opens the provider configuration form. */
  onConfigure(): void;
  /** Suggested opening questions, tailored to what is on screen. */
  suggestions(): readonly string[];
  /**
   * Empty when the selected backend is in use; otherwise the reason the
   * terminal has fallen back to answering from its own data.
   */
  fallbackNote(): string;

  /**
   * Standing briefs, or null when the host does not provide them.
   *
   * Nullable so the desk stays constructible in tests and in any surface that
   * has no watcher behind it — a brief panel with nothing driving it would
   * render arm buttons that silently do nothing.
   */
  readonly briefs?: BriefPanel;
}

/** What the desk needs to render and drive the standing briefs. */
export interface BriefPanel {
  readonly list: () => readonly Brief[];
  /** Empty when the current provider can watch; otherwise why it cannot. */
  readonly blocked: () => string;
  add(text: string): void;
  arm(id: string): void;
  disarm(id: string): void;
  remove(id: string): void;
}

export interface AgentDesk {
  readonly el: HTMLElement;
  focus(): void;
}

/**
 * The expert's standing questions.
 *
 * Fixed rather than generated, and always on screen rather than only on an
 * empty transcript: these are the five things the desk is FOR, and a prompt
 * that disappears after the first question is one nobody finds again. The last
 * one is a template, not a question — it pre-fills the input for the operator
 * to finish, because the idea being stress-tested is theirs and the analyst
 * must not guess its prices.
 */
export const EXPERT_PROMPTS: readonly { readonly text: string; readonly prefill?: boolean }[] = [
  { text: "What should I do now?" },
  { text: "Brief me on this market" },
  { text: "Build and test a strategy here" },
  { text: "Find the best setups" },
  { text: "Stress-test my idea: long at , stop , target ", prefill: true },
];

/**
 * Minimal inline markdown: **bold**, `code`, and - bullets.
 *
 * Built from text nodes, never innerHTML. The text here comes from a language
 * model and, through tool results, from a market venue — neither is a source
 * you hand to an HTML parser.
 */
function renderRich(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    if (i > 0) frag.appendChild(document.createTextNode("\n"));

    const bullet = /^\s*[-*]\s+/.exec(line);
    let body = line;
    if (bullet) {
      frag.appendChild(document.createTextNode("• "));
      body = line.slice(bullet[0].length);
    }

    /* One pass, alternating between plain runs and the two inline styles. */
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|_([^_]+)_/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(body.slice(last, m.index)));
      if (m[1] !== undefined) frag.appendChild(h("strong", { text: m[1] }));
      else if (m[2] !== undefined) frag.appendChild(h("code", { text: m[2] }));
      else if (m[3] !== undefined) frag.appendChild(h("em", { text: m[3] }));
      last = m.index + m[0].length;
    }
    if (last < body.length) frag.appendChild(document.createTextNode(body.slice(last)));
  });

  return frag;
}

function renderToolRow(entry: Extract<TranscriptEntry, { kind: "tool" }>): HTMLElement {
  const body = h(
    "div",
    { class: "agent-tool-body" },
    h("pre", {
      class: "agent-tool-json",
      text: JSON.stringify(
        { arguments: entry.args, result: entry.result },
        null,
        2,
      ),
    }),
  );

  const wrap = h(
    "div",
    {
      class: "agent-tool",
      "data-ok": String(entry.result.ok),
      "data-mutates": String(entry.mutates),
      "data-open": "false",
    },
    h(
      "button",
      {
        class: "agent-tool-head",
        type: "button",
        onclick: () => {
          const open = wrap.getAttribute("data-open") === "true";
          wrap.setAttribute("data-open", String(!open));
        },
      },
      h("span", { class: "agent-tool-caret", text: "›" }),
      h("span", { class: "agent-tool-name", text: entry.name }),
      h("span", { class: "agent-tool-arrow", text: "→" }),
      h("span", {
        class: "agent-tool-sum",
        text: entry.result.ok
          ? (entry.result.summary ?? "ok")
          : (entry.result.error ?? "failed"),
      }),
    ),
    body,
  );
  return wrap;
}

/**
 * The standing-brief panel.
 *
 * Two things are rendered that a feature like this usually hides, and both are
 * deliberate. The CHECK COUNT, because every check is a paid request made
 * while nobody is watching and a cost the operator cannot see is one they
 * cannot decide about. And the LAST ANSWER even when nothing fired, because a
 * brief that has been quiet for a day is either working or broken, and those
 * look identical without it.
 */
function renderBriefs(panel: BriefPanel): HTMLElement {
  const input = h("input", {
    class: "brief-input",
    type: "text",
    placeholder: "Watch for… e.g. the 4h sweep completing",
    "aria-label": "What to watch for",
  }) as HTMLInputElement;

  const submit = (): void => {
    const text = input.value.trim();
    if (text.length < 4) return;
    panel.add(text);
    input.value = "";
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });

  const list = h("div", { class: "brief-list" });
  const ago = (t: number | null): string => {
    if (t === null) return "not yet checked";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `checked ${s}s ago`;
    if (s < 3600) return `checked ${Math.round(s / 60)}m ago`;
    return `checked ${Math.round(s / 3600)}h ago`;
  };

  renderEffect(() => {
    const rows = panel.list();
    const blocked = panel.blocked();
    clear(list);

    if (blocked) {
      /* Named, not silent. A watcher that will not start is far better than
         one that appears to be watching and never fires. */
      list.appendChild(h("p", { class: "brief-blocked", text: blocked }));
    }

    if (rows.length === 0) {
      list.appendChild(
        h("p", {
          class: "brief-empty",
          text: "Nothing is being watched. A brief is checked once per closed bar, at most once every five minutes, and only while it is armed.",
        }),
      );
      return;
    }

    for (const b of rows) {
      list.appendChild(
        h(
          "div",
          { class: "brief", "data-state": b.state },
          h(
            "div",
            { class: "brief-top" },
            h("span", { class: "brief-text", text: b.text }),
            h("span", { class: "brief-where", text: `${b.symbol} ${b.timeframe}` }),
          ),
          h(
            "div",
            { class: "brief-meta" },
            h("span", { class: "brief-state", text: b.state }),
            /* The cost, always. */
            h("span", {
              class: "brief-checks",
              text: `${b.checks} check${b.checks === 1 ? "" : "s"}`,
              title: "Each check is one request to your configured model endpoint.",
            }),
            h("span", { class: "brief-when", text: ago(b.checkedAt) }),
          ),
          /* What it last said, fired or not. */
          ...(b.lastAnswer
            ? [h("p", { class: "brief-answer", text: b.lastAnswer })]
            : []),
          h(
            "div",
            { class: "brief-actions" },
            h("button", {
              class: "ghost-btn tiny",
              type: "button",
              text: b.state === "armed" ? "Disarm" : "Arm",
              disabled: blocked && b.state !== "armed" ? "" : null,
              title: blocked || "Start or stop checking this brief",
              onclick: () => (b.state === "armed" ? panel.disarm(b.id) : panel.arm(b.id)),
            }),
            h("button", {
              class: "ghost-btn tiny",
              type: "button",
              text: "Remove",
              onclick: () => panel.remove(b.id),
            }),
          ),
        ),
      );
    }
  });

  return h(
    "div",
    { class: "briefs" },
    h(
      "div",
      { class: "brief-head" },
      h("span", { class: "label", text: "Watching for" }),
      h("span", {
        class: "brief-note",
        text: "checked on bar close · armed by hand · fires once",
      }),
    ),
    h("div", { class: "brief-add" }, input, h("button", {
      class: "ghost-btn tiny",
      type: "button",
      text: "Add",
      onclick: submit,
    })),
    list,
  ) as HTMLElement;
}

export function createAgentDesk(opts: AgentDeskOptions): AgentDesk {
  const log = h("div", { class: "agent-log" });

  const input = h("textarea", {
    class: "agent-input",
    rows: "1",
    placeholder: "Ask about what is on screen…",
    "aria-label": "Ask the analyst",
  }) as HTMLTextAreaElement;

  const provider = (): Provider =>
    opts.providers.find((p) => p.id === opts.providerId()) ??
    (opts.providers[0] as Provider);

  /** Who is actually answering — the fallback, when there is one, says so. */
  const answering = (): string =>
    opts.fallbackNote() !== "" ? "the offline analyst (no language model)" : provider().label;

  const quick = h(
    "div",
    { class: "agent-quick", role: "group", "aria-label": "Ask the expert" },
    ...EXPERT_PROMPTS.map((q) =>
      h("button", {
        class: "agent-chip",
        type: "button",
        text: q.prefill ? "Stress-test my idea" : q.text,
        title: q.prefill ? "Fills in the question for you to complete with your own prices" : q.text,
        disabled: () => opts.session.busy(),
        onclick: () => {
          if (q.prefill) {
            input.value = q.text;
            input.focus();
            /* Caret after "long at " — the first blank to fill. */
            const at = q.text.indexOf(", stop");
            input.setSelectionRange(at, at);
            return;
          }
          void opts.session.ask(q.text);
        },
      }),
    ),
  );

  const intro = (): HTMLElement =>
    h(
      "div",
      { class: "agent-intro" },
      renderRich(
        "I answer only from the terminal's own data. Every claim below an answer has a **tool row** above it showing exactly what was fetched — if there is no row, there is no evidence.\n\nI can size a plan and test a rule set, but I cannot place or manage a trade — no order tool exists in this build. Methodology I explain from general knowledge; every market figure comes from a tool.",
      ),
      h(
        "div",
        { class: "agent-chips" },
        ...opts.suggestions().map((q) =>
          h("button", {
            class: "agent-chip",
            type: "button",
            text: q,
            onclick: () => {
              void opts.session.ask(q);
            },
          }),
        ),
      ),
    );

  /**
   * Paint the transcript.
   *
   * Rebuilt wholesale on change rather than diffed: a conversation is tens of
   * rows, appends dominate, and a keyed reconciler here would be more code than
   * the thing it optimises. If a session ever runs to hundreds of turns this is
   * the first place to look, and it will be obvious.
   */
  renderEffect(() => {
    const entries = opts.session.transcript();
    clear(log);

    if (entries.length === 0) {
      log.appendChild(intro());
      return;
    }

    for (const entry of entries) {
      if (entry.kind === "tool") {
        log.appendChild(renderToolRow(entry));
        continue;
      }

      const bubble = h("div", { class: "agent-bubble" });
      if (entry.kind === "assistant") bubble.appendChild(renderRich(entry.text));
      else bubble.textContent = entry.text;

      log.appendChild(
        h(
          "div",
          { class: "agent-msg", "data-kind": entry.kind },
          entry.kind === "assistant"
            ? h("span", { class: "agent-by", text: entry.provider })
            : null,
          bubble,
        ),
      );
    }

    /**
     * The live turn.
     *
     * Rendered as a bubble that is visibly PROVISIONAL — dashed, muted — because
     * a streaming answer that looks identical to a finished one invites acting
     * on half a sentence. It disappears the instant the real entry lands.
     */
    log.appendChild(
      h(
        "div",
        {
          class: "agent-msg agent-live",
          "data-kind": "assistant",
          "data-on": () => String(opts.session.streaming().length > 0),
        },
        h("span", { class: "agent-by", text: "writing…" }),
        h("div", { class: "agent-bubble", text: () => opts.session.streaming() }),
      ),
    );

    log.appendChild(
      h(
        "div",
        {
          class: "agent-busy",
          /* Hidden once text is flowing: a pulsing "Working…" under a visibly
             growing answer is telling you something you can already see. */
          "data-on": () =>
            String(opts.session.busy() && opts.session.streaming().length === 0),
        },
        h("span", { class: "agent-dot" }),
        h("span", { text: "Working…" }),
      ),
    );
  });

  /**
   * Keep the newest turn in view — but only if the user was already at the
   * bottom. Yanking the view down while somebody is re-reading a tool result
   * four turns up is worse than not scrolling at all.
   */
  effect(() => {
    opts.session.transcript();
    opts.session.streaming();
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    if (nearBottom) queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
  });

  const send = (): void => {
    const text = input.value.trim();
    if (text.length === 0) return;
    input.value = "";
    input.style.height = "auto";
    void opts.session.ask(text);
  };

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    /* Enter sends; Shift+Enter is a newline. The opposite mapping is the single
       most common complaint about chat inputs. */
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  /* Grow with the content up to the CSS max-height, then scroll inside. */
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  });

  const el = h(
    "div",
    { class: "agent" },
    h(
      "div",
      { class: "agent-head" },
      h("span", { class: "label", text: "Trading expert" }),
      h("span", { style: "flex:1" }),
      h("select", {
        class: "theme-select",
        "aria-label": "Model provider",
        onchange: (e: Event) => opts.providerId.set((e.target as HTMLSelectElement).value),
        ref: (sel: HTMLSelectElement) => {
          for (const p of opts.providers) {
            sel.appendChild(h("option", { value: p.id, text: p.label }));
          }
          renderEffect(() => {
            sel.value = opts.providerId();
          });
        },
      }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        text: "Settings",
        title: "Endpoint, model and key",
        onclick: () => opts.onConfigure(),
      }),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        text: "Clear",
        onclick: () => opts.session.reset(),
      }),
    ),

    h(
      "div",
      { class: "agent-expert-line" },
      h("span", {
        text: "Reads the chart, the setup gates, the outlook and your risk, and builds and tests rule sets. It suggests; you place every trade.",
      }),
      h("span", { class: "agent-expert-who", text: () => `Answering: ${answering()}` }),
    ),

    log,

    ...(opts.briefs ? [renderBriefs(opts.briefs)] : []),

    quick,

    h(
      "div",
      { class: "agent-compose" },
      input,
      h("button", {
        class: "primary-btn",
        type: "button",
        text: () => (opts.session.busy() ? "Stop" : "Ask"),
        onclick: () => (opts.session.busy() ? opts.session.cancel() : send()),
      }),
    ),

    /* Always on screen, never behind a settings pane: where the conversation
       goes is the first thing you need to know before typing into it. */
    /* Always on screen. Where the conversation goes is the first thing you
       need to know before typing into it — and if it is going NOWHERE because
       the terminal has fallen back, that is more important still. */
    h("div", {
      class: "agent-note",
      "data-fallback": () => String(opts.fallbackNote() !== ""),
      text: () => opts.fallbackNote() || provider().privacy,
    }),
  );

  return {
    el,
    focus: () => input.focus(),
  };
}

/**
 * The provider configuration form.
 *
 * The key field is `type="password"`, which is not security — anyone can read
 * it back out of the DOM — but does stop it being read over a shoulder or
 * captured in a screen share, which is the realistic threat while somebody is
 * demonstrating a terminal.
 */
export interface ProviderConfigOptions {
  readonly baseUrl: Signal<string>;
  readonly apiKey: Signal<string>;
  readonly model: Signal<string>;
  readonly provider: () => Provider;
}

export function renderProviderConfig(opts: ProviderConfigOptions): HTMLElement {
  const field = (
    label: string,
    hint: string,
    sig: Signal<string>,
    type = "text",
    placeholder = "",
  ): HTMLElement =>
    h(
      "div",
      { class: "agent-cfg-row" },
      h("label", { class: "field-label", text: label }),
      h("input", {
        class: "field-input",
        type,
        placeholder,
        spellcheck: "false",
        autocomplete: "off",
        value: () => sig(),
        oninput: (e: Event) => sig.set((e.target as HTMLInputElement).value),
      }),
      h("div", { class: "field-hint", text: hint }),
    );

  return h(
    "div",
    { class: "agent-cfg" },
    h("div", { class: "agent-privacy", text: () => opts.provider().privacy }),
    field(
      "Endpoint",
      "Any OpenAI-compatible /v1 base. http://localhost:11434/v1 for Ollama, http://localhost:1234/v1 for LM Studio.",
      opts.baseUrl,
      "text",
      "http://localhost:11434/v1",
    ),
    field(
      "Model",
      "The model name the endpoint expects, e.g. llama3.1 or gpt-4o-mini.",
      opts.model,
      "text",
      "llama3.1",
    ),
    field(
      "API key",
      "Sent only to the endpoint above. Stored locally, and deliberately excluded from vault exports — see the Data desk.",
      opts.apiKey,
      "password",
      "leave empty for a local runtime",
    ),
    h("div", {
      class: "field-hint",
      text:
        "A local runtime needs no key and nothing leaves the machine. A hosted endpoint receives your question and the tool results — which include the symbol you are looking at.",
    }),
  );
}
