"""
Discrete choice — `biogeme`.

WHAT THIS MODELS, AND WHY IT IS THE ODD ONE OUT
Every other module here models the MARKET. This one models YOU.

Biogeme is a discrete-choice library from transport economics, where it is used
to work out what actually drives a traveller's choice of route — not what they
say drives it, what the choices reveal. Pointed at a trade journal it answers
the same question about an operator: given a setup with these attributes, what
predicts whether you took it?

WHY THAT IS WORTH KNOWING
Because the answer is routinely not what the trader believes. A discretionary
operator will tell you they trade confluence and structure. Fit a logit to
their actual decisions and the biggest coefficient is often on how recently
they last won, or on the hour of the day, or on how far price has already
moved — none of which appear anywhere in their written plan.

That gap is measurable, and this is the thing that measures it. The journal
already records adherence; this says what your revealed decision rule IS, which
is a different and harder question than whether you followed the written one.

WHY LOGIT AND NOT A GRADIENT BOOSTER
Because the coefficients are the output. A booster would predict your choices
more accurately and tell you nothing about the trade-off you are actually
making. A logit coefficient is a rate of substitution: how much extra
confluence it takes to make you accept one more unit of risk. That number is
the deliverable.

Heavy import: `biogeme`, at call time. It prints a g++ warning on import when
no compiler is present; the pure-Python path works fine without one.
"""
from __future__ import annotations

import math

from .common import MIN_TRADES, refuse

#: Observations needed per estimated coefficient.
MIN_PER_PARAM = 15


def _clean_name(s: str) -> str:
    """Biogeme variable names must be identifiers."""
    out = "".join(ch if ch.isalnum() or ch == "_" else "_" for ch in s)
    return out if out and not out[0].isdigit() else f"v_{out}"


