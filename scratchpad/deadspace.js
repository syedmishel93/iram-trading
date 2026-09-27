/*
 * Find the "empty space" complaint, on every desk, by MEASUREMENT.
 *
 * Two shapes, both of which the Data desk had:
 *   1. a grid TRACK wider than 320px whose cells hold almost no text
 *      (the "Used by" column at 560px holding an em dash)
 *   2. a BLOCK wider than 1100px holding one short string
 *      (a stat cell at 420px holding the character "3")
 *
 * Reports the worst offenders per desk. Text is measured after trimming, so a
 * cell of whitespace counts as empty.
 */
(() => {
  const findings = [];
  const seen = new Set();

  for (const el of document.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display !== "grid" && cs.display !== "inline-grid") continue;

    const tracks = cs.gridTemplateColumns.split(" ").map((t) => parseFloat(t)).filter((n) => !Number.isNaN(n));
    if (tracks.length < 2) continue;

    /* Children land in tracks in order for a simple auto-flow grid; that is
       every grid in this terminal's tables. Good enough to rank by. */
    const kids = [...el.children];
    tracks.forEach((w, i) => {
      if (w < 320) return;
      const cell = kids[i];
      const text = (cell?.textContent ?? "").trim();
      if (text.length > 24) return;
      const key = el.className + "#" + i;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({
        kind: "wide track",
        sel: "." + String(el.className).split(" ").slice(0, 2).join("."),
        track: i,
        px: Math.round(w),
        holds: JSON.stringify(text.slice(0, 24)),
      });
    });
  }

  for (const el of document.querySelectorAll("div,section,p,span,li")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1100 || r.height === 0 || r.height > 120) continue;
    if (el.children.length > 0) continue;
    const text = (el.textContent ?? "").trim();
    if (text.length === 0 || text.length > 30) continue;
    const key = "blk:" + el.className + text;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      kind: "wide block",
      sel: "." + String(el.className).split(" ").slice(0, 2).join("."),
      track: -1,
      px: Math.round(r.width),
      holds: JSON.stringify(text.slice(0, 30)),
    });
  }

  findings.sort((a, b) => b.px - a.px);
  return findings.slice(0, 12);
})();
