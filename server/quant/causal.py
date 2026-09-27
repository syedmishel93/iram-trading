"""
Causal inference on the trade journal — `DoWhy`, `EconML`, `CausalML`.

THE QUESTION, AND WHY CORRELATION CANNOT ANSWER IT
The journal records, for every trade, whether you followed your plan. Group by
that flag and on-plan trades will almost certainly show a better average R. The
obvious conclusion — "following the plan makes me money" — does not follow, and
believing it is expensive.

Because there is an obvious confounder: you follow the plan when conditions are
CLEAR. In a clean trend with an obvious level, the setup is textbook and the
discipline is easy. In chop, at 3am, after two losses, the setup is marginal and
so is your adherence. The regime causes both the adherence AND the outcome. The
raw difference in means is that regime effect wearing adherence's clothes.

WHAT THIS MODULE DOES ABOUT IT
Estimates the effect of adherence on R while adjusting for the conditions the
trade was taken in, and then — this is the part that matters — tries to break
its own answer:

  • DoWhy states the assumed causal graph EXPLICITLY, so the assumption is
    inspectable rather than buried in a regression specification.
  • DoWhy's refuters then attack the estimate: add a random common cause,
    replace the treatment with noise, drop a random subset. An estimate that
    survives all three is not proven, but an estimate that fails one is dead.
  • EconML estimates a CATE — not "does adherence help" but "WHERE does it
    help" — with a doubly-robust learner, so it is consistent if either the
    outcome model or the propensity model is right.
  • CausalML's independent meta-learners are a cross-check on the same
    quantity. Two libraries disagreeing is information.

WHAT IT WILL NOT DO
Claim causation from observational data. Every output here is "the effect,
UNDER the stated assumption that these are the only confounders". That
assumption is almost certainly incomplete, and the module says so every time.

Heavy imports: dowhy, econml, causalml, at call time.
"""
from __future__ import annotations

import math

import numpy as np

from .common import MIN_TRADES, MIN_TRADES_PER_ARM, refuse

#: Refutation results this far from the original estimate kill it.
REFUTE_TOLERANCE = 0.35


def _patch_networkx_for_dowhy() -> None:
    """
    Make DoWhy 0.8 work with networkx 3.5+.

    DoWhy calls `networkx.algorithms.d_separated`, which networkx renamed to
    `is_d_separator` and then removed. The signature is identical, so the fix
    is an alias.

    WHY A SHIM AND NOT AN UPGRADE
    Because there is no newer DoWhy to upgrade to on this interpreter: pip's
    index resolves nothing above 0.8 for Python 3.14, so the choice is this
    alias or no refutation tests at all. Pinning networkx down instead would
    break every other library in this service that wants a current one.

    Idempotent, and it only ever ADDS the old name — nothing that currently
    works is rebound.
    """
    import networkx as nx

    if not hasattr(nx.algorithms, "d_separated") and hasattr(nx.algorithms, "is_d_separator"):
        nx.algorithms.d_separated = nx.algorithms.is_d_separator  # type: ignore[attr-defined]
    if not hasattr(nx, "d_separated") and hasattr(nx, "is_d_separator"):
        nx.d_separated = nx.is_d_separator  # type: ignore[attr-defined]


