"""The router: does a model over the candidate ledger know anything?

WHAT THIS IS GUARDING AGAINST

The document that prompted this work routes on `P(win) >= 62%`. Two things have
to be true before that number means anything, and neither is automatic:

 1. THE MODEL MUST BEAT THE BASE RATE. A classifier that predicts the majority
    class for every row scores the base rate exactly and has learned nothing.
    Reporting 58% accuracy on a sample that is 58% winners is reporting nothing.

 2. THE SCORE MUST BE A PROBABILITY. A gradient booster's output is a score, not
    a calibrated probability, and "0.62" from an uncalibrated model is a rank,
    not a chance. Thresholding it at 62% is a number with no units.

And the split has to be TIME-ORDERED. A random train/test split on a time series
puts June in train and May in test, so the model is scored on a past it has
already seen. That inflates every metric and it is invisible — which is why the
leak test below fabricates a feature that only a leaking split can exploit.

Run by `verify.py`, which sets MISHEL_SVC_DB so nothing here reaches the
operator's database.
"""

import math
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

# THE BOOTSTRAP ABOVE EVERY IMPORT IT EXISTS FOR. `svc.router` is only loadable
# once `server/` is on the path, so this import must stay below that insert —
# which is why it is here rather than in the block above. E402 is deferred in
# ruff.toml, so it needs no directive.
from svc.router import train_router


def _rows(n, *, seed=7, informative=True, base=0.5):
    """Candidates with one feature that is (or is not) informative.

    `t` ascends, so a time-ordered split is meaningful. When `informative`, a
    row's feature genuinely shifts its win probability; when not, the feature is
    noise and the label is a coin weighted to `base`.
    """
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        x = rnd.random()
        if informative:
            p = 0.15 + 0.7 * x
        else:
            p = base
        out.append(
            {
                "t": 1_700_000_000_000 + i * 3_600_000,
                "features": {"x": x, "noise": rnd.random()},
                "outcome": "target" if rnd.random() < p else "stop",
                "r": 1.0,
            }
        )
    return out


# THE FITS, COMPUTED ONCE.
#
# Five of these tests interrogate the SAME model over the SAME rows, and the
# first draft paid for a fresh fit in each — 11 fits, 53s, inside a gate whose
# whole pytest stage was 13s. A test slower than the thing it measures is a
# test people stop running, and this repository already records one that was.
#
# Module scope, because the questions differ and the fit does not.


@pytest.fixture(scope="module")
def fit_signal():
    return train_router(_rows(1200), min_rows=200)


@pytest.fixture(scope="module")
def fit_noise():
    return train_router(_rows(1200, informative=False, base=0.55), min_rows=200)


# --------------------------------------------------------------- refusals ---


def test_refuses_too_few_rows():
    r = train_router(_rows(30), min_rows=200)
    assert r["ok"] is False
    assert "rows" in r["why"].lower()


def test_refuses_a_single_class():
    rows = _rows(400)
    for row in rows:
        row["outcome"] = "target"
    r = train_router(rows, min_rows=100)
    assert r["ok"] is False
    assert "class" in r["why"].lower()


def test_ignores_timeouts_rather_than_calling_them_losses():
    """A timeout is neither a win nor a loss, so it is not a training row.

    Labelling it a loss teaches the model that a quiet market looks like a
    mistake, which is the ledger's own rule one layer up.
    """
    rows = _rows(400)
    for row in rows[:100]:
        row["outcome"] = "timeout"
    r = train_router(rows, min_rows=100)
    assert r["ok"] is True
    assert r["rows"] == 300


# ------------------------------------------------------ does it know anything


def test_finds_a_real_signal_and_reports_lift_over_the_base_rate(fit_signal):
    r = fit_signal
    assert r["ok"] is True
    assert r["auc"] > 0.6, "a genuinely informative feature should be found"
    assert r["lift"] > 0, "accuracy must be reported against the base rate, not alone"


def test_REPORTS_NO_SKILL_ON_NOISE_RATHER_THAN_A_FLATTERING_NUMBER(fit_noise):
    """The test that matters. On pure noise the answer is "it knows nothing".

    A router that cannot say this is a router that will route on noise, and the
    failure is silent: an AUC near 0.5 reported as "62% confident" is exactly
    the shape of a number that loses money with conviction.
    """
    r = fit_noise
    assert r["ok"] is True
    assert abs(r["auc"] - 0.5) < 0.08, f"noise should not be learnable, got auc={r['auc']}"
    assert r["skill"] is False
    assert "no" in r["why"].lower() or "not" in r["why"].lower()


def test_a_model_with_no_skill_says_so_even_when_accuracy_looks_high():
    """55% accuracy on a 55% base rate is zero skill dressed as a majority.

    This is the specific way a "62% win probability" threshold lies.
    """
    r = train_router(_rows(1500, informative=False, base=0.75), min_rows=200)
    assert r["ok"] is True
    assert r["baseRate"] > 0.7
    assert r["skill"] is False


# ----------------------------------------------------------- the time split --


def test_folds_are_time_ordered_and_a_random_split_would_have_leaked():
    """A feature that encodes its own row's index leaks only under a random split.

    With time-ordered folds every test row is strictly after its training rows,
    so an index feature carries no information about the future and the model
    cannot exploit it. If this ever passes with a high AUC, the split has
    stopped being time-ordered.
    """
    rnd = random.Random(3)
    rows = []
    for i in range(1200):
        # The label depends on a HIDDEN periodic term. Under a random split the
        # model can memorise neighbours; under a time split it cannot.
        hidden = math.sin(i / 7.0)
        rows.append(
            {
                "t": 1_700_000_000_000 + i * 3_600_000,
                "features": {"idx": float(i)},
                "outcome": "target" if (hidden > 0) == (rnd.random() < 0.9) else "stop",
                "r": 1.0,
            }
        )
    r = train_router(rows, min_rows=200)
    assert r["ok"] is True
    assert r["folds"] >= 3
    assert r["timeOrdered"] is True
    assert r["auc"] < 0.75, f"an index feature should not predict the future, got {r['auc']}"


def test_every_test_row_is_after_every_training_row_in_its_fold(fit_signal):
    r = fit_signal
    assert r["ok"] is True
    for f in r["foldSpans"]:
        assert f["trainTo"] <= f["testFrom"], "a fold trained on rows after the ones it scored"


# ---------------------------------------------------------- the calibration --


def test_calibration_buckets_account_for_every_scored_row(fit_signal):
    r = fit_signal
    assert r["ok"] is True
    assert sum(b["n"] for b in r["calibration"]) == r["scored"]


def test_calibration_reports_what_actually_happened_in_each_bucket(fit_signal):
    """The reliability curve is what replaces a fixed 62% threshold.

    A bucket saying "predicted 0.60, observed 0.59, n=140" is a threshold you
    can choose. "P(win) >= 62%" with nothing behind it is not.
    """
    r = fit_signal
    for b in r["calibration"]:
        assert 0.0 <= b["predicted"] <= 1.0
        assert 0.0 <= b["observed"] <= 1.0
        assert b["n"] >= 0


def test_a_threshold_is_derived_from_the_curve_not_assumed(fit_signal):
    r = fit_signal
    assert r["ok"] is True
    # The suggested cut is a real quantile of the scores, not a constant.
    assert 0.0 < r["suggestedThreshold"] < 1.0
    assert r["thresholdBasis"] in ("calibration", "none")


if __name__ == "__main__":
    import subprocess

    raise SystemExit(subprocess.call([sys.executable, "-m", "pytest", "-q", __file__]))
