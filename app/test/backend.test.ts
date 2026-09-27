/**
 * The single backend address, and the health probe that reports on it.
 *
 * WHAT IS WORTH PINNING HERE
 * `backend.ts` replaced eleven hardcoded literals with one resolved address, so
 * the failures worth testing are the ones that would silently point the
 * terminal somewhere wrong: a base that survives a bad stored value, an
 * override that falls back rather than blanking, and `ws://` derived from
 * `http://` rather than configured beside it.
 *
 * For `gateway.ts` it is the four outcomes. "Not running", "running but a
 * dependency is missing" and "something else owns this port" need three
 * different actions from a human, and a probe that collapses them into
 * `ok: false` is how a missing `pip install` gets diagnosed as a firewall
 * problem.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_KEY,
  DEFAULT_BACKEND,
  backendConfig,
  configureBackend,
  gatewayBase,
  gatewayWsBase,
  isConsolidated,
  isValidBase,
  normalise,
  proxyBase,
  quantBase,
  resetBackend,
  serviceBase,
} from "../src/data/backend";
import { healthLabel, healthTone, probeGateway, UNREACHABLE } from "../src/data/gateway";
import { memoryRawStore } from "../src/store/kv";
import { useBackendStore } from "../src/data/backend";

/** A store that behaves, replaced per test so persistence is observable. */
let store = memoryRawStore();

beforeEach(() => {
  store = memoryRawStore();
  useBackendStore(store);
  resetBackend(false);
});

describe("backend address", () => {
  it("defaults every service to the one gateway", () => {
    expect(gatewayBase()).toBe(DEFAULT_BACKEND);
    expect(proxyBase()).toBe(DEFAULT_BACKEND);
    expect(serviceBase()).toBe(DEFAULT_BACKEND);
    expect(quantBase()).toBe(DEFAULT_BACKEND);
    expect(isConsolidated()).toBe(true);
  });

  it("moves every service when the base moves", () => {
    configureBackend({ base: "http://10.0.0.5:9000" }, false);
    expect(proxyBase()).toBe("http://10.0.0.5:9000");
    expect(serviceBase()).toBe("http://10.0.0.5:9000");
    expect(quantBase()).toBe("http://10.0.0.5:9000");
  });

  it("supports the split three-process setup that predates the gateway", () => {
    configureBackend(
      {
        base: "http://127.0.0.1:8787",
        service: "http://127.0.0.1:8788",
        quant: "http://127.0.0.1:8789",
      },
      false,
    );
    expect(proxyBase()).toBe("http://127.0.0.1:8787");
    expect(serviceBase()).toBe("http://127.0.0.1:8788");
    expect(quantBase()).toBe("http://127.0.0.1:8789");
    expect(isConsolidated()).toBe(false);
  });

  it("clears an override back to the base rather than to nothing", () => {
    configureBackend({ service: "http://127.0.0.1:8788" }, false);
    expect(serviceBase()).toBe("http://127.0.0.1:8788");
    configureBackend({ service: "" }, false);
    expect(serviceBase()).toBe(gatewayBase());
  });

  it("falls back to the shipped default when the base is cleared", () => {
    configureBackend({ base: "http://example.test:1" }, false);
    configureBackend({ base: "" }, false);
    expect(gatewayBase()).toBe(DEFAULT_BACKEND);
  });

  it("refuses a base that would be executed rather than fetched", () => {
    for (const hostile of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "nonsense"]) {
      expect(isValidBase(hostile)).toBe(false);
    }
    configureBackend({ base: "javascript:alert(1)" }, false);
    // The previous value stands. A terminal that accepted this would have
    // quietly stopped being able to reach anything.
    expect(gatewayBase()).toBe(DEFAULT_BACKEND);
  });

  it("strips trailing slashes so callers can join with a leading slash", () => {
    expect(normalise("http://x.test:1///")).toBe("http://x.test:1");
    configureBackend({ base: "http://x.test:1/" }, false);
    expect(gatewayBase()).toBe("http://x.test:1");
  });

  it("derives the websocket origin instead of keeping a second address", () => {
    configureBackend({ base: "http://127.0.0.1:8787" }, false);
    expect(gatewayWsBase()).toBe("ws://127.0.0.1:8787");
    // https must become wss, or the socket is a mixed-content block that reads
    // in the console as simply failing to connect.
    configureBackend({ base: "https://desk.example:443" }, false);
    expect(gatewayWsBase()).toBe("wss://desk.example:443");
  });

  it("persists across a reload, and survives a corrupt stored value", () => {
    configureBackend({ base: "http://10.1.1.1:9" }, true);
    expect(JSON.parse(store.getItem(BACKEND_KEY) ?? "{}").base).toBe("http://10.1.1.1:9");
    // A fresh session reading that store comes back to the same address.
    expect(useBackendStore(store).base).toBe("http://10.1.1.1:9");
  });

  it("stands on the defaults when the stored value is corrupt", () => {
    // The key is editable from any console, and a terminal that threw here
    // would fail during module initialisation, before anything could catch it.
    store.setItem(BACKEND_KEY, "{{not json");
    expect(useBackendStore(store).base).toBe(DEFAULT_BACKEND);

    store.setItem(BACKEND_KEY, JSON.stringify({ base: "javascript:alert(1)", quant: 42 }));
    const cfg = useBackendStore(store);
    expect(cfg.base).toBe(DEFAULT_BACKEND);
    expect(cfg.quant).toBeUndefined();
  });
});

