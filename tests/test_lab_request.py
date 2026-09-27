"""
`StudyRequest` after it learned about specs — what the gateway will and will not
accept as the subject of a study.

WHY THIS IS A MODEL TEST AND NOT A ROUTE TEST
`tests/test_gateway.py` already covers the lab ROUTES, and re-asserting there
that a 422 is a 422 would test FastAPI. What is new, and what can be wrong
without anything looking wrong, is the subject rule: a study has exactly one
subject, and a request naming both or neither has to be refused BEFORE a worker
is spawned. Accepting both and picking one is a wrong answer with no symptom —
the study runs, returns a real curve, and is about the rule nobody asked for.

WHAT IS DELIBERATELY NOT TESTED HERE
That a `spec` is a valid rule. The vocabulary lives in
`app/src/backtest/rules.ts` and `validateSpec` enforces it; the gateway passes
the spec through opaquely and the engine's `parseJob` returns the reason. A
second definition of what a rule is, in pydantic, would be free to drift from
the one that actually runs — the gateway refusing a column the editor had just
learned to emit. `app/test/labspec.test.ts` covers the real check.

Run:  python -m pytest tests/test_lab_request.py -v
"""

from __future__ import annotations

import os
import sys

import pytest

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

pytest.importorskip("pydantic")

from gateway.lab import MAX_BARS, BatchRequest, StudyRequest

SPEC = {
    "id": "ema-9-21-cross",
    "name": "EMA 9/21 cross",
    "style": "scalp",
    "long": [["ema9", "crossabove", "ema21"]],
    "stop": {"type": "atr", "mult": 2},
    "target": {"type": "rr", "value": 2},
}

BAR = {"t": 1, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0}


# ----------------------------------------------------------------- accepts --

def test_accepts_a_family_job():
    request = StudyRequest(family="ema", symbol="BTCUSDT")
    assert request.family == "ema"
    assert request.spec is None
    assert request.subject() == "family:ema"


def test_accepts_a_spec_job():
    request = StudyRequest(spec=SPEC, symbol="BTCUSDT")
    assert request.family is None
    assert request.spec is not None and request.spec["id"] == "ema-9-21-cross"
    assert request.subject() == "spec:ema-9-21-cross"


def test_accepts_a_spec_the_gateway_knows_nothing_about():
    """A column this build of the gateway has never heard of is still accepted.

    On purpose: the engine is the thing that knows the vocabulary, and a
    gateway that second-guesses it starts refusing rules the editor can make.
    """
    request = StudyRequest(spec={**SPEC, "long": [["some_future_column", ">", "1"]]}, bars=[BAR])
    assert request.subject() == "spec:ema-9-21-cross"


# ----------------------------------------------------------------- refuses --

def test_rejects_a_request_naming_neither_subject():
    with pytest.raises(ValueError, match="nothing to study"):
        StudyRequest(symbol="BTCUSDT")


def test_rejects_a_request_naming_both_subjects():
    # Picking one would be right half the time and silent the other half.
    with pytest.raises(ValueError, match="one subject"):
        StudyRequest(family="ema", spec=SPEC, symbol="BTCUSDT")


def test_rejects_an_unknown_family():
    with pytest.raises(ValueError):
        StudyRequest(family="wishful", symbol="BTCUSDT")


@pytest.mark.parametrize("spec", [{}, {"id": ""}, {"id": "   "}, {"id": 7}, {"name": "no id"}])
def test_rejects_a_spec_with_no_usable_id(spec):
    """`label()` puts the id on screen and in every log line for the study."""
    with pytest.raises(ValueError, match="spec.id"):
        StudyRequest(spec=spec, symbol="BTCUSDT")


# ------------------------------------------------------------------ labels --

def test_label_stays_readable_for_both_subjects():
    assert StudyRequest(family="ema", symbol="BTCUSDT", timeframe="4h").label() == "BTCUSDT/4h/family:ema"
    assert StudyRequest(spec=SPEC, bars=[BAR]).label() == "bars/1h/spec:ema-9-21-cross"


def test_subject_is_prefixed_so_a_spec_cannot_impersonate_a_family():
    # Nothing stops somebody naming a spec `ema`. A bare id in a report would
    # then name two different studies identically.
    assert StudyRequest(spec={**SPEC, "id": "ema"}, bars=[BAR]).subject() == "spec:ema"
    assert StudyRequest(family="ema", bars=[BAR]).subject() == "family:ema"


# -------------------------------------------------------------- the wire ----

def test_a_family_job_on_the_wire_is_byte_for_byte_what_it_was():
    job = StudyRequest(family="ema", bars=[BAR], opts={"riskPerTrade": 0.01}).job([BAR])
    assert job == {"family": "ema", "bars": [BAR], "opts": {"riskPerTrade": 0.01}}


def test_a_spec_job_carries_spec_in_place_of_family():
    job = StudyRequest(spec=SPEC, bars=[BAR]).job([BAR])
    assert job == {"spec": SPEC, "bars": [BAR], "opts": {}}
    # Exactly one subject key on the pipe: the engine's `parseJob` refuses both.
    assert ("family" in job) is not ("spec" in job)


# ---------------------------------------------------- unchanged behaviour ----

def test_fetch_fields_keep_their_defaults():
    request = StudyRequest(family="ema")
    assert request.provider == "yfinance"
    assert request.timeframe == "1h"
    assert request.limit == 2000
    assert request.bars is None


@pytest.mark.parametrize("limit", [199, MAX_BARS + 1])
def test_limit_still_has_both_ends(limit):
    with pytest.raises(ValueError):
        StudyRequest(family="ema", limit=limit)


def test_batch_keeps_its_64_study_cap():
    one = {"family": "ema", "bars": [BAR]}
    assert len(BatchRequest(studies=[one] * 64).studies) == 64
    with pytest.raises(ValueError):
        BatchRequest(studies=[one] * 65)
    with pytest.raises(ValueError):
        BatchRequest(studies=[])


def test_a_batch_may_mix_families_and_specs():
    """The shape the sweep arrives in: 25 specs plus the three baselines."""
    batch = BatchRequest(studies=[{"family": "ema", "bars": [BAR]}, {"spec": SPEC, "bars": [BAR]}])
    assert [s.subject() for s in batch.studies] == ["family:ema", "spec:ema-9-21-cross"]


def test_one_bad_study_rejects_the_whole_batch():
    # Submitting 24 of 25 and saying nothing about the 25th is the failure this
    # repository keeps finding: a partial failure reported as a total.
    with pytest.raises(ValueError):
        BatchRequest(studies=[{"family": "ema", "bars": [BAR]}, {"bars": [BAR]}])
