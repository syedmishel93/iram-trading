// @vitest-environment jsdom
/**
 * HANDING THE OPERATOR A FILE: the two lines everybody gets wrong.
 *
 * The holdings card's Export button built an anchor, never put it in the
 * document, clicked it, and revoked the object URL on the same tick. So almost
 * certainly no file ever appeared, with no error anywhere — a detached anchor
 * has the right href, the right download attribute, and reports a click.
 * Nothing in a type system or a DOM assertion about the button would see it.
 *
 * Three other modules in this repository each carry their own correct copy,
 * two with the comment explaining the revoke. There is one owner now, and
 * these are its two rules.
 *
 * jsdom implements NEITHER `URL.createObjectURL` nor `URL.revokeObjectURL`, so
 * they are installed for the suite rather than per test: restoring an absent
 * function left the deferred revoke calling `undefined` a second after the
 * test that scheduled it had finished, which failed a DIFFERENT test. A stub
 * that is torn down while a timer still points at it is its own defect.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadText } from "../src/ui/download";

const made: string[] = [];
const revoked: string[] = [];
const seen: Array<{ inDocument: boolean; name: string }> = [];

const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

URL.createObjectURL = ((): string => {
  const url = `blob:test/${made.length}`;
  made.push(url);
  return url;
}) as unknown as typeof URL.createObjectURL;
URL.revokeObjectURL = ((u: string): void => void revoked.push(u)) as unknown as typeof URL.revokeObjectURL;

afterAll(() => {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

/** Captured at the moment of the click, which is the only moment that counts. */
const onClick = (e: Event): void => {
  const a = e.target as HTMLAnchorElement;
  seen.push({ inDocument: a.isConnected, name: a.download });
  e.preventDefault();
};

beforeEach(() => {
  made.length = 0;
  revoked.length = 0;
  seen.length = 0;
  vi.useFakeTimers();
  document.addEventListener("click", onClick, true);
});

afterEach(() => {
  document.removeEventListener("click", onClick, true);
  /* Run the deferred revoke here, so no timer outlives the stub it calls. */
  vi.runAllTimers();
  vi.useRealTimers();
});

describe("downloadText", () => {
  it("HAS THE ANCHOR IN THE DOCUMENT AT THE MOMENT IT IS CLICKED", () => {
    /* A click on a detached anchor dispatches and downloads nothing. This is
       the half of the defect that produced no file at all. */
    downloadText("alerts.json", "[]");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.inDocument, "the anchor was clicked outside the document").toBe(true);
    expect(seen[0]?.name).toBe("alerts.json");
  });

  it("DOES NOT REVOKE THE URL ON THE SAME TICK", () => {
    /* Revoking synchronously can beat the download the click just started —
       the comment two other call sites in this repository already carry. */
    downloadText("x.json", "{}");
    expect(revoked, "the object URL was revoked before the download could start").toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(revoked).toEqual(made);
  });

  it("LEAVES NOTHING BEHIND IN THE DOCUMENT", () => {
    const before = document.body.childElementCount;
    downloadText("x.json", "{}");
    expect(document.body.childElementCount).toBe(before);
  });
});