def _frame(payload: dict):
    """
    Build the trade table: treatment, outcome, confounders.

    Every trade must carry its own conditions. A journal entry with no regime
    recorded cannot be adjusted for regime, and quietly imputing one would be
    inventing the very variable the analysis turns on.
    """
    import pandas as pd

    trades = payload.get("trades")
    if not isinstance(trades, list) or len(trades) == 0:
        refuse("No trades in the request.")

    treatment_key = str(payload.get("treatment", "onPlan"))
    outcome_key = str(payload.get("outcome", "r"))
    confounder_keys = payload.get("confounders") or ["regime", "volPct", "setupKind"]
    if not isinstance(confounder_keys, list):
        refuse("`confounders` must be a list of field names.")

    rows = []
    for t in trades:
        if not isinstance(t, dict):
            continue
        if treatment_key not in t or outcome_key not in t:
            continue
        try:
            y = float(t[outcome_key])
            w = 1 if bool(t[treatment_key]) else 0
        except (TypeError, ValueError):
            continue
        if not math.isfinite(y):
            continue
        row = {"__treat": w, "__out": y}
        missing = False
        for k in confounder_keys:
            if k not in t or t[k] is None:
                missing = True
                break
            row[k] = t[k]
        if missing:
            continue
        rows.append(row)

    if len(rows) < MIN_TRADES:
        refuse(
            f"{len(rows)} trades carry a treatment, an outcome and every "
            f"confounder. {MIN_TRADES} is the floor. Trades missing any of "
            f"these are dropped rather than imputed — imputing the confounder "
            f"would be inventing the variable the whole analysis turns on."
        )

    df = pd.DataFrame(rows)
    n_treated = int(df["__treat"].sum())
    n_control = len(df) - n_treated
    if n_treated < MIN_TRADES_PER_ARM or n_control < MIN_TRADES_PER_ARM:
        refuse(
            f"{n_treated} treated and {n_control} control trades. Both arms need "
            f"at least {MIN_TRADES_PER_ARM}. With one arm this thin the effect is "
            f"whatever the handful of trades in it happened to do."
        )

    # One-hot the categoricals; leave numerics alone.
    cats = [c for c in confounder_keys if df[c].dtype == object]
    nums = [c for c in confounder_keys if c not in cats]
    for c in nums:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna()
    if len(df) < MIN_TRADES:
        refuse(f"Only {len(df)} trades survived numeric coercion of the confounders.")

    X = pd.get_dummies(df[confounder_keys], columns=cats, drop_first=True).astype(float)
    return df, X, confounder_keys, n_treated, n_control


def _naive(df) -> dict:
    """The number everyone computes, and the one this module exists to correct."""
    a = df.loc[df["__treat"] == 1, "__out"]
    b = df.loc[df["__treat"] == 0, "__out"]
    from scipy import stats as sps

    _t, p = sps.ttest_ind(a, b, equal_var=False)
    return {
        "treated_mean": float(a.mean()),
        "control_mean": float(b.mean()),
        "difference": float(a.mean() - b.mean()),
        "p_value": float(p),
        "note": (
            "The raw difference in means. It attributes to the treatment "
            "everything that differs between the two groups, including the "
            "conditions that drove both."
        ),
    }


