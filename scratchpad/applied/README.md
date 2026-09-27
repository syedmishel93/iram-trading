# Applied, one-shot edit scripts

Each of these rewrote a source file ONCE and has already been run. They are kept
rather than deleted because each carries, in its docstring, the measurement that
justified the edit — the 400 that was `Unsupported parameter 'order'`, the 2,069
`pair_err` rows, the byte-identical `/svc/auto/subjects`. That reasoning is the
valuable part and it belongs next to the change it argued for.

**They are not re-runnable.** Every one asserts its anchor text matches exactly
once, so a second run fails loudly rather than corrupting a file — which is the
point of the assert, and the reason they are safe to leave lying about.

The top level of `scratchpad/` holds only tools that can be run again: the
audits `tests/test_audits.py` gates, and the measurement scripts it excludes by
name. That split is what makes "is every audit gated?" a question a test can ask.
