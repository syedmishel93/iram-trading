/**
 * THE MCP CARD — connecting this terminal to TradingView and other platforms.
 *
 * `svc/mcp.py` and `svc/mcpauth.py` were built and verified against live servers,
 * and had twelve routes with no caller anywhere here. That is this project's own
 * rule turned inward: a capability nobody can see is a capability nobody has, and
 * `scratchpad/routes.py` measures it — a metric that had been driven to zero and
 * that I reopened by building the engine without its screen.
 *
 * WHY IT SITS BESIDE THE CONNECTIONS CARD
 *
 * That card answers "is everything this terminal needs reachable". This one
 * answers "what else have I connected it to", which is the same question one step
 * out, and `ui/system.ts` already owns that desk. A new desk for two routes would
 * be the "capability filed under the wrong heading" mistake.
 *
 * THREE STATES, NEVER TWO
 *
 * `connected`, `needs sign-in`, `refused`. A server waiting for a sign-in is NOT
 * broken, and colouring it with the failures buries the ones that are — the same
 * distinction the job list draws for "waiting for a key only you can supply".
 * `stateOf` in `data/mcp.ts` is the one owner of that judgement, because this
 * card and the row detail both ask.
 *
 * THE OPERATOR OPENS THE SIGN-IN, NOT THIS CARD
 *
 * Connect asks the server to prepare an authorization URL and then shows it as a
 * link. Opening a consent screen unprompted would be deciding, on somebody's
 * behalf, to grant an external service access to their account. The scopes being
 * requested — and the ones deliberately WITHHELD — are named next to it, because
 * a grant whose shape nobody can see is a grant nobody checked.
 *
 * `each()` RENDERS THE LIST. A hand-rolled fragment loses every row when one
 * render throws, silently, because the fragment is appended once at the end —
 * that cost this project five markets rendered as none, with `window.__signalErrors`
 * the only place the reason existed.
 */

import { each, h } from "../dom";
import { computed, signal } from "../../core/signal";
import { pkFold, pkWhy } from "../panelkit";
import {
  addServer,
  argHint,
  callTool,
  connectServer,
  embeddedJson,
  listServers,
  listTools,
  probeServer,
  removeServer,
  signInStatus,
  signOut,
  stateOf,
  type McpCallResult,
  type McpHandshake,
  type McpRefusal,
  type McpServer,
  type McpSignIn,
  type McpTool,
} from "../../data/mcp";

/** Servers worth offering, so the first use is not a blank field. */
const SUGGESTED: readonly { readonly name: string; readonly url: string; readonly note: string }[] = [
  {
    name: "Crypto.com",
    url: "https://mcp.crypto.com/market-data/mcp",
    note: "Needs no account. Candles, tickers, order book, index and mark price.",
  },
  {
    name: "TradingView",
    url: "https://mcp.tradingview.com/mcp",
    note: "Needs a paid TradingView plan. Screeners, fundamentals, watchlists, alerts.",
  },
  {
    name: "LunarCrush",
    url: "https://lunarcrush.ai/mcp",
    note: "Needs an account. Social and sentiment data nothing else here provides.",
  },
];

type Probe = McpHandshake | McpRefusal | null;

