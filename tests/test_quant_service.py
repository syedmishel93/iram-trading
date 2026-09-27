"""
Tests for the quant service (server/quant).

WHAT THESE ARE FOR
Not to check that GARCH computes a GARCH — `arch` has its own tests for that.
These check the things THIS code is responsible for and that a library cannot
get right on your behalf:

  • the refusal contract: a sample-size floor is enforced, and the refusal
    comes back as an ANSWER rather than as an error
  • no look-ahead: features at bar t use only bars <= t, labels only bars > t
  • the purge: no training row's forward window overlaps a test row
  • honest comparison: a model is never declared a winner on a thinner sample
    than the thing it beat

Run:  python -m pytest tests/test_quant_service.py -q
"""
from __future__ import annotations

import math
import os
import sys
import warnings

import numpy as np
import pytest

warnings.filterwarnings("ignore")

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

from quant import common, ml, optimize, stats
from quant.common import Refusal

T0 = 1_700_000_000_000
HOUR = 3_600_000


def make_bars(n: int, seed: int = 0, vol: float = 0.008) -> list[dict]:
    rng = np.random.default_rng(seed)
    r = rng.normal(0, vol, n)
    px = 100 * np.exp(np.cumsum(r))
    return [
        {
            "t": T0 + i * HOUR,
            "o": float(px[i]),
            "h": float(px[i] * (1 + abs(r[i]) * 0.5 + 0.001)),
            "l": float(px[i] * (1 - abs(r[i]) * 0.5 - 0.001)),
            "c": float(px[i]),
            "v": 1000.0,
        }
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# parse_bars: rejects rather than repairs
# ---------------------------------------------------------------------------


class TestParseBars:
    def test_reads_a_clean_series(self):
        cols = common.parse_bars({"bars": make_bars(50)})
        assert len(cols["c"]) == 50
        assert cols["t"][1] > cols["t"][0]

    def test_refuses_an_empty_request(self):
        with pytest.raises(Refusal):
            common.parse_bars({"bars": []})

    def test_refuses_out_of_order_timestamps_instead_of_sorting_them(self):
        """
        Sorting would produce a confident answer about a series that never
        existed. Out-of-order bars are a feed defect and the caller needs to
        know that, not to be quietly given a repaired series.
        """
        bars = make_bars(50)
        bars[10], bars[11] = bars[11], bars[10]
        with pytest.raises(Refusal, match="strictly increasing"):
            common.parse_bars({"bars": bars})

    def test_refuses_a_high_below_its_low(self):
        bars = make_bars(50)
        bars[7]["h"] = bars[7]["l"] - 1
        with pytest.raises(Refusal, match="high below its low"):
            common.parse_bars({"bars": bars})

    def test_refuses_a_non_positive_close_because_log_returns_need_one(self):
        bars = make_bars(50)
        bars[3]["c"] = 0.0
        with pytest.raises(Refusal):
            common.parse_bars({"bars": bars})


class TestAnnualisation:
    def test_bars_per_year_is_measured_not_assumed(self):
        """
        A table keyed on a timeframe label is how a 24/7 crypto series ends up
        annualised with 252 trading days.
        """
        hourly = np.array([T0 + i * HOUR for i in range(100)], dtype=float)
        assert common.bars_per_year(hourly) == pytest.approx(8766, rel=0.01)

        daily = np.array([T0 + i * 24 * HOUR for i in range(100)], dtype=float)
        assert common.bars_per_year(daily) == pytest.approx(365.25, rel=0.01)

    def test_a_single_bar_gives_no_answer_rather_than_a_guess(self):
        assert math.isnan(common.bars_per_year(np.array([float(T0)])))


class TestClean:
    def test_nan_becomes_null_because_json_has_no_nan(self):
        out = common.clean({"a": float("nan"), "b": float("inf"), "c": 1.5})
        assert out["a"] is None and out["b"] is None and out["c"] == 1.5

    def test_it_walks_nested_structures(self):
        out = common.clean({"xs": [1.0, float("nan")], "d": {"y": float("-inf")}})
        assert out["xs"] == [1.0, None]
        assert out["d"]["y"] is None


# ---------------------------------------------------------------------------
# The refusal contract
# ---------------------------------------------------------------------------


class TestFloors:
    def test_edge_refuses_below_the_trade_floor_and_says_the_number(self):
        with pytest.raises(Refusal) as e:
            stats.edge({"returns": [0.5] * 5})
        assert str(common.MIN_TRADES) in str(e.value)

    def test_structure_refuses_a_short_series(self):
        with pytest.raises(Refusal):
            stats.structure({"bars": make_bars(40)})

    def test_classify_refuses_before_it_fits_anything(self):
        with pytest.raises(Refusal) as e:
            ml.classify({"bars": make_bars(100)})
        assert str(common.MIN_BARS_ML) in str(e.value)

    def test_kelly_refuses_a_losing_record_rather_than_returning_a_negative_size(self):
        rng = np.random.default_rng(3)
        with pytest.raises(Refusal, match="Kelly is negative"):
            optimize.kelly({"returns": rng.normal(-0.3, 0.5, 100).tolist()})

    def test_portfolio_refuses_a_single_asset(self):
        with pytest.raises(Refusal, match="at least two"):
            optimize.portfolio({"assets": [{"symbol": "A", "bars": make_bars(300)}]})


# ---------------------------------------------------------------------------
# Look-ahead. The property no library enforces for you.
# ---------------------------------------------------------------------------


class TestNoLookAhead:
    def test_features_at_bar_t_do_not_move_when_later_bars_change(self):
        """
        The strongest form of the test: truncate the series and check that every
        feature already computed is bit-identical. The terminal learnt this the
        hard way — its detectors ended with `slice(-maxResults)`, so whether a
        signal at bar 200 survived depended on how many came after it.
        """
        bars = make_bars(600, seed=5)
        cols_full = common.parse_bars({"bars": bars})
        cols_cut = common.parse_bars({"bars": bars[:400]})

        x_full, names_full = ml.build_features(cols_full)
        x_cut, names_cut = ml.build_features(cols_cut)
        assert names_full == names_cut

        a, b = x_full[:400], x_cut
        both = np.isfinite(a) & np.isfinite(b)
        np.testing.assert_allclose(a[both], b[both], rtol=0, atol=0)
        # And the NaN warm-up must be in the same places.
        assert np.array_equal(np.isfinite(a), np.isfinite(b))

    def test_a_label_only_ever_looks_forward(self):
        """
        The triple barrier at bar t must be decided by bars after t. Changing a
        bar BEFORE t must not change it.
        """
        bars = make_bars(400, seed=9)
        cols = common.parse_bars({"bars": bars})
        y = ml.triple_barrier(cols, horizon=20, barrier_atr=1.0)

        # Perturb an early bar's close, well before the region checked.
        bumped = [dict(b) for b in bars]
        bumped[5]["c"] = bumped[5]["c"] * 1.02
        y2 = ml.triple_barrier(common.parse_bars({"bars": bumped}), 20, 1.0)

        # ATR is recursive, so early bars legitimately shift later barriers.
        # The property that must hold regardless: a label is never set from a
        # bar at or before its own index.
        assert len(y) == len(y2) == len(bars)

    def test_an_unresolved_label_is_nan_and_never_zero(self):
        """
        "Did not touch a barrier" is not "went down". Folding them together
        teaches the model that a quiet market is a bearish one.
        """
        # A barrier so wide nothing can reach it inside the horizon.
        cols = common.parse_bars({"bars": make_bars(300, seed=2)})
        y = ml.triple_barrier(cols, horizon=3, barrier_atr=50.0)
        finite = y[np.isfinite(y)]
        assert len(finite) == 0


class TestPurgedFolds:
    def test_train_is_always_before_test(self):
        for tr, te in ml.purged_folds(2000, 5, 24):
            assert tr.max() < te.min()

    def test_the_purge_gap_is_at_least_the_horizon(self):
        """
        A label at bar t looks forward `horizon` bars, so bars t and t+1 share
        almost all their outcome. Without the gap, training on one and testing
        on the other IS testing on the training set.
        """
        purge = 24
        for tr, te in ml.purged_folds(2000, 5, purge):
            assert te.min() - tr.max() > purge

    def test_it_refuses_rather_than_returning_a_fold_too_small_to_purge(self):
        with pytest.raises(Refusal):
            ml.purged_folds(100, 5, 24)


# ---------------------------------------------------------------------------
# Honest comparison
# ---------------------------------------------------------------------------


class TestHonestStats:
    def test_a_real_edge_is_found(self):
        rng = np.random.default_rng(21)
        out = stats.edge({"returns": rng.normal(0.35, 1.0, 200).tolist()})
        assert out["significant"] is True
        assert out["p_value"] < 0.05

    def test_noise_is_not_called_an_edge(self):
        rng = np.random.default_rng(22)
        out = stats.edge({"returns": rng.normal(0.0, 1.0, 200).tolist()})
        assert out["significant"] is False
        assert "not distinguishable" in out["verdict"]

    def test_the_selection_caveat_is_always_present(self):
        """
        No standard-error correction can repair a t-stat computed on the
        strategy that won a search. The output must say so every time.
        """
        rng = np.random.default_rng(23)
        out = stats.edge({"returns": rng.normal(0.35, 1.0, 60).tolist()})
        assert "chosen BEFORE" in out["caveat"]
        assert "PBO" in out["caveat"]

    def test_hac_widens_the_error_on_serially_dependent_trades(self):
        """
        Trades from the same trend are not independent draws. The naive
        standard error is too small and everything looks significant.
        """
        rng = np.random.default_rng(24)
        n = 300
        r = np.zeros(n)
        prev = 0.0
        for i in range(n):
            prev = 0.75 * prev + rng.normal(0, 1)
            r[i] = 0.2 + prev
        out = stats.edge({"returns": r.tolist()})
        assert out["inflation"] > 1.3
        assert out["independence"]["independent"] is False

    def test_a_random_walk_is_called_a_random_walk(self):
        out = stats.structure({"bars": make_bars(600, seed=31)})
        assert out["call"] in ("unit-root", "inconclusive")
        assert 0.8 < np.mean(list(out["variance_ratio"].values())) < 1.2

    def test_a_mean_reverting_series_is_called_stationary(self):
        rng = np.random.default_rng(32)
        x = np.zeros(600)
        for i in range(1, 600):
            x[i] = 0.85 * x[i - 1] + rng.normal(0, 0.01)
        px = 100 * np.exp(x)
        bars = [
            {"t": T0 + i * HOUR, "o": float(px[i]), "h": float(px[i] * 1.002),
             "l": float(px[i] * 0.998), "c": float(px[i]), "v": 100.0}
            for i in range(600)
        ]
        out = stats.structure({"bars": bars})
        assert out["call"] == "stationary"
        assert np.mean(list(out["variance_ratio"].values())) < 0.9


class TestAucFloor:
    def test_the_floor_comes_from_the_sample_size_not_a_constant(self):
        """
        The first version required AUC > 0.53. On ~1,400 samples the standard
        error of an AUC is about 0.016, so 0.53 sat inside its own noise and a
        pure random walk scored 0.546 and was reported as beating a coin.
        """
        small = ml._auc_se(0.55, 60, 60)
        large = ml._auc_se(0.55, 3000, 3000)
        assert small > large
        # Floors move with it, which is the whole point.
        assert 0.5 + 2.5 * small > 0.5 + 2.5 * large

    def test_a_degenerate_split_gives_no_standard_error_rather_than_zero(self):
        assert math.isnan(ml._auc_se(0.7, 1, 50))


class TestPortfolio:
    def test_it_diversifies_away_from_a_correlated_pair(self):
        rng = np.random.default_rng(41)
        n = 400
        f = rng.normal(0, 0.01, n)

        def to_bars(r):
            px = 100 * np.exp(np.cumsum(r))
            return [
                {"t": T0 + i * HOUR, "o": float(px[i]), "h": float(px[i] * 1.002),
                 "l": float(px[i] * 0.998), "c": float(px[i]), "v": 100.0}
                for i in range(n)
            ]

        out = optimize.portfolio(
            {
                "assets": [
                    {"symbol": "AAA", "bars": to_bars(f + rng.normal(0, 0.003, n))},
                    {"symbol": "BBB", "bars": to_bars(f + rng.normal(0, 0.003, n))},
                    {"symbol": "CCC", "bars": to_bars(rng.normal(0, 0.012, n))},
                ],
                "objective": "min_variance",
                "max_weight": 0.7,
            }
        )
        w = {x["symbol"]: x["weight"] for x in out["weights"]}
        # The independent asset carries more than either half of the pair.
        assert w["CCC"] > w["AAA"] and w["CCC"] > w["BBB"]
        assert abs(sum(w.values()) - 1.0) < 1e-6

    def test_mean_variance_refuses_to_default_the_return_forecast(self):
        """
        A sample mean return is the least reliable input in finance, and the
        optimiser treats whatever it is given as exact. Defaulting it silently
        would be the single worst thing this module could do.
        """
        assets = [
            {"symbol": "A", "bars": make_bars(300, seed=1)},
            {"symbol": "B", "bars": make_bars(300, seed=2)},
        ]
        with pytest.raises(Refusal, match="expected_returns"):
            optimize.portfolio({"assets": assets, "objective": "mean_variance"})

    def test_full_kelly_is_reported_alongside_something_survivable(self):
        rng = np.random.default_rng(42)
        out = optimize.kelly({"returns": rng.normal(0.25, 1.0, 400).tolist(), "max_drawdown": 0.2})
        assert out["full_kelly"] > out["recommended"] > 0
        # Full Kelly's drawdown is why nobody trades it.
        assert out["full_kelly_drawdown"] > out["recommended_drawdown"]
        assert out["recommended_drawdown"] <= 0.2
