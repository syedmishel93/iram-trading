# The quant service

A separate Flask process on **8789** that fits statistical and machine-learning
models on bars the terminal sends it. Optional: without it the terminal's Quant
desk says the service is not running and names the command to start it, and
nothing else in the terminal changes.

```bash
cd server
python -m quant.app
```

Then open the **Quant** desk under Research. `run.py` starts it automatically
alongside the proxy and the intelligence service.

## Why a third process

| port | process | what it does |
|------|---------|--------------|
| 8787 | `ddt_data_server.py` | market data proxy |
| 8788 | `mishel_service.py`   | alerts, ledger, sync |
| 8789 | `quant/`              | models, on demand |

The work here is CPU-bound and slow — a GARCH walk-forward takes ten seconds, a
model race takes a minute. Folding that into the alert service would block the
loop that fires price alerts, and a missed alert is a worse failure than a slow
analysis. Separate process, separate failure domain.

It binds loopback and refuses to bind anything else without
`IRAM_QUANT_ALLOW_REMOTE=1`. There is no authentication because there is
nothing to authenticate: the service holds no state, no credentials and no
positions. It takes bars in and returns numbers.

## The contract

**A refusal is an HTTP 200.** `{"ok": false, "reason": "..."}` is an *answer*.
"Ninety bars is not enough to fit a GARCH model" is the most useful thing the
service can say on ninety bars, and returning it as a 4xx would make the
terminal render a real finding as a connection problem. Status codes describe
the transport; the `ok` flag describes the answer.

**The terminal sends its bars.** It already has them, already knows which
provider they came from, and may be showing a replay slice. A service that
re-fetched would answer a question about a different series.

**Every heavy import is inside a function.** torch, darts, prophet and causalml
together take most of a minute to import. `python -m quant.app` starts in about
a second; the first call to each endpoint pays that endpoint's import cost once.

## Endpoints

| endpoint | question | libraries |
|---|---|---|
| `GET /quant/health` | what can this service actually do right now | — |
| `POST /quant/volatility` | does GARCH beat the EWMA the terminal already has | arch |
| `POST /quant/stats/structure` | trending, mean-reverting, or a random walk | statsmodels |
| `POST /quant/stats/edge` | is this edge distinguishable from zero | statsmodels |
| `POST /quant/stats/leadlag` | does one series lead another | statsmodels |
| `POST /quant/ml/classify` | does this chart predict anything | sklearn, xgboost, lightgbm, catboost, torch |
| `POST /quant/forecast/race` | which forecaster is best on this series | darts, sktime |
| `POST /quant/forecast/seasonality` | when does this instrument move | prophet |
| `POST /quant/causal/effect` | does following the plan *cause* better results | dowhy, econml, causalml |
| `POST /quant/portfolio` | weights under real constraints | cvxpy, scipy |
| `POST /quant/kelly` | how much to risk, and what it costs | scipy |
| `POST /quant/panel/factors` | does a characteristic pay across the universe | linearmodels |
| `POST /quant/choice/revealed` | what do your decisions actually turn on | biogeme |

## What it will not do

- **Forecast direction.** Volatility and seasonality only. The terminal already
  refuses this and has a test that fails if anything directional is exported
  from `analysis/forecast.ts`; three forecasting libraries do not change the
  reason for that refusal.
- **Claim causation from observational data.** Every causal output states the
  assumption it rests on and runs three refutation tests against itself.
- **Declare a winner on thin evidence.** A model scored on fewer bars than its
  rivals is reported and *not ranked*. An AUC inside its own standard error is
  reported as chance. Both of those rules exist because the first version of
  this code got them wrong and said so.
- **Place an order, move a stop, or touch a credential.** Same as the rest of
  IRAM.

## Tests

```bash
python -m pytest tests/test_quant_service.py -q
```

31 tests. They do not check that `arch` computes a GARCH — it has its own tests
for that. They check the things this code is responsible for: the sample-size
floors, the refusal contract, that features at bar *t* are bit-identical when
the series is truncated after *t*, that the purge gap in the walk-forward is at
least one label horizon, and that an unresolved label stays NaN rather than
becoming a zero.

## Dependencies

Listed in `server/requirements.txt` under the quant heading. All optional;
`/quant/health` names each missing library together with the capability it
takes away.

**TensorFlow is deliberately not included.** It has no wheel for Python 3.14 as
of this build, and PyTorch already covers the one thing it was wanted for here —
a neural-net cross-check against the gradient boosters in `ml.py`. A second
deep-learning framework for the same single MLP is a gigabyte of dependency for
no capability.