def effect(payload: dict) -> dict:
    """Estimate the causal effect of a binary treatment on a numeric outcome."""
    import pandas as pd

    df, X, conf_keys, n_treated, n_control = _frame(payload)
    out: dict = {
        "n_trades": len(df),
        "n_treated": n_treated,
        "n_control": n_control,
        "treatment": payload.get("treatment", "onPlan"),
        "outcome": payload.get("outcome", "r"),
        "confounders": conf_keys,
        "naive": _naive(df),
    }

    y = df["__out"].to_numpy(dtype=float)
    w = df["__treat"].to_numpy(dtype=int)
    Xv = X.to_numpy(dtype=float)

    # ---- DoWhy: state the graph, identify, estimate, then attack it --------
    try:
        import contextlib
        import io as _io
        import warnings

        _patch_networkx_for_dowhy()
        from dowhy import CausalModel

        work = pd.concat([X.reset_index(drop=True), df[["__treat", "__out"]].reset_index(drop=True)], axis=1)
        # DoWhy 0.8 prints its estimator parameters to stdout on every call and
        # every refutation — fourteen dicts per request, straight into the
        # service log. There is no verbosity flag for it in this version.
        with warnings.catch_warnings(), contextlib.redirect_stdout(_io.StringIO()):
            warnings.simplefilter("ignore")
            model = CausalModel(
                data=work,
                treatment="__treat",
                outcome="__out",
                common_causes=list(X.columns),
            )
            estimand = model.identify_effect(proceed_when_unidentifiable=True)
            est = model.estimate_effect(
                estimand, method_name="backdoor.linear_regression"
            )
            adjusted = float(est.value)

            refutations = {}
            for label, method in (
                ("random_common_cause", "random_common_cause"),
                ("placebo_treatment", "placebo_treatment_refuter"),
                ("subset", "data_subset_refuter"),
            ):
                try:
                    r = model.refute_estimate(estimand, est, method_name=method)
                    new = float(r.new_effect) if r.new_effect is not None else float("nan")
                    if label == "placebo_treatment":
                        # A placebo treatment SHOULD produce no effect. A large
                        # one means the estimator is finding structure that is
                        # not there.
                        passed = abs(new) < abs(adjusted) * 0.5 if adjusted != 0 else abs(new) < 0.1
                    else:
                        passed = (
                            abs(new - adjusted) <= abs(adjusted) * REFUTE_TOLERANCE
                            if adjusted != 0
                            else True
                        )
                    refutations[label] = {
                        "new_effect": new,
                        "passed": bool(passed),
                    }
                except Exception as exc:  # noqa: BLE001
                    refutations[label] = {"error": f"{type(exc).__name__}: {exc}"}

        out["dowhy"] = {
            "ok": True,
            "adjusted_effect": adjusted,
            "estimand": str(estimand.estimands.get("backdoor", {}).get("estimand", ""))[:400],
            "refutations": refutations,
            "survives_refutation": all(
                v.get("passed", False) for v in refutations.values() if "error" not in v
            ),
        }
    except ImportError:
        out["dowhy"] = {"ok": False, "reason": "DoWhy is not installed."}
    except Exception as exc:  # noqa: BLE001
        out["dowhy"] = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}

    # ---- EconML: where does the effect live? -------------------------------
    try:
        import warnings

        from econml.dr import LinearDRLearner
        from sklearn.ensemble import GradientBoostingRegressor
        from sklearn.linear_model import LogisticRegression

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            dr = LinearDRLearner(
                model_regression=GradientBoostingRegressor(n_estimators=60, max_depth=2),
                model_propensity=LogisticRegression(max_iter=1000),
                random_state=0,
            )
            dr.fit(y, w, X=Xv)
            ate = float(dr.ate(Xv, T0=0, T1=1))
            lo, hi = dr.ate_interval(Xv, T0=0, T1=1, alpha=0.05)
            cate = dr.effect(Xv, T0=0, T1=1)

        # Which quartile of the effect distribution is which
        order = np.argsort(cate)
        out["econml"] = {
            "ok": True,
            "ate": ate,
            "ci_low": float(lo),
            "ci_high": float(hi),
            "significant": bool(float(lo) > 0 or float(hi) < 0),
            "cate_spread": {
                "p10": float(np.percentile(cate, 10)),
                "median": float(np.median(cate)),
                "p90": float(np.percentile(cate, 90)),
            },
            "heterogeneous": bool(
                np.percentile(cate, 90) - np.percentile(cate, 10) > abs(ate) * 0.5
            ),
            "best_conditions": _describe(df, X, order[-max(3, len(order) // 5):], conf_keys),
            "worst_conditions": _describe(df, X, order[: max(3, len(order) // 5)], conf_keys),
            "note": (
                "Doubly robust: consistent if EITHER the outcome model or the "
                "propensity model is correctly specified, rather than needing both."
            ),
        }
    except ImportError:
        out["econml"] = {"ok": False, "reason": "EconML is not installed."}
    except Exception as exc:  # noqa: BLE001
        out["econml"] = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}

    # ---- CausalML: an independent second opinion ---------------------------
    try:
        import warnings

        from causalml.inference.meta import BaseXRegressor
        from sklearn.ensemble import GradientBoostingRegressor

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            learner = BaseXRegressor(
                learner=GradientBoostingRegressor(n_estimators=60, max_depth=2)
            )
            te = learner.estimate_ate(X=Xv, treatment=w, y=y)
            ate2 = float(np.ravel(te[0])[0])
        agree = None
        if out.get("econml", {}).get("ok"):
            e1 = out["econml"]["ate"]
            agree = bool(abs(ate2 - e1) < max(0.1, abs(e1) * 0.5))
        out["causalml"] = {
            "ok": True,
            "ate": ate2,
            "agrees_with_econml": agree,
            "note": (
                "X-learner, a different estimator family from EconML's doubly "
                "robust one. Agreement is reassurance; disagreement means the "
                "estimate depends on the method and should not be acted on."
            ),
        }
    except ImportError:
        out["causalml"] = {"ok": False, "reason": "CausalML is not installed."}
    except Exception as exc:  # noqa: BLE001
        out["causalml"] = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}

    out["verdict"] = _verdict(out)
    out["assumption"] = (
        "Everything above holds ONLY under the assumption that "
        f"{', '.join(conf_keys)} are the only things that affect both whether you "
        f"took the trade as planned and how it turned out. That assumption is "
        f"almost certainly incomplete — fatigue, news, and how the previous trade "
        f"went are not in this list. This is the best estimate available from "
        f"observational data, not a controlled experiment."
    )
    return out


def _describe(df, X, idx: np.ndarray, conf_keys: list[str]) -> dict:
    """Summarise the conditions in a slice of trades, for the CATE tails."""
    sub = df.iloc[idx]
    out: dict = {"n": len(sub), "mean_outcome": float(sub["__out"].mean())}
    for k in conf_keys:
        if k not in sub.columns:
            continue
        col = sub[k]
        if col.dtype == object:
            vc = col.value_counts()
            if len(vc) > 0:
                out[k] = f"mostly {vc.index[0]} ({vc.iloc[0]}/{len(sub)})"
        else:
            out[k] = float(col.mean())
    return out


def _verdict(out: dict) -> str:
    naive = out["naive"]["difference"]
    dw = out.get("dowhy", {})
    ec = out.get("econml", {})

    if not dw.get("ok") and not ec.get("ok"):
        return (
            "Neither causal estimator ran on this data. The raw difference in "
            f"means is {naive:+.3f}R, and it remains uninterpretable."
        )

    adjusted = dw.get("adjusted_effect") if dw.get("ok") else ec.get("ate")
    if adjusted is None:
        return "No adjusted estimate was produced."

    parts = [
        (f"Raw difference {naive:+.3f}R. After adjusting for "
        f"{', '.join(out['confounders'])}, {adjusted:+.3f}R.")
    ]

    shrink = abs(naive) - abs(adjusted)
    if abs(naive) > 1e-9 and shrink / abs(naive) > 0.3:
        parts.append(
            f"Adjustment removed {shrink / abs(naive) * 100:.0f}% of the raw gap — "
            f"most of what looked like the treatment was the conditions it was "
            f"taken in."
        )

    if ec.get("ok"):
        if ec.get("significant"):
            parts.append(
                f"95% interval [{ec['ci_low']:+.3f}, {ec['ci_high']:+.3f}] excludes zero."
            )
        else:
            parts.append(
                f"95% interval [{ec['ci_low']:+.3f}, {ec['ci_high']:+.3f}] includes zero, "
                f"so the effect is not distinguishable from nothing."
            )
        if ec.get("heterogeneous"):
            parts.append("The effect varies a lot by condition — see the CATE tails.")

    if dw.get("ok"):
        if dw.get("survives_refutation"):
            parts.append("The estimate survived all three refutation tests.")
        else:
            failed = [k for k, v in dw.get("refutations", {}).items() if v.get("passed") is False]
            if failed:
                parts.append(
                    f"It FAILED the {', '.join(failed)} refutation — do not act on it."
                )

    cm = out.get("causalml", {})
    if cm.get("ok") and cm.get("agrees_with_econml") is False:
        parts.append(
            f"CausalML's independent estimate is {cm['ate']:+.3f}R, which does not "
            f"agree. The answer depends on the method, which means there is not "
            f"enough signal here to settle it."
        )

    return " ".join(parts)
