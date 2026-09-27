#!/usr/bin/env python3
"""M3 - regime model (HMM-lite): 3-state Gaussian mixture over (return, rolling vol),
majority-smoothed state path, states auto-named by their measured means.
Honest label: GMM regime detection, not a full Baum-Welch HMM.

WHY THE STATE NAMES CHANGED, AND WHAT IT WAS COSTING
---------------------------------------------------
The three states used to be named "PANIC/high-vol", "TREND-UP" and
"CHOP/TREND-DN". Two of those are slashes, and a slash in a state name is an
admission that the namer could not tell the two apart.

The second one was not cosmetic. `app/src/core/decision.ts` reads this label to
decide which way the regime evidence leans:

    const down = /TREND-DN|PANIC/i.test(state);

so a SIDEWAYS market, labelled "CHOP/TREND-DN", contributed a full-strength
BEARISH lean to the confluence score - at whatever confidence the mixture
happened to report. The comment directly above that line reads "A CHOP state
leans nothing, which is a real answer rather than a missing one." It could not:
chop and downtrend were the same string. Measured on BTCUSDT 1m: state
"CHOP/TREND-DN" at 0.63 confidence, pushing the read short on a chart the model
itself had classified as going nowhere.

"PANIC" had the same shape of problem in the other direction. High realised
volatility is not a direction. A vertical rally is high-vol; so is a crash. It
was being read as bearish because of the word, not because of a measurement.

THE RULE NOW
------------
Each state is named from its own measured mean return: "Drifting up",
"Drifting down", "Sideways", "High volatility". One label, one meaning, and no
slashes.

WHAT THE NAMES DO NOT MEAN, WHICH IS THE IMPORTANT PART
-------------------------------------------------------
"Drifting up" is a DESCRIPTION OF THE CLUSTER, not a finding that this series
has drift. A Gaussian mixture over (return, vol) clusters ON return, so its
components are separated by mean return by construction - one of them has a
positive mean for the same reason that splitting any sample at its centre
produces a half above it. Measured: on eight driftless random walks, the fitted
state still carried a named direction on two of them, and raising the threshold
does not fix it, because the standard error of a SELECTED subsample does not
describe a selection.

So `DRIFT_SIGMAS` below is a READABILITY floor, not a significance test: it
keeps the weakest components from being given a direction they cannot support,
and that is all it claims. `app/src/core/decision.ts` correspondingly reads
this state as context and gives it no directional lean at all - which is what
its own weight table always said it was.
"""
import math

import numpy as np

# How far a state's mean return must sit from zero, in units of its own
# standard error, before its name gets a direction.
#
# A READABILITY FLOOR, NOT A SIGNIFICANCE TEST - see the module docstring. The
# mixture clusters on return, so within-component standard errors understate
# the selection and no value here makes the direction a tested claim. What it
# does do is stop the flattest of the three states from being handed a name
# that reads as a call. One let two of eight driftless walks through; two is
# stricter and costs nothing on a series that genuinely trends.
DRIFT_SIGMAS = 2.0


def _name_states(X, sm, k, means):
    """
    Name each state from what it measured, not from what it evokes.

    `means` is the mixture's own component means, used only to find which
    component is the volatile one. Everything else comes from the SMOOTHED
    assignment, because that is the path the terminal is shown and scored on.
    """
    vol_ceiling = means[:, 1].max() * 0.999
    names = {}
    for s in range(k):
        rows = X[sm == s]
        if rows.size == 0:
            names[s] = "Sideways"
            continue

        m_r, m_v = rows.mean(0)

        # The volatile state keeps its own name and gets NO direction, because
        # high realised volatility genuinely has none - it is as consistent
        # with a vertical rally as with a crash.
        if m_v >= vol_ceiling:
            names[s] = "High volatility"
            continue

        # Is the drift distinguishable from zero ON THIS SAMPLE? The standard
        # error of the mean return within the state is the only threshold here
        # that is not a made-up constant: below it, the sign of `m_r` is the
        # sign of the noise.
        n = len(rows)
        sd = float(rows[:, 0].std(ddof=1)) if n > 1 else 0.0
        se = sd / math.sqrt(n) if n > 1 and sd > 0 else 0.0

        if se == 0.0 or abs(m_r) < DRIFT_SIGMAS * se:
            names[s] = "Sideways"
        elif m_r > 0:
            names[s] = "Drifting up"
        else:
            names[s] = "Drifting down"

    # Two states that measured the same way produce two identical labels and a
    # bar chart with a repeated row. They ARE different states, and volatility
    # is the axis they differ on, so that is what distinguishes them - named in
    # the words it measured in, because the label is read straight onto a
    # 360px inspector panel by somebody who did not open this file.
    return _disambiguate(names, X, sm, k)


def _disambiguate(names, X, sm, k):
    by_name = {}
    for s, name in names.items():
        by_name.setdefault(name, []).append(s)

    def busyness(s):
        rows = X[sm == s]
        return float(rows[:, 1].mean()) if rows.size else 0.0

    out = dict(names)
    for name, states in by_name.items():
        if len(states) < 2:
            continue
        for rank, s in enumerate(sorted(states, key=busyness)):
            out[s] = f"{name}, quieter" if rank == 0 else f"{name}, more volatile"
    return out


def regimes(closes, k=3, win=24):
    from sklearn.mixture import GaussianMixture

    c = np.asarray(closes, float)
    if len(c) < 200:
        raise ValueError("insufficient history (200+ bars)")
    r = np.diff(np.log(c))
    vol = np.array([r[max(0, i - win):i + 1].std() for i in range(len(r))])
    X = np.column_stack([r, vol])
    gm = GaussianMixture(n_components=k, random_state=7, n_init=3).fit(X)
    lab = gm.predict(X)
    sm = lab.copy()                                   # majority smoothing, width 5
    for i in range(2, len(lab) - 2):
        w = lab[i - 2:i + 3]
        sm[i] = np.bincount(w).argmax()

    names = _name_states(X, sm, k, gm.means_)
    cur = int(sm[-1])
    probs = gm.predict_proba(X[-1:])[0]
    hist = [names[s] for s in sm[-48:]]
    return {
        "ok": True,
        "state": names[cur],
        "confidence": float(probs[cur]),
        "last48": {n: hist.count(n) for n in set(hist)},
        "n": len(c),
        "note": "Three states fitted on this series alone, from its returns and "
                "its rolling volatility, and named from what each one measured. "
                "A Gaussian mixture, not a hidden Markov model.",
    }
