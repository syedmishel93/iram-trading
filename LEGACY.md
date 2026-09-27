# v39 is frozen

**Frozen on 2026-09-08. It is not shipping and it is not maintained.**

This covers:

| Path | What it is |
|---|---|
| `index.html` | the built v39.29 terminal, 1.5 MB, assembled from `src/js/` |
| `src/` | the 75 modules it is assembled from |
| `tools/build.py` | the assembler, and `tools/verify.py`, `tools/split.py` |
| `dist/index.html` | an older copy of the same build |

The shipping terminal is **`app/`** — the v50 rewrite. It builds to
`app/dist/index.html` and is what `run.py`, the gateway and the packaged binary
all serve.

## Why this file exists

For months both were described as shipping. `docs/HANDOVER.md` said v39 was
"legacy, untouched" and "still shipping" in the same sentence, `run.py` served
the v39 file at `/` until recently, and the test runner ran both suites — so
every change had to be reasoned about twice and it was never quite settled
which one a bug report was about.

That ambiguity was the expensive part, not the disk space. Two codebases with
one team is a permanent tax on every decision, and this note is the decision.

## What "frozen" means precisely

- **No new features.** Not one.
- **No bug fixes**, unless the bug is data loss on an archive `app/` also reads.
- **Nothing new depends on it.** If you find yourself importing from `src/js/`,
  the answer is to port the thing you wanted into `app/src/`.
- **It still runs.** Nothing was deleted. `python run.py --legacy` opens it, and
  it is served at `/legacy`. A frozen terminal that still opens is worth more
  than a deleted one, because the way you check whether the rewrite lost a
  feature is by opening the thing it replaced.

## When to delete it

When `app/` has everything you still open v39 for. The list was 12 desks at the
start of the rewrite and `docs/HANDOVER.md` records the recovery of ten of them
in v47. Check the remaining two, then delete this and the four paths above in
one commit.

Until then it stays, read-only, and unambiguous.

## Reading the old code

`tools/build.py` and `docs/DEVELOPMENT.md` still describe how it was assembled,
and they are accurate for what they cover. Treat both as history rather than as
instructions: the build discipline they document — exact-string atomic patches,
version bumps in three places, `node --check` per module — is the discipline the
rewrite exists to have made unnecessary.
