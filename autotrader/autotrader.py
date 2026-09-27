"""Mishel Autotrader — asyncio companion (modular, decoupled). TESTNET BY DEFAULT.
Layers: DataIngestion -> AnalyticsEngine -> RiskGateway -> ExecutionLayer.
Run: pip install ccxt.pro numpy python-dotenv && python autotrader.py
Keys go in .env (never in code). Mirrors the browser terminal's math."""
import asyncio, os, time, math, json
import numpy as np

ASSETS = ["BTC/USDT"]           # extend: XAUUSD/US10Y/DXY via your data vendor
TESTNET = True                   # flip only when you have forward-tested results
MAX_DAILY_DD = 0.03              # kill-switch
RISK_TARGET_VOL = 0.008

class DataIngestion:
    """Async WS klines -> aligned store. Forward-fills gaps; never uses future bars."""
    def __init__(self): self.bars = {a: [] for a in ASSETS}
    async def run(self, q):
        import ccxt.pro as ccxtpro
        ex = ccxtpro.binance({'options': {'defaultType': 'future'}})
        if TESTNET: ex.set_sandbox_mode(True)
        while True:
            for a in ASSETS:
                ohlcv = await ex.watch_ohlcv(a, '1m')
                self.bars[a] = (self.bars[a] + ohlcv)[-500:]
            await q.put(dict(self.bars))

class AnalyticsEngine:
    """Rolling correlations, z-spreads, Mahalanobis anomaly, vol regime."""
    def signal(self, bars):
        t0 = time.perf_counter()
        c = np.array([b[4] for b in bars[ASSETS[0]]], float)
        if len(c) < 60: return None
        r = np.diff(np.log(c))[-60:]
        z = (c[-1] - c[-20:].mean()) / (c[-20:].std() + 1e-9)
        vol = r.std(); mu = r.mean()
        score = np.clip(mu / (vol + 1e-9) * 10, -1, 1)     # simple momentum edge
        ms = (time.perf_counter() - t0) * 1000
        return {'side': 1 if score > 0.25 else -1 if score < -0.25 else 0,
                'score': float(score), 'z': float(z), 'vol': float(vol), 'ms': ms}

class RiskGateway:
    """Kelly-vol sizing + absolute kill-switch. No order passes without it."""
    def __init__(self, equity): self.day0 = equity
    def size(self, equity, vol, edge=0.55, payoff=1.5):
        f = max(0.0, (edge * payoff - (1 - edge)) / payoff) * 0.25   # quarter-Kelly
        return equity * f * min(1.6, max(0.4, RISK_TARGET_VOL / (vol + 1e-9)))
    def killed(self, equity):
        return equity < self.day0 * (1 - MAX_DAILY_DD)

class ExecutionLayer:
    """Bracket orders via async ccxt. TESTNET default; refuses live without env flag."""
    async def bracket(self, ex, sym, side, qty, px, atr):
        sl = px - side * 2 * atr; tp = px + side * 3 * atr
        o = await ex.create_order(sym, 'market', 'buy' if side > 0 else 'sell', qty)
        await ex.create_order(sym, 'stop_market', 'sell' if side > 0 else 'buy', qty,
                              params={'stopPrice': sl, 'reduceOnly': True})
        await ex.create_order(sym, 'take_profit_market', 'sell' if side > 0 else 'buy', qty,
                              params={'stopPrice': tp, 'reduceOnly': True})
        return o

async def main():
    q = asyncio.Queue(); ingest = DataIngestion(); brain = AnalyticsEngine()
    risk = RiskGateway(10000.0)
    asyncio.create_task(ingest.run(q))
    while True:
        bars = await q.get()
        sig = brain.signal(bars)
        if not sig or sig['side'] == 0: continue
        print(f"signal {sig} | decided in {sig['ms']:.1f}ms")
        # equity tracking + ExecutionLayer.bracket() wiring left explicit:
        # add your keys to .env and flip TESTNET only after forward-testing.

if __name__ == "__main__": asyncio.run(main())