def revealed(payload: dict) -> dict:
    """
    Fit a binary logit to take/skip decisions.

    `opportunities` is a list of setups you SAW, each with `taken` (bool) and
    numeric attributes. The skipped ones are the whole point — a journal of
    only the trades you took cannot identify a decision rule, because there is
    no variation in the outcome to explain.
    """
    import pandas as pd

    rows_in = payload.get("opportunities")
    if not isinstance(rows_in, list) or len(rows_in) == 0:
        refuse("No opportunities in the request.")

    attr_names = payload.get("attributes")
    if not isinstance(attr_names, list) or len(attr_names) == 0:
        refuse(
            "`attributes` must list the numeric fields to model the decision on."
        )

    rows = []
    for o in rows_in:
        if not isinstance(o, dict) or "taken" not in o:
            continue
        rec = {"taken": 1 if bool(o["taken"]) else 0}
        ok = True
        for a in attr_names:
            try:
                v = float(o[a])
            except (KeyError, TypeError, ValueError):
                ok = False
                break
            if not math.isfinite(v):
                ok = False
                break
            rec[_clean_name(a)] = v
        if ok:
            rows.append(rec)

    if len(rows) < MIN_TRADES:
        refuse(
            f"{len(rows)} opportunities carry `taken` and every attribute. "
            f"{MIN_TRADES} is the floor."
        )

    df = pd.DataFrame(rows)
    n_taken = int(df["taken"].sum())
    n_skip = len(df) - n_taken
    if n_taken < 10 or n_skip < 10:
        refuse(
            f"{n_taken} taken and {n_skip} skipped. Both need at least 10. "
            f"A journal of only the trades you TOOK cannot identify a decision "
            f"rule — there is no variation in the choice to explain."
        )

    cols = [_clean_name(a) for a in attr_names]
    n_params = len(cols) + 1
    if len(df) < n_params * MIN_PER_PARAM:
        refuse(
            f"{len(df)} observations for {n_params} coefficients. This needs at "
            f"least {MIN_PER_PARAM} per coefficient ({n_params * MIN_PER_PARAM}); "
            f"below that the estimates are unstable and their signs can flip on "
            f"a single trade."
        )

    # Standardise so coefficients are comparable to each other. Without this,
    # a coefficient on "R multiple" (range ~3) and one on "confluence score"
    # (range ~100) cannot be ranked, and ranking them is the entire output.
    means = {c: float(df[c].mean()) for c in cols}
    stds = {c: float(df[c].std()) or 1.0 for c in cols}
    for c in cols:
        df[c] = (df[c] - means[c]) / stds[c]

    import logging
    import warnings

    logging.getLogger("biogeme").setLevel(logging.CRITICAL)

    import biogeme.biogeme as bio
    import biogeme.database as biodb
    import biogeme.models as biomodels
    from biogeme.expressions import Beta, Variable

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        database = biodb.Database("choices", df)

        asc = Beta("asc_take", 0, None, None, 0)
        betas = {c: Beta(f"b_{c}", 0, None, None, 0) for c in cols}

        v_take = asc
        for c in cols:
            v_take = v_take + betas[c] * Variable(c)

        V = {1: v_take, 0: Beta("asc_skip", 0, None, None, 1)}  # skip normalised to 0
        av = {1: 1, 0: 1}
        logprob = biomodels.loglogit(V, av, Variable("taken"))

        # Biogeme writes `biogeme.toml` and a `.iter` file into the working
        # directory. Crucially it writes the toml when the BIOGEME object is
        # CONSTRUCTED, not when it estimates — the first version of this moved
        # only `estimate()` into a temp directory and still dropped a
        # `biogeme.toml` in the repository root. Both calls go inside.
        import os
        import shutil
        import tempfile

        cwd = os.getcwd()
        tmp = tempfile.mkdtemp(prefix="biogeme-")
        try:
            os.chdir(tmp)
            # Output flags must go through the CONSTRUCTOR: biogeme 3.3 raises
            # on direct assignment, and the parameter set differs by version,
            # so each is offered and the unknown ones are dropped.
            wanted = {
                "generate_html": False,
                "generate_yaml": False,
                "generate_netcdf": False,
            }
            try:
                model = bio.BIOGEME(database, logprob, **wanted)
            except Exception:  # noqa: BLE001
                model = bio.BIOGEME(database, logprob)
            model.modelName = "revealed_choice"
            results = model.estimate()
        finally:
            os.chdir(cwd)
            shutil.rmtree(tmp, ignore_errors=True)

    params = _extract(results, cols)
    if not params:
        refuse("Biogeme returned no estimated parameters.")

    # Rank by |t|, which on standardised inputs is the honest ordering of what
    # actually drives the decision.
    ranked = sorted(
        (p for p in params if p["name"] not in ("asc_take", "asc_skip")),
        key=lambda p: abs(p["t_stat"]),
        reverse=True,
    )
    live = [p for p in ranked if p["significant"]]

    # Model fit against the null of "always predict the base rate".
    ll = _get(results, ("final_log_likelihood", "logLike", "final_loglikelihood"))
    ll0 = _get(results, ("null_log_likelihood", "nullLogLike", "initial_log_likelihood"))
    rho2 = 1.0 - ll / ll0 if (ll is not None and ll0 not in (None, 0)) else None

    base = n_taken / len(df)

    return {
        "n_opportunities": len(df),
        "n_taken": n_taken,
        "n_skipped": n_skip,
        "take_rate": base,
        "attributes": attr_names,
        "coefficients": ranked,
        "drivers": [p["attribute"] for p in live],
        "log_likelihood": ll,
        "null_log_likelihood": ll0,
        "rho_squared": rho2,
        "verdict": _verdict(live, ranked, rho2),
        "reading": (
            "Coefficients are on STANDARDISED attributes, so they are directly "
            "comparable: the largest is the attribute your decisions actually "
            "turn on. A positive sign means more of it makes you more likely to "
            "take the trade."
        ),
        "caveat": (
            "This describes what you DO, not what works. An attribute can drive "
            "your decisions strongly and have no relationship to the outcome — "
            "that combination is the most useful thing this can find, and the "
            "causal endpoint is where to test it."
        ),
        "basis": (
            f"Binary logit on {len(df)} take/skip decisions, {len(cols)} "
            f"standardised attributes, skip utility normalised to zero."
        ),
    }


