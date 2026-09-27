import { describe, it, expect } from "vitest";
import {
  classifyHost,
  readConnection,
  SLOW_MS,
  MIN_SAMPLES,
  RECENT_REJECTION_MS,
  type HostSnapshot,
} from "../src/core/connection";

const snap = (over: Partial<HostSnapshot> = {}): HostSnapshot => ({
  host: "api.binance.com",
  label: "Binance spot",
  latencyMs: 120,
  latencySamples: 10,
  bannedUntil: 0,
  banReason: "",
  softBlocked: false,
  softBlockReason: "",
  queued: 0,
  rejections: 0,
  lastRejectionAt: 0,
  ...over,
});

const NOW = 1_700_000_000_000;

describe("classifyHost", () => {
  it("reports a fast host as ok", () => {
    const r = classifyHost(snap(), NOW);
    expect(r.health).toBe("ok");
    expect(r.note).toMatch(/120ms/);
  });

  // A parked host is not slow, it is shut.
  it("ranks a ban above everything else", () => {
    const r = classifyHost(
      snap({ bannedUntil: NOW + 60_000, banReason: "418 — IP parked.", latencyMs: 5, rejections: 3 }),
      NOW,
    );
    expect(r.health).toBe("blocked");
    expect(r.note).toMatch(/60s/);
    expect(r.note).toMatch(/probing extends it/i);
  });

  it("treats an expired ban as over", () => {
    expect(classifyHost(snap({ bannedUntil: NOW - 1 }), NOW).health).toBe("ok");
  });

  it("reports a soft block with its own reason", () => {
    const r = classifyHost(
      snap({ softBlocked: true, softBlockReason: "403 with an HTML body — a challenge page." }),
      NOW,
    );
    expect(r.health).toBe("blocked");
    expect(r.note).toMatch(/challenge page/);
  });

  // A median off two samples is not a measurement.
  it("refuses to judge a host with too few samples", () => {
    const r = classifyHost(snap({ latencySamples: MIN_SAMPLES - 1 }), NOW);
    expect(r.health).toBe("unknown");
    expect(r.note).toMatch(/not enough to judge/i);
  });

  it("says plainly when a host has never been used", () => {
    expect(classifyHost(snap({ latencySamples: 0 }), NOW).note).toBe("Not used yet.");
  });

  it("reports queueing as throttled, not as slow", () => {
    const r = classifyHost(snap({ queued: 4 }), NOW);
    expect(r.health).toBe("throttled");
    expect(r.note).toMatch(/waiting on this host's budget/);
  });

  it("reports a RECENT refusal as throttled and says the rate is recovering", () => {
    const r = classifyHost(snap({ rejections: 2, lastRejectionAt: NOW - 5_000 }), NOW);
    expect(r.health).toBe("throttled");
    expect(r.note).toMatch(/Refused 5s ago/);
    expect(r.note).toMatch(/climbing back/);
  });

  // REGRESSION: `rejections` is cumulative and only ever grows. Using it alone
  // marked a host degraded for the whole session after a single 429.
  it("does not hold an old refusal against a host that is now fine", () => {
    const r = classifyHost(
      snap({ rejections: 9, lastRejectionAt: NOW - RECENT_REJECTION_MS - 1 }),
      NOW,
    );
    expect(r.health).toBe("ok");
  });

  it("marks a genuinely slow host slow", () => {
    const r = classifyHost(snap({ latencyMs: SLOW_MS + 1 }), NOW);
    expect(r.health).toBe("slow");
    expect(r.note).toMatch(/another venue will answer sooner/);
  });

  it("keeps a host just inside the threshold ok", () => {
    expect(classifyHost(snap({ latencyMs: SLOW_MS }), NOW).health).toBe("ok");
  });
});

describe("readConnection", () => {
  it("picks the fastest healthy host", () => {
    const c = readConnection(
      true,
      [
        snap({ host: "a", label: "A", latencyMs: 400 }),
        snap({ host: "b", label: "B", latencyMs: 90 }),
        snap({ host: "c", label: "C", latencyMs: 250 }),
      ],
      NOW,
    );
    expect(c.fastest?.label).toBe("B");
    expect(c.note).toMatch(/Fastest venue is B at 90ms/);
  });

  it("never picks a blocked host as fastest", () => {
    const c = readConnection(
      true,
      [
        snap({ host: "a", label: "A", latencyMs: 10, bannedUntil: NOW + 1000 }),
        snap({ host: "b", label: "B", latencyMs: 500 }),
      ],
      NOW,
    );
    expect(c.fastest?.label).toBe("B");
    expect(c.blocked.map((h) => h.label)).toEqual(["A"]);
  });

  it("prefers a slow host over none at all", () => {
    const c = readConnection(true, [snap({ latencyMs: SLOW_MS + 500 })], NOW);
    expect(c.fastest?.health).toBe("slow");
  });

  it("names the blocked hosts and says the registry moves on", () => {
    const c = readConnection(
      true,
      [snap({ host: "a", label: "OKX", softBlocked: true }), snap({ host: "b", label: "Binance spot" })],
      NOW,
    );
    expect(c.note).toMatch(/OKX/);
    expect(c.note).toMatch(/use the others/);
  });

  // The whole point of removing the offline MODE: this is measured, not chosen,
  // and nothing is invented to fill the gap.
  it("says exactly what offline means, and promises nothing invented", () => {
    const c = readConnection(false, [snap()], NOW);
    expect(c.online).toBe(false);
    expect(c.note).toMatch(/No network/);
    expect(c.note).toMatch(/nothing is being invented/i);
  });

  it("handles having used no host yet", () => {
    const c = readConnection(true, [], NOW);
    expect(c.fastest).toBeNull();
    expect(c.note).toMatch(/No host has been used yet/);
  });

  // "Not enough samples" and "nothing healthy" are different truths.
  it("distinguishes a throttled fleet from an unmeasured one", () => {
    const c = readConnection(true, [snap({ label: "Binance spot", queued: 3 })], NOW);
    expect(c.fastest).toBeNull();
    expect(c.note).toMatch(/throttled and recovering/);
    expect(c.note).toMatch(/Binance spot/);
  });

  it("says so when online but nothing has been measured at all", () => {
    const c = readConnection(true, [snap({ latencySamples: 0 })], NOW);
    expect(c.fastest).toBeNull();
    expect(c.provisional).toBeNull();
    expect(c.note).toMatch(/no host has been measured yet/i);
  });
});

// MEASURED: a fresh terminal makes ONE governor request to draw a chart, so it
// sat below MIN_SAMPLES and showed "—" until the third fetch. The number was
// there all along; it just was not trustworthy enough to ROUTE on.
describe("provisional latency", () => {
  it("offers a one-sample figure when no host is judged yet", () => {
    const c = readConnection(true, [snap({ latencyMs: 143, latencySamples: 1 })], NOW);
    expect(c.fastest).toBeNull();
    expect(c.provisional?.latencyMs).toBe(143);
    expect(c.provisional?.health).toBe("unknown");
  });

  it("says in words that the figure is too thin to route on", () => {
    const c = readConnection(true, [snap({ latencyMs: 143, latencySamples: 2 })], NOW);
    expect(c.note).toMatch(/143ms/);
    expect(c.note).toMatch(/2 sample\(s\)/);
    expect(c.note).toMatch(/too few to route on/i);
  });

  it("is the judged host once there is one, not a separate figure", () => {
    const c = readConnection(true, [snap({ latencyMs: 88 })], NOW);
    expect(c.provisional).toBe(c.fastest);
  });

  // A parked venue's last round trip says nothing about the connection.
  it("never reports a blocked host as the provisional reading", () => {
    const c = readConnection(
      true,
      [snap({ host: "a", label: "A", latencyMs: 5, latencySamples: 1, softBlocked: true })],
      NOW,
    );
    expect(c.provisional).toBeNull();
  });

  it("prefers the fastest unblocked host among several thin readings", () => {
    const c = readConnection(
      true,
      [
        snap({ host: "a", label: "A", latencyMs: 400, latencySamples: 1 }),
        snap({ host: "b", label: "B", latencyMs: 95, latencySamples: 1 }),
      ],
      NOW,
    );
    expect(c.provisional?.label).toBe("B");
  });

  it("classifies every host it is given", () => {
    const c = readConnection(true, [snap({ host: "a" }), snap({ host: "b" }), snap({ host: "c" })], NOW);
    expect(c.hosts.length).toBe(3);
  });
});
