/**
 * Fuzzy subsequence matching, with the positions that matched.
 *
 * WHY THIS EXISTS AT ALL
 * A command palette lives or dies on its ranking. `indexOf` is not enough:
 * typing "ordblk" must find "Order Block" and typing "wsh" must find
 * "Workspace: Horizontal split", and both must outrank an accidental
 * subsequence buried mid-word somewhere else. Substring search finds neither.
 *
 * WHY IT RETURNS POSITIONS
 * Highlighting the matched characters is not decoration. It is the only way a
 * user can tell WHY a result is in the list — without it, a fuzzy match looks
 * like the tool guessed. Every ranking decision this file makes is visible on
 * screen, because the caller draws these indices in bold.
 *
 * THE SCORING MODEL
 * Boundaries beat interiors. A character that starts a word, follows a
 * separator, or begins a camelCase hump is worth far more than one in the
 * middle of a word, because that is what people actually type when they
 * abbreviate. Runs beat scatter: "orbl" landing as OR-der BL-ock is a better
 * match than the same four letters spread across four words. Distance from the
 * start is a mild penalty, never a disqualifier.
 *
 * Deliberately NOT Levenshtein: transposition and substitution tolerance would
 * let "buy" reach "sell" through some path, and a trading terminal that quietly
 * offers the opposite of what was typed is worse than one that offers nothing.
 */

export interface FuzzyMatch {
  /** Higher is better. Only comparable between candidates for the same query. */
  readonly score: number;
  /** Indices into the target that the query matched, ascending. */
  readonly positions: readonly number[];
}

/* Scores are integers so ties are exact and ordering is deliberate. */
const S_HEAD = 100; //  char is target[0]
const S_BOUNDARY = 80; //  char begins a word ("order block" -> b)
const S_CAMEL = 70; //  char begins a camel hump ("orderBlock" -> B)
const S_CONSECUTIVE = 60; //  char directly follows the previous match
const S_EXACT_CASE = 8; //  same case as typed — a gentle nudge only
const P_LEADING = -3; //  per char skipped before the first match
const P_GAP = -6; //  per char skipped between matches
const P_UNMATCHED = -1; //  per target char never matched (prefers short targets)

/** Cap on the leading penalty. See the note at its use. */
const MAX_LEADING_PENALTY = -45;

/** Characters after which the next character starts a new "word". */
function isSeparator(ch: string): boolean {
  return (
    ch === " " ||
    ch === "-" ||
    ch === "_" ||
    ch === "/" ||
    ch === "." ||
    ch === ":" ||
    ch === "("
  );
}

function isUpper(ch: string): boolean {
  return ch >= "A" && ch <= "Z";
}

function isLowerOrDigit(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
}

/**
 * Per-position bonus, computed once per target rather than per query character.
 *
 * This is the hot path: a palette re-ranks every command on every keystroke, so
 * the O(target) work that does not depend on the query is hoisted out of the
 * O(query × target) loop below.
 */
function boundaryBonuses(target: string): Int32Array {
  const out = new Int32Array(target.length);
  for (let i = 0; i < target.length; i++) {
    const ch = target[i] as string;
    if (i === 0) {
      out[i] = S_HEAD;
      continue;
    }
    const prev = target[i - 1] as string;
    if (isSeparator(prev)) out[i] = S_BOUNDARY;
    else if (isUpper(ch) && isLowerOrDigit(prev)) out[i] = S_CAMEL;
    else out[i] = 0;
  }
  return out;
}

/**
 * Cheap rejection: is `query` a subsequence of `target` at all?
 *
 * Runs before the alignment because most candidates fail, and failing in O(n)
 * instead of O(n·m) is the difference between a palette that feels instant over
 * a thousand symbols and one that stutters.
 */
function isSubsequence(queryLower: string, targetLower: string): boolean {
  let q = 0;
  for (let t = 0; t < targetLower.length && q < queryLower.length; t++) {
    if (targetLower[t] === queryLower[q]) q++;
  }
  return q === queryLower.length;
}

