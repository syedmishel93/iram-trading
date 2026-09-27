# AI_PROMPTS — modify DDT Terminal without touching code (much)

This file lets you change the system by handing it, plus one of the prompts below, to any capable AI (Claude, ChatGPT, etc.). It maps the codebase so the AI edits the right place safely.

**How to use:** upload or paste `index.html`, then paste the relevant prompt, filling in the `<...>` parts. Ask the AI to return the full edited file (or just the changed function). After editing, `git add . && git commit -m "..." && git push`.

---

## 🗺️ Codebase map (all inside `index.html`)

It's one file with three parts: `<style>` (CSS), the `<body>` (top bar, left nav rail, view containers, right panel), and one big `<script>`. The script is organised into labelled sections:

| Section | What lives there |
|---|---|
| `SPECS`, `genData`, `mulberry32` | instrument list + synthetic data generator |
| `IND` object (`IND.ema`, `IND.rsi`, `IND.flux`, …) | all indicators |
| `swings`, `detectFVG`, `detectOB`, `detectBOS`, `detectDivergence`, `detectInducements`, `keyLevels`, `detectPatterns` | detectors |
| `buildSignals` + `confluence` + `CATW` | glass-box confluence engine (weights in `CATW`) |
| `indicatorsFor`, `runStrategy`, `specFor`, `renderRules`, `renderEditor` | transparent strategy engine + editor |
| `runBacktest`, `renderRobustness` | backtesting |
| `mcts`/`runMCTS`, `runGen`/`genSynth`, `mcmcWinRate`/`runMCMC`, `mcDropout`, `classifyRegime`, `renderEnsemble` | Intelligence Lab |
| `MODEL`, `featVec`, `mlpForward`, `modelBias` | deep-learning model inference |
| `draw`, `drawDrawings`, `renderOne`, `RENDER`, `bx/byP/barAt/priceAt` | chart + drawing tools |
| `renderHedge` (+ `HEDGE`) | hedge desk strategies |
| `renderHeatmap` | market heatmap |
| `PAPER`, `paperOpen/Close`, `renderPaper` | paper trading |
| `wireSettings`, nav `click` handler, DOM wiring | settings + view wiring |

**Conventions**
- Colours are CSS variables: `--ink --panel --edge --txt --muted --bull(#2DBE8E) --bear(#F0616D) --gold(#E8A33D) --blue(#4C82FB)`.
- Strategy rules are `[indicator, operator, value]`; operators: `> < crossabove crossbelow`.
- Keep everything **deterministic and explainable** — that's the project's identity. New signals should emit a plain-language reason.
- After any edit, the file must still be one valid HTML file (the AI should keep the `<script>` syntactically valid).

---

## 📋 Ready-to-copy prompts

### Add a new indicator
```
Here is index.html for DDT Terminal. Add a new indicator called "<NAME>" defined as:
<describe the formula in words or math>.
Steps: (1) add it to the IND object next to the other indicators; (2) add it to
indicatorsFor() and to VNAME so strategies can use it; (3) if it makes sense, add it
to buildSignals() as a confluence signal with a plain-language reason and a CATW weight.
Return the full edited index.html.
```

### Add a new strategy (built-in)
```
Add a built-in strategy named "<NAME>" for the <scalp|intraday|swing|mm> style.
Entry/exit idea: <describe>. Add it to the STRATS list and add a matching case in
specFor() using the [indicator, operator, value] rule format, with a short honest note.
Return the full edited index.html.
```
> Or skip code entirely: in the app, open the Strategy Tester → "Tweak" panel, build it with dropdowns, and click **Save as my strategy**. Or upload a `.py`/`.json` (see the strategy format below).

### Change the colour theme / make it lighter
```
Change the DDT Terminal theme to <describe: e.g. "a light theme with a white background",
or "a blue accent instead of gold">. Only edit the CSS :root variables and any hard-coded
colours that clash. Keep bull green / bear red readable. Return the full edited index.html.
```

### Add a hedge strategy
```
Add a new hedge strategy to the Hedge Desk called "<NAME>". It works like: <describe legs,
profit source, risk>. Add a button to #hStrat and a branch in renderHedge() that fills
hDesc, hYield (stat boxes), hLegs (legs table), and hRules (component/rule/action table),
matching the style of the existing strategies. Return the full edited index.html.
```

### Add an Intelligence Lab module
```
Add a new panel to the Intelligence Lab implementing <technique>. Keep it transparent and
deterministic; if it's a stand-in for something heavier, label it honestly. Add the panel
HTML in #v-intel, a render function, and call it from renderIntel(). Return the full file.
```

### Wire a real data source
```
Add support for the <PROVIDER> market-data API in Settings → Data sources. Add it to the
provider dropdown, implement a fetch function that returns bars as {t,o,h,l,c,v}, and hook
it into goOnline(). Note any CORS limitations honestly. Return the full edited index.html.
```

### Convert to the Python backend
```
Using index.html as the reference spec, scaffold the production Python version described in
README's roadmap (ddt/ with data, indicators, detectors, xai, analytics, backtest, charting,
strategies). Port the indicator formulas, the confluence logic (CATW weights), the runStrategy
rule engine, and the JSON/Python strategy format exactly. Use ccxt + Twelve Data for data and
Streamlit for the UI. Keep everything glass-box. Provide requirements.txt and a run script.
```

---

## 🧩 Strategy file format (for `.json` / `.py` upload)

```json
{
  "name": "My Strategy",
  "style": "swing",
  "long":  [["ema50", ">", "ema200"], ["rsi", "crossabove", "40"]],
  "short": [["ema50", "<", "ema200"], ["rsi", "crossbelow", "60"]],
  "exitLong":  [["rsi", ">", "65"]],
  "exitShort": [["rsi", "<", "35"]],
  "stop": {"type": "atr", "mult": 2},
  "tp":   {"type": "rr",  "value": 2}
}
```
Python `.py` files use the same schema as a `STRATEGY = {...}` dict. Indicators available:
`close open high low ema9 ema20 ema21 ema50 ema200 rsi macd macds macdh stochk stochd cci willr adx roc mfi flux vwap bbu bbl bbm stdir div atr`.

**Prompt to generate a strategy with AI** (also available via the app's "Copy AI prompt" button):
```
Output ONLY a Python file defining a STRATEGY dict for the DDT terminal.
Schema: name, style (scalp|intraday|swing|mm|custom), long/short (lists of
[indicator, operator, value]), exitLong/exitShort, stop ({type atr|pct}), tp ({type rr|pct}).
Operators: > < crossabove crossbelow. Indicators: <paste the list above>.
Write a strategy for: <your idea>.
```

## 🧠 Model file format (for the Model Manager)

```json
{
  "type": "mlp",
  "name": "My Model",
  "layers": [{ "W": [[...12 weights...]], "b": [0], "act": "tanh" }]
}
```
Input = the 12 canonical features (in order) listed in the Model Manager. Train offline, export weights in this shape, upload. For bigger nets, use ONNX / TensorFlow.js in the Python build.