def _get(results, names: tuple[str, ...]):
    """Biogeme renames result fields between minor versions; try each."""
    for n in names:
        v = getattr(results, n, None)
        if callable(v):
            try:
                v = v()
            except Exception:  # noqa: BLE001
                continue
        if isinstance(v, (int, float)) and math.isfinite(float(v)):
            return float(v)
    data = getattr(results, "data", None)
    for n in names:
        v = getattr(data, n, None)
        if isinstance(v, (int, float)) and math.isfinite(float(v)):
            return float(v)
    return None


def _extract(results, cols: list[str]) -> list[dict]:
    """
    Pull the estimates out, whichever accessor this biogeme version has.

    3.3 returns a DICT keyed "Estimated parameters" whose value is a DataFrame
    with `Name` as a COLUMN, not the index, and columns spelled "Robust
    t-stat." / "Robust p-value". Earlier versions returned the frame directly
    with the name on the index and different column spellings. Both are
    handled, because a service that breaks on a library's minor release is a
    service that breaks silently.
    """
    import pandas as pd

    obj = None
    for accessor in ("get_estimated_parameters", "getEstimatedParameters"):
        fn = getattr(results, accessor, None)
        if callable(fn):
            try:
                obj = fn()
                break
            except Exception:  # noqa: BLE001
                continue
    if obj is None:
        return []

    df = None
    if isinstance(obj, dict):
        for v in obj.values():
            if isinstance(v, pd.DataFrame):
                df = v
                break
    elif isinstance(obj, pd.DataFrame):
        df = obj
    if df is None or df.empty:
        return []

    def pick(*cands: str):
        for c in cands:
            if c in df.columns:
                return c
        return None

    c_name = pick("Name", "name")
    c_val = pick("Value", "value", "Estimate")
    c_t = pick("Robust t-stat.", "Rob. t-test", "t-test", "Rob. t-stat", "t_stat")
    c_p = pick("Robust p-value", "Rob. p-value", "p-value", "p_value")
    if c_val is None:
        return []

    out = []
    for i, row in df.iterrows():
        name = str(row[c_name]) if c_name else str(i)
        t = float(row[c_t]) if c_t and _finite(row[c_t]) else float("nan")
        p = float(row[c_p]) if c_p and _finite(row[c_p]) else float("nan")
        attr = name.removeprefix("b_")
        out.append(
            {
                "name": name,
                "attribute": attr,
                "coefficient": float(row[c_val]),
                "t_stat": t,
                "p_value": p,
                "significant": bool(math.isfinite(p) and p < 0.05),
            }
        )
    return out


def _finite(x) -> bool:
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False


def _verdict(live: list[dict], ranked: list[dict], rho2) -> str:
    if not ranked:
        return "No coefficients were estimated."
    if not live:
        return (
            "None of these attributes explains your take/skip decisions to a "
            "measurable degree. Either the real driver is not in this list — "
            "time of day, the last result, how much you are down — or your "
            "selection is closer to random than it feels."
        )
    top = live[0]
    parts = [
        (f"Your decisions turn most on {top['attribute']} "
        f"(coefficient {top['coefficient']:+.2f}, t = {top['t_stat']:+.2f}).")
    ]
    if len(live) > 1:
        parts.append(
            "Also significant: " + ", ".join(p["attribute"] for p in live[1:]) + "."
        )
    dead = [p["attribute"] for p in ranked if not p["significant"]]
    if dead:
        parts.append(
            f"{', '.join(dead)} had no measurable influence on whether you took "
            f"the trade — worth checking against what your plan says should matter."
        )
    if rho2 is not None:
        parts.append(
            f"Rho-squared {rho2:.3f}"
            + (
                " — these attributes account for most of the decision."
                if rho2 > 0.3
                else " — a real but partial account of the decision; much of it is "
                "still driven by something not measured here."
            )
        )
    return " ".join(parts)