export function createMcpCard(): { readonly el: HTMLElement; refresh(): void } {
  const servers = signal<readonly McpServer[]>([]);
  const signIns = signal<readonly McpSignIn[]>([]);
  const probes = signal<Readonly<Record<string, Probe>>>({});
  const tools = signal<Readonly<Record<string, readonly McpTool[]>>>({});
  const note = signal<string>("");
  const busy = signal<string>("");
  const redirect = signal<string>("");

  /** The open sign-in link, if a Connect has been pressed. */
  const authLink = signal<{ readonly url: string; readonly scopes: readonly string[]; readonly withheld: readonly string[] } | null>(null);

  const draftName = signal<string>("");
  const draftUrl = signal<string>("");

  /** A tool run, kept per server so switching rows does not lose it. */
  const ran = signal<{ readonly url: string; readonly tool: string; readonly result: McpCallResult | McpRefusal } | null>(null);

  const signedInFor = (url: string): boolean =>
    signIns().some((s) => s.url === url && s.signedIn);

  async function refresh(): Promise<void> {
    const [list, status] = await Promise.all([listServers(), signInStatus()]);
    if (list.ok === false) {
      note.set(list.why);
      return;
    }
    servers.set(list.servers);
    if (status.ok !== false) {
      signIns.set(status.servers);
      redirect.set(status.redirect);
    }
    // Probe each in turn rather than at once: a handshake is three round trips
    // and TradingView throttles at 100 requests a minute per user.
    for (const s of list.servers) {
      const got = await probeServer(s.url);
      probes.set({ ...probes(), [s.url]: got });
    }
  }

  async function add(name: string, url: string): Promise<void> {
    if (!url.trim()) {
      note.set("An MCP address is needed — the suggestions below fill it in.");
      return;
    }
    busy.set("adding");
    const got = await addServer(name.trim() || new URL(url).host, url.trim());
    busy.set("");
    if (got.ok === false) {
      note.set(got.why);
      return;
    }
    note.set("");
    draftName.set("");
    draftUrl.set("");
    await refresh();
  }

  async function connect(url: string): Promise<void> {
    busy.set(url);
    const probe = probes()[url] ?? null;
    const hint = probe && probe.ok === false ? probe.resourceMetadata ?? null : null;
    const got = await connectServer(url, hint);
    busy.set("");
    if (got.ok === false) {
      note.set(got.why);
      authLink.set(null);
      return;
    }
    note.set("");
    authLink.set({ url: got.authorize, scopes: got.scopes, withheld: got.withheld });
  }

  async function openTools(url: string): Promise<void> {
    busy.set(url);
    const got = await listTools(url);
    busy.set("");
    if (got.ok === false) {
      note.set(got.why);
      return;
    }
    tools.set({ ...tools(), [url]: got.tools });
  }

  async function run(url: string, tool: McpTool, raw: string): Promise<void> {
    let args: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          note.set("The arguments have to be a JSON object, like {\"instrument_name\": \"BTC_USD\"}.");
          return;
        }
        args = parsed as Record<string, unknown>;
      } catch {
        note.set("That is not valid JSON, so it was not sent.");
        return;
      }
    }
    note.set("");
    busy.set(url + tool.name);
    const got = await callTool(url, tool.name, args);
    busy.set("");
    ran.set({ url, tool: tool.name, result: got });
  }

  /* ------------------------------------------------------------- rendering */

  /**
   * ONE ROW, BUILT ONCE AND BOUND REACTIVELY.
   *
   * `each()` reuses the node for an unchanged key and never calls `render` again
   * — MEASURED: the row sat on "checking / not checked yet" for ever while the
   * handshake had long since answered, because every value was read once at
   * construction. `h()` takes a FUNCTION for text, for an attribute and as a
   * child, and binds it; that is the idiom `data/connections.ts` already uses and
   * the reason its rows track their services.
   *
   * Rebuilding the row on a state change would have been the other fix and is
   * the wrong one: it throws away the typed arguments and any expanded tool list
   * every time a probe lands. Hide and rebind, never unmount.
   */
  const row = (s: McpServer): HTMLElement => {
    const probe = (): Probe => probes()[s.url] ?? null;
    const view = () => stateOf(probe(), signedInFor(s.url));
    const sign = () => signIns().find((x) => x.url === s.url);
    const shown = () => tools()[s.url];

    const argsField = h("input", {
      class: "mcp-args field-input",
      placeholder: '{"instrument_name": "BTC_USD", "timeframe": "1h"}',
      spellcheck: "false",
    }) as HTMLInputElement;

    const toolList = (): HTMLElement => {
      const list = shown();
      if (!list || list.length === 0) return h("span", { class: "mcp-gap" }) as HTMLElement;
      return h(
        "div",
        { class: "mcp-tools" },
        ...list.map((t) =>
          h(
            "div",
            { class: "mcp-tool" },
            h("span", { class: "mcp-tool-name", text: t.title || t.name }),
            h("span", { class: "mcp-tool-args", text: argHint(t) }),
            h("button", {
              class: "tool-btn mcp-run",
              text: () => (busy() === s.url + t.name ? "Running…" : "Run"),
              onclick: () => void run(s.url, t, argsField.value),
            }),
            t.description
              ? h("p", { class: "mcp-tool-why", text: t.description })
              : h("span", { class: "mcp-gap" }),
          ),
        ),
        argsField,
      ) as HTMLElement;
    };

    const resultBlock = (): HTMLElement => {
      const out = ran();
      if (!out || out.url !== s.url) return h("span", { class: "mcp-gap" }) as HTMLElement;
      if (out.result.ok === false) {
        return h("p", { class: "mcp-result-why", text: out.result.why }) as HTMLElement;
      }
      const parsed = embeddedJson(out.result.text);
      return h(
        "div",
        { class: "mcp-result-wrap" },
        h("p", { class: "mcp-result-head", text: `${out.tool} answered` }),
        // The tool's OWN WORDS first: it answers a language model, so the prose is
        // what it actually said and the JSON is an artefact inside it.
        h("pre", {
          class: "mcp-result",
          text: parsed
            ? `${parsed.prose}

${JSON.stringify(parsed.data, null, 2).slice(0, 4000)}`
            : out.result.text.slice(0, 4000),
        }),
        parsed
          ? h("span", { class: "mcp-gap" })
          : h("p", {
              class: "mcp-tool-why",
              text: "No JSON in that answer, so it is shown exactly as sent — the tool's own wording, not a format this terminal can rely on.",
            }),
      ) as HTMLElement;
    };

    const actions = (): HTMLElement =>
      h(
        "div",
        { class: "mcp-acts" },
        view().state === "needs-sign-in"
          ? h("button", {
              class: "tool-btn",
              text: () => (busy() === s.url ? "Preparing…" : "Sign in"),
              onclick: () => void connect(s.url),
            })
          : h("button", {
              class: "tool-btn",
              text: () => {
                const list = shown();
                if (list) return `${list.length} tools`;
                return busy() === s.url ? "Asking…" : "See tools";
              },
              onclick: () => void openTools(s.url),
            }),
        sign()?.signedIn
          ? h("button", {
              class: "tool-btn",
              text: "Sign out",
              onclick: () => {
                void signOut(s.url).then(() => refresh());
              },
            })
          : h("span", { class: "mcp-gap" }),
        h("button", {
          class: "tool-btn",
          text: "Remove",
          onclick: () => {
            void removeServer(s.url).then(() => refresh());
          },
        }),
      ) as HTMLElement;

    const validity = (): HTMLElement => {
      const x = sign();
      if (!x?.signedIn || x.expiresIn === null) {
        return h("span", { class: "mcp-gap" }) as HTMLElement;
      }
      return h("p", {
        class: "mcp-detail",
        text: `Sign-in valid for another ${Math.round(x.expiresIn / 60)} min${
          x.canRefresh ? ", and renews itself" : "; it does not renew"
        }.`,
      }) as HTMLElement;
    };

    return h(
      "div",
      { class: "mcp-row", "data-state": () => view().state },
      h("span", { class: "mcp-name", text: s.name }),
      h("span", { class: "mcp-state", text: () => STATE_WORD[view().state] ?? "" }),
      h("p", { class: "mcp-detail", text: () => view().detail }),
      h("p", { class: "mcp-url", text: s.url }),
      actions,
      validity,
      toolList,
      resultBlock,
    ) as HTMLElement;
  };

  const STATE_WORD: Readonly<Record<string, string>> = {
    connected: "connected",
    "needs-sign-in": "needs sign-in",
    refused: "not answering",
    unknown: "checking",
  };

  const listBox = h("div", { class: "mcp-list" }) as HTMLElement;
  each(listBox, () => servers(), (s) => s.url, row);

  const nameField = h("input", {
    class: "mcp-field field-input",
    placeholder: "A name for it",
    spellcheck: "false",
  }) as HTMLInputElement;
  const urlField = h("input", {
    class: "mcp-field field-input",
    placeholder: "https://…/mcp",
    spellcheck: "false",
  }) as HTMLInputElement;

  const suggestions = SUGGESTED.map((sg) =>
    h(
      "div",
      { class: "mcp-sug" },
      h("button", {
        class: "tool-btn",
        text: sg.name,
        onclick: () => {
          nameField.value = sg.name;
          urlField.value = sg.url;
          draftName.set(sg.name);
          draftUrl.set(sg.url);
        },
      }),
      h("span", { class: "mcp-sug-note", text: sg.note }),
    ),
  );

  const el = h(
    "section",
    { class: "dd-panel mcp" },
    h("h3", { class: "pf-sub", text: "Other platforms this terminal can reach" }),
    h("p", {
      class: "mcp-lede",
      text: "Connect an MCP server and its tools become callable from here.",
    }),
    pkWhy(
      "What this is",
      "MCP servers publish tools — candles, screeners, fundamentals, sentiment — over one protocol. Adding one is a row on this list rather than a new release. Data that arrives this way is shown as the tool sent it and is never written into the bar archive: the candle tools return a short tail with no date range, which cannot support a backtest.",
    ),
    listBox,
    computed(() =>
      servers().length === 0
        ? h("p", {
            class: "mcp-empty",
            text: "Nothing connected yet. Crypto.com below needs no account and is the quickest way to see this working.",
          })
        : h("span", { class: "mcp-gap" }),
    ),
    computed(() => {
      const link = authLink();
      if (!link) return h("span", { class: "mcp-gap" });
      return h(
        "div",
        { class: "mcp-auth" },
        h("p", {
          class: "mcp-auth-head",
          text: "Open this to sign in. It goes to the service's own page — your password never reaches this terminal.",
        }),
        h("a", {
          class: "mcp-auth-link",
          href: link.url,
          target: "_blank",
          rel: "noopener noreferrer",
          text: "Sign in at " + new URL(link.url).host,
        }),
        h("p", {
          class: "mcp-detail",
          text: `Asking for: ${link.scopes.join(", ") || "no particular permission"}.${
            link.withheld.length > 0
              ? ` Deliberately not asking for: ${link.withheld.join(", ")}.`
              : ""
          }`,
        }),
        h("p", {
          class: "mcp-detail",
          text: "Come back here afterwards and press See tools.",
        }),
      );
    }),
    computed(() =>
      note()
        ? h("p", { class: "mcp-note", text: note() })
        : h("span", { class: "mcp-gap" }),
    ),
    pkFold(
      "Add a server",
      h(
        "div",
        { class: "mcp-add" },
        nameField,
        urlField,
        h("button", {
          class: "tool-btn",
          text: "Add",
          onclick: () => void add(nameField.value, urlField.value),
        }),
        h("div", { class: "mcp-sugs" }, ...suggestions),
        computed(() =>
          redirect()
            ? h("p", {
                class: "mcp-detail",
                text: `Sign-ins come back to ${redirect()}, which is this terminal. Nothing is sent anywhere else.`,
              })
            : h("span", { class: "mcp-gap" }),
        ),
      ),
    ),
  ) as HTMLElement;

  return { el, refresh: () => void refresh() };
}