/**
 * Best alignment of `query` within `target`, or null if there is none.
 *
 * An empty query matches everything with score 0 — the palette shows its
 * default list rather than nothing, which is what people expect from a box they
 * have just opened.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  if (target.length === 0) return null;
  /* A query longer than the target cannot be a subsequence of it. */
  if (query.length > target.length) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!isSubsequence(q, t)) return null;

  const bonus = boundaryBonuses(target);
  const n = q.length;
  const m = t.length;

  /**
   * `prev[j]` is the best score for matching query[0..i-1] with query[i-1]
   * landing exactly on target[j]. `from[i·m + j]` records which column the
   * previous character used, so the winning alignment can be walked back for
   * the highlight positions.
   *
   * `runPrev[j]` carries the position bonus of the FIRST character of the
   * unbroken run ending at j. Consecutive characters inherit it, which is the
   * whole reason this array exists:
   *
   *   Without inheritance, "orde" scored HIGHER against "o r d e" than against
   *   "order" — four word-boundary bonuses (80 each) beat three consecutive
   *   bonuses (60 each), so a scattered match won. Making the run inherit its
   *   start's bonus means matching "order" from position 0 keeps earning the
   *   head bonus for every character of the run, and the intended ordering
   *   holds. Boundaries still beat interiors; they no longer beat runs.
   *
   * Two rolling rows for scores and run bonuses; the backpointers do need the
   * full grid, but that is n·m ints and n is a query somebody typed by hand.
   */
  const NEG = -1e9;
  let prev = new Float64Array(m).fill(NEG);
  let curr = new Float64Array(m).fill(NEG);
  let runPrev = new Float64Array(m);
  let runCurr = new Float64Array(m);
  const from = new Int32Array(n * m).fill(-1);

  for (let i = 0; i < n; i++) {
    curr.fill(NEG);
    runCurr.fill(0);
    /**
     * `bestGapped` is the best score for query[i-1] ending at or before column
     * j-2 — that is, any predecessor far enough back to leave a real gap.
     * Tracking it incrementally keeps this O(n·m) rather than O(n·m²); folding
     * column j-1 in only AFTER cell j is computed is what keeps the gapped and
     * consecutive branches from being the same branch.
     */
    let bestGapped = NEG;
    let bestGappedAt = -1;

    for (let j = 0; j < m; j++) {
      if (t[j] === q[i]) {
        const posBonus = bonus[j] as number;
        const caseBonus = target[j] === query[i] ? S_EXACT_CASE : 0;

        let score = NEG;
        let src = -1;
        let runStart = posBonus;

        if (i === 0) {
          /* The leading penalty is capped. A match late in a long title is
             worse than one at the front, but it is not worthless, and an
             uncapped linear penalty would make long titles unreachable however
             well they matched. */
          score = Math.max(MAX_LEADING_PENALTY, j * P_LEADING) + posBonus + caseBonus;
        } else {
          /* (a) directly after the previous match — a run continues. */
          if (j > 0 && (prev[j - 1] as number) > NEG) {
            const inherited = Math.max(posBonus, runPrev[j - 1] as number);
            score = (prev[j - 1] as number) + S_CONSECUTIVE + inherited + caseBonus;
            src = j - 1;
            runStart = inherited;
          }
          /* (b) after a gap of at least one character. */
          if (bestGappedAt >= 0) {
            const gap = j - bestGappedAt - 1;
            const cand = bestGapped + gap * P_GAP + posBonus + caseBonus;
            if (cand > score) {
              score = cand;
              src = bestGappedAt;
              runStart = posBonus;
            }
          }
        }

        if (score > NEG) {
          curr[j] = score;
          runCurr[j] = runStart;
          from[i * m + j] = src;
        }
      }

      /* Column j-1 becomes gap-eligible only for cell j+1 onward. */
      if (i > 0 && j > 0) {
        const cand = prev[j - 1] as number;
        if (cand > bestGapped) {
          bestGapped = cand;
          bestGappedAt = j - 1;
        }
      }
    }

    let swap = prev;
    prev = curr;
    curr = swap;
    swap = runPrev;
    runPrev = runCurr;
    runCurr = swap;
  }

  /* Best end column for the final query character. */
  let best = NEG;
  let bestAt = -1;
  for (let j = 0; j < m; j++) {
    const v = prev[j] as number;
    if (v > best) {
      best = v;
      bestAt = j;
    }
  }
  if (bestAt < 0) return null;

  const positions = new Array<number>(n);
  let j = bestAt;
  for (let i = n - 1; i >= 0; i--) {
    positions[i] = j;
    j = from[i * m + j] as number;
    if (j < 0 && i > 0) return null; /* unreachable; guarded rather than trusted */
  }

  return { score: best + (m - n) * P_UNMATCHED, positions };
}

export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
  /** Positions into the item's FIRST haystack — the one the user can see. */
  readonly positions: readonly number[];
}

/** A hit on a hidden keyword is worth less than the same hit on the title. */
const ALTERNATE_HANDICAP = 40;

/**
 * Rank `items` against `query`, best first.
 *
 * `text` may return several strings: the first is the visible target, the rest
 * are alternate haystacks (keywords, aliases, the group name). The best-scoring
 * haystack wins the RANK, but positions always come from the first — painting
 * highlights over characters the user cannot see would be nonsense.
 */
export function rank<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string | readonly string[],
  limit = 50,
): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  const trimmed = query.trim();

  for (const item of items) {
    const raw = text(item);
    const haystacks = typeof raw === "string" ? [raw] : raw;
    const primary = haystacks[0] ?? "";

    const head = fuzzyMatch(trimmed, primary);
    let score = head ? head.score : -Infinity;

    for (let k = 1; k < haystacks.length; k++) {
      const alt = fuzzyMatch(trimmed, haystacks[k] as string);
      if (alt && alt.score - ALTERNATE_HANDICAP > score) {
        score = alt.score - ALTERNATE_HANDICAP;
      }
    }

    if (score === -Infinity) continue;
    out.push({ item, score, positions: head ? head.positions : [] });
  }

  /* Sort is stable in every engine this ships on, so equal scores keep
     registration order — a deliberately curated command list does not shuffle
     between keystrokes. */
  out.sort((a, b) => b.score - a.score);
  return out.length > limit ? out.slice(0, limit) : out;
}