describe("gateway health", () => {
  const respond = (body: unknown) =>
    vi.fn(async () => ({ json: async () => body })) as unknown as typeof fetch;

  const threeUp = {
    ok: true,
    version: "51.0.0",
    services: {
      data: { ok: true, error: null, provides: "market data proxy" },
      svc: { ok: true, error: null, provides: "alerts, journal, sync" },
      quant: { ok: true, error: null, provides: "GARCH, causal inference" },
    },
    background: { enabled: true },
  };

  it("reports ok when all three services loaded", async () => {
    const health = await probeGateway("http://b.test", respond(threeUp));
    expect(health.state).toBe("ok");
    expect(health.version).toBe("51.0.0");
    expect(health.background).toBe(true);
    expect(health.advice).toBe("");
    expect(healthTone(health)).toBe("good");
    expect(healthLabel(health)).toBe("BACKEND · LOOPS ON");
  });

  it("distinguishes a missing dependency from a missing backend", async () => {
    const health = await probeGateway(
      "http://b.test",
      respond({
        ...threeUp,
        ok: false,
        services: {
          ...threeUp.services,
          quant: { ok: false, error: "ImportError: scipy", provides: "GARCH, causal inference" },
        },
      }),
    );
    expect(health.state).toBe("degraded");
    // The cost is named before the remedy, and the remedy is a command.
    expect(health.advice).toContain("GARCH");
    expect(health.advice).toContain("pip install");
    expect(healthTone(health)).toBe("warn");
  });

  it("treats a thrown fetch as unreachable, not as an error to surface", async () => {
    const dead = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const health = await probeGateway("http://b.test", dead);
    expect(health.state).toBe("unreachable");
    expect(health.base).toBe("http://b.test");
    // Deliberately not an error tone: no backend is a supported way to run
    // this terminal, and a permanently red light is a light nobody reads.
    expect(healthTone(health)).toBe("mute");
    expect(health.advice).toContain("python run.py");
    // `python -m gateway` alone leaves IRAM_BACKGROUND unset: eleven loops off.
    expect(health.advice).not.toContain("-m gateway");
  });

  it("notices when something else owns the port", async () => {
    const health = await probeGateway("http://b.test", respond({ hello: "some other app" }));
    expect(health.state).toBe("foreign");
    expect(health.advice).toContain("not the IRAM gateway");
    expect(healthLabel(health)).toBe("PORT TAKEN");
  });

  it("never rejects, whatever the backend does", async () => {
    const nonsense = vi.fn(async () => ({
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })) as unknown as typeof fetch;
    await expect(probeGateway("http://b.test", nonsense)).resolves.toMatchObject({
      state: "unreachable",
    });
  });

  it("exposes a usable default for callers that have not probed yet", () => {
    expect(UNREACHABLE.state).toBe("unreachable");
    expect(UNREACHABLE.services).toEqual([]);
  });
});
